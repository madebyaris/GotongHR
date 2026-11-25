import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PiiCryptoError } from "./errors.ts";
import { isPiiField, type PiiField } from "./fields.ts";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function assertKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error("AES-256 key must be 32 bytes.");
  }
}

function tenantIdForAad(tenantId: string): string {
  if (!UUID.test(tenantId)) {
    throw new Error("tenant id must be a uuid");
  }
  return tenantId.toLowerCase();
}

/** Binds ciphertext to one tenant and one PII field. */
export function fieldAad(tenantId: string, field: PiiField): Buffer {
  const tenant = tenantIdForAad(tenantId);
  if (!isPiiField(field)) {
    throw new Error("unknown pii field");
  }
  return Buffer.from(`pii\n${tenant}\n${field}`, "utf8");
}

export function keyAad(kind: "dek" | "pepper", tenantId: string): Buffer {
  const tenant = tenantIdForAad(tenantId);
  return Buffer.from(`${kind}\n${tenant}`, "utf8");
}

/**
 * AES-256-GCM envelope: version byte, 96-bit IV, 128-bit tag, ciphertext.
 * A fresh random IV is used for every call. The result is base64url.
 */
export function seal(key: Buffer, plaintext: Buffer, aad: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]).toString("base64url");
}

export function open(key: Buffer, envelope: string, aad: Buffer): Buffer {
  assertKey(key);
  const packed = Buffer.from(envelope, "base64url");
  if (packed.toString("base64url") !== envelope || packed.length < HEADER_BYTES) {
    throw new PiiCryptoError("ciphertext failed authentication");
  }
  const version = packed[0];
  if (version !== VERSION) {
    throw new PiiCryptoError("unsupported envelope version");
  }
  const iv = packed.subarray(1, 1 + IV_BYTES);
  const tag = packed.subarray(1 + IV_BYTES, HEADER_BYTES);
  const ciphertext = packed.subarray(HEADER_BYTES);
  if (tag.length !== TAG_BYTES) {
    throw new PiiCryptoError("ciphertext failed authentication");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    if (error instanceof PiiCryptoError) throw error;
    throw new PiiCryptoError("ciphertext failed authentication");
  }
}
