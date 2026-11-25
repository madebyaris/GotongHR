import type { Idr } from "@gotonghr/contracts";
import { nonNegativeRupiah, rupiah, sumRupiah } from "../money.ts";
import { wholeCount } from "../whole-count.ts";

export interface ThrInput {
  readonly tenureMonths: number;
  readonly baseSalary: bigint;
  readonly fixedAllowances: bigint;
}

/**
 * THR on base salary plus fixed allowances.
 * Twelve months or more pays that sum once. Twenty-four months still pays one month.
 * One to eleven months pays floor(months / 12 * that sum), by integer division.
 * Less than one month pays 0. THR starts at the first full month.
 * A negative tenure or a fractional tenure throws PayrollInputError.
 */
export function calculateThr(input: ThrInput): Idr {
  const months = wholeCount(input.tenureMonths, "tenureMonths", 0);
  const wage = monthlyFixedWage(input.baseSalary, input.fixedAllowances);
  if (months < 1) return rupiah(0n);
  if (months >= 12) return wage;
  return rupiah((wage * BigInt(months)) / 12n);
}

function monthlyFixedWage(baseSalary: bigint, fixedAllowances: bigint): Idr {
  return sumRupiah([
    nonNegativeRupiah(baseSalary, "baseSalary"),
    nonNegativeRupiah(fixedAllowances, "fixedAllowances"),
  ]);
}
