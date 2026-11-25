import type { DomainActionExecutor } from "@gotonghr/contracts";
import {
  applyDatabaseUrls,
  createTenantDatabase,
  loadRepoEnv,
  requiredEnv,
  type TenantDatabase,
} from "@gotonghr/db";
import type { AiRuntimeDeps, LlmProvider } from "@gotonghr/ai";
import {
  createAuth,
  hashPassword,
  readAuthSecret,
  readTrustProxy,
  registerIdentity,
  type GotongAuth,
} from "@gotonghr/identity";
import {
  openPlatformDatabase,
  platformApiMounted,
  readPlatformDatabaseUrl,
  registerPlatform,
} from "@gotonghr/platform";
import { createStorage } from "@gotonghr/storage";
import type { PgBoss } from "pg-boss";
import { registerTenantAi } from "./ai.ts";
import { readConfig, type AppConfig } from "./config.ts";
import { platformReaders } from "./platform-auth.ts";
import { buildServer } from "./server.ts";
import { MAINTENANCE_QUEUE, startBoss } from "./queue.ts";
import type { FastifyInstance } from "fastify";

export interface ComposedApp {
  app: FastifyInstance;
  config: AppConfig;
  appDb: TenantDatabase;
  auth: GotongAuth;
  boss: PgBoss;
  close(): Promise<void>;
}

export interface ComposeOptions {
  aiDomain?: DomainActionExecutor;
  aiProvider?: LlmProvider;
  aiLoadTable?: AiRuntimeDeps["loadTable"];
}

export async function composeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ComposeOptions = {},
): Promise<ComposedApp> {
  loadRepoEnv();
  applyDatabaseUrls(env);
  const config = readConfig(env);
  const appDb = createTenantDatabase(requiredEnv(env, "DATABASE_URL_APP"));
  const platformDb = await openPlatformDatabase(readPlatformDatabaseUrl(env));
  let boss: PgBoss | undefined;
  let app: FastifyInstance | undefined;
  try {
    await appDb.pool.query("select 1");
    await platformDb.pool.query("select 1");
    boss = await startBoss(requiredEnv(env, "DATABASE_URL_QUEUE"));
    const storage = createStorage(env);
    let closed = false;
    let closing: Promise<void> | undefined;
    const runningBoss = boss;
    app = await buildServer({
      logger: env.NODE_ENV !== "test",
      trustProxy: readTrustProxy(env),
      storage,
      checkReady: async () => {
        if (closed) {
          throw new Error("queue is not started");
        }
        await appDb.pool.query("select 1");
        const queue = await runningBoss.getQueue(MAINTENANCE_QUEUE);
        if (!queue) {
          throw new Error("maintenance queue is missing");
        }
      },
    });
    const auth = createAuth({ appDb, env });
    await registerIdentity(app, { auth, appDb, env });
    await registerTenantAi(app, {
      database: appDb,
      env,
      ...(options.aiDomain ? { domain: options.aiDomain } : {}),
      ...(options.aiProvider ? { provider: options.aiProvider } : {}),
      ...(options.aiLoadTable ? { loadTable: options.aiLoadTable } : {}),
    });
    const readers = platformReaders({ auth, platform: platformDb });
    await registerPlatform(app, {
      platform: platformDb,
      app: appDb,
      mountPlatformRoutes: platformApiMounted(config.deploymentMode),
      inviteSecret: readAuthSecret(env),
      hashOwnerPassword: hashPassword,
      readPlatformActor: readers.readPlatformActor,
      readTenantAdmin: readers.readTenantAdmin,
    });
    const runningApp = app;

    return {
      app,
      config,
      appDb,
      auth,
      boss,
      close() {
        closing ??= (async () => {
          closed = true;
          const failures: unknown[] = [];
          for (const step of [
            () => runningApp.close(),
            () => runningBoss.stop({ graceful: true, close: true }),
            () => appDb.end(),
            () => platformDb.end(),
          ]) {
            try {
              await step();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length === 0) return;
          const errors = failures.map((failure) =>
            failure instanceof Error ? failure : new Error(String(failure)),
          );
          for (const error of errors) {
            process.stderr.write(
              `${JSON.stringify({ msg: "shutdown step failed", error: error.message })}\n`,
            );
          }
          throw new AggregateError(errors, "shutdown failed");
        })();
        return closing;
      },
    };
  } catch (error) {
    await app?.close().catch(() => undefined);
    await boss?.stop({ graceful: false, close: true }).catch(() => undefined);
    await appDb.end().catch(() => undefined);
    await platformDb.end().catch(() => undefined);
    throw error;
  }
}
