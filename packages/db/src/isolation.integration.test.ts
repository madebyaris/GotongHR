import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { maskNik } from "@gotonghr/crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { createTenantDatabase, type TenantDatabase } from "./client.ts";
import { requiredEnv } from "./env.ts";
import { APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE } from "./migrate.ts";
import { tenantIsolationPolicySql } from "./policy.ts";
import { assertPostgresReachable } from "./require-database.ts";

const execFileAsync = promisify(execFile);

const { Client } = pg;

await assertPostgresReachable();

const standIns = ["hr_secret", "att_secret", "pay_run"] as const;

const requiredTenantTables = [
  "ai_action_proposals",
  "ai_conversations",
  "ai_knowledge_chunks",
  "ai_messages",
  "att_approval_delegations",
  "att_daily_summaries",
  "att_holidays",
  "att_leave_balances",
  "att_leave_requests",
  "att_leave_types",
  "att_overtime_requests",
  "att_rosters",
  "att_secret",
  "att_shifts",
  "aud_events",
  "aud_outbox_events",
  "aud_pii_access_logs",
  "aud_tenant_keys",
  "hr_employee_pii",
  "hr_employees",
  "hr_secret",
  "id_branches",
  "id_legal_entities",
  "id_memberships",
  "id_roles",
  "id_sessions",
  "id_users",
  "pay_run",
  "rls_probe",
  "sys_support_grants",
] as const;

const platformDeniedTables = [
  "ai_action_proposals",
  "ai_conversations",
  "ai_knowledge_chunks",
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
  "hr_employee_pii",
  "hr_employees",
  "hr_secret",
  "att_secret",
  "pay_run",
  "id_memberships",
  "id_legal_entities",
  "id_branches",
  "aud_pii_access_logs",
  "aud_tenant_keys",
] as const;

const appendOnlyTables = ["aud_events", "aud_pii_access_logs", "aud_tenant_keys"] as const;

interface Seed {
  tenantA: string;
  tenantB: string;
  orgA: string;
  orgB: string;
  authA: string;
  authB: string;
  sessionA: string;
  sessionB: string;
  operatorId: string;
  ids: Map<string, { a: string; b: string }>;
}

class RollbackProbe extends Error {
  constructor() {
    super("rollback probe");
    this.name = "RollbackProbe";
  }
}

function ident(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error(`invalid identifier: ${value}`);
  return value;
}

function permissionCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function isRollback(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
    if (current instanceof RollbackProbe) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function rowsOf(result: unknown): Array<{ id: string; tenant_id?: string }> {
  if (Array.isArray(result)) return result as Array<{ id: string; tenant_id?: string }>;
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Array<{ id: string; tenant_id?: string }>;
  }
  return [];
}

describe("tenant isolation", { concurrency: 1 }, () => {
  let app: TenantDatabase | undefined;
  let platform: pg.Client | undefined;
  let superuser: pg.Client | undefined;
  let seed: Seed | undefined;

  before(async () => {
    await applyTenantSchema();
    app = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    platform = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM") });
    superuser = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
    await platform.connect();
    await superuser.connect();
    await createStandIns(superuser);
    seed = await insertSeed(superuser);
  });

  after(async () => {
    if (superuser) {
      if (seed) await deleteSeed(superuser, seed).catch(() => undefined);
      await dropStandIns(superuser).catch(() => undefined);
    }
    await app?.end();
    await platform?.end();
    await superuser?.end();
  });

  it("masks a 16-digit NIK as 3273********0001 and hides the middle digits", () => {
    const nik = "3273011508950001";
    const masked = maskNik(nik);
    assert.equal(masked, "3273********0001");
    assert.equal(masked.includes(nik.slice(4, 12)), false);
    assert.equal(masked.includes("01150895"), false);
  });

  it("covers every FORCE RLS tenant table, including queries with no WHERE", async () => {
    if (!app || !superuser || !seed) throw new Error("isolation setup did not open the database");
    const database = app;
    const admin = superuser;
    const seeded = seed;
    const discovered = await tenantTables(admin);
    assert.deepEqual(discovered.map((row) => row.name), [...requiredTenantTables]);
    for (const row of discovered) {
      assert.equal(row.forced, true, row.name);
      assert.equal(seed.ids.has(row.name), true, row.name);
    }
    const tenants = await admin.query<{ forced: boolean }>(
      `SELECT c.relforcerowsecurity AS forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'id_tenants'`,
    );
    assert.equal(tenants.rows[0]?.forced, true);

    for (const table of requiredTenantTables) {
      const ids = seeded.ids.get(table);
      assert.ok(ids, table);
      const statement = `SELECT id::text AS id, tenant_id::text AS tenant_id FROM ${ident(table)}`;
      assert.equal(/\bwhere\b/iu.test(statement), false, statement);
      await database.withTenantContext(seeded.tenantA, async (tx) => {
        const visible = rowsOf(await tx.execute(sql.raw(statement)));
        assert.equal(visible.some((row) => row.id === ids.b), false, statement);
        assert.equal(visible.some((row) => row.id === ids.a), true, statement);
        if (table === "ai_knowledge_chunks") {
          assert.equal(
            visible.some((row) => row.tenant_id == null),
            true,
            statement,
          );
          for (const row of visible) {
            assert.equal(row.tenant_id === seeded.tenantA || row.tenant_id == null, true, statement);
          }
        } else {
          for (const row of visible) assert.equal(row.tenant_id, seeded.tenantA, statement);
        }
      });
    }

    const tenantSql = "SELECT id::text AS id FROM id_tenants";
    assert.equal(/\bwhere\b/iu.test(tenantSql), false);
    await database.withTenantContext(seeded.tenantA, async (tx) => {
      const visible = rowsOf(await tx.execute(sql.raw(tenantSql)));
      assert.equal(visible.some((row) => row.id === seeded.tenantB), false);
      assert.equal(visible.some((row) => row.id === seeded.tenantA), true);
      for (const row of visible) assert.equal(row.id, seeded.tenantA);
    });
  });

  it("stops tenant A from updating or deleting tenant B, then rolls the probe back", async () => {
    if (!app || !superuser || !seed) throw new Error("isolation setup did not open the database");
    const database = app;
    const admin = superuser;
    const seeded = seed;
    for (const table of requiredTenantTables) {
      const ids = seeded.ids.get(table);
      assert.ok(ids);
      const update =
        table === "sys_support_grants"
          ? "UPDATE sys_support_grants SET revoked_at = revoked_at RETURNING id::text AS id"
          : `UPDATE ${ident(table)} SET tenant_id = tenant_id RETURNING id::text AS id`;
      await scopedOrDenied(database, seeded.tenantA, update, ids.a, ids.b);
    }
    await scopedOrDenied(
      database,
      seeded.tenantA,
      "UPDATE id_tenants SET name = name RETURNING id::text AS id",
      seeded.tenantA,
      seeded.tenantB,
    );
    const deleteTargets = [
      "att_rosters",
      "att_leave_requests",
      "att_leave_balances",
      "att_overtime_requests",
      "att_daily_summaries",
      "att_holidays",
      "att_approval_delegations",
      "att_leave_types",
      "att_shifts",
      "ai_knowledge_chunks",
      "hr_employee_pii",
      "hr_employees",
      "ai_messages",
      "ai_action_proposals",
      "ai_conversations",
      "att_secret",
      "hr_secret",
      "pay_run",
      "rls_probe",
      "id_sessions",
      "id_memberships",
      "id_branches",
      "id_users",
      "id_roles",
      "id_legal_entities",
      "sys_support_grants",
      "aud_pii_access_logs",
      "aud_events",
      "aud_outbox_events",
      "aud_tenant_keys",
    ].map((table) => {
      const ids = seeded.ids.get(table);
      if (!ids) throw new Error(`missing seed for ${table}`);
      return { table, ownId: ids.a, otherId: ids.b };
    });
    await deleteVisibleOrDenied(database, seeded.tenantA, [
      ...deleteTargets,
      { table: "id_tenants", ownId: seeded.tenantA, otherId: seeded.tenantB },
    ]);
    for (const table of requiredTenantTables) {
      const ids = seeded.ids.get(table);
      assert.ok(ids);
      const remaining = await admin.query(`SELECT 1 FROM ${ident(table)} WHERE id = $1::uuid`, [ids.b]);
      assert.equal(remaining.rowCount, 1, table);
    }
    const tenantB = await admin.query("SELECT 1 FROM id_tenants WHERE id = $1::uuid", [seeded.tenantB]);
    assert.equal(tenantB.rowCount, 1);
  });

  it("does not keep app.current_tenant_id on a pooled connection", async () => {
    if (!app || !superuser || !seed) throw new Error("isolation setup did not open the database");
    const database = app;
    const admin = superuser;
    const seeded = seed;
    await database.withTenantContext(seeded.tenantA, async (tx) => {
      await tx.execute(sql`select 1`);
    });
    const clients: pg.PoolClient[] = [];
    try {
      for (let index = 0; index < 8; index += 1) clients.push(await database.pool.connect());
      for (const client of clients) {
        const setting = await client.query<{ tenant: string | null }>(
          "SELECT current_setting('app.current_tenant_id', true) AS tenant",
        );
        assert.equal(setting.rows[0]?.tenant ?? "", "");
        const visible = await client.query("SELECT id FROM rls_probe");
        assert.equal(visible.rows.length, 0);
        const updated = await client.query("UPDATE rls_probe SET tenant_id = tenant_id");
        assert.equal(updated.rowCount, 0);
      }
    } finally {
      for (const client of clients) client.release();
    }
    const probe = seeded.ids.get("rls_probe");
    assert.ok(probe);
    const still = await admin.query("SELECT 1 FROM rls_probe WHERE id = $1::uuid", [probe.b]);
    assert.equal(still.rowCount, 1);
  });

  it("denies platform_admin on stand-ins and tenant tables", async () => {
    if (!platform) throw new Error("isolation setup did not open the database");
    for (const table of platformDeniedTables) {
      await assertDeniedOrEmpty(platform, `SELECT id FROM ${ident(table)}`);
    }
  });

  it("rejects UPDATE, DELETE, and TRUNCATE on append-only audit tables", async () => {
    if (!app || !platform || !superuser || !seed) throw new Error("isolation setup did not open the database");
    const database = app;
    const adminRole = platform;
    const admin = superuser;
    const seeded = seed;
    const statements = (table: string) => [
      `UPDATE ${table} SET tenant_id = tenant_id`,
      `DELETE FROM ${table}`,
      `TRUNCATE ${table}`,
    ];
    for (const table of appendOnlyTables) {
      for (const statement of statements(ident(table))) {
        await assertPermissionDenied(database.pool, statement);
        await assertPermissionDenied(adminRole, statement);
      }
    }
    for (const table of appendOnlyTables) {
      const ids = seeded.ids.get(table);
      assert.ok(ids);
      const remaining = await admin.query(`SELECT 1 FROM ${ident(table)} WHERE id = $1::uuid`, [ids.b]);
      assert.equal(remaining.rowCount, 1, table);
    }
  });

  it("shares curated summaries and hides the other tenant's SOP chunks", async () => {
    if (!app || !superuser || !seed) throw new Error("isolation setup did not open the database");
    const database = app;
    const admin = superuser;
    const seeded = seed;
    const ids = seeded.ids.get("ai_knowledge_chunks");
    assert.ok(ids);
    const statement =
      "SELECT id::text AS id, tenant_id::text AS tenant_id, citation_ref, content FROM ai_knowledge_chunks";
    assert.equal(/\bwhere\b/iu.test(statement), false);
    const curated = [
      "summary:pp-58-2023",
      "summary:pmk-168-2023",
      "summary:pp-35-2021",
      "summary:uu-pdp-27-2022",
    ];
    for (const tenantId of [seeded.tenantA, seeded.tenantB]) {
      const ownSop = tenantId === seeded.tenantA ? "sop:isolation-a" : "sop:isolation-b";
      const otherSop = tenantId === seeded.tenantA ? "sop:isolation-b" : "sop:isolation-a";
      const ownId = tenantId === seeded.tenantA ? ids.a : ids.b;
      const otherId = tenantId === seeded.tenantA ? ids.b : ids.a;
      await database.withTenantContext(tenantId, async (tx) => {
        const visible = rowsOf(await tx.execute(sql.raw(statement))) as Array<{
          id: string;
          tenant_id: string | null;
          citation_ref: string;
          content: string;
        }>;
        assert.equal(visible.some((row) => row.id === otherId), false, tenantId);
        assert.equal(visible.some((row) => row.citation_ref === otherSop), false, tenantId);
        assert.equal(visible.some((row) => row.id === ownId && row.citation_ref === ownSop), true, tenantId);
        for (const ref of curated) {
          assert.equal(
            visible.some((row) => row.citation_ref === ref && row.tenant_id == null),
            true,
            ref,
          );
        }
        for (const row of visible) {
          if (curated.includes(row.citation_ref)) {
            assert.equal(row.content.toLowerCase().includes("not the statute"), true, row.citation_ref);
          }
        }
      });
    }
    await database.withTenantContext(seeded.tenantB, async (tx) => {
      await tx.execute(sql.raw("SAVEPOINT curated_probe"));
      const updated = rowsOf(
        await tx.execute(
          sql.raw(
            "UPDATE ai_knowledge_chunks SET title = 'changed' WHERE citation_ref = 'summary:pp-58-2023' RETURNING id::text AS id",
          ),
        ),
      );
      const removed = rowsOf(
        await tx.execute(
          sql.raw(
            "DELETE FROM ai_knowledge_chunks WHERE citation_ref = 'summary:pp-58-2023' RETURNING id::text AS id",
          ),
        ),
      );
      assert.equal(updated.length, 0);
      assert.equal(removed.length, 0);
      await tx.execute(sql.raw("ROLLBACK TO SAVEPOINT curated_probe"));
      await tx.execute(sql.raw("RELEASE SAVEPOINT curated_probe"));
    });
    const title = await admin.query<{ title: string }>(
      "SELECT title FROM ai_knowledge_chunks WHERE citation_ref = 'summary:pp-58-2023'",
    );
    assert.equal(title.rows[0]?.title.includes("changed"), false);
    await assert.rejects(
      () =>
        database.withTenantContext(seeded.tenantA, (tx) =>
          tx.execute(sql`
            INSERT INTO ai_knowledge_chunks (
              tenant_id, source_type, citation_ref, title, content, is_statute_text, document_id, chunk_index
            ) VALUES (
              NULL, 'curated_summary', 'summary:isolation-hack', 'Hack', 'not the statute', false, uuidv7(), 0
            )
          `),
        ),
      (error: unknown) => permissionCode(error) === "42501",
    );
    await assert.rejects(
      () =>
        database.withTenantContext(seeded.tenantA, (tx) =>
          tx.execute(sql`
            INSERT INTO ai_knowledge_chunks (
              tenant_id, source_type, citation_ref, title, content, is_statute_text, document_id, chunk_index
            ) VALUES (
              ${seeded.tenantB}::uuid,
              'tenant_sop',
              'sop:isolation-steal',
              'Steal',
              'secret',
              false,
              uuidv7(),
              0
            )
          `),
        ),
      (error: unknown) => permissionCode(error) === "42501",
    );
  });
});

async function deleteVisibleOrDenied(
  app: TenantDatabase,
  tenantId: string,
  tables: Array<{ table: string; ownId: string; otherId: string }>,
): Promise<void> {
  try {
    await app.withTenantContext(tenantId, async (tx) => {
      for (const item of tables) {
        const statement = `DELETE FROM ${ident(item.table)} RETURNING id::text AS id`;
        assert.equal(/\bwhere\b/iu.test(statement), false, statement);
        await tx.execute(sql.raw("SAVEPOINT isolation_probe"));
        try {
          const ids = rowsOf(await tx.execute(sql.raw(statement))).map((row) => row.id);
          assert.equal(ids.includes(item.otherId), false, statement);
          assert.equal(ids.includes(item.ownId), true, statement);
          await tx.execute(sql.raw("RELEASE SAVEPOINT isolation_probe"));
        } catch (error) {
          await tx.execute(sql.raw("ROLLBACK TO SAVEPOINT isolation_probe"));
          await tx.execute(sql.raw("RELEASE SAVEPOINT isolation_probe"));
          if (permissionCode(error) !== "42501") throw error;
        }
      }
      throw new RollbackProbe();
    });
    assert.fail("delete probe committed");
  } catch (error) {
    if (isRollback(error)) return;
    throw error;
  }
}

async function scopedOrDenied(
  app: TenantDatabase,
  tenantId: string,
  statement: string,
  ownId: string,
  otherId: string,
): Promise<void> {
  assert.equal(/\bwhere\b/iu.test(statement), false, statement);
  try {
    await app.withTenantContext(tenantId, async (tx) => {
      const ids = rowsOf(await tx.execute(sql.raw(statement))).map((row) => row.id);
      assert.equal(ids.includes(otherId), false, statement);
      assert.equal(ids.includes(ownId), true, statement);
      throw new RollbackProbe();
    });
    assert.fail(`${statement} returned`);
  } catch (error) {
    if (isRollback(error)) return;
    if (permissionCode(error) === "42501") return;
    throw error;
  }
}

/** Runs identity, platform, audit, and AI migrates without a package dependency from db. */
async function applyTenantSchema(): Promise<void> {
  const script = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../modules/platform/src/isolation-schema.ts",
  );
    try {
      await execFileAsync(process.execPath, ["--experimental-strip-types", script], {
        env: { ...process.env, GOTONG_APPLY_TENANT_SCHEMA: "1" },
      });
    } catch (error) {
      const stderr =
        error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
      const detail = error instanceof Error ? error.message : "migrate failed";
      throw new Error(`tenant schema migrate failed: ${detail}\n${stderr}`, { cause: error });
    }
}

async function assertPermissionDenied(
  queryable: { query: pg.Client["query"] },
  statement: string,
): Promise<void> {
  await assert.rejects(
    queryable.query(statement),
    (error: unknown) => permissionCode(error) === "42501",
    statement,
  );
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

async function tenantTables(
  superuser: pg.Client,
): Promise<Array<{ name: string; forced: boolean }>> {
  const result = await superuser.query<{ name: string; forced: boolean }>(`
    SELECT c.relname AS name, c.relforcerowsecurity AS forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity
      AND EXISTS (
        SELECT 1
        FROM pg_attribute a
        WHERE a.attrelid = c.oid
          AND a.attname = 'tenant_id'
          AND NOT a.attisdropped
      )
    ORDER BY c.relname
  `);
  return result.rows;
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

async function insertSeed(superuser: pg.Client): Promise<Seed> {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const orgA = `org-${tenantA}`;
  const orgB = `org-${tenantB}`;
  const userA = randomUUID();
  const userB = randomUUID();
  const roleA = randomUUID();
  const roleB = randomUUID();
  const membershipA = randomUUID();
  const membershipB = randomUUID();
  const authA = `auth-${tenantA}`;
  const authB = `auth-${tenantB}`;
  const sessionA = `sess-${tenantA}`;
  const sessionB = `sess-${tenantB}`;
  const idSessionA = randomUUID();
  const idSessionB = randomUUID();
  const entityA = randomUUID();
  const entityB = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();
  const eventA = randomUUID();
  const eventB = randomUUID();
  const piiA = randomUUID();
  const piiB = randomUUID();
  const outboxA = randomUUID();
  const outboxB = randomUUID();
  const keyA = randomUUID();
  const keyB = randomUUID();
  const operatorId = randomUUID();
  const grantA = randomUUID();
  const grantB = randomUUID();
  const probeA = randomUUID();
  const probeB = randomUUID();
  const hrA = randomUUID();
  const hrB = randomUUID();
  const attA = randomUUID();
  const attB = randomUUID();
  const payA = randomUUID();
  const payB = randomUUID();
  const employeeA = randomUUID();
  const employeeB = randomUUID();
  const employeePiiA = randomUUID();
  const employeePiiB = randomUUID();
  const conversationA = randomUUID();
  const conversationB = randomUUID();
  const messageA = randomUUID();
  const messageB = randomUUID();
  const proposalA = randomUUID();
  const proposalB = randomUUID();
  const chunkA = randomUUID();
  const chunkB = randomUUID();
  const sopDocA = randomUUID();
  const sopDocB = randomUUID();
  const shiftA = randomUUID();
  const shiftB = randomUUID();
  const rosterA = randomUUID();
  const rosterB = randomUUID();
  const holidayA = randomUUID();
  const holidayB = randomUUID();
  const leaveTypeA = randomUUID();
  const leaveTypeB = randomUUID();
  const leaveBalanceA = randomUUID();
  const leaveBalanceB = randomUUID();
  const leaveRequestA = randomUUID();
  const leaveRequestB = randomUUID();
  const overtimeA = randomUUID();
  const overtimeB = randomUUID();
  const delegationA = randomUUID();
  const delegationB = randomUUID();
  const delegateA = randomUUID();
  const delegateB = randomUUID();
  const summaryA = randomUUID();
  const summaryB = randomUUID();
  const emailA = `${tenantA}@isolation.test`;
  const emailB = `${tenantB}@isolation.test`;

  await superuser.query("BEGIN");
  try {
    await superuser.query(
      `INSERT INTO ba_organization (id, name, slug) VALUES ($1, 'Isolation A', $1), ($2, 'Isolation B', $2)`,
      [orgA, orgB],
    );
    await superuser.query(
      `INSERT INTO id_tenants (id, organization_id, name, slug)
       VALUES ($1::uuid, $3, 'Isolation A', $3), ($2::uuid, $4, 'Isolation B', $4)`,
      [tenantA, tenantB, orgA, orgB],
    );
    await superuser.query(
      `INSERT INTO id_roles (id, tenant_id, code, permissions) VALUES
         ($1, $3, 'org_owner', ARRAY['employee.pii.reveal']::text[]),
         ($2, $4, 'org_owner', ARRAY['employee.pii.reveal']::text[])`,
      [roleA, roleB, tenantA, tenantB],
    );
    await superuser.query(
      `INSERT INTO ba_user (id, name, email) VALUES ($1, 'A', $3), ($2, 'B', $4)`,
      [authA, authB, emailA, emailB],
    );
    await superuser.query(
      `INSERT INTO id_users (id, tenant_id, auth_user_id, email, display_name) VALUES
         ($1, $3, $5, $7, 'A'),
         ($2, $4, $6, $8, 'B')`,
      [userA, userB, tenantA, tenantB, authA, authB, emailA, emailB],
    );
    await superuser.query(
      `INSERT INTO id_memberships (id, tenant_id, user_id, auth_user_id, role_id) VALUES
         ($1, $3, $5, $7, $9),
         ($2, $4, $6, $8, $10)`,
      [membershipA, membershipB, tenantA, tenantB, userA, userB, authA, authB, roleA, roleB],
    );
    await superuser.query(
      `INSERT INTO ba_session (id, expires_at, token, user_id) VALUES
         ($1, now() + interval '1 day', $3, $5),
         ($2, now() + interval '1 day', $4, $6)`,
      [sessionA, sessionB, `tok-${tenantA}`, `tok-${tenantB}`, authA, authB],
    );
    await superuser.query(
      `INSERT INTO id_sessions (id, tenant_id, auth_session_id, auth_user_id, user_id) VALUES
         ($1, $3, $5, $7, $9),
         ($2, $4, $6, $8, $10)`,
      [idSessionA, idSessionB, tenantA, tenantB, sessionA, sessionB, authA, authB, userA, userB],
    );
    await superuser.query(
      `INSERT INTO id_legal_entities (id, tenant_id, company_name, npwp_16) VALUES
         ($1, $3, 'PT Isolation A', '1000000000000001'),
         ($2, $4, 'PT Isolation B', '1000000000000002')`,
      [entityA, entityB, tenantA, tenantB],
    );
    await superuser.query(
      `INSERT INTO id_branches (
         id, tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr
       ) VALUES
         ($1, $3, $5, 'HQ A', '1000000000000000000001', 'Asia/Jakarta', 5000000),
         ($2, $4, $6, 'HQ B', '1000000000000000000002', 'Asia/Jakarta', 5000000)`,
      [branchA, branchB, tenantA, tenantB, entityA, entityB],
    );
    await superuser.query(
      `INSERT INTO aud_events (id, tenant_id, action, resource_type, diff_redacted_json) VALUES
         ($1, $3, 'seed', 'isolation', '{}'::jsonb),
         ($2, $4, 'seed', 'isolation', '{}'::jsonb)`,
      [eventA, eventB, tenantA, tenantB],
    );
    await superuser.query(
      `INSERT INTO aud_pii_access_logs (
         id, tenant_id, actor_user_id, field_name, resource_type, resource_id, reason
       ) VALUES
         ($1, $3, $5, 'nik', 'hr_employee_pii', $7, 'seed'),
         ($2, $4, $6, 'nik', 'hr_employee_pii', $8, 'seed')`,
      [piiA, piiB, tenantA, tenantB, userA, userB, randomUUID(), randomUUID()],
    );
    await superuser.query(
      `INSERT INTO aud_outbox_events (id, tenant_id, topic, payload) VALUES
         ($1, $3, 'isolation.probe', '{}'::jsonb),
         ($2, $4, 'isolation.probe', '{}'::jsonb)`,
      [outboxA, outboxB, tenantA, tenantB],
    );
    await superuser.query(
      `INSERT INTO aud_tenant_keys (id, tenant_id, wrapped_dek, wrapped_pepper) VALUES
         ($1, $3, 'wrapped-dek-a', 'wrapped-pepper-a'),
         ($2, $4, 'wrapped-dek-b', 'wrapped-pepper-b')`,
      [keyA, keyB, tenantA, tenantB],
    );
    await superuser.query(
      `INSERT INTO sys_platform_operators (id, auth_user_id, role) VALUES ($1, $2, 'platform_ops')`,
      [operatorId, `op-${tenantA}`],
    );
    await superuser.query(
      `INSERT INTO sys_support_grants (
         id, tenant_id, granted_by_user_id, grantee_platform_user_id, token_hash, reason, expires_at
       ) VALUES
         ($1, $3, $5, $7, $8, 'isolation', now() + interval '1 hour'),
         ($2, $4, $6, $7, $9, 'isolation', now() + interval '1 hour')`,
      [grantA, grantB, tenantA, tenantB, userA, userB, operatorId, `hash-${grantA}`, `hash-${grantB}`],
    );
    await superuser.query(
      `INSERT INTO rls_probe (id, tenant_id) VALUES ($1, $3), ($2, $4)`,
      [probeA, probeB, tenantA, tenantB],
    );
    await superuser.query(
      `INSERT INTO hr_employees (
         id, tenant_id, employee_code, full_name, legal_entity_id, branch_id,
         employment_status, join_date, ptkp_status, tax_method, pph21_subject_type
       ) VALUES
         ($1, $3, 'A001', 'Employee A', $5, $7, 'active', '2024-01-15', 'TK/0', 'gross', 'permanent'),
         ($2, $4, 'B001', 'Employee B', $6, $8, 'active', '2024-01-15', 'TK/0', 'gross', 'permanent')`,
      [employeeA, employeeB, tenantA, tenantB, entityA, entityB, branchA, branchB],
    );
    await superuser.query(
      `INSERT INTO hr_employee_pii (id, tenant_id, employee_id, nik_enc, nik_hash, nik_mask) VALUES
         ($1, $3, $5, 'sealed-ciphertext-value-aaaa', $7, '3273********0001'),
         ($2, $4, $6, 'sealed-ciphertext-value-bbbb', $8, '3273********0001')`,
      [
        employeePiiA,
        employeePiiB,
        tenantA,
        tenantB,
        employeeA,
        employeeB,
        "a".repeat(64),
        "b".repeat(64),
      ],
    );
    await superuser.query(
      `INSERT INTO hr_secret (id, tenant_id, marker) VALUES ($1, $3, 'a'), ($2, $4, 'b')`,
      [hrA, hrB, tenantA, tenantB],
    );
    await superuser.query(
      `INSERT INTO att_secret (id, tenant_id, marker) VALUES ($1, $3, 'a'), ($2, $4, 'b')`,
      [attA, attB, tenantA, tenantB],
    );
    await superuser.query(
      `INSERT INTO pay_run (id, tenant_id, marker) VALUES ($1, $3, 'a'), ($2, $4, 'b')`,
      [payA, payB, tenantA, tenantB],
    );
    await superuser.query(
      `INSERT INTO ai_conversations (id, tenant_id, created_by_user_id, title) VALUES
         ($1, $3, $5, 'a'),
         ($2, $4, $6, 'b')`,
      [conversationA, conversationB, tenantA, tenantB, userA, userB],
    );
    await superuser.query(
      `INSERT INTO ai_messages (id, tenant_id, conversation_id, role, content_redacted) VALUES
         ($1, $3, $5, 'user', 'a'),
         ($2, $4, $6, 'user', 'b')`,
      [messageA, messageB, tenantA, tenantB, conversationA, conversationB],
    );
    await superuser.query(
      `INSERT INTO ai_action_proposals (
         id, tenant_id, conversation_id, created_by_user_id, tool_name,
         arguments_json, impact_preview_json, confirmation_nonce, expires_at
       ) VALUES
         ($1, $3, $5, $7, 'isolation', '{}'::jsonb, '{}'::jsonb, repeat('ab', 32), now() + interval '15 minutes'),
         ($2, $4, $6, $8, 'isolation', '{}'::jsonb, '{}'::jsonb, repeat('cd', 32), now() + interval '15 minutes')`,
      [proposalA, proposalB, tenantA, tenantB, conversationA, conversationB, userA, userB],
    );
    await superuser.query(
      `INSERT INTO att_shifts (
         id, tenant_id, code, name, start_local_time, end_local_time, workweek_type
       ) VALUES
         ($1, $3, 'PAGI', 'Pagi', '08:00', '17:00', '5_day'),
         ($2, $4, 'PAGI', 'Pagi', '08:00', '17:00', '5_day')`,
      [shiftA, shiftB, tenantA, tenantB],
    );
    await superuser.query(
      `INSERT INTO att_rosters (id, tenant_id, employee_id, shift_id, work_date) VALUES
         ($1, $3, $5, $7, '2026-02-02'),
         ($2, $4, $6, $8, '2026-02-02')`,
      [rosterA, rosterB, tenantA, tenantB, employeeA, employeeB, shiftA, shiftB],
    );
    await superuser.query(
      `INSERT INTO att_holidays (
         id, tenant_id, holiday_date, name, kind, source_status, calendar_year
       ) VALUES
         ($1, $3, '2026-08-17', 'Kemerdekaan', 'national', 'draft', 2026),
         ($2, $4, '2026-08-17', 'Kemerdekaan', 'national', 'draft', 2026)`,
      [holidayA, holidayB, tenantA, tenantB],
    );
    await superuser.query(
      `INSERT INTO att_leave_types (
         id, tenant_id, code, name, tenure_months, entitlement_days, deducts_annual, deduction_toggle
       ) VALUES
         ($1, $3, 'cuti_tahunan', 'Cuti Tahunan', 12, 12, false, false),
         ($2, $4, 'cuti_tahunan', 'Cuti Tahunan', 12, 12, false, false)`,
      [leaveTypeA, leaveTypeB, tenantA, tenantB],
    );
    await superuser.query(
      `INSERT INTO att_leave_balances (
         id, tenant_id, employee_id, leave_type_id, balance_year, entitled_days, used_days
       ) VALUES
         ($1, $3, $5, $7, 2026, 12, 0),
         ($2, $4, $6, $8, 2026, 12, 0)`,
      [leaveBalanceA, leaveBalanceB, tenantA, tenantB, employeeA, employeeB, leaveTypeA, leaveTypeB],
    );
    await superuser.query(
      `INSERT INTO att_leave_requests (
         id, tenant_id, employee_id, leave_type_id, start_date, end_date, day_count,
         status, requested_by_user_id
       ) VALUES
         ($1, $3, $5, $7, '2026-02-02', '2026-02-02', 1, 'pending_line_manager', $9),
         ($2, $4, $6, $8, '2026-02-02', '2026-02-02', 1, 'pending_line_manager', $10)`,
      [
        leaveRequestA,
        leaveRequestB,
        tenantA,
        tenantB,
        employeeA,
        employeeB,
        leaveTypeA,
        leaveTypeB,
        userA,
        userB,
      ],
    );
    await superuser.query(
      `INSERT INTO att_overtime_requests (
         id, tenant_id, employee_id, work_date, starts_at, ends_at, workweek_type, day_type,
         requested_minutes, status, requested_by_user_id
       ) VALUES
         ($1, $3, $5, '2026-02-02', '2026-02-02T01:00:00Z', '2026-02-02T02:00:00Z', '5_day', 'workday', 60, 'pending_line_manager', $7),
         ($2, $4, $6, '2026-02-02', '2026-02-02T01:00:00Z', '2026-02-02T02:00:00Z', '5_day', 'workday', 60, 'pending_line_manager', $8)`,
      [overtimeA, overtimeB, tenantA, tenantB, employeeA, employeeB, userA, userB],
    );
    await superuser.query(
      `INSERT INTO att_approval_delegations (
         id, tenant_id, delegator_user_id, delegate_user_id, role_code, starts_at, ends_at
       ) VALUES
         ($1, $3, $5, $7, 'line_manager', now(), now() + interval '1 day'),
         ($2, $4, $6, $8, 'line_manager', now(), now() + interval '1 day')`,
      [delegationA, delegationB, tenantA, tenantB, userA, userB, delegateA, delegateB],
    );
    await superuser.query(
      `INSERT INTO att_daily_summaries (id, tenant_id, employee_id, work_date, status) VALUES
         ($1, $3, $5, '2026-02-02', 'open'),
         ($2, $4, $6, '2026-02-02', 'open')`,
      [summaryA, summaryB, tenantA, tenantB, employeeA, employeeB],
    );
    await superuser.query(
      `INSERT INTO ai_knowledge_chunks (
         id, tenant_id, source_type, citation_ref, title, content, is_statute_text, document_id, chunk_index
       ) VALUES
         ($1, $3, 'tenant_sop', 'sop:isolation-a', 'SOP A', 'tenant a night shift sop', false, $5, 0),
         ($2, $4, 'tenant_sop', 'sop:isolation-b', 'SOP B', 'tenant b night shift sop', false, $6, 0)`,
      [chunkA, chunkB, tenantA, tenantB, sopDocA, sopDocB],
    );
    await superuser.query("COMMIT");
  } catch (error) {
    await superuser.query("ROLLBACK");
    throw error;
  }

  return {
    tenantA,
    tenantB,
    orgA,
    orgB,
    authA,
    authB,
    sessionA,
    sessionB,
    operatorId,
    ids: new Map([
      ["ai_action_proposals", { a: proposalA, b: proposalB }],
      ["ai_conversations", { a: conversationA, b: conversationB }],
      ["ai_knowledge_chunks", { a: chunkA, b: chunkB }],
      ["ai_messages", { a: messageA, b: messageB }],
      ["att_approval_delegations", { a: delegationA, b: delegationB }],
      ["att_daily_summaries", { a: summaryA, b: summaryB }],
      ["att_holidays", { a: holidayA, b: holidayB }],
      ["att_leave_balances", { a: leaveBalanceA, b: leaveBalanceB }],
      ["att_leave_requests", { a: leaveRequestA, b: leaveRequestB }],
      ["att_leave_types", { a: leaveTypeA, b: leaveTypeB }],
      ["att_overtime_requests", { a: overtimeA, b: overtimeB }],
      ["att_rosters", { a: rosterA, b: rosterB }],
      ["att_secret", { a: attA, b: attB }],
      ["att_shifts", { a: shiftA, b: shiftB }],
      ["aud_events", { a: eventA, b: eventB }],
      ["aud_outbox_events", { a: outboxA, b: outboxB }],
      ["aud_pii_access_logs", { a: piiA, b: piiB }],
      ["aud_tenant_keys", { a: keyA, b: keyB }],
      ["hr_employee_pii", { a: employeePiiA, b: employeePiiB }],
      ["hr_employees", { a: employeeA, b: employeeB }],
      ["hr_secret", { a: hrA, b: hrB }],
      ["id_branches", { a: branchA, b: branchB }],
      ["id_legal_entities", { a: entityA, b: entityB }],
      ["id_memberships", { a: membershipA, b: membershipB }],
      ["id_roles", { a: roleA, b: roleB }],
      ["id_sessions", { a: idSessionA, b: idSessionB }],
      ["id_users", { a: userA, b: userB }],
      ["pay_run", { a: payA, b: payB }],
      ["rls_probe", { a: probeA, b: probeB }],
      ["sys_support_grants", { a: grantA, b: grantB }],
    ]),
  };
}

async function deleteSeed(superuser: pg.Client, seed: Seed): Promise<void> {
  const tenants = [seed.tenantA, seed.tenantB];
  await superuser.query("DELETE FROM att_rosters WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM att_leave_requests WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM att_leave_balances WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM att_overtime_requests WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM att_daily_summaries WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM att_holidays WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM att_approval_delegations WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM att_leave_types WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM att_shifts WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM ai_knowledge_chunks WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM ai_messages WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM ai_action_proposals WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM ai_conversations WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_pii_access_logs WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_outbox_events WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM aud_tenant_keys WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM sys_platform_audit_events WHERE target_tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM sys_support_grants WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM rls_probe WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_employee_pii WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM hr_employees WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  for (const table of standIns) {
    await superuser.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenants]);
  }
  await superuser.query("DELETE FROM id_branches WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_legal_entities WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_sessions WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_memberships WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_users WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_roles WHERE tenant_id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM id_tenants WHERE id = ANY($1::uuid[])", [tenants]);
  await superuser.query("DELETE FROM ba_session WHERE id = ANY($1::text[])", [[seed.sessionA, seed.sessionB]]);
  await superuser.query("DELETE FROM ba_user WHERE id = ANY($1::text[])", [[seed.authA, seed.authB]]);
  await superuser.query("DELETE FROM ba_organization WHERE id = ANY($1::text[])", [[seed.orgA, seed.orgB]]);
  await superuser.query("DELETE FROM sys_platform_operators WHERE id = $1::uuid", [seed.operatorId]);
}
