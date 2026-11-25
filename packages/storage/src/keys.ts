import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { MAX_UPLOAD_BYTES } from "./types.ts";

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}$/;

export const MAX_TOKEN_TTL_SECONDS = 900;

export interface ObjectToken {
  key: string;
  method: "PUT" | "GET";
  exp: number;
  maxBytes: number;
}

export function assertObjectKey(key: string): void {
  if (!keyPattern.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error("Object key is not allowed.");
  }
}

export function resolveObjectPath(rootDir: string, key: string): string {
  assertObjectKey(key);
  const root = path.resolve(rootDir);
  const full = path.resolve(root, key);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
    throw new Error("Object key escapes the storage root.");
  }
  return full;
}

export function tokenExpiry(expiresInSeconds: number | undefined, now = Date.now()): number {
  const ttl = expiresInSeconds ?? MAX_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TOKEN_TTL_SECONDS) {
    throw new Error("Token lifetime must be a whole number of seconds up to 900.");
  }
  return Math.floor(now / 1000) + ttl;
}

export function assertTokenExpiry(exp: number, now = Date.now()): void {
  if (!Number.isInteger(exp)) {
    throw new Error("Object token expiry is invalid.");
  }
  const seconds = Math.floor(now / 1000);
  if (exp <= seconds) {
    throw new Error("Object token is expired.");
  }
  if (exp > seconds + MAX_TOKEN_TTL_SECONDS) {
    throw new Error("Object token lifetime is too long.");
  }
}

export function signToken(token: ObjectToken, secret: string): string {
  assertTokenExpiry(token.exp);
  const body = Buffer.from(JSON.stringify(token)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function readToken(token: string, secret: string, method: ObjectToken["method"]): ObjectToken {
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra) {
    throw new Error("Object token is malformed.");
  }
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const actualBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    throw new Error("Object token signature does not match.");
  }
  const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Object token payload is invalid.");
  }
  const record = parsed as Partial<ObjectToken>;
  if (record.method !== method || typeof record.key !== "string" || typeof record.exp !== "number") {
    throw new Error("Object token payload is invalid.");
  }
  if (typeof record.maxBytes !== "number" || record.maxBytes < 1 || record.maxBytes > MAX_UPLOAD_BYTES) {
    throw new Error("Object token size cap is invalid.");
  }
  assertTokenExpiry(record.exp);
  assertObjectKey(record.key);
  return {
    key: record.key,
    method,
    exp: record.exp,
    maxBytes: record.maxBytes,
  };
}
