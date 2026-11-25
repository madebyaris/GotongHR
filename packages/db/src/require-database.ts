import pg from "pg";
import { applyDatabaseUrls, loadRepoEnv, requiredEnv } from "./env.ts";

/**
 * Connects to Postgres and throws when it is missing.
 * The isolation script exits on this error. Tests do not skip.
 */
export async function assertPostgresReachable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  loadRepoEnv();
  applyDatabaseUrls(env);
  const client = new pg.Client({
    connectionString: requiredEnv(env, "DATABASE_URL_SUPERUSER"),
    connectionTimeoutMillis: 3_000,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (error) {
    const message = error instanceof Error ? error.message : "connection failed";
    throw new Error(`PostgreSQL is unreachable: ${message}`, { cause: error });
  } finally {
    await client.end().catch(() => undefined);
  }
}
