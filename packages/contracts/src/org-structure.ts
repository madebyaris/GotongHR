import type { FieldIssue } from "./envelope.ts";
import type { ParseObjectResult, ParseResult } from "./org.ts";
import { parseUmpIdr } from "./org.ts";

/**
 * Departments, positions, PKWT/PKWTT contracts, and compensation profiles.
 * Money crosses JSON as a decimal string. The service stores bigint rupiah.
 */

export const contractTypes = ["PKWT", "PKWTT"] as const;
export type ContractType = (typeof contractTypes)[number];

export const contractStatuses = ["draft", "active", "ended", "cancelled"] as const;
export type ContractStatus = (typeof contractStatuses)[number];

export const bpjsFlagKeys = ["kesehatan", "jht", "jkk", "jkm", "jp", "jkp"] as const;
export type BpjsFlagKey = (typeof bpjsFlagKeys)[number];
export type BpjsFlags = Record<BpjsFlagKey, boolean>;

const contractTypeSet: ReadonlySet<string> = new Set(contractTypes);
const contractStatusSet: ReadonlySet<string> = new Set(contractStatuses);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const ALLOWANCE_KEY = /^[a-z][a-z0-9_]{0,31}$/u;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MAX_ALLOWANCES = 12;

export interface DepartmentInput {
  legalEntityId: string;
  branchId: string | null;
  parentDepartmentId: string | null;
  name: string;
  code: string;
  costCenterCode: string | null;
}

export interface DepartmentPatch {
  legalEntityId?: string;
  branchId?: string | null;
  parentDepartmentId?: string | null;
  name?: string;
  code?: string;
  costCenterCode?: string | null;
}

export interface DepartmentRecord {
  id: string;
  legalEntityId: string;
  branchId: string | null;
  parentDepartmentId: string | null;
  name: string;
  code: string;
  costCenterCode: string | null;
}

export interface PositionInput {
  departmentId: string;
  title: string;
  code: string;
  levelCode: string | null;
  reportsToPositionId: string | null;
}

export interface PositionPatch {
  departmentId?: string;
  title?: string;
  code?: string;
  levelCode?: string | null;
  reportsToPositionId?: string | null;
}

export interface PositionRecord {
  id: string;
  departmentId: string;
  title: string;
  code: string;
  levelCode: string | null;
  reportsToPositionId: string | null;
}

export interface ContractInput {
  contractType: ContractType;
  status: ContractStatus;
  startDate: string;
  endDate: string | null;
  departmentId: string | null;
  positionId: string | null;
  managerEmployeeId: string | null;
  compensationPaid: boolean;
}

export interface ContractRecord {
  id: string;
  employeeId: string;
  contractType: ContractType;
  status: ContractStatus;
  startDate: string;
  endDate: string | null;
  departmentId: string | null;
  positionId: string | null;
  managerEmployeeId: string | null;
  compensationPaid: boolean;
}

export interface CompensationCreateInput {
  baseSalaryIdr: bigint;
  fixedAllowances: Record<string, bigint>;
  bpjsFlags: BpjsFlags;
  effectiveFrom: string;
}

export interface CompensationProfileRecord {
  id: string;
  employeeId: string;
  baseSalaryIdr: string;
  fixedAllowances: Record<string, string>;
  bpjsFlags: BpjsFlags;
  effectiveFrom: string;
  effectiveTo: string | null;
  supersededBy: string | null;
}

export function parseDepartmentCreate(input: unknown): ParseObjectResult<DepartmentInput> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const legalEntityId = readUuid(body.legalEntityId, "Choose a legal entity.");
  const branchId = readOptionalUuid(body.branchId, "Choose a branch.");
  const parentDepartmentId = readOptionalUuid(body.parentDepartmentId, "Choose a parent department.");
  const name = readLabel(body.name, 160, "Enter the department name.");
  const code = readCode(body.code, "Enter a department code.");
  const costCenterCode = readOptionalCode(body.costCenterCode, "Enter a cost center code.");
  push(fields, "legalEntityId", legalEntityId);
  push(fields, "branchId", branchId);
  push(fields, "parentDepartmentId", parentDepartmentId);
  push(fields, "name", name);
  push(fields, "code", code);
  push(fields, "costCenterCode", costCenterCode);
  if (
    fields.length > 0 ||
    !legalEntityId.ok ||
    !branchId.ok ||
    !parentDepartmentId.ok ||
    !name.ok ||
    !code.ok ||
    !costCenterCode.ok
  ) {
    return { ok: false, fields };
  }
  return {
    ok: true,
    value: {
      legalEntityId: legalEntityId.value,
      branchId: branchId.value,
      parentDepartmentId: parentDepartmentId.value,
      name: name.value,
      code: code.value,
      costCenterCode: costCenterCode.value,
    },
  };
}

export function parseDepartmentPatch(input: unknown): ParseObjectResult<DepartmentPatch> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const value: DepartmentPatch = {};
  let changed = false;
  if (hasOwn(body, "legalEntityId")) {
    changed = true;
    const legalEntityId = readUuid(body.legalEntityId, "Choose a legal entity.");
    if (!legalEntityId.ok) fields.push({ field: "legalEntityId", message: legalEntityId.message });
    else value.legalEntityId = legalEntityId.value;
  }
  if (hasOwn(body, "branchId")) {
    changed = true;
    const branchId = readOptionalUuid(body.branchId, "Choose a branch.");
    if (!branchId.ok) fields.push({ field: "branchId", message: branchId.message });
    else value.branchId = branchId.value;
  }
  if (hasOwn(body, "parentDepartmentId")) {
    changed = true;
    const parentDepartmentId = readOptionalUuid(body.parentDepartmentId, "Choose a parent department.");
    if (!parentDepartmentId.ok) fields.push({ field: "parentDepartmentId", message: parentDepartmentId.message });
    else value.parentDepartmentId = parentDepartmentId.value;
  }
  if (hasOwn(body, "name")) {
    changed = true;
    const name = readLabel(body.name, 160, "Enter the department name.");
    if (!name.ok) fields.push({ field: "name", message: name.message });
    else value.name = name.value;
  }
  if (hasOwn(body, "code")) {
    changed = true;
    const code = readCode(body.code, "Enter a department code.");
    if (!code.ok) fields.push({ field: "code", message: code.message });
    else value.code = code.value;
  }
  if (hasOwn(body, "costCenterCode")) {
    changed = true;
    const costCenterCode = readOptionalCode(body.costCenterCode, "Enter a cost center code.");
    if (!costCenterCode.ok) fields.push({ field: "costCenterCode", message: costCenterCode.message });
    else value.costCenterCode = costCenterCode.value;
  }
  if (fields.length > 0) return { ok: false, fields };
  if (!changed) return { ok: false, fields: [{ field: "body", message: "No changes to save." }] };
  return { ok: true, value };
}

export function parsePositionCreate(input: unknown): ParseObjectResult<PositionInput> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const departmentId = readUuid(body.departmentId, "Choose a department.");
  const title = readLabel(body.title, 120, "Enter the position title.");
  const code = readCode(body.code, "Enter a position code.");
  const levelCode = readOptionalCode(body.levelCode, "Enter a level code.");
  const reportsToPositionId = readOptionalUuid(body.reportsToPositionId, "Choose a reporting position.");
  push(fields, "departmentId", departmentId);
  push(fields, "title", title);
  push(fields, "code", code);
  push(fields, "levelCode", levelCode);
  push(fields, "reportsToPositionId", reportsToPositionId);
  if (
    fields.length > 0 ||
    !departmentId.ok ||
    !title.ok ||
    !code.ok ||
    !levelCode.ok ||
    !reportsToPositionId.ok
  ) {
    return { ok: false, fields };
  }
  return {
    ok: true,
    value: {
      departmentId: departmentId.value,
      title: title.value,
      code: code.value,
      levelCode: levelCode.value,
      reportsToPositionId: reportsToPositionId.value,
    },
  };
}

export function parsePositionPatch(input: unknown): ParseObjectResult<PositionPatch> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const value: PositionPatch = {};
  let changed = false;
  if (hasOwn(body, "departmentId")) {
    changed = true;
    const departmentId = readUuid(body.departmentId, "Choose a department.");
    if (!departmentId.ok) fields.push({ field: "departmentId", message: departmentId.message });
    else value.departmentId = departmentId.value;
  }
  if (hasOwn(body, "title")) {
    changed = true;
    const title = readLabel(body.title, 120, "Enter the position title.");
    if (!title.ok) fields.push({ field: "title", message: title.message });
    else value.title = title.value;
  }
  if (hasOwn(body, "code")) {
    changed = true;
    const code = readCode(body.code, "Enter a position code.");
    if (!code.ok) fields.push({ field: "code", message: code.message });
    else value.code = code.value;
  }
  if (hasOwn(body, "levelCode")) {
    changed = true;
    const levelCode = readOptionalCode(body.levelCode, "Enter a level code.");
    if (!levelCode.ok) fields.push({ field: "levelCode", message: levelCode.message });
    else value.levelCode = levelCode.value;
  }
  if (hasOwn(body, "reportsToPositionId")) {
    changed = true;
    const reportsToPositionId = readOptionalUuid(body.reportsToPositionId, "Choose a reporting position.");
    if (!reportsToPositionId.ok) {
      fields.push({ field: "reportsToPositionId", message: reportsToPositionId.message });
    } else value.reportsToPositionId = reportsToPositionId.value;
  }
  if (fields.length > 0) return { ok: false, fields };
  if (!changed) return { ok: false, fields: [{ field: "body", message: "No changes to save." }] };
  return { ok: true, value };
}

export function parseContractCreate(input: unknown): ParseObjectResult<ContractInput> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const contractType = readContractType(body.contractType);
  const status = body.status === undefined ? { ok: true as const, value: "active" as const } : readStatus(body.status);
  const startDate = readIsoDate(body.startDate, "Enter the contract start date.");
  const endDate = readOptionalIsoDate(body.endDate, "Enter the contract end date.");
  const departmentId = readOptionalUuid(body.departmentId, "Choose a department.");
  const positionId = readOptionalUuid(body.positionId, "Choose a position.");
  const managerEmployeeId = readOptionalUuid(body.managerEmployeeId, "Choose a manager.");
  const compensationPaid = readBoolean(body.compensationPaid, false, "compensationPaid");
  push(fields, "contractType", contractType);
  push(fields, "status", status);
  push(fields, "startDate", startDate);
  push(fields, "endDate", endDate);
  push(fields, "departmentId", departmentId);
  push(fields, "positionId", positionId);
  push(fields, "managerEmployeeId", managerEmployeeId);
  push(fields, "compensationPaid", compensationPaid);
  if (
    fields.length > 0 ||
    !contractType.ok ||
    !status.ok ||
    !startDate.ok ||
    !endDate.ok ||
    !departmentId.ok ||
    !positionId.ok ||
    !managerEmployeeId.ok ||
    !compensationPaid.ok
  ) {
    return { ok: false, fields };
  }
  if (contractType.value === "PKWT" && endDate.value === null) {
    fields.push({ field: "endDate", message: "A PKWT contract needs an end date." });
  }
  if (endDate.value !== null && startDate.value > endDate.value) {
    fields.push({ field: "endDate", message: "The end date must be on or after the start date." });
  }
  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: {
      contractType: contractType.value,
      status: status.value,
      startDate: startDate.value,
      endDate: endDate.value,
      departmentId: departmentId.value,
      positionId: positionId.value,
      managerEmployeeId: managerEmployeeId.value,
      compensationPaid: compensationPaid.value,
    },
  };
}

export function parseCompensationCreate(input: unknown): ParseObjectResult<CompensationCreateInput> {
  const body = asRecord(input);
  if (!body) return objectError();
  const fields: FieldIssue[] = [];
  const baseSalaryIdr = readSalary(body.baseSalaryIdr);
  const fixedAllowances = readAllowances(body.fixedAllowances);
  const bpjsFlags = readBpjsFlags(body.bpjsFlags);
  const effectiveFrom = readIsoDate(body.effectiveFrom, "Enter the date this pay starts.");
  push(fields, "baseSalaryIdr", baseSalaryIdr);
  push(fields, "fixedAllowances", fixedAllowances);
  push(fields, "bpjsFlags", bpjsFlags);
  push(fields, "effectiveFrom", effectiveFrom);
  if (fields.length > 0 || !baseSalaryIdr.ok || !fixedAllowances.ok || !bpjsFlags.ok || !effectiveFrom.ok) {
    return { ok: false, fields };
  }
  return {
    ok: true,
    value: {
      baseSalaryIdr: baseSalaryIdr.value,
      fixedAllowances: fixedAllowances.value,
      bpjsFlags: bpjsFlags.value,
      effectiveFrom: effectiveFrom.value,
    },
  };
}

export function emptyBpjsFlags(): BpjsFlags {
  return {
    kesehatan: false,
    jht: false,
    jkk: false,
    jkm: false,
    jp: false,
    jkp: false,
  };
}

function readSalary(input: unknown): ParseResult<bigint> {
  const parsed = parseUmpIdr(input);
  if (!parsed.ok) return { ok: false, message: "Enter the salary in whole rupiah." };
  return parsed;
}

function readAllowances(input: unknown): ParseResult<Record<string, bigint>> {
  if (input === undefined) return { ok: true, value: {} };
  const body = asRecord(input);
  if (!body) return { ok: false, message: "Fixed allowances must be an object of rupiah amounts." };
  const keys = Object.keys(body);
  if (keys.length > MAX_ALLOWANCES) {
    return { ok: false, message: "Use 12 fixed allowances or fewer." };
  }
  const value: Record<string, bigint> = {};
  for (const key of keys) {
    if (!ALLOWANCE_KEY.test(key)) {
      return { ok: false, message: "Allowance names use lowercase letters, digits, and underscores." };
    }
    const amount = readSalary(body[key]);
    if (!amount.ok) return { ok: false, message: "Enter each allowance in whole rupiah." };
    value[key] = amount.value;
  }
  return { ok: true, value };
}

function readBpjsFlags(input: unknown): ParseResult<BpjsFlags> {
  const flags = emptyBpjsFlags();
  if (input === undefined) return { ok: true, value: flags };
  const body = asRecord(input);
  if (!body) return { ok: false, message: "BPJS flags must be an object." };
  for (const key of Object.keys(body)) {
    if (!isBpjsFlagKey(key)) return { ok: false, message: "Unknown BPJS flag." };
    const flag = body[key];
    if (typeof flag !== "boolean") return { ok: false, message: "BPJS flags must be true or false." };
    flags[key] = flag;
  }
  return { ok: true, value: flags };
}

function isBpjsFlagKey(value: string): value is BpjsFlagKey {
  return (bpjsFlagKeys as readonly string[]).includes(value);
}

function readContractType(input: unknown): ParseResult<ContractType> {
  if (typeof input !== "string" || !contractTypeSet.has(input)) {
    return { ok: false, message: "Choose PKWT or PKWTT." };
  }
  return { ok: true, value: input as ContractType };
}

function readStatus(input: unknown): ParseResult<ContractStatus> {
  if (typeof input !== "string" || !contractStatusSet.has(input)) {
    return { ok: false, message: "Choose a contract status." };
  }
  return { ok: true, value: input as ContractStatus };
}

function readBoolean(
  input: unknown,
  fallback: boolean,
  field: string,
): ParseResult<boolean> {
  if (input === undefined) return { ok: true, value: fallback };
  if (typeof input !== "boolean") return { ok: false, message: `${field} must be true or false.` };
  return { ok: true, value: input };
}

function readIsoDate(input: unknown, message: string): ParseResult<string> {
  if (typeof input !== "string" || !isRealIsoDate(input)) return { ok: false, message };
  return { ok: true, value: input };
}

function readOptionalIsoDate(input: unknown, message: string): ParseResult<string | null> {
  if (isBlank(input)) return { ok: true, value: null };
  return readIsoDate(input, message);
}

export function isRealIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.toISOString().slice(0, 10) === value;
}

function readUuid(input: unknown, message: string): ParseResult<string> {
  if (typeof input !== "string" || !UUID.test(input)) return { ok: false, message };
  return { ok: true, value: input.toLowerCase() };
}

function readOptionalUuid(input: unknown, message: string): ParseResult<string | null> {
  if (isBlank(input)) return { ok: true, value: null };
  return readUuid(input, message);
}

function readLabel(input: unknown, max: number, emptyMessage: string): ParseResult<string> {
  if (typeof input !== "string") return { ok: false, message: emptyMessage };
  const value = input.trim();
  if (value.length === 0 || hasControl(value)) return { ok: false, message: emptyMessage };
  if (value.length > max) return { ok: false, message: `Use ${max} characters or fewer.` };
  return { ok: true, value };
}

function readCode(input: unknown, emptyMessage: string): ParseResult<string> {
  if (typeof input !== "string") return { ok: false, message: emptyMessage };
  const value = input.trim();
  if (value.length === 0 || value.length > 32 || !CODE.test(value)) {
    return { ok: false, message: "Use 1 to 32 letters, digits, dots, slashes, or hyphens." };
  }
  return { ok: true, value };
}

function readOptionalCode(input: unknown, emptyMessage: string): ParseResult<string | null> {
  if (isBlank(input)) return { ok: true, value: null };
  return readCode(input, emptyMessage);
}

function push(fields: FieldIssue[], field: string, result: { ok: boolean; message?: string }): void {
  if (!result.ok && result.message) fields.push({ field, message: result.message });
}

function hasControl(value: string): boolean {
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
