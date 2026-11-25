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

/** Picks the single table whose effective window contains the injected date. */
export function findTableForDate(
  tables: readonly StatutoryTable[],
  payrollDate: CivilDate,
): StatutoryTable {
  if (!Array.isArray(tables)) {
    throw new PayrollInputError("Statutory tables must be an array.");
  }
  const iso = civilDateToIso(payrollDate);
  const matches = tables.filter((table) => table.effectiveFrom <= iso && iso <= table.effectiveTo);
  const match = matches[0];
  if (match === undefined) throw new PayrollInputError(`No statutory table covers ${iso}.`);
  if (matches.length > 1) throw new PayrollInputError(`Overlapping statutory tables cover ${iso}.`);
  return match;
}

/**
 * True only for a published non-fixture table whose TER rates and PTKP amounts are present.
 * Draft files and synthetic fixtures stay false so golden checks do not treat them as the law.
 */
export function isStatutoryDeclared(table: StatutoryTable): boolean {
  if (table.fixture === "synthetic" || table.status !== "published") return false;
  if (table.ter.source === "missing" || table.ptkpAnnual.source === "missing") return false;
  for (const category of terCategories) {
    const entry = table.ter.categories[category];
    if (entry.source === "missing" || entry.brackets === null) return false;
  }
  for (const status of ptkpStatuses) {
    const amount = table.ptkpAnnual.amounts[status];
    if (amount.source === "missing" || amount.rupiah === null) return false;
  }
  return true;
}
