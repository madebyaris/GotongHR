import type { Idr } from "@gotonghr/contracts";
import { PayrollInputError } from "../errors.ts";
import { nonNegativeRupiah, rupiah } from "../money.ts";
import { jpAnnualWageCap } from "../tables/caps.ts";
import type { StatutoryTable } from "../tables/types.ts";
import { bpjsComponent } from "./component.ts";

const JHT_EMPLOYER_RATE = 370n;
const JHT_EMPLOYEE_RATE = 200n;
const JKM_EMPLOYER_RATE = 30n;
const JP_EMPLOYER_RATE = 200n;
const JP_EMPLOYEE_RATE = 100n;

export interface ContributionResult {
  readonly wageBasis: Idr;
  readonly employer: Idr;
  readonly employee: Idr;
}

export interface JpResult extends ContributionResult {
  readonly monthlyWageCap: Idr;
}

/** JHT is 3.7 percent employer and 2 percent employee, on the floored wage. */
export function calculateJht(flooredWage: bigint): ContributionResult {
  const wageBasis = nonNegativeRupiah(flooredWage, "wage");
  return {
    wageBasis,
    employer: rupiah(bpjsComponent(wageBasis, JHT_EMPLOYER_RATE)),
    employee: rupiah(bpjsComponent(wageBasis, JHT_EMPLOYEE_RATE)),
  };
}

/** JKM is 0.3 percent employer. The employee pays nothing. */
export function calculateJkm(flooredWage: bigint): ContributionResult {
  const wageBasis = nonNegativeRupiah(flooredWage, "wage");
  return {
    wageBasis,
    employer: rupiah(bpjsComponent(wageBasis, JKM_EMPLOYER_RATE)),
    employee: rupiah(0n),
  };
}

/**
 * JP is 2 percent employer and 1 percent employee.
 * The monthly ceiling is the table's annual cap divided by 12.
 * The annual cap must divide evenly by 12, so the ceiling needs no rounding.
 * A missing cap throws MissingStatutoryValueError. This function does not guess one.
 */
export function calculateJp(flooredWage: bigint, table: StatutoryTable): JpResult {
  const wage = nonNegativeRupiah(flooredWage, "wage");
  const annual = jpAnnualWageCap(table);
  if (annual < 0n) {
    throw new PayrollInputError("jp_annual_wage_cap cannot be negative.");
  }
  if (annual % 12n !== 0n) {
    throw new PayrollInputError(
      "jp_annual_wage_cap must divide evenly by 12 so the monthly JP ceiling is exact rupiah.",
    );
  }
  const monthlyWageCap = annual / 12n;
  const wageBasis = wage > monthlyWageCap ? monthlyWageCap : wage;
  return {
    wageBasis: rupiah(wageBasis),
    monthlyWageCap: rupiah(monthlyWageCap),
    employer: rupiah(bpjsComponent(wageBasis, JP_EMPLOYER_RATE)),
    employee: rupiah(bpjsComponent(wageBasis, JP_EMPLOYEE_RATE)),
  };
}
