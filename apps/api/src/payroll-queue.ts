import {
  PAYROLL_CALC_QUEUE,
  PAYROLL_PDF_QUEUE,
  processPayrollCalculation,
  processPayrollPayslips,
  type PayrollCalcMessage,
  type PayrollPdfMessage,
  type PayrollQueuePort,
  type PayrollStoragePort,
} from "@gotonghr/payroll";
import type { TenantDatabase } from "@gotonghr/db";
import type { Job, PgBoss } from "pg-boss";
import { createMemorySqsClient, createSqsPayrollQueue } from "./queue/sqs.ts";

const RETENTION_SECONDS = 7 * 24 * 60 * 60;

/**
 * `pgboss` is the default. `sqs` uses the in-memory client and does not call AWS.
 */
export function createPayrollQueue(driver: "pgboss" | "sqs", boss: PgBoss): PayrollQueuePort {
  if (driver === "sqs") {
    process.stderr.write(
      `${JSON.stringify({ msg: "QUEUE_DRIVER=sqs uses the in-memory client", liveAws: false })}\n`,
    );
    return createSqsPayrollQueue(createMemorySqsClient());
  }
  return createPgBossPayrollQueue(boss);
}

export function createPgBossPayrollQueue(boss: PgBoss): PayrollQueuePort {
  return {
    async enqueueCalculation(messages) {
      await ensureQueue(boss, PAYROLL_CALC_QUEUE);
      for (const message of messages) {
        await boss.send(PAYROLL_CALC_QUEUE, message, {
          singletonKey: `${message.runId}:${message.batchIndex}`,
          retryLimit: 2,
          retryDelay: 30,
          expireInSeconds: 15 * 60,
          deleteAfterSeconds: RETENTION_SECONDS,
        });
      }
    },
    async enqueuePayslips(messages) {
      await ensureQueue(boss, PAYROLL_PDF_QUEUE);
      for (const message of messages) {
        await boss.send(PAYROLL_PDF_QUEUE, message, {
          singletonKey: `${message.runId}:pdf:${message.batchIndex}`,
          retryLimit: 2,
          retryDelay: 30,
          expireInSeconds: 15 * 60,
          deleteAfterSeconds: RETENTION_SECONDS,
        });
      }
    },
  };
}

export async function startPayrollWorkers(
  boss: PgBoss,
  deps: { appDb: TenantDatabase; storage: PayrollStoragePort },
): Promise<void> {
  await ensureQueue(boss, PAYROLL_CALC_QUEUE);
  await ensureQueue(boss, PAYROLL_PDF_QUEUE);
  await boss.work<PayrollCalcMessage>(
    PAYROLL_CALC_QUEUE,
    { localConcurrency: 2 },
    async (jobs: Job<PayrollCalcMessage>[]) => {
      for (const job of jobs) await processPayrollCalculation(deps, job.data);
    },
  );
  await boss.work<PayrollPdfMessage>(
    PAYROLL_PDF_QUEUE,
    { localConcurrency: 2 },
    async (jobs: Job<PayrollPdfMessage>[]) => {
      for (const job of jobs) await processPayrollPayslips(deps, job.data);
    },
  );
}

async function ensureQueue(boss: PgBoss, name: string): Promise<void> {
  const existing = await boss.getQueue(name);
  if (existing) return;
  await boss.createQueue(name, { deleteAfterSeconds: RETENTION_SECONDS });
}
