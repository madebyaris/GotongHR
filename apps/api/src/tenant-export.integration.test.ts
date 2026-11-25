import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { migrateAttendance, migrateClock } from "@gotonghr/attendance";
import { migrateAudit } from "@gotonghr/audit";
import { migrateCoreHr } from "@gotonghr/core-hr";
import { applyDatabaseUrls, loadRepoEnv, migrate, migrateEnvFrom, requiredEnv } from "@gotonghr/db";
import { ensureCredentialUser, grantMembership, migrateIdentity } from "@gotonghr/identity";
import { migratePayroll } from "@gotonghr/payroll";
import { migratePlatform, openPlatformDatabase, readStoredZip, registerPlatformOperator } from "@gotonghr/platform";
import { createLocalStorage } from "@gotonghr/storage";
import pg from "pg";
import { composeFromEnv, type ComposedApp } from "./composition.ts";
import { provisionQueue } from "./queue.ts";

const { Client } = pg;

const origin = "http://127.0.0.1:3000";
const ownerPassword = "owner-password-1";
const securityPassword = "security-password-1";
const operatorPassword = "platform-password-1";
const nik = "3273011508950001";

process.env.GOTONG_PII_KEK = "7a".repeat(32);
process.env.AUDIT_HASH_CHAIN = "on";
loadRepoEnv();
applyDatabaseUrls(process.env);

describe("tenant export", { concurrency: 1 }, () => {
  let composed: ComposedApp | undefined;
  let admin: pg.Client | undefined;
  let operators: Awaited<ReturnType<typeof openPlatformDatabase>> | undefined;
  let storageRoot = "";
  let tenantId = "";
  const previousMode = process.env.GOTONG_DEPLOYMENT_MODE;
  const previousRoot = process.env.STORAGE_LOCAL_ROOT;
  const previousSecret = process.env.STORAGE_LOCAL_SECRET;

  before(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "gotong-export-"));
    process.env.NODE_ENV = "test";
    process.env.GOTONG_DEPLOYMENT_MODE = "multi_tenant_saas";
    process.env.BETTER_AUTH_URL = origin;
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    process.env.STORAGE_LOCAL_SECRET = "export-test-storage-secret-0123456789";
    process.env.QUEUE_DRIVER = "pgboss";
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
    await migrateAudit({ migratorUrl: migrateEnv.migratorUrl });
    await migrateCoreHr({ migratorUrl: migrateEnv.migratorUrl });
    await migrateAttendance({ migratorUrl: migrateEnv.migratorUrl });
    await migrateClock({ migratorUrl: migrateEnv.migratorUrl });
    await migratePayroll({ migratorUrl: migrateEnv.migratorUrl });
    await provisionQueue(migrateEnv.migratorUrl);
    admin = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await admin.connect();
    operators = await openPlatformDatabase(requiredEnv(process.env, "DATABASE_URL_PLATFORM"));
    composed = await composeFromEnv(process.env);
  });

  after(async () => {
    await composed?.close();
    await operators?.end();
    if (admin && tenantId) {
      await admin.query("DELETE FROM pay_exports WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM pay_run_items WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM pay_runs WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM att_leave_requests WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM att_leave_types WHERE tenant_id = $1::uuid", [tenantId]).catch(() => undefined);
      await admin.query("DELETE FROM id_tenants WHERE id = $1::uuid", [tenantId]).catch(() => undefined);
    }
    await admin?.end();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
    restoreEnv("GOTONG_DEPLOYMENT_MODE", previousMode);
    restoreEnv("STORAGE_LOCAL_ROOT", previousRoot);
    restoreEnv("STORAGE_LOCAL_SECRET", previousSecret);
  });

  it("streams an owner ZIP with the five tables and stored files", { timeout: 120_000 }, async () => {
    if (!composed || !admin) throw new Error("export setup did not open the app");
    const app = composed;
    const suffix = randomUUID().slice(0, 8);
    const operatorEmail = `export-ops-${suffix}@gotonghr.test`;
    const ownerEmail = `owner-${suffix}@gotonghr.test`;
    const securityEmail = `security-${suffix}@gotonghr.test`;
    const operator = await ensureCredentialUser(app.auth, {
      email: operatorEmail,
      password: operatorPassword,
      name: "Export Ops",
    });
    if (!operators) throw new Error("export setup did not open the operator database");
    await registerPlatformOperator(operators, {
      authUserId: operator.id,
      role: "platform_super_admin",
    });
    const operatorSignIn = await signIn(app, operatorEmail, operatorPassword);
    assert.equal(operatorSignIn.statusCode, 200, operatorSignIn.body);
    const operatorCookie = cookieHeader(setCookies(operatorSignIn));
    const created = await request(app, "POST", "/api/v1/platform/tenants", {
      name: "Export HQ",
      slug: `export-${suffix}`,
      ownerEmail,
      ownerName: "Owner Export",
      ownerPassword,
    }, operatorCookie);
    assert.equal(created.statusCode, 201, created.body);
    tenantId = readData<{ id: string }>(created.body).id;

    const anonymous = await app.app.inject({ method: "POST", url: "/api/v1/tenant/exports" });
    assert.equal(anonymous.statusCode, 401, anonymous.body);

    const ownerSignIn = await signIn(app, ownerEmail, ownerPassword);
    assert.equal(ownerSignIn.statusCode, 200, ownerSignIn.body);
    let ownerCookie = cookieHeader(setCookies(ownerSignIn));
    const needsTotp = await request(app, "POST", "/api/v1/tenant/exports", undefined, ownerCookie);
    assert.equal(needsTotp.statusCode, 403, needsTotp.body);
    assert.equal(readError(needsTotp.body), "totp_enrollment_required");

    await grantMembership(app.auth, app.appDb, {
      tenantId,
      email: securityEmail,
      password: securityPassword,
      name: "Security",
      role: "it_security_admin",
    });
    const securitySignIn = await signIn(app, securityEmail, securityPassword);
    assert.equal(securitySignIn.statusCode, 200, securitySignIn.body);
    const securityCookie = await confirmTotp(app, securityPassword, cookieHeader(setCookies(securitySignIn)));
    const securityDenied = await request(app, "POST", "/api/v1/tenant/exports", undefined, securityCookie);
    assert.equal(securityDenied.statusCode, 403, securityDenied.body);
    assert.equal(readError(securityDenied.body), "forbidden");

    const ownerId = await ownerUserId(admin, tenantId);
    const seeded = await seedArchive(admin, tenantId, ownerId, storageRoot);
    ownerCookie = await confirmTotp(app, ownerPassword, ownerCookie);
    const queued = await request(app, "POST", "/api/v1/tenant/exports", undefined, ownerCookie);
    assert.equal(queued.statusCode, 201, queued.body);
    const job = readData<{ id: string; status: string; byteSize: null; download: null }>(queued.body);
    assert.equal(job.status, "queued");
    assert.equal(job.byteSize, null);
    assert.equal(job.download, null);
    assert.equal(queued.body.includes("storageKey"), false);

    const ready = await waitUntilReady(app, job.id, ownerCookie);
    assert.equal(ready.byteSize != null && ready.byteSize > 0, true);
    assert.equal(ready.download?.expiresInSeconds, 900);
    const downloadUrl = ready.download?.url;
    if (!downloadUrl) throw new Error("ready export has no download");
    assert.equal(readyBodyHasStorageKey(downloadUrl), false);

    const downloaded = await app.app.inject({ method: "GET", url: downloadUrl });
    assert.equal(downloaded.statusCode, 200, downloaded.body.slice(0, 180));
    assert.ok(Buffer.isBuffer(downloaded.rawPayload));
    assert.equal(downloaded.rawPayload.length, ready.byteSize);
    const entries = readStoredZip(downloaded.rawPayload);
    assert.deepEqual(
      [...entries.keys()].sort(),
      [
        "attendance.csv",
        "contracts.csv",
        `coretax/${seeded.coretaxId}.xml`,
        "employees.csv",
        "leave.csv",
        "payroll_runs.csv",
        `payslips/${seeded.itemId}.pdf`,
      ],
    );
    const employees = entries.get("employees.csv")?.toString("utf8") ?? "";
    assert.equal(employees.includes("employee_code"), true);
    assert.equal(employees.includes("EMP001"), true);
    assert.equal(employees.includes("Sari Export"), true);
    assert.equal(employees.includes(nik), false);
    assert.equal(entries.get("contracts.csv")?.toString("utf8").includes("PKWTT"), true);
    assert.equal(entries.get("attendance.csv")?.toString("utf8").includes("clock_in"), true);
    assert.equal(entries.get("leave.csv")?.toString("utf8").includes("2026-02-02"), true);
    assert.equal(entries.get("payroll_runs.csv")?.toString("utf8").includes("2026-03"), true);
    assert.equal(entries.get(`coretax/${seeded.coretaxId}.xml`)?.toString("utf8").includes(nik), true);
    assert.equal(entries.get(`payslips/${seeded.itemId}.pdf`)?.toString("utf8").includes("%PDF-1.4"), true);

    const missing = await request(app, "GET", `/api/v1/tenant/exports/${randomUUID()}`, undefined, ownerCookie);
    assert.equal(missing.statusCode, 404, missing.body);
  });
});

function readyBodyHasStorageKey(url: string): boolean {
  return url.includes("storageKey") || url.includes("tenant-exports/");
}

async function waitUntilReady(
  app: ComposedApp,
  exportId: string,
  cookie: string,
): Promise<{ byteSize: number | null; download: { url: string; expiresInSeconds: number } | null }> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const status = await request(app, "GET", `/api/v1/tenant/exports/${exportId}`, undefined, cookie);
    assert.equal(status.statusCode, 200, status.body);
    const data = readData<{
      status: string;
      byteSize: number | null;
      download: { url: string; expiresInSeconds: number } | null;
    }>(status.body);
    if (data.status === "ready") return data;
    if (data.status === "failed") assert.fail(status.body);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("export was not ready");
}

async function seedArchive(
  admin: pg.Client,
  tenantId: string,
  userId: string,
  rootDir: string,
): Promise<{ coretaxId: string; itemId: string }> {
  const entityId = randomUUID();
  const branchId = randomUUID();
  const employeeId = randomUUID();
  const contractId = randomUUID();
  const leaveTypeId = randomUUID();
  const leaveId = randomUUID();
  const clockId = randomUUID();
  const runId = randomUUID();
  const itemId = randomUUID();
  const coretaxId = randomUUID();
  const xml = `<?xml version="1.0"?><BPMP><NIK>${nik}</NIK></BPMP>`;
  const pdf = "%PDF-1.4\n%%EOF\n";
  const xmlKey = `exports/${tenantId}/${runId}/coretax-${coretaxId}.xml`;
  const pdfKey = `payslips/${tenantId}/${runId}/${itemId}.pdf`;
  const storage = createLocalStorage({
    rootDir,
    secret: "export-test-storage-secret-0123456789",
    urlPrefix: "/api",
  });
  await storage.put({ key: xmlKey, body: Buffer.from(xml), contentType: "application/xml" });
  await storage.put({ key: pdfKey, body: Buffer.from(pdf), contentType: "application/pdf" });
  await admin.query(
    `INSERT INTO id_legal_entities (id, tenant_id, company_name, npwp_16)
     VALUES ($1, $2, 'PT Export', '3273011508950099')`,
    [entityId, tenantId],
  );
  await admin.query(
    `INSERT INTO id_branches (id, tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr)
     VALUES ($1, $2, $3, 'HQ', '2200000000000000000099', 'Asia/Jakarta', 5000000)`,
    [branchId, tenantId, entityId],
  );
  await admin.query(
    `INSERT INTO hr_employees (
       id, tenant_id, employee_code, full_name, legal_entity_id, branch_id,
       employment_status, join_date, ptkp_status, tax_method, pph21_subject_type, date_of_birth
     ) VALUES (
       $1, $2, 'EMP001', 'Sari Export', $3, $4, 'active', '2024-01-15', 'TK/0', 'gross', 'permanent', '1990-04-02'
     )`,
    [employeeId, tenantId, entityId, branchId],
  );
  await admin.query(
    `INSERT INTO hr_contracts (id, tenant_id, employee_id, contract_type, status, start_date)
     VALUES ($1, $2, $3, 'PKWTT', 'active', '2024-01-15')`,
    [contractId, tenantId, employeeId],
  );
  await admin.query(
    `INSERT INTO att_clock_events (
       id, tenant_id, employee_id, branch_id, idempotency_key,
       punch_type, captured_at, received_at, clock_drift_seconds,
       sync_source, lat, lng, geofence_ok, review_status
     ) VALUES (
       $1, $2, $3, $4, $5, 'clock_in', now(), now(), 0, 'online', -6.2, 106.8, true, 'ok'
     )`,
    [clockId, tenantId, employeeId, branchId, randomUUID()],
  );
  await admin.query(
    `INSERT INTO att_leave_types (id, tenant_id, code, name, tenure_months, entitlement_days)
     VALUES ($1, $2, 'cuti_tahunan', 'Cuti Tahunan', 12, 12)`,
    [leaveTypeId, tenantId],
  );
  await admin.query(
    `INSERT INTO att_leave_requests (
       id, tenant_id, employee_id, leave_type_id, start_date, end_date, day_count, requested_by_user_id
     ) VALUES ($1, $2, $3, $4, '2026-02-02', '2026-02-02', 1, $5)`,
    [leaveId, tenantId, employeeId, leaveTypeId, userId],
  );
  await admin.query(
    `INSERT INTO pay_runs (id, tenant_id, legal_entity_id, period_year_month)
     VALUES ($1, $2, $3, '2026-03')`,
    [runId, tenantId, entityId],
  );
  await admin.query(
    `INSERT INTO pay_run_items (
       id, tenant_id, run_id, employee_id,
       employee_snapshot_json, attendance_snapshot_json, earnings_json, deductions_json,
       bpjs_json, pph21_json, gross_idr, tax_idr, net_idr, payslip_storage_key, payslip_generated_at
     ) VALUES (
       $1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '{}'::jsonb, '{}'::jsonb, 0, 0, 0, $5, now()
     )`,
    [itemId, tenantId, runId, employeeId, pdfKey],
  );
  await admin.query(
    `INSERT INTO pay_exports (
       id, tenant_id, run_id, export_kind, storage_key, checksum_sha256, byte_size
     ) VALUES ($1, $2, $3, 'coretax', $4, $5, $6)`,
    [coretaxId, tenantId, runId, xmlKey, "ab".repeat(32), Buffer.byteLength(xml)],
  );
  return { coretaxId, itemId };
}

async function ownerUserId(admin: pg.Client, tenantId: string): Promise<string> {
  const rows = await admin.query<{ id: string }>(
    "SELECT id::text AS id FROM id_users WHERE tenant_id = $1::uuid",
    [tenantId],
  );
  const id = rows.rows[0]?.id;
  if (!id) throw new Error("owner user was not stored");
  return id;
}

function signIn(app: ComposedApp, email: string, password: string) {
  return request(app, "POST", "/api/auth/sign-in/email", { email, password });
}

function request(
  app: ComposedApp,
  method: "GET" | "POST",
  url: string,
  body?: Record<string, unknown>,
  cookie?: string,
) {
  return app.app.inject({
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

function readError(body: string): string | undefined {
  const parsed = JSON.parse(body) as { error?: { code?: string } | null };
  return parsed.error?.code;
}

function readData<T>(body: string): T {
  const parsed = JSON.parse(body) as { data: T };
  return parsed.data;
}

async function confirmTotp(app: ComposedApp, password: string, cookie: string): Promise<string> {
  const enabled = await request(app, "POST", "/api/auth/two-factor/enable", { password }, cookie);
  assert.equal(enabled.statusCode, 200, enabled.body);
  const enrollment = JSON.parse(enabled.body) as { totpURI?: string };
  if (!enrollment.totpURI) throw new Error("missing totp uri");
  const verified = await request(
    app,
    "POST",
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
