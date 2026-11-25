import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { STALE_MS, SYNC_BACKOFF_MS, backoffDelay, nextPunch, uuidv7 } from "../src/ess/policy.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("ess policy", () => {
  it("keeps the cache windows from the slice", () => {
    assert.equal(STALE_MS.shifts, 15 * 60 * 1000);
    assert.equal(STALE_MS.leaveTypes, 15 * 60 * 1000);
    assert.equal(STALE_MS.balances, 5 * 60 * 1000);
    assert.equal(STALE_MS.today, 30 * 1000);
    assert.deepEqual([...SYNC_BACKOFF_MS], [2_000, 5_000, 15_000, 60_000]);
    assert.equal(backoffDelay(0), 2_000);
    assert.equal(backoffDelay(3), 60_000);
    assert.equal(nextPunch(null), "clock_in");
    assert.equal(nextPunch("clock_in"), "clock_out");
    assert.equal(nextPunch("clock_out"), "clock_in");
    assert.match(uuidv7(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("keeps one outbox owner in the service worker", () => {
    const sw = readFileSync(path.join(root, "src/ess/sw.js"), "utf8");
    const db = readFileSync(path.join(root, "src/ess/db.js"), "utf8");
    assert.match(sw, /does not POST/);
    assert.match(sw, /ifAvailable:\s*true/);
    assert.match(sw, /gotonghr-outbox/);
    assert.match(sw, /ess-shifts-14d/);
    assert.match(db, /outbox_clock_events/);
    assert.match(db, /sync_control/);
    assert.match(db, /bootstrap_cache/);
    assert.match(sw, /\/api\/v1\/mobile\/bootstrap/);
  });
});
