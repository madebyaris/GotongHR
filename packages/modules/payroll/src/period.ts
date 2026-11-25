const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export interface PayrollPeriod {
  year: number;
  month: number;
  yearMonth: string;
  start: string;
  end: string;
}

export function parsePeriod(value: string): PayrollPeriod | null {
  const match = PERIOD.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1900 || year > 2199) return null;
  const length = MONTH_LENGTHS[month - 1];
  if (length === undefined) return null;
  const leap = month === 2 && (year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0));
  const day = leap ? 29 : length;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return {
    year,
    month,
    yearMonth: `${year}-${mm}`,
    start: `${year}-${mm}-01`,
    end: `${year}-${mm}-${dd}`,
  };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error("batch size must be a positive integer");
  }
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
