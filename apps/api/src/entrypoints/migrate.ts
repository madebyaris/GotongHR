import { migrateAi } from "@gotonghr/ai";
import { migrateAnomalies, migrateAttendance, migrateClock } from "@gotonghr/attendance";
import { migrateAudit } from "@gotonghr/audit";
import { migrateCoreHr } from "@gotonghr/core-hr";
import { applyDatabaseUrls, loadRepoEnv, migrate, migrateEnvFrom, requiredEnv } from "@gotonghr/db";
import { migrateIdentity } from "@gotonghr/identity";
import { migratePlatform } from "@gotonghr/platform";
import { provisionQueue } from "../queue.ts";

async function main(): Promise<void> {
  loadRepoEnv();
  applyDatabaseUrls(process.env);
  const migrateEnv = migrateEnvFrom(process.env);
  await migrate(migrateEnv);
  await migrateIdentity({
    superuserUrl: migrateEnv.superuserUrl,
    migratorUrl: migrateEnv.migratorUrl,
  });
  await migratePlatform({
    superuserUrl: migrateEnv.superuserUrl,
    migratorUrl: migrateEnv.migratorUrl,
  });
  await migrateAudit({ migratorUrl: migrateEnv.migratorUrl });
  await migrateCoreHr({ migratorUrl: migrateEnv.migratorUrl });
  await migrateAttendance({ migratorUrl: migrateEnv.migratorUrl });
  await migrateClock({ migratorUrl: migrateEnv.migratorUrl });
  await migrateAnomalies({ migratorUrl: migrateEnv.migratorUrl });
  await migrateAi({
    migratorUrl: migrateEnv.migratorUrl,
    superuserUrl: migrateEnv.superuserUrl,
  });
  await provisionQueue(requiredEnv(process.env, "DATABASE_URL_MIGRATOR"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "migrate failed";
  process.stderr.write(`${JSON.stringify({ msg: "migrate failed", error: message })}\n`);
  process.exit(1);
});
