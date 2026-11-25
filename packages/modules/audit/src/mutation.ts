import type { TenantTx } from "@gotonghr/db";
import { sql, type SQL } from "drizzle-orm";
import { AuditChainError } from "./errors.ts";
import {
  AUDIT_TIMESTAMP_FORMAT,
  eventHash,
  genesisHash,
} from "./hash-chain.ts";
import { hashChainEnabledForTenant } from "./keys.ts";
import { redactPii } from "./redact.ts";
import { assertUuid, queryRows, quoteIdentifier } from "./sql.ts";
import { assertSameTenant } from "./tenant.ts";

export type SqlValue = string | number | boolean | null;

export interface AuditedUpdateInput {
  table: string;
  tenantId: string;
  resourceId: string;
  action: string;
  resourceType: string;
  actorUserId: string;
  actorRole?: string;
  ipAddress?: string;
  userAgent?: string;
  aiProposalId?: string;
  supportGrantId?: string;
  idColumn?: string;
  assignments: Readonly<Record<string, SqlValue>>;
}

export interface AuditedUpdateResult {
  eventId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

interface Stamp {
  id: string;
  created_at: string;
}

interface HashRow {
  event_hash: string | null;
}

/**
 * Updates one tenant row and appends `aud_events` in the same transaction.
 * PostgreSQL 18 returns OLD and NEW from that UPDATE. PII keys are redacted
 * before the JSON is stored. The returned snapshots are redacted too.
 * The hash chain runs when the tenant key row says it is on.
 */
export async function auditedUpdate(
  tx: TenantTx,
  input: AuditedUpdateInput,
): Promise<AuditedUpdateResult> {
  const tenantId = await assertSameTenant(tx, input.tenantId);
  const resourceId = assertUuid(input.resourceId, "resource id");
  const actorUserId = assertUuid(input.actorUserId, "actor user id");
  const idColumn = input.idColumn ?? "id";
  quoteIdentifier(input.table);
  quoteIdentifier(idColumn);
  const action = requiredText(input.action, "action", 80);
  const resourceType = requiredText(input.resourceType, "resource type", 80);
  const actorRole = optionalText(input.actorRole, 80);
  const ipAddress = optionalText(input.ipAddress, 64);
  const userAgent = optionalText(input.userAgent, 512);
  const aiProposalId = optionalUuid(input.aiProposalId, "ai proposal id");
  const supportGrantId = optionalUuid(input.supportGrantId, "support grant id");
  const names = Object.keys(input.assignments);
  if (names.length === 0) throw new Error("audited update needs at least one column");
  for (const name of names) {
    quoteIdentifier(name);
    if (name === "id" || name === "tenant_id" || name === idColumn) {
      throw new Error(`audited update cannot set ${name}`);
    }
    assertSqlValue(input.assignments[name]);
  }

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gotonghr.audit.append\n${tenantId}`}, 0))`,
  );

  const updated = queryRows<{ before_json: unknown; after_json: unknown }>(
    await tx.execute(sql`
      UPDATE ${sql.raw(quoteIdentifier(input.table))}
      SET ${assignmentSql(input.assignments)}
      WHERE ${sql.raw(quoteIdentifier(idColumn))} = ${resourceId}::uuid
        AND tenant_id = ${tenantId}::uuid
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        to_jsonb(before_row) AS before_json,
        to_jsonb(after_row) AS after_json
    `),
  );
  if (updated.length !== 1) {
    throw new Error("audit target was not found");
  }
  const row = updated[0];
  if (!row) throw new Error("audit target was not found");
  const before = asRecord(redactPii(asRecord(row.before_json)));
  const after = asRecord(redactPii(asRecord(row.after_json)));
  const diff = { before, after };

  const chain = await hashChainEnabledForTenant(tx, tenantId);
  let prevHash: string | null = null;
  let eventHashValue: string | null = null;
  const stamp = await nextStamp(tx);
  const chainSeq = await nextChainSeq(tx, tenantId);
  if (chain) {
    prevHash = await previousHash(tx, tenantId);
    eventHashValue = eventHash({
      id: stamp.id,
      tenantId,
      actorUserId,
      actorRole,
      action,
      resourceType,
      resourceId,
      diff,
      aiProposalId,
      supportGrantId,
      ipAddress,
      userAgent,
      createdAt: stamp.created_at,
      prevHash,
      chainSeq,
    });
  }

  await tx.execute(sql`
    INSERT INTO aud_events (
      id, tenant_id, actor_user_id, actor_role, action, resource_type, resource_id,
      diff_redacted_json, ai_proposal_id, support_grant_id, ip_address, user_agent,
      prev_hash, event_hash, chain_seq, created_at
    ) VALUES (
      ${stamp.id}::uuid,
      ${tenantId}::uuid,
      ${actorUserId}::uuid,
      ${actorRole},
      ${action},
      ${resourceType},
      ${resourceId}::uuid,
      ${JSON.stringify(diff)}::jsonb,
      ${aiProposalId}::uuid,
      ${supportGrantId}::uuid,
      ${ipAddress},
      ${userAgent},
      ${prevHash},
      ${eventHashValue},
      ${chainSeq},
      ${stamp.created_at}::timestamptz
    )
  `);

  return { eventId: stamp.id, before, after };
}

function assignmentSql(assignments: Readonly<Record<string, SqlValue>>): SQL {
  const parts = Object.entries(assignments).map(([column, value]) => {
    return sql`${sql.raw(quoteIdentifier(column))} = ${value ?? null}`;
  });
  return sql.join(parts, sql`, `);
}

async function nextStamp(tx: TenantTx): Promise<Stamp> {
  const rows = queryRows<Stamp>(
    await tx.execute(sql`
      SELECT uuidv7()::text AS id,
             to_char(
               date_trunc('milliseconds', clock_timestamp()) AT TIME ZONE 'UTC',
               ${AUDIT_TIMESTAMP_FORMAT}
             ) AS created_at
    `),
  );
  const stamp = rows[0];
  if (!stamp?.id || !stamp.created_at) throw new Error("audit stamp failed");
  return stamp;
}

async function nextChainSeq(tx: TenantTx, tenantId: string): Promise<number> {
  const rows = queryRows<{ chain_seq: number | string }>(
    await tx.execute(sql`
      SELECT (COALESCE(MAX(chain_seq), 0) + 1)::bigint AS chain_seq
      FROM aud_events
      WHERE tenant_id = ${tenantId}::uuid
    `),
  );
  const chainSeq = Number(rows[0]?.chain_seq);
  if (!Number.isSafeInteger(chainSeq) || chainSeq < 1) {
    throw new Error("audit chain sequence failed");
  }
  return chainSeq;
}

async function previousHash(tx: TenantTx, tenantId: string): Promise<string> {
  const rows = queryRows<HashRow>(
    await tx.execute(sql`
      SELECT event_hash
      FROM aud_events
      WHERE tenant_id = ${tenantId}::uuid
        AND chain_seq IS NOT NULL
      ORDER BY aud_events.chain_seq DESC
      LIMIT 1
    `),
  );
  const row = rows[0];
  if (!row) return genesisHash(tenantId);
  if (row.event_hash === null) {
    throw new AuditChainError("audit hash chain is broken");
  }
  return row.event_hash;
}

function asRecord(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("audit row was not an object");
  }
  return parsed as Record<string, unknown>;
}

function assertSqlValue(value: SqlValue | undefined): void {
  if (value === undefined) throw new Error("audit assignment value is missing");
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("audit assignment values must be finite");
  }
}

function requiredText(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function optionalText(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw new Error("optional audit field is too long");
  return trimmed;
}

function optionalUuid(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  return assertUuid(value, label);
}
