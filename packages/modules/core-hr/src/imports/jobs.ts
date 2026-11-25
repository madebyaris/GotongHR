import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { queryRows } from "../sql.ts";
import type { ImportJobError, ImportJobView, ImportLineError, ImportMode, ImportStatus } from "./queue.ts";

export interface StoredImportJob {
  id: string;
  status: ImportStatus;
  mode: ImportMode;
  storageKey: string;
  legalEntityId: string;
  branchId: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  writtenRows: number;
  lineErrors: ImportLineError[];
  error: ImportJobError | null;
  requestedBy: string;
  actorRole: string;
  ipAddress: string | null;
  userAgent: string | null;
}

interface JobRow {
  id: string;
  status: string;
  mode: string;
  storage_key: string;
  legal_entity_id: string;
  branch_id: string;
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  written_rows: number;
  line_errors: unknown;
  error_json: unknown;
  requested_by: string;
  actor_role: string;
  ip_address: string | null;
  user_agent: string | null;
}

const columns = sql`
  id::text AS id,
  status,
  mode,
  storage_key,
  legal_entity_id::text AS legal_entity_id,
  branch_id::text AS branch_id,
  total_rows,
  valid_rows,
  error_rows,
  written_rows,
  line_errors,
  error_json,
  requested_by::text AS requested_by,
  actor_role,
  ip_address,
  user_agent
`;

export function toImportView(job: StoredImportJob): ImportJobView {
  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    allOrNothing: true,
    totalRows: job.totalRows,
    validRows: job.validRows,
    errorRows: job.errorRows,
    writtenRows: job.writtenRows,
    lineErrors: job.lineErrors,
    error: job.error,
  };
}

export async function readImportJob(
  appDb: TenantDatabase,
  tenantId: string,
  jobId: string,
): Promise<StoredImportJob | null> {
  return appDb.withTenantContext(tenantId, async (tx) => readImportJobTx(tx, jobId));
}

export async function readImportJobTx(tx: TenantTx, jobId: string): Promise<StoredImportJob | null> {
  const rows = queryRows<JobRow>(
    await tx.execute(sql`SELECT ${columns} FROM hr_import_jobs WHERE id = ${jobId}::uuid`),
  );
  const row = rows[0];
  return row ? mapJob(row) : null;
}

export async function lockImportJobTx(tx: TenantTx, jobId: string): Promise<StoredImportJob | null> {
  const rows = queryRows<JobRow>(
    await tx.execute(sql`
      SELECT ${columns}
      FROM hr_import_jobs
      WHERE id = ${jobId}::uuid
      FOR UPDATE
    `),
  );
  const row = rows[0];
  return row ? mapJob(row) : null;
}

export async function insertImportJob(
  tx: TenantTx,
  input: {
    id: string;
    tenantId: string;
    mode: ImportMode;
    storageKey: string;
    legalEntityId: string;
    branchId: string;
    requestedBy: string;
    actorRole: string;
    ipAddress: string | null;
    userAgent: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO hr_import_jobs (
      id, tenant_id, status, mode, storage_key, legal_entity_id, branch_id,
      requested_by, actor_role, ip_address, user_agent
    )
    VALUES (
      ${input.id}::uuid,
      ${input.tenantId}::uuid,
      'queued',
      ${input.mode},
      ${input.storageKey},
      ${input.legalEntityId}::uuid,
      ${input.branchId}::uuid,
      ${input.requestedBy}::uuid,
      ${input.actorRole},
      ${input.ipAddress},
      ${input.userAgent}
    )
  `);
}

export async function claimImportJob(tx: TenantTx, jobId: string): Promise<boolean> {
  const rows = queryRows<{ id: string }>(
    await tx.execute(sql`
      UPDATE hr_import_jobs
      SET status = 'running', started_at = COALESCE(started_at, clock_timestamp())
      WHERE id = ${jobId}::uuid
        AND status IN ('queued', 'running')
      RETURNING id::text AS id
    `),
  );
  return Boolean(rows[0]?.id);
}

export async function finishImportJob(
  tx: TenantTx,
  jobId: string,
  input: {
    status: "completed" | "failed";
    totalRows: number;
    validRows: number;
    errorRows: number;
    writtenRows: number;
    lineErrors: ImportLineError[];
    error: ImportJobError;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE hr_import_jobs
    SET status = ${input.status},
        total_rows = ${input.totalRows},
        valid_rows = ${input.validRows},
        error_rows = ${input.errorRows},
        written_rows = ${input.writtenRows},
        line_errors = ${JSON.stringify(input.lineErrors)}::jsonb,
        error_json = ${JSON.stringify(input.error)}::jsonb,
        finished_at = clock_timestamp()
    WHERE id = ${jobId}::uuid
      AND status IN ('queued', 'running')
  `);
}

function mapJob(row: JobRow): StoredImportJob {
  const status = asStatus(row.status);
  const mode = asMode(row.mode);
  return {
    id: row.id,
    status,
    mode,
    storageKey: row.storage_key,
    legalEntityId: row.legal_entity_id,
    branchId: row.branch_id,
    totalRows: Number(row.total_rows),
    validRows: Number(row.valid_rows),
    errorRows: Number(row.error_rows),
    writtenRows: Number(row.written_rows),
    lineErrors: asLineErrors(row.line_errors),
    error: asJobError(row.error_json),
    requestedBy: row.requested_by,
    actorRole: row.actor_role,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
  };
}

function asStatus(value: string): ImportStatus {
  if (value === "queued" || value === "running" || value === "completed" || value === "failed") return value;
  throw new Error("import status is not valid");
}

function asMode(value: string): ImportMode {
  if (value === "dry_run" || value === "commit") return value;
  throw new Error("import mode is not valid");
}

function asLineErrors(value: unknown): ImportLineError[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) return [];
  const errors: ImportLineError[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { line?: unknown; field?: unknown; message?: unknown };
    if (typeof record.line !== "number" || typeof record.field !== "string" || typeof record.message !== "string") {
      continue;
    }
    errors.push({ line: record.line, field: record.field, message: record.message });
  }
  return errors;
}

function asJobError(value: unknown): ImportJobError | null {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { code?: unknown; message?: unknown; allOrNothing?: unknown; written?: unknown };
  if (
    (record.code !== "import_rolled_back" && record.code !== "dry_run" && record.code !== "committed") ||
    typeof record.message !== "string" ||
    record.allOrNothing !== true ||
    typeof record.written !== "number"
  ) {
    return null;
  }
  return {
    code: record.code,
    message: record.message,
    allOrNothing: true,
    written: record.written,
  };
}
