/* global fetch, navigator, self */

import { readOwnerBeat, listOutbox, deleteOutbox } from "./db.js";
import { sendOutboxEvent } from "./flush.js";
import { ExpirationPlugin } from "workbox-expiration";
import { matchPrecache, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";

const LOCK = "gotonghr-outbox";
const OWNER_FRESH_MS = 8000;

// The page sync manager owns the outbox. This worker does not POST while that lock is held.
registerRoute(
  ({ request, url }) => request.mode === "navigate" && (url.pathname === "/ess" || url.pathname === "/ess/"),
  async () => (await matchPrecache("/ess/index.html")) ?? fetch("/ess/index.html"),
);

precacheAndRoute(self.__WB_MANIFEST);

registerRoute(
  ({ url, request }) => request.method === "GET" && url.pathname === "/api/v1/mobile/bootstrap",
  new NetworkFirst({
    cacheName: "ess-shifts-14d",
    networkTimeoutSeconds: 4,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 4,
        maxAgeSeconds: 14 * 24 * 60 * 60,
      }),
    ],
  }),
);

self.addEventListener("sync", (event) => {
  if (event.tag !== "outbox-clock") return;
  event.waitUntil(flushIfOwnerFree());
});

async function flushIfOwnerFree() {
  if (await pageOwnsOutbox()) return;
  const events = await listOutbox();
  for (const event of events) {
    await sendOutboxEvent(event);
    await deleteOutbox(event.idempotency_key);
  }
}

async function pageOwnsOutbox() {
  if (navigator.locks) {
    const free = await navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => lock !== null);
    if (!free) return true;
  }
  const beat = await readOwnerBeat();
  return beat !== null && Date.now() - beat < OWNER_FRESH_MS;
}
