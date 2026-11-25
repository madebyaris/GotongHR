import { provisionTenantKeys, readTenantSecrets } from "@gotonghr/audit";
import type { EmployeeCreateInput } from "@gotonghr/contracts";
import { MAX_UPLOAD_BYTES, type ObjectStorage } from "@gotonghr/storage";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { EmployeeFieldError } from "../errors.ts";
import { errorCode, errorConstraint, queryRows } from "../sql.ts";
import { hashNik, insertImportedEmployee, type ImportActor, type ImportSecrets } from "./commit.ts";
import { csvRecords, CsvFormatError } from "./csv.ts";
import {
  claimImportJob,
  finishImportJob,
  lockImportJobTx,
  readImportJob,
  toImportView,
  type StoredImportJob,
} from "./jobs.ts";
import { assertImportPlacement } from "./placement.ts";
import {
  ALL_OR_NOTHING_ROLLBACK,
  DRY_RUN_WRITES_NOTHING,
  MAX_IMPORT_ROWS,
  MAX_STORED_LINE_ERRORS,
  type EmployeeImportMessage,
  type ImportJobError,
  type ImportJobView,
  type ImportLineError,
} from "./queue.ts";
import { blankRecord, mapImportRow, readHeader } from "./rows.ts";

export interface ImportProcessResult {
  job: ImportJobView;
  peakRssBytes: number;
}

interface AcceptedRow {
  line: number;
  nikHash: string;
  employeeCode: string;
}

interface ScanResult {
  total: number;
  errors: ImportLineError[];
  accepted: AcceptedRow[];
}

/**
 * Streams the CSV from object storage one record at a time.
 * Dry-run writes no employees. Commit writes every row in one transaction, or none.
 */
export async function processEmployeeImport(
  deps: { appDb: TenantDatabase; storage: ObjectStorage },
  message: EmployeeImportMessage,
): Promise<ImportProcessResult> {
  let peakRssBytes = process.memoryUsage().rss;
  const sample = (): void => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
  };
  try {
    const job = await runImport(deps, message, sample);
    sample();
    return { job, peakRssBytes };
  } catch (error) {
    sample();
    if (error instanceof ImportAlreadyFinished) {
      const current = await readImportJob(deps.appDb, message.tenantId, message.importJobId);
      if (!current) throw error;
      return { job: toImportView(current), peakRssBytes };
    }
    throw error;
  }
}

class ImportRollback extends Error {
  readonly lineErrors: ImportLineError[];

  constructor(lineErrors: ImportLineError[]) {
    super(ALL_OR_NOTHING_ROLLBACK);
    this.name = "ImportRollback";
    this.lineErrors = lineErrors;
  }
}

class ImportAlreadyFinished extends Error {
  constructor() {
    super("import already finished");
    this.name = "ImportAlreadyFinished";
  }
}

async function runImport(
  deps: { appDb: TenantDatabase; storage: ObjectStorage },
  message: EmployeeImportMessage,
  sample: () => void,
): Promise<ImportJobView> {
  const existing = await readImportJob(deps.appDb, message.tenantId, message.importJobId);
  if (!existing) throw new Error("import job was not found");
  if (existing.status === "completed" || existing.status === "failed") return toImportView(existing);
  const claimed = await deps.appDb.withTenantContext(message.tenantId, async (tx) => claimImportJob(tx, existing.id));
  if (!claimed) {
    const current = await readImportJob(deps.appDb, message.tenantId, existing.id);
    if (!current) throw new Error("import job was not found");
    return toImportView(current);
  }
  const job = { ...existing, status: "running" as const };
  const tenantId = message.tenantId;
  try {
    await assertReady(deps, job);
    const secrets = await loadSecrets(deps.appDb, tenantId);
    const scan = await scanFile(deps.storage, job, secrets, sample);
    const withDuplicates = await appendDatabaseDuplicates(deps.appDb, tenantId, scan);
    if (job.mode === "dry_run" || withDuplicates.errors.length > 0) {
      return await saveChecked(deps.appDb, tenantId, job, withDuplicates);
    }
    await commitFile(deps, tenantId, job, secrets, withDuplicates.accepted.length, sample);
    const saved = await readImportJob(deps.appDb, tenantId, job.id);
    if (!saved) throw new Error("import job was not found");
    return toImportView(saved);
  } catch (error) {
    if (error instanceof ImportAlreadyFinished) throw error;
    const lineErrors =
      error instanceof ImportRollback
        ? error.lineErrors
        : error instanceof CsvFormatError
          ? [{ line: error.line, field: "file", message: error.message }]
          : error instanceof EmployeeFieldError
            ? error.fields.map((field) => ({ line: 1, field: field.field, message: field.message }))
            : [{ line: 1, field: "file", message: "The import could not be read." }];
    return saveFailure(deps.appDb, tenantId, job.id, lineErrors);
  }
}

async function assertReady(
  deps: { storage: ObjectStorage },
  job: StoredImportJob,
): Promise<void> {
  const info = await deps.storage.stat({ key: job.storageKey });
  if (!info || info.byteSize < 1 || info.byteSize > MAX_UPLOAD_BYTES) {
    throw new ImportRollback([{ line: 1, field: "file", message: "The CSV is missing or larger than 2 MB." }]);
  }
}

async function loadSecrets(appDb: TenantDatabase, tenantId: string): Promise<ImportSecrets> {
  return appDb.withTenantContext(tenantId, async (tx) => {
    await provisionTenantKeys(tx, tenantId);
    const secrets = await readTenantSecrets(tx, tenantId);
    return { dek: secrets.dek, pepper: secrets.pepper };
  });
}

async function scanFile(
  storage: ObjectStorage,
  job: StoredImportJob,
  secrets: ImportSecrets,
  sample: () => void,
): Promise<ScanResult> {
  const stream = await storage.openRead({ key: job.storageKey });
  try {
    const errors: ImportLineError[] = [];
    const accepted: AcceptedRow[] = [];
    const seenNik = new Set<string>();
    const seenCode = new Set<string>();
    let columns: Map<string, number> | null = null;
    let total = 0;
    const placement = { legalEntityId: job.legalEntityId, branchId: job.branchId };
    try {
      for await (const record of csvRecords(stream)) {
        sample();
        if (!columns) {
          const header = readHeader(record.fields);
          if (!header.ok) throw new ImportRollback([{ line: record.line, field: "file", message: header.message }]);
          columns = header.columns;
          continue;
        }
        if (blankRecord(record.fields)) continue;
        total += 1;
        if (total > MAX_IMPORT_ROWS) {
          throw new ImportRollback([
            { line: record.line, field: "file", message: `An import accepts at most ${MAX_IMPORT_ROWS} rows.` },
          ]);
        }
        const parsed = mapImportRow(record.fields, columns, placement);
        if (!parsed.ok) {
          pushErrors(errors, record.line, parsed.fields);
          continue;
        }
        if (seenCode.has(parsed.value.employeeCode)) {
          pushErrors(errors, record.line, [
            { field: "employeeCode", message: "This employee code is already used in this file." },
          ]);
          continue;
        }
        if (seenNik.has(parsed.value.nik)) {
          pushErrors(errors, record.line, [{ field: "nik", message: "This NIK is already used in this file." }]);
          continue;
        }
        seenCode.add(parsed.value.employeeCode);
        seenNik.add(parsed.value.nik);
        accepted.push({
          line: record.line,
          nikHash: hashNik(secrets, parsed.value.nik),
          employeeCode: parsed.value.employeeCode,
        });
      }
    } catch (error) {
      if (error instanceof CsvFormatError) {
        throw new ImportRollback([{ line: error.line, field: "file", message: error.message }]);
      }
      throw error;
    }
    if (!columns) {
      throw new ImportRollback([{ line: 1, field: "file", message: "The CSV needs a header row." }]);
    }
    if (total === 0) {
      throw new ImportRollback([{ line: 1, field: "file", message: "The CSV has no employee rows." }]);
    }
    return { total, errors, accepted };
  } finally {
    destroyStream(stream);
  }
}

async function appendDatabaseDuplicates(
  appDb: TenantDatabase,
  tenantId: string,
  scan: ScanResult,
): Promise<ScanResult> {
  if (scan.accepted.length === 0) return scan;
  const duplicates = await appDb.withTenantContext(tenantId, async (tx) => {
    const nikHits = await existingNikHashes(tx, scan.accepted.map((row) => row.nikHash));
    const codeHits = await existingCodes(tx, scan.accepted.map((row) => row.employeeCode));
    return { nikHits, codeHits };
  });
  const errors = [...scan.errors];
  const accepted: AcceptedRow[] = [];
  for (const row of scan.accepted) {
    const nikUsed = duplicates.nikHits.has(row.nikHash);
    const codeUsed = duplicates.codeHits.has(row.employeeCode);
    if (!nikUsed && !codeUsed) {
      accepted.push(row);
      continue;
    }
    if (nikUsed) pushErrors(errors, row.line, [{ field: "nik", message: "This NIK is already used." }]);
    if (codeUsed) {
      pushErrors(errors, row.line, [{ field: "employeeCode", message: "This employee code is already used." }]);
    }
  }
  return { total: scan.total, errors, accepted };
}

async function commitFile(
  deps: { appDb: TenantDatabase; storage: ObjectStorage },
  tenantId: string,
  job: StoredImportJob,
  secrets: ImportSecrets,
  expected: number,
  sample: () => void,
): Promise<void> {
  await deps.appDb.withTenantContext(tenantId, async (tx) => {
    const locked = await lockImportJobTx(tx, job.id);
    if (!locked || locked.status === "completed" || locked.status === "failed") {
      throw new ImportAlreadyFinished();
    }
    await assertImportPlacement(tx, job.legalEntityId, job.branchId);
    const stream = await deps.storage.openRead({ key: job.storageKey });
    const actor = actorOf(job, tenantId);
    let columns: Map<string, number> | null = null;
    let written = 0;
    try {
      for await (const record of csvRecords(stream)) {
        sample();
        if (!columns) {
          const header = readHeader(record.fields);
          if (!header.ok) throw new ImportRollback([{ line: record.line, field: "file", message: header.message }]);
          columns = header.columns;
          continue;
        }
        if (blankRecord(record.fields)) continue;
        const parsed = mapImportRow(record.fields, columns, {
          legalEntityId: job.legalEntityId,
          branchId: job.branchId,
        });
        if (!parsed.ok) {
          throw new ImportRollback(
            parsed.fields.map((field) => ({ line: record.line, field: field.field, message: field.message })),
          );
        }
        await insertOne(tx, actor, parsed.value, secrets, record.line);
        written += 1;
      }
      if (written !== expected) {
        throw new ImportRollback([
          { line: 1, field: "file", message: "The file changed while the import was checking it." },
        ]);
      }
    } finally {
      destroyStream(stream);
    }
    await finishImportJob(tx, job.id, {
      status: "completed",
      totalRows: written,
      validRows: written,
      errorRows: 0,
      writtenRows: written,
      lineErrors: [],
      error: {
        code: "committed",
        message: "Every row was written.",
        allOrNothing: true,
        written,
      },
    });
  });
}

async function insertOne(
  tx: TenantTx,
  actor: ImportActor,
  input: EmployeeCreateInput,
  secrets: ImportSecrets,
  line: number,
): Promise<void> {
  try {
    await insertImportedEmployee(tx, actor, input, secrets);
  } catch (error) {
    if (errorCode(error) === "23503") {
      const constraint = errorConstraint(error);
      const field = constraint.includes("department")
        ? "departmentId"
        : constraint.includes("position")
          ? "positionId"
          : "branchId";
      throw new ImportRollback([{ line, field, message: "That reference was not found." }]);
    }
    if (errorCode(error) !== "23505") throw error;
    const constraint = errorConstraint(error);
    const field = constraint.includes("nik_hash") ? "nik" : constraint.includes("code") ? "employeeCode" : "body";
    const message = field === "nik" ? "This NIK is already used." : "That value is already used.";
    throw new ImportRollback([{ line, field, message }]);
  }
}

async function saveChecked(
  appDb: TenantDatabase,
  tenantId: string,
  job: StoredImportJob,
  scan: ScanResult,
): Promise<ImportJobView> {
  const errorLines = new Set(scan.errors.map((error) => error.line));
  const errorRows = Math.min(errorLines.size, scan.total);
  const validRows = scan.total - errorRows;
  const failed = job.mode === "commit" && scan.errors.length > 0;
  const error: ImportJobError = failed
    ? { code: "import_rolled_back", message: ALL_OR_NOTHING_ROLLBACK, allOrNothing: true, written: 0 }
    : { code: "dry_run", message: DRY_RUN_WRITES_NOTHING, allOrNothing: true, written: 0 };
  return writeTerminal(appDb, tenantId, job.id, {
    status: failed ? "failed" : "completed",
    totalRows: scan.total,
    validRows,
    errorRows,
    writtenRows: 0,
    lineErrors: scan.errors,
    error,
  });
}

async function saveFailure(
  appDb: TenantDatabase,
  tenantId: string,
  jobId: string,
  lineErrors: ImportLineError[],
): Promise<ImportJobView> {
  return writeTerminal(appDb, tenantId, jobId, {
    status: "failed",
    totalRows: 0,
    validRows: 0,
    errorRows: 0,
    writtenRows: 0,
    lineErrors,
    error: {
      code: "import_rolled_back",
      message: ALL_OR_NOTHING_ROLLBACK,
      allOrNothing: true,
      written: 0,
    },
  });
}

async function writeTerminal(
  appDb: TenantDatabase,
  tenantId: string,
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
): Promise<ImportJobView> {
  await appDb.withTenantContext(tenantId, async (tx) => {
    await finishImportJob(tx, jobId, input);
  });
  const saved = await readImportJob(appDb, tenantId, jobId);
  if (!saved) throw new Error("import job was not found");
  return toImportView(saved);
}

function actorOf(job: StoredImportJob, tenantId: string): ImportActor {
  return {
    tenantId,
    userId: job.requestedBy,
    role: job.actorRole,
    ipAddress: job.ipAddress,
    userAgent: job.userAgent,
  };
}

function pushErrors(
  errors: ImportLineError[],
  line: number,
  fields: { field: string; message: string }[],
): void {
  for (const field of fields) {
    if (errors.length >= MAX_STORED_LINE_ERRORS) return;
    errors.push({ line, field: field.field, message: field.message });
  }
}

async function existingNikHashes(tx: TenantTx, hashes: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const slice of chunks(hashes, 200)) {
    const rows = queryRows<{ nik_hash: string }>(
      await tx.execute(sql`
        SELECT nik_hash
        FROM hr_employee_pii
        WHERE nik_hash IN (${sql.join(slice.map((hash) => sql`${hash}`), sql`, `)})
      `),
    );
    for (const row of rows) found.add(row.nik_hash);
  }
  return found;
}

async function existingCodes(tx: TenantTx, codes: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const slice of chunks(codes, 200)) {
    const rows = queryRows<{ employee_code: string }>(
      await tx.execute(sql`
        SELECT employee_code
        FROM hr_employees
        WHERE employee_code IN (${sql.join(slice.map((code) => sql`${code}`), sql`, `)})
      `),
    );
    for (const row of rows) found.add(row.employee_code);
  }
  return found;
}

function destroyStream(stream: AsyncIterable<Uint8Array | string>): void {
  if (typeof stream === "object" && stream && "destroy" in stream && typeof stream.destroy === "function") {
    stream.destroy();
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size));
  return groups;
}
