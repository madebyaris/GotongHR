import { ptkpStatuses, type PermissionAtom, type PtkpStatus, type TaxMethod } from "@gotonghr/contracts";
import {
  MissingStatutoryValueError,
  PayrollInputError,
  calculateMonthlyPph21,
  civilDateFromIso,
  rupiah,
  type StatutoryTable,
} from "@gotonghr/payroll-engine";
import type { AiCaller } from "./caller.ts";
import type { LlmToolDefinition } from "./provider.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const IDR = /^(0|[1-9][0-9]*)$/u;
const METHODS = ["gross", "nett", "gross_up"] as const;

export interface PayrollAmounts {
  grossTaxableIdr: bigint;
  taxIdr: bigint;
  employeeWithheldIdr: bigint;
  employerBorneTaxIdr: bigint;
  taxAllowanceIdr: bigint;
  category: string;
  tableUndeclared: boolean;
}

export type ToolFailure = "forbidden" | "invalid" | "statutory_table_incomplete";

export type ToolDispatch =
  | { ok: false; code: ToolFailure }
  | { ok: true; mutating: false; result: Record<string, unknown> }
  | {
      ok: true;
      mutating: true;
      arguments: Record<string, unknown>;
      impact: Record<string, unknown>;
    };

interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permission: PermissionAtom;
  mutating: boolean;
  visible(caller: AiCaller): boolean;
}

const SIMULATE = "simulate_payroll_item";
const PROPOSE = "propose_employee_change";
const FINALIZE = "propose_payroll_finalize";
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;

const simulateParameters: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["employeeId", "payrollDate", "periodMonth", "ptkpStatus", "method", "baseSalaryIdr"],
  properties: {
    employeeId: { type: "string" },
    branchId: { type: "string" },
    legalEntityId: { type: "string" },
    payrollDate: { type: "string", description: "YYYY-MM-DD" },
    periodMonth: { type: "integer", minimum: 1, maximum: 11 },
    ptkpStatus: { type: "string" },
    method: { type: "string", enum: [...METHODS] },
    baseSalaryIdr: { type: "string", description: "Integer rupiah" },
    fixedAllowancesIdr: { type: "string" },
    overtimeIdr: { type: "string" },
    bonusOrThrIdr: { type: "string" },
    employerJkkIdr: { type: "string" },
    employerJkmIdr: { type: "string" },
    employerBpjsKesehatanIdr: { type: "string" },
  },
};

const proposeParameters: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["employeeId", "field", "value"],
  properties: {
    employeeId: { type: "string" },
    branchId: { type: "string" },
    legalEntityId: { type: "string" },
    field: { type: "string", enum: ["display_name", "ptkp_status"] },
    value: { type: "string" },
  },
};

const finalizeParameters: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["payrollRunId", "periodLabel", "netPayIdr"],
  properties: {
    payrollRunId: { type: "string" },
    periodLabel: { type: "string", description: "YYYY-MM" },
    netPayIdr: { type: "string", description: "Integer rupiah" },
  },
};

const TOOLS: readonly ToolSpec[] = [
  {
    name: SIMULATE,
    description:
      "Estimate one employee's monthly PPh 21 with the payroll engine. Amounts are integer rupiah. Do not calculate tax yourself.",
    parameters: simulateParameters,
    permission: "payroll.run.prepare",
    mutating: false,
    visible: (caller) => canSee(caller, "payroll.run.prepare"),
  },
  {
    name: PROPOSE,
    description:
      "Propose a non-sensitive employee field change. This does not change the employee. A person must confirm the proposal.",
    parameters: proposeParameters,
    permission: "ai.action.approve",
    mutating: true,
    visible: (caller) => canSee(caller, "ai.action.approve"),
  },
  {
    name: FINALIZE,
    description:
      "Propose finalizing one payroll run. This does not finalize the run. A person must confirm it with an authenticator code.",
    parameters: finalizeParameters,
    permission: "payroll.run.finalize",
    mutating: true,
    visible: (caller) => caller.permissions.includes("payroll.run.finalize"),
  },
];

export function toolsForCaller(caller: AiCaller): LlmToolDefinition[] {
  return TOOLS.filter((tool) => tool.visible(caller)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export function isMutatingTool(name: string): boolean {
  return TOOLS.some((tool) => tool.name === name && tool.mutating);
}

export function proposalRequiresTotp(toolName: string): boolean {
  return toolName === FINALIZE;
}

export function dispatchTool(caller: AiCaller, name: string, args: unknown, table: StatutoryTable): ToolDispatch {
  if (name === SIMULATE) return dispatchSimulate(caller, args, table);
  if (name === PROPOSE) return dispatchPropose(caller, args);
  if (name === FINALIZE) return dispatchFinalize(caller, args);
  return { ok: false, code: "forbidden" };
}

/**
 * Calls the payroll engine. The rate table is injected. This function does not
 * invent TER or PTKP amounts. A draft table with missing rates returns no tax.
 */
export function simulatePayrollItem(
  caller: AiCaller,
  args: unknown,
  table: StatutoryTable,
): { ok: true; amounts: PayrollAmounts } | { ok: false; code: ToolFailure } {
  const parsed = parseSimulate(args);
  if (!parsed) return { ok: false, code: "invalid" };
  if (!compensationAllowed(caller, parsed.employeeId, parsed.branchId, parsed.legalEntityId)) {
    return { ok: false, code: "forbidden" };
  }
  try {
    const result = calculateMonthlyPph21({
      payrollDate: parsed.payrollDate,
      periodMonth: parsed.periodMonth,
      table,
      ptkpStatus: parsed.ptkpStatus,
      method: parsed.method,
      components: {
        baseSalary: parsed.baseSalary,
        fixedAllowances: parsed.fixedAllowances,
        overtime: parsed.overtime,
        bonusOrThr: parsed.bonusOrThr,
        employerJkk: parsed.employerJkk,
        employerJkm: parsed.employerJkm,
        employerBpjsKesehatan: parsed.employerBpjsKesehatan,
      },
      ...(table.status === "draft" ? { allowUndeclared: true as const } : {}),
    });
    return {
      ok: true,
      amounts: {
        grossTaxableIdr: result.grossTaxable,
        taxIdr: result.tax,
        employeeWithheldIdr: result.employeeWithheld,
        employerBorneTaxIdr: result.employerBorneTax,
        taxAllowanceIdr: result.taxAllowance,
        category: result.category,
        tableUndeclared: result.tableUndeclared,
      },
    };
  } catch (error) {
    if (error instanceof MissingStatutoryValueError || error instanceof PayrollInputError) {
      return { ok: false, code: "statutory_table_incomplete" };
    }
    throw error;
  }
}

function dispatchSimulate(caller: AiCaller, args: unknown, table: StatutoryTable): ToolDispatch {
  const simulated = simulatePayrollItem(caller, args, table);
  if (!simulated.ok) return simulated;
  return {
    ok: true,
    mutating: false,
    result: {
      unit: "idr",
      category: simulated.amounts.category,
      tableUndeclared: simulated.amounts.tableUndeclared,
      grossTaxableIdr: simulated.amounts.grossTaxableIdr.toString(),
      taxIdr: simulated.amounts.taxIdr.toString(),
      employeeWithheldIdr: simulated.amounts.employeeWithheldIdr.toString(),
      employerBorneTaxIdr: simulated.amounts.employerBorneTaxIdr.toString(),
      taxAllowanceIdr: simulated.amounts.taxAllowanceIdr.toString(),
    },
  };
}

function dispatchPropose(caller: AiCaller, args: unknown): ToolDispatch {
  const parsed = parsePropose(args);
  if (!parsed) return { ok: false, code: "invalid" };
  if (!caller.permissions.includes("ai.action.approve")) return { ok: false, code: "forbidden" };
  if (!employeeInScope(caller, parsed.employeeId, parsed.branchId, parsed.legalEntityId)) {
    return { ok: false, code: "forbidden" };
  }
  const label = parsed.field === "display_name" ? "Display name" : "PTKP status";
  return {
    ok: true,
    mutating: true,
    arguments: {
      employeeId: parsed.employeeId,
      field: parsed.field,
      value: parsed.value,
      ...(parsed.branchId ? { branchId: parsed.branchId } : {}),
      ...(parsed.legalEntityId ? { legalEntityId: parsed.legalEntityId } : {}),
    },
    impact: {
      summary: `Update ${label} after confirmation.`,
      employeeId: parsed.employeeId,
      field: parsed.field,
      nextValue: parsed.value,
      requiresTotp: false,
      diff: [{ label, before: null, after: parsed.value }],
      amounts: [],
      warnings: ["Nothing changes until you confirm."],
    },
  };
}

function dispatchFinalize(caller: AiCaller, args: unknown): ToolDispatch {
  const parsed = parseFinalize(args);
  if (!parsed) return { ok: false, code: "invalid" };
  if (!caller.permissions.includes("payroll.run.finalize")) return { ok: false, code: "forbidden" };
  return {
    ok: true,
    mutating: true,
    arguments: {
      payrollRunId: parsed.payrollRunId,
      periodLabel: parsed.periodLabel,
      netPayIdr: parsed.netPayIdr,
    },
    impact: {
      summary: `Finalize payroll ${parsed.periodLabel}.`,
      requiresTotp: true,
      payrollRunId: parsed.payrollRunId,
      diff: [{ label: "Run status", before: "draft", after: "finalized" }],
      amounts: [{ unit: "idr", label: "Net pay", amount: parsed.netPayIdr }],
      warnings: [
        "Finalizing payroll needs an authenticator code.",
        "Nothing changes until you confirm.",
      ],
    },
  };
}

function canSee(caller: AiCaller, permission: PermissionAtom): boolean {
  if (!caller.permissions.includes(permission)) return false;
  if ((caller.selfOnly || caller.directReportsOnly) && caller.selfEmployeeId === null) return false;
  return true;
}

function compensationAllowed(
  caller: AiCaller,
  employeeId: string,
  branchId: string | null,
  legalEntityId: string | null,
): boolean {
  if (!caller.permissions.includes("payroll.run.prepare")) return false;
  return employeeInScope(caller, employeeId, branchId, legalEntityId);
}

function employeeInScope(
  caller: AiCaller,
  employeeId: string,
  branchId: string | null,
  legalEntityId: string | null,
): boolean {
  if (caller.selfOnly || caller.directReportsOnly) {
    return caller.selfEmployeeId !== null && caller.selfEmployeeId === employeeId;
  }
  if (caller.scopeBranchIds.length > 0) {
    if (!branchId || !caller.scopeBranchIds.includes(branchId)) return false;
  }
  if (caller.scopeEntityIds.length > 0) {
    if (!legalEntityId || !caller.scopeEntityIds.includes(legalEntityId)) return false;
  }
  return true;
}

interface SimulateArgs {
  employeeId: string;
  branchId: string | null;
  legalEntityId: string | null;
  payrollDate: ReturnType<typeof civilDateFromIso>;
  periodMonth: number;
  ptkpStatus: PtkpStatus;
  method: TaxMethod;
  baseSalary: ReturnType<typeof rupiah>;
  fixedAllowances: ReturnType<typeof rupiah>;
  overtime: ReturnType<typeof rupiah>;
  bonusOrThr: ReturnType<typeof rupiah>;
  employerJkk: ReturnType<typeof rupiah>;
  employerJkm: ReturnType<typeof rupiah>;
  employerBpjsKesehatan: ReturnType<typeof rupiah>;
}

function parseSimulate(args: unknown): SimulateArgs | null {
  const record = asRecord(args);
  if (!record) return null;
  const employeeId = readUuid(record.employeeId);
  const payrollDate = readDate(record.payrollDate);
  const periodMonth = readMonth(record.periodMonth);
  const ptkpStatus = readPtkp(record.ptkpStatus);
  const method = readMethod(record.method);
  const baseSalary = readIdr(record.baseSalaryIdr);
  const fixedAllowances = optionalIdr(record.fixedAllowancesIdr);
  const overtime = optionalIdr(record.overtimeIdr);
  const bonusOrThr = optionalIdr(record.bonusOrThrIdr);
  const employerJkk = optionalIdr(record.employerJkkIdr);
  const employerJkm = optionalIdr(record.employerJkmIdr);
  const employerBpjsKesehatan = optionalIdr(record.employerBpjsKesehatanIdr);
  if (
    employeeId === null ||
    payrollDate === null ||
    periodMonth === null ||
    ptkpStatus === null ||
    method === null ||
    baseSalary === null ||
    fixedAllowances === null ||
    overtime === null ||
    bonusOrThr === null ||
    employerJkk === null ||
    employerJkm === null ||
    employerBpjsKesehatan === null
  ) {
    return null;
  }
  if (payrollDate.month !== periodMonth) return null;
  return {
    employeeId,
    branchId: readOptionalUuid(record.branchId),
    legalEntityId: readOptionalUuid(record.legalEntityId),
    payrollDate,
    periodMonth,
    ptkpStatus,
    method,
    baseSalary,
    fixedAllowances,
    overtime,
    bonusOrThr,
    employerJkk,
    employerJkm,
    employerBpjsKesehatan,
  };
}

function parseFinalize(args: unknown): {
  payrollRunId: string;
  periodLabel: string;
  netPayIdr: string;
} | null {
  const record = asRecord(args);
  if (!record) return null;
  const payrollRunId = readUuid(record.payrollRunId);
  const periodLabel = typeof record.periodLabel === "string" && PERIOD.test(record.periodLabel) ? record.periodLabel : null;
  const netPayIdr = typeof record.netPayIdr === "string" && IDR.test(record.netPayIdr) ? record.netPayIdr : null;
  if (!payrollRunId || !periodLabel || !netPayIdr) return null;
  return { payrollRunId, periodLabel, netPayIdr };
}

function parsePropose(args: unknown): {
  employeeId: string;
  branchId: string | null;
  legalEntityId: string | null;
  field: "display_name" | "ptkp_status";
  value: string;
} | null {
  const record = asRecord(args);
  if (!record) return null;
  const employeeId = readUuid(record.employeeId);
  const field = record.field === "display_name" || record.field === "ptkp_status" ? record.field : null;
  if (!employeeId || !field || typeof record.value !== "string") return null;
  const value = record.value.trim();
  if (value.length === 0 || value.length > 80) return null;
  if (field === "ptkp_status" && !readPtkp(value)) return null;
  return {
    employeeId,
    branchId: readOptionalUuid(record.branchId),
    legalEntityId: readOptionalUuid(record.legalEntityId),
    field,
    value,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readUuid(value: unknown): string | null {
  if (typeof value !== "string" || !UUID.test(value)) return null;
  return value.toLowerCase();
}

function readOptionalUuid(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return readUuid(value);
}

function readMonth(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 11) return null;
  return value;
}

function readPtkp(value: unknown): PtkpStatus | null {
  if (typeof value !== "string") return null;
  return ptkpStatuses.find((status) => status === value) ?? null;
}

function readMethod(value: unknown): TaxMethod | null {
  if (value === "gross" || value === "nett" || value === "gross_up") return value;
  return null;
}

function readDate(value: unknown): ReturnType<typeof civilDateFromIso> | null {
  if (typeof value !== "string") return null;
  try {
    return civilDateFromIso(value);
  } catch (error) {
    if (error instanceof PayrollInputError) return null;
    throw error;
  }
}

function readIdr(value: unknown): ReturnType<typeof rupiah> | null {
  if (typeof value !== "string" || !IDR.test(value)) return null;
  return rupiah(BigInt(value));
}

function optionalIdr(value: unknown): ReturnType<typeof rupiah> | null {
  if (value === undefined || value === null || value === "") return rupiah(0n);
  return readIdr(value);
}
