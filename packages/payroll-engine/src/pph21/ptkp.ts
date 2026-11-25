import { ptkpStatuses, type Idr, type PtkpStatus } from "@gotonghr/contracts";
import { MissingStatutoryValueError, PayrollInputError } from "../errors.ts";
import { rupiah } from "../money.ts";
import type { StatutoryTable, TerCategory } from "../tables/types.ts";

/**
 * PTKP status maps to TER category A, B, or C.
 * TER A: TK/0, TK/1, K/0. TER B: TK/2, TK/3, K/1, K/2. TER C: K/3.
 * This map is not a percentage.
 */
const categoryByPtkp = {
  "TK/0": "A",
  "TK/1": "A",
  "K/0": "A",
  "TK/2": "B",
  "TK/3": "B",
  "K/1": "B",
  "K/2": "B",
  "K/3": "C",
} as const satisfies Record<PtkpStatus, TerCategory>;

export function terCategoryForPtkp(status: PtkpStatus): TerCategory {
  if (!ptkpStatuses.includes(status)) {
    throw new PayrollInputError("PTKP status must be TK/0 through K/3.");
  }
  return categoryByPtkp[status];
}

/** Annual PTKP rupiah from the table. A missing amount is not replaced with zero. */
export function annualPtkp(table: StatutoryTable, status: PtkpStatus): Idr {
  terCategoryForPtkp(status);
  const entry = table.ptkpAnnual.amounts[status];
  if (table.ptkpAnnual.source === "missing" || entry.kind !== "present") {
    throw new MissingStatutoryValueError(`ptkp_annual.${status}`);
  }
  return rupiah(entry.rupiah);
}
