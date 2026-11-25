import type pg from "pg";
import type { PlatformDatabase } from "./db.ts";
import { PlatformError } from "./errors.ts";
import { statutoryStatuses, type StatutoryStatus } from "./schema.ts";
import { platformErrorFromDatabase, withPlatformTx, writeAudit } from "./tenants.ts";

type StatutoryQueryable = Pick<pg.Pool, "query"> | pg.PoolClient;

const PUBLISHABLE_RULE_TYPE = "pph21";
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const statutoryColumns = `
  id,
  rule_type,
  version_label,
  to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
  to_char(effective_to, 'YYYY-MM-DD') AS effective_to,
  status,
  payload_json,
  created_by_operator_id,
  published_by_operator_id,
  published_at,
  created_at,
  updated_at
`;

export type StatutoryPublishVerdict =
  | {
      readonly ok: true;
      readonly ruleType: string;
      readonly effectiveFrom: string;
      readonly effectiveTo: string;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

/** Injected from `apps/api`. The platform package does not import the payroll engine. */
export type StatutoryPublishVerifier = (payload: unknown) => StatutoryPublishVerdict;

export interface StatutoryTableRecord {
  id: string;
  ruleType: string;
  versionLabel: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: StatutoryStatus;
  payload: unknown;
  createdByOperatorId: string;
  publishedByOperatorId: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStatutoryDraftInput {
  ruleType: string;
  versionLabel: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  payload: Record<string, unknown>;
  actorId: string;
  ip: string | null;
}

interface StatutoryRow {
  id: string;
  rule_type: string;
  version_label: string;
  effective_from: string;
  effective_to: string | null;
  status: string;
  payload_json: unknown;
  created_by_operator_id: string;
  published_by_operator_id: string | null;
  published_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** A real civil date from 1900 through 2199, the window the payroll engine accepts. */
export function isPayrollDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1) return false;
  const length = MONTH_LENGTHS[month - 1];
  if (length === undefined) return false;
  const leap = month === 2 && (year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0));
  return day <= (leap ? 29 : length);
}

export async function listStatutoryTables(
  platform: PlatformDatabase,
): Promise<StatutoryTableRecord[]> {
  const result = await platform.pool.query<StatutoryRow>(
    `SELECT ${statutoryColumns}
     FROM pay_statutory_tables
     ORDER BY effective_from, id
     LIMIT 200`,
  );
  return result.rows.map(toRecord);
}

export async function createStatutoryDraft(
  platform: PlatformDatabase,
  input: CreateStatutoryDraftInput,
): Promise<StatutoryTableRecord> {
  const draft = checkedDraft(input);
  try {
    return await withPlatformTx(platform, async (client) => {
      const inserted = await client.query<StatutoryRow>(
        `INSERT INTO pay_statutory_tables (
           rule_type, version_label, effective_from, effective_to, status,
           payload_json, created_by_operator_id
         ) VALUES ($1, $2, $3::date, $4::date, 'draft', $5::jsonb, $6::uuid)
         RETURNING ${statutoryColumns}`,
        [
          draft.ruleType,
          draft.versionLabel,
          draft.effectiveFrom,
          draft.effectiveTo,
          JSON.stringify(draft.payload),
          draft.actorId,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new PlatformError(500, "internal_error", "Statutory draft was not stored.");
      const record = toRecord(row);
      await writeAudit(client, {
        actorId: draft.actorId,
        action: "statutory.draft.create",
        tenantId: null,
        grantId: null,
        diff: {
          id: record.id,
          ruleType: record.ruleType,
          versionLabel: record.versionLabel,
          effectiveFrom: record.effectiveFrom,
          effectiveTo: record.effectiveTo,
          status: record.status,
        },
        ip: draft.ip,
      });
      return record;
    });
  } catch (error) {
    throw mapped(error);
  }
}

export async function publishStatutoryTable(
  platform: PlatformDatabase,
  input: {
    id: string;
    actorId: string;
    ip: string | null;
    verify: StatutoryPublishVerifier;
  },
): Promise<StatutoryTableRecord> {
  try {
    return await withPlatformTx(platform, async (client) => {
      const locked = await client.query<StatutoryRow>(
        `SELECT ${statutoryColumns}
         FROM pay_statutory_tables
         WHERE id = $1::uuid
         FOR UPDATE`,
        [input.id],
      );
      const current = locked.rows[0];
      if (!current) throw new PlatformError(404, "not_found", "Statutory table was not found.");
      const draft = toRecord(current);
      if (draft.status !== "draft") {
        throw new PlatformError(409, "conflict", "A published statutory table cannot be changed.");
      }
      const verdict = input.verify(draft.payload);
      if (!verdict.ok) {
        throw new PlatformError(422, "invalid_statutory", clip(verdict.message));
      }
      if (verdict.ruleType !== draft.ruleType) {
        throw new PlatformError(
          422,
          "invalid_statutory",
          "The payload rule type does not match the draft.",
        );
      }
      if (
        verdict.effectiveFrom !== draft.effectiveFrom ||
        (draft.effectiveTo !== null && verdict.effectiveTo !== draft.effectiveTo)
      ) {
        throw new PlatformError(
          422,
          "invalid_statutory",
          "The payload effective dates do not match the draft.",
        );
      }
      const updated = await client.query<StatutoryRow>(
        `UPDATE pay_statutory_tables
         SET status = 'published',
             published_by_operator_id = $2::uuid,
             published_at = now(),
             updated_at = now()
         WHERE id = $1::uuid
           AND status = 'draft'
         RETURNING ${statutoryColumns}`,
        [draft.id, input.actorId],
      );
      const publishedRow = updated.rows[0];
      if (!publishedRow) {
        throw new PlatformError(409, "conflict", "A published statutory table cannot be changed.");
      }
      const published = toRecord(publishedRow);
      await writeAudit(client, {
        actorId: input.actorId,
        action: "statutory.publish",
        tenantId: null,
        grantId: null,
        diff: {
          id: published.id,
          ruleType: published.ruleType,
          versionLabel: published.versionLabel,
          effectiveFrom: published.effectiveFrom,
          effectiveTo: published.effectiveTo,
          status: published.status,
        },
        ip: input.ip,
      });
      return published;
    });
  } catch (error) {
    throw mapped(error);
  }
}

/**
 * The published row whose closed window covers `payrollDate`.
 * A null `effectiveTo` stays open. Callers copy `payload` onto a calculation.
 * Publishing a later table does not update that copy or this row.
 */
export async function getEffectiveStatutoryTable(
  tx: StatutoryQueryable,
  ruleType: string,
  payrollDate: string,
): Promise<StatutoryTableRecord | null> {
  if (ruleType.trim().length === 0 || ruleType.length > 40 || !isPayrollDate(payrollDate)) {
    throw new PlatformError(400, "invalid", "The request was invalid.");
  }
  const result = await tx.query<StatutoryRow>(
    `SELECT ${statutoryColumns}
     FROM pay_statutory_tables
     WHERE rule_type = $1
       AND status = 'published'
       AND effective_from <= $2::date
       AND (effective_to IS NULL OR effective_to >= $2::date)
     ORDER BY effective_from, id`,
    [ruleType, payrollDate],
  );
  const first = result.rows[0];
  if (!first) return null;
  if (result.rows.length > 1) {
    throw new PlatformError(
      500,
      "internal_error",
      "Overlapping published statutory tables cover this date.",
    );
  }
  return toRecord(first);
}

function checkedDraft(input: CreateStatutoryDraftInput): CreateStatutoryDraftInput {
  const versionLabel = input.versionLabel.trim();
  if (input.ruleType !== PUBLISHABLE_RULE_TYPE) {
    throw new PlatformError(400, "invalid", "The request was invalid.");
  }
  if (versionLabel.length < 1 || versionLabel.length > 80) {
    throw new PlatformError(400, "invalid", "The request was invalid.");
  }
  if (!isPayrollDate(input.effectiveFrom)) {
    throw new PlatformError(400, "invalid", "The request was invalid.");
  }
  if (input.effectiveTo !== null && !isPayrollDate(input.effectiveTo)) {
    throw new PlatformError(400, "invalid", "The request was invalid.");
  }
  if (input.effectiveTo !== null && input.effectiveTo < input.effectiveFrom) {
    throw new PlatformError(400, "invalid", "The request was invalid.");
  }
  if (
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw new PlatformError(400, "invalid", "The request was invalid.");
  }
  return {
    ruleType: input.ruleType,
    versionLabel,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    payload: input.payload,
    actorId: input.actorId,
    ip: input.ip,
  };
}

function toRecord(row: StatutoryRow): StatutoryTableRecord {
  if (!isStatus(row.status)) {
    throw new PlatformError(500, "internal_error", "Statutory status is invalid.");
  }
  if (typeof row.effective_from !== "string" || row.effective_from.length === 0) {
    throw new PlatformError(500, "internal_error", "Statutory date is invalid.");
  }
  return {
    id: row.id,
    ruleType: row.rule_type,
    versionLabel: row.version_label,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    status: row.status,
    payload:
      typeof row.payload_json === "string"
        ? (JSON.parse(row.payload_json) as unknown)
        : row.payload_json,
    createdByOperatorId: row.created_by_operator_id,
    publishedByOperatorId: row.published_by_operator_id,
    publishedAt: row.published_at === null ? null : isoTime(row.published_at),
    createdAt: isoTime(row.created_at),
    updatedAt: isoTime(row.updated_at),
  };
}

function isStatus(value: string): value is StatutoryStatus {
  return (statutoryStatuses as readonly string[]).includes(value);
}

function isoTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PlatformError(500, "internal_error", "Statutory timestamp is invalid.");
  }
  return date.toISOString();
}

function clip(message: string): string {
  const text = message.trim();
  if (text.length === 0) return "Statutory table failed publish checks.";
  return text.length > 400 ? text.slice(0, 400) : text;
}

function mapped(error: unknown): Error {
  if (error instanceof PlatformError) return error;
  return platformErrorFromDatabase(error) ?? (error instanceof Error ? error : new Error("Request failed."));
}
