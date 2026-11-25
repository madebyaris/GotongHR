import type { Idr } from "@gotonghr/contracts";
import { PayrollInputError } from "../errors.ts";
import { rupiah, sumRupiah } from "../money.ts";
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
  readonly jkpEligible?: boolean;
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
 * JKM and JHT use the floored wage. JKK does too.
 * jkpEligible defaults to true. The employer then pays the reduced JKK rate
 * plus jkp.fromJkk, and the government part stays out of employerPayable.
 * jkpEligible false keeps the headline JKK rate and a zero JKP memo.
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
  const jkpEligible = readJkpEligible(input.jkpEligible);
  const { reportedWage, flooredWage } = resolveWageBasis(input);
  const kesehatan = calculateKesehatan(flooredWage, input.additionalFamilyMembers);
  const jht = calculateJht(flooredWage);
  const jkk = calculateJkk(flooredWage, input.jkkRiskClass, jkpEligible);
  const jkm = calculateJkm(flooredWage);
  const jp = calculateJp(flooredWage, input.table);
  const jkp = jkpEligible ? jkpRecomposition(flooredWage) : zeroJkp();
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
      jkp.fromJkk,
    ]),
    employeePayable: sumRupiah([kesehatan.employee, jht.employee, jp.employee]),
  };
}

function readJkpEligible(value: boolean | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") {
    throw new PayrollInputError("jkpEligible must be true or false.");
  }
  return value;
}

function zeroJkp(): JkpRecomposition {
  const zero = rupiah(0n);
  return {
    wageBasis: zero,
    government: zero,
    fromJkk: zero,
    fromJkm: zero,
    total: zero,
  };
}
