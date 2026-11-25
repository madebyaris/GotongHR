import type { Idr } from "@gotonghr/contracts";
import { PayrollInputError } from "../errors.ts";
import { sumRupiah } from "../money.ts";
import { assertReadyForCalculation } from "../tables/select.ts";
import type { StatutoryTable } from "../tables/types.ts";
import { calculateJkk, type JkkResult } from "./jkk.ts";
import { jkpRecomposition, type JkpRecomposition } from "./jkp.ts";
import { calculateJp, calculateJht, calculateJkm, type ContributionResult, type JpResult } from "./ketenagakerjaan.ts";
import { calculateKesehatan, type KesehatanResult } from "./kesehatan.ts";
import { resolveWageBasis } from "./wage-basis.ts";

export interface CalculateBpjsInput {
  readonly wage: bigint;
  readonly additionalFamilyMembers: number;
  readonly applyWageFloor: boolean;
  readonly umpUmk?: bigint;
  readonly jkkRiskClass: number;
  readonly table: StatutoryTable;
  readonly allowUndeclared?: boolean;
}

export interface CalculateBpjsResult {
  readonly reportedWage: Idr;
  readonly flooredWage: Idr;
  readonly kesehatan: KesehatanResult;
  readonly jht: ContributionResult;
  readonly jkk: JkkResult;
  readonly jkm: ContributionResult;
  readonly jp: JpResult;
  readonly jkp: JkpRecomposition;
  readonly employerPayable: Idr;
  readonly employeePayable: Idr;
}

/**
 * BPJS for one wage. Kesehatan is capped at Rp12,000,000 after the UMP or UMK floor.
 * JP reads the table cap and throws MissingStatutoryValueError when that cap is missing.
 * JKK, JKM, JHT, and the JKP memo use the floored wage.
 * Payable totals omit JKP. The employer already remits full JKK and full JKM.
 * A draft table is refused unless allowUndeclared is set.
 */
export function calculateBpjs(input: CalculateBpjsInput): CalculateBpjsResult {
  if (typeof input.table !== "object" || input.table === null) {
    throw new PayrollInputError("table must be a statutory table.");
  }
  assertReadyForCalculation(
    input.table,
    input.allowUndeclared === true ? { allowUndeclared: true } : undefined,
  );
  const { reportedWage, flooredWage } = resolveWageBasis(input);
  const kesehatan = calculateKesehatan(flooredWage, input.additionalFamilyMembers);
  const jht = calculateJht(flooredWage);
  const jkk = calculateJkk(flooredWage, input.jkkRiskClass);
  const jkm = calculateJkm(flooredWage);
  const jp = calculateJp(flooredWage, input.table);
  const jkp = jkpRecomposition(flooredWage);
  return {
    reportedWage,
    flooredWage,
    kesehatan,
    jht,
    jkk,
    jkm,
    jp,
    jkp,
    employerPayable: sumRupiah([
      kesehatan.employer,
      jht.employer,
      jkk.employer,
      jkm.employer,
      jp.employer,
    ]),
    employeePayable: sumRupiah([kesehatan.employee, jht.employee, jp.employee]),
  };
}
