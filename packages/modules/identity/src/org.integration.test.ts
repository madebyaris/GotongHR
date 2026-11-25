import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
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
import { bootstrapOwner, grantMembership } from "./bootstrap.ts";
import { migrateIdentity } from "./migrate.ts";
import { registerIdentity } from "./plugin.ts";
import { cookieHeader, readErrorRecord, resetIdentity, setCookieLines, superuserQuery } from "./testing.ts";

const { Client } = pg;

const origin = "http://127.0.0.1:3000";
const ownerEmail = "org-owner@gotonghr.test";
const ownerPassword = "owner-password-1";
const employeeEmail = "org-employee@gotonghr.test";
const hrEmail = "org-hr@gotonghr.test";
const payrollEmail = "org-payroll@gotonghr.test";
const password = "employee-password-1";
const npwp = "0123456789012345";
const nitku = "0123456789012345678901";
const hugeUmp = "9007199254740993";

loadRepoEnv();
applyDatabaseUrls(process.env);

describe("legal entities and branches", { concurrency: 1 }, () => {
  let app: FastifyInstance;
  let appDb: TenantDatabase;
  let tenantId = "";
  let employeeAuthUserId = "";
  let hrAuthUserId = "";
  let ownerCookie = "";
  let employeeCookie = "";
  let hrCookie = "";
  let payrollCookie = "";

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
    const auth: GotongAuth = createAuth({
      appDb,
      env: {
        ...process.env,
        NODE_ENV: "test",
        GOTONG_DEPLOYMENT_MODE: "single_tenant",
        BETTER_AUTH_URL: origin,
      },
    });
    app = Fastify({ logger: false });
    appHandleRef = app;
    await registerIdentity(app, { auth, appDb, rateLimitMax: 100 });
    const created = await bootstrapOwner(
      auth,
      appDb,
      { email: ownerEmail, password: ownerPassword, name: "Owner", tenantName: "GotongHR" },
      "single_tenant",
    );
    tenantId = created.tenantId;
    const employee = await grantMembership(auth, appDb, {
      tenantId,
      email: employeeEmail,
      password,
      name: "Employee",
      role: "employee",
    });
    employeeAuthUserId = employee.authUserId;
    const hr = await grantMembership(auth, appDb, {
      tenantId,
      email: hrEmail,
      password,
      name: "HR Admin",
      role: "hr_admin",
    });
    hrAuthUserId = hr.authUserId;
    await grantMembership(auth, appDb, {
      tenantId,
      email: payrollEmail,
      password,
      name: "Payroll",
      role: "payroll_admin",
    });
    ownerCookie = await signedIn(ownerEmail, ownerPassword);
    employeeCookie = await signedIn(employeeEmail, password);
    hrCookie = await signedIn(hrEmail, password);
    payrollCookie = await signedIn(payrollEmail, password);
  });

  after(async () => {
    await app.close();
    await appDb.end();
    await resetIdentity();
  });

  it("returns the signed-in owner, tenant, role, and an empty company", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/v1/me/context" });
    assert.equal(anon.statusCode, 401);
    assert.equal(readErrorRecord(anon)?.code, "unauthenticated");
    const response = await getJson("/api/v1/me/context", ownerCookie);
    assert.equal(response.statusCode, 200, response.body);
    const body = readData<ContextBody>(response);
    assert.equal(body.user.email, ownerEmail);
    assert.equal(body.user.displayName, "Owner");
    assert.equal(body.tenant.id, tenantId);
    assert.equal(body.tenant.name, "GotongHR");
    assert.equal(body.role, "org_owner");
    assert.equal(body.permissions.includes("employee.pii.read"), true);
    assert.deepEqual(body.scope.legalEntityIds, []);
    assert.equal(body.legalEntities.length, 0);
    assert.equal(body.branches.length, 0);
  });

  it("returns a field error for NPWP and NITKU lengths other than 16 and 22", async () => {
    const before = await getJson("/api/v1/legal-entities", ownerCookie);
    const beforeCount = readData<unknown[]>(before).length;
    for (const badNpwp of ["123456789012345", "12345678901234567", "01.234.567.8-901.234"]) {
      const response = await postJson("/api/v1/legal-entities", ownerCookie, {
        companyName: "PT Bad",
        npwp16: badNpwp,
      });
      assert.equal(response.statusCode, 400, response.body);
      const error = readErrorRecord(response);
      assert.equal(error?.code, "invalid_field");
      assert.equal(error?.fields?.some((field) => field.field === "npwp16"), true);
    }
    const entity = await postJson("/api/v1/legal-entities", ownerCookie, {
      companyName: "PT Length",
      npwp16: "6666666666666666",
    });
    assert.equal(entity.statusCode, 201, entity.body);
    const entityId = readData<{ id: string }>(entity).id;
    for (const badNitku of ["123456789012345678901", "12345678901234567890123", "012345678901234567890A"]) {
      const response = await postJson("/api/v1/branches", ownerCookie, branchBody(entityId, badNitku));
      assert.equal(response.statusCode, 400, response.body);
      const error = readErrorRecord(response);
      assert.equal(error?.code, "invalid_field");
      assert.equal(error?.fields?.some((field) => field.field === "nitku22" && field.message.includes("22")), true);
    }
    const branches = await getJson("/api/v1/branches", ownerCookie);
    assert.equal(readData<unknown[]>(branches).length, 0);
    const after = await getJson("/api/v1/legal-entities", ownerCookie);
    assert.equal(readData<unknown[]>(after).length, beforeCount + 1);
  });

  it("stores UMP as bigint and rejects a fractional amount", async () => {
    const entities = readData<{ id: string }[]>(await getJson("/api/v1/legal-entities", ownerCookie));
    const entityId = entities[0]?.id;
    assert.ok(entityId);
    const fractional = await postJson("/api/v1/branches", ownerCookie, {
      ...branchBody(entityId, nitku),
      umpUmkIdr: 5396761.5,
    });
    assert.equal(fractional.statusCode, 400, fractional.body);
    assert.equal(readErrorRecord(fractional)?.fields?.some((field) => field.field === "umpUmkIdr"), true);
    const negative = await postJson("/api/v1/branches", ownerCookie, {
      ...branchBody(entityId, nitku),
      umpUmkIdr: -1,
    });
    assert.equal(negative.statusCode, 400, negative.body);
    const created = await postJson("/api/v1/branches", ownerCookie, {
      ...branchBody(entityId, nitku),
      umpUmkIdr: "5.396.761",
      latitude: "-6.175392",
      longitude: "106.827153",
      geofenceRadiusM: 150,
    });
    assert.equal(created.statusCode, 201, created.body);
    const branch = readData<BranchBody>(created);
    assert.equal(branch.umpUmkIdr, "5396761");
    assert.equal(typeof branch.umpUmkIdr, "string");
    assert.equal(branch.latitude, "-6.175392");
    assert.equal(branch.longitude, "106.827153");
    assert.equal(branch.geofenceRadiusM, 150);
    assert.equal(branch.timezone, "Asia/Jakarta");
    assertUuidV7(branch.id);
    const patched = await patchJson(`/api/v1/branches/${branch.id}`, ownerCookie, { umpUmkIdr: hugeUmp });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(readData<BranchBody>(patched).umpUmkIdr, hugeUmp);
    const listed = readData<BranchBody[]>(await getJson("/api/v1/branches", ownerCookie));
    assert.equal(listed.find((row) => row.id === branch.id)?.umpUmkIdr, hugeUmp);
    const moved = await patchJson(`/api/v1/branches/${branch.id}`, ownerCookie, { latitude: "-6.200000" });
    assert.equal(moved.statusCode, 200, moved.body);
    const movedBranch = readData<BranchBody>(moved);
    assert.equal(movedBranch.latitude, "-6.2");
    assert.equal(movedBranch.longitude, "106.827153");
    assert.equal(movedBranch.geofenceRadiusM, 150);
    const column = await appDb.pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'id_branches' AND column_name = 'ump_umk_idr'`,
    );
    assert.equal(column.rows[0]?.data_type, "bigint");
  });

  it("reloads the legal entity and branch from context", async () => {
    const context = readData<ContextBody>(await getJson("/api/v1/me/context", ownerCookie));
    const entity = context.legalEntities.find((row) => row.npwp16 === "6666666666666666");
    assert.ok(entity);
    assert.equal(entity.companyName, "PT Length");
    const branch = context.branches.find((row) => row.nitku22 === nitku);
    assert.ok(branch);
    assert.equal(branch.umpUmkIdr, hugeUmp);
    const renamed = await patchJson(`/api/v1/legal-entities/${entity.id}`, ownerCookie, {
      companyName: "PT Surya Nusantara",
      npwp16: npwp,
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal(readData<{ companyName: string; npwp16: string }>(renamed).npwp16, npwp);
    const again = readData<ContextBody>(await getJson("/api/v1/me/context", ownerCookie));
    assert.equal(again.legalEntities.some((row) => row.companyName === "PT Surya Nusantara"), true);
    const missing = await patchJson(`/api/v1/legal-entities/${randomUUID()}`, ownerCookie, {
      companyName: "Missing",
    });
    assert.equal(missing.statusCode, 404);
  });

  it("returns 409 when the NPWP or NITKU is already used", async () => {
    const duplicateEntity = await postJson("/api/v1/legal-entities", ownerCookie, {
      companyName: "PT Copy",
      npwp16: npwp,
    });
    assert.equal(duplicateEntity.statusCode, 409, duplicateEntity.body);
    assert.equal(readErrorRecord(duplicateEntity)?.fields?.some((field) => field.field === "npwp16"), true);
    const entities = readData<{ id: string }[]>(await getJson("/api/v1/legal-entities", ownerCookie));
    const entityId = entities[0]?.id;
    assert.ok(entityId);
    const duplicateBranch = await postJson(
      "/api/v1/branches",
      ownerCookie,
      branchBody(entityId, nitku),
    );
    assert.equal(duplicateBranch.statusCode, 409, duplicateBranch.body);
    assert.equal(readErrorRecord(duplicateBranch)?.fields?.some((field) => field.field === "nitku22"), true);
  });

  it("lets every member read and only an owner or HR admin write", async () => {
    const employeeRead = await getJson("/api/v1/legal-entities", employeeCookie);
    assert.equal(employeeRead.statusCode, 200, employeeRead.body);
    assert.equal(readData<unknown[]>(employeeRead).length > 0, true);
    const employeeWrite = await postJson("/api/v1/legal-entities", employeeCookie, {
      companyName: "PT Employee",
      npwp16: "7777777777777777",
    });
    assert.equal(employeeWrite.statusCode, 403, employeeWrite.body);
    assert.equal(readErrorRecord(employeeWrite)?.code, "forbidden");
    const payrollWrite = await postJson("/api/v1/branches", payrollCookie, {
      ...branchBody(readData<{ id: string }[]>(employeeRead)[0]?.id ?? "", "7777777777777777777777"),
    });
    assert.equal(payrollWrite.statusCode, 403, payrollWrite.body);
    const hrWrite = await postJson("/api/v1/legal-entities", hrCookie, {
      companyName: "PT HR",
      npwp16: "8888888888888888",
    });
    assert.equal(hrWrite.statusCode, 201, hrWrite.body);
    const hrEntityId = readData<{ id: string }>(hrWrite).id;
    await superuserQuery(
      "UPDATE id_memberships SET scope_entity_ids = ARRAY[$1]::uuid[] WHERE auth_user_id = $2",
      [hrEntityId, employeeAuthUserId],
    );
    const scoped = readData<{ id: string }[]>(await getJson("/api/v1/legal-entities", employeeCookie));
    assert.deepEqual(scoped.map((row) => row.id), [hrEntityId]);
    await superuserQuery(
      "UPDATE id_memberships SET scope_entity_ids = '{}'::uuid[] WHERE auth_user_id = $1",
      [employeeAuthUserId],
    );
  });

  it("limits a branch-scoped HR admin to the entity that owns the branch", async () => {
    const entities = readData<{ id: string }[]>(await getJson("/api/v1/legal-entities", ownerCookie));
    const branches = readData<{ id: string; legalEntityId: string }[]>(
      await getJson("/api/v1/branches", ownerCookie),
    );
    const scopedBranch = branches[0];
    assert.ok(scopedBranch);
    const owned = entities.find((row) => row.id === scopedBranch.legalEntityId);
    const other = entities.find((row) => row.id !== scopedBranch.legalEntityId);
    assert.ok(owned);
    assert.ok(other);
    const otherBranch = await postJson(
      "/api/v1/branches",
      ownerCookie,
      branchBody(other.id, "5555555555555555555555"),
    );
    assert.equal(otherBranch.statusCode, 201, otherBranch.body);
    await superuserQuery(
      "UPDATE id_memberships SET scope_entity_ids = '{}'::uuid[], scope_branch_ids = ARRAY[$1]::uuid[] WHERE auth_user_id = $2",
      [scopedBranch.id, hrAuthUserId],
    );
    try {
      const visibleEntities = readData<{ id: string }[]>(await getJson("/api/v1/legal-entities", hrCookie));
      assert.deepEqual(visibleEntities.map((row) => row.id), [owned.id]);
      const visibleBranches = readData<{ id: string }[]>(await getJson("/api/v1/branches", hrCookie));
      assert.deepEqual(visibleBranches.map((row) => row.id), [scopedBranch.id]);
      const context = readData<ContextBody>(await getJson("/api/v1/me/context", hrCookie));
      assert.deepEqual(
        context.legalEntities.map((row) => row.id),
        [owned.id],
      );
      const patch = await patchJson(`/api/v1/legal-entities/${owned.id}`, hrCookie, {
        companyName: "PT Scoped",
      });
      assert.equal(patch.statusCode, 403, patch.body);
      assert.equal(readErrorRecord(patch)?.code, "forbidden");
      const create = await postJson("/api/v1/legal-entities", hrCookie, {
        companyName: "PT Extra",
        npwp16: "2222222222222222",
      });
      assert.equal(create.statusCode, 403, create.body);
    } finally {
      await superuserQuery(
        "UPDATE id_memberships SET scope_entity_ids = '{}'::uuid[], scope_branch_ids = '{}'::uuid[] WHERE auth_user_id = $1",
        [hrAuthUserId],
      );
    }
  });

  it("isolates rows with FORCE RLS and allows DML only for app_tenant", async () => {
    const flags = await superuserQuery<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class AS c
       JOIN pg_namespace AS n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [["id_legal_entities", "id_branches"]],
    );
    assert.equal(flags.length, 2);
    for (const flag of flags) {
      assert.equal(flag.relrowsecurity, true, flag.relname);
      assert.equal(flag.relforcerowsecurity, true, flag.relname);
    }
    for (const table of ["id_legal_entities", "id_branches"]) {
      const grants = await superuserQuery<{ grantee: string; privilege_type: string }>(
        `SELECT grantee, privilege_type
         FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const grantees = new Set(grants.map((grant) => grant.grantee));
      assert.equal(grantees.has("app_tenant"), true, table);
      assert.equal(grantees.has("platform_admin"), false, table);
      assert.equal(grantees.has("gotong_queue"), false, table);
      assert.equal(grantees.has("PUBLIC"), false, table);
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal(
          grants.some((grant) => grant.grantee === "app_tenant" && grant.privilege_type === privilege),
          true,
          `${table} ${privilege}`,
        );
      }
    }

    const tenantB = await superuserQuery<{ id: string }>("SELECT uuidv7() AS id", []);
    const otherTenantId = tenantB[0]?.id;
    assert.ok(otherTenantId);
    assertUuidV7(otherTenantId);
    const orgId = `org-${randomUUID()}`;
    await superuserQuery(
      "INSERT INTO ba_organization (id, name, slug) VALUES ($1, 'Other Co', $2)",
      [orgId, `other-${orgId.slice(0, 8)}`],
    );
    await superuserQuery(
      `INSERT INTO id_tenants (id, organization_id, name, slug)
       VALUES ($1::uuid, $2, 'Other Co', $3)`,
      [otherTenantId, orgId, `other-${orgId.slice(0, 8)}`],
    );
    await superuserQuery(
      `INSERT INTO id_legal_entities (tenant_id, company_name, npwp_16)
       VALUES ($1::uuid, 'Other PT', '3333333333333333')`,
      [otherTenantId],
    );

    const seenByA = await appDb.withTenantContext(tenantId, async (tx) => {
      const result = await tx.execute<{ company_name: string }>(
        sql`SELECT company_name FROM id_legal_entities`,
      );
      return result.rows.map((row) => row.company_name);
    });
    assert.equal(seenByA.includes("Other PT"), false);
    const seenByB = await appDb.withTenantContext(otherTenantId, async (tx) => {
      const result = await tx.execute<{ company_name: string }>(
        sql`SELECT company_name FROM id_legal_entities`,
      );
      return result.rows.map((row) => row.company_name);
    });
    assert.deepEqual(seenByB, ["Other PT"]);
    const unscoped = await appDb.pool.query("SELECT id FROM id_legal_entities");
    assert.equal(unscoped.rowCount, 0);

    const entity = readData<{ id: string }[]>(await getJson("/api/v1/legal-entities", ownerCookie))[0];
    assert.ok(entity);
    await assert.rejects(
      () =>
        appDb.withTenantContext(tenantId, (tx) =>
          tx.execute(sql`
            INSERT INTO id_legal_entities (tenant_id, company_name, npwp_16)
            VALUES (${otherTenantId}::uuid, 'Cross', '9999999999999999')
          `),
        ),
      (error: unknown) => errorCode(error) === "42501",
    );
    await assert.rejects(
      () =>
        appDb.withTenantContext(tenantId, (tx) =>
          tx.execute(sql`
            INSERT INTO id_legal_entities (tenant_id, company_name, npwp_16)
            VALUES (${tenantId}::uuid, 'Short', '12345')
          `),
        ),
      (error: unknown) => errorCode(error) === "23514",
    );
    await assert.rejects(
      () =>
        appDb.withTenantContext(tenantId, (tx) =>
          tx.execute(sql`
            INSERT INTO id_branches (
              tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr
            )
            VALUES (
              ${tenantId}::uuid, ${entity.id}::uuid, 'Bad zone', '4444444444444444444444', 'WIB', 1000
            )
          `),
        ),
      (error: unknown) => errorCode(error) === "23514",
    );
    await assert.rejects(
      () =>
        appDb.withTenantContext(tenantId, (tx) =>
          tx.execute(sql`
            INSERT INTO id_branches (
              tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr
            )
            VALUES (
              ${tenantId}::uuid, ${entity.id}::uuid, 'Bad wage', '2222222222222222222222',
              'Asia/Jakarta', -5
            )
          `),
        ),
      (error: unknown) => errorCode(error) === "23514",
    );

    const platform = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM") });
    const queue = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_QUEUE") });
    let platformOpen = false;
    let queueOpen = false;
    try {
      await platform.connect();
      platformOpen = true;
      await queue.connect();
      queueOpen = true;
      await assert.rejects(platform.query("SELECT id FROM id_legal_entities"), (error: unknown) => {
        return errorCode(error) === "42501";
      });
      await assert.rejects(queue.query("SELECT id FROM id_branches"), (error: unknown) => {
        return errorCode(error) === "42501";
      });
    } finally {
      if (platformOpen) await platform.end();
      if (queueOpen) await queue.end();
    }
  });
});

interface ContextBody {
  user: { email: string; displayName: string };
  tenant: { id: string; name: string };
  role: string;
  permissions: string[];
  scope: { legalEntityIds: string[] };
  legalEntities: { id: string; companyName: string; npwp16: string }[];
  branches: BranchBody[];
}

interface BranchBody {
  id: string;
  nitku22: string;
  timezone: string;
  umpUmkIdr: string;
  latitude: string | null;
  longitude: string | null;
  geofenceRadiusM: number | null;
}

function branchBody(legalEntityId: string, nitku22: string) {
  return {
    legalEntityId,
    name: "Jakarta Pusat",
    nitku22,
    timezone: "Asia/Jakarta",
    umpUmkIdr: 5396761,
  };
}

async function signedIn(email: string, userPassword: string): Promise<string> {
  const response = await postJson("/api/auth/sign-in/email", undefined, {
    email,
    password: userPassword,
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = cookieHeader(setCookieLines(response));
  assert.ok(cookie.includes("="));
  return cookie;
}

function postJson(url: string, cookie: string | undefined, body: Record<string, unknown>) {
  return appRequest("POST", url, cookie, body);
}

function patchJson(url: string, cookie: string, body: Record<string, unknown>) {
  return appRequest("PATCH", url, cookie, body);
}

function getJson(url: string, cookie: string) {
  return appRequest("GET", url, cookie);
}

function appRequest(
  method: "GET" | "POST" | "PATCH",
  url: string,
  cookie?: string,
  body?: Record<string, unknown>,
) {
  return appHandle().inject({
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

let appHandleRef: FastifyInstance | undefined;

function appHandle(): FastifyInstance {
  if (!appHandleRef) throw new Error("app is not ready");
  return appHandleRef;
}

function readData<T>(response: LightMyRequestResponse): T {
  const parsed = JSON.parse(response.body) as { data: T };
  return parsed.data;
}

function assertUuidV7(id: string): void {
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
