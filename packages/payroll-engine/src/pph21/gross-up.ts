import { GrossUpDidNotConvergeError } from "../errors.ts";
import { applyScaledRate, type RateRounding } from "../money.ts";
import { MAX_TER_BRACKETS } from "../tables/limits.ts";
import type { TerRate } from "./ter.ts";

/**
 * One step per TER bracket the loader accepts.
 * Ordinary tables finish in a handful of steps. The plan's 10-step figure is that
 * ordinary target, not a cap that would reject a valid 80-bracket monotone schedule.
 */
export const GROSS_UP_MAX_ITERATIONS = MAX_TER_BRACKETS;

export interface GrossUpSolution {
  readonly allowance: bigint;
  readonly tax: bigint;
  readonly iterations: number;
}

function gap(left: bigint, right: bigint): bigint {
  return left >= right ? left - right : right - left;
}

function didNotConverge(message: string): never {
  throw new GrossUpDidNotConvergeError(message);
}

function closedFormAllowance(gross: bigint, rate: TerRate, rounding: RateRounding): bigint {
  if (rate.ratePerScale <= 0n) return 0n;
  if (rate.ratePerScale >= rate.rateScale) {
    didNotConverge("Gross-up cannot converge when ratePerScale is not below rateScale.");
  }
  return applyScaledRate(gross, rate.ratePerScale, rate.rateScale - rate.ratePerScale, rounding);
}

/**
 * Gross-up and nett share this fixed point.
 * The allowance stays within Rp1 of the tax on gross taxable plus that allowance.
 * Each step uses the rate of the current base, then jumps with that rate's closed form.
 * A candidate that already matches is returned on that same step, including the last one.
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
    let chosenTax: bigint | null = null;
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
        chosenTax = candidateTax;
        break;
      }
    }
    if (chosenTax !== null) {
      return { allowance: chosen, tax: chosenTax, iterations: iteration };
    }
    const key = chosen.toString();
    if (seen.has(key)) {
      didNotConverge(
        `Gross-up repeated an allowance within ${GROSS_UP_MAX_ITERATIONS} iterations.`,
      );
    }
    seen.add(key);
    allowance = chosen;
  }
  const finalRate = rateAt(gross + allowance);
  const finalTax = applyScaledRate(
    gross + allowance,
    finalRate.ratePerScale,
    finalRate.rateScale,
    rounding,
  );
  if (gap(allowance, finalTax) <= 1n) {
    return { allowance, tax: finalTax, iterations: GROSS_UP_MAX_ITERATIONS };
  }
  didNotConverge(`Gross-up did not converge within ${GROSS_UP_MAX_ITERATIONS} iterations.`);
}
