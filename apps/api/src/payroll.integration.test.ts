import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { migrateAttendance } from "@gotonghr/attendance";
import { migrateAudit, provisionTenantKeys, readTenantSecrets } from "@gotonghr/audit";
import { appendCompensation, migrateCoreHr } from "@gotonghr/core-hr";
import { idr, fail, type BpjsFlags } from "@gotonghr/contracts";
import { blindIndex, encryptField, maskBankAccount, maskNik } from "@gotonghr/crypto";
import {
  applyDatabaseUrls,
  createTenantDatabase,
  loadRepoEnv,
  migrate,
  migrateEnvFrom,
  requiredEnv,
  type TenantDatabase,
} from "@gotonghr/db";
import { migrateIdentity } from "@gotonghr/identity";
import {
  migratePayroll,
  processPayrollCalculation,
  processPayrollPayslips,
  registerPayrollRoutes,
  type PayrollCaller,
  type PayrollQueuePort,
  type PayrollStoragePort,
} from "@gotonghr/payroll";
import { migratePlatform } from "@gotonghr/platform";
import { createLocalStorage } from "@gotonghr/storage";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type LightMyRequestResponse } from "fastify";
import pg from "pg";
import { createPayrollAdapters } from "./payroll-adapters.ts";

loadRepoEnv();
applyDatabaseUrls(process.env);
process.env.GOTONG_PII_KEK = "7a".repeat(32);
process.env.AUDIT_HASH_CHAIN = "on";

const flags: BpjsFlags = {
  kesehatan: true,
  jht: true,
  jkk: true,
  jkm: true,
  jp: true,
  jkp: true,
};

describe("payroll adapters keep a calculated line", { concurrency: 1 }, () => {
  const tenantId = randomUUID();
  const orgId = `payroll-${tenantId}`;
  const entityId = randomUUID();
  const branchId = randomUUID();
  const employeeId = randomUUID();
  const userId = randomUUID();
  const operatorId = randomUUID();
  const tableId = randomUUID();
  const laterTableId = randomUUID();
  let app: FastifyInstance | undefined;
  let appDb: TenantDatabase | undefined;
  let admin: pg.Client | undefined;
  let storageDir = "";

  before(async () => {
    const migrateEnv = migrateEnvFrom(process.env);
    await migrate(migrateEnv);
    await migrateIdentity({ superuserUrl: migrateEnv.superuserUrl, migratorUrl: migrateEnv.migratorUrl });
    await migratePlatform({ superuserUrl: migrateEnv.superuserUrl, migratorUrl: migrateEnv.migratorUrl });
    await migrateAudit({ migratorUrl: migrateEnv.migratorUrl });
    await migrateCoreHr({ migratorUrl: migrateEnv.migratorUrl });
    await migrateAttendance({ migratorUrl: migrateEnv.migratorUrl });
    await migratePayroll({ migratorUrl: migrateEnv.migratorUrl });
    appDb = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    admin = new pg.Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await admin.connect();
    const payload = statutoryPayload();
    await admin.query(`INSERT INTO ba_organization (id, name, slug) VALUES ($1, 'Payroll', $1)`, [orgId]);
    await admin.query(
      `INSERT INTO id_tenants (id, organization_id, name, slug) VALUES ($1::uuid, $2, 'Payroll', $2)`,
      [tenantId, orgId],
    );
    await admin.query(
      `INSERT INTO id_legal_entities (id, tenant_id, company_name, npwp_16, jkk_risk_class)
       VALUES ($1::uuid, $2::uuid, 'PT Contoh', '0102030405060708', 1)`,
      [entityId, tenantId],
    );
    await admin.query(
      `INSERT INTO id_branches (id, tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'HQ', '0102030405060708000001', 'Asia/Jakarta', 1000000)`,
      [branchId, tenantId, entityId],
    );
    await admin.query(
      `INSERT INTO hr_employees (
         id, tenant_id, employee_code, full_name, legal_entity_id, branch_id,
         employment_status, join_date, ptkp_status, tax_method, pph21_subject_type,
         user_id, date_of_birth
       ) VALUES (
         $1::uuid, $2::uuid, 'E1', 'Sari Wulandari', $3::uuid, $4::uuid,
         'active', '2024-01-01', 'TK/0', 'gross', 'permanent', $5::uuid, '1990-01-15'
       )`,
      [employeeId, tenantId, entityId, branchId, userId],
    );
    await seedPii(appDb, tenantId, employeeId);
    await admin.query(
      `INSERT INTO hr_compensation_profiles (
         id, tenant_id, employee_id, base_salary_idr, fixed_allowances_json, bpjs_flags_json, effective_from
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 5000000, '{"transport":"500000"}'::jsonb, $4::jsonb, '2024-01-01')`,
      [randomUUID(), tenantId, employeeId, JSON.stringify(flags)],
    );
    await admin.query(
      `INSERT INTO att_daily_summaries (
         id, tenant_id, employee_id, work_date, approved_overtime_minutes, is_locked, locked_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-06-15', 60, true, now())`,
      [randomUUID(), tenantId, employeeId],
    );
    await admin.query(
      `INSERT INTO sys_platform_operators (id, auth_user_id, role) VALUES ($1::uuid, $2, 'platform_ops')`,
      [operatorId, `op-${operatorId}`],
    );
    await admin.query(
      `INSERT INTO pay_statutory_tables (
         id, rule_type, version_label, effective_from, effective_to, status, payload_json,
         created_by_operator_id, published_by_operator_id, published_at
       ) VALUES (
         $1::uuid, 'pph21', 'synthetic-2026', '2026-01-01', '2026-12-31', 'published', $2::jsonb,
         $3::uuid, $3::uuid, now()
       )`,
      [tableId, JSON.stringify(payload), operatorId],
    );
    storageDir = await mkdtemp(path.join(tmpdir(), "gotong-payroll-api-"));
    const local = createLocalStorage({
      rootDir: storageDir,
      secret: "payroll-api-test-secret-32-chars",
      urlPrefix: "/api",
    });
    const storage: PayrollStoragePort = {
      put: (input) => local.put(input),
      presignGet: async (input) => local.presignGet(input),
    };
    const database = appDb;
    const queue: PayrollQueuePort = {
      async enqueueCalculation(messages) {
        for (const message of messages) await processPayrollCalculation({ appDb: database }, message);
      },
      async enqueuePayslips(messages) {
        for (const message of messages) await processPayrollPayslips({ appDb: database, storage }, message);
      },
    };
    const actors = new Map<string, PayrollCaller>([
      ["preparer", caller(tenantId, userId)],
    ]);
    app = Fastify({ logger: false });
    const pass = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const name = request.headers["x-test-actor"];
      if (typeof name !== "string" || !actors.has(name)) {
        await reply.code(401).send(fail("unauthenticated", "Sign in required."));
      }
    };
    await registerPayrollRoutes(app, {
      appDb,
      ...createPayrollAdapters(appDb),
      queue,
      storage,
      prepareGuard: pass,
      createGuard: pass,
      finalizeGuard: pass,
      exportGuard: pass,
      memberGuard: pass,
      readCaller(request) {
        const name = request.headers["x-test-actor"];
        return typeof name === "string" ? actors.get(name) ?? null : null;
      },
    });
  });

  after(async () => {
    if (admin) {
      await admin.query("ALTER TABLE pay_run_items DISABLE TRIGGER pay_run_items_immutable_trg").catch(() => undefined);
      await admin.query("ALTER TABLE pay_statutory_tables DISABLE TRIGGER pay_statutory_tables_guard_trg").catch(() => undefined);
      await admin.query("DELETE FROM pay_exports WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM pay_run_items WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM pay_runs WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM pay_statutory_tables WHERE id = ANY($1::uuid[])", [[tableId, laterTableId]]).catch(() => undefined);
      await admin.query("DELETE FROM att_daily_summaries WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM aud_events WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM aud_tenant_keys WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM hr_compensation_profiles WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM hr_employee_pii WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM hr_employees WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM id_branches WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM id_legal_entities WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM id_tenants WHERE id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM ba_organization WHERE id = $1", [orgId]).catch(() => undefined);
      await admin.query("DELETE FROM sys_platform_operators WHERE id = $1::uuid", [operatorId]).catch(() => undefined);
      await admin.query("ALTER TABLE pay_run_items ENABLE TRIGGER pay_run_items_immutable_trg").catch(() => undefined);
      await admin.query("ALTER TABLE pay_statutory_tables ENABLE TRIGGER pay_statutory_tables_guard_trg").catch(() => undefined);
    }
    await app?.close();
    await appDb?.end();
    await admin?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it("keeps pay_run_items when pay or the statutory table changes", async () => {
    if (!app || !appDb || !admin) throw new Error("payroll api test did not start");
    const created = await send(app, "POST", "/api/v1/payroll/runs", {
      legalEntityId: entityId,
      periodYearMonth: "2026-06",
    });
    const draft = readData<{ id: string }>(created, 201);
    const calculated = await send(app, "POST", `/api/v1/payroll/runs/${draft.id}/calculate`);
    const run = readData<{ status: string; statutoryTableVersionId: string }>(calculated, 200);
    assert.equal(run.status, "calculated");
    assert.equal(run.statutoryTableVersionId, tableId);
    const before = readData<{ items: Array<{ earnings: { baseSalaryIdr: string }; grossIdr: string }> }>(
      await send(app, "GET", `/api/v1/payroll/runs/${draft.id}`),
      200,
    );
    assert.equal(before.items[0]?.earnings.baseSalaryIdr, "5000000");
    const frozen = JSON.stringify(before.items);

    await appendCompensation(
      appDb,
      {
        tenantId,
        userId,
        role: "hr_admin",
        permissions: ["employee.read", "employee.write"],
        scopeEntityIds: [],
        scopeBranchIds: [],
        directReportsOnly: false,
        selfOnly: false,
        ipAddress: null,
        userAgent: null,
      },
      employeeId,
      {
        baseSalaryIdr: 9_000_000n,
        fixedAllowances: { transport: 500_000n },
        bpjsFlags: flags,
        effectiveFrom: "2026-06-01",
      },
    );
    const later = statutoryPayload();
    later.effective_from = "2027-01-01";
    later.effective_to = "2027-12-31";
    await admin.query(
      `INSERT INTO pay_statutory_tables (
         id, rule_type, version_label, effective_from, effective_to, status, payload_json,
         created_by_operator_id, published_by_operator_id, published_at
       ) VALUES (
         $1::uuid, 'pph21', 'synthetic-2027', '2027-01-01', '2027-12-31', 'published', $2::jsonb,
         $3::uuid, $3::uuid, now()
       )`,
      [laterTableId, JSON.stringify(later), operatorId],
    );

    const after = readData<{ items: unknown[]; statutoryTableVersionId?: string }>(
      await send(app, "GET", `/api/v1/payroll/runs/${draft.id}`),
      200,
    );
    assert.equal(JSON.stringify(after.items), frozen);
    const profiles = await createPayrollAdapters(appDb).coreHr.getActivePayrollProfiles({
      tenantId,
      legalEntityId: entityId,
      periodYear: 2026,
      periodMonth: 6,
    });
    assert.equal(profiles[0]?.baseSalaryIdr, idr(9_000_000n));
    assert.equal(before.items[0]?.grossIdr, afterGross(after.items));
  });
});

function afterGross(items: unknown[]): string {
  const first = items[0];
  if (!first || typeof first !== "object" || !("grossIdr" in first)) return "";
  return String(first.grossIdr);
}

const employeeNik = "3174011501900001";
const employeeBank = "1111111111";

async function seedPii(appDb: TenantDatabase, tenantId: string, employeeId: string): Promise<void> {
  await appDb.withTenantContext(tenantId, async (tx) => {
    await provisionTenantKeys(tx, tenantId);
    const secrets = await readTenantSecrets(tx, tenantId);
    const nikEnc = encryptField(secrets.dek, tenantId, "nik", employeeNik);
    const bankEnc = encryptField(secrets.dek, tenantId, "bank_account_number", employeeBank);
    await tx.execute(sql`
      INSERT INTO hr_employee_pii (
        id, tenant_id, employee_id, nik_enc, bank_account_number_enc, nik_hash, nik_mask, bank_account_number_mask
      ) VALUES (
        ${randomUUID()}::uuid, ${tenantId}::uuid, ${employeeId}::uuid, ${nikEnc}, ${bankEnc},
        ${blindIndex(secrets.pepper, employeeNik)}, ${maskNik(employeeNik)}, ${maskBankAccount(employeeBank)}
      )
    `);
  });
}

function statutoryPayload(): {
  effective_from: string;
  effective_to: string;
  jp_annual_wage_cap?: { rupiah?: string };
} & Record<string, unknown> {
  const fixture = fileURLToPath(
    new URL("../../../packages/payroll-engine/src/__tests__/fixtures/synthetic-pph21.json", import.meta.url),
  );
  const payload = JSON.parse(readFileSync(fixture, "utf8")) as {
    effective_from: string;
    effective_to: string;
    jp_annual_wage_cap?: { rupiah?: string };
  };
  if (payload.jp_annual_wage_cap) payload.jp_annual_wage_cap.rupiah = "120000000";
  return payload;
}

function caller(tenantId: string, userId: string): PayrollCaller {
  return {
    tenantId,
    userId,
    role: "payroll_admin",
    permissions: ["payroll.run.prepare", "payroll.run.create"],
    employeeId: null,
    sessionTotpVerified: true,
    ipAddress: null,
    userAgent: null,
  };
}

function send(app: FastifyInstance, method: "GET" | "POST", url: string, body?: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { "x-test-actor": "preparer", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

function readData<T>(response: { statusCode: number; body: string }, status: number): T {
  assert.equal(response.statusCode, status, response.body);
  return (JSON.parse(response.body) as { data: T }).data;
}
