import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { loadRepoEnv, migrate, migrateEnvFrom, requiredEnv } from "@gotonghr/db";
import { composeFromEnv, type ComposedApp } from "./composition.ts";
import { provisionQueue } from "./queue.ts";

const { Client } = pg;

loadRepoEnv();

describe("readyz against postgres", { concurrency: 1 }, () => {
  let composed: ComposedApp;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.STORAGE_DRIVER ??= "local";
    process.env.STORAGE_LOCAL_SECRET = "local-test-storage-secret";
    process.env.QUEUE_DRIVER ??= "pgboss";
    await migrate(migrateEnvFrom(process.env));
    await provisionQueue(requiredEnv(process.env, "DATABASE_URL_MIGRATOR"));
    composed = await composeFromEnv(process.env);
  });

  after(async () => {
    await composed.close();
  });

  it("stays ready after a tenant transaction returns its connection", async () => {
    const first = await composed.app.inject({ method: "GET", url: "/readyz" });
    assert.equal(first.statusCode, 200);

    await composed.appDb.withTenantContext(randomUUID(), async () => {});
    const client = await composed.appDb.pool.connect();
    try {
      const result = await client.query<{ tenant: string | null }>(
        "SELECT current_setting('app.current_tenant_id', true) AS tenant",
      );
      const tenant = result.rows[0]?.tenant ?? null;
      assert.ok(tenant === null || tenant === "");
    } finally {
      client.release();
    }

    const second = await composed.app.inject({ method: "GET", url: "/readyz" });
    assert.equal(second.statusCode, 200);
  });

  it("keeps pg-boss in its own schema and refuses a drop from app_tenant", async () => {
    const migrator = new Client({
      connectionString: requiredEnv(process.env, "DATABASE_URL_MIGRATOR"),
    });
    await migrator.connect();
    try {
      const tables = await migrator.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'pgboss' ORDER BY tablename",
      );
      assert.ok(tables.rows.length > 0);
      const name = tables.rows[0]?.tablename;
      assert.ok(name && /^[a-z0-9_]+$/.test(name));
      await assert.rejects(composed.appDb.pool.query(`DROP TABLE pgboss.${name}`), (error: unknown) => {
        const current = error as { code?: string; cause?: { code?: string } };
        return current.code === "42501" || current.cause?.code === "42501";
      });
    } finally {
      await migrator.end();
    }
  });
});
