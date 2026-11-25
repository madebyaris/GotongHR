import { grantSchemaDml, QUEUE_ROLE, QUEUE_SCHEMA } from "@gotonghr/db";
import pg from "pg";
import { PgBoss } from "pg-boss";

const QUEUE_PROVISION_LOCK = "gotonghr.queue.provision";

export const BOSS_SCHEMA = QUEUE_SCHEMA;
export const MAINTENANCE_QUEUE = "gotong.maintenance";

/** pg-boss 12 deletes completed jobs in place. It has no archive table. */
export const COMPLETED_JOB_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const WORKER_POLLING_INTERVAL_SECONDS = 5;
export const WORKER_CONCURRENCY = 2;

export function queueDefaults(): { deleteAfterSeconds: number } {
  return { deleteAfterSeconds: COMPLETED_JOB_RETENTION_SECONDS };
}

export function workerDefaults(): {
  pollingIntervalSeconds: number;
  localConcurrency: number;
} {
  return {
    pollingIntervalSeconds: WORKER_POLLING_INTERVAL_SECONDS,
    localConcurrency: WORKER_CONCURRENCY,
  };
}

export async function startBoss(
  connectionString: string,
  options?: { provision?: boolean },
): Promise<PgBoss> {
  const provision = options?.provision === true;
  const boss = new PgBoss({
    connectionString,
    schema: BOSS_SCHEMA,
    createSchema: provision,
    migrate: provision,
  });
  boss.on("error", (error: Error) => {
    process.stderr.write(`${JSON.stringify({ msg: "pg-boss error", error: error.message })}\n`);
  });
  try {
    await boss.start();
    const existing = await boss.getQueue(MAINTENANCE_QUEUE);
    if (existing) {
      await boss.updateQueue(MAINTENANCE_QUEUE, queueDefaults());
    } else {
      await boss.createQueue(MAINTENANCE_QUEUE, queueDefaults());
    }
    return boss;
  } catch (error) {
    await boss.stop({ graceful: false, close: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Creates the pg-boss schema as the migrator, then grants DML to gotong_queue.
 * An advisory lock keeps two callers, including parallel test files, from
 * migrating the schema at the same time.
 */
export async function provisionQueue(migratorUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1)::bigint)", [QUEUE_PROVISION_LOCK]);
    const boss = await startBoss(migratorUrl, { provision: true });
    try {
      await grantSchemaDml(migratorUrl, BOSS_SCHEMA, QUEUE_ROLE);
    } finally {
      await boss.stop({ graceful: false, close: true });
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [QUEUE_PROVISION_LOCK])
      .catch(() => undefined);
    await client.end();
  }
}
