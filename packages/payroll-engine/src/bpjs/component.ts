import { applyScaledRate } from "../money.ts";

/**
 * BPJS rates are parts per 10_000. 400 is 4 percent.
 * Each component rounds half up to the nearest rupiah.
 */
export const BPJS_RATE_SCALE = 10_000n;

export function bpjsComponent(wageBasis: bigint, ratePerScale: bigint): bigint {
  return applyScaledRate(wageBasis, ratePerScale, BPJS_RATE_SCALE, "half_up");
}
