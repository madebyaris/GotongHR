import { createHmac } from "node:crypto";

/**
 * HMAC-SHA256 of the trimmed NFKC value. The same pepper and the same value
 * always return the same hex digest. A different pepper returns a different digest.
 */
export function blindIndex(pepper: Buffer, value: string): string {
  if (pepper.length !== 32) {
    throw new Error("pepper must be 32 bytes.");
  }
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0) {
    throw new Error("blind index value is empty");
  }
  return createHmac("sha256", pepper).update(normalized, "utf8").digest("hex");
}
