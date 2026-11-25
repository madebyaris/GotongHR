import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ruleClockEvent } from "./decide.ts";
import { haversineMeters } from "./haversine.ts";
import { DRIFT_REVIEW_SECONDS, MAX_PLAUSIBLE_TRAVEL_SPEED_KMH } from "./limits.ts";

const received = new Date("2026-06-01T01:00:00.000Z");

describe("clock ruling", () => {
  it("names the 1000 km/h fail line", () => {
    assert.equal(MAX_PLAUSIBLE_TRAVEL_SPEED_KMH, 1000);
    assert.equal(DRIFT_REVIEW_SECONDS, 600);
  });

  it("measures about 111.2 km for one degree of longitude at the equator", () => {
    const meters = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    assert.ok(Math.abs(meters - 111_195) < 50);
  });

  it("stores a 15 minute offline drift and does not flag it", () => {
    const ruling = ruleClockEvent(facts({ syncSource: "offline_queue", capturedAt: before(15 * 60_000) }));
    assert.equal(ruling.clockDriftSeconds, 900);
    assert.equal(ruling.reviewStatus, "ok");
    assert.deepEqual(ruling.reviewReasons, []);
  });

  it("flags a 15 minute drift that was not queued offline", () => {
    const ruling = ruleClockEvent(facts({ syncSource: "online", capturedAt: before(15 * 60_000) }));
    assert.equal(ruling.clockDriftSeconds, 900);
    assert.equal(ruling.reviewStatus, "needs_review");
    assert.deepEqual(ruling.reviewReasons, ["clock_drift"]);
  });

  it("does not flag 600 seconds and does flag 601", () => {
    assert.equal(ruleClockEvent(facts({ capturedAt: before(600_000) })).reviewStatus, "ok");
    const over = ruleClockEvent(facts({ capturedAt: before(601_000) }));
    assert.equal(over.reviewStatus, "needs_review");
    assert.deepEqual(over.reviewReasons, ["clock_drift"]);
  });

  it("sets geofence_ok false outside the radius and still returns a ruling", () => {
    const ruling = ruleClockEvent(facts({ point: { lat: 0, lng: 0.02 } }));
    assert.equal(ruling.geofenceOk, false);
    assert.ok((ruling.distanceMeters ?? 0) > 200);
    assert.equal(ruling.reviewStatus, "needs_review");
    assert.deepEqual(ruling.reviewReasons, ["geofence"]);
  });

  it("flags travel faster than 1000 km/h", () => {
    const ruling = ruleClockEvent(
      facts({
        capturedAt: before(1_000),
        point: { lat: 0, lng: 1 },
        previous: { lat: 0, lng: 0, capturedAt: before(2_000) },
        geofence: { lat: 0, lng: 0, radiusMeters: 500_000 },
      }),
    );
    assert.ok((ruling.speedKmh ?? 0) > MAX_PLAUSIBLE_TRAVEL_SPEED_KMH);
    assert.equal(ruling.geofenceOk, true);
    assert.deepEqual(ruling.reviewReasons, ["travel_speed"]);
  });
});

function before(ms: number): Date {
  return new Date(received.getTime() - ms);
}

function facts(overrides: {
  syncSource?: "online" | "offline_queue";
  capturedAt?: Date;
  point?: { lat: number; lng: number };
  previous?: { lat: number; lng: number; capturedAt: Date } | null;
  geofence?: { lat: number; lng: number; radiusMeters: number } | null;
}) {
  return {
    capturedAt: overrides.capturedAt ?? before(1_000),
    receivedAt: received,
    syncSource: overrides.syncSource ?? "online",
    point: overrides.point ?? { lat: 0, lng: 0 },
    geofence: overrides.geofence === undefined ? { lat: 0, lng: 0, radiusMeters: 200 } : overrides.geofence,
    previous: overrides.previous === undefined ? null : overrides.previous,
    mockLocationFlag: false,
    livenessOk: null,
    branchMismatch: false,
  };
}
