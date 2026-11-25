import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyDatabaseUrls,
  loadRepoEnv,
  migrate,
  migrateEnvFrom,
  requiredEnv,
} from "@gotonghr/db";
import { ensureCredentialUser, migrateIdentity } from "@gotonghr/identity";
import {
  getEffectiveStatutoryTable,
  migratePlatform,
  openPlatformDatabase,
  registerPlatformOperator,
  type PlatformDatabase,
  type StatutoryTableRecord,
} from "@gotonghr/platform";
import pg from "pg";
import { composeFromEnv, type ComposedApp } from "./composition.ts";
import { provisionQueue } from "./queue.ts";

const { Client } = pg;

const origin = "http://127.0.0.1:3000";
const superEmail = "statutory-super@gotonghr.test";
const superPassword = "statutory-password-1";
const opsEmail = "statutory-ops@gotonghr.test";
const opsPassword = "statutory-password-2";

loadRepoEnv();
applyDatabaseUrls(process.env);

const synthetic = readRepoJson(
  "../../../packages/payroll-engine/src/__tests__/fixtures/synthetic-pph21.json",
);
const draftTable = readRepoJson("../../../packages/payroll-engine/src/tables/id-2026.draft.json");

function readRepoJson(relativePath: string): Record<string, unknown> {
  const file = fileURLToPath(new URL(relativePath, import.meta.url));
  const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Statutory fixture was not an object.");
  }
  return value as Record<string, unknown>;
}

function withWindow(from: string, to: string): Record<string, unknown> {
  const payload = structuredClone(synthetic);
  payload.effective_from = from;
  payload.effective_to = to;
  payload.status = "published";
  return payload;
}

describe("statutory publish", { concurrency: 1 }, () => {
  let composed: ComposedApp;
  let platform: PlatformDatabase;
  let operatorId = "";
  let superCookie = "";
  let opsCookie = "";
  const previousMode = process.env.GOTONG_DEPLOYMENT_MODE;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.GOTONG_DEPLOYMENT_MODE = "multi_tenant_saas";
    process.env.BETTER_AUTH_URL = origin;
    process.env.STORAGE_DRIVER ??= "local";
    process.env.STORAGE_LOCAL_SECRET = "local-test-storage-secret-0123456789";
    process.env.QUEUE_DRIVER ??= "pgboss";
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
    await provisionQueue(migrateEnv.migratorUrl);
    await superuserExec(`
      DROP TABLE IF EXISTS pay_statutory_snapshot_probe;
      CREATE TABLE pay_statutory_snapshot_probe (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        payroll_date date NOT NULL,
        statutory_table_id uuid NOT NULL,
        snapshot_json jsonb NOT NULL
      );
      REVOKE ALL ON TABLE pay_statutory_snapshot_probe FROM PUBLIC;
      GRANT SELECT, INSERT ON TABLE pay_statutory_snapshot_probe TO app_tenant;
    `);
    composed = await composeFromEnv(process.env);
    composedRef = composed;
    platform = await openPlatformDatabase(requiredEnv(process.env, "DATABASE_URL_PLATFORM"));
    const admin = await ensureCredentialUser(composed.auth, {
      email: superEmail,
      password: superPassword,
      name: "Statutory",
    });
    operatorId = (
      await registerPlatformOperator(platform, {
        authUserId: admin.id,
        role: "platform_super_admin",
      })
    ).id;
    const ops = await ensureCredentialUser(composed.auth, {
      email: opsEmail,
      password: opsPassword,
      name: "Ops",
    });
    await registerPlatformOperator(platform, {
      authUserId: ops.id,
      role: "platform_ops",
    });
    operatorIdForLock = operatorId;
    superCookie = await signedCookie(superEmail, superPassword);
    opsCookie = await signedCookie(opsEmail, opsPassword);
  });

  beforeEach(async () => {
    await superuserExec(`
      TRUNCATE TABLE pay_statutory_snapshot_probe, pay_statutory_tables, sys_platform_audit_events
    `);
  });

  after(async () => {
    if (previousMode === undefined) delete process.env.GOTONG_DEPLOYMENT_MODE;
    else process.env.GOTONG_DEPLOYMENT_MODE = previousMode;
    await composed?.close();
    await platform?.end();
    await superuserExec("DROP TABLE IF EXISTS pay_statutory_snapshot_probe");
  });

  it("rejects a draft status and a missing source, and leaves the row a draft", async () => {
    const draft = await createDraft(superCookie, {
      versionLabel: "shipped-2026-draft",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-12-31",
      payload: draftTable,
    });
    assert.equal(draft.statusCode, 201, draft.body);
    const draftId = readData<StatutoryTableRecord>(draft.body).id;
    const rejected = await publish(draftId, superCookie);
    assert.equal(rejected.statusCode, 422, rejected.body);
    assert.equal(readError(rejected.body), "invalid_statutory");
    assert.match(readMessage(rejected.body), /draft/);
    await assertStillDraft(draftId);
    assert.equal(await publishAuditCount(draftId), 0);

    const missing = await createDraft(superCookie, {
      versionLabel: "synthetic-missing-jp",
      effectiveFrom: "2030-01-01",
      effectiveTo: "2030-12-31",
      payload: { ...withWindow("2030-01-01", "2030-12-31"), jp_annual_wage_cap: { source: "missing" } },
    });
    assert.equal(missing.statusCode, 201, missing.body);
    const missingId = readData<StatutoryTableRecord>(missing.body).id;
    const missingPublish = await publish(missingId, superCookie);
    assert.equal(missingPublish.statusCode, 422, missingPublish.body);
    assert.match(readMessage(missingPublish.body), /missing/);
    await assertStillDraft(missingId);
    assert.equal(await publishAuditCount(missingId), 0);
  });

  it("publishes a complete synthetic table and writes the audit row in the same transaction", async () => {
    const created = await createDraft(superCookie, {
      versionLabel: "synthetic-2031-test-only",
      effectiveFrom: "2031-01-01",
      effectiveTo: "2031-12-31",
      payload: withWindow("2031-01-01", "2031-12-31"),
    });
    assert.equal(created.statusCode, 201, created.body);
    const id = readData<StatutoryTableRecord>(created.body).id;
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    const published = await publish(id, superCookie);
    assert.equal(published.statusCode, 200, published.body);
    const row = readData<StatutoryTableRecord>(published.body);
    assert.equal(row.status, "published");
    assert.equal(row.publishedByOperatorId, operatorId);
    assert.equal(typeof row.publishedAt, "string");
    assert.notEqual(row.publishedAt, null);
    const payload = row.payload as { fixture?: string; not_official?: boolean };
    assert.equal(payload.fixture, "synthetic");
    assert.equal(payload.not_official, true);
    const audits = await superuserQuery<{ action: string }>(
      `SELECT action FROM sys_platform_audit_events
       WHERE diff_json->>'id' = $1
       ORDER BY action`,
      [id],
    );
    assert.deepEqual(
      audits.map((audit) => audit.action),
      ["statutory.draft.create", "statutory.publish"],
    );
    const again = await publish(id, superCookie);
    assert.equal(again.statusCode, 409, again.body);
    assert.match(readMessage(again.body), /cannot be changed/);
    assert.equal(await publishAuditCount(id), 1);
  });

  it("rejects overlapping published dates from the API and from the database", async () => {
    const first = await publishWindow(superCookie, {
      versionLabel: "synthetic-2032-full",
      effectiveFrom: "2032-01-01",
      effectiveTo: "2032-12-31",
    });
    const overlap = await createDraft(superCookie, {
      versionLabel: "synthetic-2032-overlap",
      effectiveFrom: "2032-06-01",
      effectiveTo: "2033-01-31",
      payload: withWindow("2032-06-01", "2033-01-31"),
    });
    assert.equal(overlap.statusCode, 201, overlap.body);
    const overlapId = readData<StatutoryTableRecord>(overlap.body).id;
    const rejected = await publish(overlapId, superCookie);
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(readError(rejected.body), "conflict");
    assert.match(readMessage(rejected.body), /overlap/);
    await assertStillDraft(overlapId);
    assert.equal(await publishAuditCount(overlapId), 0);
    assert.equal(first.status, "published");

    const platformClient = new Client({
      connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM"),
    });
    await platformClient.connect();
    try {
      await assert.rejects(
        platformClient.query(publishedInsertSql, [
          "db-2032-touch",
          "2032-12-31",
          "2032-12-31",
          operatorId,
        ]),
        (error: unknown) => codeOf(error) === "23P01",
      );
      await assert.rejects(
        platformClient.query(publishedInsertSql, [
          "db-2032-span",
          "2031-06-01",
          "2032-01-01",
          operatorId,
        ]),
        (error: unknown) => codeOf(error) === "23P01",
      );
    } finally {
      await platformClient.end();
    }

    await assertOverlapsWhileLocked();
    const count = await superuserQuery<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pay_statutory_tables
       WHERE status = 'published' AND version_label LIKE 'lock-%'`,
    );
    assert.equal(count[0]?.count, "1");
  });

  it("publishes adjacent windows and returns the table that covers each payroll date", async () => {
    const closed = await publishWindow(superCookie, {
      versionLabel: "synthetic-2033-test-only",
      effectiveFrom: "2033-01-01",
      effectiveTo: "2033-12-31",
    });
    const openPayload = withWindow("2034-01-01", "2099-12-31");
    const openDraft = await createDraft(superCookie, {
      versionLabel: "synthetic-2034-open-test-only",
      effectiveFrom: "2034-01-01",
      effectiveTo: null,
      payload: openPayload,
    });
    assert.equal(openDraft.statusCode, 201, openDraft.body);
    const openId = readData<StatutoryTableRecord>(openDraft.body).id;
    const open = await publish(openId, superCookie);
    assert.equal(open.statusCode, 200, open.body);
    assert.equal(readData<StatutoryTableRecord>(open.body).effectiveTo, null);

    const insideOpen = await createDraft(superCookie, {
      versionLabel: "synthetic-2035-inside-open",
      effectiveFrom: "2035-01-01",
      effectiveTo: "2035-12-31",
      payload: withWindow("2035-01-01", "2035-12-31"),
    });
    const insideId = readData<StatutoryTableRecord>(insideOpen.body).id;
    const inside = await publish(insideId, superCookie);
    assert.equal(inside.statusCode, 409, inside.body);
    assert.match(readMessage(inside.body), /overlap/);

    const app = composed.appDb.pool;
    assert.equal((await getEffectiveStatutoryTable(app, "pph21", "2032-12-31"))?.id, undefined);
    assert.equal((await getEffectiveStatutoryTable(app, "pph21", "2033-01-01"))?.id, closed.id);
    assert.equal((await getEffectiveStatutoryTable(app, "pph21", "2033-12-31"))?.id, closed.id);
    assert.equal((await getEffectiveStatutoryTable(app, "pph21", "2034-01-01"))?.id, openId);
    assert.equal((await getEffectiveStatutoryTable(app, "pph21", "2036-06-01"))?.id, openId);
  });

  it("keeps a calculation snapshot after a later table is published", async () => {
    const older = await publishWindow(superCookie, {
      versionLabel: "synthetic-2037-snapshot",
      effectiveFrom: "2037-01-01",
      effectiveTo: "2037-12-31",
    });
    const app = composed.appDb.pool;
    const effective = await getEffectiveStatutoryTable(app, "pph21", "2037-06-15");
    assert.equal(effective?.id, older.id);
    const stored = await app.query<{ id: string }>(
      `INSERT INTO pay_statutory_snapshot_probe (payroll_date, statutory_table_id, snapshot_json)
       VALUES ($1::date, $2::uuid, $3::jsonb)
       RETURNING id`,
      ["2037-06-15", older.id, JSON.stringify(effective?.payload)],
    );
    const snapshotId = stored.rows[0]?.id;
    assert.ok(snapshotId);
    const before = await snapshotJson(snapshotId);

    await publishWindow(superCookie, {
      versionLabel: "synthetic-2038-later",
      effectiveFrom: "2038-01-01",
      effectiveTo: "2038-12-31",
    });

    assert.deepEqual(await snapshotJson(snapshotId), before);
    const live = await superuserQuery<{ payload_json: unknown }>(
      "SELECT payload_json FROM pay_statutory_tables WHERE id = $1::uuid",
      [older.id],
    );
    assert.deepEqual(live[0]?.payload_json, before);
    assert.equal((await getEffectiveStatutoryTable(app, "pph21", "2037-06-15"))?.id, older.id);
    assert.equal(
      (await getEffectiveStatutoryTable(app, "pph21", "2038-03-01"))?.versionLabel,
      "synthetic-2038-later",
    );

    const writer = new Client({
      connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM"),
    });
    await writer.connect();
    try {
      await assert.rejects(
        writer.query(
          `UPDATE pay_statutory_tables
           SET payload_json = payload_json || '{"touched":true}'::jsonb
           WHERE id = $1::uuid`,
          [older.id],
        ),
        (error: unknown) => codeOf(error) === "55000",
      );
      await assert.rejects(
        writer.query("DELETE FROM pay_statutory_tables WHERE id = $1::uuid", [older.id]),
        (error: unknown) => codeOf(error) === "55000",
      );
    } finally {
      await writer.end();
    }
    assert.deepEqual(await snapshotJson(snapshotId), before);
  });

  it("gives platform_ops 403 and lets app_tenant read published rows only", async () => {
    const published = await publishWindow(superCookie, {
      versionLabel: "synthetic-2039-read",
      effectiveFrom: "2039-01-01",
      effectiveTo: "2039-12-31",
    });
    const hidden = await createDraft(superCookie, {
      versionLabel: "synthetic-2040-hidden",
      effectiveFrom: "2040-01-01",
      effectiveTo: "2040-12-31",
      payload: withWindow("2040-01-01", "2040-12-31"),
    });
    const hiddenId = readData<StatutoryTableRecord>(hidden.body).id;

    const opsCreate = await createDraft(opsCookie, {
      versionLabel: "ops-draft",
      effectiveFrom: "2041-01-01",
      effectiveTo: "2041-12-31",
      payload: withWindow("2041-01-01", "2041-12-31"),
    });
    assert.equal(opsCreate.statusCode, 403, opsCreate.body);
    assert.equal(readError(opsCreate.body), "forbidden");
    const opsPublish = await publish(hiddenId, opsCookie);
    assert.equal(opsPublish.statusCode, 403, opsPublish.body);
    assert.equal(readError(opsPublish.body), "forbidden");
    await assertStillDraft(hiddenId);
    const opsList = await get("/api/v1/platform/statutory-tables", opsCookie);
    assert.equal(opsList.statusCode, 200, opsList.body);

    const app = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_APP") });
    await app.connect();
    try {
      const role = await app.query<{ current_user: string; rolbypassrls: boolean }>(
        `SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      assert.equal(role.rows[0]?.current_user, "app_tenant");
      assert.equal(role.rows[0]?.rolbypassrls, false);
      const visible = await app.query<{ id: string }>(
        "SELECT id FROM pay_statutory_tables ORDER BY id",
      );
      assert.deepEqual(
        visible.rows.map((row) => row.id),
        [published.id],
      );
      const drafts = await app.query("SELECT id FROM pay_statutory_tables WHERE status = 'draft'");
      assert.equal(drafts.rowCount, 0);
      await assert.rejects(
        app.query(publishedInsertSql, ["tenant-insert", "2042-01-01", "2042-12-31", operatorId]),
        (error: unknown) => codeOf(error) === "42501",
      );
      await assert.rejects(
        app.query("UPDATE pay_statutory_tables SET version_label = version_label"),
        (error: unknown) => codeOf(error) === "42501",
      );
      await assert.rejects(
        app.query("DELETE FROM pay_statutory_tables"),
        (error: unknown) => codeOf(error) === "42501",
      );
    } finally {
      await app.end();
    }

    const admin = new Client({
      connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM"),
    });
    await admin.connect();
    try {
      const role = await admin.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      assert.equal(role.rows[0]?.rolbypassrls, false);
      await assert.rejects(
        admin.query(publishedInsertSql, ["bad-order", "2043-12-31", "2043-01-01", operatorId]),
        (error: unknown) => codeOf(error) === "23514",
      );
    } finally {
      await admin.end();
    }
  });

  it("rejects a payload whose dates do not match a closed draft", async () => {
    const created = await createDraft(superCookie, {
      versionLabel: "synthetic-2044-mismatch",
      effectiveFrom: "2044-01-01",
      effectiveTo: "2044-12-31",
      payload: withWindow("2044-01-01", "2044-06-30"),
    });
    assert.equal(created.statusCode, 201, created.body);
    const id = readData<StatutoryTableRecord>(created.body).id;
    const rejected = await publish(id, superCookie);
    assert.equal(rejected.statusCode, 422, rejected.body);
    assert.match(readMessage(rejected.body), /effective dates/);
    await assertStillDraft(id);

    const badDay = await createDraft(superCookie, {
      versionLabel: "bad-day",
      effectiveFrom: "2044-02-31",
      effectiveTo: "2044-03-01",
      payload: withWindow("2044-01-01", "2044-03-01"),
    });
    assert.equal(badDay.statusCode, 400, badDay.body);
  });
});

const publishedInsertSql = `
  INSERT INTO pay_statutory_tables (
    rule_type, version_label, effective_from, effective_to, status, payload_json,
    created_by_operator_id, published_by_operator_id, published_at
  ) VALUES (
    'pph21', $1, $2::date, $3::date, 'published',
    '{"note":"database test, not a DJP table"}'::jsonb,
    $4::uuid, $4::uuid, now()
  )
`;

async function publishWindow(
  cookie: string,
  input: { versionLabel: string; effectiveFrom: string; effectiveTo: string },
): Promise<StatutoryTableRecord> {
  const created = await createDraft(cookie, {
    ...input,
    payload: withWindow(input.effectiveFrom, input.effectiveTo),
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = readData<StatutoryTableRecord>(created.body).id;
  const published = await publish(id, cookie);
  assert.equal(published.statusCode, 200, published.body);
  return readData<StatutoryTableRecord>(published.body);
}

async function assertStillDraft(id: string): Promise<void> {
  const rows = await superuserQuery<{ status: string; published_at: Date | null }>(
    "SELECT status, published_at FROM pay_statutory_tables WHERE id = $1::uuid",
    [id],
  );
  assert.equal(rows[0]?.status, "draft");
  assert.equal(rows[0]?.published_at, null);
}

async function publishAuditCount(id: string): Promise<number> {
  const rows = await superuserQuery<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM sys_platform_audit_events
     WHERE action = 'statutory.publish' AND diff_json->>'id' = $1`,
    [id],
  );
  return Number(rows[0]?.count ?? 0);
}

async function snapshotJson(id: string): Promise<unknown> {
  const rows = await superuserQuery<{ snapshot_json: unknown }>(
    "SELECT snapshot_json FROM pay_statutory_snapshot_probe WHERE id = $1::uuid",
    [id],
  );
  return rows[0]?.snapshot_json;
}

async function assertOverlapsWhileLocked(): Promise<void> {
  const first = new Client({
    connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM"),
  });
  const second = new Client({
    connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM"),
  });
  await first.connect();
  await second.connect();
  let pending: Promise<unknown> = Promise.resolve();
  try {
    await second.query("SET statement_timeout = '3s'");
    await first.query("BEGIN");
    await first.query(publishedInsertSql, ["lock-open", "2020-01-01", "2020-12-31", operatorIdRef()]);
    const locks = await first.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_locks
       WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()`,
    );
    assert.notEqual(locks.rows[0]?.count, "0");
    let settled = false;
    pending = second.query("BEGIN").then(() =>
      second.query(publishedInsertSql, ["lock-overlap", "2020-06-01", "2020-12-31", operatorIdRef()]),
    );
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(settled, false);
    await first.query("COMMIT");
    await assert.rejects(pending, (error: unknown) => codeOf(error) === "23P01");
  } finally {
    await pending.catch(() => undefined);
    await second.query("ROLLBACK").catch(() => undefined);
    await first.query("ROLLBACK").catch(() => undefined);
    await first.end();
    await second.end();
  }
}

let operatorIdForLock = "";

function operatorIdRef(): string {
  if (!operatorIdForLock) throw new Error("operator is not ready");
  return operatorIdForLock;
}

function createDraft(
  cookie: string,
  input: {
    versionLabel: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    payload: Record<string, unknown>;
  },
) {
  return post("/api/v1/platform/statutory-tables", { ruleType: "pph21", ...input }, cookie);
}

function publish(id: string, cookie: string) {
  return post(`/api/v1/platform/statutory-tables/${id}/publish`, {}, cookie);
}

function get(url: string, cookie?: string) {
  return request("GET", url, undefined, cookie);
}

function post(url: string, body: Record<string, unknown>, cookie?: string) {
  return request("POST", url, body, cookie);
}

let composedRef: ComposedApp | undefined;

function request(
  method: "GET" | "POST",
  url: string,
  body?: Record<string, unknown>,
  cookie?: string,
) {
  if (!composedRef) throw new Error("app is not ready");
  return composedRef.app.inject({
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

async function signedCookie(email: string, password: string): Promise<string> {
  const signedIn = await post("/api/auth/sign-in/email", { email, password });
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  return cookieHeader(setCookies(signedIn));
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

function readMessage(body: string): string {
  const parsed = JSON.parse(body) as { error?: { message?: string } | null };
  return parsed.error?.message ?? "";
}

function readData<T>(body: string): T {
  const parsed = JSON.parse(body) as { data: T };
  return parsed.data;
}

function codeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
}

async function superuserQuery<T extends pg.QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<T[]> {
  const admin = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
  await admin.connect();
  try {
    const result = await admin.query<T>(text, values);
    return result.rows;
  } finally {
    await admin.end();
  }
}

async function superuserExec(text: string): Promise<void> {
  await superuserQuery(text);
}
