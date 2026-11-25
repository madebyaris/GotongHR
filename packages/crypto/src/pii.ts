import { fieldAad, open, seal } from "./envelope.ts";
import { isPiiField, type PiiField } from "./fields.ts";

/**
 * Encrypts one PII field under the tenant DEK.
 * List responses use the mask helpers. They do not call this module's open path.
 * Audited plaintext goes through `@gotonghr/audit/reveal`.
 */
export function encryptField(
  dek: Buffer,
  tenantId: string,
  field: PiiField,
  plaintext: string,
): string {
  if (!isPiiField(field)) throw new Error("unknown pii field");
  if (plaintext.length === 0) throw new Error("plaintext is empty");
  return seal(dek, Buffer.from(plaintext, "utf8"), fieldAad(tenantId, field));
}

export function decryptField(
  dek: Buffer,
  tenantId: string,
  field: PiiField,
  envelope: string,
): string {
  if (!isPiiField(field)) throw new Error("unknown pii field");
  return open(dek, envelope, fieldAad(tenantId, field)).toString("utf8");
}
