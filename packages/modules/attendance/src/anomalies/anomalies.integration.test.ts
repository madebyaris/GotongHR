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
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import pg from "pg";
import { registerAnomalyRoutes } from "./routes.ts";
import { rowsOf } from "./sql.ts";
import type { AnomalyCaller, PendingAnomaly } from "./types.ts";

process.env.GOTONG_PII_KEK ??= "7a".repeat(32);

const execFileAsync = promisify(execFile);
const { Client } = pg;

loadRepoEnv();
applyDatabaseUrls(process.env);

interface Company {
  tenantId: string;
  orgId: string;
  legalEntityId: string;
  branchId: string;
  employeeId: string;
  userId: string;
  name: string;
  code: string;
}

describe("anomaly inbox", { concurrency: 1 }, () => {
  let app: FastifyInstance;
  let appDb: TenantDatabase;
  let superuser: pg.Client;
  let companyA: Company;
  let companyB: Company;
  let actors: Record<string, AnomalyCaller>;

  before(async () => {
    await applySchemas();
    appDb = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    superuser = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await superuser.connect();
    companyA = await seedCompany(superuser, "A", "Raka Putra", "AN001");
    companyB = await seedCompany(superuser, "B", "Budi Santoso", "AN002");
    const outsideBranch = randomUUID();
    actors = {
      manager: caller(companyA, "branch_manager", ["attendance.approve"], []),
      staff: caller(companyA, "employee", [], []),
      scoped: caller(companyA, "branch_manager", ["attendance.approve"], [outsideBranch]),
      other: caller(companyB, "hr_admin", ["attendance.approve"], []),
    };
    app = Fastify({ logger: false });
    await registerAnomalyRoutes(app, {
      database: appDb,
      guard: async () => {},
      readCaller(request) {
        const header = request.headers["x-test-actor"];
        const name = Array.isArray(header) ? header[0] : header;
        if (!name) return null;
        return actors[name] ?? null;
      },
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

  it("hides unflagged punches and returns the same flagged punches on both inboxes", async () => {
    await clearPunches(superuser, [companyA.tenantId, companyB.tenantId]);
    const okId = await insertPunch(superuser, companyA, { reviewStatus: "ok", capturedAt: atMinute(1) });
    const offlineId = await insertPunch(superuser, companyA, {
      reviewStatus: "ok",
      drift: 900,
      syncSource: "offline_queue",
      capturedAt: atMinute(2),
    });
    const reviewedId = await insertPunch(superuser, companyA, {
      reviewStatus: "reviewed",
      geofenceOk: false,
      reasons: ["geofence"],
      capturedAt: atMinute(3),
    });
    const driftId = await insertPunch(superuser, companyA, {
      reviewStatus: "needs_review",
      drift: 900,
      reasons: ["clock_drift"],
      capturedAt: atMinute(4),
    });
    const geofenceId = await insertPunch(superuser, companyA, {
      reviewStatus: "needs_review",
      geofenceOk: false,
      distance: 1500,
      reasons: ["geofence"],
      capturedAt: atMinute(5),
    });
    const speedId = await insertPunch(superuser, companyA, {
      reviewStatus: "needs_review",
      speed: 1200,
      reasons: ["travel_speed"],
      capturedAt: atMinute(6),
    });
    const livenessId = await insertPunch(superuser, companyA, {
      reviewStatus: "needs_review",
      livenessOk: false,
      capturedAt: atMinute(7),
    });
    const mockId = await insertPunch(superuser, companyA, {
      reviewStatus: "needs_review",
      mock: true,
      capturedAt: atMinute(8),
    });
    const otherId = await insertPunch(superuser, companyB, {
      reviewStatus: "needs_review",
      livenessOk: false,
      mock: true,
      capturedAt: atMinute(1),
    });

    const web = await getInbox(app, "manager", "/api/v1/attendance/anomalies");
    const phone = await getInbox(app, "manager", "/api/v1/mobile/approvals/pending");
    assert.equal(web.statusCode, 200, web.body);
    assert.equal(phone.body, web.body);
    const rows = dataOf(web);
    const ids = rows.map((row) => row.id);
    assert.deepEqual(ids, [driftId, geofenceId, speedId, livenessId, mockId]);
    for (const hidden of [okId, offlineId, reviewedId, otherId]) {
      assert.equal(ids.includes(hidden), false);
    }
    assert.deepEqual(byId(rows, driftId).reasons, ["clock_drift"]);
    assert.deepEqual(byId(rows, geofenceId).reasons, ["geofence"]);
    assert.equal(byId(rows, geofenceId).distanceMeters, 1500);
    assert.equal(byId(rows, geofenceId).geofenceOk, false);
    assert.deepEqual(byId(rows, speedId).reasons, ["travel_speed"]);
    assert.equal(byId(rows, speedId).speedKmh, 1200);
    assert.deepEqual(byId(rows, livenessId).reasons, ["liveness"]);
    assert.equal(byId(rows, livenessId).livenessOk, false);
    assert.deepEqual(byId(rows, mockId).reasons, ["mock_location"]);
    assert.equal(byId(rows, mockId).mockLocationFlag, true);
    assert.equal(byId(rows, driftId).employeeName, companyA.name);
    assert.equal(byId(rows, driftId).employeeCode, companyA.code);

    const otherWeb = await getInbox(app, "other", "/api/v1/attendance/anomalies");
    const otherPhone = await getInbox(app, "other", "/api/v1/mobile/approvals/pending");
    assert.equal(otherPhone.body, otherWeb.body);
    assert.deepEqual(dataOf(otherWeb).map((row) => row.id), [otherId]);
  });

  it("removes a reviewed punch from both inboxes and keeps the clock row and audit event", async () => {
    await clearPunches(superuser, [companyA.tenantId]);
    const okId = await insertPunch(superuser, companyA, { reviewStatus: "ok", capturedAt: atMinute(1) });
    const flaggedId = await insertPunch(superuser, companyA, {
      reviewStatus: "needs_review",
      geofenceOk: false,
      distance: 842,
      reasons: ["geofence"],
      capturedAt: atMinute(2),
    });
    const before = await punchCount(superuser, companyA.tenantId);
    assert.equal(before, 2);

    const reviewed = await postReview(app, "manager", flaggedId, { note: "Saw the guard wave them in." });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    const receipt = (
      JSON.parse(reviewed.body) as {
        data: { id: string; reviewStatus: string; reviewedBy: string; reviewNote: string | null };
      }
    ).data;
    assert.equal(receipt.id, flaggedId);
    assert.equal(receipt.reviewStatus, "reviewed");
    assert.equal(receipt.reviewedBy, companyA.userId);
    assert.equal(receipt.reviewNote, "Saw the guard wave them in.");

    const web = await getInbox(app, "manager", "/api/v1/attendance/anomalies");
    const phone = await getInbox(app, "manager", "/api/v1/mobile/approvals/pending");
    assert.equal(phone.body, web.body);
    const ids = dataOf(web).map((row) => row.id);
    assert.equal(ids.includes(flaggedId), false);
    assert.equal(ids.includes(okId), false);

    const stored = await superuser.query<{
      review_status: string;
      reviewed_by: string;
      reviewed: boolean;
      review_note: string | null;
    }>(
      `SELECT review_status, reviewed_by::text, reviewed_at IS NOT NULL AS reviewed, review_note
       FROM att_clock_events WHERE id = $1::uuid`,
      [flaggedId],
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0]?.review_status, "reviewed");
    assert.equal(stored.rows[0]?.reviewed_by, companyA.userId);
    assert.equal(stored.rows[0]?.reviewed, true);
    assert.equal(stored.rows[0]?.review_note, "Saw the guard wave them in.");
    assert.equal(await punchCount(superuser, companyA.tenantId), before);

    const audit = await superuser.query<{ action: string; resource_type: string; diff: string }>(
      `SELECT action, resource_type, diff_redacted_json::text AS diff
       FROM aud_events
       WHERE tenant_id = $1::uuid AND resource_id = $2::uuid`,
      [companyA.tenantId, flaggedId],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0]?.action, "attendance.anomaly.review");
    assert.equal(audit.rows[0]?.resource_type, "att_clock_event");
    assert.equal(audit.rows[0]?.diff.includes("Saw the guard wave them in."), true);
    await appDb.withTenantContext(companyB.tenantId, async (tx) => {
      const visible = rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT id::text AS id FROM aud_events WHERE resource_id = ${flaggedId}::uuid`),
      );
      assert.equal(visible.length, 0);
    });

    const again = await postReview(app, "manager", flaggedId, {});
    assert.equal(again.statusCode, 409, again.body);
    assert.equal(codeOf(again), "conflict");
    assert.equal(await punchCount(superuser, companyA.tenantId), before);

    const plain = await postReview(app, "manager", okId, {});
    assert.equal(plain.statusCode, 409, plain.body);
    const stillOk = await superuser.query<{ review_status: string }>(
      "SELECT review_status FROM att_clock_events WHERE id = $1::uuid",
      [okId],
    );
    assert.equal(stillOk.rows[0]?.review_status, "ok");
  });

  it("keeps another tenant and another branch from reviewing the punch", async () => {
    await clearPunches(superuser, [companyA.tenantId, companyB.tenantId]);
    const flaggedId = await insertPunch(superuser, companyA, {
      reviewStatus: "needs_review",
      mock: true,
      capturedAt: atMinute(1),
    });
    const foreign = await postReview(app, "other", flaggedId, {});
    assert.equal(foreign.statusCode, 404, foreign.body);
    const scopedList = await getInbox(app, "scoped", "/api/v1/attendance/anomalies");
    const scopedPhone = await getInbox(app, "scoped", "/api/v1/mobile/approvals/pending");
    assert.equal(scopedPhone.body, scopedList.body);
    assert.deepEqual(dataOf(scopedList), []);
    const scopedReview = await postReview(app, "scoped", flaggedId, {});
    assert.equal(scopedReview.statusCode, 404, scopedReview.body);
    const stored = await superuser.query<{ review_status: string }>(
      "SELECT review_status FROM att_clock_events WHERE id = $1::uuid",
      [flaggedId],
    );
    assert.equal(stored.rows[0]?.review_status, "needs_review");
  });

  it("refuses a caller without attendance.approve and an over-long note", async () => {
    await clearPunches(superuser, [companyA.tenantId]);
    const flaggedId = await insertPunch(superuser, companyA, {
      reviewStatus: "needs_review",
      livenessOk: false,
      capturedAt: atMinute(1),
    });
    for (const path of ["/api/v1/attendance/anomalies", "/api/v1/mobile/approvals/pending"]) {
      const response = await getInbox(app, "staff", path);
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(codeOf(response), "forbidden");
    }
    const denied = await postReview(app, "staff", flaggedId, {});
    assert.equal(denied.statusCode, 403, denied.body);
    const blank = await postReview(app, "manager", flaggedId, { note: "   " });
    assert.equal(blank.statusCode, 200, blank.body);
    const blankRow = await superuser.query<{ review_note: string | null }>(
      "SELECT review_note FROM att_clock_events WHERE id = $1::uuid",
      [flaggedId],
    );
    assert.equal(blankRow.rows[0]?.review_note, null);

    const second = await insertPunch(superuser, companyA, {
      reviewStatus: "needs_review",
      geofenceOk: false,
      capturedAt: atMinute(2),
    });
    const longNote = await postReview(app, "manager", second, { note: "a".repeat(501) });
    assert.equal(longNote.statusCode, 400, longNote.body);
    assert.equal(codeOf(longNote), "invalid_field");
    const unknown = await postReview(app, "manager", second, { comment: "nope" });
    assert.equal(unknown.statusCode, 400, unknown.body);
    const untouched = await superuser.query<{ review_status: string }>(
      "SELECT review_status FROM att_clock_events WHERE id = $1::uuid",
      [second],
    );
    assert.equal(untouched.rows[0]?.review_status, "needs_review");
    const missing = await postReview(app, "manager", randomUUID(), {});
    assert.equal(missing.statusCode, 404, missing.body);
    const signedOut = await app.inject({ method: "GET", url: "/api/v1/attendance/anomalies" });
    assert.equal(signedOut.statusCode, 401);
  });
});

function caller(
  company: Company,
  role: string,
  permissions: readonly string[],
  scopeBranchIds: readonly string[],
): AnomalyCaller {
  return {
    tenantId: company.tenantId,
    userId: company.userId,
    role,
    permissions,
    scopeBranchIds,
    ipAddress: "127.0.0.1",
    userAgent: "anomaly-test",
  };
}

async function applySchemas(): Promise<void> {
  const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
  const source = `
    import { migrate, migrateEnvFrom, loadRepoEnv, applyDatabaseUrls } from ${JSON.stringify(`${repo}/packages/db/dist/index.js`)};
    import { migrateIdentity } from ${JSON.stringify(`${repo}/packages/modules/identity/dist/migrate.js`)};
    import { migrateCoreHr } from ${JSON.stringify(`${repo}/packages/modules/core-hr/dist/migrate.js`)};
    import { migrateAudit } from ${JSON.stringify(`${repo}/packages/modules/audit/dist/migrate.js`)};
    import { migrateClock } from ${JSON.stringify(`${repo}/packages/modules/attendance/dist/clock/migrate.js`)};
    import { migrateAnomalies } from ${JSON.stringify(`${repo}/packages/modules/attendance/dist/anomalies/migrate.js`)};
    loadRepoEnv();
    applyDatabaseUrls(process.env);
    const env = migrateEnvFrom(process.env);
    await migrate(env);
    await migrateIdentity({ superuserUrl: env.superuserUrl, migratorUrl: env.migratorUrl });
    await migrateCoreHr({ migratorUrl: env.migratorUrl });
    await migrateAudit({ migratorUrl: env.migratorUrl });
    await migrateClock({ migratorUrl: env.migratorUrl });
    await migrateAnomalies({ migratorUrl: env.migratorUrl });
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: repo,
    env: process.env,
  });
}

async function seedCompany(
  superuser: pg.Client,
  label: string,
  name: string,
  code: string,
): Promise<Company> {
  const tenantId = randomUUID();
  const orgId = `anomaly-${label}-${tenantId}`;
  const legalEntityId = randomUUID();
  const branchId = randomUUID();
  const employeeId = randomUUID();
  const userId = randomUUID();
  const npwp = label === "A" ? "1000000000000301" : "1000000000000302";
  const nitku = label === "A" ? "1000000000000000000301" : "1000000000000000000302";
  await superuser.query(`INSERT INTO ba_organization (id, name, slug) VALUES ($1, $2, $1)`, [
    orgId,
    `Anomaly ${label}`,
  ]);
  await superuser.query(
    `INSERT INTO id_tenants (id, organization_id, name, slug) VALUES ($1::uuid, $2, $3, $2)`,
    [tenantId, orgId, `Anomaly ${label}`],
  );
  await superuser.query(
    `INSERT INTO id_legal_entities (id, tenant_id, company_name, npwp_16) VALUES ($1::uuid, $2::uuid, $3, $4)`,
    [legalEntityId, tenantId, `PT Anomaly ${label}`, npwp],
  );
  await superuser.query(
    `INSERT INTO id_branches (
       id, tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr,
       geofence_lat, geofence_lng, geofence_radius_m
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'Asia/Jakarta', 5000000, -6.2, 106.816, 200)`,
    [branchId, tenantId, legalEntityId, `HQ ${label}`, nitku],
  );
  await superuser.query(
    `INSERT INTO hr_employees (
       id, tenant_id, employee_code, full_name, legal_entity_id, branch_id,
       employment_status, join_date, ptkp_status, tax_method, pph21_subject_type
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid,
       'active', '2024-01-15', 'TK/0', 'gross', 'permanent'
     )`,
    [employeeId, tenantId, code, name, legalEntityId, branchId],
  );
  return { tenantId, orgId, legalEntityId, branchId, employeeId, userId, name, code };
}

async function cleanup(superuser: pg.Client, companies: Company[]): Promise<void> {
  const tenants = companies.map((company) => company.tenantId);
  const orgs = companies.map((company) => company.orgId);
  await superuser.query("DELETE FROM att_clock_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_tenant_keys WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_employees WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_branches WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_legal_entities WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_tenants WHERE id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM ba_organization WHERE id = ANY($1::text[])", [orgs]);
}

async function clearPunches(superuser: pg.Client, tenantIds: string[]): Promise<void> {
  await superuser.query("DELETE FROM att_clock_events WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
}

async function punchCount(superuser: pg.Client, tenantId: string): Promise<number> {
  const result = await superuser.query("SELECT id FROM att_clock_events WHERE tenant_id = $1::uuid", [
    tenantId,
  ]);
  return result.rowCount ?? 0;
}

interface PunchSeed {
  reviewStatus: "ok" | "needs_review" | "reviewed";
  reasons?: string[];
  drift?: number;
  syncSource?: "online" | "offline_queue";
  geofenceOk?: boolean;
  distance?: number | null;
  speed?: number | null;
  livenessOk?: boolean | null;
  mock?: boolean;
  capturedAt: string;
}

async function insertPunch(superuser: pg.Client, company: Company, seed: PunchSeed): Promise<string> {
  const id = randomUUID();
  await superuser.query(
    `INSERT INTO att_clock_events (
       id, tenant_id, employee_id, branch_id, idempotency_key,
       punch_type, captured_at, received_at, clock_drift_seconds, sync_source,
       lat, lng, distance_meters, geofence_ok, speed_kmh,
       liveness_ok, mock_location_flag, review_status, review_reasons_json
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       'clock_in', $6::timestamptz, $6::timestamptz, $7, $8,
       -6.2, 106.816, $9, $10, $11,
       $12, $13, $14, $15::jsonb
     )`,
    [
      id,
      company.tenantId,
      company.employeeId,
      company.branchId,
      randomUUID(),
      seed.capturedAt,
      seed.drift ?? 1,
      seed.syncSource ?? "online",
      seed.distance ?? null,
      seed.geofenceOk ?? true,
      seed.speed ?? null,
      seed.livenessOk === undefined ? true : seed.livenessOk,
      seed.mock ?? false,
      seed.reviewStatus,
      JSON.stringify(seed.reasons ?? []),
    ],
  );
  return id;
}

function atMinute(minute: number): string {
  return new Date(Date.UTC(2026, 5, 1, 1, minute, 0)).toISOString();
}

function getInbox(app: FastifyInstance, actor: string, url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: "GET", url, headers: { "x-test-actor": actor } });
}

function postReview(
  app: FastifyInstance,
  actor: string,
  id: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/api/v1/attendance/anomalies/${id}/review`,
    headers: { "content-type": "application/json", "x-test-actor": actor },
    payload,
  });
}

function dataOf(response: LightMyRequestResponse): PendingAnomaly[] {
  assert.equal(response.statusCode, 200, response.body);
  return (JSON.parse(response.body) as { data: PendingAnomaly[] }).data;
}

function byId(rows: PendingAnomaly[], id: string): PendingAnomaly {
  const row = rows.find((item) => item.id === id);
  assert.ok(row);
  return row;
}

function codeOf(response: LightMyRequestResponse): string {
  return (JSON.parse(response.body) as { error: { code: string } }).error.code;
}
