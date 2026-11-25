import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fail } from "@gotonghr/contracts";
import {
  applyDatabaseUrls,
  createTenantDatabase,
  loadRepoEnv,
  requiredEnv,
  type TenantDatabase,
} from "@gotonghr/db";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import pg from "pg";
import type { CoreHrAuth } from "../auth.ts";
import { registerCoreHr } from "../routes.ts";
import { errorCode } from "../sql.ts";
import { addIsoDays, jakartaDate } from "./dates.ts";
import { scanContractExpiry } from "./expiry.ts";

const execFileAsync = promisify(execFile);
const { Client } = pg;

loadRepoEnv();
applyDatabaseUrls(process.env);
process.env.GOTONG_PII_KEK = "7a".repeat(32);
process.env.AUDIT_HASH_CHAIN = "on";

const frozen = new Date("2026-11-24T17:30:00.000Z");
const noticeOn = jakartaDate(frozen);
const hugeSalary = "9007199254740993";

interface Company {
  tenantId: string;
  userId: string;
  orgId: string;
  legalEntityId: string;
  branchId: string;
}

interface DepartmentJson {
  id: string;
  parentDepartmentId: string | null;
  code: string;
}

interface PositionJson {
  id: string;
  departmentId: string;
  reportsToPositionId: string | null;
}

interface ContractJson {
  id: string;
  contractType: string;
  endDate: string | null;
  departmentId: string | null;
  positionId: string | null;
  managerEmployeeId: string | null;
}

interface ProfileJson {
  id: string;
  baseSalaryIdr: string;
  fixedAllowances: Record<string, string>;
  effectiveFrom: string;
  effectiveTo: string | null;
  supersededBy: string | null;
}

describe("org structure, contracts, and expiry", { concurrency: 1 }, () => {
  let app: FastifyInstance;
  let appDb: TenantDatabase;
  let platform: pg.Client;
  let superuser: pg.Client;
  let companyA: Company;
  let companyB: Company;
  let workerId = "";
  let managerId = "";

  before(async () => {
    await applySchemas();
    appDb = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    platform = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM") });
    superuser = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await platform.connect();
    await superuser.connect();
    companyA = await seedCompany(superuser, "A");
    companyB = await seedCompany(superuser, "B");
    workerId = await insertEmployee(superuser, companyA, "W001", "Worker A");
    managerId = await insertEmployee(superuser, companyA, "M001", "Manager A");
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
          userAgent: "org-test",
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

  it("rejects a department write without employee.write", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: authHeaders(companyA, ["employee.read"]),
      payload: departmentBody(companyA, "OPS", null),
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(errorOf(response).code, "forbidden");
  });

  it("creates a department tree, blocks a cycle, and hides the other tenant", async () => {
    const beforeAudit = await auditCount(superuser, companyA.tenantId, "department.create");
    const parent = dataOf<DepartmentJson>(
      await app.inject({
        method: "POST",
        url: "/api/v1/departments",
        headers: authHeaders(companyA, ["employee.write"]),
        payload: departmentBody(companyA, "HQ", null),
      }),
    );
    assert.equal(parent.code, "HQ");
    assert.equal(await auditCount(superuser, companyA.tenantId, "department.create"), beforeAudit + 1);
    const childResponse = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: authHeaders(companyA, ["employee.write"]),
      payload: departmentBody(companyA, "FIN", parent.id),
    });
    assert.equal(childResponse.statusCode, 201, childResponse.body);
    const child = dataOf<DepartmentJson>(childResponse);
    assert.equal(child.parentDepartmentId, parent.id);

    const selfParent = await app.inject({
      method: "PATCH",
      url: `/api/v1/departments/${parent.id}`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { parentDepartmentId: parent.id },
    });
    assert.equal(selfParent.statusCode, 400, selfParent.body);
    assert.equal(errorOf(selfParent).fields?.some((field) => field.field === "parentDepartmentId"), true);

    const cycle = await app.inject({
      method: "PATCH",
      url: `/api/v1/departments/${parent.id}`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { parentDepartmentId: child.id },
    });
    assert.equal(cycle.statusCode, 400, cycle.body);

    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/v1/departments/${parent.id}`,
      headers: authHeaders(companyA, ["employee.write"]),
    });
    assert.equal(blocked.statusCode, 409, blocked.body);

    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/departments/${child.id}`,
      headers: authHeaders(companyB, ["employee.read"]),
    });
    assert.equal(hidden.statusCode, 404, hidden.body);

    const removedChild = await app.inject({
      method: "DELETE",
      url: `/api/v1/departments/${child.id}`,
      headers: authHeaders(companyA, ["employee.write"]),
    });
    assert.equal(removedChild.statusCode, 200, removedChild.body);
    const removedParent = await app.inject({
      method: "DELETE",
      url: `/api/v1/departments/${parent.id}`,
      headers: authHeaders(companyA, ["employee.write"]),
    });
    assert.equal(removedParent.statusCode, 200, removedParent.body);
  });

  it("links a contract to a department, position, and manager", async () => {
    const department = dataOf<DepartmentJson>(
      await app.inject({
        method: "POST",
        url: "/api/v1/departments",
        headers: authHeaders(companyA, ["employee.write"]),
        payload: departmentBody(companyA, "PLANT", null),
      }),
    );
    const lead = dataOf<PositionJson>(
      await app.inject({
        method: "POST",
        url: "/api/v1/positions",
        headers: authHeaders(companyA, ["employee.write"]),
        payload: { departmentId: department.id, title: "Plant lead", code: "LEAD", levelCode: "L3" },
      }),
    );
    const staff = dataOf<PositionJson>(
      await app.inject({
        method: "POST",
        url: "/api/v1/positions",
        headers: authHeaders(companyA, ["employee.write"]),
        payload: {
          departmentId: department.id,
          title: "Operator",
          code: "OPR",
          levelCode: "L1",
          reportsToPositionId: lead.id,
        },
      }),
    );
    assert.equal(staff.reportsToPositionId, lead.id);

    const missingEnd = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${workerId}/contracts`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { contractType: "PKWT", startDate: "2026-01-01" },
    });
    assert.equal(missingEnd.statusCode, 400, missingEnd.body);
    assert.equal(errorOf(missingEnd).fields?.some((field) => field.field === "endDate"), true);

    const permanent = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${workerId}/contracts`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { contractType: "PKWTT", startDate: "2026-01-01" },
    });
    assert.equal(permanent.statusCode, 201, permanent.body);
    assert.equal(dataOf<ContractJson>(permanent).endDate, null);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${workerId}/contracts`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: {
        contractType: "PKWT",
        startDate: "2026-02-01",
        endDate: "2028-01-01",
        departmentId: department.id,
        positionId: staff.id,
        managerEmployeeId: managerId,
        compensationPaid: false,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const contract = dataOf<ContractJson>(created);
    assert.equal(contract.departmentId, department.id);
    assert.equal(contract.positionId, staff.id);
    assert.equal(contract.managerEmployeeId, managerId);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${workerId}/contracts`,
      headers: authHeaders(companyA, ["employee.read"]),
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(dataOf<ContractJson[]>(listed).some((row) => row.id === contract.id), true);

    const placement = await superuser.query<{
      department_id: string;
      position_id: string;
      manager_employee_id: string;
    }>(
      `SELECT department_id::text AS department_id,
              position_id::text AS position_id,
              manager_employee_id::text AS manager_employee_id
       FROM hr_employees WHERE id = $1::uuid`,
      [workerId],
    );
    assert.equal(placement.rows[0]?.department_id, department.id);
    assert.equal(placement.rows[0]?.position_id, staff.id);
    assert.equal(placement.rows[0]?.manager_employee_id, managerId);
  });

  it("appends compensation and refuses an in-place salary change", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${workerId}/compensation-profiles`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: {
        baseSalaryIdr: "8000000",
        fixedAllowances: { meal: "500000" },
        bpjsFlags: { kesehatan: true, jht: true },
        effectiveFrom: "2026-01-01",
      },
    });
    assert.equal(first.statusCode, 201, first.body);
    const opened = dataOf<ProfileJson>(first);
    assert.equal(opened.baseSalaryIdr, "8000000");
    assert.equal(opened.effectiveTo, null);

    const tooEarly = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${workerId}/compensation-profiles`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: { baseSalaryIdr: "1", effectiveFrom: "2025-12-01" },
    });
    assert.equal(tooEarly.statusCode, 400, tooEarly.body);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${workerId}/compensation-profiles`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: {
        baseSalaryIdr: hugeSalary,
        fixedAllowances: { transport: "1.500.000" },
        effectiveFrom: "2026-06-01",
      },
    });
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(dataOf<ProfileJson>(second).baseSalaryIdr, hugeSalary);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${workerId}/compensation-profiles`,
      headers: authHeaders(companyA, ["employee.read"]),
    });
    const profiles = dataOf<ProfileJson[]>(listed);
    const closed = profiles.find((row) => row.id === opened.id);
    assert.ok(closed);
    assert.equal(closed.baseSalaryIdr, "8000000");
    assert.equal(closed.effectiveTo, "2026-05-31");
    assert.equal(closed.supersededBy, dataOf<ProfileJson>(second).id);

    const march = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${workerId}/compensation-profiles/effective?on=2026-03-01`,
      headers: authHeaders(companyA, ["employee.read"]),
    });
    assert.equal(dataOf<ProfileJson>(march).baseSalaryIdr, "8000000");
    const june = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${workerId}/compensation-profiles/effective?on=2026-06-01`,
      headers: authHeaders(companyA, ["employee.read"]),
    });
    const current = dataOf<ProfileJson>(june);
    assert.equal(current.baseSalaryIdr, hugeSalary);
    assert.equal(current.fixedAllowances.transport, "1500000");
    const beforePay = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${workerId}/compensation-profiles/effective?on=2025-12-31`,
      headers: authHeaders(companyA, ["employee.read"]),
    });
    assert.equal(beforePay.statusCode, 404, beforePay.body);

    const readOnly = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${workerId}/compensation-profiles`,
      headers: authHeaders(companyA, ["employee.read"]),
      payload: { baseSalaryIdr: "1", effectiveFrom: "2026-07-01" },
    });
    assert.equal(readOnly.statusCode, 403, readOnly.body);

    await assert.rejects(
      () =>
        appDb.withTenantContext(companyA.tenantId, async (tx) => {
          await tx.execute(sql`
            UPDATE hr_compensation_profiles
            SET base_salary_idr = 1
            WHERE id = ${current.id}::uuid
          `);
        }),
      (error: unknown) => errorText(error).includes("append-only") || errorCode(error) === "23514",
    );
    const still = await superuser.query<{ salary: string }>(
      "SELECT base_salary_idr::text AS salary FROM hr_compensation_profiles WHERE id = $1::uuid",
      [current.id],
    );
    assert.equal(still.rows[0]?.salary, hugeSalary);
  });

  it("emits 90, 60, and 30 day notices once on the same Jakarta day", async () => {
    const windows = [30, 60, 90] as const;
    for (const days of windows) {
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/employees/${workerId}/contracts`,
        headers: authHeaders(companyA, ["employee.write"]),
        payload: {
          contractType: "PKWT",
          status: "active",
          startDate: "2026-01-01",
          endDate: addIsoDays(noticeOn, days),
        },
      });
      assert.equal(created.statusCode, 201, created.body);
    }
    const decoy = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${workerId}/contracts`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: {
        contractType: "PKWT",
        startDate: "2026-01-01",
        endDate: addIsoDays(noticeOn, 45),
      },
    });
    assert.equal(decoy.statusCode, 201, decoy.body);
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/employees/${workerId}/contracts`,
      headers: authHeaders(companyA, ["employee.write"]),
      payload: {
        contractType: "PKWT",
        status: "cancelled",
        startDate: "2026-01-01",
        endDate: addIsoDays(noticeOn, 30),
      },
    });
    assert.equal(cancelled.statusCode, 201, cancelled.body);

    const before = await outboxWindows(superuser, companyA.tenantId);
    const first = await scanContractExpiry({
      appDb,
      queueUrl: requiredEnv(process.env, "DATABASE_URL_QUEUE"),
      now: frozen,
    });
    const afterFirst = await outboxWindows(superuser, companyA.tenantId);
    assert.equal(first.noticeOn, noticeOn);
    assert.equal(afterFirst.length - before.length, 3);
    assert.deepEqual(afterFirst.slice(before.length).sort(), ["30", "60", "90"]);
    const notices = await superuser.query(
      "SELECT id FROM hr_contract_expiry_notices WHERE tenant_id = $1::uuid",
      [companyA.tenantId],
    );
    assert.equal(notices.rowCount, 3);

    const second = await scanContractExpiry({
      appDb,
      queueUrl: requiredEnv(process.env, "DATABASE_URL_QUEUE"),
      now: frozen,
    });
    const afterSecond = await outboxWindows(superuser, companyA.tenantId);
    assert.equal(second.emitted, 0);
    assert.equal(afterSecond.length, afterFirst.length);
    const noticesAgain = await superuser.query(
      "SELECT id FROM hr_contract_expiry_notices WHERE tenant_id = $1::uuid",
      [companyA.tenantId],
    );
    assert.equal(noticesAgain.rowCount, 3);
  });

  it("denies platform_admin on the org tables", async () => {
    for (const table of [
      "hr_departments",
      "hr_positions",
      "hr_contracts",
      "hr_compensation_profiles",
      "hr_contract_expiry_notices",
    ]) {
      await assert.rejects(platform.query(`SELECT id FROM ${table}`), (error: unknown) => errorCode(error) === "42501");
    }
  });
});

async function applySchemas(): Promise<void> {
  const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
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
  const orgId = `org-hr-${label}-${tenantId}`;
  const legalEntityId = randomUUID();
  const branchId = randomUUID();
  const userId = randomUUID();
  const npwp = label === "A" ? "1000000000000201" : "1000000000000202";
  const nitku = label === "A" ? "1000000000000000000201" : "1000000000000000000202";
  await superuser.query(`INSERT INTO ba_organization (id, name, slug) VALUES ($1, $2, $1)`, [
    orgId,
    `Org HR ${label}`,
  ]);
  await superuser.query(
    `INSERT INTO id_tenants (id, organization_id, name, slug) VALUES ($1::uuid, $2, $3, $2)`,
    [tenantId, orgId, `Org HR ${label}`],
  );
  await superuser.query(
    `INSERT INTO id_legal_entities (id, tenant_id, company_name, npwp_16) VALUES ($1::uuid, $2::uuid, $3, $4)`,
    [legalEntityId, tenantId, `PT Org ${label}`, npwp],
  );
  await superuser.query(
    `INSERT INTO id_branches (id, tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'Asia/Jakarta', 5000000)`,
    [branchId, tenantId, legalEntityId, `HQ ${label}`, nitku],
  );
  return { tenantId, userId, orgId, legalEntityId, branchId };
}

async function insertEmployee(
  superuser: pg.Client,
  company: Company,
  code: string,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `INSERT INTO hr_employees (
       id, tenant_id, employee_code, full_name, legal_entity_id, branch_id,
       employment_status, join_date, ptkp_status, tax_method, pph21_subject_type
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid,
       'active', '2024-01-15', 'TK/0', 'gross', 'permanent'
     )`,
    [id, company.tenantId, code, name, company.legalEntityId, company.branchId],
  );
  return id;
}

async function cleanup(superuser: pg.Client, companies: Company[]): Promise<void> {
  const tenants = companies.map((company) => company.tenantId);
  const orgs = companies.map((company) => company.orgId);
  await superuser.query("DELETE FROM hr_contract_expiry_notices WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_compensation_profiles WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_contracts WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_outbox_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_tenant_keys WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_employees WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_positions WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_departments WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_branches WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_legal_entities WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_tenants WHERE id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM ba_organization WHERE id = ANY($1::text[])", [orgs]);
}

async function auditCount(superuser: pg.Client, tenantId: string, action: string): Promise<number> {
  const result = await superuser.query(
    "SELECT id FROM aud_events WHERE tenant_id = $1::uuid AND action = $2",
    [tenantId, action],
  );
  return result.rowCount ?? 0;
}

async function outboxWindows(superuser: pg.Client, tenantId: string): Promise<string[]> {
  const result = await superuser.query<{ window_days: string }>(
    `SELECT payload->>'windowDays' AS window_days
     FROM aud_outbox_events
     WHERE tenant_id = $1::uuid AND topic = 'core_hr.contract_expiring'
     ORDER BY created_at, id`,
    [tenantId],
  );
  return result.rows.map((row) => row.window_days);
}

function departmentBody(company: Company, code: string, parentDepartmentId: string | null): Record<string, unknown> {
  return {
    legalEntityId: company.legalEntityId,
    branchId: company.branchId,
    parentDepartmentId,
    name: `Department ${code}`,
    code,
  };
}

function authHeaders(company: Company, permissions: string[]): Record<string, string> {
  return {
    "x-test-tenant": company.tenantId,
    "x-test-user": company.userId,
    "x-test-permissions": permissions.join(","),
  };
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

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.message} ${"cause" in error ? errorText(error.cause) : ""}`;
  return "";
}
