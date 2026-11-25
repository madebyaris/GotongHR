import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const HASH_HEX = /^[0-9a-f]{64}$/u;

export const PROPOSAL_TTL_MINUTES = 15;

/** High-entropy secret. Only the SHA-256 hex is stored. */
export function createConfirmationNonce(): { nonce: string; hash: string } {
  const nonce = randomBytes(32).toString("base64url");
  return { nonce, hash: hashNonce(nonce) };
}

export function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

/**
 * Compares the caller-supplied secret with the stored digest.
 * The digest compare always runs, including when the stored value is not a hash.
 */
export function nonceMatches(nonce: string, storedHash: string): boolean {
  const computed = hashNonce(nonce);
  const storedOk = HASH_HEX.test(storedHash);
  const left = Buffer.from(computed, "hex");
  const right = Buffer.from(storedOk ? storedHash : computed, "hex");
  const equal = timingSafeEqual(left, right);
  return storedOk && equal;
}
