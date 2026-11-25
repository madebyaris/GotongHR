import type { FieldIssue } from "./envelope.ts";
import type { ParseObjectResult, ParseResult } from "./org.ts";
import { parseUmpIdr } from "./org.ts";

/**
 * Department, position, contract, and pay parsers. No network.
 * The same checks run in the browser and on the employee routes.
 */

export const contractTypes = ["PKWT", "PKWTT"] as const;

export type ContractType = (typeof contractTypes)[number];

const contractTypeSet: ReadonlySet<string> = new Set(contractTypes);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface DepartmentRecord {
  id: string;
  name: string;
}

export interface PositionRecord {
  id: string;
  departmentId: string | null;
  name: string;
}

export interface PositionCreateInput {
  name: string;
  departmentId: string | null;
}

export interface ContractCreateInput {
  contractType: ContractType;
  startDate: string;
  endDate: string | null;
}

export interface ContractRecord {
  id: string;
  employeeId: string;
  contractType: ContractType;
  startDate: string;
  endDate: string | null;
  compensationPaid: boolean;
}

export interface CompensationCreateInput {
  baseSalaryIdr: bigint;
  effectiveFrom: string;
}

export interface CompensationRecord {
  id: string;
  employeeId: string;
  baseSalaryIdr: string;
  effectiveFrom: string;
}

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

const EXPIRY_WINDOW_DAYS = 90;

export function parseDepartmentCreate(input: unknown): ParseObjectResult<{ name: string }> {
  const body = asRecord(input);
  if (!body) return objectError();
  const name = parseOrgName(body.name, "Enter a department name.");
  if (!name.ok) return { ok: false, fields: [{ field: "name", message: name.message }] };
  return { ok: true, value: { name: name.value } };
}

export function parsePositionCreate(input: unknown): ParseObjectResult<PositionCreateInput> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const name = parseOrgName(body.name, "Enter a position name.");
  if (!name.ok) fields.push({ field: "name", message: name.message });
  const departmentId = parseOptionalUuid(body.departmentId, "Choose a department.");
  if (!departmentId.ok) fields.push({ field: "departmentId", message: departmentId.message });
  if (!name.ok || !departmentId.ok) return { ok: false, fields };
  return { ok: true, value: { name: name.value, departmentId: departmentId.value } };
}

export function parseContractCreate(input: unknown): ParseObjectResult<ContractCreateInput> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const contractType = parseContractType(body.contractType);
  if (!contractType.ok) fields.push({ field: "contractType", message: contractType.message });
  const startDate = parseIsoDate(body.startDate, "Enter the contract start date.", "Enter a real start date.");
  if (!startDate.ok) fields.push({ field: "startDate", message: startDate.message });
  const endDate = parseOptionalDate(body.endDate);
  if (!endDate.ok) fields.push({ field: "endDate", message: endDate.message });
  if (contractType.ok && endDate.ok && startDate.ok) {
    if (contractType.value === "PKWT" && !endDate.value) {
      fields.push({ field: "endDate", message: "Enter the contract end date." });
    }
    if (contractType.value === "PKWTT" && endDate.value) {
      fields.push({ field: "endDate", message: "A PKWTT contract has no end date." });
    }
    if (endDate.value && endDate.value < startDate.value) {
      fields.push({ field: "endDate", message: "The end date is before the start date." });
    }
  }
  if (fields.length > 0 || !contractType.ok || !startDate.ok || !endDate.ok) {
    return { ok: false, fields };
  }
  return {
    ok: true,
    value: {
      contractType: contractType.value,
      startDate: startDate.value,
      endDate: endDate.value,
    },
  };
}

export function parseCompensationCreate(input: unknown): ParseObjectResult<CompensationCreateInput> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const salary = parseUmpIdr(body.baseSalaryIdr);
  if (!salary.ok) fields.push({ field: "baseSalaryIdr", message: "Enter the base salary in whole rupiah." });
  const effectiveFrom = parseIsoDate(
    body.effectiveFrom,
    "Enter the date this pay starts.",
    "Enter a real start date.",
  );
  if (!effectiveFrom.ok) fields.push({ field: "effectiveFrom", message: effectiveFrom.message });
  if (fields.length > 0 || !salary.ok || !effectiveFrom.ok) return { ok: false, fields };
  return { ok: true, value: { baseSalaryIdr: salary.value, effectiveFrom: effectiveFrom.value } };
}

/** Whole days from `today` to `endDate`. Both values are `YYYY-MM-DD`. */
export function daysUntil(today: string, endDate: string): number {
  const start = Date.parse(`${today}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export function formatDirectoryDate(iso: string): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (!isCalendarDay(day, month, year)) return iso;
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** The end date, plus an expiry note inside the 90-day window. */
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

function parseContractType(input: unknown): ParseResult<ContractType> {
  if (typeof input !== "string" || !contractTypeSet.has(input)) {
    return { ok: false, message: "Choose PKWT or PKWTT." };
  }
  return { ok: true, value: input as ContractType };
}

function parseOrgName(input: unknown, message: string): ParseResult<string> {
  if (typeof input !== "string") return { ok: false, message };
  const name = input.trim();
  if (name.length < 1 || name.length > 80 || hasControlCharacter(name)) return { ok: false, message };
  return { ok: true, value: name };
}

function parseIsoDate(input: unknown, missing: string, unreal: string): ParseResult<string> {
  if (typeof input !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(input)) {
    return { ok: false, message: missing };
  }
  const year = Number(input.slice(0, 4));
  const month = Number(input.slice(5, 7));
  const day = Number(input.slice(8, 10));
  if (!isCalendarDay(day, month, year)) return { ok: false, message: unreal };
  return { ok: true, value: input };
}

function parseOptionalDate(input: unknown): ParseResult<string | null> {
  if (input === undefined || input === null || input === "") return { ok: true, value: null };
  return parseIsoDate(input, "Enter the contract end date.", "Enter a real end date.");
}

function parseOptionalUuid(value: unknown, message: string): ParseResult<string | null> {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string" || !UUID.test(value)) return { ok: false, message };
  return { ok: true, value: value.toLowerCase() };
}

function isCalendarDay(day: number, month: number, year: number): boolean {
  if (month < 1 || month > 12 || day < 1 || year < 1900 || year > 9999) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function objectError(): ParseObjectResult<never> {
  return { ok: false, fields: [{ field: "body", message: "Send the fields as an object." }] };
}
