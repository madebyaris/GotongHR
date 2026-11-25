import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { migrateAudit } from "@gotonghr/audit";
import { idr, type AttendancePayrollPort, type CoreHrPayrollPort, type EmployeePayrollProfileDTO, type StatutoryPayrollPort } from "@gotonghr/contracts";
import {
  applyDatabaseUrls,
  createTenantDatabase,
  loadRepoEnv,
  migrate,
  migrateEnvFrom,
  requiredEnv,
  type TenantDatabase,
} from "@gotonghr/db";
import {
  calculateBpjs,
  calculateMonthlyPph21,
  calculateOvertime,
  civilDate,
  parseStatutoryTable,
  rupiah,
} from "@gotonghr/payroll-engine";
import { createLocalStorage } from "@gotonghr/storage";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type LightMyRequestResponse } from "fastify";
import pg from "pg";
import { fail } from "@gotonghr/contracts";
import type { PayrollCaller } from "./caller.ts";
import { processPayrollCalculation, processPayrollPayslips } from "./jobs.ts";
import { migratePayroll } from "./migrate.ts";
import type { PayrollCalcMessage, PayrollPdfMessage, PayrollQueuePort, PayrollStoragePort } from "./ports.ts";
import { registerPayrollRoutes } from "./routes.ts";

loadRepoEnv();
applyDatabaseUrls(process.env);

const tenantA = randomUUID();
const tenantB = randomUUID();
const entityA = randomUUID();
const userPrepare = randomUUID();
const userOwner = randomUUID();
const userOwnerPlain = randomUUID();
const userEmployee = randomUUID();
const userOther = randomUUID();
const employeeIds = [randomUUID(), randomUUID(), randomUUID()] as const;
const tableId = randomUUID();
const replacementTableId = randomUUID();

const fixturePath = fileURLToPath(
  new URL("../../../payroll-engine/src/__tests__/fixtures/synthetic-pph21.json", import.meta.url),
);
const tablePayload: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
if (tablePayload && typeof tablePayload === "object" && "jp_annual_wage_cap" in tablePayload) {
  const cap = (tablePayload as { jp_annual_wage_cap?: { rupiah?: string } }).jp_annual_wage_cap;
  if (cap) cap.rupiah = "120000000";
}
const publishedTable = parseStatutoryTable(tablePayload);

const flags = {
  kesehatan: true,
  jht: true,
  jkk: true,
  jkm: true,
  jp: true,
  jkp: true,
} as const;

const people: EmployeePayrollProfileDTO[] = [
  profile(0, 5_000_000n, 500_000n, "gross", "TK/0", "3174011501900001", "1111111111", "1990-01-15"),
  profile(1, 8_000_000n, 0n, "nett", "K/0", "3174011501900002", "2222222222", "1992-03-20"),
  profile(2, 12_000_000n, 1_000_000n, "gross_up", "K/1", "3174011501900003", "4444444444", "1988-11-02"),
];

let attendanceLocked = false;
let statutoryId = tableId;
const overtimeMinutes = [60, 0, 90] as const;
const calcMessages: PayrollCalcMessage[] = [];
const pdfMessages: PayrollPdfMessage[] = [];

describe("payroll runs", { concurrency: 1 }, () => {
  let app: FastifyInstance | undefined;
  let appDb: TenantDatabase | undefined;
  let admin: pg.Client | undefined;
  let storageDir = "";

  before(async () => {
    const migrateEnv = migrateEnvFrom(process.env);
    await migrate(migrateEnv);
    await migrateAudit({ migratorUrl: migrateEnv.migratorUrl });
    await migratePayroll({ migratorUrl: migrateEnv.migratorUrl });
    appDb = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    admin = new pg.Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await admin.connect();
    storageDir = await mkdtemp(path.join(tmpdir(), "gotong-payroll-"));
    const local = createLocalStorage({
      rootDir: storageDir,
      secret: "payroll-test-secret-must-be-32ch",
      urlPrefix: "/api",
    });
    const storage: PayrollStoragePort = {
      put: (input) => local.put(input),
      presignGet: async (input) => local.presignGet(input),
    };
    const database = appDb;
    const queue: PayrollQueuePort = {
      async enqueueCalculation(messages) {
        calcMessages.push(...messages);
        for (const message of messages) await processPayrollCalculation({ appDb: database }, message);
      },
      async enqueuePayslips(messages) {
        pdfMessages.push(...messages);
        for (const message of messages) await processPayrollPayslips({ appDb: database, storage }, message);
      },
    };
    const actors = new Map<string, PayrollCaller>([
      ["preparer", caller(tenantA, userPrepare, ["payroll.run.prepare", "payroll.run.create"], null, false)],
      ["owner", caller(tenantA, userOwner, ["payroll.run.finalize", "payroll.coretax.export"], null, true)],
      ["owner-plain", caller(tenantA, userOwnerPlain, ["payroll.run.finalize"], null, false)],
      ["employee", caller(tenantA, userEmployee, [], employeeIds[0], false)],
      ["other", caller(tenantA, userOther, [], employeeIds[1], false)],
      ["other-tenant", caller(tenantB, userPrepare, ["payroll.run.prepare", "payroll.run.create"], null, false)],
    ]);
    app = Fastify({ logger: false });
    const pass = guard(actors);
    await registerPayrollRoutes(app, {
      appDb,
      coreHr: coreHrPort(),
      attendance: attendancePort(),
      statutory: statutoryPort(),
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
      const tenants = [tenantA, tenantB];
      await admin.query("ALTER TABLE pay_run_items DISABLE TRIGGER pay_run_items_immutable_trg").catch(() => undefined);
      await admin.query("DELETE FROM pay_exports WHERE tenant_id = ANY($1::uuid[])", [tenants]).catch(() => undefined);
      await admin.query("DELETE FROM pay_run_items WHERE tenant_id = ANY($1::uuid[])", [tenants]).catch(() => undefined);
      await admin.query("DELETE FROM pay_runs WHERE tenant_id = ANY($1::uuid[])", [tenants]).catch(() => undefined);
      await admin.query("ALTER TABLE pay_run_items ENABLE TRIGGER pay_run_items_immutable_trg").catch(() => undefined);
      await admin.query("DELETE FROM aud_events WHERE tenant_id = ANY($1::uuid[])", [tenants]).catch(() => undefined);
    }
    await app?.close();
    await appDb?.end();
    await admin?.end();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it("calculates, freezes, finalizes once, and serves the employee's payslip", async () => {
    attendanceLocked = false;
    const created = await send(app, "POST", "preparer", "/api/v1/payroll/runs", {
      legalEntityId: entityA,
      periodYearMonth: "2026-06",
    });
    const draft = readData<{ id: string; status: string }>(created, 201);
    assert.equal(draft.status, "draft");
    assert.equal(draft.id.split("-")[2]?.[0], "7");

    const unlocked = await send(app, "POST", "preparer", `/api/v1/payroll/runs/${draft.id}/preflight`);
    assert.equal(unlocked.statusCode, 422, unlocked.body);
    assert.equal(readCode(unlocked), "attendance_unlocked");

    attendanceLocked = true;
    const ready = await send(app, "POST", "preparer", `/api/v1/payroll/runs/${draft.id}/preflight`);
    assert.equal(readData<{ employeeCount: number }>(ready, 200).employeeCount, 3);

    const calculated = await send(app, "POST", "preparer", `/api/v1/payroll/runs/${draft.id}/calculate`);
    const afterCalc = readData<{ status: string; statutoryTableVersionId: string }>(calculated, 200);
    assert.equal(afterCalc.status, "calculated");
    assert.equal(afterCalc.statutoryTableVersionId, tableId);
    assert.equal(calcMessages.length, 1);
    assert.equal(calcMessages[0]?.employees.length, 3);

    const detail = readData<Detail>(await send(app, "GET", "preparer", `/api/v1/payroll/runs/${draft.id}`), 200);
    assert.equal(detail.items.length, 3);
    for (const item of detail.items) assertEngine(item);
    const frozen = JSON.stringify(detail.items.map(moneyOf));

    const firstPerson = people[0];
    assert.ok(firstPerson);
    people[0] = { ...firstPerson, baseSalaryIdr: idr(9_000_000n) };
    statutoryId = replacementTableId;
    const afterEdit = readData<Detail>(await send(app, "GET", "preparer", `/api/v1/payroll/runs/${draft.id}`), 200);
    assert.equal(JSON.stringify(afterEdit.items.map(moneyOf)), frozen);

    const approved = await send(app, "POST", "preparer", `/api/v1/payroll/runs/${draft.id}/approve`);
    assert.equal(readData<{ status: string }>(approved, 200).status, "approved");

    const denied = await send(app, "POST", "preparer", `/api/v1/payroll/runs/${draft.id}/finalize`);
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(readCode(denied), "forbidden");
    const noTotp = await send(app, "POST", "owner-plain", `/api/v1/payroll/runs/${draft.id}/finalize`);
    assert.equal(noTotp.statusCode, 403, noTotp.body);
    assert.equal(readCode(noTotp), "totp_verification_required");

    const finalized = await send(app, "POST", "owner", `/api/v1/payroll/runs/${draft.id}/finalize`);
    const done = readData<{ status: string; pdfBatchEnqueuedCount: number }>(finalized, 200);
    assert.equal(done.status, "finalized");
    assert.equal(done.pdfBatchEnqueuedCount, 1);
    assert.equal(pdfMessages.length, 1);

    const again = await send(app, "POST", "owner", `/api/v1/payroll/runs/${draft.id}/finalize`);
    assert.equal(again.statusCode, 409, again.body);
    assert.equal(pdfMessages.length, 1);

    const hidden = await send(app, "GET", "other-tenant", `/api/v1/payroll/runs/${draft.id}`);
    assert.equal(hidden.statusCode, 404, hidden.body);

    const ownItem = detail.items.find((item) => item.employeeId === employeeIds[0]);
    assert.ok(ownItem);
    const own = readData<{ url: string; expiresInSeconds: number }>(
      await send(app, "GET", "employee", `/api/v1/mobile/payslips/${ownItem.id}/download-url`),
      200,
    );
    assert.equal(own.expiresInSeconds, 120);
    const token = new URL(own.url, "http://localhost").searchParams.get("token");
    assert.ok(token);
    const payload = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as { exp: number };
    const now = Math.floor(Date.now() / 1000);
    assert.ok(payload.exp > now);
    assert.ok(payload.exp <= now + 120);

    const cross = await send(app, "GET", "other", `/api/v1/mobile/payslips/${ownItem.id}/download-url`);
    assert.equal(cross.statusCode, 403, cross.body);

    const coretax = await send(app, "POST", "preparer", `/api/v1/payroll/runs/${draft.id}/exports/coretax`);
    assert.equal(readData<{ kind: string }>(coretax, 201).kind, "coretax");
    const bank = await send(app, "POST", "preparer", `/api/v1/payroll/runs/${draft.id}/exports/bank-batch`, {
      bank: "bca-klikbisnis",
      debitAccountNumber: "3333333333",
    });
    assert.equal(readData<{ kind: string }>(bank, 201).kind, "bank_batch");

    if (!appDb) throw new Error("database did not start");
    await assert.rejects(
      appDb.withTenantContext(tenantA, (tx) =>
        tx.execute(sql`
          UPDATE pay_run_items
          SET gross_idr = gross_idr + 1
          WHERE run_id = ${draft.id}::uuid
        `),
      ),
      (error: unknown) => postgresCode(error) === "23514",
    );
  });
});

function assertEngine(item: Item): void {
  const index = employeeIds.indexOf(item.employeeId as (typeof employeeIds)[number]);
  const person = people[index];
  assert.ok(person);
  const base = person.baseSalaryIdr;
  const fixed = person.fixedAllowancesIdr;
  const minutes = overtimeMinutes[index] ?? 0;
  const overtime = calculateOvertime({ monthlyWage: base + fixed, minutes, dayKind: "workday" });
  const bpjs = calculateBpjs({
    wage: base + fixed,
    additionalFamilyMembers: 0,
    applyWageFloor: true,
    umpUmk: person.umpUmkIdr,
    jkkRiskClass: person.jkkRiskClass,
    jkpEligible: true,
    table: publishedTable,
  });
  const pph = calculateMonthlyPph21({
    payrollDate: civilDate(2026, 6, 30),
    periodMonth: 6,
    table: publishedTable,
    ptkpStatus: person.ptkpStatus,
    method: person.taxMethod,
    components: {
      baseSalary: rupiah(base),
      fixedAllowances: rupiah(fixed),
      overtime: overtime.pay,
      bonusOrThr: rupiah(0n),
      employerJkk: bpjs.jkk.employer,
      employerJkm: bpjs.jkm.employer,
      employerBpjsKesehatan: bpjs.kesehatan.employer,
    },
  });
  const earningAllowance = person.taxMethod === "gross_up" ? pph.taxAllowance : 0n;
  const gross = base + fixed + overtime.pay + earningAllowance;
  const net = gross - bpjs.employeePayable - pph.employeeWithheld;
  assert.equal(item.earnings.baseSalaryIdr, base.toString());
  assert.equal(item.earnings.fixedAllowancesIdr, fixed.toString());
  assert.equal(item.earnings.overtimeIdr, overtime.pay.toString());
  assert.equal(item.earnings.taxAllowanceIdr, earningAllowance.toString());
  assert.equal(item.bpjs.kesehatanEmployeeIdr, bpjs.kesehatan.employee.toString());
  assert.equal(item.bpjs.kesehatanEmployerIdr, bpjs.kesehatan.employer.toString());
  assert.equal(item.bpjs.jhtEmployeeIdr, bpjs.jht.employee.toString());
  assert.equal(item.bpjs.jhtEmployerIdr, bpjs.jht.employer.toString());
  assert.equal(item.bpjs.jkkEmployerIdr, bpjs.jkk.employer.toString());
  assert.equal(item.bpjs.jkmEmployerIdr, bpjs.jkm.employer.toString());
  assert.equal(item.bpjs.jpEmployeeIdr, bpjs.jp.employee.toString());
  assert.equal(item.bpjs.jpEmployerIdr, bpjs.jp.employer.toString());
  assert.equal(item.bpjs.jkpEmployerIdr, bpjs.jkp.fromJkk.toString());
  assert.equal(item.bpjs.employeePayableIdr, bpjs.employeePayable.toString());
  assert.equal(item.deductions.bpjsEmployeeIdr, bpjs.employeePayable.toString());
  assert.equal(item.deductions.pph21EmployeeIdr, pph.employeeWithheld.toString());
  assert.equal(item.pph21.method, pph.method);
  assert.equal(item.pph21.category, pph.category);
  assert.equal(item.pph21.grossTaxableIdr, pph.grossTaxable.toString());
  assert.equal(item.pph21.taxAllowanceIdr, pph.taxAllowance.toString());
  assert.equal(item.pph21.grossedTaxableIdr, pph.grossedTaxable.toString());
  assert.equal(item.pph21.taxIdr, pph.tax.toString());
  assert.equal(item.pph21.employeeWithheldIdr, pph.employeeWithheld.toString());
  assert.equal(item.pph21.employerBorneTaxIdr, pph.employerBorneTax.toString());
  assert.equal(item.grossIdr, gross.toString());
  assert.equal(item.taxIdr, pph.tax.toString());
  assert.equal(item.netIdr, net.toString());
}

function moneyOf(item: Item): unknown {
  return {
    earnings: item.earnings,
    deductions: item.deductions,
    bpjs: item.bpjs,
    pph21: item.pph21,
    grossIdr: item.grossIdr,
    taxIdr: item.taxIdr,
    netIdr: item.netIdr,
  };
}

interface Item {
  id: string;
  employeeId: string;
  earnings: {
    baseSalaryIdr: string;
    fixedAllowancesIdr: string;
    overtimeIdr: string;
    taxAllowanceIdr: string;
  };
  deductions: { bpjsEmployeeIdr: string; pph21EmployeeIdr: string };
  bpjs: {
    kesehatanEmployeeIdr: string;
    kesehatanEmployerIdr: string;
    jhtEmployeeIdr: string;
    jhtEmployerIdr: string;
    jkkEmployerIdr: string;
    jkmEmployerIdr: string;
    jpEmployeeIdr: string;
    jpEmployerIdr: string;
    jkpEmployerIdr: string;
    employeePayableIdr: string;
  };
  pph21: {
    method: string;
    category: string;
    grossTaxableIdr: string;
    taxAllowanceIdr: string;
    grossedTaxableIdr: string;
    taxIdr: string;
    employeeWithheldIdr: string;
    employerBorneTaxIdr: string;
  };
  grossIdr: string;
  taxIdr: string;
  netIdr: string;
}

interface Detail {
  items: Item[];
}

function profile(
  index: number,
  base: bigint,
  fixed: bigint,
  method: EmployeePayrollProfileDTO["taxMethod"],
  ptkp: EmployeePayrollProfileDTO["ptkpStatus"],
  nik: string,
  account: string,
  dateOfBirth: string,
): EmployeePayrollProfileDTO {
  const employeeId = employeeIds[index];
  if (!employeeId) throw new Error("missing employee");
  return {
    tenantId: tenantA,
    employeeId,
    legalEntityId: entityA,
    branchId: randomUUID(),
    userId: index === 0 ? userEmployee : null,
    employeeCode: `E${index}`,
    fullName: `Employee ${index}`,
    jobTitle: "Staff",
    dateOfBirth,
    ptkpStatus: ptkp,
    taxMethod: method,
    pph21SubjectType: "permanent",
    baseSalaryIdr: idr(base),
    fixedAllowancesIdr: idr(fixed),
    bpjsFlags: flags,
    nik,
    bankAccountNumber: account,
    nitku: "0102030405060708000001",
    companyName: "PT Contoh",
    companyNpwp: "0102030405060708",
    umpUmkIdr: idr(1_000_000n),
    jkkRiskClass: 1,
  };
}

function coreHrPort(): CoreHrPayrollPort {
  return {
    async getActivePayrollProfiles() {
      return people.map((person) => ({ ...person }));
    },
    async employeeIdForUser(input) {
      const match = people.find((person) => person.userId === input.userId);
      return match?.employeeId ?? null;
    },
  };
}

function attendancePort(): AttendancePayrollPort {
  return {
    async getLockedPeriodSummaries(input) {
      return people.map((person, index) => ({
        tenantId: input.tenantId,
        employeeId: person.employeeId,
        legalEntityId: input.legalEntityId,
        periodYear: input.periodYear,
        periodMonth: input.periodMonth,
        approvedOvertimeMinutes: overtimeMinutes[index] ?? 0,
        locked: attendanceLocked,
      }));
    },
    async attachPayrollRun() {
      return { attached: people.length };
    },
  };
}

function statutoryPort(): StatutoryPayrollPort {
  return {
    async getEffectiveTable() {
      return { id: statutoryId, payload: tablePayload };
    },
  };
}

function caller(
  tenantId: string,
  userId: string,
  permissions: string[],
  employeeId: string | null,
  sessionTotpVerified: boolean,
): PayrollCaller {
  return {
    tenantId,
    userId,
    role: "payroll_admin",
    permissions,
    employeeId,
    sessionTotpVerified,
    ipAddress: null,
    userAgent: null,
  };
}

function guard(actors: Map<string, PayrollCaller>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const name = request.headers["x-test-actor"];
    if (typeof name !== "string" || !actors.has(name)) {
      await reply.code(401).send(fail("unauthenticated", "Sign in required."));
    }
  };
}

function send(
  app: FastifyInstance | undefined,
  method: "GET" | "POST",
  actor: string,
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  if (!app) return Promise.reject(new Error("server did not start"));
  return app.inject({
    method,
    url,
    headers: { "x-test-actor": actor, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

function readData<T>(response: { statusCode: number; body: string }, status: number): T {
  assert.equal(response.statusCode, status, response.body);
  return (JSON.parse(response.body) as { data: T }).data;
}

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
    if ("code" in current && current.code === "23514") return "23514";
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function readCode(response: { body: string }): string | undefined {
  return (JSON.parse(response.body) as { error: { code?: string } | null }).error?.code;
}
