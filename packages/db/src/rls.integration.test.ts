import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createTenantDatabase } from "./client.ts";
import { loadRepoEnv, requiredEnv } from "./env.ts";
import { migrate, migrateEnvFrom } from "./migrate.ts";

const { Client } = pg;

loadRepoEnv();

function rowsOf(result: { rows?: unknown[]; rowCount?: number | null }): number {
  if (typeof result.rowCount === "number") return result.rowCount;
  return result.rows?.length ?? 0;
}

function isRlsViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const current = error as { code?: string; cause?: unknown };
  if (current.code === "42501") return true;
  return isRlsViolation(current.cause);
}

describe("tenant row security", { concurrency: 1 }, () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let app: ReturnType<typeof createTenantDatabase>;
  let platform: pg.Client;
  let superuser: pg.Client;

  before(async () => {
    await migrate(migrateEnvFrom(process.env));
    app = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
    platform = new Client({
      connectionString: requiredEnv(process.env, "DATABASE_URL_PLATFORM"),
    });
    superuser = new Client({
      connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER"),
    });
    await platform.connect();
    await superuser.connect();
    await superuser.query("TRUNCATE rls_probe");
  });

  after(async () => {
    await superuser.query("DELETE FROM rls_probe WHERE tenant_id = ANY($1::uuid[])", [
      [tenantA, tenantB],
    ]);
    await app.end();
    await platform.end();
    await superuser.end();
  });

  it("gives app_tenant and platform_admin no BYPASSRLS", async () => {
    const result = await superuser.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1::text[])",
      [["app_tenant", "platform_admin", "gotong_migrator"]],
    );
    assert.equal(result.rows.length, 3);
    for (const role of result.rows) {
      assert.equal(role.rolsuper, false, role.rolname);
      assert.equal(role.rolbypassrls, false, role.rolname);
    }
  });

  it("hides tenant A from tenant B when the query has no tenant predicate", async () => {
    await app.withTenantContext(tenantA, async (tx) => {
      await tx.execute(sql`insert into rls_probe (tenant_id) values (${tenantA}::uuid)`);
      const visible = await tx.execute(sql`select id from rls_probe`);
      assert.equal(rowsOf(visible), 1);
    });

    await app.withTenantContext(tenantB, async (tx) => {
      const visible = await tx.execute(sql`select id from rls_probe`);
      const updated = await tx.execute(sql`update rls_probe set tenant_id = tenant_id`);
      assert.equal(rowsOf(visible), 0);
      assert.equal(rowsOf(updated), 0);
    });

    await app.withTenantContext(tenantA, async (tx) => {
      const visible = await tx.execute(sql`select id from rls_probe`);
      assert.equal(rowsOf(visible), 1);
    });
  });

  it("rejects a write that names another tenant", async () => {
    await assert.rejects(
      app.withTenantContext(tenantA, async (tx) => {
        await tx.execute(sql`insert into rls_probe (tenant_id) values (${tenantB}::uuid)`);
      }),
      isRlsViolation,
    );
    await app.withTenantContext(tenantA, async (tx) => {
      await tx.execute(sql`insert into rls_probe (tenant_id) values (${tenantA}::uuid)`);
    });
    await assert.rejects(
      app.withTenantContext(tenantA, async (tx) => {
        await tx.execute(
          sql`update rls_probe set tenant_id = ${tenantB}::uuid where tenant_id = ${tenantA}::uuid`,
        );
      }),
      isRlsViolation,
    );
  });

  it("drops the tenant setting when the transaction returns the connection", async () => {
    await app.withTenantContext(tenantA, async (tx) => {
      await tx.execute(sql`select 1`);
    });
    const client = await app.pool.connect();
    try {
      const result = await client.query<{ tenant: string | null }>(
        "SELECT current_setting('app.current_tenant_id', true) AS tenant",
      );
      const tenant = result.rows[0]?.tenant ?? null;
      assert.ok(tenant === null || tenant === "");
    } finally {
      client.release();
    }
  });

  it("denies platform_admin select on rls_probe", async () => {
    await assert.rejects(
      platform.query("SELECT id FROM rls_probe"),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "42501");
        return true;
      },
    );
  });

  it("returns a uuidv7 from the database", async () => {
    const result = await app.pool.query<{ id: string }>("SELECT uuidv7() AS id");
    const id = result.rows[0]?.id;
    assert.ok(id);
    const version = id.split("-")[2]?.[0];
    assert.equal(version, "7");
  });
});
