import { PayrollInputError } from "./errors.ts";

export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function digits(source: string): number {
  let value = 0;
  for (const char of source) {
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) return -1;
    value = value * 10 + (code - 48);
  }
  return value;
}

export function isLeapYear(year: number): boolean {
  if (year % 400 === 0) return true;
  if (year % 100 === 0) return false;
  return year % 4 === 0;
}

export function isValidCivilDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1900 || year > 2199) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  const length = MONTH_LENGTHS[month - 1];
  if (length === undefined) return false;
  const days = month === 2 && isLeapYear(year) ? 29 : length;
  return day <= days;
}

export function civilDate(year: number, month: number, day: number): CivilDate {
  if (!isValidCivilDate(year, month, day)) {
    throw new PayrollInputError("Payroll date must be a real calendar date.");
  }
  return { year, month, day };
}

export function civilDateToIso(date: CivilDate): string {
  const checked = civilDate(date.year, date.month, date.day);
  const year = String(checked.year).padStart(4, "0");
  const month = String(checked.month).padStart(2, "0");
  const day = String(checked.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return isValidCivilDate(digits(value.slice(0, 4)), digits(value.slice(5, 7)), digits(value.slice(8, 10)));
}

export function civilDateFromIso(value: string): CivilDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PayrollInputError("Payroll date must be YYYY-MM-DD.");
  }
  return civilDate(digits(value.slice(0, 4)), digits(value.slice(5, 7)), digits(value.slice(8, 10)));
}
