import type { Idr } from "@gotonghr/contracts";
import { monthlyFixedWage } from "../monthly-fixed-wage.ts";
import { rupiah } from "../money.ts";
import { wholeCount } from "../whole-count.ts";

export interface PkwtCompensationInput {
  readonly completedMonths: number;
  readonly baseSalary: bigint;
  readonly fixedAllowances: bigint;
}

/**
 * Uang kompensasi PKWT. Pesangon, UPMK, and UPH are Phase 2 and are not exported.
 * floor(completedMonths / 12 * (base + fixed allowances)), for one completed month or more.
 * A contract longer than 12 months keeps growing. Twenty-four months pays two months of wage.
 * Completed months below 1 throw PayrollInputError. Compensation starts at one month.
 */
export function calculatePkwtCompensation(input: PkwtCompensationInput): Idr {
  const months = wholeCount(input.completedMonths, "completedMonths", 1);
  const wage = monthlyFixedWage(input.baseSalary, input.fixedAllowances);
  return rupiah((wage * BigInt(months)) / 12n);
}
