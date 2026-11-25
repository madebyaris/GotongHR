import { migrateAi } from "@gotonghr/ai";
import { migrateAttendance, migrateClock } from "@gotonghr/attendance";
import { migrateAudit } from "@gotonghr/audit";
import { migrateCoreHr } from "@gotonghr/core-hr";
import { migrate, migrateEnvFrom } from "@gotonghr/db";
import { migrateIdentity } from "@gotonghr/identity";
import { migratePayroll } from "@gotonghr/payroll";
import { migratePlatform } from "./migrate.ts";

/** Applies every tenant schema the isolation suite reads. Test support only. */
export async function applyTenantSchema(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const migrateEnv = migrateEnvFrom(env);
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
  await migratePayroll({ migratorUrl: migrateEnv.migratorUrl });
  await migrateAi({
    migratorUrl: migrateEnv.migratorUrl,
    superuserUrl: migrateEnv.superuserUrl,
  });
}

if (process.env.GOTONG_APPLY_TENANT_SCHEMA === "1") {
  await applyTenantSchema();
}
