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
  ensureCredentialUser,
  grantMembership,
  migrateIdentity,
  readAuthSecret,
  requireSession,
} from "@gotonghr/identity";
import {
  hashToken,
  migratePlatform,
  openPlatformDatabase,
  registerPlatformOperator,
  verifyInvite,
  withSupportSession,
  type PlatformDatabase,
} from "@gotonghr/platform";
import pg from "pg";
import { composeFromEnv, type ComposedApp } from "./composition.ts";
import { provisionQueue } from "./queue.ts";

const { Client } = pg;

const origin = "http://127.0.0.1:3000";
const operatorEmail = "platform-ops@gotonghr.test";
const operatorPassword = "platform-password-1";
const otherEmail = "platform-ops-b@gotonghr.test";
const otherPassword = "platform-password-2";
const ownerPassword = "owner-password-1";
const employeePassword = "employee-password-1";
const securityPassword = "security-password-1";

loadRepoEnv();
applyDatabaseUrls(process.env);

describe("platform admin", { concurrency: 1 }, () => {
  let composed: ComposedApp;
  let platform: PlatformDatabase;
  let operatorId = "";
  let otherOperatorId = "";
  let operatorCookie = "";
  const previousMode = process.env.GOTONG_DEPLOYMENT_MODE;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.GOTONG_DEPLOYMENT_MODE = "multi_tenant_saas";
    process.env.BETTER_AUTH_URL = origin;
    process.env.STORAGE_DRIVER ??= "local";
    process.env.STORAGE_LOCAL_SECRET = "local-test-storage-secret-0123456789";
    process.env.QUEUE_DRIVER ??= "pgboss";
    process.env.GOTONG_AUTH_RATE_LIMIT_MAX = "100";
    process.env.GOTONG_TRUST_PROXY = "1";
    process.env.GOTONG_TRUST_CLOUDFLARE = "false";
    const migrateEnv = migrateEnvFrom(process.env);
    await migrate(migrateEnv);
    await migrateIdentity({
      superuserUrl: migrateEnv.superuserUrl,
      migratorUrl: migrateEnv.migratorUrl,
    });
    await migratePlatform({
      superuserUrl: migrateEnv.superuserUrl,
      migratorUrl: migrateEnv.migratorUrl,
    });
    await provisionQueue(migrateEnv.migratorUrl);
    await resetRows();
    composed = await composeFromEnv(process.env);
    composedRef = composed;
    platform = await openPlatformDatabase(requiredEnv(process.env, "DATABASE_URL_PLATFORM"));
    composed.app.get("/api/v1/probe/session", { preHandler: requireSession() }, async () =>
      ok({ ok: true }),
    );
    await composed.appDb.pool.query("DELETE FROM id_rate_limits");
    const operator = await ensureCredentialUser(composed.auth, {
      email: operatorEmail,
      password: operatorPassword,
      name: "Platform",
    });
    operatorId = (await registerPlatformOperator(platform, {
      authUserId: operator.id,
      role: "platform_super_admin",
    })).id;
    const other = await ensureCredentialUser(composed.auth, {
      email: otherEmail,
      password: otherPassword,
      name: "Other",
    });
    otherOperatorId = (await registerPlatformOperator(platform, {
      authUserId: other.id,
      role: "platform_ops",
    })).id;
    const signedIn = await signIn(operatorEmail, operatorPassword);
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    operatorCookie = cookieHeader(setCookies(signedIn));
  });

  after(async () => {
    if (previousMode === undefined) delete process.env.GOTONG_DEPLOYMENT_MODE;
    else process.env.GOTONG_DEPLOYMENT_MODE = previousMode;
    await composed?.close();
    await platform?.end();
    await resetRows();
  });

  it("denies platform_admin select on id_memberships and update on the audit log", async () => {
    const client = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM") });
    await client.connect();
    try {
      const role = await client.query<{ current_user: string; rolbypassrls: boolean }>(
        `SELECT current_user, rolbypassrls
         FROM pg_roles
         WHERE rolname = current_user`,
      );
      assert.equal(role.rows[0]?.current_user, "platform_admin");
      assert.equal(role.rows[0]?.rolbypassrls, false);
      await assert.rejects(client.query("SELECT id FROM id_memberships"), isPermissionDenied);
      await assert.rejects(
        client.query("UPDATE sys_platform_audit_events SET action = action"),
        isPermissionDenied,
      );
      await assert.rejects(
        client.query("UPDATE sys_tenant_quotas SET status = 'suspended'"),
        isPermissionDenied,
      );
      await client.query("UPDATE sys_tenant_quotas SET max_seats = max_seats");
    } finally {
      await client.end();
    }

    const app = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_APP") });
    await app.connect();
    try {
      await assert.rejects(app.query("SELECT id FROM sys_platform_operators"), isPermissionDenied);
      const known = await app.query<{ ok: boolean }>(
        "SELECT sys_platform_operator_exists($1::uuid) AS ok",
        [operatorId],
      );
      assert.equal(known.rows[0]?.ok, true);
      const other = await app.query<{ ok: boolean }>(
        "SELECT sys_platform_operator_exists($1::uuid) AS ok",
        [otherOperatorId],
      );
      assert.equal(other.rows[0]?.ok, true);
      const missing = await app.query<{ ok: boolean }>(
        "SELECT sys_platform_operator_exists($1::uuid) AS ok",
        ["00000000-0000-0000-0000-000000000000"],
      );
      assert.equal(missing.rows[0]?.ok, false);
    } finally {
      await app.end();
    }
  });

  it("creates, suspends, and opens a single-use support grant", async () => {
    const anonymous = await composed.app.inject({ method: "GET", url: "/api/v1/platform/tenants" });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(readError(anonymous.body), "unauthenticated");

    const suffix = randomUUID().slice(0, 8);
    const ownerEmail = `owner-${suffix}@gotonghr.test`;
    const opsSignIn = await signIn(otherEmail, otherPassword);
    assert.equal(opsSignIn.statusCode, 200, opsSignIn.body);
    const opsCookie = cookieHeader(setCookies(opsSignIn));
    const tenantBody = {
      name: "Acme HQ",
      slug: `acme-${suffix}`,
      ownerEmail,
      ownerName: "Owner",
      ownerPassword,
    };
    const opsCreate = await post("/api/v1/platform/tenants", tenantBody, opsCookie);
    assert.equal(opsCreate.statusCode, 403, opsCreate.body);
    assert.equal(readError(opsCreate.body), "forbidden");
    const created = await post(
      "/api/v1/platform/tenants",
      tenantBody,
      operatorCookie,
    );
    assert.equal(created.statusCode, 201, created.body);
    const tenant = readData<{
      id: string;
      slug: string;
      planCode: string;
      inviteToken: string;
    }>(created.body);
    assert.equal(tenant.planCode, "starter");
    assert.equal(created.body.includes(ownerPassword), false);
    const inviteHash = await superuserQuery<{ owner_invite_token_hash: string }>(
      "SELECT owner_invite_token_hash FROM sys_tenant_quotas WHERE tenant_id = $1",
      [tenant.id],
    );
    assert.equal(inviteHash[0]?.owner_invite_token_hash, hashToken(tenant.inviteToken));
    assert.equal(inviteHash[0]?.owner_invite_token_hash.includes(tenant.inviteToken), false);
    const invite = verifyInvite(readAuthSecret(process.env), tenant.inviteToken);
    assert.equal(invite?.email, ownerEmail);
    assert.equal(invite?.tenantId, tenant.id);
    await assert.rejects(
      superuserQuery(
        `INSERT INTO sys_support_grants (
           tenant_id, granted_by_user_id, grantee_platform_user_id, token_hash, reason, expires_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'too long', now() + interval '5 hours')`,
        [tenant.id, tenant.id, operatorId, `too-long-${suffix}`],
      ),
      isCheckViolation,
    );

    const opsSuspend = await patch(
      `/api/v1/platform/tenants/${tenant.id}/status`,
      { status: "suspended" },
      opsCookie,
    );
    assert.equal(opsSuspend.statusCode, 403, opsSuspend.body);
    assert.equal(readError(opsSuspend.body), "forbidden");
    const opsConfig = await patch(
      `/api/v1/platform/tenants/${tenant.id}/config`,
      { maxSeats: 10 },
      opsCookie,
    );
    assert.equal(opsConfig.statusCode, 403, opsConfig.body);

    const ownerSignIn = await signIn(ownerEmail, ownerPassword);
    assert.equal(ownerSignIn.statusCode, 200, ownerSignIn.body);
    let ownerCookie = cookieHeader(setCookies(ownerSignIn));

    const configured = await patch(
      `/api/v1/platform/tenants/${tenant.id}/config`,
      { maxSeats: 40, featureFlags: { aiAssistant: true } },
      operatorCookie,
    );
    assert.equal(configured.statusCode, 200, configured.body);
    const config = readData<{ maxSeats: number; featureFlags: { aiAssistant: boolean; coretaxXml: boolean } }>(
      configured.body,
    );
    assert.equal(config.maxSeats, 40);
    assert.equal(config.featureFlags.aiAssistant, true);
    assert.equal(config.featureFlags.coretaxXml, true);

    const sessionsBefore = await sessionCount(ownerEmail);
    const suspended = await patch(
      `/api/v1/platform/tenants/${tenant.id}/status`,
      { status: "suspended" },
      operatorCookie,
    );
    assert.equal(suspended.statusCode, 200, suspended.body);
    const blockedSignIn = await signIn(ownerEmail, ownerPassword);
    assert.equal(blockedSignIn.statusCode, 403, blockedSignIn.body);
    assert.match(blockedSignIn.body, /tenant_suspended/);
    assert.equal(await sessionCount(ownerEmail), sessionsBefore);
    const blockedProbe = await get("/api/v1/probe/session", ownerCookie);
    assert.equal(blockedProbe.statusCode, 403, blockedProbe.body);
    assert.equal(readError(blockedProbe.body), "tenant_suspended");
    const listedResponse = await get("/api/v1/platform/tenants", operatorCookie);
    const listed = readData<Array<{ id: string; status: string }>>(listedResponse.body);
    const listedMeta = JSON.parse(listedResponse.body) as { meta?: { hasMore?: boolean } };
    assert.equal(listedMeta.meta?.hasMore, false);
    assert.equal(listed.find((row) => row.id === tenant.id)?.status, "suspended");

    const restored = await patch(
      `/api/v1/platform/tenants/${tenant.id}/status`,
      { status: "active" },
      operatorCookie,
    );
    assert.equal(restored.statusCode, 200, restored.body);
    const ownerAgain = await signIn(ownerEmail, ownerPassword);
    assert.equal(ownerAgain.statusCode, 200, ownerAgain.body);
    ownerCookie = cookieHeader(setCookies(ownerAgain));
    const openProbe = await get("/api/v1/probe/session", ownerCookie);
    assert.equal(openProbe.statusCode, 200, openProbe.body);
    const ownerNeedsTotp = await post(
      "/api/v1/tenant/support-grants",
      grantBody(operatorId),
      ownerCookie,
    );
    assert.equal(ownerNeedsTotp.statusCode, 403, ownerNeedsTotp.body);
    assert.equal(readError(ownerNeedsTotp.body), "totp_enrollment_required");
    ownerCookie = await confirmTotp(ownerPassword, ownerCookie);

    await grantMembership(composed.auth, composed.appDb, {
      tenantId: tenant.id,
      email: `employee-${suffix}@gotonghr.test`,
      password: employeePassword,
      name: "Employee",
      role: "employee",
    });
    const employeeSignIn = await signIn(`employee-${suffix}@gotonghr.test`, employeePassword);
    assert.equal(employeeSignIn.statusCode, 200, employeeSignIn.body);
    const employeeDenied = await post(
      "/api/v1/tenant/support-grants",
      grantBody(operatorId),
      cookieHeader(setCookies(employeeSignIn)),
    );
    assert.equal(employeeDenied.statusCode, 403, employeeDenied.body);
    assert.equal(readError(employeeDenied.body), "forbidden");

    await grantMembership(composed.auth, composed.appDb, {
      tenantId: tenant.id,
      email: `security-${suffix}@gotonghr.test`,
      password: securityPassword,
      name: "Security",
      role: "it_security_admin",
    });
    const securitySignIn = await signIn(`security-${suffix}@gotonghr.test`, securityPassword);
    assert.equal(securitySignIn.statusCode, 200, securitySignIn.body);
    let securityCookie = cookieHeader(setCookies(securitySignIn));
    const securityNeedsTotp = await post(
      "/api/v1/tenant/support-grants",
      grantBody(operatorId),
      securityCookie,
    );
    assert.equal(securityNeedsTotp.statusCode, 403, securityNeedsTotp.body);
    assert.equal(readError(securityNeedsTotp.body), "totp_enrollment_required");
    securityCookie = await confirmTotp(securityPassword, securityCookie);
    const securityGrant = await post(
      "/api/v1/tenant/support-grants",
      grantBody(operatorId),
      securityCookie,
    );
    assert.equal(securityGrant.statusCode, 201, securityGrant.body);

    const granted = await post("/api/v1/tenant/support-grants", grantBody(operatorId), ownerCookie);
    assert.equal(granted.statusCode, 201, granted.body);
    const grant = readData<{ id: string; token: string; scope: string; allowPiiReveal: boolean }>(
      granted.body,
    );
    assert.equal(grant.scope, "read_only");
    assert.equal(grant.allowPiiReveal, false);
    const stored = await superuserQuery<{
      token_hash: string;
      scope: string;
      allow_pii_reveal: boolean;
      consumed_at: Date | null;
    }>(
      `SELECT token_hash, scope, allow_pii_reveal, consumed_at
       FROM sys_support_grants WHERE id = $1`,
      [grant.id],
    );
    assert.equal(stored[0]?.scope, "read_only");
    assert.equal(stored[0]?.allow_pii_reveal, false);
    assert.equal(stored[0]?.token_hash, hashToken(grant.token));
    assert.equal(stored[0]?.token_hash.includes(grant.token), false);
    assert.equal(stored[0]?.consumed_at, null);

    const otherSignIn = await signIn(otherEmail, otherPassword);
    assert.equal(otherSignIn.statusCode, 200, otherSignIn.body);
    const otherCookie = cookieHeader(setCookies(otherSignIn));
    const forbidden = await post(
      "/api/v1/platform/support-grants/activate",
      { token: grant.token },
      otherCookie,
    );
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    assert.equal(readError(forbidden.body), "grant_forbidden");
    const stillOpen = await superuserQuery<{ consumed_at: Date | null }>(
      "SELECT consumed_at FROM sys_support_grants WHERE id = $1",
      [grant.id],
    );
    assert.equal(stillOpen[0]?.consumed_at, null);

    const activated = await post(
      "/api/v1/platform/support-grants/activate",
      { token: grant.token },
      operatorCookie,
    );
    assert.equal(activated.statusCode, 200, activated.body);
    const session = readData<{ tenantId: string; contextTenantId: string; sessionToken: string }>(
      activated.body,
    );
    assert.equal(session.tenantId, tenant.id);
    assert.equal(session.contextTenantId, tenant.id);
    assert.equal(activated.body.includes(grant.token), false);

    const opened = await post(
      "/api/v1/platform/support-grants/session",
      { sessionToken: session.sessionToken },
      operatorCookie,
    );
    assert.equal(opened.statusCode, 200, opened.body);
    assert.equal(readData<{ contextTenantId: string }>(opened.body).contextTenantId, tenant.id);
    const otherSession = await post(
      "/api/v1/platform/support-grants/session",
      { sessionToken: session.sessionToken },
      otherCookie,
    );
    assert.equal(otherSession.statusCode, 403, otherSession.body);
    assert.equal(readError(otherSession.body), "grant_forbidden");

    const hiddenTenant = randomUUID();
    await superuserQuery("INSERT INTO rls_probe (tenant_id) VALUES ($1), ($2)", [
      tenant.id,
      hiddenTenant,
    ]);
    try {
      await assert.rejects(
        withSupportSession(
          platform,
          composed.appDb,
          { sessionToken: session.sessionToken, actorId: operatorId, ip: null },
          async ({ tx, scope, allowPiiReveal }) => {
            assert.equal(scope, "read_only");
            assert.equal(allowPiiReveal, false);
            await tx.execute(
              `INSERT INTO rls_probe (tenant_id) VALUES ('${sqlUuid(tenant.id)}'::uuid)`,
            );
          },
        ),
        isReadOnly,
      );
      const visible = await withSupportSession(
        platform,
        composed.appDb,
        { sessionToken: session.sessionToken, actorId: operatorId, ip: null },
        async ({ tx, scope, allowPiiReveal }) => {
          assert.equal(scope, "read_only");
          assert.equal(allowPiiReveal, false);
          const rows = await tx.execute<{ tenant_id: string }>("SELECT tenant_id FROM rls_probe");
          return rows.rows.map((row) => row.tenant_id);
        },
      );
      assert.equal(visible.contextTenantId, tenant.id);
      assert.deepEqual(visible.result, [tenant.id]);

      const writableGrant = await post(
        "/api/v1/tenant/support-grants",
        { ...grantBody(operatorId), scope: "read_write" },
        ownerCookie,
      );
      assert.equal(writableGrant.statusCode, 201, writableGrant.body);
      const writable = readData<{ token: string }>(writableGrant.body);
      const writableActivated = await post(
        "/api/v1/platform/support-grants/activate",
        { token: writable.token },
        operatorCookie,
      );
      assert.equal(writableActivated.statusCode, 200, writableActivated.body);
      const writableSession = readData<{ sessionToken: string }>(writableActivated.body);
      const wrote = await withSupportSession(
        platform,
        composed.appDb,
        { sessionToken: writableSession.sessionToken, actorId: operatorId, ip: null },
        async ({ tx, scope }) => {
          assert.equal(scope, "read_write");
          await tx.execute(`INSERT INTO rls_probe (tenant_id) VALUES ('${sqlUuid(tenant.id)}'::uuid)`);
          const rows = await tx.execute<{ tenant_id: string }>("SELECT tenant_id FROM rls_probe");
          return rows.rows.length;
        },
      );
      assert.ok(wrote.result >= 1);
    } finally {
      await superuserQuery("DELETE FROM rls_probe WHERE tenant_id = ANY($1::uuid[])", [
        [tenant.id, hiddenTenant],
      ]);
    }

    const second = await post(
      "/api/v1/platform/support-grants/activate",
      { token: grant.token },
      operatorCookie,
    );
    assert.equal(second.statusCode, 403, second.body);
    assert.equal(readError(second.body), "grant_consumed");

    const expiredGrant = await post(
      "/api/v1/tenant/support-grants",
      grantBody(operatorId),
      ownerCookie,
    );
    assert.equal(expiredGrant.statusCode, 201, expiredGrant.body);
    const expired = readData<{ id: string; token: string }>(expiredGrant.body);
    await superuserQuery(
      `UPDATE sys_support_grants
       SET created_at = now() - interval '2 minutes',
           expires_at = now() - interval '1 minute'
       WHERE id = $1`,
      [expired.id],
    );
    const expiredUse = await post(
      "/api/v1/platform/support-grants/activate",
      { token: expired.token },
      operatorCookie,
    );
    assert.equal(expiredUse.statusCode, 403, expiredUse.body);
    assert.equal(readError(expiredUse.body), "grant_expired");
    const expiredRow = await superuserQuery<{ consumed_at: Date | null }>(
      "SELECT consumed_at FROM sys_support_grants WHERE id = $1",
      [expired.id],
    );
    assert.equal(expiredRow[0]?.consumed_at, null);

    const revokeGrant = await post("/api/v1/tenant/support-grants", grantBody(operatorId), ownerCookie);
    assert.equal(revokeGrant.statusCode, 201, revokeGrant.body);
    const revocable = readData<{ id: string; token: string }>(revokeGrant.body);
    const revoked = await post(
      `/api/v1/tenant/support-grants/${revocable.id}/revoke`,
      {},
      ownerCookie,
    );
    assert.equal(revoked.statusCode, 200, revoked.body);
    const revokedUse = await post(
      "/api/v1/platform/support-grants/activate",
      { token: revocable.token },
      operatorCookie,
    );
    assert.equal(revokedUse.statusCode, 403, revokedUse.body);
    assert.equal(readError(revokedUse.body), "grant_revoked");

    const revokedSession = await post(
      `/api/v1/tenant/support-grants/${grant.id}/revoke`,
      {},
      ownerCookie,
    );
    assert.equal(revokedSession.statusCode, 200, revokedSession.body);
    const closed = await post(
      "/api/v1/platform/support-grants/session",
      { sessionToken: session.sessionToken },
      operatorCookie,
    );
    assert.equal(closed.statusCode, 403, closed.body);
    assert.equal(readError(closed.body), "grant_revoked");

    const draft = await post("/api/v1/platform/statutory-tables", { name: "pph21" }, operatorCookie);
    assert.equal(draft.statusCode, 501, draft.body);
    assert.equal(readError(draft.body), "not_implemented");
    const drafts = await get("/api/v1/platform/statutory-tables", operatorCookie);
    assert.equal(drafts.statusCode, 200, drafts.body);
    assert.deepEqual(readData<unknown[]>(drafts.body), []);

    const health = await get("/api/v1/platform/health/tenants", operatorCookie);
    assert.equal(health.statusCode, 200, health.body);
    const healthRow = readData<
      Array<{ tenantId: string; activeUsers: number | null; queueDepth: number | null }>
    >(health.body).find((row) => row.tenantId === tenant.id);
    assert.equal(healthRow?.activeUsers, null);
    assert.equal(healthRow?.queueDepth, null);

    const audits = await get("/api/v1/platform/audit-events", operatorCookie);
    assert.equal(audits.statusCode, 200, audits.body);
    assert.equal(audits.body.includes(grant.token), false);
    assert.equal(audits.body.includes(ownerEmail), false);
    assert.equal(audits.body.includes("support_grant.activate"), true);
    assert.equal(otherOperatorId.length > 0, true);
  });
});

function grantBody(granteePlatformUserId: string) {
  return {
    granteePlatformUserId,
    reason: "Payroll period is stuck.",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

function signIn(email: string, password: string) {
  return request("POST", "/api/auth/sign-in/email", { email, password });
}

function get(url: string, cookie?: string) {
  return request("GET", url, undefined, cookie);
}

function post(url: string, body: Record<string, unknown>, cookie?: string) {
  return request("POST", url, body, cookie);
}

function patch(url: string, body: Record<string, unknown>, cookie?: string) {
  return request("PATCH", url, body, cookie);
}

function request(
  method: "GET" | "POST" | "PATCH",
  url: string,
  body?: Record<string, unknown>,
  cookie?: string,
) {
  return currentApp().inject({
    method,
    url,
    headers: {
      origin,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
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
  else if (Array.isArray(raw)) return raw.map(String);
  return [];
}

function cookieHeader(cookies: string[]): string {
  return cookies
    .map((line) => line.split(";")[0]?.trim() ?? "")
    .filter((part) => part.includes("="))
    .join("; ");
}

function readError(body: string): string | undefined {
  const parsed = JSON.parse(body) as { error?: { code?: string } | null; code?: string };
  return parsed.error?.code ?? parsed.code;
}

function readData<T>(body: string): T {
  const parsed = JSON.parse(body) as { data: T };
  return parsed.data;
}

async function sessionCount(email: string): Promise<number> {
  const rows = await superuserQuery<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM ba_session s
     JOIN ba_user u ON u.id = s.user_id
     WHERE u.email = $1`,
    [email],
  );
  return Number(rows[0]?.count ?? 0);
}

async function superuserQuery<T extends pg.QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<T[]> {
  const admin = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
  await admin.connect();
  try {
    const result = await admin.query<T>(text, values);
    return result.rows;
  } finally {
    await admin.end();
  }
}

function isPermissionDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "42501";
}

function isCheckViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23514";
}

function isReadOnly(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if ("code" in current && current.code === "25006") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function sqlUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("tenant id is not a uuid");
  }
  return value;
}

async function confirmTotp(password: string, cookie: string): Promise<string> {
  const enabled = await post("/api/auth/two-factor/enable", { password }, cookie);
  assert.equal(enabled.statusCode, 200, enabled.body);
  const enrollment = JSON.parse(enabled.body) as { totpURI?: string };
  if (!enrollment.totpURI) throw new Error("missing totp uri");
  const verified = await post(
    "/api/auth/two-factor/verify-totp",
    { code: totpFromUri(enrollment.totpURI) },
    mergeCookies(cookie, setCookies(enabled)),
  );
  assert.equal(verified.statusCode, 200, verified.body);
  return mergeCookies(cookie, [...setCookies(enabled), ...setCookies(verified)]);
}

function mergeCookies(cookie: string, extra: string[]): string {
  const jar = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const name = trimmed.split("=")[0];
    if (name) jar.set(name, trimmed);
  }
  for (const header of extra) {
    const pair = header.split(";")[0]?.trim() ?? "";
    const name = pair.split("=")[0];
    if (name) jar.set(name, pair);
  }
  return [...jar.values()].join("; ");
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

async function resetRows(): Promise<void> {
  const admin = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
  await admin.connect();
  try {
    await admin.query(`
      TRUNCATE TABLE
        sys_platform_audit_events,
        sys_support_grants,
        sys_tenant_quotas,
        sys_platform_operators,
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
