import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { ok } from "@gotonghr/contracts";
import {
  applyDatabaseUrls,
  loadRepoEnv,
  migrate,
  migrateEnvFrom,
  requiredEnv,
} from "@gotonghr/db";
import {
  grantMembership,
  migrateIdentity,
  requirePermission,
  SingleTenantOccupiedError,
  TENANT_HEADER,
} from "@gotonghr/identity";
import pg from "pg";
import { runBootstrap } from "./bootstrap.ts";
import { composeFromEnv, type ComposedApp } from "./composition.ts";
import { provisionQueue } from "./queue.ts";

const { Client } = pg;

const origin = "http://127.0.0.1:3000";
const ownerEmail = "api-owner@gotonghr.test";
const ownerPassword = "owner-password-1";
const employeeEmail = "api-employee@gotonghr.test";
const employeePassword = "employee-password-1";

loadRepoEnv();
applyDatabaseUrls(process.env);

describe("api identity", { concurrency: 1 }, () => {
  let composed: ComposedApp;
  let tenantId = "";
  let ownerCookie = "";
  const probe = { hits: 0 };

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.GOTONG_DEPLOYMENT_MODE = "single_tenant";
    process.env.BETTER_AUTH_URL = origin;
    process.env.GOTONG_BOOTSTRAP_EMAIL = ownerEmail;
    process.env.GOTONG_BOOTSTRAP_PASSWORD = ownerPassword;
    process.env.GOTONG_BOOTSTRAP_TENANT_NAME = "GotongHR";
    process.env.GOTONG_BOOTSTRAP_OWNER_NAME = "Owner";
    process.env.STORAGE_DRIVER ??= "local";
    process.env.STORAGE_LOCAL_SECRET = "local-test-storage-secret-0123456789";
    process.env.QUEUE_DRIVER ??= "pgboss";
    process.env.GOTONG_AUTH_RATE_LIMIT_MAX = "10";
    process.env.GOTONG_AUTH_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.GOTONG_TRUST_PROXY = "1";
    process.env.GOTONG_TRUST_CLOUDFLARE = "false";
    const migrateEnv = migrateEnvFrom(process.env);
    await migrate(migrateEnv);
    await migrateIdentity({
      superuserUrl: migrateEnv.superuserUrl,
      migratorUrl: migrateEnv.migratorUrl,
    });
    await provisionQueue(migrateEnv.migratorUrl);
    await resetIdentity();
    const created = await runBootstrap(process.env);
    assert.equal(created.created, true);
    tenantId = created.tenantId;
    composed = await composeFromEnv(process.env);
    composedRef = composed;
    await grantMembership(composed.auth, composed.appDb, {
      tenantId,
      email: employeeEmail,
      password: employeePassword,
      name: "Employee",
      role: "employee",
    });
    composed.app.get(
      "/api/v1/probe/pii",
      { preHandler: requirePermission("employee.pii.read") },
      async () => {
        probe.hits += 1;
        return ok({ seen: true });
      },
    );
    const signedIn = await signIn(ownerEmail, ownerPassword);
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    ownerCookie = cookieHeader(setCookies(signedIn));
  });

  after(async () => {
    await composed.close();
    await resetIdentity();
  });

  it("bootstraps one owner and blocks a second tenant", async () => {
    const again = await runBootstrap(process.env);
    assert.equal(again.created, false);
    assert.equal(again.tenantId, tenantId);
    process.env.GOTONG_BOOTSTRAP_EMAIL = "other@gotonghr.test";
    try {
      await assert.rejects(() => runBootstrap(process.env), (error: unknown) => {
        return error instanceof SingleTenantOccupiedError;
      });
    } finally {
      process.env.GOTONG_BOOTSTRAP_EMAIL = ownerEmail;
    }
    const count = await composed.appDb.pool.query<{ count: number }>(
      "SELECT id_tenant_count() AS count",
    );
    assert.equal(Number(count.rows[0]?.count), 1);
  });

  it("keeps platform routes unmounted and sets secure cookies", async () => {
    for (const url of [
      "/api/v1/platform/tenants",
      "/api/v1/platform/health/tenants",
      "/api/v1/platform/statutory-tables",
      "/api/v1/platform/support-grants/activate",
      "/api/v1/platform/audit-events",
    ]) {
      const platform = await composed.app.inject({ method: "GET", url });
      assert.equal(platform.statusCode, 404, url);
    }
    const activate = await composed.app.inject({
      method: "POST",
      url: "/api/v1/platform/support-grants/activate",
      headers: { "content-type": "application/json" },
      payload: { token: "not-a-token" },
    });
    assert.equal(activate.statusCode, 404);
    const signedIn = await signIn(ownerEmail, ownerPassword);
    const cookies = setCookies(signedIn).join("\n");
    assert.match(cookies, /HttpOnly/i);
    assert.match(cookies, /Secure/i);
    assert.match(cookies, /SameSite=Lax/i);
  });

  it("returns 403 for an employee and an enrollment challenge without TOTP", async () => {
    probe.hits = 0;
    const employeeSignIn = await signIn(employeeEmail, employeePassword);
    assert.equal(employeeSignIn.statusCode, 200, employeeSignIn.body);
    const denied = await getProbe(cookieHeader(setCookies(employeeSignIn)));
    assert.equal(denied.statusCode, 403);
    assert.equal(readError(denied.body), "forbidden");
    assert.equal(probe.hits, 0);

    const mismatch = await getProbe(ownerCookie, randomUUID());
    assert.equal(mismatch.statusCode, 403);
    assert.equal(readError(mismatch.body), "tenant_mismatch");
    assert.equal(probe.hits, 0);

    const blocked = await getProbe(ownerCookie);
    assert.equal(blocked.statusCode, 403);
    assert.equal(readError(blocked.body), "totp_enrollment_required");
    const blockedBody = JSON.parse(blocked.body) as { meta: { challenge?: string } | null };
    assert.equal(blockedBody.meta?.challenge, "totp_enrollment");
    assert.equal(probe.hits, 0);

    const enabled = await postAuth("/api/auth/two-factor/enable", { password: ownerPassword }, ownerCookie);
    assert.equal(enabled.statusCode, 200, enabled.body);
    const enrollment = JSON.parse(enabled.body) as { totpURI?: string; backupCodes?: string[] };
    assert.equal(typeof enrollment.totpURI, "string");
    const code = totpFromUri(enrollment.totpURI ?? "");
    const verified = await postAuth(
      "/api/auth/two-factor/verify-totp",
      { code },
      mergeCookies(ownerCookie, [...setCookies(enabled)]),
    );
    assert.equal(verified.statusCode, 200, verified.body);
    const nextCookie = mergeCookies(ownerCookie, [...setCookies(enabled), ...setCookies(verified)]);
    const allowed = await getProbe(nextCookie);
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(probe.hits, 1);

    const stale = await getProbe(ownerCookie);
    assert.notEqual(stale.statusCode, 200);
    assert.equal(probe.hits, 1);

    await superuserExec("UPDATE id_sessions SET totp_verified_at = NULL");
    const unverified = await getProbe(nextCookie);
    assert.equal(unverified.statusCode, 403);
    assert.equal(readError(unverified.body), "totp_verification_required");
    assert.equal(probe.hits, 1);
  });

  it("rate limits login and password reset", async () => {
    await composed.appDb.pool.query("DELETE FROM id_rate_limits");
    const loginCodes: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await postAuth("/api/auth/sign-in/email", {
        email: "nobody@gotonghr.test",
        password: "not-the-password",
      });
      loginCodes.push(response.statusCode);
      if (attempt === 10) assert.equal(readError(response.body), "rate_limited");
    }
    assert.equal(loginCodes[10], 429);
    assert.equal(loginCodes.slice(0, 10).every((status) => status !== 429), true);

    await composed.appDb.pool.query("DELETE FROM id_rate_limits");
    const resetCodes: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await postAuth("/api/auth/request-password-reset", {
        email: "nobody@gotonghr.test",
      });
      resetCodes.push(response.statusCode);
    }
    assert.equal(resetCodes[10], 429);
    assert.equal(resetCodes.slice(0, 10).every((status) => status !== 429), true);

    await composed.appDb.pool.query("DELETE FROM id_rate_limits");
    const totpCodes: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await postAuth("/api/auth/two-factor/verify-totp", { code: "000000" });
      totpCodes.push(response.statusCode);
    }
    assert.equal(totpCodes[10], 429);
    assert.equal(totpCodes.slice(0, 10).every((status) => status !== 429), true);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const health = await composed.app.inject({ method: "GET", url: "/healthz" });
      assert.equal(health.statusCode, 200);
    }
  });
});

function signIn(email: string, password: string) {
  return postAuth("/api/auth/sign-in/email", { email, password });
}

function postAuth(url: string, body: Record<string, unknown>, cookie?: string) {
  return composedRequest("POST", url, body, cookie);
}

function getProbe(cookie: string, tenantId?: string) {
  return composedRequest("GET", "/api/v1/probe/pii", undefined, cookie, tenantId);
}

function composedRequest(
  method: "GET" | "POST",
  url: string,
  body?: Record<string, unknown>,
  cookie?: string,
  tenantId?: string,
) {
  return currentApp().inject({
    method,
    url,
    headers: {
      origin,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(tenantId ? { [TENANT_HEADER]: tenantId } : {}),
    },
    ...(body ? { payload: body } : {}),
  });
}

let composedRef: ComposedApp | undefined;

function currentApp() {
  if (!composedRef) throw new Error("app is not ready");
  return composedRef.app;
}

function setCookies(response: { headers: { "set-cookie"?: string | string[] | undefined } }): string[] {
  const raw = response.headers["set-cookie"];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.map(String);
  return [];
}

function cookieHeader(cookies: string[]): string {
  return cookies
    .map((line) => line.split(";")[0]?.trim() ?? "")
    .filter((part) => part.includes("="))
    .join("; ");
}

function mergeCookies(existing: string, cookies: string[]): string {
  const jar = new Map<string, string>();
  for (const part of existing.split(";")) {
    const trimmed = part.trim();
    const name = trimmed.split("=")[0];
    if (name && trimmed.includes("=")) jar.set(name, trimmed);
  }
  for (const line of cookies) {
    const pair = line.split(";")[0]?.trim();
    const name = pair?.split("=")[0];
    if (name && pair?.includes("=")) jar.set(name, pair);
  }
  return [...jar.values()].join("; ");
}

function readError(body: string): string | undefined {
  const parsed = JSON.parse(body) as { error?: { code?: string } | null };
  return parsed.error?.code;
}

function totpFromUri(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("missing totp secret");
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buffer).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    ((hmac[offset + 1] ?? 0) << 16) |
    ((hmac[offset + 2] ?? 0) << 8) |
    (hmac[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(6, "0");
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = input.replace(/=+$/u, "").toUpperCase().replace(/ /gu, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

async function superuserExec(text: string): Promise<void> {
  const admin = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
  await admin.connect();
  try {
    await admin.query(text);
  } finally {
    await admin.end();
  }
}

async function resetIdentity(): Promise<void> {
  const admin = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
  await admin.connect();
  try {
    await admin.query(`
      TRUNCATE TABLE
        id_sessions,
        id_memberships,
        id_users,
        id_roles,
        id_tenants,
        id_rate_limits,
        ba_two_factor,
        ba_invitation,
        ba_member,
        ba_session,
        ba_account,
        ba_verification,
        ba_organization,
        ba_user
      CASCADE
    `);
  } finally {
    await admin.end();
  }
}
