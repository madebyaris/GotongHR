import {
  TENANT_EXPORT_QUEUE,
  processTenantExport,
  type TenantExportDeps,
  type TenantExportMessage,
} from "@gotonghr/platform";
import type { PgBoss, Job } from "pg-boss";

const RETENTION_SECONDS = 7 * 24 * 60 * 60;

export async function ensureTenantExportQueue(boss: PgBoss): Promise<void> {
  const existing = await boss.getQueue(TENANT_EXPORT_QUEUE);
  if (existing) return;
  await boss.createQueue(TENANT_EXPORT_QUEUE, { deleteAfterSeconds: RETENTION_SECONDS });
}

export async function sendTenantExport(boss: PgBoss, message: TenantExportMessage): Promise<void> {
  await ensureTenantExportQueue(boss);
  await boss.send(TENANT_EXPORT_QUEUE, { tenantId: message.tenantId, exportId: message.exportId }, {
    id: message.exportId,
    singletonKey: message.exportId,
    retryLimit: 2,
    retryDelay: 30,
    expireInSeconds: 15 * 60,
    deleteAfterSeconds: RETENTION_SECONDS,
  });
}

export async function startTenantExportWorker(boss: PgBoss, deps: TenantExportDeps): Promise<void> {
  await ensureTenantExportQueue(boss);
  await boss.work<TenantExportMessage>(
    TENANT_EXPORT_QUEUE,
    { localConcurrency: 1 },
    async (jobs: Job<TenantExportMessage>[]) => {
      for (const job of jobs) {
        await processTenantExport(deps, job.data);
      }
    },
  );
}
