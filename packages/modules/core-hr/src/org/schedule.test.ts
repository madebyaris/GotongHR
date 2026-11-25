import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PgBoss } from "pg-boss";
import {
  CONTRACT_EXPIRY_CRON,
  CONTRACT_EXPIRY_QUEUE,
  CONTRACT_EXPIRY_TZ,
  registerContractExpiryJob,
} from "./schedule.ts";

describe("contract expiry schedule", () => {
  it("registers a daily Asia/Jakarta job and runs it once per fire", async () => {
    const seen: { cron?: string; tz?: string } = {};
    let handler: (() => Promise<void>) | undefined;
    const frozen = new Date("2026-11-24T17:30:00.000Z");
    let ranAt: Date | undefined;
    const boss = {
      async getQueue() {
        return null;
      },
      async createQueue() {
        return undefined;
      },
      async schedule(_name: string, cron: string, _data: object, options?: { tz?: string }) {
        seen.cron = cron;
        if (options?.tz !== undefined) seen.tz = options.tz;
      },
      async work(_name: string, next: () => Promise<void>) {
        handler = next;
        return "worker";
      },
    };
    await registerContractExpiryJob(
      boss as unknown as PgBoss,
      async (now) => {
        ranAt = now;
      },
      () => frozen,
    );
    assert.equal(seen.cron, CONTRACT_EXPIRY_CRON);
    assert.equal(seen.tz, CONTRACT_EXPIRY_TZ);
    assert.ok(handler);
    await handler();
    assert.equal(ranAt?.toISOString(), frozen.toISOString());
    assert.equal(CONTRACT_EXPIRY_QUEUE, "gotong.core_hr.contract_expiry");
  });
});
