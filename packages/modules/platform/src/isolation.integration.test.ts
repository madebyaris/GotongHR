import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createSupportGrantAuditPort, provisionTenantKeys, verifyTenantHashChain } from "@gotonghr/audit";
import { asCiphertext, revealPii } from "@gotonghr/audit/reveal";
import { encryptField, loadKek, unwrapDek } from "@gotonghr/crypto";
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
import { registerPlatformOperator } from "./tenants.ts";

const { Client } = pg;

await assertPostgresReachable();

const nik = "3273011508950001";
const nikMiddle = nik.slice(4, 12);
const standIns = ["hr_secret", "att_secret", "pay_run"] as const;
const deniedTables = [
  "hr_secret",
  "att_secret",
  "pay_run",
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
