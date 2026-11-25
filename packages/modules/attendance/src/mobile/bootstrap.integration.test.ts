import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  applyDatabaseUrls,
  createTenantDatabase,
  loadRepoEnv,
  requiredEnv,
  type TenantDatabase,
} from "@gotonghr/db";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { registerMobileRoutes } from "./routes.ts";
import { BOOTSTRAP_DAY_COUNT, BOOTSTRAP_MAX_BYTES, type BootstrapPayload } from "./types.ts";

const execFileAsync = promisify(execFile);
const { Client } = pg;

loadRepoEnv();
applyDatabaseUrls(process.env);

const NOW = new Date("2026-11-25T02:00:00.000Z");

interface Company {
  tenantId: string;
  orgId: string;
  legalEntityId: string;
  branchId: string;
  employeeId: string;
  userId: string;
  name: string;
}

describe("mobile bootstrap", { concurrency: 1 }, () => {
  let app: FastifyInstance;
  let appDb: TenantDatabase;
  let superuser: pg.Client;
  let companyA: Company;
  let companyB: Company;

  before(async () => {
    await applySchemas();
    appDb = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    superuser = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await superuser.connect();
    companyA = await seedCompany(superuser, "A", "Sari Wulandari");
    companyB = await seedCompany(superuser, "B", "Budi Santoso");
    await seedFixture(superuser, companyA);
    app = Fastify({ logger: false });
    await registerMobileRoutes(app, {
      database: appDb,
      guard: async () => {},
      readCaller(request) {
        const header = request.headers["x-test-tenant"];
        const tenantId = Array.isArray(header) ? header[0] : header;
        const userHeader = request.headers["x-test-user"];
        const userId = Array.isArray(userHeader) ? userHeader[0] : userHeader;
        if (tenantId === companyA.tenantId) {
          return { tenantId: companyA.tenantId, userId: userId || companyA.userId };
        }
        if (tenantId === companyB.tenantId) return { tenantId: companyB.tenantId, userId: companyB.userId };
        return null;
      },
      now: () => NOW,
    });
  });

  after(async () => {
    if (superuser && companyA && companyB) {
      await cleanup(superuser, [companyA, companyB]).catch(() => undefined);
    }
    await app?.close();
    await appDb?.end();
    await superuser?.end();
  });

  it("returns a flat document under 5 KB and a stable etag", async () => {
    const first = await getBootstrap(app, companyA.tenantId);
    assert.equal(first.statusCode, 200, first.body);
    const bytes = Buffer.byteLength(first.body);
    console.log(`bootstrap bytes ${bytes}`);
    assert.equal(bytes < BOOTSTRAP_MAX_BYTES, true, `bootstrap is ${bytes} bytes`);
    const etag = first.headers.etag;
    assert.equal(typeof etag, "string");
    assert.equal(String(etag).startsWith('"'), true);
    const payload = readPayload(first.body);
    assert.equal(payload.employee.name, "Sari Wulandari");
    assert.equal(payload.employee.code, "ESS01");
    assert.equal(payload.branch.name, "Jakarta Pusat");
    assert.equal(payload.branch.lat, -6.175392);
    assert.equal(payload.branch.radiusM, 120);
    assert.equal(payload.shift?.code, "PAGI");
    assert.equal(payload.shift?.start, "08:00");
    assert.equal(payload.shift?.end, "17:00");
    assert.equal(payload.days.length, BOOTSTRAP_DAY_COUNT);
    assert.equal(payload.days[0]?.date, "2026-11-25");
    assert.equal(payload.days[13]?.date, "2026-12-08");
    assert.equal(payload.days.every((day) => day.code === "PAGI"), true);
    assert.equal(payload.leaveTypes.length, 9);
    assert.equal(payload.leaveTypes.some((type) => type.code === "cuti_tahunan" && type.name === "Cuti Tahunan"), true);
    assert.deepEqual(payload.balances, [{ code: "cuti_tahunan", year: 2026, entitled: 12, used: 1 }]);
    assert.equal(payload.punches.length, 1);
    assert.equal(payload.punches[0]?.type, "clock_in");
    assert.equal(JSON.stringify(payload).includes('"nik"'), false);

    const again = await getBootstrap(app, companyA.tenantId);
    assert.equal(again.headers.etag, etag);
    const weak = await getBootstrap(app, companyA.tenantId, `W/${etag}`);
    assert.equal(weak.statusCode, 304, weak.body);
    assert.equal(weak.body, "");
    assert.equal(weak.headers.etag, etag);
    const strong = await getBootstrap(app, companyA.tenantId, String(etag));
    assert.equal(strong.statusCode, 304);
    assert.equal(strong.body, "");
    const miss = await getBootstrap(app, companyA.tenantId, '"missing"');
    assert.equal(miss.statusCode, 200);
    assert.equal(miss.headers.etag, etag);
  });

  it("hides another tenant and rejects a sign-in with no employee", async () => {
    const other = await getBootstrap(app, companyB.tenantId);
    assert.equal(other.statusCode, 200, other.body);
    const payload = readPayload(other.body);
    assert.equal(payload.employee.name, "Budi Santoso");
    assert.equal(payload.punches.length, 0);
    assert.equal(payload.shift, null);
    const stranger = await app.inject({
      method: "GET",
      url: "/api/v1/mobile/bootstrap",
      headers: { "x-test-tenant": companyA.tenantId, "x-test-user": randomUUID() },
    });
    assert.equal(stranger.statusCode, 404, stranger.body);
    assert.equal(codeOf(stranger.body), "no_employee");
    const signedOut = await app.inject({ method: "GET", url: "/api/v1/mobile/bootstrap" });
    assert.equal(signedOut.statusCode, 401);
    assert.equal(codeOf(signedOut.body), "unauthenticated");
  });
});

async function applySchemas(): Promise<void> {
  const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
  const source = `
    import { migrate, migrateEnvFrom, loadRepoEnv, applyDatabaseUrls } from ${JSON.stringify(`${repo}/packages/db/dist/index.js`)};
    import { migrateIdentity } from ${JSON.stringify(`${repo}/packages/modules/identity/dist/migrate.js`)};
    import { migrateCoreHr } from ${JSON.stringify(`${repo}/packages/modules/core-hr/dist/migrate.js`)};
    import { migrateAttendance } from ${JSON.stringify(`${repo}/packages/modules/attendance/dist/schedules/migrate.js`)};
    import { migrateClock } from ${JSON.stringify(`${repo}/packages/modules/attendance/dist/clock/migrate.js`)};
    import { migrateMobile } from ${JSON.stringify(`${repo}/packages/modules/attendance/dist/mobile/migrate.js`)};
    loadRepoEnv();
    applyDatabaseUrls(process.env);
    const env = migrateEnvFrom(process.env);
    await migrate(env);
    await migrateIdentity({ superuserUrl: env.superuserUrl, migratorUrl: env.migratorUrl });
    await migrateCoreHr({ migratorUrl: env.migratorUrl });
    await migrateAttendance({ migratorUrl: env.migratorUrl });
    await migrateClock({ migratorUrl: env.migratorUrl });
    await migrateMobile({ migratorUrl: env.migratorUrl });
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: repo,
    env: process.env,
  });
}

async function seedCompany(superuser: pg.Client, label: string, name: string): Promise<Company> {
  const tenantId = randomUUID();
  const orgId = `ess-${label}-${tenantId}`;
  const legalEntityId = randomUUID();
  const branchId = randomUUID();
  const employeeId = randomUUID();
  const userId = randomUUID();
  const npwp = label === "A" ? "1000000000000301" : "1000000000000302";
  const nitku = label === "A" ? "1000000000000000000301" : "1000000000000000000302";
  await superuser.query(`INSERT INTO ba_organization (id, name, slug) VALUES ($1, $2, $1)`, [
    orgId,
    `ESS ${label}`,
  ]);
  await superuser.query(
    `INSERT INTO id_tenants (id, organization_id, name, slug) VALUES ($1::uuid, $2, $3, $2)`,
    [tenantId, orgId, `ESS ${label}`],
  );
  await superuser.query(
    `INSERT INTO id_legal_entities (id, tenant_id, company_name, npwp_16) VALUES ($1::uuid, $2::uuid, $3, $4)`,
    [legalEntityId, tenantId, `PT ESS ${label}`, npwp],
  );
  await superuser.query(
    `INSERT INTO id_branches (
       id, tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr,
       geofence_lat, geofence_lng, geofence_radius_m
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'Jakarta Pusat', $4, 'Asia/Jakarta', 5396761,
       -6.175392, 106.827153, 120
     )`,
    [branchId, tenantId, legalEntityId, nitku],
  );
  await superuser.query(
    `INSERT INTO id_users (id, tenant_id, auth_user_id, email, display_name)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
    [userId, tenantId, randomUUID(), `ess-${label}@example.com`, name],
  );
  await superuser.query(
    `INSERT INTO hr_employees (
       id, tenant_id, employee_code, full_name, legal_entity_id, branch_id,
       employment_status, join_date, ptkp_status, tax_method, pph21_subject_type, user_id
     ) VALUES (
       $1::uuid, $2::uuid, 'ESS01', $3, $4::uuid, $5::uuid,
       'active', '2024-01-15', 'TK/0', 'gross', 'permanent', $6::uuid
     )`,
    [employeeId, tenantId, name, legalEntityId, branchId, userId],
  );
  return { tenantId, orgId, legalEntityId, branchId, employeeId, userId, name };
}

async function seedFixture(superuser: pg.Client, company: Company): Promise<void> {
  const shift = await superuser.query<{ id: string }>(
    `INSERT INTO att_shifts (
       tenant_id, code, name, start_local_time, end_local_time, grace_minutes, workweek_type, is_overnight
     ) VALUES ($1::uuid, 'PAGI', 'Pagi', '08:00', '17:00', 10, '5_day', false)
     RETURNING id::text AS id`,
    [company.tenantId],
  );
  const shiftId = shift.rows[0]?.id;
  assert.ok(shiftId);
  for (let offset = 0; offset < BOOTSTRAP_DAY_COUNT; offset += 1) {
    const date = addDays("2026-11-25", offset);
    await superuser.query(
      `INSERT INTO att_rosters (tenant_id, employee_id, shift_id, work_date)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date)`,
      [company.tenantId, company.employeeId, shiftId, date],
    );
  }
  const leave = await superuser.query<{ id: string }>(
    `INSERT INTO att_leave_types (
       tenant_id, code, name, tenure_months, entitlement_days, deducts_annual, deduction_toggle
     ) VALUES ($1::uuid, 'cuti_tahunan', 'Cuti Tahunan', 12, 12, false, false)
     RETURNING id::text AS id`,
    [company.tenantId],
  );
  const leaveTypeId = leave.rows[0]?.id;
  assert.ok(leaveTypeId);
  await superuser.query(
    `INSERT INTO att_leave_balances (
       tenant_id, employee_id, leave_type_id, balance_year, entitled_days, used_days
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 2026, 12, 1)`,
    [company.tenantId, company.employeeId, leaveTypeId],
  );
  await superuser.query(
    `INSERT INTO att_clock_events (
       tenant_id, employee_id, branch_id, idempotency_key, punch_type,
       captured_at, received_at, clock_drift_seconds, sync_source,
       lat, lng, accuracy_meters, distance_meters, geofence_ok,
       liveness_ok, mock_location_flag, review_status
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'clock_in',
       '2026-11-25T01:05:00.000Z', '2026-11-25T01:05:02.000Z', 2, 'online',
       -6.175392, 106.827153, 12, 0, true,
       true, false, 'ok'
     )`,
    [company.tenantId, company.employeeId, company.branchId, randomUUID()],
  );
}

async function cleanup(superuser: pg.Client, companies: Company[]): Promise<void> {
  const tenants = companies.map((company) => company.tenantId);
  const orgs = companies.map((company) => company.orgId);
  await superuser.query("DELETE FROM att_clock_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM att_leave_balances WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM att_rosters WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM att_shifts WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM att_leave_types WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_employees WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_users WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_branches WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_legal_entities WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_tenants WHERE id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM ba_organization WHERE id = ANY($1::text[])", [orgs]);
}

function getBootstrap(app: FastifyInstance, tenantId: string, ifNoneMatch?: string) {
  return app.inject({
    method: "GET",
    url: "/api/v1/mobile/bootstrap",
    headers: {
      "x-test-tenant": tenantId,
      ...(ifNoneMatch ? { "if-none-match": ifNoneMatch } : {}),
    },
  });
}

function readPayload(body: string): BootstrapPayload {
  return (JSON.parse(body) as { data: BootstrapPayload }).data;
}

function codeOf(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code;
}

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year ?? 2026, (month ?? 1) - 1, (day ?? 1) + days));
  return utc.toISOString().slice(0, 10);
}
