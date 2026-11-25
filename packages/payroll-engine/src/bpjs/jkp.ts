import type { Idr } from "@gotonghr/contracts";
import { nonNegativeRupiah, rupiah } from "../money.ts";
import { bpjsComponent } from "./component.ts";

/**
 * JKP memo under PP 6/2025. The total is 0.36 percent of the capped wage.
 * The parts are 0.22 percent from the central government and 0.14 percent recomposed from JKK.
 * JKM is no longer recomposed, so that part is zero.
 * A regulation change to this split or this cap stays in this file.
 * Each part rounds half up. The total is the sum of those parts, so the parts add up.
 * This amount is a memo. It is not added to the employer or employee payable totals.
 * The employer still remits the full JKK risk rate and the full JKM rate.
 */
export const JKP_WAGE_CAP = 5_000_000n;

export const jkpRecompositionParts = {
  governmentPerScale: 22n,
  fromJkkPerScale: 14n,
  fromJkmPerScale: 0n,
  rateScale: 10_000n,
} as const;

export interface JkpRecomposition {
  readonly wageBasis: Idr;
  readonly government: Idr;
  readonly fromJkk: Idr;
  readonly fromJkm: Idr;
  readonly total: Idr;
}

export function jkpRecomposition(flooredWage: bigint): JkpRecomposition {
  const wage = nonNegativeRupiah(flooredWage, "wage");
  const wageBasis = wage > JKP_WAGE_CAP ? JKP_WAGE_CAP : wage;
  const government = bpjsComponent(wageBasis, jkpRecompositionParts.governmentPerScale);
  const fromJkk = bpjsComponent(wageBasis, jkpRecompositionParts.fromJkkPerScale);
  const fromJkm = bpjsComponent(wageBasis, jkpRecompositionParts.fromJkmPerScale);
  return {
    wageBasis: rupiah(wageBasis),
    government: rupiah(government),
    fromJkk: rupiah(fromJkk),
    fromJkm: rupiah(fromJkm),
    total: rupiah(government + fromJkk + fromJkm),
  };
}
