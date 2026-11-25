import type { Idr } from "@gotonghr/contracts";
import { PayrollInputError } from "../errors.ts";
import { applyScaledRate, rupiah } from "../money.ts";
import { assertReadyForCalculation, type CalculationTableOptions } from "../tables/select.ts";
import type { StatutoryTable } from "../tables/types.ts";

/**
 * Biaya jabatan is the table rate of YTD gross, floored to a rupiah, then capped
 * at monthly_cap times active months.
 * A draft table is refused unless allowUndeclared is set.
 */
export function biayaJabatan(
  table: StatutoryTable,
  ytdGrossTaxable: bigint,
  activeMonths: number,
  options?: CalculationTableOptions,
): Idr {
  if (typeof ytdGrossTaxable !== "bigint" || ytdGrossTaxable < 0n) {
    throw new PayrollInputError("ytdGrossTaxable must be non-negative bigint rupiah.");
  }
  if (!Number.isInteger(activeMonths) || activeMonths < 1 || activeMonths > 12) {
    throw new PayrollInputError("activeMonths must be an integer from 1 to 12.");
  }
  assertReadyForCalculation(table, options);
  const rule = table.biayaJabatan;
  const raw = applyScaledRate(ytdGrossTaxable, rule.ratePerScale, rule.rateScale, rule.rounding);
  const cap = rule.monthlyCap * BigInt(activeMonths);
  return rupiah(raw < cap ? raw : cap);
}
