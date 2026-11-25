import { applyDatabaseUrls, loadRepoEnv, migrate, migrateEnvFrom, requiredEnv } from "@gotonghr/db";
import { provisionQueue } from "../queue.ts";

async function main(): Promise<void> {
  loadRepoEnv();
  applyDatabaseUrls(process.env);
  await migrate(migrateEnvFrom(process.env));
  await provisionQueue(requiredEnv(process.env, "DATABASE_URL_MIGRATOR"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "migrate failed";
  process.stderr.write(`${JSON.stringify({ msg: "migrate failed", error: message })}\n`);
  process.exit(1);
});
