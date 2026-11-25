import { idr, type BpjsFlags, type EmployeePayrollProfileDTO, type Idr } from "@gotonghr/contracts";
import type { AttendancePeriodSummaryDTO } from "@gotonghr/contracts";
import {
  calculateBpjs,
  calculateMonthlyPph21,
  calculateOvertime,
  civilDate,
  parseStatutoryTable,
  rupiah,
  terCategoryForPtkp,
  terRate,
  type StatutoryTable,
} from "@gotonghr/payroll-engine";
import { PayrollError } from "./errors.ts";

export interface StoredEarnings {
  baseSalaryIdr: string;
  fixedAllowancesIdr: string;
  overtimeIdr: string;
  taxAllowanceIdr: string;
}

export interface StoredDeductions {
  bpjsEmployeeIdr: string;
  pph21EmployeeIdr: string;
}

export interface StoredBpjs {
  reportedWageIdr: string;
  flooredWageIdr: string;
  kesehatanEmployeeIdr: string;
  kesehatanEmployerIdr: string;
  jhtEmployeeIdr: string;
  jhtEmployerIdr: string;
  jkkEmployerIdr: string;
  jkmEmployerIdr: string;
  jpEmployeeIdr: string;
  jpEmployerIdr: string;
  jkpEmployerIdr: string;
  employeePayableIdr: string;
  employerPayableIdr: string;
}

export interface StoredPph21 {
  method: string;
  periodMonth: number;
  category: string;
  grossTaxableIdr: string;
  taxAllowanceIdr: string;
  grossedTaxableIdr: string;
  taxIdr: string;
  employeeWithheldIdr: string;
  employerBorneTaxIdr: string;
  ratePerScale: string;
  rateScale: string;
  tableStatus: string;
  tableUndeclared: boolean;
}

export interface PayItemComputation {
  employeeSnapshot: Record<string, unknown>;
  attendanceSnapshot: Record<string, unknown>;
  earnings: StoredEarnings;
  deductions: StoredDeductions;
  bpjs: StoredBpjs;
  pph21: StoredPph21;
  grossIdr: bigint;
  taxIdr: bigint;
  netIdr: bigint;
}

/**
 * One employee for one month.
 * Wage for BPJS and overtime is base salary plus fixed allowances.
 * Overtime minutes are workday overtime. December is refused here.
 * A BPJS flag that is off contributes Rp0. All flags on matches `calculateBpjs`.
 * Gross is earnings the employee is paid. Nett does not add the tax allowance.
 * Net subtracts employee BPJS and employee-withheld PPh 21.
 */
export function computePayItem(input: {
  profile: EmployeePayrollProfileDTO;
  attendance: AttendancePeriodSummaryDTO;
  table: StatutoryTable;
  periodYear: number;
  periodMonth: number;
}): PayItemComputation {
  if (input.periodMonth === 12) {
    throw new PayrollError(
      422,
      "december_unsupported",
      "December payroll uses Pasal 17 reconciliation, which this run does not calculate yet.",
    );
  }
  const flags = input.profile.bpjsFlags;
  const base = input.profile.baseSalaryIdr;
  const fixed = input.profile.fixedAllowancesIdr;
  const monthlyWage = base + fixed;
  const overtime = calculateOvertime({
    monthlyWage,
    minutes: input.attendance.approvedOvertimeMinutes,
    dayKind: "workday",
  }).pay;
  const raw = calculateBpjs({
    wage: monthlyWage,
    additionalFamilyMembers: 0,
    applyWageFloor: true,
    umpUmk: input.profile.umpUmkIdr,
    jkkRiskClass: input.profile.jkkRiskClass,
    jkpEligible: flags.jkp,
    table: input.table,
  });
  const kesehatanEmployee = flagged(flags.kesehatan, raw.kesehatan.employee);
  const kesehatanEmployer = flagged(flags.kesehatan, raw.kesehatan.employer);
  const jhtEmployee = flagged(flags.jht, raw.jht.employee);
  const jhtEmployer = flagged(flags.jht, raw.jht.employer);
  const jkkEmployer = flagged(flags.jkk, raw.jkk.employer);
  const jkmEmployer = flagged(flags.jkm, raw.jkm.employer);
  const jpEmployee = flagged(flags.jp, raw.jp.employee);
  const jpEmployer = flagged(flags.jp, raw.jp.employer);
  const jkpEmployer = flagged(flags.jkp, raw.jkp.fromJkk);
  const employeePayable = kesehatanEmployee + jhtEmployee + jpEmployee;
  const employerPayable = kesehatanEmployer + jhtEmployer + jkkEmployer + jkmEmployer + jpEmployer + jkpEmployer;
  const pph = calculateMonthlyPph21({
    payrollDate: civilDate(input.periodYear, input.periodMonth, lastDay(input.periodYear, input.periodMonth)),
    periodMonth: input.periodMonth,
    table: input.table,
    ptkpStatus: input.profile.ptkpStatus,
    method: input.profile.taxMethod,
    components: {
      baseSalary: rupiah(base),
      fixedAllowances: rupiah(fixed),
      overtime,
      bonusOrThr: rupiah(0n),
      employerJkk: rupiah(jkkEmployer),
      employerJkm: rupiah(jkmEmployer),
      employerBpjsKesehatan: rupiah(kesehatanEmployer),
    },
  });
  const earningAllowance = input.profile.taxMethod === "gross_up" ? pph.taxAllowance : 0n;
  const gross = base + fixed + overtime + earningAllowance;
  const net = gross - employeePayable - pph.employeeWithheld;
  const rate = terRate(input.table, terCategoryForPtkp(input.profile.ptkpStatus), pph.grossedTaxable);
  return {
    employeeSnapshot: toJsonRecord(input.profile),
    attendanceSnapshot: toJsonRecord(input.attendance),
    earnings: {
      baseSalaryIdr: base.toString(),
      fixedAllowancesIdr: fixed.toString(),
      overtimeIdr: overtime.toString(),
      taxAllowanceIdr: earningAllowance.toString(),
    },
    deductions: {
      bpjsEmployeeIdr: employeePayable.toString(),
      pph21EmployeeIdr: pph.employeeWithheld.toString(),
    },
    bpjs: {
      reportedWageIdr: raw.reportedWage.toString(),
      flooredWageIdr: raw.flooredWage.toString(),
      kesehatanEmployeeIdr: kesehatanEmployee.toString(),
      kesehatanEmployerIdr: kesehatanEmployer.toString(),
      jhtEmployeeIdr: jhtEmployee.toString(),
      jhtEmployerIdr: jhtEmployer.toString(),
      jkkEmployerIdr: jkkEmployer.toString(),
      jkmEmployerIdr: jkmEmployer.toString(),
      jpEmployeeIdr: jpEmployee.toString(),
      jpEmployerIdr: jpEmployer.toString(),
      jkpEmployerIdr: jkpEmployer.toString(),
      employeePayableIdr: employeePayable.toString(),
      employerPayableIdr: employerPayable.toString(),
    },
    pph21: {
      method: pph.method,
      periodMonth: pph.periodMonth,
      category: pph.category,
      grossTaxableIdr: pph.grossTaxable.toString(),
      taxAllowanceIdr: pph.taxAllowance.toString(),
      grossedTaxableIdr: pph.grossedTaxable.toString(),
      taxIdr: pph.tax.toString(),
      employeeWithheldIdr: pph.employeeWithheld.toString(),
      employerBorneTaxIdr: pph.employerBorneTax.toString(),
      ratePerScale: rate.ratePerScale.toString(),
      rateScale: rate.rateScale.toString(),
      tableStatus: pph.tableStatus,
      tableUndeclared: pph.tableUndeclared,
    },
    grossIdr: gross,
    taxIdr: pph.tax,
    netIdr: net,
  };
}

export function readStatutoryTable(payload: unknown): StatutoryTable {
  return parseStatutoryTable(payload);
}

export function profileFromSnapshot(value: Record<string, unknown>): EmployeePayrollProfileDTO {
  return {
    tenantId: text(value.tenantId, "tenantId"),
    employeeId: text(value.employeeId, "employeeId"),
    legalEntityId: text(value.legalEntityId, "legalEntityId"),
    branchId: text(value.branchId, "branchId"),
    userId: value.userId === null ? null : text(value.userId, "userId"),
    employeeCode: text(value.employeeCode, "employeeCode"),
    fullName: text(value.fullName, "fullName"),
    jobTitle: text(value.jobTitle, "jobTitle"),
    dateOfBirth: text(value.dateOfBirth, "dateOfBirth"),
    ptkpStatus: text(value.ptkpStatus, "ptkpStatus") as EmployeePayrollProfileDTO["ptkpStatus"],
    taxMethod: text(value.taxMethod, "taxMethod") as EmployeePayrollProfileDTO["taxMethod"],
    pph21SubjectType: text(value.pph21SubjectType, "pph21SubjectType") as EmployeePayrollProfileDTO["pph21SubjectType"],
    baseSalaryIdr: money(value.baseSalaryIdr, "baseSalaryIdr"),
    fixedAllowancesIdr: money(value.fixedAllowancesIdr, "fixedAllowancesIdr"),
    bpjsFlags: flags(value.bpjsFlags),
    nik: text(value.nik, "nik"),
    bankAccountNumber: text(value.bankAccountNumber, "bankAccountNumber"),
    nitku: text(value.nitku, "nitku"),
    companyName: text(value.companyName, "companyName"),
    companyNpwp: text(value.companyNpwp, "companyNpwp"),
    umpUmkIdr: money(value.umpUmkIdr, "umpUmkIdr"),
    jkkRiskClass: risk(value.jkkRiskClass),
  };
}

export function attendanceFromSnapshot(value: Record<string, unknown>): AttendancePeriodSummaryDTO {
  const minutes = value.approvedOvertimeMinutes;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0) {
    throw new PayrollError(500, "internal_error", "Attendance snapshot minutes are not a whole number.");
  }
  return {
    tenantId: text(value.tenantId, "tenantId"),
    employeeId: text(value.employeeId, "employeeId"),
    legalEntityId: text(value.legalEntityId, "legalEntityId"),
    periodYear: whole(value.periodYear, "periodYear"),
    periodMonth: whole(value.periodMonth, "periodMonth"),
    approvedOvertimeMinutes: minutes,
    locked: value.locked === true,
  };
}

function flagged(on: boolean, amount: Idr): bigint {
  return on ? amount : 0n;
}

function lastDay(year: number, month: number): number {
  const leap = month === 2 && (year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0));
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1] ?? 30;
}

export function toJsonRecord(value: object): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item)),
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PayrollError(500, "internal_error", "Snapshot was not an object.");
  }
  return parsed as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PayrollError(500, "internal_error", `${label} is missing from the snapshot.`);
  }
  return value;
}

function money(value: unknown, label: string): Idr {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new PayrollError(500, "internal_error", `${label} was not integer rupiah.`);
  }
  return idr(BigInt(value));
}

function whole(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PayrollError(500, "internal_error", `${label} was not a whole number.`);
  }
  return value;
}

function risk(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new PayrollError(500, "internal_error", "JKK risk class was not 1 to 5.");
  }
  return value;
}

function flags(value: unknown): BpjsFlags {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PayrollError(500, "internal_error", "BPJS flags are missing from the snapshot.");
  }
  const record = value as Record<string, unknown>;
  return {
    kesehatan: record.kesehatan === true,
    jht: record.jht === true,
    jkk: record.jkk === true,
    jkm: record.jkm === true,
    jp: record.jp === true,
    jkp: record.jkp === true,
  };
}
