import type { Idr } from "@gotonghr/contracts";
import { PayrollInputError } from "../errors.ts";
import { rupiah } from "../money.ts";
import type { StatutoryTable } from "../tables/types.ts";

/** PKP is rounded down to the nearest Rp1,000 before Pasal 17. */
export function roundPkpDown(amount: bigint): bigint {
  if (typeof amount !== "bigint" || amount < 0n) {
    throw new PayrollInputError("PKP must be non-negative bigint rupiah.");
  }
  return amount - (amount % 1000n);
}

/**
 * Progressive Pasal 17 tax on a PKP that is already a multiple of Rp1,000.
 * Each slice uses exact integer division. A remainder is an error, not a float.
 */
export function pasal17Tax(table: StatutoryTable, pkp: bigint): Idr {
  if (typeof pkp !== "bigint" || pkp < 0n) {
    throw new PayrollInputError("PKP must be non-negative bigint rupiah.");
  }
  if (pkp % 1000n !== 0n) {
    throw new PayrollInputError("PKP must already be rounded down to Rp1,000.");
  }
  const bands = table.pasal17.bands;
  const last = bands[bands.length - 1];
  if (last === undefined || last.upTo !== null) {
    throw new PayrollInputError("Pasal 17 bands must be non-empty and end with an open band.");
  }
  let tax = 0n;
  let lower = 0n;
  for (const band of table.pasal17.bands) {
    if (pkp <= lower) break;
    const upper = band.upTo ?? pkp;
    const taxedUpTo = pkp < upper ? pkp : upper;
    const width = taxedUpTo - lower;
    if (width > 0n) {
      const product = width * band.ratePerScale;
      if (product % band.rateScale !== 0n) {
        throw new PayrollInputError("Pasal 17 tax is not an exact rupiah amount.");
      }
      tax += product / band.rateScale;
    }
    if (band.upTo === null || pkp <= band.upTo) break;
    lower = band.upTo;
  }
  return rupiah(tax);
}
