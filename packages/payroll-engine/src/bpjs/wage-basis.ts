import type { Idr } from "@gotonghr/contracts";
import { PayrollInputError } from "../errors.ts";
import { nonNegativeRupiah } from "../money.ts";

export interface ResolvedWage {
  readonly reportedWage: Idr;
  readonly flooredWage: Idr;
}

/**
 * Reported wage, then the branch UMP or UMK when the floor flag is set.
 * Each program applies its own cap after this floor.
 */
export function resolveWageBasis(input: {
  readonly wage: bigint;
  readonly applyWageFloor: boolean;
  readonly umpUmk?: bigint;
}): ResolvedWage {
  if (typeof input.applyWageFloor !== "boolean") {
    throw new PayrollInputError("applyWageFloor must be true or false.");
  }
  const reportedWage = nonNegativeRupiah(input.wage, "wage");
  if (!input.applyWageFloor) {
    return { reportedWage, flooredWage: reportedWage };
  }
  if (input.umpUmk === undefined) {
    throw new PayrollInputError("umpUmk is required when applyWageFloor is true.");
  }
  const floor = nonNegativeRupiah(input.umpUmk, "umpUmk");
  const flooredWage = reportedWage < floor ? floor : reportedWage;
  return { reportedWage, flooredWage };
}
