import pg from "pg";
import { assertProductionDatabaseSecrets, requiredEnv } from "./env.ts";
import { tenantIsolationPolicySql } from "./policy.ts";

const { Client } = pg;

export const APP_ROLE = "app_tenant";
export const PLATFORM_ROLE = "platform_admin";
export const MIGRATOR_ROLE = "gotong_migrator";
export const QUEUE_ROLE = "gotong_queue";
export const QUEUE_SCHEMA = "pgboss";

export interface MigrateEnv {
  superuserUrl: string;
  migratorUrl: string;
  migratorPassword: string;
  appPassword: string;
  platformPassword: string;
  queuePassword: string;
}

export function migrateEnvFrom(env: NodeJS.ProcessEnv): MigrateEnv {
  const input: MigrateEnv = {
    superuserUrl: requiredEnv(env, "DATABASE_URL_SUPERUSER"),
    migratorUrl: requiredEnv(env, "DATABASE_URL_MIGRATOR"),
    migratorPassword: requiredEnv(env, "MIGRATOR_PASSWORD"),
    appPassword: requiredEnv(env, "APP_PASSWORD"),
    platformPassword: requiredEnv(env, "PLATFORM_PASSWORD"),
    queuePassword: requiredEnv(env, "QUEUE_PASSWORD"),
  };
  assertProductionDatabaseSecrets(env);
  return input;
}

interface StatementRow {
  stmt: string;
}

async function runFormatted(
  client: pg.Client,
  template: string,
  values: string[],
): Promise<void> {
  const formatted = await client.query<StatementRow>(template, values);
  const statement = formatted.rows[0]?.stmt;
  if (!statement) {
    throw new Error("Role statement was empty.");
  }
  await client.query(statement);
}

async function ensureRole(
  client: pg.Client,
  role: string,
  password: string,
): Promise<void> {
  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
    role,
  ]);
  const verb = (existing.rowCount ?? 0) > 0 ? "ALTER ROLE %I WITH" : "CREATE ROLE %I";
  await runFormatted(
    client,
    `SELECT format('${verb} LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', $1::text, $2::text) AS stmt`,
    [role, password],
  );
}

function databaseName(connectionString: string): string {
  const name = new URL(connectionString).pathname.replace(/^\//, "");
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error("Database name must be a plain identifier.");
  }
  return name;
}

/**
 * Creates the database roles, then applies the probe schema as the migrator.
 * Request handlers use app_tenant. The queue role is not the migrator.
 */
export async function migrate(input: MigrateEnv): Promise<void> {
  const database = databaseName(input.superuserUrl);
  const admin = new Client({ connectionString: input.superuserUrl });
  await admin.connect();
  try {
    await ensureRole(admin, MIGRATOR_ROLE, input.migratorPassword);
    await ensureRole(admin, APP_ROLE, input.appPassword);
    await ensureRole(admin, PLATFORM_ROLE, input.platformPassword);
    await ensureRole(admin, QUEUE_ROLE, input.queuePassword);
    await runFormatted(
      admin,
      "SELECT format('GRANT CONNECT, CREATE ON DATABASE %I TO %I', $1::text, $2::text) AS stmt",
      [database, MIGRATOR_ROLE],
    );
    for (const role of [APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE]) {
      await runFormatted(
        admin,
        "SELECT format('GRANT CONNECT ON DATABASE %I TO %I', $1::text, $2::text) AS stmt",
        [database, role],
      );
    }
    await admin.query(`ALTER SCHEMA public OWNER TO ${MIGRATOR_ROLE}`);
    await admin.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ${APP_ROLE}`,
    );
  } finally {
    await admin.end();
  }

  const migrator = new Client({ connectionString: input.migratorUrl });
  await migrator.connect();
  try {
    await migrator.query(`
      CREATE TABLE IF NOT EXISTS rls_probe (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        tenant_id uuid NOT NULL
      )
    `);
    await migrator.query(
      "CREATE INDEX IF NOT EXISTS rls_probe_tenant_id_idx ON rls_probe (tenant_id)",
    );
    await migrator.query(tenantIsolationPolicySql("rls_probe"));
    await migrator.query(`REVOKE ALL ON TABLE rls_probe FROM PUBLIC`);
    await migrator.query(`REVOKE ALL ON TABLE rls_probe FROM ${PLATFORM_ROLE}`);
    await migrator.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE rls_probe TO ${APP_ROLE}`,
    );
    await migrator.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await migrator.query(`GRANT USAGE ON SCHEMA public TO ${PLATFORM_ROLE}`);
    await migrator.query(`REVOKE CREATE ON SCHEMA public FROM ${APP_ROLE}`);
    await migrator.query(`REVOKE CREATE ON SCHEMA public FROM ${PLATFORM_ROLE}`);
    await migrator.query(`REVOKE CREATE ON SCHEMA public FROM ${QUEUE_ROLE}`);
  } finally {
    await migrator.end();
  }
}

/** Grants the queue role DML on the pg-boss schema. The caller creates that schema first. */
export async function grantSchemaDml(
  connectionString: string,
  schema: string,
  role: string,
): Promise<void> {
  if (schema !== QUEUE_SCHEMA || role !== QUEUE_ROLE) {
    throw new Error("Schema grants are limited to the queue schema.");
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`GRANT USAGE ON SCHEMA ${QUEUE_SCHEMA} TO ${QUEUE_ROLE}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${QUEUE_SCHEMA} TO ${QUEUE_ROLE}`,
    );
    await client.query(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${QUEUE_SCHEMA} TO ${QUEUE_ROLE}`,
    );
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${QUEUE_SCHEMA} TO ${QUEUE_ROLE}`);
  } finally {
    await client.end();
  }
}
