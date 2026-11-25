import type { Idr } from "@gotonghr/contracts";
import { nonNegativeRupiah, sumRupiah } from "../money.ts";

/** Monthly TER base. Employee JHT and JP are not part of this sum. */
export interface GrossTaxableComponents {
  readonly baseSalary: Idr;
  readonly fixedAllowances: Idr;
  readonly overtime: Idr;
  readonly bonusOrThr: Idr;
  readonly employerJkk: Idr;
  readonly employerJkm: Idr;
  readonly employerBpjsKesehatan: Idr;
}

export function grossTaxableOf(components: GrossTaxableComponents): Idr {
  return sumRupiah([
    nonNegativeRupiah(components.baseSalary, "baseSalary"),
    nonNegativeRupiah(components.fixedAllowances, "fixedAllowances"),
    nonNegativeRupiah(components.overtime, "overtime"),
    nonNegativeRupiah(components.bonusOrThr, "bonusOrThr"),
    nonNegativeRupiah(components.employerJkk, "employerJkk"),
    nonNegativeRupiah(components.employerJkm, "employerJkm"),
    nonNegativeRupiah(components.employerBpjsKesehatan, "employerBpjsKesehatan"),
  ]);
}
