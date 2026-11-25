import type { Idr } from "@gotonghr/contracts";
import { MissingStatutoryValueError, PayrollInputError } from "../errors.ts";
import { applyScaledRate, rupiah } from "../money.ts";
import type { StatutoryTable, TerCategory } from "../tables/types.ts";

export interface TerRate {
  readonly ratePerScale: bigint;
  readonly rateScale: bigint;
}

function assertGross(grossTaxable: bigint): void {
  if (typeof grossTaxable !== "bigint" || grossTaxable < 0n) {
    throw new PayrollInputError("grossTaxable must be non-negative bigint rupiah.");
  }
}

/** Looks up the TER rate for one category. Missing brackets throw. */
export function terRate(
  table: StatutoryTable,
  category: TerCategory,
  grossTaxable: bigint,
): TerRate {
  assertGross(grossTaxable);
  const entry = table.ter.categories[category];
  if (table.ter.source === "missing" || entry.kind !== "present") {
    throw new MissingStatutoryValueError(`ter.${category}`);
  }
  for (const bracket of entry.brackets) {
    if (bracket.upTo === null || grossTaxable <= bracket.upTo) {
      return { ratePerScale: bracket.ratePerScale, rateScale: table.ter.rateScale };
    }
  }
  throw new PayrollInputError("No TER bracket covers this gross taxable.");
}

/** TER tax for one month: rate(category, gross) applied to the whole gross, table rounding. */
export function terTax(table: StatutoryTable, category: TerCategory, grossTaxable: bigint): Idr {
  const rate = terRate(table, category, grossTaxable);
  return rupiah(
    applyScaledRate(grossTaxable, rate.ratePerScale, rate.rateScale, table.ter.taxRounding),
  );
}
