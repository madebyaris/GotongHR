import { writeOwnerBeat } from "./db.js";
import { OUTBOX_LOCK, OWNER_BEAT_MS } from "./policy";

/**
 * Holds the outbox for this document. The service worker skips POST while this lock is taken
 * or the heartbeat is fresh.
 */
export function holdOutbox(): void {
  void writeOwnerBeat();
  window.setInterval(() => {
    void writeOwnerBeat();
  }, OWNER_BEAT_MS);
  if (!navigator.locks) return;
  void navigator.locks.request(
    OUTBOX_LOCK,
    () =>
      new Promise<void>(() => {
        // The lock stays until the document closes.
      }),
  );
}
