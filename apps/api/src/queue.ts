import { PgBoss } from "pg-boss";

export const BOSS_SCHEMA = "pgboss";
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

export async function startBoss(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: BOSS_SCHEMA });
  boss.on("error", (error: Error) => {
    process.stderr.write(`${JSON.stringify({ msg: "pg-boss error", error: error.message })}\n`);
  });
  await boss.start();
  const existing = await boss.getQueue(MAINTENANCE_QUEUE);
  if (existing) {
    await boss.updateQueue(MAINTENANCE_QUEUE, queueDefaults());
  } else {
    await boss.createQueue(MAINTENANCE_QUEUE, queueDefaults());
  }
  return boss;
}
