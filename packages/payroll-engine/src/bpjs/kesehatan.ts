import type { Idr } from "@gotonghr/contracts";
import { nonNegativeRupiah, rupiah } from "../money.ts";
import { wholeCount } from "../whole-count.ts";
import { bpjsComponent } from "./component.ts";

/** Architecture spec: the BPJS Kesehatan wage cap is Rp12,000,000 a month. */
export const KESEHATAN_WAGE_CAP = 12_000_000n;

const EMPLOYER_RATE = 400n;
const EMPLOYEE_RATE = 100n;
const FAMILY_MEMBER_RATE = 100n;

export interface KesehatanResult {
  readonly wageBasis: Idr;
  readonly programEmployer: Idr;
  readonly additionalFamilyEmployer: Idr;
  readonly additionalFamilyMembers: number;
  readonly employer: Idr;
  readonly employee: Idr;
}

/**
 * BPJS Kesehatan. The employer pays 4 percent and the employee pays 1 percent.
 * The wage cap is applied after the UMP or UMK floor.
 * Each additional family member adds 1 percent on the employer side of that capped wage.
 * The 1 percent rounds half up per member, then the member count multiplies it.
 */
export function calculateKesehatan(
  flooredWage: bigint,
  additionalFamilyMembers: number,
): KesehatanResult {
  const members = wholeCount(additionalFamilyMembers, "additionalFamilyMembers", 0);
  const wage = nonNegativeRupiah(flooredWage, "wage");
  const wageBasis = wage > KESEHATAN_WAGE_CAP ? KESEHATAN_WAGE_CAP : wage;
  const programEmployer = bpjsComponent(wageBasis, EMPLOYER_RATE);
  const perMember = bpjsComponent(wageBasis, FAMILY_MEMBER_RATE);
  const additionalFamilyEmployer = perMember * BigInt(members);
  return {
    wageBasis: rupiah(wageBasis),
    programEmployer: rupiah(programEmployer),
    additionalFamilyEmployer: rupiah(additionalFamilyEmployer),
    additionalFamilyMembers: members,
    employer: rupiah(programEmployer + additionalFamilyEmployer),
    employee: rupiah(bpjsComponent(wageBasis, EMPLOYEE_RATE)),
  };
}
