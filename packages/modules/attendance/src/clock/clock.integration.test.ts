import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
import { createLocalStorage, type LocalObjectStorage } from "@gotonghr/storage";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import pg from "pg";
import { MAX_PLAUSIBLE_TRAVEL_SPEED_KMH, SELFIE_MAX_BYTES } from "./limits.ts";
import { registerClockRoutes } from "./routes.ts";
import type { ClockDecision } from "./types.ts";
import { uuidv7 } from "./uuid.ts";

const execFileAsync = promisify(execFile);
const { Client } = pg;

loadRepoEnv();
applyDatabaseUrls(process.env);

const RECEIVED = new Date("2026-06-01T01:00:00.000Z");
const RADIUS_M = 200;

interface Company {
  tenantId: string;
  orgId: string;
  legalEntityId: string;
  branchId: string;
  employeeId: string;
  userId: string;
}

describe("clock events and sync", { concurrency: 1 }, () => {
  let app: FastifyInstance;
  let appDb: TenantDatabase;
  let platform: pg.Client;
  let superuser: pg.Client;
  let storage: LocalObjectStorage;
  let root = "";
  let companyA: Company;
  let companyB: Company;
  const scopeBranchIds: string[] = [];

  before(async () => {
    await applySchemas();
    root = await mkdtemp(path.join(tmpdir(), "gotong-clock-"));
    storage = createLocalStorage({
      rootDir: root,
      secret: "local-test-storage-secret-0123456789",
      urlPrefix: "",
    });
    appDb = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    platform = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM") });
    superuser = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await platform.connect();
    await superuser.connect();
    companyA = await seedCompany(superuser, "A");
    companyB = await seedCompany(superuser, "B");
    app = Fastify({ logger: false });
    await storage.registerRoutes(app);
    await registerClockRoutes(app, {
      database: appDb,
      storage,
      guard: async () => {},
      readCaller(request) {
        const header = request.headers["x-test-tenant"];
        const tenantId = Array.isArray(header) ? header[0] : header;
        if (tenantId === companyA.tenantId) {
          return { tenantId: companyA.tenantId, userId: companyA.userId, scopeBranchIds };
        }
        if (tenantId === companyB.tenantId) {
          return { tenantId: companyB.tenantId, userId: companyB.userId, scopeBranchIds: [] };
        }
        return null;
      },
      now: () => RECEIVED,
    });
  });

  after(async () => {
    scopeBranchIds.length = 0;
    if (superuser && companyA && companyB) {
      await cleanup(superuser, [companyA, companyB]).catch(() => undefined);
    }
    await app?.close();
    await appDb?.end();
    await platform?.end();
    await superuser?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("keeps the spec columns, forces RLS, and has no image column", async () => {
    const columns = await superuser.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'att_clock_events'`,
    );
    const names = new Set(columns.rows.map((row) => row.column_name));
    for (const name of [
      "id",
      "tenant_id",
      "employee_id",
      "branch_id",
      "idempotency_key",
      "punch_type",
      "captured_at",
      "received_at",
      "clock_drift_seconds",
      "sync_source",
      "lat",
      "lng",
      "accuracy_meters",
      "distance_meters",
      "geofence_ok",
      "speed_kmh",
      "liveness_ok",
      "mock_location_flag",
      "selfie_storage_key",
      "review_status",
      "review_reasons_json",
      "reviewed_by",
      "reviewed_at",
    ]) {
      assert.equal(names.has(name), true, name);
    }
    assert.equal(columns.rows.some((row) => row.data_type === "bytea"), false);
    const forced = await superuser.query<{ forced: boolean }>(
      `SELECT c.relforcerowsecurity AS forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'att_clock_events'`,
    );
    assert.equal(forced.rows[0]?.forced, true);
    const constraint = await superuser.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'att_clock_events_idempotency_key'",
    );
    assert.equal(constraint.rowCount, 1);
  });

  it("returns the same decision for a duplicate idempotency key and keeps one row", async () => {
    await clearPunches(superuser, companyA.tenantId);
    const body = punch(companyA.employeeId);
    const first = await postSync(app, companyA.tenantId, [body]);
    const second = await postSync(app, companyA.tenantId, [
      { ...body, lat: 10, capturedAt: earlier(15 * 60_000) },
    ]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    const original = one(first);
    const replay = one(second);
    assert.equal(original.duplicate, false);
    assert.equal(replay.duplicate, true);
    const { duplicate: _originalDup, ...stored } = original;
    const { duplicate: _replayDup, ...replayed } = replay;
    assert.deepEqual(replayed, stored);
    assert.equal(original.geofenceOk, true);
    assert.equal(original.clockDriftSeconds, 1);
    assert.equal(await punchCount(superuser, companyA.tenantId, body.idempotencyKey), 1);
  });

  it("stores a 15 minute offline drift and does not flag it", async () => {
    await clearPunches(superuser, companyA.tenantId);
    const response = await postSync(app, companyA.tenantId, [
      punch(companyA.employeeId, { syncSource: "offline_queue", capturedAt: earlier(15 * 60_000) }),
    ]);
    assert.equal(response.statusCode, 200, response.body);
    const decision = one(response);
    assert.equal(decision.clockDriftSeconds, 900);
    assert.equal(decision.reviewStatus, "ok");
    assert.deepEqual(decision.reviewReasons, []);
    assert.equal(await punchCount(superuser, companyA.tenantId), 1);
  });

  it("flags a 15 minute drift without offline_queue and keeps the punch", async () => {
    await clearPunches(superuser, companyA.tenantId);
    const response = await postSync(app, companyA.tenantId, [
      punch(companyA.employeeId, { capturedAt: earlier(15 * 60_000) }),
    ]);
    assert.equal(response.statusCode, 200, response.body);
    const decision = one(response);
    assert.equal(decision.clockDriftSeconds, 900);
    assert.equal(decision.reviewStatus, "needs_review");
    assert.deepEqual(decision.reviewReasons, ["clock_drift"]);
    assert.equal(await punchCount(superuser, companyA.tenantId), 1);
    const row = await superuser.query("SELECT id FROM att_clock_events WHERE id = $1::uuid", [decision.id]);
    assert.equal(row.rowCount, 1);
  });

  it("does not flag exactly 600 seconds and flags 601", async () => {
    await clearPunches(superuser, companyA.tenantId);
    const onTime = one(
      await postSync(app, companyA.tenantId, [punch(companyA.employeeId, { capturedAt: earlier(600_000) })]),
    );
    assert.equal(onTime.clockDriftSeconds, 600);
    assert.equal(onTime.reviewStatus, "ok");
    await clearPunches(superuser, companyA.tenantId);
    const late = one(
      await postSync(app, companyA.tenantId, [punch(companyA.employeeId, { capturedAt: earlier(601_000) })]),
    );
    assert.equal(late.clockDriftSeconds, 601);
    assert.equal(late.reviewStatus, "needs_review");
    assert.deepEqual(late.reviewReasons, ["clock_drift"]);
  });

  it("sets geofence_ok false when the point is outside the branch radius", async () => {
    await clearPunches(superuser, companyA.tenantId);
    const response = await postSync(app, companyA.tenantId, [
      punch(companyA.employeeId, { lat: 0, lng: 0.02 }),
    ]);
    assert.equal(response.statusCode, 200, response.body);
    const decision = one(response);
    assert.equal(decision.geofenceOk, false);
    assert.ok((decision.distanceMeters ?? 0) > RADIUS_M);
    assert.equal(decision.reviewStatus, "needs_review");
    assert.deepEqual(decision.reviewReasons, ["geofence"]);
    const stored = await superuser.query<{ geofence_ok: boolean }>(
      "SELECT geofence_ok FROM att_clock_events WHERE id = $1::uuid",
      [decision.id],
    );
    assert.equal(stored.rows[0]?.geofence_ok, false);
  });

  it("flags a later punch faster than 1000 km/h and keeps it", async () => {
    assert.equal(MAX_PLAUSIBLE_TRAVEL_SPEED_KMH, 1000);
    await clearPunches(superuser, companyA.tenantId);
    const first = await postSync(app, companyA.tenantId, [
      punch(companyA.employeeId, { capturedAt: earlier(2_000) }),
    ]);
    assert.equal(one(first).reviewStatus, "ok");
    const second = await postSync(app, companyA.tenantId, [
      punch(companyA.employeeId, { capturedAt: earlier(1_900), lng: 0.0008 }),
    ]);
    assert.equal(second.statusCode, 200, second.body);
    const decision = one(second);
    assert.ok((decision.speedKmh ?? 0) > MAX_PLAUSIBLE_TRAVEL_SPEED_KMH);
    assert.equal(decision.geofenceOk, true);
    assert.equal(decision.reviewStatus, "needs_review");
    assert.deepEqual(decision.reviewReasons, ["travel_speed"]);
    assert.equal(await punchCount(superuser, companyA.tenantId), 2);
  });

  it("rejects a bad selfie type or a size over 100 KB and presigns a jpeg at the cap", async () => {
    const beforeCount = await punchCount(superuser, companyA.tenantId);
    const png = await postUpload(app, companyA.tenantId, { contentType: "image/png", contentLength: 100 });
    assert.equal(png.statusCode, 400, png.body);
    assert.equal(errorOf(png).code, "invalid_field");
    const huge = await postUpload(app, companyA.tenantId, {
      contentType: "image/jpeg",
      contentLength: SELFIE_MAX_BYTES + 1,
    });
    assert.equal(huge.statusCode, 400, huge.body);
    assert.equal(huge.body.includes("100 KB"), true);
    const jpeg = await postUpload(app, companyA.tenantId, {
      contentType: "image/jpeg",
      contentLength: SELFIE_MAX_BYTES,
    });
    assert.equal(jpeg.statusCode, 200, jpeg.body);
    const upload = uploadOf(jpeg);
    assert.equal(upload.maxContentLength, SELFIE_MAX_BYTES);
    assert.equal(upload.upload.method, "PUT");
    assert.equal(tokenMaxBytes(upload.upload.url), SELFIE_MAX_BYTES);
    assert.match(upload.storageKey, /^selfies\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/u);
    const webp = await postUpload(app, companyA.tenantId, { contentType: "image/webp", contentLength: 40_000 });
    assert.equal(webp.statusCode, 200, webp.body);
    assert.equal(uploadOf(webp).maxContentLength, 40_000);
    assert.equal(tokenMaxBytes(uploadOf(webp).upload.url), 40_000);
    assert.equal(await punchCount(superuser, companyA.tenantId), beforeCount);

    const capped = await postUpload(app, companyA.tenantId, { contentType: "image/jpeg", contentLength: 100 });
    const small = uploadOf(capped);
    const rejected = await app.inject({
      method: "PUT",
      url: small.upload.url,
      headers: { "content-type": "image/jpeg", "content-length": "101" },
      payload: Buffer.alloc(101, 7),
    });
    assert.equal(rejected.statusCode, 413);
  });

  it("stores the selfie key and zero image bytes", async () => {
    await clearPunches(superuser, companyA.tenantId);
    const image = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22, 0x33, 0xd9]);
    const presign = await postUpload(app, companyA.tenantId, {
      contentType: "image/jpeg",
      contentLength: image.length,
    });
    assert.equal(presign.statusCode, 200, presign.body);
    const upload = uploadOf(presign);
    const put = await app.inject({
      method: "PUT",
      url: upload.upload.url,
      headers: { "content-type": "image/jpeg" },
      payload: image,
    });
    assert.equal(put.statusCode, 200, put.body);
    const raw = await postSync(app, companyA.tenantId, [
      { ...punch(companyA.employeeId), selfieBytes: image.toString("base64") },
    ]);
    assert.equal(raw.statusCode, 400, raw.body);
    assert.equal(await punchCount(superuser, companyA.tenantId), 0);
    const saved = await postSync(app, companyA.tenantId, [
      punch(companyA.employeeId, { selfieStorageKey: upload.storageKey }),
    ]);
    assert.equal(saved.statusCode, 200, saved.body);
    const decision = one(saved);
    const row = await superuser.query<{ selfie_storage_key: string; payload: string }>(
      `SELECT selfie_storage_key, row_to_json(att_clock_events)::text AS payload
       FROM att_clock_events WHERE id = $1::uuid`,
      [decision.id],
    );
    assert.equal(row.rows[0]?.selfie_storage_key, upload.storageKey);
    assert.equal(row.rows[0]?.payload.includes(image.toString("base64")), false);
    assert.equal(row.rows[0]?.payload.includes(image.toString("hex")), false);
    const file = await readFile(path.join(root, upload.storageKey));
    assert.equal(file.equals(image), true);
    const bytea = await superuser.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'att_clock_events' AND data_type = 'bytea'`,
    );
    assert.equal(bytea.rowCount, 0);
  });

  it("hides another tenant's punches and denies platform_admin", async () => {
    await clearPunches(superuser, companyA.tenantId);
    const response = await postSync(app, companyA.tenantId, [punch(companyA.employeeId)]);
    const decision = one(response);
    await appDb.withTenantContext(companyB.tenantId, async (tx) => {
      const visible = rowsOf(await tx.execute(sql`SELECT id::text AS id FROM att_clock_events`));
      assert.equal(visible.some((row) => row.id === decision.id), false);
    });
    await appDb.withTenantContext(companyA.tenantId, async (tx) => {
      const visible = rowsOf(await tx.execute(sql`SELECT id::text AS id FROM att_clock_events`));
      assert.equal(visible.some((row) => row.id === decision.id), true);
      const updated = rowsOf(
        await tx.execute(sql`UPDATE att_clock_events SET review_status = 'reviewed' RETURNING id::text AS id`),
      );
      assert.equal(updated.some((row) => row.id === decision.id), true);
      const leaked = updated.filter((row) => row.id !== decision.id);
      assert.equal(leaked.length, 0);
    });
    const other = await appDb.withTenantContext(companyB.tenantId, async (tx) =>
      rowsOf(await tx.execute(sql`UPDATE att_clock_events SET review_status = 'ok' RETURNING id::text AS id`)),
    );
    assert.equal(other.length, 0);
    const still = await superuser.query<{ review_status: string }>(
      "SELECT review_status FROM att_clock_events WHERE id = $1::uuid",
      [decision.id],
    );
    assert.equal(still.rows[0]?.review_status, "reviewed");
    await assert.rejects(platform.query("SELECT id FROM att_clock_events"), (error: unknown) => {
      return codeOf(error) === "42501";
    });
  });

  it("rejects a signed-out sync", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mobile/attendance/sync",
      headers: { "content-type": "application/json" },
      payload: { events: [punch(companyA.employeeId)] },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(errorOf(response).code, "unauthenticated");
  });
});

async function applySchemas(): Promise<void> {
  const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
  const source = `
    import { migrate, migrateEnvFrom, loadRepoEnv, applyDatabaseUrls } from ${JSON.stringify(`${repo}/packages/db/dist/index.js`)};
    import { migrateIdentity } from ${JSON.stringify(`${repo}/packages/modules/identity/dist/migrate.js`)};
    import { migrateCoreHr } from ${JSON.stringify(`${repo}/packages/modules/core-hr/dist/migrate.js`)};
    import { migrateClock } from ${JSON.stringify(`${repo}/packages/modules/attendance/dist/clock/migrate.js`)};
    loadRepoEnv();
    applyDatabaseUrls(process.env);
    const env = migrateEnvFrom(process.env);
    await migrate(env);
    await migrateIdentity({ superuserUrl: env.superuserUrl, migratorUrl: env.migratorUrl });
    await migrateCoreHr({ migratorUrl: env.migratorUrl });
    await migrateClock({ migratorUrl: env.migratorUrl });
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: repo,
    env: process.env,
  });
}

async function seedCompany(superuser: pg.Client, label: string): Promise<Company> {
  const tenantId = randomUUID();
  const orgId = `clock-${label}-${tenantId}`;
  const legalEntityId = randomUUID();
  const branchId = randomUUID();
  const employeeId = randomUUID();
  const userId = randomUUID();
  const npwp = label === "A" ? "1000000000000201" : "1000000000000202";
  const nitku = label === "A" ? "1000000000000000000201" : "1000000000000000000202";
  await superuser.query(`INSERT INTO ba_organization (id, name, slug) VALUES ($1, $2, $1)`, [
    orgId,
    `Clock ${label}`,
  ]);
  await superuser.query(
    `INSERT INTO id_tenants (id, organization_id, name, slug) VALUES ($1::uuid, $2, $3, $2)`,
    [tenantId, orgId, `Clock ${label}`],
  );
  await superuser.query(
    `INSERT INTO id_legal_entities (id, tenant_id, company_name, npwp_16) VALUES ($1::uuid, $2::uuid, $3, $4)`,
    [legalEntityId, tenantId, `PT Clock ${label}`, npwp],
  );
  await superuser.query(
    `INSERT INTO id_branches (
       id, tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr,
       geofence_lat, geofence_lng, geofence_radius_m
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'Asia/Jakarta', 5000000, 0, 0, $6)`,
    [branchId, tenantId, legalEntityId, `HQ ${label}`, nitku, RADIUS_M],
  );
  await superuser.query(
    `INSERT INTO hr_employees (
       id, tenant_id, employee_code, full_name, legal_entity_id, branch_id,
       employment_status, join_date, ptkp_status, tax_method, pph21_subject_type
     ) VALUES (
       $1::uuid, $2::uuid, 'CLK001', 'Clock Employee', $3::uuid, $4::uuid,
       'active', '2024-01-15', 'TK/0', 'gross', 'permanent'
     )`,
    [employeeId, tenantId, legalEntityId, branchId],
  );
  return { tenantId, orgId, legalEntityId, branchId, employeeId, userId };
}

async function cleanup(superuser: pg.Client, companies: Company[]): Promise<void> {
  const tenants = companies.map((company) => company.tenantId);
  const orgs = companies.map((company) => company.orgId);
  await superuser.query("DELETE FROM att_clock_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_employees WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_branches WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_legal_entities WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_tenants WHERE id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM ba_organization WHERE id = ANY($1::text[])", [orgs]);
}

async function clearPunches(superuser: pg.Client, tenantId: string): Promise<void> {
  await superuser.query("DELETE FROM att_clock_events WHERE tenant_id = $1::uuid", [tenantId]);
}

async function punchCount(superuser: pg.Client, tenantId: string, idempotencyKey?: string): Promise<number> {
  const result = idempotencyKey
    ? await superuser.query(
        "SELECT id FROM att_clock_events WHERE tenant_id = $1::uuid AND idempotency_key = $2::uuid",
        [tenantId, idempotencyKey],
      )
    : await superuser.query("SELECT id FROM att_clock_events WHERE tenant_id = $1::uuid", [tenantId]);
  return result.rowCount ?? 0;
}

function postSync(app: FastifyInstance, tenantId: string, events: unknown[]): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/api/v1/mobile/attendance/sync",
    headers: { "content-type": "application/json", "x-test-tenant": tenantId },
    payload: { events },
  });
}

function postUpload(
  app: FastifyInstance,
  tenantId: string,
  payload: { contentType: string; contentLength: number },
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/api/v1/mobile/attendance/selfie-upload-url",
    headers: { "content-type": "application/json", "x-test-tenant": tenantId },
    payload,
  });
}

function punch(employeeId: string, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: uuidv7(),
    employeeId,
    punchType: "clock_in",
    capturedAt: earlier(1_000),
    syncSource: "online",
    lat: 0,
    lng: 0,
    ...overrides,
  };
}

function earlier(ms: number): string {
  return new Date(RECEIVED.getTime() - ms).toISOString();
}

function one(response: LightMyRequestResponse): ClockDecision {
  assert.equal(response.statusCode, 200, response.body);
  const events = (JSON.parse(response.body) as { data: { events: ClockDecision[] } }).data.events;
  const decision = events[0];
  assert.ok(decision);
  return decision;
}

function uploadOf(response: LightMyRequestResponse): {
  storageKey: string;
  maxContentLength: number;
  upload: { url: string; method: string };
} {
  return (
    JSON.parse(response.body) as {
      data: { storageKey: string; maxContentLength: number; upload: { url: string; method: string } };
    }
  ).data;
}

function errorOf(response: LightMyRequestResponse): { code: string } {
  return (JSON.parse(response.body) as { error: { code: string } }).error;
}

function tokenMaxBytes(url: string): number {
  const token = new URL(url, "http://127.0.0.1").searchParams.get("token");
  assert.ok(token);
  const body = token.split(".")[0];
  assert.ok(body);
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { maxBytes?: number };
  assert.equal(typeof payload.maxBytes, "number");
  return payload.maxBytes as number;
}

function rowsOf(result: unknown): Array<{ id: string }> {
  if (Array.isArray(result)) return result as Array<{ id: string }>;
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Array<{ id: string }>;
  }
  return [];
}

function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
