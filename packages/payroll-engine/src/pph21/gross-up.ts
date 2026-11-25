import { GrossUpDidNotConvergeError } from "../errors.ts";
import { applyScaledRate, type RateRounding } from "../money.ts";
import type { TerRate } from "./ter.ts";

/** The plan caps the fixed-point search at 10 iterations. */
export const GROSS_UP_MAX_ITERATIONS = 10;

export interface GrossUpSolution {
  readonly allowance: bigint;
  readonly tax: bigint;
  readonly iterations: number;
}

function gap(left: bigint, right: bigint): bigint {
  return left >= right ? left - right : right - left;
}

function closedFormAllowance(gross: bigint, rate: TerRate, rounding: RateRounding): bigint {
  if (rate.ratePerScale <= 0n) return 0n;
  if (rate.ratePerScale >= rate.rateScale) throw new GrossUpDidNotConvergeError();
  return applyScaledRate(gross, rate.ratePerScale, rate.rateScale - rate.ratePerScale, rounding);
}

/**
 * Gross-up and nett share this fixed point.
 * The allowance stays within Rp1 of the tax on gross taxable plus that allowance.
 * Each step uses the rate of the current base, then jumps with that rate's closed form.
 * The search stops after 10 iterations.
 */
export function solveGrossUp(
  gross: bigint,
  rounding: RateRounding,
  rateAt: (base: bigint) => TerRate,
): GrossUpSolution {
  let allowance = 0n;
  const seen = new Set<string>();
  for (let iteration = 1; iteration <= GROSS_UP_MAX_ITERATIONS; iteration += 1) {
    const rate = rateAt(gross + allowance);
    const tax = applyScaledRate(gross + allowance, rate.ratePerScale, rate.rateScale, rounding);
    if (gap(allowance, tax) <= 1n) {
      return { allowance, tax, iterations: iteration };
    }
    const center = closedFormAllowance(gross, rate, rounding);
    let chosen = center;
    for (const delta of [0n, -1n, 1n, -2n, 2n]) {
      const candidate = center + delta;
      if (candidate < 0n) continue;
      const candidateRate = rateAt(gross + candidate);
      if (
        candidateRate.ratePerScale !== rate.ratePerScale ||
        candidateRate.rateScale !== rate.rateScale
      ) {
        continue;
      }
      const candidateTax = applyScaledRate(
        gross + candidate,
        rate.ratePerScale,
        rate.rateScale,
        rounding,
      );
      if (gap(candidate, candidateTax) <= 1n) {
        chosen = candidate;
        break;
      }
    }
    const key = chosen.toString();
    if (seen.has(key)) throw new GrossUpDidNotConvergeError();
    seen.add(key);
    allowance = chosen;
  }
  throw new GrossUpDidNotConvergeError();
}
