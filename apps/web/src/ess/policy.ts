/** Cache windows for the ESS document. Shifts and leave types move slowly. */
export const STALE_MS = {
  profile: 15 * 60 * 1000,
  shifts: 15 * 60 * 1000,
  leaveTypes: 15 * 60 * 1000,
  balances: 5 * 60 * 1000,
  today: 30 * 1000,
} as const;

/** Waits after a failed sync attempt. The last wait is the end of the cycle. */
export const SYNC_BACKOFF_MS = [2_000, 5_000, 15_000, 60_000] as const;

export const SELFIE_MAX_BYTES = 40 * 1024;
export const SELFIE_MAX_EDGE = 480;
export const OUTBOX_DB = "gotonghr-ess";
export const OUTBOX_STORE = "outbox_clock_events";
export const OWNER_STORE = "sync_control";
export const BOOTSTRAP_STORE = "bootstrap_cache";
export const OUTBOX_LOCK = "gotonghr-outbox";
export const OWNER_ID = "owner";
export const OWNER_BEAT_MS = 2_000;
export const OWNER_FRESH_MS = 8_000;

export function backoffDelay(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), SYNC_BACKOFF_MS.length - 1);
  return SYNC_BACKOFF_MS[index] ?? 60_000;
}

export function nextPunch(last: "clock_in" | "clock_out" | null): "clock_in" | "clock_out" {
  return last === "clock_in" ? "clock_out" : "clock_in";
}

/** Timestamp-ordered id. The version nibble is 7 and the variant is RFC 4122. */
export function uuidv7(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const time = BigInt(now);
  bytes[0] = Number((time >> 40n) & 0xffn);
  bytes[1] = Number((time >> 32n) & 0xffn);
  bytes[2] = Number((time >> 24n) & 0xffn);
  bytes[3] = Number((time >> 16n) & 0xffn);
  bytes[4] = Number((time >> 8n) & 0xffn);
  bytes[5] = Number(time & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
