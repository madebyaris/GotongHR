import { ptkpStatuses } from "@gotonghr/contracts";
import { civilDate, civilDateToIso, type CivilDate } from "../civil-date.ts";
import { PayrollInputError } from "../errors.ts";
import { terCategories, type StatutoryTable } from "./types.ts";

export function assertTableCovers(table: StatutoryTable, payrollDate: CivilDate): void {
  const date = civilDate(payrollDate.year, payrollDate.month, payrollDate.day);
  const iso = civilDateToIso(date);
  if (iso < table.effectiveFrom || iso > table.effectiveTo) {
    throw new PayrollInputError(`Statutory table does not cover ${iso}.`);
  }
}

export interface CalculationTableOptions {
  readonly allowUndeclared?: boolean;
}

/**
 * A draft table is for inspection. Payroll math uses it only when the caller opts in.
 * Published fixtures stay usable so tests can run a labeled stand-in.
 */
export function assertReadyForCalculation(
  table: StatutoryTable,
  options?: CalculationTableOptions,
): void {
  if (table.status !== "draft" || options?.allowUndeclared === true) return;
  throw new PayrollInputError(
    "A draft statutory table is not used for calculation. Pass allowUndeclared to calculate with it.",
  );
}

/** Picks the single table whose effective window contains the injected date. */
export function findTableForDate(
  tables: readonly StatutoryTable[],
  payrollDate: CivilDate,
  options?: CalculationTableOptions,
): StatutoryTable {
  if (!Array.isArray(tables)) {
    throw new PayrollInputError("Statutory tables must be an array.");
  }
  const iso = civilDateToIso(payrollDate);
  const matches = tables.filter((table) => table.effectiveFrom <= iso && iso <= table.effectiveTo);
  const match = matches[0];
  if (match === undefined) throw new PayrollInputError(`No statutory table covers ${iso}.`);
  if (matches.length > 1) throw new PayrollInputError(`Overlapping statutory tables cover ${iso}.`);
  assertReadyForCalculation(match, options);
  return match;
}

/**
 * Copies the table status onto a calculation result.
 * tableUndeclared is false only for a published non-fixture table with every amount present.
 */
export function calculationProvenance(table: StatutoryTable): {
  readonly tableStatus: StatutoryTable["status"];
  readonly tableUndeclared: boolean;
} {
  return {
    tableStatus: table.status,
    tableUndeclared: !isStatutoryDeclared(table),
  };
}

/**
 * True only for a published non-fixture table whose TER rates, PTKP amounts, and JP cap are present.
 * Draft files and synthetic fixtures stay false so golden checks do not treat them as the law.
 */
export function isStatutoryDeclared(table: StatutoryTable): boolean {
  if (table.fixture === "synthetic" || table.status !== "published") return false;
  if (table.ter.source === "missing" || table.ptkpAnnual.source === "missing") return false;
  if (table.jpAnnualWageCap.kind !== "present") return false;
  for (const category of terCategories) {
    if (table.ter.categories[category].kind !== "present") return false;
  }
  for (const status of ptkpStatuses) {
    if (table.ptkpAnnual.amounts[status].kind !== "present") return false;
  }
  return true;
}
