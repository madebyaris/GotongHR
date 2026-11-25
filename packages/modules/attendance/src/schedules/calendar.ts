import { readFileSync } from "node:fs";

export const workweekTypes = ["5_day", "6_day"] as const;
export type WorkweekType = (typeof workweekTypes)[number];

export const dayTypes = ["workday", "weekend", "national_holiday"] as const;
export type DayType = (typeof dayTypes)[number];

export const approvalRoles = ["line_manager", "branch_manager", "hr_admin"] as const;
export type ApprovalRole = (typeof approvalRoles)[number];

export interface LeaveTypeSeed {
  code: string;
  name: string;
  tenureMonths: number | null;
  entitlementDays: number | null;
  deductsAnnual: boolean;
  deductionToggle: boolean;
}

/**
 * Statutory leave names. Cuti Tahunan is 12 days after 12 months.
 * Cuti Bersama deducts from that balance unless the tenant turns the toggle off.
 */
export const defaultLeaveTypes: readonly LeaveTypeSeed[] = [
  {
    code: "cuti_tahunan",
    name: "Cuti Tahunan",
    tenureMonths: 12,
    entitlementDays: 12,
    deductsAnnual: false,
    deductionToggle: false,
  },
  {
    code: "cuti_bersama",
    name: "Cuti Bersama",
    tenureMonths: null,
    entitlementDays: null,
    deductsAnnual: true,
    deductionToggle: true,
  },
  {
    code: "melahirkan",
    name: "Melahirkan",
    tenureMonths: null,
    entitlementDays: null,
    deductsAnnual: false,
    deductionToggle: false,
  },
  {
    code: "haid",
    name: "Haid",
    tenureMonths: null,
    entitlementDays: null,
    deductsAnnual: false,
    deductionToggle: false,
  },
  {
    code: "sakit",
    name: "Sakit",
    tenureMonths: null,
    entitlementDays: null,
    deductsAnnual: false,
    deductionToggle: false,
  },
  {
    code: "menikah",
    name: "Menikah",
    tenureMonths: null,
    entitlementDays: null,
    deductsAnnual: false,
    deductionToggle: false,
  },
  {
    code: "duka",
    name: "Duka",
    tenureMonths: null,
    entitlementDays: null,
    deductsAnnual: false,
    deductionToggle: false,
  },
  {
    code: "haji",
    name: "Haji",
    tenureMonths: null,
    entitlementDays: null,
    deductsAnnual: false,
    deductionToggle: false,
  },
  {
    code: "umrah",
    name: "Umrah",
    tenureMonths: null,
    entitlementDays: null,
    deductsAnnual: false,
    deductionToggle: false,
  },
];

export interface HolidayEntry {
  date: string;
  name: string;
  kind: "national" | "joint";
}

export interface HolidayDraftFile {
  status: "draft" | "official";
  calendar: "skb_3_menteri";
  year: number;
  note: string;
  holidays: HolidayEntry[];
}

const ISO_DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function weekdayUtc(isoDate: string): number {
  const match = ISO_DATE.exec(isoDate);
  if (!match?.[1] || !match[2] || !match[3]) throw new Error("work date is not a calendar date");
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
}

/**
 * A date in `att_holidays` is a national holiday, including joint-leave days from the SKB file.
 * A 5-day week rests on Saturday and Sunday. A 6-day week rests on Sunday.
 */
export function deriveDayType(
  workDate: string,
  workweek: WorkweekType,
  holidayDates: ReadonlySet<string>,
): DayType {
  if (holidayDates.has(workDate)) return "national_holiday";
  const day = weekdayUtc(workDate);
  if (workweek === "5_day" && (day === 0 || day === 6)) return "weekend";
  if (workweek === "6_day" && day === 0) return "weekend";
  return "workday";
}

export function isWorkweekType(value: string): value is WorkweekType {
  return value === "5_day" || value === "6_day";
}

export function isApprovalRole(value: string): value is ApprovalRole {
  return value === "line_manager" || value === "branch_manager" || value === "hr_admin";
}

export function inclusiveDays(start: string, end: string): number | null {
  if (!isIsoDate(start) || !isIsoDate(end)) return null;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (endMs < startMs) return null;
  const days = Math.round((endMs - startMs) / 86_400_000) + 1;
  if (days < 1 || days > 366) return null;
  return days;
}

export function completedMonths(joinedOn: string, asOf: string): number | null {
  if (!isIsoDate(joinedOn) || !isIsoDate(asOf)) return null;
  const start = dateParts(joinedOn);
  const end = dateParts(asOf);
  let months = (end.year - start.year) * 12 + (end.month - start.month);
  if (end.day < start.day) months -= 1;
  if (months < 0) return null;
  return months;
}

export function annualEntitlement(joinedOn: string, asOf: string): number | null {
  const months = completedMonths(joinedOn, asOf);
  if (months === null) return null;
  return months >= 12 ? 12 : 0;
}

export function monthBounds(yearMonth: string): { start: string; end: string } | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/u.exec(yearMonth);
  if (!match?.[1] || !match[2]) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${match[1]}-${match[2]}-01`,
    end: `${match[1]}-${match[2]}-${String(last).padStart(2, "0")}`,
  };
}

export function readHolidayFile(): HolidayDraftFile {
  const raw = readFileSync(new URL("./holidays-2026.draft.json", import.meta.url), "utf8");
  return parseHolidayFile(JSON.parse(raw) as unknown);
}

export function parseHolidayFile(value: unknown): HolidayDraftFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("holiday file is not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.status !== "draft" && record.status !== "official") {
    throw new Error("holiday file status must be draft or official");
  }
  if (record.calendar !== "skb_3_menteri") throw new Error("holiday file calendar is not skb_3_menteri");
  if (typeof record.year !== "number" || !Number.isInteger(record.year)) {
    throw new Error("holiday file year is missing");
  }
  if (typeof record.note !== "string" || record.note.trim().length === 0) {
    throw new Error("holiday file note is missing");
  }
  if (!Array.isArray(record.holidays) || record.holidays.length === 0) {
    throw new Error("holiday file has no dates");
  }
  const holidays: HolidayEntry[] = [];
  const seen = new Set<string>();
  for (const entry of record.holidays) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("holiday file has a row that is not an object");
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.date !== "string" || !isIsoDate(row.date) || !row.date.startsWith(`${record.year}-`)) {
      throw new Error("holiday file has a date outside its year");
    }
    if (typeof row.name !== "string" || row.name.trim().length === 0 || row.name.trim().length > 120) {
      throw new Error("holiday file has a name that is empty or too long");
    }
    if (row.kind !== "national" && row.kind !== "joint") {
      throw new Error("holiday file kind must be national or joint");
    }
    if (seen.has(row.date)) throw new Error(`holiday file repeats ${row.date}`);
    seen.add(row.date);
    holidays.push({ date: row.date, name: row.name.trim(), kind: row.kind });
  }
  return {
    status: record.status,
    calendar: "skb_3_menteri",
    year: record.year,
    note: record.note.trim(),
    holidays,
  };
}

function dateParts(isoDate: string): { year: number; month: number; day: number } {
  const match = ISO_DATE.exec(isoDate);
  if (!match?.[1] || !match[2] || !match[3]) throw new Error("date is not a calendar date");
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}
