import type { Idr } from "@gotonghr/contracts";
import { PayrollInputError } from "../errors.ts";
import { nonNegativeRupiah, rupiah } from "../money.ts";
import { bpjsComponent } from "./component.ts";

/** PP 44/2015 risk classes, as the architecture spec lists them. */
export const jkkRiskClasses = [1, 2, 3, 4, 5] as const;

export type JkkRiskClass = (typeof jkkRiskClasses)[number];

const JKK_RATE_PER_SCALE: Readonly<Record<JkkRiskClass, bigint>> = {
  1: 24n,
  2: 54n,
  3: 89n,
  4: 127n,
  5: 174n,
};

export interface JkkResult {
  readonly riskClass: JkkRiskClass;
  readonly wageBasis: Idr;
  readonly employer: Idr;
  readonly employee: Idr;
}

export function calculateJkk(flooredWage: bigint, riskClass: number): JkkResult {
  const checked = assertJkkRiskClass(riskClass);
  const wageBasis = nonNegativeRupiah(flooredWage, "wage");
  return {
    riskClass: checked,
    wageBasis,
    employer: rupiah(bpjsComponent(wageBasis, JKK_RATE_PER_SCALE[checked])),
    employee: rupiah(0n),
  };
}

function assertJkkRiskClass(riskClass: number): JkkRiskClass {
  switch (riskClass) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
      return riskClass;
    default:
      throw new PayrollInputError("jkkRiskClass must be 1, 2, 3, 4, or 5.");
  }
}
