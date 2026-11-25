import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { fail, type PermissionAtom } from "@gotonghr/contracts";
import {
  applyDatabaseUrls,
  createTenantDatabase,
  loadRepoEnv,
  requiredEnv,
  type TenantDatabase,
} from "@gotonghr/db";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import pg from "pg";
import type { CoreHrAuth } from "./auth.ts";
import { EmployeeForbiddenError } from "./errors.ts";
import { registerCoreHr } from "./routes.ts";
import { revealEmployeePii } from "./reveal.ts";

const execFileAsync = promisify(execFile);
const { Client } = pg;

const maleNik = "3273011508950001";
const femaleNik = "3273015508950001";
const femaleMiddle = "01550895";
const otherNik = "3273011508950002";

loadRepoEnv();
applyDatabaseUrls(process.env);
process.env.GOTONG_PII_KEK = "7a".repeat(32);
process.env.AUDIT_HASH_CHAIN = "on";

interface Company {
  tenantId: string;
  userId: string;
  orgId: string;
  legalEntityId: string;
  branchId: string;
}

describe("employees and the PII vault", { concurrency: 1 }, () => {
  let app: FastifyInstance;
  let appDb: TenantDatabase;
  let platform: pg.Client;
  let superuser: pg.Client;
  let companyA: Company;
  let companyB: Company;

  before(async () => {
    await applySchemas();
    appDb = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    platform = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM") });
    superuser = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await platform.connect();
    await superuser.connect();
    const role = await appDb.pool.query<{ current_user: string }>("SELECT current_user");
    assert.equal(role.rows[0]?.current_user, "app_tenant");
    companyA = await seedCompany(superuser, "A");
    companyB = await seedCompany(superuser, "B");
    app = Fastify({ logger: false });
    await registerCoreHr(app, {
      appDb,
      guard(permission) {
        return async (request, reply) => {
          const permissions = headerList(request.headers["x-test-permissions"]);
          if (!permissions.includes(permission)) {
            await reply.code(403).send(fail("forbidden", "Missing permission."));
          }
        };
      },
      readAuth(request): CoreHrAuth | null {
        const tenantId = headerOne(request.headers["x-test-tenant"]);
        const userId = headerOne(request.headers["x-test-user"]);
        if (!tenantId || !userId) return null;
        const support = headerOne(request.headers["x-test-support-pii"]);
        return {
          tenantId,
          userId,
          role: "hr_admin",
          permissions: headerList(request.headers["x-test-permissions"]),
          scopeEntityIds: [],
          scopeBranchIds: [],
          directReportsOnly: false,
          selfOnly: false,
          ipAddress: "127.0.0.1",
          userAgent: "core-hr-test",
          ...(support === "deny" ? { supportGrantAllowPiiReveal: false } : {}),
        };
      },
    });
  });

  after(async () => {
    await app.close();
    await cleanup(superuser, [companyA, companyB]);
    await appDb.end();
    await platform.end();
    await superuser.end();
  });

  it("rejects an invalid NIK and writes nothing", async () => {
    const beforeCount = await employeeCount(superuser, companyA.tenantId);
    const response = await postEmployee(app, companyA, ["employee.write"], {
      ...body(companyA, "BAD1", "3273013208950001"),
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(errorOf(response).code, "invalid_field");
    assert.equal(errorOf(response).fields?.some((field) => field.field === "nik"), true);
    assert.equal(await employeeCount(superuser, companyA.tenantId), beforeCount);
  });

  it("stores a female NIK and lists only the mask", async () => {
    const created = await postEmployee(app, companyA, ["employee.write"], body(companyA, "F001", femaleNik));
    assert.equal(created.statusCode, 201, created.body);
    const saved = dataOf<EmployeeJson>(created);
    assert.equal(saved.nikMask, "3273********0001");
    assert.equal(JSON.stringify(saved).includes(femaleNik), false);
    assert.equal(JSON.stringify(saved).includes("nik_enc"), false);
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/employees",
      headers: authHeaders(companyA, ["employee.read"]),
    });
    assert.equal(listed.statusCode, 200, listed.body);
    const payload = listed.body;
    assert.equal(payload.includes(femaleNik), false);
    assert.equal(payload.includes(femaleMiddle), false);
    assert.equal(payload.includes("nik_enc"), false);
    assert.equal(payload.includes("nikEnc"), false);
    assert.equal(payload.includes("3273********0001"), true);
    const bare = await appDb.pool.query("SELECT id FROM hr_employees");
    assert.equal(bare.rows.length, 0);
  });

  it("returns 409 for a duplicate NIK in one tenant and allows it in another", async () => {
    const [first, second] = await Promise.all([
      postEmployee(app, companyA, ["employee.write"], body(companyA, "D001", maleNik)),
      postEmployee(app, companyA, ["employee.write"], body(companyA, "D002", maleNik)),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort((left, right) => left - right);
    assert.deepEqual(statuses, [201, 409]);
    const conflict = first.statusCode === 409 ? first : second;
    assert.equal(errorOf(conflict).fields?.some((field) => field.field === "nik"), true);
    const other = await postEmployee(app, companyB, ["employee.write"], body(companyB, "D001", maleNik));
    assert.equal(other.statusCode, 201, other.body);
    const duplicateCode = await postEmployee(app, companyA, ["employee.write"], body(companyA, "F001", otherNik));
    assert.equal(duplicateCode.statusCode, 409, duplicateCode.body);
    assert.equal(errorOf(duplicateCode).fields?.some((field) => field.field === "employeeCode"), true);
  });

  it("hides the other tenant and denies platform_admin", async () => {
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/employees",
      headers: authHeaders(companyB, ["employee.read"]),
    });
    const rows = dataOf<EmployeeJson[]>(listed);
    assert.equal(rows.every((row) => row.employeeCode === "D001"), true);
    assert.equal(rows.some((row) => row.employeeCode === "F001"), false);
    const foreign = rows[0];
    assert.ok(foreign);
    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${foreign.id}`,
      headers: authHeaders(companyA, ["employee.read"]),
    });
    assert.equal(hidden.statusCode, 404, hidden.body);
    await assert.rejects(platform.query("SELECT id FROM hr_employees"), (error: unknown) => {
      return codeOf(error) === "42501";
    });
    await assert.rejects(platform.query("SELECT id FROM hr_employee_pii"), (error: unknown) => {
      return codeOf(error) === "42501";
    });
  });

  it("refuses reveal without permission and writes no access log", async () => {
    const employee = dataOf<EmployeeJson>(
      await postEmployee(app, companyA, ["employee.write"], body(companyA, "R001", "3273011508950003")),
    );
    const beforeLogs = await logCount(superuser, employee.id);
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee.id}/pii/reveal`,
      headers: authHeaders(companyA, ["employee.read"]),
      payload: { reason: "Payroll check" },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(errorOf(denied).code, "forbidden");
    await assert.rejects(
      revealEmployeePii(appDb, caller(companyA, ["employee.read"]), employee.id, {
        reason: "Payroll check",
        fields: ["nik"],
      }),
      EmployeeForbiddenError,
    );
    assert.equal(await logCount(superuser, employee.id), beforeLogs);
  });

  it("writes one reveal log and keeps the raw NIK out of it", async () => {
    const employee = dataOf<EmployeeJson>(
      await postEmployee(app, companyA, ["employee.write"], body(companyA, "R002", "3273011508950004")),
    );
    const revealed = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee.id}/pii/reveal`,
      headers: authHeaders(companyA, ["employee.pii.reveal"]),
      payload: { reason: "BPJS registration" },
    });
    assert.equal(revealed.statusCode, 200, revealed.body);
    const bodyJson = dataOf<{ values: { nik: string } }>(revealed);
    assert.equal(bodyJson.values.nik, "3273011508950004");
    const logs = await superuser.query<{ field_name: string; reason: string; row_text: string }>(
      `SELECT field_name, reason, row_to_json(aud_pii_access_logs)::text AS row_text
       FROM aud_pii_access_logs
       WHERE resource_id = $1::uuid`,
      [employee.id],
    );
    assert.equal(logs.rowCount, 1);
    assert.equal(logs.rows[0]?.field_name, "nik");
    assert.equal(logs.rows[0]?.reason, "BPJS registration");
    assert.equal(logs.rows[0]?.row_text.includes("3273011508950004"), false);
    const stored = await superuser.query<{ nik_enc: string }>(
      "SELECT nik_enc FROM hr_employee_pii WHERE employee_id = $1::uuid",
      [employee.id],
    );
    assert.notEqual(stored.rows[0]?.nik_enc, "3273011508950004");
    assert.equal(stored.rows[0]?.nik_enc.includes("3273011508950004"), false);
  });

  it("updates the name and stores a redacted audit row", async () => {
    const employee = dataOf<EmployeeJson>(
      await postEmployee(app, companyA, ["employee.write"], body(companyA, "P001", "3273011508950006")),
    );
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employee.id}`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { fullName: "Sari Putri" },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(dataOf<EmployeeJson>(patched).fullName, "Sari Putri");
    assert.equal(patched.body.includes("3273011508950006"), false);
    const events = await superuser.query<{ diff: string }>(
      `SELECT diff_redacted_json::text AS diff
       FROM aud_events
       WHERE resource_id = $1::uuid AND action = 'employee.update'`,
      [employee.id],
    );
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0]?.diff.includes("3273011508950006"), false);
    assert.equal(events.rows[0]?.diff.includes("Sari Putri"), true);
  });

  it("refuses a support grant that cannot reveal PII and writes no log", async () => {
    const employee = dataOf<EmployeeJson>(
      await postEmployee(app, companyA, ["employee.write"], body(companyA, "R003", "3273011508950005")),
    );
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee.id}/pii/reveal`,
      headers: authHeaders(companyA, ["employee.pii.reveal"], "deny"),
      payload: { reason: "Support lookup" },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(errorOf(denied).code, "pii_reveal_denied");
    assert.equal(await logCount(superuser, employee.id), 0);
  });

  it("stores a department, a PKWT end date, and append-only pay", async () => {
    const employee = dataOf<EmployeeJson>(
      await postEmployee(app, companyA, ["employee.write"], body(companyA, "C001", "3273011508950007")),
    );
    const missingEnd = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee.id}/contracts`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { contractType: "PKWT", startDate: "2026-01-01" },
    });
    assert.equal(missingEnd.statusCode, 400, missingEnd.body);
    assert.equal(errorOf(missingEnd).fields?.[0]?.field, "endDate");

    const department = dataOf<{ id: string; name: string }>(
      await app.inject({
        method: "POST",
        url: "/api/v1/departments",
        headers: authHeaders(companyA, ["employee.write"]),
        payload: { name: "People Operations" },
      }),
    );
    assert.equal(department.name, "People Operations");
    const position = dataOf<{ id: string }>(
      await app.inject({
        method: "POST",
        url: "/api/v1/positions",
        headers: authHeaders(companyA, ["employee.write"]),
        payload: { name: "HR Generalist", departmentId: department.id },
      }),
    );
    const assigned = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employee.id}`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { departmentId: department.id, positionId: position.id },
    });
    assert.equal(assigned.statusCode, 200, assigned.body);
    const contract = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee.id}/contracts`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { contractType: "PKWT", startDate: "2026-01-01", endDate: "2027-01-09" },
    });
    assert.equal(contract.statusCode, 201, contract.body);
    const listed = dataOf<EmployeeJson[]>(
      await app.inject({
        method: "GET",
        url: "/api/v1/employees?limit=100",
        headers: authHeaders(companyA, ["employee.read"]),
      }),
    );
    const row = listed.find((item) => item.employeeCode === "C001");
    assert.equal(row?.departmentName, "People Operations");
    assert.equal(row?.positionName, "HR Generalist");
    assert.equal(row?.contractType, "PKWT");
    assert.equal(row?.contractEndDate, "2027-01-09");
    assert.equal(JSON.stringify(listed).includes("3273011508950007"), false);

    const firstPay = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee.id}/compensation-profiles`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { baseSalaryIdr: "8.500.000", effectiveFrom: "2026-01-01" },
    });
    assert.equal(firstPay.statusCode, 201, firstPay.body);
    assert.equal(dataOf<{ baseSalaryIdr: string }>(firstPay).baseSalaryIdr, "8500000");
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee.id}/compensation-profiles`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { baseSalaryIdr: "9000000", effectiveFrom: "2026-01-01" },
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    const secondPay = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${employee.id}/compensation-profiles`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { baseSalaryIdr: "9000000", effectiveFrom: "2026-06-01" },
    });
    assert.equal(secondPay.statusCode, 201, secondPay.body);
    const history = dataOf<{ effectiveFrom: string; baseSalaryIdr: string }[]>(
      await app.inject({
        method: "GET",
        url: `/api/v1/employees/${employee.id}/compensation-profiles`,
        headers: authHeaders(companyA, ["employee.read"]),
      }),
    );
    assert.deepEqual(
      history.map((item) => item.effectiveFrom),
      ["2026-06-01", "2026-01-01"],
    );
    const patchedPay = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employee.id}/compensation-profiles`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { baseSalaryIdr: "1", effectiveFrom: "2026-01-01" },
    });
    assert.equal(patchedPay.statusCode, 404, patchedPay.body);
    await assert.rejects(platform.query("SELECT id FROM hr_contracts"), (error: unknown) => codeOf(error) === "42501");
  });
});

interface EmployeeJson {
  id: string;
  employeeCode: string;
  fullName: string;
  nikMask: string;
  departmentName?: string | null;
  positionName?: string | null;
  contractType?: string | null;
  contractEndDate?: string | null;
}

async function applySchemas(): Promise<void> {
  const repo = fileURLToPath(new URL("../../../../", import.meta.url));
  const source = `
    import { migrate, migrateEnvFrom, loadRepoEnv, applyDatabaseUrls } from ${JSON.stringify(`${repo}/packages/db/dist/index.js`)};
    import { migrateIdentity } from ${JSON.stringify(`${repo}/packages/modules/identity/dist/migrate.js`)};
    import { migrateAudit } from ${JSON.stringify(`${repo}/packages/modules/audit/dist/migrate.js`)};
    import { migrateCoreHr } from ${JSON.stringify(`${repo}/packages/modules/core-hr/dist/migrate.js`)};
    loadRepoEnv();
    applyDatabaseUrls(process.env);
    const env = migrateEnvFrom(process.env);
    await migrate(env);
    await migrateIdentity({ superuserUrl: env.superuserUrl, migratorUrl: env.migratorUrl });
    await migrateAudit({ migratorUrl: env.migratorUrl });
    await migrateCoreHr({ migratorUrl: env.migratorUrl });
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: repo,
    env: process.env,
  });
}

async function seedCompany(superuser: pg.Client, label: string): Promise<Company> {
  const tenantId = randomUUID();
  const orgId = `core-hr-${label}-${tenantId}`;
  const legalEntityId = randomUUID();
  const branchId = randomUUID();
  const userId = randomUUID();
  const npwp = label === "A" ? "1000000000000101" : "1000000000000102";
  const nitku = label === "A" ? "1000000000000000000101" : "1000000000000000000102";
  await superuser.query(
    `INSERT INTO ba_organization (id, name, slug) VALUES ($1, $2, $1)`,
    [orgId, `Core HR ${label}`],
  );
  await superuser.query(
    `INSERT INTO id_tenants (id, organization_id, name, slug)
     VALUES ($1::uuid, $2, $3, $2)`,
    [tenantId, orgId, `Core HR ${label}`],
  );
  await superuser.query(
    `INSERT INTO id_legal_entities (id, tenant_id, company_name, npwp_16)
     VALUES ($1::uuid, $2::uuid, $3, $4)`,
    [legalEntityId, tenantId, `PT Core ${label}`, npwp],
  );
  await superuser.query(
    `INSERT INTO id_branches (id, tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'Asia/Jakarta', 5000000)`,
    [branchId, tenantId, legalEntityId, `HQ ${label}`, nitku],
  );
  return { tenantId, userId, orgId, legalEntityId, branchId };
}

async function cleanup(superuser: pg.Client, companies: Company[]): Promise<void> {
  const tenants = companies.map((company) => company.tenantId);
  const orgs = companies.map((company) => company.orgId);
  await superuser.query("DELETE FROM aud_pii_access_logs WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_outbox_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_tenant_keys WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_employee_pii WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_employees WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_branches WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_legal_entities WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_tenants WHERE id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM ba_organization WHERE id = ANY($1::text[])", [orgs]);
}

function body(company: Company, code: string, nik: string): Record<string, unknown> {
  return {
    employeeCode: code,
    fullName: "Sari Wulandari",
    legalEntityId: company.legalEntityId,
    branchId: company.branchId,
    employmentStatus: "active",
    joinDate: "2024-03-01",
    ptkpStatus: "TK/0",
    taxMethod: "gross",
    pph21SubjectType: "permanent",
    nik,
  };
}

function authHeaders(company: Company, permissions: string[], support?: "deny"): Record<string, string> {
  return {
    "x-test-tenant": company.tenantId,
    "x-test-user": company.userId,
    "x-test-permissions": permissions.join(","),
    ...(support ? { "x-test-support-pii": support } : {}),
  };
}

function postEmployee(
  app: FastifyInstance,
  company: Company,
  permissions: string[],
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/api/v1/employees",
    headers: authHeaders(company, permissions),
    payload,
  });
}

function caller(company: Company, permissions: readonly PermissionAtom[]): CoreHrAuth {
  return {
    tenantId: company.tenantId,
    userId: company.userId,
    role: "hr_admin",
    permissions,
    scopeEntityIds: [],
    scopeBranchIds: [],
    directReportsOnly: false,
    selfOnly: false,
    ipAddress: null,
    userAgent: null,
  };
}

async function employeeCount(superuser: pg.Client, tenantId: string): Promise<number> {
  const result = await superuser.query("SELECT id FROM hr_employees WHERE tenant_id = $1::uuid", [tenantId]);
  return result.rowCount ?? 0;
}

async function logCount(superuser: pg.Client, employeeId: string): Promise<number> {
  const result = await superuser.query(
    "SELECT id FROM aud_pii_access_logs WHERE resource_id = $1::uuid",
    [employeeId],
  );
  return result.rowCount ?? 0;
}

function dataOf<T>(response: LightMyRequestResponse): T {
  return (JSON.parse(response.body) as { data: T }).data;
}

function errorOf(response: LightMyRequestResponse): {
  code: string;
  fields?: { field: string; message: string }[];
} {
  return (JSON.parse(response.body) as { error: { code: string; fields?: { field: string; message: string }[] } })
    .error;
}

function headerOne(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : null;
}

function headerList(value: string | string[] | undefined): string[] {
  const first = headerOne(value);
  return first ? first.split(",").filter((item) => item.length > 0) : [];
}

function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
