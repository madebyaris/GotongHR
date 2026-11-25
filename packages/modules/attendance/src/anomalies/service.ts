import { appendAuditEvent, provisionTenantKeys } from "@gotonghr/audit";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { AnomalyError, missingPermission } from "./errors.ts";
import { branchScopeSql, iso, isUuid, rowsOf } from "./sql.ts";
import type { AnomalyCaller, ReviewedAnomaly } from "./types.ts";

const NOTE_MAX = 500;

interface LockedRow {
  id: string;
  review_status: string;
  review_note: string | null;
}

interface UpdatedRow {
  id: string;
  reviewed_by: string;
  reviewed_at: Date | string;
  review_note: string | null;
}

/**
 * Marks one pending punch reviewed and appends an audit event in the same transaction.
 * The att_clock_events row stays. A second review returns 409.
 */
export async function reviewAnomaly(
  database: TenantDatabase,
  caller: AnomalyCaller,
  id: string,
  note: string | null,
): Promise<ReviewedAnomaly> {
  if (!caller.permissions.includes("attendance.approve")) throw missingPermission();
  if (!isUuid(id)) throw notFound();
  const reviewNote = cleanNote(note);
  return database.withTenantContext(caller.tenantId, async (tx) => {
    const current = await lockPunch(tx, caller, id);
    if (!current) throw notFound();
    if (current.review_status !== "needs_review") throw alreadyDecided(current.review_status);
    const updated = await markReviewed(tx, caller, id, reviewNote);
    if (!updated) throw alreadyDecided("reviewed");
    await provisionTenantKeys(tx, caller.tenantId);
    await appendAuditEvent(
      tx,
      {
        tenantId: caller.tenantId,
        actorUserId: caller.userId,
        actorRole: clip(caller.role, 80),
        action: "attendance.anomaly.review",
        resourceType: "att_clock_event",
        resourceId: id,
        diff: {
          before: {
            reviewStatus: current.review_status,
            reviewNote: current.review_note,
          },
          after: {
            reviewStatus: "reviewed",
            reviewNote,
            reviewedBy: caller.userId,
            reviewedAt: iso(updated.reviewed_at),
          },
        },
        aiProposalId: null,
        supportGrantId: null,
        ipAddress: clip(caller.ipAddress, 64),
        userAgent: clip(caller.userAgent, 512),
      },
      { requireTenantKeys: true },
    );
    return {
      id: updated.id,
      reviewStatus: "reviewed",
      reviewedBy: updated.reviewed_by,
      reviewedAt: iso(updated.reviewed_at),
      reviewNote: updated.review_note,
    };
  });
}

export function cleanNote(note: string | null): string | null {
  if (note === null) return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > NOTE_MAX) {
    throw new AnomalyError(400, "invalid_field", "Check the highlighted fields.", [
      { field: "note", message: "Note must be 500 characters or fewer." },
    ]);
  }
  return trimmed;
}

async function lockPunch(tx: TenantTx, caller: AnomalyCaller, id: string): Promise<LockedRow | null> {
  const scope = branchScopeSql(caller.scopeBranchIds);
  const rows = rowsOf<LockedRow>(
    await tx.execute(sql`
      SELECT e.id::text AS id, e.review_status, e.review_note
      FROM att_clock_events AS e
      WHERE e.id = ${id}::uuid
        AND e.tenant_id = ${caller.tenantId}::uuid
        AND ${scope}
      FOR UPDATE
    `),
  );
  return rows[0] ?? null;
}

async function markReviewed(
  tx: TenantTx,
  caller: AnomalyCaller,
  id: string,
  reviewNote: string | null,
): Promise<UpdatedRow | null> {
  const scope = branchScopeSql(caller.scopeBranchIds);
  const rows = rowsOf<UpdatedRow>(
    await tx.execute(sql`
      UPDATE att_clock_events AS e
      SET
        review_status = 'reviewed',
        reviewed_by = ${caller.userId}::uuid,
        reviewed_at = clock_timestamp(),
        review_note = ${reviewNote}
      WHERE e.id = ${id}::uuid
        AND e.tenant_id = ${caller.tenantId}::uuid
        AND e.review_status = 'needs_review'
        AND ${scope}
      RETURNING
        e.id::text AS id,
        e.reviewed_by::text AS reviewed_by,
        e.reviewed_at,
        e.review_note
    `),
  );
  return rows[0] ?? null;
}

function notFound(): AnomalyError {
  return new AnomalyError(404, "not_found", "Punch not found.");
}

function alreadyDecided(status: string): AnomalyError {
  const message =
    status === "reviewed" ? "This punch is already reviewed." : "This punch does not need review.";
  return new AnomalyError(409, "conflict", message);
}

function clip(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}
