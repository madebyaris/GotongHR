export const documentTypes = ["ktp", "npwp", "kk", "bpjs", "contract", "other"] as const;
export const documentContentTypes = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;

export type DocumentType = (typeof documentTypes)[number];
export type DocumentContentType = (typeof documentContentTypes)[number];

const documentTypeSet: ReadonlySet<string> = new Set(documentTypes);
const contentTypeSet: ReadonlySet<string> = new Set(documentContentTypes);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const documentKey =
  /^t\/([0-9a-f-]{36})\/emp\/([0-9a-f-]{36})\/doc\/([0-9a-f-]{36})\/([A-Za-z0-9][A-Za-z0-9._-]{0,59})$/u;

export function isDocumentType(value: string): value is DocumentType {
  return documentTypeSet.has(value);
}

export function isDocumentContentType(value: string): value is DocumentContentType {
  return contentTypeSet.has(value);
}

/** Drops any path and characters that cannot appear in an object key. */
export function safeFileName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const base = input.trim().replace(/\\/gu, "/").split("/").pop() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/u.test(base)) return null;
  if (base.includes("..")) return null;
  return base;
}

export function documentStorageKey(
  tenantId: string,
  employeeId: string,
  documentId: string,
  fileName: string,
): string {
  return `t/${tenantId.toLowerCase()}/emp/${employeeId.toLowerCase()}/doc/${documentId.toLowerCase()}/${fileName}`;
}

export function parseDocumentKey(key: string): {
  tenantId: string;
  employeeId: string;
  documentId: string;
  fileName: string;
} | null {
  const match = documentKey.exec(key);
  if (!match) return null;
  const tenantId = match[1]?.toLowerCase() ?? "";
  const employeeId = match[2]?.toLowerCase() ?? "";
  const documentId = match[3]?.toLowerCase() ?? "";
  const fileName = match[4] ?? "";
  if (!UUID.test(tenantId) || !UUID.test(employeeId) || !UUID.test(documentId)) return null;
  return { tenantId, employeeId, documentId, fileName };
}
