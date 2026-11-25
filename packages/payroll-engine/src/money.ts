import { idr, type Idr } from "@gotonghr/contracts";
import { PayrollInputError } from "./errors.ts";

export type RateRounding = "half_up" | "floor";

/** Brands a bigint as rupiah. Calculation inputs must already be integers. */
export function rupiah(value: bigint): Idr {
  if (typeof value !== "bigint") {
    throw new TypeError("IDR values are bigint rupiah.");
  }
  return idr(value);
}

export function nonNegativeRupiah(value: bigint, label: string): Idr {
  if (typeof value !== "bigint") {
    throw new TypeError(`${label} must be bigint rupiah.`);
  }
  if (value < 0n) {
    throw new PayrollInputError(`${label} cannot be negative.`);
  }
  return idr(value);
}

export function sumRupiah(values: readonly bigint[]): Idr {
  let total = 0n;
  for (const value of values) {
    if (typeof value !== "bigint") {
      throw new TypeError("IDR values are bigint rupiah.");
    }
    total += value;
  }
  return idr(total);
}

/**
 * Multiplies rupiah by ratePerScale / rateScale.
 * half_up rounds a half rupiah away from zero. floor drops the fractional rupiah.
 * Both paths use integer division only.
 */
export function applyScaledRate(
  amount: bigint,
  ratePerScale: bigint,
  rateScale: bigint,
  rounding: RateRounding,
): bigint {
  if (typeof amount !== "bigint" || amount < 0n) {
    throw new PayrollInputError("A rate applies only to non-negative rupiah.");
  }
  if (rounding !== "floor" && rounding !== "half_up") {
    throw new PayrollInputError('rounding must be "floor" or "half_up".');
  }
  if (
    typeof ratePerScale !== "bigint" ||
    ratePerScale < 0n ||
    typeof rateScale !== "bigint" ||
    rateScale <= 0n
  ) {
    throw new PayrollInputError(
      "ratePerScale must be a non-negative integer and rateScale must be a positive integer.",
    );
  }
  const product = amount * ratePerScale;
  if (rounding === "floor") return product / rateScale;
  const quotient = product / rateScale;
  const remainder = product % rateScale;
  if (remainder * 2n >= rateScale) return quotient + 1n;
  return quotient;
}
