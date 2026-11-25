import pg from "pg";
import { readPlatformDatabaseUrl } from "./env.ts";

const { Pool } = pg;

export interface PlatformDatabase {
  pool: pg.Pool;
  end(): Promise<void>;
}

/**
 * Opens the request pool. The URL must name `platform_admin`, and the session
 * must actually be that role. This function does not read the migrator URL.
 */
export async function openPlatformDatabase(connectionString: string): Promise<PlatformDatabase> {
  readPlatformDatabaseUrl({ DATABASE_URL_PLATFORM: connectionString });
  const pool = new Pool({ connectionString, max: 4, statement_timeout: 10_000 });
  pool.on("error", (error: Error) => {
    process.stderr.write(
      `${JSON.stringify({ msg: "platform pg pool error", error: error.message })}\n`,
    );
  });
  try {
    const role = await pool.query<{ current_user: string }>("SELECT current_user");
    if (role.rows[0]?.current_user !== "platform_admin") {
      throw new Error("Platform pool is not platform_admin.");
    }
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  return {
    pool,
    async end() {
      await pool.end();
    },
  };
}
