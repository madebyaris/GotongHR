import { appendAuditEvent } from "@gotonghr/audit";
import { MAX_UPLOAD_BYTES, type ObjectStorage, type PresignedGet, type PresignedPut } from "@gotonghr/storage";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { assertReadable, assertWritable } from "../access.ts";
import type { CoreHrAuth } from "../auth.ts";
import { EmployeeConflictError, EmployeeFieldError, EmployeeNotFoundError } from "../errors.ts";
import { findEmployeeTx } from "../read.ts";
import { asObject, clip, errorCode, queryRows } from "../sql.ts";
import {
  documentStorageKey,
  isDocumentContentType,
  isDocumentType,
  parseDocumentKey,
  safeFileName,
  type DocumentContentType,
  type DocumentType,
} from "./keys.ts";

export interface EmployeeDocumentRecord {
  id: string;
  employeeId: string;
  docType: DocumentType;
  fileName: string;
  contentType: DocumentContentType;
  byteSize: number;
  uploadedBy: string;
  createdAt: string;
}

export interface DocumentUpload {
  documentId: string;
  storageKey: string;
  upload: PresignedPut;
}

export async function createDocumentUpload(
  appDb: TenantDatabase,
  storage: ObjectStorage,
  auth: CoreHrAuth,
  employeeId: string,
  input: Record<string, unknown>,
): Promise<DocumentUpload> {
  assertWritable(auth);
  const fileName = safeFileName(input.fileName);
  const contentType = typeof input.contentType === "string" ? input.contentType : "";
  const docType = typeof input.docType === "string" ? input.docType : "";
  const byteSize = parseByteSize(input.byteSize);
  const fields = uploadFields(fileName, contentType, docType, byteSize);
  if (fields.length > 0 || !fileName || !isDocumentContentType(contentType) || !isDocumentType(docType) || !byteSize) {
    throw new EmployeeFieldError(fields);
  }
  const documentId = await appDb.withTenantContext(auth.tenantId, async (tx) => {
    const employee = await findEmployeeTx(tx, auth, employeeId);
    if (!employee) throw new EmployeeNotFoundError();
    return newId(tx);
  });
  const storageKey = documentStorageKey(auth.tenantId, employeeId, documentId, fileName);
  const upload = await storage.presignPut({ key: storageKey, contentType, maxBytes: byteSize });
  return { documentId, storageKey, upload };
}

export async function confirmDocument(
  appDb: TenantDatabase,
  storage: ObjectStorage,
  auth: CoreHrAuth,
  employeeId: string,
  input: Record<string, unknown>,
): Promise<EmployeeDocumentRecord> {
  assertWritable(auth);
  const fileName = safeFileName(input.fileName);
  const contentType = typeof input.contentType === "string" ? input.contentType : "";
  const docType = typeof input.docType === "string" ? input.docType : "";
  const byteSize = parseByteSize(input.byteSize);
  const storageKey = typeof input.storageKey === "string" ? input.storageKey : "";
  const parsedKey = parseDocumentKey(storageKey);
  const fields = uploadFields(fileName, contentType, docType, byteSize);
  if (!parsedKey || parsedKey.tenantId !== auth.tenantId.toLowerCase() || parsedKey.employeeId !== employeeId.toLowerCase()) {
    fields.push({ field: "storageKey", message: "Upload the file with the key from this company." });
  } else if (fileName && parsedKey.fileName !== fileName) {
    fields.push({ field: "fileName", message: "The file name does not match the upload." });
  }
  if (typeof input.documentId === "string" && parsedKey && input.documentId.toLowerCase() !== parsedKey.documentId) {
    fields.push({ field: "documentId", message: "The document id does not match the upload." });
  }
  if (fields.length > 0 || !fileName || !isDocumentContentType(contentType) || !isDocumentType(docType) || !byteSize || !parsedKey) {
    throw new EmployeeFieldError(fields);
  }
  const stored = await storage.stat({ key: storageKey });
  if (!stored || stored.byteSize !== byteSize) {
    throw new EmployeeFieldError([{ field: "byteSize", message: "Upload the file before saving it." }]);
  }
  try {
    return await appDb.withTenantContext(auth.tenantId, async (tx) => {
      const employee = await findEmployeeTx(tx, auth, employeeId);
      if (!employee) throw new EmployeeNotFoundError();
      const inserted = queryRows<{ id: string; created_at: string; before_json: unknown; after_json: unknown }>(
        await tx.execute(sql`
          INSERT INTO hr_documents (
            id, tenant_id, employee_id, doc_type, file_name, storage_key, content_type, byte_size, uploaded_by
          )
          VALUES (
            ${parsedKey.documentId}::uuid,
            ${auth.tenantId}::uuid,
            ${employeeId}::uuid,
            ${docType},
            ${fileName},
            ${storageKey},
            ${contentType},
            ${byteSize},
            ${auth.userId}::uuid
          )
          RETURNING WITH (OLD AS before_row, NEW AS after_row)
            id::text AS id,
            created_at::text AS created_at,
            to_jsonb(before_row) AS before_json,
            to_jsonb(after_row) AS after_json
        `),
      );
      const row = inserted[0];
      if (!row?.id) throw new Error("document insert returned no row");
      await appendAuditEvent(
        tx,
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          actorRole: auth.role,
          action: "employee.document.create",
          resourceType: "hr_documents",
          resourceId: row.id,
          diff: { before: asObject(row.before_json), after: asObject(row.after_json) },
          aiProposalId: null,
          supportGrantId: null,
          ipAddress: clip(auth.ipAddress, 64),
          userAgent: clip(auth.userAgent, 512),
        },
        { requireTenantKeys: true },
      );
      return {
        id: row.id,
        employeeId,
        docType,
        fileName,
        contentType,
        byteSize,
        uploadedBy: auth.userId,
        createdAt: row.created_at,
      };
    });
  } catch (error) {
    if (error instanceof EmployeeFieldError || error instanceof EmployeeNotFoundError) throw error;
    if (errorCode(error) === "23505") {
      throw new EmployeeConflictError([{ field: "storageKey", message: "That document is already saved." }]);
    }
    throw error;
  }
}

export async function listDocuments(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  employeeId: string,
  page: { limit: number; offset: number },
): Promise<EmployeeDocumentRecord[]> {
  assertReadable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const employee = await findEmployeeTx(tx, auth, employeeId);
    if (!employee) throw new EmployeeNotFoundError();
    const rows = queryRows<{
      id: string;
      employee_id: string;
      doc_type: string;
      file_name: string;
      content_type: string;
      byte_size: number;
      uploaded_by: string;
      created_at: string;
    }>(
      await tx.execute(sql`
        SELECT id::text AS id,
               employee_id::text AS employee_id,
               doc_type,
               file_name,
               content_type,
               byte_size,
               uploaded_by::text AS uploaded_by,
               created_at::text AS created_at
        FROM hr_documents
        WHERE employee_id = ${employeeId}::uuid
        ORDER BY created_at, id
        LIMIT ${page.limit} OFFSET ${page.offset}
      `),
    );
    return rows.map((row) => {
      if (!isDocumentType(row.doc_type) || !isDocumentContentType(row.content_type)) {
        throw new Error("document row is not valid");
      }
      return {
        id: row.id,
        employeeId: row.employee_id,
        docType: row.doc_type,
        fileName: row.file_name,
        contentType: row.content_type,
        byteSize: Number(row.byte_size),
        uploadedBy: row.uploaded_by,
        createdAt: row.created_at,
      };
    });
  });
}

export class DocumentNotFoundError extends Error {
  constructor() {
    super("That document was not found.");
    this.name = "DocumentNotFoundError";
  }
}

export async function createDocumentDownload(
  appDb: TenantDatabase,
  storage: ObjectStorage,
  auth: CoreHrAuth,
  employeeId: string,
  documentId: string,
): Promise<PresignedGet> {
  assertReadable(auth);
  const storageKey = await appDb.withTenantContext(auth.tenantId, async (tx) => {
    const employee = await findEmployeeTx(tx, auth, employeeId);
    if (!employee) throw new EmployeeNotFoundError();
    const rows = queryRows<{ storage_key: string }>(
      await tx.execute(sql`
        SELECT storage_key
        FROM hr_documents
        WHERE id = ${documentId}::uuid
          AND employee_id = ${employeeId}::uuid
      `),
    );
    return rows[0]?.storage_key ?? null;
  });
  if (!storageKey || !storageKey.startsWith(`t/${auth.tenantId.toLowerCase()}/`)) {
    throw new DocumentNotFoundError();
  }
  return storage.presignGet({ key: storageKey });
}

function uploadFields(
  fileName: string | null,
  contentType: string,
  docType: string,
  byteSize: number | null,
): { field: string; message: string }[] {
  const fields: { field: string; message: string }[] = [];
  if (!fileName) fields.push({ field: "fileName", message: "Use a file name of letters, digits, dots, or dashes." });
  if (!isDocumentContentType(contentType)) {
    fields.push({ field: "contentType", message: "Use a PDF, JPEG, PNG, or WebP file." });
  }
  if (!isDocumentType(docType)) fields.push({ field: "docType", message: "Choose a document type." });
  if (!byteSize) fields.push({ field: "byteSize", message: "File must be between 1 byte and 2 MB." });
  return fields;
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
