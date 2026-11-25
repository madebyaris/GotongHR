import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type ChildProcess, spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { migrateAi } from "@gotonghr/ai";
import { migrateAnomalies, migrateAttendance, migrateClock, migrateMobile } from "@gotonghr/attendance";
import { migrateAudit, provisionTenantKeys, readTenantSecrets } from "@gotonghr/audit";
import { roleCodes, rolePermissions, type BpjsFlags } from "@gotonghr/contracts";
import { migrateCoreHr } from "@gotonghr/core-hr";
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
import { createAuth, grantMembership, migrateIdentity } from "@gotonghr/identity";
import { migratePayroll } from "@gotonghr/payroll";
import { migratePlatform } from "@gotonghr/platform";
import { sql } from "drizzle-orm";
import pg from "pg";
import { portPaths } from "./ports/http.ts";
import { provisionQueue } from "./queue.ts";

loadRepoEnv();
applyDatabaseUrls(process.env);
process.env.GOTONG_PII_KEK = "7a".repeat(32);
process.env.AUDIT_HASH_CHAIN = "on";

const SECRET = "slice62-internal-secret-0123456789";
const AUTH_ORIGIN = "http://127.0.0.1:4011";
const ATTENDANCE_PORT = 4011;
const WORKER_PORT = 4012;
const AI_PORT = 4013;
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const flags: BpjsFlags = {
  kesehatan: true,
  jht: true,
  jkk: true,
  jkm: true,
  jp: true,
  jkp: true,
};

describe("role entrypoints over HTTP ports", { concurrency: 1, timeout: 180_000 }, () => {
  const orgId = randomUUID();
  const tenantId = randomUUID();
  const entityId = randomUUID();
  const branchId = randomUUID();
  const employeeId = randomUUID();
  const operatorId = randomUUID();
  const tableId = randomUUID();
  const email = `slice62-${tenantId.slice(0, 8)}@gotonghr.test`;
  const password = "Slice62-password";
  const children: ChildProcess[] = [];
  let admin: pg.Client | undefined;
  let authUserId = "";

  before(async () => {
    const migrateEnv = migrateEnvFrom(process.env);
    await migrate(migrateEnv);
    await migrateIdentity({ superuserUrl: migrateEnv.superuserUrl, migratorUrl: migrateEnv.migratorUrl });
    await migratePlatform({ superuserUrl: migrateEnv.superuserUrl, migratorUrl: migrateEnv.migratorUrl });
    await migrateAudit({ migratorUrl: migrateEnv.migratorUrl });
    await migrateCoreHr({ migratorUrl: migrateEnv.migratorUrl });
    await migrateAttendance({ migratorUrl: migrateEnv.migratorUrl });
    await migrateClock({ migratorUrl: migrateEnv.migratorUrl });
    await migrateMobile({ migratorUrl: migrateEnv.migratorUrl });
    await migrateAnomalies({ migratorUrl: migrateEnv.migratorUrl });
    await migratePayroll({ migratorUrl: migrateEnv.migratorUrl });
    await migrateAi({ migratorUrl: migrateEnv.migratorUrl, superuserUrl: migrateEnv.superuserUrl });
    await provisionQueue(requiredEnv(process.env, "DATABASE_URL_MIGRATOR"));

    admin = new pg.Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await admin.connect();
    const payload = statutoryPayload();
    await admin.query(`INSERT INTO ba_organization (id, name, slug) VALUES ($1, 'Slice 62', $1)`, [orgId]);
    await admin.query(
      `INSERT INTO id_tenants (id, organization_id, name, slug) VALUES ($1::uuid, $2, 'Slice 62', $2)`,
      [tenantId, orgId],
    );
    for (const code of roleCodes) {
      await admin.query(
        `INSERT INTO id_roles (tenant_id, code, permissions) VALUES ($1::uuid, $2, $3::text[])`,
        [tenantId, code, [...rolePermissions[code]]],
      );
    }
    await admin.query(
      `INSERT INTO id_legal_entities (id, tenant_id, company_name, npwp_16, jkk_risk_class)
       VALUES ($1::uuid, $2::uuid, 'PT Slice', '3201010101900099', 1)`,
      [entityId, tenantId],
    );
    await admin.query(
      `INSERT INTO id_branches (id, tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'HQ', '3201010101900099000001', 'Asia/Jakarta', 1000000)`,
      [branchId, tenantId, entityId],
    );
    const appDb = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    try {
      const auth = createAuth({ appDb, env: process.env });
      const member = await grantMembership(auth, appDb, {
        email,
        password,
        name: "Sari Wulandari",
        tenantId,
        role: "hr_admin",
      });
      authUserId = member.authUserId;
      await admin.query(
        `INSERT INTO hr_employees (
           id, tenant_id, employee_code, full_name, legal_entity_id, branch_id,
           employment_status, join_date, ptkp_status, tax_method, pph21_subject_type,
           user_id, date_of_birth
         ) VALUES (
           $1::uuid, $2::uuid, 'E62', 'Sari Wulandari', $3::uuid, $4::uuid,
           'active', '2024-01-01', 'TK/0', 'gross', 'permanent', $5::uuid, '1990-01-15'
         )`,
        [employeeId, tenantId, entityId, branchId, member.userId],
      );
      await seedPii(appDb, tenantId, employeeId);
    } finally {
      await appDb.end();
    }
    await admin.query(
      `INSERT INTO hr_compensation_profiles (
         id, tenant_id, employee_id, base_salary_idr, fixed_allowances_json, bpjs_flags_json, effective_from
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 5000000, '{"transport":"500000"}'::jsonb, $4::jsonb, '2024-01-01')`,
      [randomUUID(), tenantId, employeeId, JSON.stringify(flags)],
    );
    await admin.query(
      `INSERT INTO att_daily_summaries (
         id, tenant_id, employee_id, work_date, approved_overtime_minutes, is_locked, locked_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, '2099-01-15', 0, true, now())`,
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
         $1::uuid, 'pph21', $2, '2099-01-01', '2099-01-31', 'published', $3::jsonb,
         $4::uuid, $4::uuid, now()
       )`,
      [tableId, `slice62-${tableId.slice(0, 8)}`, JSON.stringify(payload), operatorId],
    );
  });

  after(async () => {
    await stopChildren(children);
    if (admin) {
      await admin.query("ALTER TABLE pay_run_items DISABLE TRIGGER pay_run_items_immutable_trg").catch(() => undefined);
      await admin.query("ALTER TABLE pay_statutory_tables DISABLE TRIGGER pay_statutory_tables_guard_trg").catch(() => undefined);
      await admin.query("DELETE FROM pay_run_items WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM pay_runs WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM pay_statutory_tables WHERE id = $1::uuid", [tableId]).catch(() => undefined);
      await admin.query("DELETE FROM ai_messages WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM ai_action_proposals WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM ai_conversations WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM att_clock_events WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM att_daily_summaries WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM aud_events WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM aud_tenant_keys WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM hr_compensation_profiles WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM hr_employee_pii WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM hr_employees WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM id_sessions WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM id_memberships WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM id_users WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM id_roles WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM id_branches WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM id_legal_entities WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM id_tenants WHERE id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM ba_organization WHERE id = $1", [orgId]).catch(() => undefined);
      await admin.query("DELETE FROM sys_platform_operators WHERE id = $1::uuid", [operatorId]).catch(() => undefined);
      if (authUserId) {
        await admin.query("DELETE FROM ba_two_factor WHERE user_id = $1", [authUserId]).catch(() => undefined);
        await admin.query("DELETE FROM ba_session WHERE user_id = $1", [authUserId]).catch(() => undefined);
        await admin.query("DELETE FROM ba_account WHERE user_id = $1", [authUserId]).catch(() => undefined);
        await admin.query("DELETE FROM ba_user WHERE id = $1", [authUserId]).catch(() => undefined);
      }
      await admin.query("ALTER TABLE pay_run_items ENABLE TRIGGER pay_run_items_immutable_trg").catch(() => undefined);
      await admin.query("ALTER TABLE pay_statutory_tables ENABLE TRIGGER pay_statutory_tables_guard_trg").catch(() => undefined);
      await admin.end();
    }
  });

  it("serves one role each, then clocks, calculates, and chats", async () => {
    const logs = {
      attendance: { out: "", err: "" },
      worker: { out: "", err: "" },
      ai: { out: "", err: "" },
    };
    const attendanceUrl = `http://127.0.0.1:${ATTENDANCE_PORT}`;
    const aiUrl = `http://127.0.0.1:${AI_PORT}`;
    try {
      children.push(
        startRole("attendance", ATTENDANCE_PORT, attendanceUrl, aiUrl, logs.attendance),
        startRole("worker", WORKER_PORT, attendanceUrl, aiUrl, logs.worker),
        startRole("ai", AI_PORT, attendanceUrl, aiUrl, logs.ai),
      );
      await waitHealthy(ATTENDANCE_PORT, () => logs.attendance.err);
      await waitHealthy(WORKER_PORT, () => logs.worker.err);
      await waitHealthy(AI_PORT, () => logs.ai.err);

      await expectStatus(ATTENDANCE_PORT, "POST", "/api/v1/ai/chat", 404);
      await expectStatus(WORKER_PORT, "POST", "/api/v1/ai/chat", 404);
      await expectStatus(AI_PORT, "POST", "/api/v1/mobile/attendance/sync", 404);
      await expectStatus(WORKER_PORT, "POST", "/api/v1/mobile/attendance/sync", 404);
      await expectStatus(AI_PORT, "POST", "/api/v1/attendance/clock", 404);
      await expectStatus(ATTENDANCE_PORT, "POST", "/api/v1/payroll/runs", 404);
      await expectStatus(AI_PORT, "POST", "/api/v1/payroll/runs", 404);
      await expectStatus(WORKER_PORT, "POST", "/api/v1/payroll/runs", 401);
      for (const port of [ATTENDANCE_PORT, WORKER_PORT, AI_PORT]) {
        await expectStatus(port, "POST", "/api/v1/employees", 404);
        await expectStatus(port, "GET", "/api/v1/legal-entities", 404);
      }
      await expectStatus(ATTENDANCE_PORT, "POST", portPaths.effectiveTable, 404);
      await expectStatus(AI_PORT, "POST", portPaths.periodSummaries, 404);
      await expectStatus(WORKER_PORT, "POST", portPaths.payrollProfiles, 404);
      const secretDenied = await call(AI_PORT, "POST", portPaths.effectiveTable, {
        body: { payrollDate: "2099-01-31" },
      });
      assert.equal(secretDenied.status, 401, secretDenied.text);

      if (!admin) throw new Error("database client is missing");
      await admin.query("DELETE FROM id_rate_limits");
      const signedIn = await call(ATTENDANCE_PORT, "POST", "/api/auth/sign-in/email", {
        body: { email, password },
      });
      assert.equal(signedIn.status, 200, signedIn.text);
      let cookie = cookieHeader(signedIn.cookies);
      assert.ok(cookie.includes("="), signedIn.text);

      const clock = await call(ATTENDANCE_PORT, "POST", "/api/v1/mobile/attendance/sync", {
        cookie,
        body: {
          events: [
            {
              idempotencyKey: uuidv7(),
              employeeId,
              branchId,
              punchType: "clock_in",
              capturedAt: new Date(Date.now() - 2_000).toISOString(),
              syncSource: "online",
              lat: -6.2,
              lng: 106.8,
              livenessOk: true,
              mockLocationFlag: false,
            },
          ],
        },
      });
      assert.equal(clock.status, 200, clock.text);

      const enabled = await call(ATTENDANCE_PORT, "POST", "/api/auth/two-factor/enable", {
        cookie,
        body: { password },
      });
      assert.equal(enabled.status, 200, enabled.text);
      cookie = mergeCookies(cookie, enabled.cookies);
      const verified = await call(ATTENDANCE_PORT, "POST", "/api/auth/two-factor/verify-totp", {
        cookie,
        body: { code: totpFromUri(readTotpUri(enabled.text)) },
      });
      assert.equal(verified.status, 200, verified.text);
      cookie = mergeCookies(cookie, verified.cookies);

      const created = await call(WORKER_PORT, "POST", "/api/v1/payroll/runs", {
        cookie,
        body: { legalEntityId: entityId, periodYearMonth: "2099-01" },
      });
      assert.equal(created.status, 201, created.text);
      const runId = readData(created.text).id;
      if (typeof runId !== "string") throw new Error(created.text);
      const calculated = await call(WORKER_PORT, "POST", `/api/v1/payroll/runs/${runId}/calculate`, { cookie });
      assert.equal(calculated.status, 200, `${calculated.text}\n${logs.worker.err}`);
      await waitCalculated(WORKER_PORT, runId, cookie, () => logs.worker.err);
      await waitForLog(() => logs.attendance.out, '"port":"core-hr"');
      await waitForLog(() => logs.attendance.out, '"port":"attendance"');
      await waitForLog(() => logs.ai.out, '"port":"statutory"');

      const chat = await call(AI_PORT, "POST", "/api/v1/ai/chat", {
        cookie,
        body: { message: "Halo", fakeScript: [{ text: "Siap." }] },
      });
      assert.equal(chat.status, 200, chat.text);
      const conversationId = readData(chat.text).conversationId;
      assert.equal(typeof conversationId, "string");
    } finally {
      await stopChildren(children);
    }
  });
});

function startRole(
  role: "attendance" | "worker" | "ai",
  port: number,
  attendanceUrl: string,
  aiUrl: string,
  logs: { out: string; err: string },
): ChildProcess {
  const entry = fileURLToPath(new URL(`./entrypoints/${role}.ts`, import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      GOTONG_ROLE: role,
      PORT: String(port),
      HOST: "127.0.0.1",
      PORT_TRANSPORT: "http",
      INTERNAL_SERVICE_SECRET: SECRET,
      CORE_HR_PORT_URL: attendanceUrl,
      ATTENDANCE_PORT_URL: attendanceUrl,
      STATUTORY_PORT_URL: aiUrl,
      LLM_PROVIDER: "fake",
      QUEUE_DRIVER: "pgboss",
      BETTER_AUTH_URL: AUTH_ORIGIN,
      GOTONG_AUTH_RATE_LIMIT_MAX: "100",
      GOTONG_PII_KEK: "7a".repeat(32),
      AUDIT_HASH_CHAIN: "on",
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_SECRET: "slice62-local-storage-secret-0123456789",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    logs.out = `${logs.out}${chunk}`.slice(-20_000);
  });
  child.stderr?.on("data", (chunk: string) => {
    logs.err = `${logs.err}${chunk}`.slice(-20_000);
  });
  return child;
}

async function waitHealthy(port: number, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last = "";
  while (Date.now() < deadline) {
    if (stderr().includes("boot failed")) throw new Error(stderr());
    try {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (health.status === 200) {
        const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
        if (ready.status === 200) return;
        last = `ready ${ready.status} ${await ready.text()}`;
      } else {
        last = `health ${health.status}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : "down";
    }
    await delay(200);
  }
  throw new Error(`port ${port} did not become ready: ${last}\n${stderr()}`);
}

async function waitCalculated(port: number, runId: string, cookie: string, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last = "";
  while (Date.now() < deadline) {
    const response = await call(port, "GET", `/api/v1/payroll/runs/${runId}`, { cookie });
    last = `${response.status} ${response.text}`;
    if (response.status === 200) {
      const run = readData(response.text).run;
      if (run && typeof run === "object" && "status" in run && run.status === "calculated") return;
    }
    await delay(500);
  }
  throw new Error(`payroll was not calculated: ${last}\n${stderr()}`);
}

async function waitForLog(read: () => string, needle: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (read().includes(needle)) return;
    await delay(50);
  }
  throw new Error(`log missing ${needle}: ${read()}`);
}

async function expectStatus(port: number, method: string, path: string, status: number): Promise<void> {
  const response = await call(port, method, path);
  assert.equal(response.status, status, `${method} ${path} on ${port}: ${response.text}`);
}

async function call(
  port: number,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; text: string; cookies: string[] }> {
  const headers: Record<string, string> = { origin: AUTH_ORIGIN };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  return { status: response.status, text: await response.text(), cookies };
}

function cookieHeader(cookies: string[]): string {
  return cookies
    .map((line) => line.split(";")[0]?.trim() ?? "")
    .filter((part) => part.includes("="))
    .join("; ");
}

function mergeCookies(current: string, extra: string[]): string {
  const jar = new Map<string, string>();
  for (const part of current.split(";")) {
    const trimmed = part.trim();
    const name = trimmed.split("=")[0];
    if (name && trimmed.includes("=")) jar.set(name, trimmed);
  }
  for (const line of extra) {
    const pair = line.split(";")[0]?.trim() ?? "";
    const name = pair.split("=")[0];
    if (name && pair.includes("=")) jar.set(name, pair);
  }
  return [...jar.values()].join("; ");
}

function readData(text: string): { id?: string; conversationId?: string; run?: { status?: string } } {
  const parsed = JSON.parse(text) as { data?: { id?: string; conversationId?: string; run?: { status?: string } } };
  return parsed.data ?? {};
}

function readTotpUri(text: string): string {
  const parsed = JSON.parse(text) as { totpURI?: unknown };
  if (typeof parsed.totpURI !== "string") throw new Error(`missing totp uri: ${text}`);
  return parsed.totpURI;
}

function totpFromUri(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("missing totp secret");
  return totpCode(base32Decode(secret), Date.now());
}

function totpCode(secret: Buffer, at: number): string {
  const counter = Math.floor(at / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(buffer).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
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

function uuidv7(now = Date.now()): string {
  const bytes = new Uint8Array(randomBytes(16));
  const time = BigInt(now);
  bytes[0] = Number((time >> 40n) & 0xffn);
  bytes[1] = Number((time >> 32n) & 0xffn);
  bytes[2] = Number((time >> 24n) & 0xffn);
  bytes[3] = Number((time >> 16n) & 0xffn);
  bytes[4] = Number((time >> 8n) & 0xffn);
  bytes[5] = Number(time & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function statutoryPayload(): { effective_from: string; effective_to: string; jp_annual_wage_cap?: { rupiah?: string } } {
  const fixture = fileURLToPath(
    new URL("../../../packages/payroll-engine/src/__tests__/fixtures/synthetic-pph21.json", import.meta.url),
  );
  const payload = JSON.parse(readFileSync(fixture, "utf8")) as {
    effective_from: string;
    effective_to: string;
    jp_annual_wage_cap?: { rupiah?: string };
  };
  payload.effective_from = "2099-01-01";
  payload.effective_to = "2099-01-31";
  if (payload.jp_annual_wage_cap) payload.jp_annual_wage_cap.rupiah = "120000000";
  return payload;
}

async function seedPii(appDb: TenantDatabase, tenantId: string, employeeId: string): Promise<void> {
  const nik = "3201010101900099";
  const bank = "2222222222";
  await appDb.withTenantContext(tenantId, async (tx) => {
    await provisionTenantKeys(tx, tenantId);
    const secrets = await readTenantSecrets(tx, tenantId);
    const nikEnc = encryptField(secrets.dek, tenantId, "nik", nik);
    const bankEnc = encryptField(secrets.dek, tenantId, "bank_account_number", bank);
    await tx.execute(sql`
      INSERT INTO hr_employee_pii (
        id, tenant_id, employee_id, nik_enc, bank_account_number_enc, nik_hash, nik_mask, bank_account_number_mask
      ) VALUES (
        ${randomUUID()}::uuid, ${tenantId}::uuid, ${employeeId}::uuid, ${nikEnc}, ${bankEnc},
        ${blindIndex(secrets.pepper, nik)}, ${maskNik(nik)}, ${maskBankAccount(bank)}
      )
    `);
  });
}

async function stopChildren(children: ChildProcess[]): Promise<void> {
  await Promise.all(children.splice(0).map((child) => stopChild(child)));
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 12_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
