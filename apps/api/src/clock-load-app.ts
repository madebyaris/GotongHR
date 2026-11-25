import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { migrateClock, registerClockRoutes } from "@gotonghr/attendance";
import { migrateCoreHr } from "@gotonghr/core-hr";
import {
  applyDatabaseUrls,
  createTenantDatabase,
  loadRepoEnv,
  migrate,
  migrateEnvFrom,
  requiredEnv,
} from "@gotonghr/db";
import { migrateIdentity } from "@gotonghr/identity";
import { createLocalStorage } from "@gotonghr/storage";
import Fastify from "fastify";
import pg from "pg";

const { Client } = pg;

interface Seed {
  tenantId: string;
  orgId: string;
  employeeId: string;
  root: string;
}

/**
 * Serves the real sync route for load-clock.mjs.
 * The process is the API under measurement. It removes its seed on SIGTERM.
 */
async function main(): Promise<void> {
  loadRepoEnv();
  applyDatabaseUrls(process.env);
  const env = migrateEnvFrom(process.env);
  await migrate(env);
  await migrateIdentity({ superuserUrl: env.superuserUrl, migratorUrl: env.migratorUrl });
  await migrateCoreHr({ migratorUrl: env.migratorUrl });
  await migrateClock({ migratorUrl: env.migratorUrl });

  const admin = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
  await admin.connect();
  const database = createTenantDatabase(requiredEnv(process.env, "DATABASE_URL_APP"));
  const seed = await insertSeed(admin);
  const storage = createLocalStorage({
    rootDir: seed.root,
    secret: "local-test-storage-secret-0123456789",
    urlPrefix: "",
  });
  const app = Fastify({ logger: false });
  const caller = { tenantId: seed.tenantId, userId: seed.employeeId, scopeBranchIds: [] as string[] };
  await registerClockRoutes(app, {
    database,
    storage,
    guard: async () => {},
    readCaller: () => caller,
  });

  let closing = false;
  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
      await deleteSeed(admin, seed);
      await rm(seed.root, { recursive: true, force: true });
      await database.end();
      await admin.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : "cleanup failed";
      process.stderr.write(`${message}\n`);
      process.exit(1);
    }
    process.exit(code);
  };

  process.once("SIGTERM", () => {
    void shutdown(0);
  });
  process.once("SIGINT", () => {
    void shutdown(0);
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("clock load port missing");
  process.stdout.write(`READY ${address.port} ${seed.employeeId}\n`);
}

async function insertSeed(admin: pg.Client): Promise<Seed> {
  const tenantId = randomUUID();
  const orgId = `clock-load-${tenantId}`;
  const legalEntityId = randomUUID();
  const branchId = randomUUID();
  const employeeId = randomUUID();
  const root = await mkdtemp(path.join(tmpdir(), "gotong-clock-load-"));
  await admin.query("BEGIN");
  try {
    await admin.query(`INSERT INTO ba_organization (id, name, slug) VALUES ($1, 'Clock load', $1)`, [orgId]);
    await admin.query(
      `INSERT INTO id_tenants (id, organization_id, name, slug) VALUES ($1::uuid, $2, 'Clock load', $2)`,
      [tenantId, orgId],
    );
    await admin.query(
      `INSERT INTO id_legal_entities (id, tenant_id, company_name, npwp_16)
       VALUES ($1::uuid, $2::uuid, 'PT Clock Load', '1000000000000301')`,
      [legalEntityId, tenantId],
    );
    await admin.query(
      `INSERT INTO id_branches (
         id, tenant_id, legal_entity_id, name, nitku_22, timezone, ump_umk_idr,
         geofence_lat, geofence_lng, geofence_radius_m
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'HQ', '1000000000000000000301', 'Asia/Jakarta', 5000000,
         0, 0, 1000
       )`,
      [branchId, tenantId, legalEntityId],
    );
    await admin.query(
      `INSERT INTO hr_employees (
         id, tenant_id, employee_code, full_name, legal_entity_id, branch_id,
         employment_status, join_date, ptkp_status, tax_method, pph21_subject_type
       ) VALUES (
         $1::uuid, $2::uuid, 'LOAD001', 'Load Employee', $3::uuid, $4::uuid,
         'active', '2024-01-15', 'TK/0', 'gross', 'permanent'
       )`,
      [employeeId, tenantId, legalEntityId, branchId],
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { tenantId, orgId, employeeId, root };
}

async function deleteSeed(admin: pg.Client, seed: Seed): Promise<void> {
  await admin.query("DELETE FROM att_clock_events WHERE tenant_id = $1::uuid", [seed.tenantId]);
  await admin.query("DELETE FROM hr_employees WHERE tenant_id = $1::uuid", [seed.tenantId]);
  await admin.query("DELETE FROM id_branches WHERE tenant_id = $1::uuid", [seed.tenantId]);
  await admin.query("DELETE FROM id_legal_entities WHERE tenant_id = $1::uuid", [seed.tenantId]);
  await admin.query("DELETE FROM id_tenants WHERE id = $1::uuid", [seed.tenantId]);
  await admin.query("DELETE FROM ba_organization WHERE id = $1", [seed.orgId]);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "clock load server failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
