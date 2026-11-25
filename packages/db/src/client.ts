import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

const { Pool } = pg;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AppDatabase = NodePgDatabase<typeof schema>;

export interface TenantDatabase {
  db: AppDatabase;
  pool: pg.Pool;
  withTenantContext<T>(
    tenantId: string,
    fn: (tx: TenantTx) => Promise<T>,
  ): Promise<T>;
  end(): Promise<void>;
}

export type TenantTx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

export function createTenantDatabase(connectionString: string, max = 8): TenantDatabase {
  const pool = new Pool({ connectionString, max, statement_timeout: 10_000 });
  pool.on("error", (error: Error) => {
    process.stderr.write(`${JSON.stringify({ msg: "pg pool error", error: error.message })}\n`);
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    withTenantContext(tenantId, fn) {
      return withTenantContext(db, tenantId, fn);
    },
    async end() {
      await pool.end();
    },
  };
}

/**
 * Opens one transaction, sets the tenant for that transaction only, and passes
 * the transaction to fn. The third argument of set_config is is_local, so the
 * setting is SET LOCAL and does not survive commit on a pooled connection.
 */
export async function withTenantContext<T>(
  db: AppDatabase,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!uuidPattern.test(tenantId)) {
    throw new Error("tenant id must be a uuid");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
