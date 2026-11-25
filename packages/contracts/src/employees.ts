import type { FieldIssue } from "./envelope.ts";
import type { ParseObjectResult, ParseResult } from "./org.ts";
import { ptkpStatuses, type Pph21SubjectType, type PtkpStatus, type TaxMethod } from "./core-hr-payroll.port.ts";

/**
 * NIK, NPWP, and employee body checks. No network. The same parsers run in
 * the browser and in `POST /api/v1/employees` before any row is written.
 */

export const employmentStatuses = ["active", "probation", "resigned", "terminated"] as const;

export type EmploymentStatus = (typeof employmentStatuses)[number];

export const employeePiiFields = [
  "nik",
  "npwp",
  "kk_number",
  "bpjs_kesehatan_no",
  "bpjs_tk_no",
  "bank_account_number",
] as const;

export type EmployeePiiField = (typeof employeePiiFields)[number];

const employmentStatusSet: ReadonlySet<string> = new Set(employmentStatuses);
const ptkpSet: ReadonlySet<string> = new Set(ptkpStatuses);
const taxMethods = ["gross", "nett", "gross_up"] as const;
const taxMethodSet: ReadonlySet<string> = new Set(taxMethods);
const subjectTypes = ["permanent", "non_permanent", "expat"] as const;
const subjectSet: ReadonlySet<string> = new Set(subjectTypes);
const piiFieldSet: ReadonlySet<string> = new Set(employeePiiFields);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

export function isEmployeePiiField(value: string): value is EmployeePiiField {
  return piiFieldSet.has(value);
}

export interface EmployeeCreateInput {
  employeeCode: string;
  fullName: string;
  legalEntityId: string;
  branchId: string;
  departmentId: string | null;
  positionId: string | null;
  employmentStatus: EmploymentStatus;
  joinDate: string;
  ptkpStatus: PtkpStatus;
  taxMethod: TaxMethod;
  pph21SubjectType: Pph21SubjectType;
  nik: string;
  npwp: string | null;
  kkNumber: string | null;
  bpjsKesehatanNo: string | null;
  bpjsTkNo: string | null;
  bankAccountNumber: string | null;
}

export interface EmployeePatch {
  employeeCode?: string;
  fullName?: string;
  legalEntityId?: string;
  branchId?: string;
  departmentId?: string | null;
  positionId?: string | null;
  employmentStatus?: EmploymentStatus;
  joinDate?: string;
  ptkpStatus?: PtkpStatus;
  taxMethod?: TaxMethod;
  pph21SubjectType?: Pph21SubjectType;
  nik?: string;
  npwp?: string | null;
  kkNumber?: string | null;
  bpjsKesehatanNo?: string | null;
  bpjsTkNo?: string | null;
  bankAccountNumber?: string | null;
}

export interface EmployeeRecord {
  id: string;
  employeeCode: string;
  fullName: string;
  legalEntityId: string;
  branchId: string;
  departmentId: string | null;
  positionId: string | null;
  employmentStatus: EmploymentStatus;
  joinDate: string;
  ptkpStatus: PtkpStatus;
  taxMethod: TaxMethod;
  pph21SubjectType: Pph21SubjectType;
  nikMask: string;
  npwpMask: string | null;
  kkNumberMask: string | null;
  bpjsKesehatanNoMask: string | null;
  bpjsTkNoMask: string | null;
  bankAccountNumberMask: string | null;
}

export interface PiiRevealInput {
  reason: string;
  fields: EmployeePiiField[];
}

/** 16 ASCII digits, a non-zero region shape, and a real birth date. Digits 7-8 may be day+40. */
export function parseEmployeeNik(input: unknown): ParseResult<string> {
  if (typeof input !== "string") return { ok: false, message: "NIK must be 16 digits." };
  const nik = input.trim();
  if (!/^[0-9]{16}$/u.test(nik)) return { ok: false, message: "NIK must be 16 digits." };
  const province = Number(nik.slice(0, 2));
  const regency = Number(nik.slice(2, 4));
  const district = Number(nik.slice(4, 6));
  if (province === 0 || regency === 0 || district === 0) {
    return { ok: false, message: "NIK region code is not valid." };
  }
  const dayCode = Number(nik.slice(6, 8));
  const month = Number(nik.slice(8, 10));
  const year = Number(nik.slice(10, 12));
  const female = dayCode >= 41 && dayCode <= 71;
  const male = dayCode >= 1 && dayCode <= 31;
  if (!female && !male) return { ok: false, message: "NIK birth date is not a real date." };
  const day = female ? dayCode - 40 : dayCode;
  if (!isCalendarDay(day, month, 1900 + year) && !isCalendarDay(day, month, 2000 + year)) {
    return { ok: false, message: "NIK birth date is not a real date." };
  }
  return { ok: true, value: nik };
}

/** Absent or blank is allowed. A value must be 15 or 16 ASCII digits. */
export function parseEmployeeNpwp(input: unknown): ParseResult<string | null> {
  if (isBlank(input)) return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false, message: "NPWP must be 15 or 16 digits." };
  const npwp = input.trim();
  if (!/^[0-9]{15}$/u.test(npwp) && !/^[0-9]{16}$/u.test(npwp)) {
    return { ok: false, message: "NPWP must be 15 or 16 digits." };
  }
  return { ok: true, value: npwp };
}

export function parseEmployeeCreate(input: unknown): ParseObjectResult<EmployeeCreateInput> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const employeeCode = parseCode(body.employeeCode);
  if (!employeeCode.ok) fields.push({ field: "employeeCode", message: employeeCode.message });
  const fullName = parseName(body.fullName);
  if (!fullName.ok) fields.push({ field: "fullName", message: fullName.message });
  const legalEntityId = parseUuid(body.legalEntityId, "Choose a legal entity.");
  if (!legalEntityId.ok) fields.push({ field: "legalEntityId", message: legalEntityId.message });
  const branchId = parseUuid(body.branchId, "Choose a branch.");
  if (!branchId.ok) fields.push({ field: "branchId", message: branchId.message });
  const departmentId = parseOptionalUuid(body.departmentId, "Enter a valid department.");
  if (!departmentId.ok) fields.push({ field: "departmentId", message: departmentId.message });
  const positionId = parseOptionalUuid(body.positionId, "Enter a valid position.");
  if (!positionId.ok) fields.push({ field: "positionId", message: positionId.message });
  const employmentStatus = parseStatus(body.employmentStatus);
  if (!employmentStatus.ok) fields.push({ field: "employmentStatus", message: employmentStatus.message });
  const joinDate = parseJoinDate(body.joinDate);
  if (!joinDate.ok) fields.push({ field: "joinDate", message: joinDate.message });
  const ptkpStatus = parsePtkp(body.ptkpStatus);
  if (!ptkpStatus.ok) fields.push({ field: "ptkpStatus", message: ptkpStatus.message });
  const taxMethod = parseTaxMethod(body.taxMethod);
  if (!taxMethod.ok) fields.push({ field: "taxMethod", message: taxMethod.message });
  const pph21SubjectType = parseSubject(body.pph21SubjectType);
  if (!pph21SubjectType.ok) fields.push({ field: "pph21SubjectType", message: pph21SubjectType.message });
  const nik = parseEmployeeNik(body.nik);
  if (!nik.ok) fields.push({ field: "nik", message: nik.message });
  const npwp = parseEmployeeNpwp(body.npwp);
  if (!npwp.ok) fields.push({ field: "npwp", message: npwp.message });
  const kkNumber = parseOptionalDigits(body.kkNumber, 16, 16, "KK number must be 16 digits.");
  if (!kkNumber.ok) fields.push({ field: "kkNumber", message: kkNumber.message });
  const bpjsKesehatanNo = parseOptionalDigits(
    body.bpjsKesehatanNo,
    13,
    13,
    "BPJS Kesehatan number must be 13 digits.",
  );
  if (!bpjsKesehatanNo.ok) fields.push({ field: "bpjsKesehatanNo", message: bpjsKesehatanNo.message });
  const bpjsTkNo = parseOptionalDigits(body.bpjsTkNo, 11, 11, "BPJS TK number must be 11 digits.");
  if (!bpjsTkNo.ok) fields.push({ field: "bpjsTkNo", message: bpjsTkNo.message });
  const bankAccountNumber = parseOptionalDigits(
    body.bankAccountNumber,
    8,
    20,
    "Bank account must be 8 to 20 digits.",
  );
  if (!bankAccountNumber.ok) fields.push({ field: "bankAccountNumber", message: bankAccountNumber.message });
  if (
    fields.length > 0 ||
    !employeeCode.ok ||
    !fullName.ok ||
    !legalEntityId.ok ||
    !branchId.ok ||
    !departmentId.ok ||
    !positionId.ok ||
    !employmentStatus.ok ||
    !joinDate.ok ||
    !ptkpStatus.ok ||
    !taxMethod.ok ||
    !pph21SubjectType.ok ||
    !nik.ok ||
    !npwp.ok ||
    !kkNumber.ok ||
    !bpjsKesehatanNo.ok ||
    !bpjsTkNo.ok ||
    !bankAccountNumber.ok
  ) {
    return { ok: false, fields };
  }
  return {
    ok: true,
    value: {
      employeeCode: employeeCode.value,
      fullName: fullName.value,
      legalEntityId: legalEntityId.value,
      branchId: branchId.value,
      departmentId: departmentId.value,
      positionId: positionId.value,
      employmentStatus: employmentStatus.value,
      joinDate: joinDate.value,
      ptkpStatus: ptkpStatus.value,
      taxMethod: taxMethod.value,
      pph21SubjectType: pph21SubjectType.value,
      nik: nik.value,
      npwp: npwp.value,
      kkNumber: kkNumber.value,
      bpjsKesehatanNo: bpjsKesehatanNo.value,
      bpjsTkNo: bpjsTkNo.value,
      bankAccountNumber: bankAccountNumber.value,
    },
  };
}

export function parseEmployeePatch(input: unknown): ParseObjectResult<EmployeePatch> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const value: EmployeePatch = {};
  let changed = false;
  if (hasOwn(body, "employeeCode")) {
    changed = true;
    const employeeCode = parseCode(body.employeeCode);
    if (!employeeCode.ok) fields.push({ field: "employeeCode", message: employeeCode.message });
    else value.employeeCode = employeeCode.value;
  }
  if (hasOwn(body, "fullName")) {
    changed = true;
    const fullName = parseName(body.fullName);
    if (!fullName.ok) fields.push({ field: "fullName", message: fullName.message });
    else value.fullName = fullName.value;
  }
  if (hasOwn(body, "legalEntityId")) {
    changed = true;
    const legalEntityId = parseUuid(body.legalEntityId, "Choose a legal entity.");
    if (!legalEntityId.ok) fields.push({ field: "legalEntityId", message: legalEntityId.message });
    else value.legalEntityId = legalEntityId.value;
  }
  if (hasOwn(body, "branchId")) {
    changed = true;
    const branchId = parseUuid(body.branchId, "Choose a branch.");
    if (!branchId.ok) fields.push({ field: "branchId", message: branchId.message });
    else value.branchId = branchId.value;
  }
  if (hasOwn(body, "departmentId")) {
    changed = true;
    const departmentId = parseOptionalUuid(body.departmentId, "Enter a valid department.");
    if (!departmentId.ok) fields.push({ field: "departmentId", message: departmentId.message });
    else value.departmentId = departmentId.value;
  }
  if (hasOwn(body, "positionId")) {
    changed = true;
    const positionId = parseOptionalUuid(body.positionId, "Enter a valid position.");
    if (!positionId.ok) fields.push({ field: "positionId", message: positionId.message });
    else value.positionId = positionId.value;
  }
  if (hasOwn(body, "employmentStatus")) {
    changed = true;
    const employmentStatus = parseStatus(body.employmentStatus);
    if (!employmentStatus.ok) fields.push({ field: "employmentStatus", message: employmentStatus.message });
    else value.employmentStatus = employmentStatus.value;
  }
  if (hasOwn(body, "joinDate")) {
    changed = true;
    const joinDate = parseJoinDate(body.joinDate);
    if (!joinDate.ok) fields.push({ field: "joinDate", message: joinDate.message });
    else value.joinDate = joinDate.value;
  }
  if (hasOwn(body, "ptkpStatus")) {
    changed = true;
    const ptkpStatus = parsePtkp(body.ptkpStatus);
    if (!ptkpStatus.ok) fields.push({ field: "ptkpStatus", message: ptkpStatus.message });
    else value.ptkpStatus = ptkpStatus.value;
  }
  if (hasOwn(body, "taxMethod")) {
    changed = true;
    const taxMethod = parseTaxMethod(body.taxMethod);
    if (!taxMethod.ok) fields.push({ field: "taxMethod", message: taxMethod.message });
    else value.taxMethod = taxMethod.value;
  }
  if (hasOwn(body, "pph21SubjectType")) {
    changed = true;
    const pph21SubjectType = parseSubject(body.pph21SubjectType);
    if (!pph21SubjectType.ok) fields.push({ field: "pph21SubjectType", message: pph21SubjectType.message });
    else value.pph21SubjectType = pph21SubjectType.value;
  }
  if (hasOwn(body, "nik")) {
    changed = true;
    const nik = parseEmployeeNik(body.nik);
    if (!nik.ok) fields.push({ field: "nik", message: nik.message });
    else value.nik = nik.value;
  }
  if (hasOwn(body, "npwp")) {
    changed = true;
    const npwp = parseEmployeeNpwp(body.npwp);
    if (!npwp.ok) fields.push({ field: "npwp", message: npwp.message });
    else value.npwp = npwp.value;
  }
  if (hasOwn(body, "kkNumber")) {
    changed = true;
    const kkNumber = parseOptionalDigits(body.kkNumber, 16, 16, "KK number must be 16 digits.");
    if (!kkNumber.ok) fields.push({ field: "kkNumber", message: kkNumber.message });
    else value.kkNumber = kkNumber.value;
  }
  if (hasOwn(body, "bpjsKesehatanNo")) {
    changed = true;
    const bpjsKesehatanNo = parseOptionalDigits(
      body.bpjsKesehatanNo,
      13,
      13,
      "BPJS Kesehatan number must be 13 digits.",
    );
    if (!bpjsKesehatanNo.ok) fields.push({ field: "bpjsKesehatanNo", message: bpjsKesehatanNo.message });
    else value.bpjsKesehatanNo = bpjsKesehatanNo.value;
  }
  if (hasOwn(body, "bpjsTkNo")) {
    changed = true;
    const bpjsTkNo = parseOptionalDigits(body.bpjsTkNo, 11, 11, "BPJS TK number must be 11 digits.");
    if (!bpjsTkNo.ok) fields.push({ field: "bpjsTkNo", message: bpjsTkNo.message });
    else value.bpjsTkNo = bpjsTkNo.value;
  }
  if (hasOwn(body, "bankAccountNumber")) {
    changed = true;
    const bankAccountNumber = parseOptionalDigits(
      body.bankAccountNumber,
      8,
      20,
      "Bank account must be 8 to 20 digits.",
    );
    if (!bankAccountNumber.ok) fields.push({ field: "bankAccountNumber", message: bankAccountNumber.message });
    else value.bankAccountNumber = bankAccountNumber.value;
  }
  if (fields.length > 0) return { ok: false, fields };
  if (!changed) return { ok: false, fields: [{ field: "body", message: "No changes to save." }] };
  return { ok: true, value };
}

export function parsePiiReveal(input: unknown): ParseObjectResult<PiiRevealInput> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const reason = parseReason(body.reason);
  if (!reason.ok) fields.push({ field: "reason", message: reason.message });
  const requested = parseRevealFields(body.fields);
  if (!requested.ok) fields.push({ field: "fields", message: requested.message });
  if (!reason.ok || !requested.ok) return { ok: false, fields };
  return { ok: true, value: { reason: reason.value, fields: requested.value } };
}

function parseRevealFields(input: unknown): ParseResult<EmployeePiiField[]> {
  if (input === undefined) return { ok: true, value: ["nik"] };
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, message: "Choose a field to reveal." };
  }
  const fields: EmployeePiiField[] = [];
  for (const item of input) {
    if (typeof item !== "string" || !isEmployeePiiField(item)) {
      return { ok: false, message: "Choose a field to reveal." };
    }
    if (!fields.includes(item)) fields.push(item);
  }
  return { ok: true, value: fields };
}

function parseReason(input: unknown): ParseResult<string> {
  if (typeof input !== "string") return { ok: false, message: "Enter a reason." };
  const reason = input.trim();
  if (reason.length === 0) return { ok: false, message: "Enter a reason." };
  if (reason.length > 500) return { ok: false, message: "Use 500 characters or fewer." };
  return { ok: true, value: reason };
}

function isCalendarDay(day: number, month: number, year: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseCode(input: unknown): ParseResult<string> {
  if (typeof input !== "string") return { ok: false, message: "Enter an employee code." };
  const code = input.trim();
  if (code.length < 1 || code.length > 32 || !CODE.test(code)) {
    return { ok: false, message: "Use letters, digits, and . _ / - (32 characters or fewer)." };
  }
  return { ok: true, value: code };
}

function parseName(input: unknown): ParseResult<string> {
  if (typeof input !== "string") return { ok: false, message: "Enter the full name." };
  const name = input.trim();
  if (name.length < 1 || name.length > 160 || hasControlCharacter(name)) {
    return { ok: false, message: "Enter the full name." };
  }
  return { ok: true, value: name };
}

function parseStatus(input: unknown): ParseResult<EmploymentStatus> {
  if (typeof input !== "string" || !employmentStatusSet.has(input)) {
    return { ok: false, message: "Choose a status." };
  }
  return { ok: true, value: input as EmploymentStatus };
}

function parseJoinDate(input: unknown): ParseResult<string> {
  if (typeof input !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(input)) {
    return { ok: false, message: "Enter a join date." };
  }
  const year = Number(input.slice(0, 4));
  const month = Number(input.slice(5, 7));
  const day = Number(input.slice(8, 10));
  if (!isCalendarDay(day, month, year)) return { ok: false, message: "Enter a real join date." };
  return { ok: true, value: input };
}

function parsePtkp(input: unknown): ParseResult<PtkpStatus> {
  if (typeof input !== "string" || !ptkpSet.has(input)) {
    return { ok: false, message: "Choose a PTKP status." };
  }
  return { ok: true, value: input as PtkpStatus };
}

function parseTaxMethod(input: unknown): ParseResult<TaxMethod> {
  if (typeof input !== "string" || !taxMethodSet.has(input)) {
    return { ok: false, message: "Choose a tax method." };
  }
  return { ok: true, value: input as TaxMethod };
}

function parseSubject(input: unknown): ParseResult<Pph21SubjectType> {
  if (typeof input !== "string" || !subjectSet.has(input)) {
    return { ok: false, message: "Choose a PPh 21 subject." };
  }
  return { ok: true, value: input as Pph21SubjectType };
}

function parseUuid(value: unknown, message: string): ParseResult<string> {
  if (typeof value !== "string" || !UUID.test(value)) return { ok: false, message };
  return { ok: true, value: value.toLowerCase() };
}

function parseOptionalUuid(value: unknown, message: string): ParseResult<string | null> {
  if (isBlank(value)) return { ok: true, value: null };
  const parsed = parseUuid(value, message);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value };
}

function parseOptionalDigits(
  value: unknown,
  min: number,
  max: number,
  message: string,
): ParseResult<string | null> {
  if (isBlank(value)) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, message };
  const digits = value.trim();
  if (!/^[0-9]+$/u.test(digits) || digits.length < min || digits.length > max) {
    return { ok: false, message };
  }
  return { ok: true, value: digits };
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(body, key);
}

function objectError(): ParseObjectResult<never> {
  return { ok: false, fields: [{ field: "body", message: "Send a JSON object." }] };
}
