import type { PgBoss } from "pg-boss";
import pg from "pg";

const { Client } = pg;

/** One queue. The topic stays on the job body so each event name does not create a queue. */
export const OUTBOX_QUEUE = "gotong.outbox";
const OUTBOX_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export interface OutboxDispatchResult {
  published: number;
  failed: number;
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  topic: string;
  payload: unknown;
}

/**
 * Job id and singleton slot stay equal to the outbox id for the retention window.
 * A crash after pg-boss commits and before `published_at` commits retries the same id.
 * `send` returns null when that id already exists, and the row is still marked published.
 */
export function outboxJobOptions(outboxId: string): {
  id: string;
  singletonKey: string;
  singletonSeconds: number;
  deleteAfterSeconds: number;
} {
  return {
    id: outboxId,
    singletonKey: outboxId,
    singletonSeconds: OUTBOX_RETENTION_SECONDS,
    deleteAfterSeconds: OUTBOX_RETENTION_SECONDS,
  };
}

/**
 * Publishes unpublished outbox rows through pg-boss and sets `published_at`.
 * A row that already has `published_at` is skipped.
 */
export async function dispatchOutboxOnce(
  boss: PgBoss,
  connectionString: string,
  limit = 20,
): Promise<OutboxDispatchResult> {
  const batch = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await ensureQueue(boss);
    const claimed = await client.query<ClaimedRow>(
      `SELECT id::text AS id, tenant_id::text AS tenant_id, topic, payload
       FROM aud_outbox_events
       WHERE published_at IS NULL
       ORDER BY aud_outbox_events.created_at, aud_outbox_events.id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    let published = 0;
    let failed = 0;
    for (const row of claimed.rows) {
      try {
        await boss.send(
          OUTBOX_QUEUE,
          {
            outboxId: row.id,
            tenantId: row.tenant_id,
            topic: row.topic,
            payload: row.payload,
          },
          outboxJobOptions(row.id),
        );
        const updated = await client.query(
          `UPDATE aud_outbox_events
           SET published_at = clock_timestamp(), attempts = attempts + 1, last_error = NULL
           WHERE id = $1::uuid AND published_at IS NULL`,
          [row.id],
        );
        if ((updated.rowCount ?? 0) > 0) published += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : "outbox publish failed";
        await client.query(
          `UPDATE aud_outbox_events
           SET attempts = attempts + 1, last_error = $2
           WHERE id = $1::uuid AND published_at IS NULL`,
          [row.id, message.slice(0, 500)],
        );
      }
    }
    await client.query("COMMIT");
    return { published, failed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

export function startOutboxDispatcher(options: {
  boss: PgBoss;
  connectionString: string;
  intervalMs?: number;
  limit?: number;
}): { stop(): Promise<void> } {
  const intervalMs = options.intervalMs ?? 5_000;
  const limit = options.limit ?? 20;
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = (): void => {
    if (stopped || running) return;
    running = dispatchOutboxOnce(options.boss, options.connectionString, limit)
      .then(() => undefined)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "outbox dispatch failed";
        process.stderr.write(
          `${JSON.stringify({ msg: "outbox dispatch failed", error: message })}\n`,
        );
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

async function ensureQueue(boss: PgBoss): Promise<void> {
  const existing = await boss.getQueue(OUTBOX_QUEUE);
  if (existing) return;
  await boss.createQueue(OUTBOX_QUEUE, { deleteAfterSeconds: OUTBOX_RETENTION_SECONDS });
}
