import { MAX_UPLOAD_BYTES, type ObjectStorage, type PresignedPut } from "@gotonghr/storage";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { assertInScope, assertReadable, assertWritable } from "../access.ts";
import type { CoreHrAuth } from "../auth.ts";
import { EmployeeConflictError, EmployeeFieldError } from "../errors.ts";
import { clip, errorCode, queryRows } from "../sql.ts";
import { insertImportJob, readImportJob, toImportView } from "./jobs.ts";
import { parseImportKey, importStorageKey } from "./keys.ts";
import { assertImportPlacement } from "./placement.ts";
import type { EmployeeImportMessage, ImportJobView, ImportMode } from "./queue.ts";
import { finishImportJob } from "./jobs.ts";
import { ALL_OR_NOTHING_ROLLBACK } from "./queue.ts";

export interface ImportUpload {
  storageKey: string;
  contentType: "text/csv";
  upload: PresignedPut;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function createImportUpload(
  appDb: TenantDatabase,
  storage: ObjectStorage,
  auth: CoreHrAuth,
  byteSize: unknown,
): Promise<ImportUpload> {
  assertWritable(auth);
  const size = parseByteSize(byteSize);
  if (!size) {
    throw new EmployeeFieldError([{ field: "byteSize", message: "File must be between 1 byte and 2 MB." }]);
  }
  const jobId = await appDb.withTenantContext(auth.tenantId, async (tx) => newId(tx));
  const storageKey = importStorageKey(auth.tenantId, jobId);
  const upload = await storage.presignPut({ key: storageKey, contentType: "text/csv", maxBytes: size });
  return { storageKey, contentType: "text/csv", upload };
}

export async function createEmployeeImport(
  appDb: TenantDatabase,
  storage: ObjectStorage,
  auth: CoreHrAuth,
  input: Record<string, unknown>,
  enqueue: (message: EmployeeImportMessage) => Promise<void>,
): Promise<ImportJobView> {
  assertWritable(auth);
  const storageKey = typeof input.storageKey === "string" ? input.storageKey : "";
  const parsedKey = parseImportKey(storageKey);
  const mode = parseMode(input.mode);
  const legalEntityId = parseUuid(input.legalEntityId);
  const branchId = parseUuid(input.branchId);
  const fields: { field: string; message: string }[] = [];
  if (!parsedKey || parsedKey.tenantId !== auth.tenantId.toLowerCase()) {
    fields.push({ field: "storageKey", message: "Upload the CSV with the key from this company." });
  }
  if (!mode) fields.push({ field: "mode", message: "Choose dry_run or commit." });
  if (!legalEntityId) fields.push({ field: "legalEntityId", message: "Choose a legal entity." });
  if (!branchId) fields.push({ field: "branchId", message: "Choose a branch." });
  if (fields.length > 0 || !parsedKey || !mode || !legalEntityId || !branchId) {
    throw new EmployeeFieldError(fields);
  }
  assertInScope(auth, legalEntityId, branchId);
  const stored = await storage.stat({ key: storageKey });
  if (!stored || stored.byteSize < 1 || stored.byteSize > MAX_UPLOAD_BYTES) {
    throw new EmployeeFieldError([{ field: "storageKey", message: "Upload the CSV before starting the import." }]);
  }
  const actorRole = clip(auth.role, 80) ?? "hr_admin";
  try {
    await appDb.withTenantContext(auth.tenantId, async (tx) => {
      await assertImportPlacement(tx, legalEntityId, branchId);
      await insertImportJob(tx, {
        id: parsedKey.jobId,
        tenantId: auth.tenantId,
        mode,
        storageKey,
        legalEntityId,
        branchId,
        requestedBy: auth.userId,
        actorRole,
        ipAddress: clip(auth.ipAddress, 64),
        userAgent: clip(auth.userAgent, 512),
      });
    });
  } catch (error) {
    if (error instanceof EmployeeFieldError) throw error;
    if (errorCode(error) === "23505") {
      throw new EmployeeConflictError([{ field: "storageKey", message: "This import was already started." }]);
    }
    throw error;
  }
  try {
    await enqueue({ tenantId: auth.tenantId, importJobId: parsedKey.jobId });
  } catch (error) {
    await appDb.withTenantContext(auth.tenantId, async (tx) => {
      await finishImportJob(tx, parsedKey.jobId, {
        status: "failed",
        totalRows: 0,
        validRows: 0,
        errorRows: 0,
        writtenRows: 0,
        lineErrors: [{ line: 1, field: "file", message: "The import could not be queued." }],
        error: {
          code: "import_rolled_back",
          message: ALL_OR_NOTHING_ROLLBACK,
          allOrNothing: true,
          written: 0,
        },
      });
    });
    throw error;
  }
  const saved = await readImportJob(appDb, auth.tenantId, parsedKey.jobId);
  if (!saved) throw new ImportNotFoundError();
  return toImportView(saved);
}

export class ImportNotFoundError extends Error {
  constructor() {
    super("That import was not found.");
    this.name = "ImportNotFoundError";
  }
}

export async function getEmployeeImport(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  jobId: string,
): Promise<ImportJobView> {
  assertReadable(auth);
  const saved = await readImportJob(appDb, auth.tenantId, jobId);
  if (!saved) throw new ImportNotFoundError();
  return toImportView(saved);
}

function parseMode(value: unknown): ImportMode | null {
  if (value === "dry_run" || value === "commit") return value;
  return null;
}

function parseUuid(value: unknown): string | null {
  if (typeof value !== "string" || !UUID.test(value)) return null;
  return value.toLowerCase();
}

function parseByteSize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 1 || value > MAX_UPLOAD_BYTES) return null;
  return value;
}

async function newId(tx: TenantTx): Promise<string> {
  const rows = queryRows<{ id: string }>(await tx.execute(sql`SELECT uuidv7()::text AS id`));
  const id = rows[0]?.id;
  if (!id) throw new Error("uuidv7 returned no id");
  return id;
}
