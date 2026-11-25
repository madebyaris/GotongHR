/** Calendar dates for the bootstrap window. The branch timezone picks "today". */

export function localIsoDate(now: Date, timeZone: string): string {
  let zone = timeZone;
  try {
    Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(now);
  } catch {
    zone = "Asia/Jakarta";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Could not read the local date.");
  return `${year}-${month}-${day}`;
}

export function addIsoDays(isoDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(isoDate);
  if (!match?.[1] || !match[2] || !match[3]) throw new Error("Expected an ISO date.");
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return utc.toISOString().slice(0, 10);
}

export function hhmm(value: string): string {
  const match = /^(\d{2}):(\d{2})/u.exec(value.trim());
  if (!match?.[1] || !match[2]) return value.trim();
  return `${match[1]}:${match[2]}`;
}
