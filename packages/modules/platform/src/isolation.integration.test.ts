import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createSupportGrantAuditPort, provisionTenantKeys, readTenantSecrets, verifyTenantHashChain } from "@gotonghr/audit";
import { asCiphertext, revealPii } from "@gotonghr/audit/reveal";
import { blindIndex, encryptField, loadKek, maskNik, unwrapDek } from "@gotonghr/crypto";
import Fastify from "fastify";
import {
  APP_ROLE,
  PLATFORM_ROLE,
  QUEUE_ROLE,
  assertPostgresReachable,
  createTenantDatabase,
  requiredEnv,
  tenantIsolationPolicySql,
  type TenantDatabase,
} from "@gotonghr/db";
import { sql } from "drizzle-orm";
import pg from "pg";
import { openPlatformDatabase, type PlatformDatabase } from "./db.ts";
import {
  activateSupportGrant,
  createSupportGrant,
  revokeSupportGrant,
  withSupportSession,
} from "./grants.ts";
import { applyTenantSchema } from "./isolation-schema.ts";
import { registerPlatform } from "./routes.ts";
import { registerPlatformOperator } from "./tenants.ts";

const { Client } = pg;

await assertPostgresReachable();

const nik = "3273011508950001";
const nikMiddle = nik.slice(4, 12);
const standIns = ["hr_secret", "att_secret", "pay_run"] as const;
const deniedTables = [
  "ai_action_proposals",
  "ai_conversations",
  "ai_messages",
  "att_approval_delegations",
  "att_daily_summaries",
  "att_holidays",
  "att_leave_balances",
  "att_leave_requests",
  "att_leave_types",
  "att_overtime_requests",
  "att_rosters",
  "att_shifts",
  "hr_compensation_profiles",
  "hr_contract_expiry_notices",
  "hr_contracts",
  "hr_departments",
  "hr_documents",
  "hr_employee_pii",
  "hr_employees",
  "hr_import_jobs",
  "hr_positions",
  "hr_secret",
  "att_clock_events",
  "att_secret",
  "pay_exports",
  "pay_run",
  "pay_run_items",
  "pay_runs",
  "tenant_exports",
  "id_memberships",
  "id_legal_entities",
  "id_branches",
  "aud_pii_access_logs",
  "aud_tenant_keys",
] as const;

describe("support grant isolation", { concurrency: 1 }, () => {
  let app: TenantDatabase | undefined;
  let platformDb: PlatformDatabase | undefined;
  let platform: pg.Client | undefined;
  let superuser: pg.Client | undefined;
  let tenantA = "";
  let tenantB = "";
  let orgA = "";
  let orgB = "";
  let operatorId = "";
  let grantedBy = "";
  const previousKek = process.env.GOTONG_PII_KEK;
  const previousChain = process.env.AUDIT_HASH_CHAIN;

  before(async () => {
    process.env.GOTONG_PII_KEK = "7a".repeat(32);
    process.env.AUDIT_HASH_CHAIN = "on";
    await applyTenantSchema();
    app = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    platformDb = await openPlatformDatabase(requiredEnv(process.env, "DATABASE_URL_PLATFORM"));
    platform = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM") });
    superuser = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await platform.connect();
    await superuser.connect();
    await createStandIns(superuser);
    const seeded = await insertTenants(superuser);
    tenantA = seeded.tenantA;
    tenantB = seeded.tenantB;
    orgA = seeded.orgA;
    orgB = seeded.orgB;
    await app.withTenantContext(tenantA, (tx) => provisionTenantKeys(tx, tenantA));
    await app.withTenantContext(tenantB, (tx) => provisionTenantKeys(tx, tenantB));
    grantedBy = randomUUID();
    operatorId = (
      await registerPlatformOperator(platformDb, {
        authUserId: `op-${tenantA}`,
        role: "platform_ops",
      })
    ).id;
  });

  after(async () => {
    if (superuser && tenantA && tenantB) {
      await deleteTenants(superuser, {
        tenantA,
        tenantB,
        orgA,
        orgB,
        operatorId,
      }).catch(() => undefined);
      await dropStandIns(superuser).catch(() => undefined);
    }
    await app?.end();
    await platformDb?.end();
    await platform?.end();
    await superuser?.end();
    restoreEnv("GOTONG_PII_KEK", previousKek);
    restoreEnv("AUDIT_HASH_CHAIN", previousChain);
  });

  it("refuses PII reveal when the live grant disallows it, and writes both audit logs", async () => {
    if (!app || !platformDb || !platform || !superuser) {
      throw new Error("isolation setup did not open the database");
    }
    const audit = createSupportGrantAuditPort(app);
    const hidden = await createSupportGrant(app, audit, {
      tenantId: tenantA,
      grantedByUserId: grantedBy,
      granteePlatformUserId: operatorId,
      reason: "isolation reveal denied",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: "read_write",
      allowPiiReveal: false,
      ip: null,
    });
    const activated = await activateSupportGrant(platformDb, app, audit, {
      token: hidden.token,
      actorId: operatorId,
      ip: null,
    });
    assert.equal(activated.allowPiiReveal, false);
    assert.equal(activated.tenantId, tenantA);

    for (const table of deniedTables) {
      await assertDeniedOrEmpty(platform, `SELECT id FROM ${table}`);
    }

    const ciphertext = asCiphertext(encryptField(await tenantDek(superuser, tenantA), tenantA, "nik", nik));
    await assert.rejects(
      withSupportSession(
        platformDb,
        app,
        audit,
        { sessionToken: activated.sessionToken, actorId: operatorId, ip: null },
        async ({ tx, allowPiiReveal }) => {
          assert.equal(allowPiiReveal, false);
          for (const table of standIns) {
            const statement = `SELECT marker FROM ${table}`;
            assert.equal(/\bwhere\b/iu.test(statement), false);
            const markers = rows<{ marker: string }>(await tx.execute(sql.raw(statement)));
            assert.deepEqual(markers.map((row) => row.marker).sort(), ["a"], table);
          }
          const keys = rows<{ n: number }>(
            await tx.execute(sql`SELECT count(*)::int AS n FROM aud_tenant_keys`),
          );
          assert.equal(Number(keys[0]?.n), 1);
          await revealPii(
            tx,
            {
              tenantId: tenantA,
              userId: grantedBy,
              permissions: ["employee.pii.reveal"],
              supportGrantAllowPiiReveal: allowPiiReveal,
            },
            {
              field: "nik",
              ciphertext,
              resourceType: "hr_employee_pii",
              resourceId: randomUUID(),
              reason: "payroll check",
            },
          );
        },
      ),
      (error: unknown) => denialCode(error) === "403:pii_reveal_denied",
    );

    const leaked = await superuser.query<{ n: number; body: string }>(
      `SELECT count(*)::int AS n, coalesce(string_agg(row_to_json(l)::text, ''), '') AS body
       FROM aud_pii_access_logs l
       WHERE tenant_id = $1`,
      [tenantA],
    );
    assert.equal(leaked.rows[0]?.n, 0);
    assert.equal(leaked.rows[0]?.body.includes(nik), false);
    assert.equal(leaked.rows[0]?.body.includes(nikMiddle), false);
    await assertActions(superuser, hidden.id, {
      platform: ["support_grant.activate", "support_grant.session"],
      tenant: ["support_grant.create", "support_grant.activate", "support_grant.session"],
    });

    const opened = await createSupportGrant(app, audit, {
      tenantId: tenantA,
      grantedByUserId: grantedBy,
      granteePlatformUserId: operatorId,
      reason: "isolation reveal allowed",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: "read_write",
      allowPiiReveal: true,
      ip: null,
    });
    const allowed = await activateSupportGrant(platformDb, app, audit, {
      token: opened.token,
      actorId: operatorId,
      ip: null,
    });
    const revealed = await withSupportSession(
      platformDb,
      app,
      audit,
      { sessionToken: allowed.sessionToken, actorId: operatorId, ip: null },
      async ({ tx, allowPiiReveal }) => {
        assert.equal(allowPiiReveal, true);
        return revealPii(
          tx,
          {
            tenantId: tenantA,
            userId: grantedBy,
            permissions: ["employee.pii.reveal"],
            supportGrantAllowPiiReveal: allowPiiReveal,
          },
          {
            field: "nik",
            ciphertext,
            resourceType: "hr_employee_pii",
            resourceId: randomUUID(),
            reason: "payroll check",
          },
        );
      },
    );
    assert.equal(revealed.result, nik);
    const logged = await superuser.query<{ n: number; body: string }>(
      `SELECT count(*)::int AS n, coalesce(string_agg(row_to_json(l)::text, ''), '') AS body
       FROM aud_pii_access_logs l
       WHERE tenant_id = $1`,
      [tenantA],
    );
    assert.equal(logged.rows[0]?.n, 1);
    assert.equal(logged.rows[0]?.body.includes(nik), false);
    assert.equal(logged.rows[0]?.body.includes(nikMiddle), false);

    await revokeSupportGrant(app, audit, {
      tenantId: tenantA,
      grantId: hidden.id,
      actorUserId: grantedBy,
      ip: null,
    });
    const platformRevoke = await superuser.query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM sys_platform_audit_events
       WHERE support_grant_id = $1 AND action = 'support_grant.revoke'`,
      [hidden.id],
    );
    const tenantRevoke = await superuser.query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM aud_events
       WHERE support_grant_id = $1 AND action = 'support_grant.revoke'`,
      [hidden.id],
    );
    assert.equal(platformRevoke.rows[0]?.n, 0);
    assert.equal(tenantRevoke.rows[0]?.n, 1);

    const chain = await app.withTenantContext(tenantA, (tx) => verifyTenantHashChain(tx, tenantA));
    assert.equal(chain.ok, true);
    if (chain.ok) assert.equal(chain.chained, true);
  });

  it("GET /api/v1/platform/health/tenants returns counters and no NIK", async () => {
    if (!app || !platformDb || !superuser) throw new Error("isolation setup did not open the database");
    const database = app;
    const admin = superuser;
    const healthName = "Sari Wulandari";
    const healthEmail = `sari-${tenantA}@health.test`;
    const healthNpwp = "1000000000000099";
    const secrets = await database.withTenantContext(tenantA, (tx) => readTenantSecrets(tx, tenantA));
    const ciphertext = encryptField(secrets.dek, tenantA, "nik", nik);
    const userId = randomUUID();
    const roleId = randomUUID();
    const membershipId = randomUUID();
    const entityId = randomUUID();
    const branchId = randomUUID();
    const employeeId = randomUUID();
    const piiId = randomUUID();
    const clockId = randomUUID();
    const documentId = randomUUID();
    const runId = randomUUID();
    const itemId = randomUUID();
    const exportId = randomUUID();
    await admin.query("BEGIN");
    try {
      await admin.query(
        `INSERT INTO id_roles (id, tenant_id, code, permissions)
         VALUES ($1, $2, 'org_owner', ARRAY['employee.pii.reveal']::text[])`,
        [roleId, tenantA],
      );
      await admin.query(
        `INSERT INTO id_users (id, tenant_id, auth_user_id, email, display_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, tenantA, `health-${tenantA}`, healthEmail, healthName],
      );
      await admin.query(
        `INSERT INTO id_memberships (id, tenant_id, user_id, auth_user_id, role_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [membershipId, tenantA, userId, `health-${tenantA}`, roleId],
      );
      await admin.query(
        `INSERT INTO id_legal_entities (id, tenant_id, company_name, npwp_16)
         VALUES ($1, $2, 'PT Health', $3)`,
        [entityId, tenantA, healthNpwp],
      );
      await admin.query(
        `INSERT INTO id_branches (id, tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr)
         VALUES ($1, $2, $3, 'HQ', '2200000000000000000099', 'Asia/Jakarta', 5000000)`,
        [branchId, tenantA, entityId],
      );
      await admin.query(
        `INSERT INTO hr_employees (
           id, tenant_id, employee_code, full_name, legal_entity_id, branch_id,
           employment_status, join_date, ptkp_status, tax_method, pph21_subject_type, date_of_birth
         ) VALUES (
           $1, $2, 'H001', $3, $4, $5, 'active', '2024-01-15', 'TK/0', 'gross', 'permanent', '1990-04-02'
         )`,
        [employeeId, tenantA, healthName, entityId, branchId],
      );
      await admin.query(
        `INSERT INTO hr_employee_pii (id, tenant_id, employee_id, nik_enc, nik_hash, nik_mask)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [piiId, tenantA, employeeId, ciphertext, blindIndex(secrets.pepper, nik), maskNik(nik)],
      );
      await admin.query(
        `INSERT INTO att_clock_events (
           id, tenant_id, employee_id, branch_id, idempotency_key,
           punch_type, captured_at, received_at, clock_drift_seconds,
           sync_source, lat, lng, geofence_ok, review_status
         ) VALUES (
           $1, $2, $3, $4, $5, 'clock_in', now(), now(), 0, 'online', -6.2, 106.8, true, 'ok'
         )`,
        [clockId, tenantA, employeeId, branchId, randomUUID()],
      );
      await admin.query(
        `INSERT INTO hr_documents (
           id, tenant_id, employee_id, doc_type, file_name, storage_key, content_type, byte_size, uploaded_by
         ) VALUES (
           $1, $2, $3, 'ktp', 'ktp-health.pdf', $4, 'application/pdf', 4096, $5
         )`,
        [documentId, tenantA, employeeId, `t/${tenantA}/emp/${employeeId}/doc/${documentId}/ktp-health.pdf`, userId],
      );
      await admin.query(
        `INSERT INTO pay_runs (id, tenant_id, legal_entity_id, period_year_month)
         VALUES ($1, $2, $3, '2026-03')`,
        [runId, tenantA, entityId],
      );
      await admin.query(
        `INSERT INTO pay_run_items (
           id, tenant_id, run_id, employee_id,
           employee_snapshot_json, attendance_snapshot_json, earnings_json, deductions_json,
           bpjs_json, pph21_json, gross_idr, tax_idr, net_idr
         ) VALUES (
           $1, $2, $3, $4,
           $5::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 0, 0
         )`,
        [
          itemId,
          tenantA,
          runId,
          employeeId,
          JSON.stringify({ nik, fullName: healthName }),
        ],
      );
      await admin.query(
        `INSERT INTO pay_exports (id, tenant_id, run_id, export_kind, storage_key, checksum_sha256, byte_size)
         VALUES ($1, $2, $3, 'coretax', $4, $5, 128)`,
        [exportId, tenantA, runId, `exports/${tenantA}/${runId}/coretax-${exportId}.xml`, "ab".repeat(32)],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }

    const http = Fastify({ logger: false });
    try {
      await registerPlatform(http, {
        platform: platformDb,
        app: database,
        tenantAudit: createSupportGrantAuditPort(database),
        mountPlatformRoutes: true,
        inviteSecret: "isolation-invite-secret-0123456789",
        hashOwnerPassword: async () => "unused",
        readPlatformActor: async () => ({
          kind: "ok",
          actor: { id: operatorId, role: "platform_ops", ip: null },
        }),
        readTenantAdmin: async () => ({
          kind: "denied",
          status: 401,
          code: "unauthenticated",
          message: "Sign in required.",
        }),
        readTenantOwner: async () => ({
          kind: "denied",
          status: 401,
          code: "unauthenticated",
          message: "Sign in required.",
        }),
        enqueueTenantExport: async () => undefined,
        presignExportDownload: async () => ({ url: "/unused" }),
        verifyStatutoryPayload: () => ({
          ok: true,
          ruleType: "pph21",
          effectiveFrom: "2026-01-01",
          effectiveTo: "2026-12-31",
        }),
      });
      const response = await http.inject({ method: "GET", url: "/api/v1/platform/health/tenants" });
      assert.equal(response.statusCode, 200, response.body);
      const parsed = JSON.parse(response.body) as {
        data: Array<{
          tenantId: string;
          activeUsers: number;
          peakClockIns: number;
          queueDepth: number;
          storageBytes: number;
          webhookFailureRate: null;
        }>;
      };
      const row = parsed.data.find((item) => item.tenantId === tenantA);
      assert.ok(row);
      assert.equal(row.activeUsers, 1);
      assert.equal(row.peakClockIns, 1);
      assert.equal(row.queueDepth, 0);
      assert.equal(row.storageBytes, 4224);
      assert.equal(row.webhookFailureRate, null);
      assert.equal(response.body.includes(nik), false);
      assert.equal(response.body.includes(ciphertext), false);
      assert.equal(response.body.includes(healthName), false);
      assert.equal(response.body.includes(healthEmail), false);
      assert.equal(response.body.includes(healthNpwp), false);
      assert.equal(response.body.includes(maskNik(nik)), false);
      assert.equal(/\d{16}/.test(response.body), false);
    } finally {
      await http.close();
      await admin.query("DELETE FROM pay_exports WHERE tenant_id = $1::uuid", [tenantA]);
      await admin.query("DELETE FROM pay_run_items WHERE tenant_id = $1::uuid", [tenantA]);
      await admin.query("DELETE FROM pay_runs WHERE tenant_id = $1::uuid", [tenantA]);
    }
  });
});

function restoreEnv(name: "GOTONG_PII_KEK" | "AUDIT_HASH_CHAIN", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const value = (result as { rows?: unknown }).rows;
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

function permissionCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function denialCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
    if (
      "statusCode" in current &&
      "code" in current &&
      typeof current.statusCode === "number" &&
      typeof current.code === "string"
    ) {
      return `${current.statusCode}:${current.code}`;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

async function assertDeniedOrEmpty(
  queryable: { query: pg.Client["query"] },
  statement: string,
): Promise<void> {
  try {
    const result = await queryable.query(statement);
    assert.equal(result.rows.length, 0, statement);
  } catch (error) {
    assert.equal(permissionCode(error), "42501", statement);
  }
}

async function assertActions(
  superuser: pg.Client,
  grantId: string,
  expected: { platform: string[]; tenant: string[] },
): Promise<void> {
  const platformRows = await superuser.query<{ action: string }>(
    `SELECT action FROM sys_platform_audit_events WHERE support_grant_id = $1 ORDER BY created_at, action`,
    [grantId],
  );
  const tenantRows = await superuser.query<{ action: string }>(
    `SELECT action FROM aud_events WHERE support_grant_id = $1 ORDER BY chain_seq, action`,
    [grantId],
  );
  assert.deepEqual(platformRows.rows.map((row) => row.action), expected.platform);
  assert.deepEqual(tenantRows.rows.map((row) => row.action), expected.tenant);
}

async function tenantDek(superuser: pg.Client, tenantId: string): Promise<Buffer> {
  const wrapped = await superuser.query<{ wrapped_dek: string }>(
    "SELECT wrapped_dek FROM aud_tenant_keys WHERE tenant_id = $1",
    [tenantId],
  );
  const value = wrapped.rows[0]?.wrapped_dek;
  assert.ok(value);
  return unwrapDek(loadKek(process.env), value, tenantId);
}

async function createStandIns(superuser: pg.Client): Promise<void> {
  await dropStandIns(superuser);
  for (const table of standIns) {
    await superuser.query(`
      CREATE TABLE ${table} (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL,
        marker text NOT NULL
      )
    `);
    await superuser.query(tenantIsolationPolicySql(table));
    await superuser.query(`REVOKE ALL ON TABLE ${table} FROM PUBLIC`);
    await superuser.query(`REVOKE ALL ON TABLE ${table} FROM ${PLATFORM_ROLE}`);
    await superuser.query(`REVOKE ALL ON TABLE ${table} FROM ${QUEUE_ROLE}`);
    await superuser.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO ${APP_ROLE}`);
  }
}

async function insertTenants(
  superuser: pg.Client,
): Promise<{ tenantA: string; tenantB: string; orgA: string; orgB: string }> {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const orgA = `org-${tenantA}`;
  const orgB = `org-${tenantB}`;
  await superuser.query("BEGIN");
  try {
    await superuser.query(
      `INSERT INTO ba_organization (id, name, slug) VALUES ($1, 'Grant A', $1), ($2, 'Grant B', $2)`,
      [orgA, orgB],
    );
    await superuser.query(
      `INSERT INTO id_tenants (id, organization_id, name, slug)
       VALUES ($1::uuid, $3, 'Grant A', $3), ($2::uuid, $4, 'Grant B', $4)`,
      [tenantA, tenantB, orgA, orgB],
    );
    for (const table of standIns) {
      await superuser.query(
        `INSERT INTO ${table} (tenant_id, marker) VALUES ($1, 'a'), ($2, 'b')`,
        [tenantA, tenantB],
      );
    }
    await superuser.query("COMMIT");
  } catch (error) {
    await superuser.query("ROLLBACK");
    throw error;
  }
  return { tenantA, tenantB, orgA, orgB };
}

async function dropStandIns(superuser: pg.Client): Promise<void> {
  for (const table of standIns) {
    const existing = await superuser.query<{ rel: string | null }>(
      "SELECT to_regclass($1) AS rel",
      [`public.${table}`],
    );
    if (!existing.rows[0]?.rel) continue;
    const marker = await superuser.query(
      `SELECT 1
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1 AND a.attname = 'marker' AND NOT a.attisdropped`,
      [table],
    );
    if ((marker.rowCount ?? 0) === 0) {
      throw new Error(`${table} exists and is not an isolation stand-in.`);
    }
    await superuser.query(`DROP TABLE ${table}`);
  }
}

async function deleteTenants(
  superuser: pg.Client,
  ids: { tenantA: string; tenantB: string; orgA: string; orgB: string; operatorId: string },
): Promise<void> {
  const tenants = [ids.tenantA, ids.tenantB];
  await superuser.query("DELETE FROM pay_exports WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM pay_run_items WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM pay_runs WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM tenant_exports WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_pii_access_logs WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_outbox_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_tenant_keys WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM sys_platform_audit_events WHERE target_tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM sys_support_grants WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_tenants WHERE id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM ba_organization WHERE id = ANY($1::text[])", [[ids.orgA, ids.orgB]]);
  if (ids.operatorId) {
    await superuser.query("DELETE FROM sys_platform_operators WHERE id = $1::uuid", [ids.operatorId]);
  }
}
