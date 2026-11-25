import type { PgBoss } from "pg-boss";

export const CONTRACT_EXPIRY_QUEUE = "gotong.core_hr.contract_expiry";

/** 07:00 Asia/Jakarta, every day. The worker inserts outbox rows and does not send email. */
export const CONTRACT_EXPIRY_CRON = "0 7 * * *";
export const CONTRACT_EXPIRY_TZ = "Asia/Jakarta";

export async function registerContractExpiryJob(
  boss: PgBoss,
  run: (now: Date) => Promise<void>,
  clock: () => Date = () => new Date(),
): Promise<void> {
  const existing = await boss.getQueue(CONTRACT_EXPIRY_QUEUE);
  if (!existing) await boss.createQueue(CONTRACT_EXPIRY_QUEUE);
  await boss.schedule(CONTRACT_EXPIRY_QUEUE, CONTRACT_EXPIRY_CRON, {}, { tz: CONTRACT_EXPIRY_TZ });
  await boss.work(CONTRACT_EXPIRY_QUEUE, async () => {
    await run(clock());
  });
}
