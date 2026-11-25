import type { Idr } from "@gotonghr/contracts";
import { nonNegativeRupiah, rupiah } from "../money.ts";
import { bpjsComponent } from "./component.ts";

/**
 * JKP recomposition from the architecture spec: 0.46 percent of the floored wage.
 * The parts are 0.22 percent from the central government, 0.14 percent from JKK,
 * and 0.10 percent from JKM. A regulation change to this split stays in this file.
 * Each part rounds half up. The total is the sum of those parts, so the parts add up.
 * This amount is a memo. It is not added to the employer or employee payable totals.
 * The employer still remits the full JKK risk rate and the full JKM rate.
 * The spec states no separate JKP wage cap, so the floored wage is used in full.
 */
export const jkpRecompositionParts = {
  governmentPerScale: 22n,
  fromJkkPerScale: 14n,
  fromJkmPerScale: 10n,
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
  const wageBasis = nonNegativeRupiah(flooredWage, "wage");
  const government = bpjsComponent(wageBasis, jkpRecompositionParts.governmentPerScale);
  const fromJkk = bpjsComponent(wageBasis, jkpRecompositionParts.fromJkkPerScale);
  const fromJkm = bpjsComponent(wageBasis, jkpRecompositionParts.fromJkmPerScale);
  return {
    wageBasis,
    government: rupiah(government),
    fromJkk: rupiah(fromJkk),
    fromJkm: rupiah(fromJkm),
    total: rupiah(government + fromJkk + fromJkm),
  };
}
