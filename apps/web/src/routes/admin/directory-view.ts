import type { ContractType } from "@gotonghr/contracts";

/** Client-side directory filters. The employee list already carries the summary columns. */

const EXPIRY_WINDOW_DAYS = 90;

export interface DirectoryRow {
  id: string;
  fullName: string;
  employeeCode: string;
  employmentStatus: string;
  departmentId: string | null;
  contractType: ContractType | null;
  contractEndDate: string | null;
}

export interface DirectoryFilters {
  query: string;
  status: string;
  departmentId: string;
  contract: "" | "ending" | ContractType;
}

export function daysUntil(today: string, endDate: string): number {
  const start = Date.parse(`${today}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export function formatDirectoryDate(iso: string): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return iso;
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function contractEndLabel(endDate: string | null, today: string): string {
  if (!endDate) return "No end date";
  const formatted = formatDirectoryDate(endDate);
  const days = daysUntil(today, endDate);
  if (days < 0) return `Ended ${formatted}`;
  if (days === 0) return `Ends today, ${formatted}`;
  if (days <= EXPIRY_WINDOW_DAYS) {
    const unit = days === 1 ? "day" : "days";
    return `${formatted}, ends in ${days} ${unit}`;
  }
  return formatted;
}

export function filterDirectoryRows<T extends DirectoryRow>(
  rows: readonly T[],
  filters: DirectoryFilters,
  today: string,
): T[] {
  const query = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (query.length > 0) {
      const haystack = `${row.fullName} ${row.employeeCode}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (filters.status.length > 0 && row.employmentStatus !== filters.status) return false;
    if (filters.departmentId.length > 0 && row.departmentId !== filters.departmentId) return false;
    if (filters.contract === "PKWT" || filters.contract === "PKWTT") {
      if (row.contractType !== filters.contract) return false;
    }
    if (filters.contract === "ending") {
      if (!row.contractEndDate) return false;
      const days = daysUntil(today, row.contractEndDate);
      if (days < 0 || days > EXPIRY_WINDOW_DAYS) return false;
    }
    return true;
  });
}
