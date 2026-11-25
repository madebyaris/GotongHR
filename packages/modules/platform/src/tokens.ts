import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const MAX_GRANT_MS = 4 * 60 * 60 * 1000;

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function expiryError(expiresAt: Date, now: Date): "past" | "too_long" | null {
  const delta = expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(delta) || delta <= 0) return "past";
  if (delta > MAX_GRANT_MS) return "too_long";
  return null;
}

export interface InvitePayload {
  tenantId: string;
  email: string;
  exp: number;
}

/** Signed invite. Callers store `hashToken` of the result and return the token once. */
export function signInvite(secret: string, payload: InvitePayload): string {
  const body = Buffer.from(JSON.stringify({ v: 1, ...payload })).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyInvite(secret: string, token: string, now = Date.now()): InvitePayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      v?: unknown;
      tenantId?: unknown;
      email?: unknown;
      exp?: unknown;
    };
    if (parsed.v !== 1) return null;
    if (typeof parsed.tenantId !== "string" || typeof parsed.email !== "string") return null;
    if (typeof parsed.exp !== "number" || parsed.exp <= now) return null;
    return { tenantId: parsed.tenantId, email: parsed.email, exp: parsed.exp };
  } catch {
    return null;
  }
}
