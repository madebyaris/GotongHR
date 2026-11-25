import {
  applyDatabaseUrls,
  createTenantDatabase,
  loadRepoEnv,
  requiredEnv,
  type TenantDatabase,
} from "@gotonghr/db";
import { createStorage } from "@gotonghr/storage";
import type { PgBoss } from "pg-boss";
import { readConfig, type AppConfig } from "./config.ts";
import { buildServer } from "./server.ts";
import { MAINTENANCE_QUEUE, startBoss } from "./queue.ts";
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
  applyDatabaseUrls(env);
  const config = readConfig(env);
  const appDb = createTenantDatabase(requiredEnv(env, "DATABASE_URL_APP"));
  const platformDb = createTenantDatabase(requiredEnv(env, "DATABASE_URL_PLATFORM"), 2);
  await appDb.pool.query("select 1");
  await platformDb.pool.query("select 1");
  const boss = await startBoss(requiredEnv(env, "DATABASE_URL_QUEUE"));
  const storage = createStorage(env);
  let closed = false;
  const app = await buildServer({
    logger: env.NODE_ENV !== "test",
    storage,
    checkReady: async () => {
      if (closed) {
        throw new Error("queue is not started");
      }
      await appDb.pool.query("select 1");
      const queue = await boss.getQueue(MAINTENANCE_QUEUE);
      if (!queue) {
        throw new Error("maintenance queue is missing");
      }
    },
  });

  return {
    app,
    config,
    appDb,
    boss,
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      await boss.stop({ graceful: true, close: true });
      await appDb.end();
      await platformDb.end();
    },
  };
}
