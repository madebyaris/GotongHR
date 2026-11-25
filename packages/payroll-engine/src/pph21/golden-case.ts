import { ptkpStatuses, type PtkpStatus, type TaxMethod } from "@gotonghr/contracts";
import { civilDateFromIso, isIsoDate, type CivilDate } from "../civil-date.ts";
import { GoldenCaseMismatchError, InvalidStatutoryTableError } from "../errors.ts";
import { rupiah } from "../money.ts";
import type { StatutoryTable } from "../tables/types.ts";
import type { GrossTaxableComponents } from "./gross-taxable.ts";
import { calculateMonthlyPph21 } from "./monthly.ts";
import { reconcilePph21, type ReconciliationReason } from "./reconcile.ts";

export interface MonthlyGoldenCase {
  readonly kind: "monthly_ter";
  readonly id: string;
  readonly verified: true;
  readonly payrollDate: CivilDate;
  readonly ptkpStatus: PtkpStatus;
  readonly method: TaxMethod;
  readonly components: GrossTaxableComponents;
  readonly expected: {
    readonly tax: bigint;
    readonly taxAllowance: bigint;
    readonly employeeWithheld: bigint;
    readonly employerBorneTax: bigint;
    readonly grossedTaxable: bigint;
    readonly grossedCost: bigint;
  };
}

export interface ReconcileGoldenCase {
  readonly kind: "reconcile";
  readonly id: string;
  readonly verified: true;
  readonly payrollDate: CivilDate;
  readonly reason: ReconciliationReason;
  readonly ptkpStatus: PtkpStatus;
  readonly activeMonths: number;
  readonly ytdGrossTaxable: bigint;
  readonly ytdEmployeeJht: bigint;
  readonly ytdEmployeeJp: bigint;
  readonly verifiedZakat: bigint;
  readonly ytdPph21Withheld: bigint;
  readonly expected: {
    readonly withholding: bigint;
    readonly refund: bigint;
    readonly pkp: bigint;
    readonly annualTax: bigint;
    readonly biayaJabatan: bigint;
  };
}

export type GoldenCase = MonthlyGoldenCase | ReconcileGoldenCase;

export interface GoldenFile {
  readonly description: string;
  readonly cases: readonly GoldenCase[];
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidStatutoryTableError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new InvalidStatutoryTableError(`${path}.${key} is not a golden case field.`);
    }
  }
}

function requireKey(record: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.hasOwn(record, key)) {
    throw new InvalidStatutoryTableError(`${path}.${key} is required.`);
  }
  return record[key];
}

function parseId(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value)) {
    throw new InvalidStatutoryTableError(`${path} must be a short id.`);
  }
  return value;
}

function parseMoney(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new InvalidStatutoryTableError(`${path} must be a non-negative integer string.`);
  }
  return BigInt(value);
}

function parseStatus(value: unknown, path: string): PtkpStatus {
  if (typeof value !== "string" || !ptkpStatuses.includes(value as PtkpStatus)) {
    throw new InvalidStatutoryTableError(`${path} must be a PTKP status.`);
  }
  return value as PtkpStatus;
}

function parseMethod(value: unknown, path: string): TaxMethod {
  if (value !== "gross" && value !== "nett" && value !== "gross_up") {
    throw new InvalidStatutoryTableError(`${path} must be gross, nett, or gross_up.`);
  }
  return value;
}

function parseComponents(value: unknown, path: string): GrossTaxableComponents {
  const record = asRecord(value, path);
  rejectUnknown(
    record,
    [
      "base_salary",
      "fixed_allowances",
      "overtime",
      "bonus_or_thr",
      "employer_jkk",
      "employer_jkm",
      "employer_bpjs_kesehatan",
    ],
    path,
  );
  return {
    baseSalary: rupiah(parseMoney(requireKey(record, "base_salary", path), `${path}.base_salary`)),
    fixedAllowances: rupiah(
      parseMoney(requireKey(record, "fixed_allowances", path), `${path}.fixed_allowances`),
    ),
    overtime: rupiah(parseMoney(requireKey(record, "overtime", path), `${path}.overtime`)),
    bonusOrThr: rupiah(parseMoney(requireKey(record, "bonus_or_thr", path), `${path}.bonus_or_thr`)),
    employerJkk: rupiah(parseMoney(requireKey(record, "employer_jkk", path), `${path}.employer_jkk`)),
    employerJkm: rupiah(parseMoney(requireKey(record, "employer_jkm", path), `${path}.employer_jkm`)),
    employerBpjsKesehatan: rupiah(
      parseMoney(requireKey(record, "employer_bpjs_kesehatan", path), `${path}.employer_bpjs_kesehatan`),
    ),
  };
}

function same(caseId: string, field: string, expected: bigint, actual: bigint): void {
  if (expected !== actual) throw new GoldenCaseMismatchError(caseId, field, expected, actual);
}

function parseCase(value: unknown, index: number, seenIds: Set<string>): GoldenCase | null {
  const path = `cases.${index}`;
  const record = asRecord(value, path);
  const id = parseId(requireKey(record, "id", path), `${path}.id`);
  if (seenIds.has(id)) {
    throw new InvalidStatutoryTableError(`${path}.id duplicates ${id}.`);
  }
  seenIds.add(id);
  const verified = requireKey(record, "verified", path);
  if (verified !== true) {
    if (verified !== false) throw new InvalidStatutoryTableError(`${path}.verified must be boolean.`);
    return null;
  }
  const operation = requireKey(record, "operation", path);
  const payrollDateValue = requireKey(record, "payroll_date", path);
  if (typeof payrollDateValue !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payrollDateValue)) {
    throw new InvalidStatutoryTableError(`${path}.payroll_date must be YYYY-MM-DD.`);
  }
  if (!isIsoDate(payrollDateValue)) {
    throw new InvalidStatutoryTableError(`${path}.payroll_date must be a real calendar date.`);
  }
  const payrollDate = civilDateFromIso(payrollDateValue);
  const ptkpStatus = parseStatus(requireKey(record, "ptkp_status", path), `${path}.ptkp_status`);
  if (operation === "monthly_ter") {
    rejectUnknown(
      record,
      ["id", "verified", "operation", "payroll_date", "ptkp_status", "method", "components", "expected"],
      path,
    );
    const expected = asRecord(requireKey(record, "expected", path), `${path}.expected`);
    rejectUnknown(
      expected,
      ["tax", "tax_allowance", "employee_withheld", "employer_borne_tax", "grossed_taxable", "grossed_cost"],
      `${path}.expected`,
    );
    return {
      kind: "monthly_ter",
      id,
      verified: true,
      payrollDate,
      ptkpStatus,
      method: parseMethod(requireKey(record, "method", path), `${path}.method`),
      components: parseComponents(requireKey(record, "components", path), `${path}.components`),
      expected: {
        tax: parseMoney(requireKey(expected, "tax", `${path}.expected`), `${path}.expected.tax`),
        taxAllowance: parseMoney(
          requireKey(expected, "tax_allowance", `${path}.expected`),
          `${path}.expected.tax_allowance`,
        ),
        employeeWithheld: parseMoney(
          requireKey(expected, "employee_withheld", `${path}.expected`),
          `${path}.expected.employee_withheld`,
        ),
        employerBorneTax: parseMoney(
          requireKey(expected, "employer_borne_tax", `${path}.expected`),
          `${path}.expected.employer_borne_tax`,
        ),
        grossedTaxable: parseMoney(
          requireKey(expected, "grossed_taxable", `${path}.expected`),
          `${path}.expected.grossed_taxable`,
        ),
        grossedCost: parseMoney(
          requireKey(expected, "grossed_cost", `${path}.expected`),
          `${path}.expected.grossed_cost`,
        ),
      },
    };
  }
  if (operation === "reconcile") {
    rejectUnknown(
      record,
      [
        "id",
        "verified",
        "operation",
        "payroll_date",
        "reason",
        "ptkp_status",
        "active_months",
        "ytd_gross_taxable",
        "ytd_employee_jht",
        "ytd_employee_jp",
        "verified_zakat",
        "ytd_pph21_withheld",
        "expected",
      ],
      path,
    );
    const reason = requireKey(record, "reason", path);
    if (reason !== "december" && reason !== "exit") {
      throw new InvalidStatutoryTableError(`${path}.reason must be december or exit.`);
    }
    const activeMonths = requireKey(record, "active_months", path);
    if (
      typeof activeMonths !== "number" ||
      !Number.isInteger(activeMonths) ||
      activeMonths < 1 ||
      activeMonths > 12
    ) {
      throw new InvalidStatutoryTableError(`${path}.active_months must be an integer from 1 to 12.`);
    }
    const expected = asRecord(requireKey(record, "expected", path), `${path}.expected`);
    rejectUnknown(
      expected,
      ["withholding", "refund", "pkp", "annual_tax", "biaya_jabatan"],
      `${path}.expected`,
    );
    return {
      kind: "reconcile",
      id,
      verified: true,
      payrollDate,
      reason,
      ptkpStatus,
      activeMonths,
      ytdGrossTaxable: parseMoney(requireKey(record, "ytd_gross_taxable", path), `${path}.ytd_gross_taxable`),
      ytdEmployeeJht: parseMoney(requireKey(record, "ytd_employee_jht", path), `${path}.ytd_employee_jht`),
      ytdEmployeeJp: parseMoney(requireKey(record, "ytd_employee_jp", path), `${path}.ytd_employee_jp`),
      verifiedZakat: parseMoney(requireKey(record, "verified_zakat", path), `${path}.verified_zakat`),
      ytdPph21Withheld: parseMoney(
        requireKey(record, "ytd_pph21_withheld", path),
        `${path}.ytd_pph21_withheld`,
      ),
      expected: {
        withholding: parseMoney(
          requireKey(expected, "withholding", `${path}.expected`),
          `${path}.expected.withholding`,
        ),
        refund: parseMoney(requireKey(expected, "refund", `${path}.expected`), `${path}.expected.refund`),
        pkp: parseMoney(requireKey(expected, "pkp", `${path}.expected`), `${path}.expected.pkp`),
        annualTax: parseMoney(
          requireKey(expected, "annual_tax", `${path}.expected`),
          `${path}.expected.annual_tax`,
        ),
        biayaJabatan: parseMoney(
          requireKey(expected, "biaya_jabatan", `${path}.expected`),
          `${path}.expected.biaya_jabatan`,
        ),
      },
    };
  }
  throw new InvalidStatutoryTableError(`${path}.operation must be monthly_ter or reconcile.`);
}

export function parseGoldenFile(input: unknown): GoldenFile {
  const record = asRecord(input, "golden");
  rejectUnknown(record, ["description", "cases"], "golden");
  const description = requireKey(record, "description", "golden");
  if (typeof description !== "string" || description.length === 0 || description.length > 240) {
    throw new InvalidStatutoryTableError("golden.description must be a short string.");
  }
  const casesValue = requireKey(record, "cases", "golden");
  if (!Array.isArray(casesValue)) throw new InvalidStatutoryTableError("golden.cases must be an array.");
  const cases: GoldenCase[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < casesValue.length; index += 1) {
    const parsed = parseCase(casesValue[index], index, seenIds);
    if (parsed !== null) cases.push(parsed);
  }
  return { description, cases };
}

/** Checks one verified case against the supplied table. Invented cases must not be marked verified. */
export function assertGoldenCase(table: StatutoryTable, goldenCase: GoldenCase): void {
  if (goldenCase.kind === "monthly_ter") {
    const result = calculateMonthlyPph21({
      payrollDate: goldenCase.payrollDate,
      periodMonth: goldenCase.payrollDate.month,
      table,
      ptkpStatus: goldenCase.ptkpStatus,
      method: goldenCase.method,
      components: goldenCase.components,
    });
    same(goldenCase.id, "tax", goldenCase.expected.tax, result.tax);
    same(goldenCase.id, "tax_allowance", goldenCase.expected.taxAllowance, result.taxAllowance);
    same(goldenCase.id, "employee_withheld", goldenCase.expected.employeeWithheld, result.employeeWithheld);
    same(goldenCase.id, "employer_borne_tax", goldenCase.expected.employerBorneTax, result.employerBorneTax);
    same(goldenCase.id, "grossed_taxable", goldenCase.expected.grossedTaxable, result.grossedTaxable);
    same(goldenCase.id, "grossed_cost", goldenCase.expected.grossedCost, result.grossedCost);
    return;
  }
  const result = reconcilePph21({
    payrollDate: goldenCase.payrollDate,
    reason: goldenCase.reason,
    table,
    ptkpStatus: goldenCase.ptkpStatus,
    activeMonths: goldenCase.activeMonths,
    ytdGrossTaxable: rupiah(goldenCase.ytdGrossTaxable),
    ytdEmployeeJht: rupiah(goldenCase.ytdEmployeeJht),
    ytdEmployeeJp: rupiah(goldenCase.ytdEmployeeJp),
    verifiedZakat: rupiah(goldenCase.verifiedZakat),
    ytdPph21Withheld: rupiah(goldenCase.ytdPph21Withheld),
  });
  same(goldenCase.id, "withholding", goldenCase.expected.withholding, result.withholding);
  same(goldenCase.id, "refund", goldenCase.expected.refund, result.refund);
  same(goldenCase.id, "pkp", goldenCase.expected.pkp, result.pkp);
  same(goldenCase.id, "annual_tax", goldenCase.expected.annualTax, result.annualTax);
  same(goldenCase.id, "biaya_jabatan", goldenCase.expected.biayaJabatan, result.biayaJabatan);
}
