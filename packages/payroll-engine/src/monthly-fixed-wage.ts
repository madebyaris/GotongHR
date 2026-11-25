import type { Idr } from "@gotonghr/contracts";
import { nonNegativeRupiah, sumRupiah } from "./money.ts";

/** Base salary plus fixed allowances. Both must be non-negative bigint rupiah. */
export function monthlyFixedWage(baseSalary: bigint, fixedAllowances: bigint): Idr {
  return sumRupiah([
    nonNegativeRupiah(baseSalary, "baseSalary"),
    nonNegativeRupiah(fixedAllowances, "fixedAllowances"),
  ]);
}
