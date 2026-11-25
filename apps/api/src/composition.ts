import {
  createTenantDatabase,
  loadRepoEnv,
  migrate,
  migrateEnvFrom,
  requiredEnv,
  type TenantDatabase,
} from "@gotonghr/db";
import { createStorage } from "@gotonghr/storage";
import type { PgBoss } from "pg-boss";
import { readConfig, type AppConfig } from "./config.ts";
import { buildServer } from "./server.ts";
import { startBoss } from "./queue.ts";
import type { FastifyInstance } from "fastify";

export interface ComposedApp {
  app: FastifyInstance;
  config: AppConfig;
  appDb: TenantDatabase;
  boss: PgBoss;
  close(): Promise<void>;
}

export async function composeFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<ComposedApp> {
  loadRepoEnv();
  const config = readConfig(env);
  await migrate(migrateEnvFrom(env));
  const appDb = createTenantDatabase(requiredEnv(env, "DATABASE_URL_APP"));
  const platformDb = createTenantDatabase(requiredEnv(env, "DATABASE_URL_PLATFORM"), 2);
  await appDb.pool.query("select 1");
  await platformDb.pool.query("select 1");
  const boss = await startBoss(requiredEnv(env, "DATABASE_URL_MIGRATOR"));
  const storage = createStorage(env);
  let queueStarted = true;
  const app = await buildServer({
    logger: env.NODE_ENV !== "test",
    storage,
    checkReady: async () => {
      if (!queueStarted) {
        throw new Error("queue is not started");
      }
      await appDb.pool.query("select 1");
    },
  });

  return {
    app,
    config,
    appDb,
    boss,
    async close() {
      queueStarted = false;
      await app.close();
      await boss.stop({ graceful: true, close: true });
      await appDb.end();
      await platformDb.end();
    },
  };
}
