import { deleteOutbox, listOutbox, type OutboxClockEvent } from "./db.js";
import { sendOutboxEvent } from "./flush.js";
import { SYNC_BACKOFF_MS } from "./policy";

let chain: Promise<void> = Promise.resolve();

/** One flush at a time. A second call waits for the first so two tabs do not double-send. */
export function requestFlush(): Promise<void> {
  const run = chain.then(() => flushOnce());
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function flushOnce(): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const events = await listOutbox();
  for (const event of events) {
    await sendWithBackoff(event);
  }
}

async function sendWithBackoff(event: OutboxClockEvent): Promise<void> {
  for (let attempt = 0; attempt <= SYNC_BACKOFF_MS.length; attempt += 1) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    try {
      await sendOutboxEvent(event);
      await deleteOutbox(event.idempotency_key);
      return;
    } catch {
      const wait = SYNC_BACKOFF_MS[attempt];
      if (wait === undefined) return;
      await delay(wait);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function registerBackgroundSync(): Promise<void> {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const sync = (registration as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync;
  if (!sync) return;
  await sync.register("outbox-clock");
}
