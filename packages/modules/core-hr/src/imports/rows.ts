import { parseEmployeeCreate, type EmployeeCreateInput, type FieldIssue } from "@gotonghr/contracts";

const REQUIRED_COLUMNS = [
  "employee_code",
  "full_name",
  "nik",
  "employment_status",
  "join_date",
  "ptkp_status",
  "tax_method",
  "pph21_subject_type",
] as const;

const OPTIONAL_COLUMNS = [
  "npwp",
  "kk_number",
  "bpjs_kesehatan_no",
  "bpjs_tk_no",
  "bank_account_number",
  "department_id",
  "position_id",
] as const;

const ALLOWED: ReadonlySet<string> = new Set([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);

export function readHeader(
  fields: string[],
): { ok: true; columns: Map<string, number> } | { ok: false; message: string } {
  const columns = new Map<string, number>();
  for (const [index, field] of fields.entries()) {
    const name = field.replace(/^\uFEFF/u, "").trim();
    if (!ALLOWED.has(name)) {
      return { ok: false, message: `Unknown column ${clip(name)}.` };
    }
    if (columns.has(name)) return { ok: false, message: `Column ${name} is repeated.` };
    columns.set(name, index);
  }
  for (const name of REQUIRED_COLUMNS) {
    if (!columns.has(name)) return { ok: false, message: `Missing column ${name}.` };
  }
  return { ok: true, columns };
}

export function mapImportRow(
  fields: string[],
  columns: Map<string, number>,
  placement: { legalEntityId: string; branchId: string },
): { ok: true; value: EmployeeCreateInput } | { ok: false; fields: FieldIssue[] } {
  if (fields.length !== columns.size) {
    return { ok: false, fields: [{ field: "body", message: "This row has the wrong number of columns." }] };
  }
  return parseEmployeeCreate({
    employeeCode: cell(fields, columns, "employee_code"),
    fullName: cell(fields, columns, "full_name"),
    legalEntityId: placement.legalEntityId,
    branchId: placement.branchId,
    departmentId: optional(fields, columns, "department_id"),
    positionId: optional(fields, columns, "position_id"),
    employmentStatus: cell(fields, columns, "employment_status"),
    joinDate: cell(fields, columns, "join_date"),
    ptkpStatus: cell(fields, columns, "ptkp_status"),
    taxMethod: cell(fields, columns, "tax_method"),
    pph21SubjectType: cell(fields, columns, "pph21_subject_type"),
    nik: cell(fields, columns, "nik"),
    npwp: optional(fields, columns, "npwp"),
    kkNumber: optional(fields, columns, "kk_number"),
    bpjsKesehatanNo: optional(fields, columns, "bpjs_kesehatan_no"),
    bpjsTkNo: optional(fields, columns, "bpjs_tk_no"),
    bankAccountNumber: optional(fields, columns, "bank_account_number"),
  });
}

export function blankRecord(fields: string[]): boolean {
  return fields.every((field) => field.trim() === "");
}

function cell(fields: string[], columns: Map<string, number>, name: string): string {
  const index = columns.get(name);
  if (index === undefined) return "";
  return fields[index]?.trim() ?? "";
}

function optional(fields: string[], columns: Map<string, number>, name: string): string | null {
  if (!columns.has(name)) return null;
  const value = cell(fields, columns, name);
  return value.length === 0 ? null : value;
}

function clip(value: string): string {
  const clean = value.replace(/[^\w.-]/gu, "");
  if (clean.length === 0) return "column";
  return clean.length > 40 ? clean.slice(0, 40) : clean;
}
