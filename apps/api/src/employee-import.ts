import {
  EMPLOYEE_IMPORT_QUEUE,
  processEmployeeImport,
  type EmployeeImportMessage,
} from "@gotonghr/core-hr";
import type { TenantDatabase } from "@gotonghr/db";
import type { ObjectStorage } from "@gotonghr/storage";
import type { PgBoss, Job } from "pg-boss";

const RETENTION_SECONDS = 7 * 24 * 60 * 60;

export async function ensureEmployeeImportQueue(boss: PgBoss): Promise<void> {
  const existing = await boss.getQueue(EMPLOYEE_IMPORT_QUEUE);
  if (existing) return;
  await boss.createQueue(EMPLOYEE_IMPORT_QUEUE, { deleteAfterSeconds: RETENTION_SECONDS });
}

export async function sendEmployeeImport(boss: PgBoss, message: EmployeeImportMessage): Promise<void> {
  await ensureEmployeeImportQueue(boss);
  await boss.send(
    EMPLOYEE_IMPORT_QUEUE,
    { tenantId: message.tenantId, importJobId: message.importJobId },
    {
      id: message.importJobId,
      singletonKey: message.importJobId,
      retryLimit: 2,
      retryDelay: 30,
      expireInSeconds: 15 * 60,
      deleteAfterSeconds: RETENTION_SECONDS,
    },
  );
}

export async function startEmployeeImportWorker(
  boss: PgBoss,
  deps: { appDb: TenantDatabase; storage: ObjectStorage },
): Promise<void> {
  await ensureEmployeeImportQueue(boss);
  await boss.work<EmployeeImportMessage>(
    EMPLOYEE_IMPORT_QUEUE,
    { localConcurrency: 1 },
    async (jobs: Job<EmployeeImportMessage>[]) => {
      for (const job of jobs) {
        await processEmployeeImport(deps, job.data);
      }
    },
  );
}
