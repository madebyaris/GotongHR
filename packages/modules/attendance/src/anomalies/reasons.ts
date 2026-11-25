import { DRIFT_REVIEW_SECONDS, MAX_PLAUSIBLE_TRAVEL_SPEED_KMH } from "../clock/limits.ts";

const GEOFENCE_REASONS = new Set(["geofence", "missing_geofence", "branch_mismatch"]);

export interface ReasonFacts {
  stored: unknown;
  geofenceOk: boolean;
  clockDriftSeconds: number;
  syncSource: string;
  speedKmh: number | null;
  livenessOk: boolean | null;
  mockLocationFlag: boolean;
}

/**
 * Reasons shown on a punch that is already `needs_review`.
 * Stored engine codes stay first. Flags fill a gap when the JSON is empty.
 * Liveness is the stored boolean. This does not score a face.
 */
export function anomalyReasons(facts: ReasonFacts): string[] {
  const reasons = readStored(facts.stored);
  const seen = new Set(reasons);
  if (!facts.geofenceOk && !reasons.some((reason) => GEOFENCE_REASONS.has(reason))) {
    reasons.push("geofence");
    seen.add("geofence");
  }
  if (
    facts.clockDriftSeconds > DRIFT_REVIEW_SECONDS &&
    facts.syncSource !== "offline_queue" &&
    !seen.has("clock_drift")
  ) {
    reasons.push("clock_drift");
    seen.add("clock_drift");
  }
  if (
    facts.speedKmh !== null &&
    facts.speedKmh > MAX_PLAUSIBLE_TRAVEL_SPEED_KMH &&
    !seen.has("travel_speed")
  ) {
    reasons.push("travel_speed");
    seen.add("travel_speed");
  }
  if (facts.livenessOk === false && !seen.has("liveness")) {
    reasons.push("liveness");
    seen.add("liveness");
  }
  if (facts.mockLocationFlag && !seen.has("mock_location")) {
    reasons.push("mock_location");
  }
  return reasons;
}

function readStored(value: unknown): string[] {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
}
