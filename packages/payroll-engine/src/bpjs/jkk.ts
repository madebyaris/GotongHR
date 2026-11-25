import type { Idr } from "@gotonghr/contracts";
import { PayrollInputError } from "../errors.ts";
import { nonNegativeRupiah, rupiah } from "../money.ts";
import { bpjsComponent } from "./component.ts";

/** Risk classes 1 to 5. */
export const jkkRiskClasses = [1, 2, 3, 4, 5] as const;

export type JkkRiskClass = (typeof jkkRiskClasses)[number];

/**
 * Headline employer rates per 10_000: 24, 54, 89, 127, and 174.
 * A worker outside JKP pays these rates on the full floored wage.
 */
const JKK_HEADLINE_RATE_PER_SCALE: Readonly<Record<JkkRiskClass, bigint>> = {
  1: 24n,
  2: 54n,
  3: 89n,
  4: 127n,
  5: 174n,
};

/**
 * Employer rates per 10_000 after the JKP from-JKK part leaves this program:
 * 10, 40, 75, 113, and 160.
 * The moved part is remitted separately, and only up to the JKP wage cap.
 */
const JKK_WITH_JKP_RATE_PER_SCALE: Readonly<Record<JkkRiskClass, bigint>> = {
  1: 10n,
  2: 40n,
  3: 75n,
  4: 113n,
  5: 160n,
};

export interface JkkResult {
  readonly riskClass: JkkRiskClass;
  readonly wageBasis: Idr;
  readonly employer: Idr;
  readonly employee: Idr;
}

export function calculateJkk(
  flooredWage: bigint,
  riskClass: number,
  jkpEligible = true,
): JkkResult {
  if (typeof jkpEligible !== "boolean") {
    throw new PayrollInputError("jkpEligible must be true or false.");
  }
  const checked = assertJkkRiskClass(riskClass);
  const wageBasis = nonNegativeRupiah(flooredWage, "wage");
  const rates = jkpEligible ? JKK_WITH_JKP_RATE_PER_SCALE : JKK_HEADLINE_RATE_PER_SCALE;
  return {
    riskClass: checked,
    wageBasis,
    employer: rupiah(bpjsComponent(wageBasis, rates[checked])),
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
