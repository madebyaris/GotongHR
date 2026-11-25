import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DRIFT_REVIEW_SECONDS, MAX_PLAUSIBLE_TRAVEL_SPEED_KMH } from "../clock/limits.ts";
import { anomalyReasons, type ReasonFacts } from "./reasons.ts";

function facts(overrides: Partial<ReasonFacts> = {}): ReasonFacts {
  return {
    stored: [],
    geofenceOk: true,
    clockDriftSeconds: 1,
    syncSource: "online",
    speedKmh: null,
    livenessOk: true,
    mockLocationFlag: false,
    ...overrides,
  };
}

describe("anomaly reasons", () => {
  it("keeps stored engine codes and does not repeat a flag", () => {
    assert.deepEqual(
      anomalyReasons(facts({ stored: ["liveness"], livenessOk: false })),
      ["liveness"],
    );
    assert.deepEqual(
      anomalyReasons(facts({ stored: ["missing_geofence"], geofenceOk: false })),
      ["missing_geofence"],
    );
  });

  it("fills geofence, drift, speed, liveness, and mock when the JSON is empty", () => {
    assert.deepEqual(anomalyReasons(facts({ geofenceOk: false })), ["geofence"]);
    assert.deepEqual(
      anomalyReasons(facts({ clockDriftSeconds: DRIFT_REVIEW_SECONDS + 1 })),
      ["clock_drift"],
    );
    assert.deepEqual(
      anomalyReasons(facts({ speedKmh: MAX_PLAUSIBLE_TRAVEL_SPEED_KMH + 0.01 })),
      ["travel_speed"],
    );
    assert.deepEqual(anomalyReasons(facts({ livenessOk: false })), ["liveness"]);
    assert.deepEqual(anomalyReasons(facts({ mockLocationFlag: true })), ["mock_location"]);
  });

  it("does not flag the exact drift and speed limits, or offline drift", () => {
    assert.deepEqual(anomalyReasons(facts({ clockDriftSeconds: DRIFT_REVIEW_SECONDS })), []);
    assert.deepEqual(anomalyReasons(facts({ speedKmh: MAX_PLAUSIBLE_TRAVEL_SPEED_KMH })), []);
    assert.deepEqual(
      anomalyReasons(
        facts({ clockDriftSeconds: DRIFT_REVIEW_SECONDS + 300, syncSource: "offline_queue" }),
      ),
      [],
    );
  });

  it("keeps an unknown stored code", () => {
    assert.deepEqual(anomalyReasons(facts({ stored: ["future_flag"] })), ["future_flag"]);
  });
});
