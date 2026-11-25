import { isRealIsoDate } from "@gotonghr/contracts";

export const EXPIRY_WINDOWS = [90, 60, 30] as const;

export type ExpiryWindow = (typeof EXPIRY_WINDOWS)[number];

const windowSet: ReadonlySet<number> = new Set(EXPIRY_WINDOWS);

export function isExpiryWindow(value: number): value is ExpiryWindow {
  return windowSet.has(value);
}

/** Calendar day in Asia/Jakarta. The expiry job uses this, not the server zone. */
export function jakartaDate(now: Date): string {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  if (!isRealIsoDate(formatted)) throw new Error("Jakarta date was not YYYY-MM-DD.");
  return formatted;
}

export function addIsoDays(isoDate: string, days: number): string {
  if (!isRealIsoDate(isoDate) || !Number.isInteger(days)) {
    throw new Error("date math needs a real date");
  }
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return utc.toISOString().slice(0, 10);
}

export function contractExpiryDedupeKey(contractId: string, windowDays: number, noticeOn: string): string {
  return `contract:${contractId}:window:${windowDays}:on:${noticeOn}`;
}
