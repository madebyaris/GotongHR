import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { ok } from "@gotonghr/contracts";
import {
  applyDatabaseUrls,
  createTenantDatabase,
  loadRepoEnv,
  migrate,
  migrateEnvFrom,
  requiredEnv,
  type TenantDatabase,
} from "@gotonghr/db";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import pg from "pg";
import { createAuth, type GotongAuth } from "./auth.ts";
import {
  bootstrapOwner,
  createTenantWithOwner,
  ensureCredentialUser,
  grantMembership,
  tenantSlug,
} from "./bootstrap.ts";
import { TENANT_HEADER, requirePermission } from "./guard.ts";
import { migrateIdentity } from "./migrate.ts";
import { registerIdentity } from "./plugin.ts";
import { SingleTenantOccupiedError } from "./errors.ts";
import { tenantCount } from "./directory.ts";
import { cookieHeader, readErrorCode, resetIdentity, setCookieLines, superuserQuery } from "./testing.ts";

const { Client } = pg;

const origin = "http://127.0.0.1:3000";
const ownerEmail = "owner@gotonghr.test";
const ownerPassword = "owner-password-1";
const employeeEmail = "employee@gotonghr.test";
const employeePassword = "employee-password-1";

loadRepoEnv();
applyDatabaseUrls(process.env);

describe("identity auth", { concurrency: 1 }, () => {
  let app: FastifyInstance;
  let auth: GotongAuth;
  let appDb: TenantDatabase;
  let tenantId = "";
  let authUserId = "";
  let ownerCookie = "";
  const probe = { hits: 0 };

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.GOTONG_DEPLOYMENT_MODE = "single_tenant";
    process.env.BETTER_AUTH_URL = origin;
    await migrate(migrateEnvFrom(process.env));
    await migrateIdentity({
      superuserUrl: requiredEnv(process.env, "DATABASE_URL_SUPERUSER"),
      migratorUrl: requiredEnv(process.env, "DATABASE_URL_MIGRATOR"),
    });
    await resetIdentity();
    appDb = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    const role = await appDb.pool.query<{ current_user: string }>("SELECT current_user");
    assert.equal(role.rows[0]?.current_user, "app_tenant");
    auth = createAuth({
      appDb,
      env: { ...process.env, NODE_ENV: "test", GOTONG_DEPLOYMENT_MODE: "single_tenant", BETTER_AUTH_URL: origin },
    });
    app = Fastify({ logger: false });
    await registerIdentity(app, { auth, appDb, rateLimitMax: 100 });
    app.get("/healthz", async () => ok({ status: "ok" }));
    app.get(
      "/api/v1/probe/pii",
      { preHandler: requirePermission("employee.pii.read") },
      async () => {
        probe.hits += 1;
        return ok({ seen: true });
      },
    );
    const created = await bootstrapOwner(
      auth,
      appDb,
      { email: ownerEmail, password: ownerPassword, name: "Owner", tenantName: "GotongHR" },
      "single_tenant",
    );
    assert.equal(created.created, true);
    tenantId = created.tenantId;
    authUserId = created.authUserId;
    await grantMembership(auth, appDb, {
      tenantId,
      email: employeeEmail,
      password: employeePassword,
      name: "Employee",
      role: "employee",
    });
    const signedIn = await signIn(app, ownerEmail, ownerPassword);
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    ownerCookie = cookieHeader(setCookieLines(signedIn));
    assert.ok(ownerCookie.includes("="));
  });

  after(async () => {
    await app.close();
    await appDb.end();
    await resetIdentity();
  });

  it("bootstraps one org_owner and refuses a second tenant", async () => {
    const again = await bootstrapOwner(
      auth,
      appDb,
      { email: ownerEmail, password: ownerPassword, name: "Owner", tenantName: "GotongHR" },
      "single_tenant",
    );
    assert.equal(again.created, false);
    assert.equal(again.tenantId, tenantId);
    await assert.rejects(
      () =>
        bootstrapOwner(
          auth,
          appDb,
          { email: "other@gotonghr.test", password: ownerPassword, name: "Other", tenantName: "Other" },
          "single_tenant",
        ),
      (error: unknown) => error instanceof SingleTenantOccupiedError,
    );
    await assert.rejects(
      () =>
        bootstrapOwner(
          auth,
          appDb,
          { email: ownerEmail, password: ownerPassword, name: "Owner", tenantName: "GotongHR" },
          "multi_tenant_saas",
        ),
      /single_tenant/,
    );
    await assert.rejects(() =>
      auth.api.createOrganization({
        body: { name: "Second", slug: "second", userId: authUserId },
      }),
    );
    const httpCreate = await postAuth(app, "/api/auth/organization/create", {
      name: "Second",
      slug: "second-http",
    }, ownerCookie);
    assert.notEqual(httpCreate.statusCode, 200);
    assert.equal(await tenantCount(appDb.pool), 1);
    const flags = await appDb.withTenantContext(tenantId, async (tx) => {
      const result = await tx.execute<{
        code: string;
        direct_reports_only: boolean;
        self_only: boolean;
        roles: number;
      }>(sql`
        SELECT r.code, m.direct_reports_only, m.self_only,
          (SELECT count(*)::int FROM id_roles) AS roles
        FROM id_memberships m
        JOIN id_roles r ON r.id = m.role_id
      `);
      return result.rows;
    });
    assert.equal(flags.length, 2);
    const owner = flags.find((row) => row.code === "org_owner");
    const employee = flags.find((row) => row.code === "employee");
    assert.equal(owner?.direct_reports_only, false);
    assert.equal(owner?.self_only, false);
    assert.equal(employee?.self_only, true);
    assert.equal(Number(owner?.roles), 8);
    const sessions = await appDb.withTenantContext(tenantId, async (tx) => {
      const result = await tx.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM id_sessions`,
      );
      return result.rows[0];
    });
    assert.ok(Number(sessions?.count) >= 1);
  });

  it("sets HttpOnly Secure SameSite=Lax cookies", async () => {
    const signedIn = await signIn(app, ownerEmail, ownerPassword);
    const cookies = setCookieLines(signedIn).join("\n");
    assert.match(cookies, /HttpOnly/i);
    assert.match(cookies, /Secure/i);
    assert.match(cookies, /SameSite=Lax/i);
  });

  it("returns 403 for employee on employee.pii.read and does not run the handler", async () => {
    probe.hits = 0;
    const signedIn = await signIn(app, employeeEmail, employeePassword);
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    const response = await getProbe(app, cookieHeader(setCookieLines(signedIn)));
    assert.equal(response.statusCode, 403);
    assert.equal(readErrorCode(response), "forbidden");
    assert.equal(probe.hits, 0);
  });

  it("rejects a tenant header that is not a membership", async () => {
    probe.hits = 0;
    const response = await getProbe(app, ownerCookie, randomUUID());
    assert.equal(response.statusCode, 403);
    assert.equal(readErrorCode(response), "tenant_mismatch");
    assert.equal(probe.hits, 0);
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/probe/pii" });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(readErrorCode(anonymous), "unauthenticated");
  });

  it("challenges a privileged user without TOTP and then runs the handler", async () => {
    probe.hits = 0;
    const blocked = await getProbe(app, ownerCookie);
    assert.equal(blocked.statusCode, 403);
    assert.equal(readErrorCode(blocked), "totp_enrollment_required");
    const blockedBody = readBody(blocked);
    assert.equal(blockedBody.meta?.challenge, "totp_enrollment");
    assert.equal(probe.hits, 0);

    const enabled = await postAuth(
      app,
      "/api/auth/two-factor/enable",
      { password: ownerPassword },
      ownerCookie,
    );
    assert.equal(enabled.statusCode, 200, enabled.body);
    const enrollment = readEnable(enabled.body);
    assert.ok(enrollment.backupCodes[0]);
    const stored = await superuserQuery<{ backup_codes: string; two_factor_enabled: boolean | null }>(
      `SELECT tf.backup_codes, u.two_factor_enabled
       FROM ba_two_factor tf
       JOIN ba_user u ON u.id = tf.user_id
       WHERE u.email = $1`,
      [ownerEmail],
    );
    const row = stored[0];
    assert.ok(row);
    assert.equal(row.two_factor_enabled, false);
    assert.equal(row.backup_codes.includes(enrollment.backupCodes[0] ?? ""), false);

    const verified = await postAuth(
      app,
      "/api/auth/two-factor/verify-totp",
      { code: totpFromUri(enrollment.totpURI) },
      mergeCookies(ownerCookie, setCookieLines(enabled)),
    );
    assert.equal(verified.statusCode, 200, verified.body);
    const nextCookie = mergeCookies(ownerCookie, [
      ...setCookieLines(enabled),
      ...setCookieLines(verified),
    ]);
    const allowed = await getProbe(app, nextCookie);
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(probe.hits, 1);

    const stale = await getProbe(app, ownerCookie);
    assert.notEqual(stale.statusCode, 200);
    assert.equal(probe.hits, 1);

    await superuserQuery("UPDATE id_sessions SET totp_verified_at = NULL WHERE auth_user_id = $1", [
      authUserId,
    ]);
    const wrongCode = await postAuth(
      app,
      "/api/auth/two-factor/verify-totp",
      { code: "000000" },
      nextCookie,
    );
    assert.notEqual(wrongCode.statusCode, 200);
    const unverified = await getProbe(app, nextCookie);
    assert.equal(unverified.statusCode, 403);
    assert.equal(readErrorCode(unverified), "totp_verification_required");
    assert.equal(probe.hits, 1);
    const afterVerify = await superuserQuery<{ two_factor_enabled: boolean | null }>(
      "SELECT two_factor_enabled FROM ba_user WHERE email = $1",
      [ownerEmail],
    );
    assert.equal(afterVerify[0]?.two_factor_enabled, true);
  });

  it("rate limits login and password reset and leaves healthz alone", async () => {
    await appDb.pool.query("DELETE FROM id_rate_limits");
    const limited = Fastify({ logger: false });
    await registerIdentity(limited, { auth, appDb, rateLimitMax: 3, rateLimitWindowMs: 60_000 });
    limited.get("/healthz", async () => ok({ status: "ok" }));
    try {
      const loginResponses = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        loginResponses.push(
          await postAuth(limited, "/api/auth/sign-in/email", {
            email: "nobody@gotonghr.test",
            password: "not-the-password",
          }),
        );
      }
      assert.deepEqual(
        loginResponses.slice(0, 3).map((response) => response.statusCode === 429),
        [false, false, false],
      );
      const blockedLogin = loginResponses[3];
      assert.ok(blockedLogin);
      assert.equal(blockedLogin.statusCode, 429);
      assert.equal(readErrorCode(blockedLogin), "rate_limited");

      await appDb.pool.query("DELETE FROM id_rate_limits");
      const resetStatuses: number[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await postAuth(limited, "/api/auth/request-password-reset", {
          email: "nobody@gotonghr.test",
        });
        resetStatuses.push(response.statusCode);
      }
      assert.equal(resetStatuses[3], 429);
      assert.equal(resetStatuses.slice(0, 3).every((status) => status !== 429), true);

      await appDb.pool.query("DELETE FROM id_rate_limits");
      const totpStatuses: number[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await postAuth(limited, "/api/auth/two-factor/verify-totp", {
          code: "000000",
        });
        totpStatuses.push(response.statusCode);
      }
      assert.equal(totpStatuses[3], 429);
      assert.equal(totpStatuses.slice(0, 3).every((status) => status !== 429), true);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const health = await limited.inject({ method: "GET", url: "/healthz" });
        assert.equal(health.statusCode, 200);
      }
    } finally {
      await limited.close();
    }
  });

  it("does not mount platform routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/platform/tenants" });
    assert.equal(response.statusCode, 404);
    assert.equal(tenantSlug("GotongHR"), "gotonghr");
    assert.match(tenantSlug("東京"), /^tenant-[0-9a-f]{8}$/u);
    const longA = tenantSlug(`${"a".repeat(80)}x`);
    const longB = tenantSlug(`${"a".repeat(80)}y`);
    assert.equal(longA.length, 64);
    assert.notEqual(longA, longB);
    await assert.rejects(
      () =>
        ensureCredentialUser(auth, {
          email: employeeEmail,
          password: "not-the-employee",
          name: "Employee",
        }),
      /Password does not match/,
    );
  });

  it("keeps tenant rows behind FORCE RLS and the resolver functions", async () => {
    await resetIdentity();
    const multi = createAuth({
      appDb,
      env: {
        ...process.env,
        NODE_ENV: "test",
        GOTONG_DEPLOYMENT_MODE: "multi_tenant_saas",
        BETTER_AUTH_URL: origin,
      },
    });
    const tenantA = await createTenantWithOwner(multi, appDb, {
      email: "a-owner@gotonghr.test",
      password: ownerPassword,
      name: "A Owner",
      tenantName: "Tenant A",
    });
    const tenantB = await createTenantWithOwner(multi, appDb, {
      email: "b-owner@gotonghr.test",
      password: ownerPassword,
      name: "B Owner",
      tenantName: "Tenant B",
    });
    const hidden = await appDb.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM id_memberships",
    );
    assert.equal(hidden.rows[0]?.count, 0);
    assert.equal(await tenantCount(appDb.pool), 2);
    const visible = await appDb.withTenantContext(tenantA.tenantId, async (tx) => {
      const result = await tx.execute<{ email: string }>(
        sql`SELECT email FROM id_users ORDER BY email`,
      );
      return result.rows.map((row) => row.email);
    });
    assert.deepEqual(visible, ["a-owner@gotonghr.test"]);
    await assert.rejects(
      () =>
        appDb.withTenantContext(tenantA.tenantId, async (tx) => {
          await tx.execute(sql`
            INSERT INTO id_users (tenant_id, auth_user_id, email, display_name)
            VALUES (${tenantB.tenantId}::uuid, 'cross', 'cross@gotonghr.test', 'Cross')
          `);
        }),
      isPermissionDenied,
    );
    const platform = new Client({
      connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM"),
    });
    await platform.connect();
    try {
      await assert.rejects(() => platform.query("SELECT id FROM id_memberships"), isPermissionDenied);
    } finally {
      await platform.end();
    }
    const flags = await superuserQuery<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname = ANY($1::text[])`,
      [["id_tenants", "id_memberships", "ba_user", "id_rate_limits"]],
    );
    const byName = new Map(flags.map((row) => [row.relname, row]));
    assert.equal(byName.get("id_tenants")?.relforcerowsecurity, true);
    assert.equal(byName.get("id_memberships")?.relforcerowsecurity, true);
    assert.equal(byName.get("ba_user")?.relrowsecurity, false);
    assert.equal(byName.get("id_rate_limits")?.relrowsecurity, false);
    const privileges = await superuserQuery<{
      platform_select: boolean;
      queue_select: boolean;
      platform_insert: boolean;
    }>(
      `SELECT
         has_table_privilege('platform_admin', 'ba_user', 'SELECT') AS platform_select,
         has_table_privilege('gotong_queue', 'ba_user', 'SELECT') AS queue_select,
         has_table_privilege('platform_admin', 'ba_session', 'INSERT') AS platform_insert`,
      [],
    );
    assert.equal(privileges[0]?.platform_select, false);
    assert.equal(privileges[0]?.queue_select, false);
    assert.equal(privileges[0]?.platform_insert, false);

    await grantMembership(multi, appDb, {
      tenantId: tenantB.tenantId,
      email: "a-owner@gotonghr.test",
      password: ownerPassword,
      name: "A Owner",
      role: "hr_admin",
    });
    const signedIn = await signIn(app, "a-owner@gotonghr.test", ownerPassword);
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    probe.hits = 0;
    const switched = await getProbe(app, cookieHeader(setCookieLines(signedIn)), tenantB.tenantId);
    assert.equal(switched.statusCode, 403);
    assert.equal(readErrorCode(switched), "tenant_mismatch");
    assert.equal(probe.hits, 0);
  });

  it("serializes overlapping single-tenant bootstraps", async () => {
    await resetIdentity();
    const attempts = await Promise.allSettled([
      bootstrapOwner(
        auth,
        appDb,
        { email: "race-a@gotonghr.test", password: ownerPassword, name: "A", tenantName: "Race A" },
        "single_tenant",
      ),
      bootstrapOwner(
        auth,
        appDb,
        { email: "race-b@gotonghr.test", password: ownerPassword, name: "B", tenantName: "Race B" },
        "single_tenant",
      ),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const failure = rejected[0];
    assert.ok(failure);
    assert.equal(failure.status, "rejected");
    assert.ok(failure.reason instanceof SingleTenantOccupiedError);
    assert.equal(await tenantCount(appDb.pool), 1);
  });

  it("redacts internal errors from auth routes", async () => {
    const local = Fastify({ logger: false });
    await registerIdentity(local, {
      auth,
      appDb,
      env: { ...process.env, NODE_ENV: "test" },
    });
    const response = await local.inject({ method: "GET", url: "/api/auth/__test/fail" });
    assert.equal(response.statusCode, 500);
    const body = response.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "internal_error");
    assert.equal(body.error.message, "Request failed.");
    assert.equal(response.body.includes("database password"), false);
    assert.equal(response.body.includes("secret"), false);
    await local.close();
  });

  it("keeps a separate rate-limit bucket per Cloudflare client", async () => {
    const limited = Fastify({ logger: false });
    await registerIdentity(limited, {
      auth,
      appDb,
      env: {
        ...process.env,
        NODE_ENV: "test",
        GOTONG_TRUST_CLOUDFLARE: "true",
        GOTONG_TRUST_PROXY: "1",
      },
      rateLimitMax: 2,
      rateLimitWindowMs: 60_000,
    });
    const post = (ip: string) =>
      limited.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        remoteAddress: "127.0.0.1",
        headers: {
          origin,
          "content-type": "application/json",
          "cf-connecting-ip": ip,
        },
        payload: { email: "nobody-cf@gotonghr.test", password: "not-a-real-password" },
      });
    const first = await post("203.0.113.10");
    const second = await post("203.0.113.10");
    const third = await post("203.0.113.10");
    const other = await post("203.0.113.11");
    assert.notEqual(first.statusCode, 429);
    assert.notEqual(second.statusCode, 429);
    assert.equal(third.statusCode, 429);
    assert.notEqual(other.statusCode, 429);
    await limited.close();
  });
});

async function signIn(app: FastifyInstance, email: string, password: string) {
  return postAuth(app, "/api/auth/sign-in/email", { email, password });
}

function postAuth(
  app: FastifyInstance,
  url: string,
  body: Record<string, unknown>,
  cookie?: string,
) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      origin,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    payload: body,
  });
}

function getProbe(app: FastifyInstance, cookie: string, tenantId?: string) {
  return app.inject({
    method: "GET",
    url: "/api/v1/probe/pii",
    headers: {
      cookie,
      ...(tenantId ? { [TENANT_HEADER]: tenantId } : {}),
    },
  });
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

function readBody(response: LightMyRequestResponse): {
  error: { code: string } | null;
  meta: { challenge?: string } | null;
} {
  return JSON.parse(response.body) as {
    error: { code: string } | null;
    meta: { challenge?: string } | null;
  };
}

function readEnable(body: string): { totpURI: string; backupCodes: string[] } {
  const parsed = JSON.parse(body) as { totpURI?: unknown; backupCodes?: unknown };
  if (typeof parsed.totpURI !== "string" || !Array.isArray(parsed.backupCodes)) {
    throw new Error(`unexpected enable response: ${body}`);
  }
  return {
    totpURI: parsed.totpURI,
    backupCodes: parsed.backupCodes.filter((code): code is string => typeof code === "string"),
  };
}

function totpFromUri(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("missing totp secret");
  const key = base32Decode(secret);
  const now = Date.now();
  return totpCode(key, now);
}

function totpCode(secret: Buffer, at: number): string {
  const counter = Math.floor(at / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(buffer).digest();
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

function isPermissionDenied(error: unknown): boolean {
  const current = error as { code?: string; cause?: { code?: string } };
  return current.code === "42501" || current.cause?.code === "42501";
}
