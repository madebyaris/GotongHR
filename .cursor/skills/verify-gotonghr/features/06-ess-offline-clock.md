# Clock in offline and sync once

The employee loses the network, takes one selfie, and the punch waits on the phone. When the network returns, the phone syncs that punch once. A second sync of the same key does not add a row.

## Sub-features

- `ess-offline-queue` stores one punch in `outbox_clock_events` while the browser is offline.
- `ess-sync-once` writes one `att_clock_events` row and ignores a second post of the same key.

## How to get to it (user POV)

- Start from the ESS clock in feature 05.
- Turn the network off.
- Choose a selfie. The page shows `Offline`, `1 punch waiting to sync`, and Clock out.
- Turn the network on. The waiting line goes away.

## Driving it with Playwright

Preconditions:

- Feature 05 is set up. The same owner, employee, shift, and branch geofence are in place.
- The Vite dev server is the page. It does not register the service worker, so the page owns the outbox.

- **Go offline.** `page.context().setOffline(true)`. Grant geolocation at the branch pin before this. The page shows `Offline`.
- **Queue one punch.** `page.getByLabel("Selfie").setInputFiles(png)`. The file is a real PNG Chromium can decode. IndexedDB `gotonghr-ess` store `outbox_clock_events` has one row. The row has `idempotency_key`, `punch_type` `clock_in`, `captured_at`, `monotonic_elapsed_ms`, `lat`, `lng`, `accuracy`, `mock_location_flags`, and a `selfie_blob` under 40 KB.
- **Proof of the queue.** Screenshot the 390px screen. It shows `Offline` and `1 punch waiting to sync`.
- **Sync once.** `page.context().setOffline(false)`, then `page.evaluate(() => window.dispatchEvent(new Event("online")))`. Wait until `att_clock_events` has one row for that `idempotency_key`.
- **Sync again.** POST the captured `/api/v1/mobile/attendance/sync` body a second time. The row count is still 1.

## Gotchas

- `context.setOffline(true)` blocks the presign call. Do not click Clock in until the selfie input is set. The button only opens the file picker.
- The camera policy is `camera=()`. Use a file input with `capture=user`. Do not call `getUserMedia`.
- The service worker does not POST while the page holds the `gotonghr-outbox` lock. This drive uses the Vite server, so only the page syncs.
- A successful sync deletes the outbox row. The second attempt must replay the same JSON body. An empty flush is not the second attempt.
- The selfie in IndexedDB is a resized WebP or JPEG. The sync POST sends the storage key, not the bytes.
