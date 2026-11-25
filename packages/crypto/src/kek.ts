const HEX_KEY = /^[0-9a-fA-F]{64}$/u;
const BASE64_KEY = /^[A-Za-z0-9+/_-]+={0,2}$/u;

/**
 * Reads the 32-byte key-encryption key from `GOTONG_PII_KEK`.
 * The value is base64, base64url, or 64 hex characters. There is no default.
 */
export function loadKek(env: NodeJS.ProcessEnv): Buffer {
  const value = env.GOTONG_PII_KEK;
  if (!value) {
    throw new Error("Missing GOTONG_PII_KEK.");
  }
  return decodeKek(value);
}

export function decodeKek(value: string): Buffer {
  const trimmed = value.trim();
  if (HEX_KEY.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  if (!BASE64_KEY.test(trimmed)) {
    throw new Error("GOTONG_PII_KEK must be 32 bytes encoded as base64 or hex.");
  }
  const normalized = trimmed.replace(/-/gu, "+").replace(/_/gu, "/").replace(/=+$/u, "");
  const padLength = (4 - (normalized.length % 4)) % 4;
  const decoded = Buffer.from(`${normalized}${"=".repeat(padLength)}`, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/u, "");
  if (decoded.length !== 32 || canonical !== normalized) {
    throw new Error("GOTONG_PII_KEK must be 32 bytes encoded as base64 or hex.");
  }
  return decoded;
}
