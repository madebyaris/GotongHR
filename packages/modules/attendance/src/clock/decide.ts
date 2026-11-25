import { haversineMeters, type GeoPoint } from "./haversine.ts";
import { DRIFT_REVIEW_SECONDS, MAX_PLAUSIBLE_TRAVEL_SPEED_KMH } from "./limits.ts";
import type { ReviewStatus, SyncSource } from "./types.ts";

const INT4_MAX = 2_147_483_647;

export interface Geofence {
  lat: number;
  lng: number;
  radiusMeters: number;
}

export interface PreviousPunch {
  lat: number;
  lng: number;
  capturedAt: Date;
}

export interface ClockFacts {
  capturedAt: Date;
  receivedAt: Date;
  syncSource: SyncSource;
  point: GeoPoint;
  geofence: Geofence | null;
  previous: PreviousPunch | null;
  mockLocationFlag: boolean;
  livenessOk: boolean | null;
  branchMismatch: boolean;
}

export interface ClockRuling {
  clockDriftSeconds: number;
  distanceMeters: number | null;
  geofenceOk: boolean;
  speedKmh: number | null;
  reviewStatus: Extract<ReviewStatus, "ok" | "needs_review">;
  reviewReasons: string[];
}

/**
 * Scores one punch. A flagged punch is stored. This function does not drop it.
 * Offline drift is recorded and is not a review reason.
 */
export function ruleClockEvent(facts: ClockFacts): ClockRuling {
  const reasons: string[] = [];
  const clockDriftSeconds = driftSeconds(facts.receivedAt, facts.capturedAt);
  if (clockDriftSeconds > DRIFT_REVIEW_SECONDS && facts.syncSource !== "offline_queue") {
    reasons.push("clock_drift");
  }

  let distanceMeters: number | null = null;
  let geofenceOk = false;
  if (!facts.geofence) {
    reasons.push("missing_geofence");
  } else {
    distanceMeters = round2(haversineMeters(facts.point, facts.geofence));
    geofenceOk = distanceMeters <= facts.geofence.radiusMeters;
    if (!geofenceOk) reasons.push("geofence");
  }

  const speedKmh = travelSpeed(facts.previous, facts.point, facts.capturedAt);
  if (speedKmh !== null && speedKmh > MAX_PLAUSIBLE_TRAVEL_SPEED_KMH) {
    reasons.push("travel_speed");
  }
  if (facts.mockLocationFlag) reasons.push("mock_location");
  if (facts.livenessOk === false) reasons.push("liveness");
  if (facts.branchMismatch) reasons.push("branch_mismatch");

  return {
    clockDriftSeconds,
    distanceMeters,
    geofenceOk,
    speedKmh: Number.isFinite(speedKmh) ? speedKmh : null,
    reviewStatus: reasons.length > 0 ? "needs_review" : "ok",
    reviewReasons: reasons,
  };
}

export function driftSeconds(receivedAt: Date, capturedAt: Date): number {
  const raw = Math.round((receivedAt.getTime() - capturedAt.getTime()) / 1000);
  if (!Number.isFinite(raw) || raw > INT4_MAX) return INT4_MAX;
  if (raw < -INT4_MAX) return -INT4_MAX;
  return raw;
}

function travelSpeed(previous: PreviousPunch | null, point: GeoPoint, capturedAt: Date): number | null {
  if (!previous) return null;
  const meters = haversineMeters(previous, point);
  const seconds = (capturedAt.getTime() - previous.capturedAt.getTime()) / 1000;
  if (seconds <= 0) return meters > 1 ? Number.POSITIVE_INFINITY : 0;
  return round2(meters / 1000 / (seconds / 3600));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
