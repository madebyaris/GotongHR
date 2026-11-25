import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import {
  JKP_WAGE_CAP,
  KESEHATAN_WAGE_CAP,
  MissingStatutoryValueError,
  PayrollInputError,
  applyScaledRate,
  calculateBpjs,
  calculateKesehatan,
  jkkRiskClasses,
  jkpRecomposition,
  jkpRecompositionParts,
  type CalculateBpjsInput,
} from "../index.ts";
import { id2026DraftTable } from "../tables/draft-2026.ts";
import { withJpAnnualCap } from "./fixture-table.ts";

const bpjsDir = fileURLToPath(new URL("../bpjs/", import.meta.url));
const monthlyCap = 10_000_000n;
const capTable = withJpAnnualCap("120000000");

function bpjs(overrides: Partial<CalculateBpjsInput> & Pick<CalculateBpjsInput, "wage">) {
  return calculateBpjs({
    additionalFamilyMembers: 0,
    applyWageFloor: false,
    jkkRiskClass: 1,
    table: capTable,
    ...overrides,
  });
}

test("Kesehatan is 4 percent employer and 1 percent employee under the cap", () => {
  const result = bpjs({ wage: 10_000_000n });
  assert.equal(result.kesehatan.wageBasis, 10_000_000n);
  assert.equal(result.kesehatan.programEmployer, 400_000n);
  assert.equal(result.kesehatan.additionalFamilyEmployee, 0n);
  assert.equal(result.kesehatan.employer, 400_000n);
  assert.equal(result.kesehatan.employee, 100_000n);
  assert.equal(result.flooredWage, 10_000_000n);
});

test("Kesehatan wage cap is Rp12,000,000 and the next rupiah stays capped", () => {
  assert.equal(KESEHATAN_WAGE_CAP, 12_000_000n);
  const atCap = bpjs({ wage: 12_000_000n });
  const overCap = bpjs({ wage: 12_000_001n });
  assert.equal(atCap.kesehatan.wageBasis, 12_000_000n);
  assert.equal(overCap.kesehatan.wageBasis, 12_000_000n);
  assert.equal(atCap.kesehatan.programEmployer, 480_000n);
  assert.equal(overCap.kesehatan.programEmployer, 480_000n);
  assert.equal(atCap.kesehatan.employee, 120_000n);
  assert.equal(overCap.kesehatan.employee, 120_000n);
  assert.equal(overCap.jht.wageBasis, 12_000_001n);
  assert.equal(overCap.jkk.wageBasis, 12_000_001n);
});

test("each additional family member is 1 percent employee, rounded half up", () => {
  const plain = calculateKesehatan(50n, 0);
  assert.equal(plain.employee, 1n);
  assert.equal(plain.additionalFamilyEmployee, 0n);
  assert.equal(calculateKesehatan(49n, 0).employee, 0n);
  const family = calculateKesehatan(50n, 3);
  assert.equal(family.additionalFamilyMembers, 3);
  assert.equal(family.additionalFamilyEmployee, 3n);
  assert.equal(family.programEmployer, 2n);
  assert.equal(family.employer, 2n);
  assert.equal(family.employee, 4n);

  const capped = bpjs({ wage: 15_000_000n, additionalFamilyMembers: 2 });
  assert.equal(capped.kesehatan.wageBasis, 12_000_000n);
  assert.equal(capped.kesehatan.programEmployer, 480_000n);
  assert.equal(capped.kesehatan.additionalFamilyEmployee, 240_000n);
  assert.equal(capped.kesehatan.employer, 480_000n);
  assert.equal(capped.kesehatan.employee, 360_000n);
});

test("BPJS component rounding is half up to the nearest rupiah", () => {
  const down = bpjs({ wage: 12n });
  const up = bpjs({ wage: 13n });
  assert.equal(down.kesehatan.programEmployer, 0n);
  assert.equal(up.kesehatan.programEmployer, 1n);
  assert.equal(up.kesehatan.employee, 0n);
  assert.equal(down.jht.employer, 0n);
});

test("the wage floor uses branch UMP or UMK only when the flag is set", () => {
  const floored = bpjs({ wage: 4_999_999n, applyWageFloor: true, umpUmk: 5_000_000n });
  assert.equal(floored.reportedWage, 4_999_999n);
  assert.equal(floored.flooredWage, 5_000_000n);
  assert.equal(floored.jht.wageBasis, 5_000_000n);
  assert.equal(floored.kesehatan.wageBasis, 5_000_000n);

  const equal = bpjs({ wage: 5_000_000n, applyWageFloor: true, umpUmk: 5_000_000n });
  assert.equal(equal.flooredWage, 5_000_000n);

  const above = bpjs({ wage: 6_000_000n, applyWageFloor: true, umpUmk: 5_000_000n });
  assert.equal(above.flooredWage, 6_000_000n);

  const ignored = bpjs({ wage: 4_999_999n, applyWageFloor: false, umpUmk: 5_000_000n });
  assert.equal(ignored.flooredWage, 4_999_999n);
  assert.equal(ignored.kesehatan.wageBasis, 4_999_999n);
});

test("a floor above the Kesehatan cap still caps Kesehatan and leaves JHT on the floor", () => {
  const result = bpjs({
    wage: 1_000_000n,
    applyWageFloor: true,
    umpUmk: 13_000_000n,
    jkkRiskClass: 5,
    table: withJpAnnualCap("240000000"),
  });
  assert.equal(result.flooredWage, 13_000_000n);
  assert.equal(result.kesehatan.wageBasis, 12_000_000n);
  assert.equal(result.kesehatan.programEmployer, 480_000n);
  assert.equal(result.jht.wageBasis, 13_000_000n);
  assert.equal(result.jht.employer, 481_000n);
  assert.equal(result.jp.wageBasis, 13_000_000n);
  assert.equal(result.jp.monthlyWageCap, 20_000_000n);
  assert.equal(result.jkk.employer, 226_200n);
});

test("JHT is 3.7 and 2 percent, and JKM is 0.3 percent employer", () => {
  const result = bpjs({ wage: 10_000_000n });
  assert.equal(result.jht.employer, 370_000n);
  assert.equal(result.jht.employee, 200_000n);
  assert.equal(result.jkm.employer, 30_000n);
  assert.equal(result.jkm.employee, 0n);
});

test("all 5 JKK risk classes use 0.24, 0.54, 0.89, 1.27, and 1.74 percent", () => {
  const expected = [24_000n, 54_000n, 89_000n, 127_000n, 174_000n];
  assert.deepEqual(jkkRiskClasses, [1, 2, 3, 4, 5]);
  for (const riskClass of jkkRiskClasses) {
    const result = bpjs({ wage: 10_000_000n, jkkRiskClass: riskClass });
    assert.equal(result.jkk.riskClass, riskClass);
    assert.equal(result.jkk.employer, expected[riskClass - 1]);
    assert.equal(result.jkk.employee, 0n);
  }
});

test("a missing JP cap throws, and a supplied cap ceilings the monthly wage", () => {
  assert.throws(
    () =>
      calculateBpjs({
        wage: 11_000_000n,
        additionalFamilyMembers: 0,
        applyWageFloor: false,
        jkkRiskClass: 1,
        table: withJpAnnualCap("missing"),
      }),
    (error: unknown) => {
      assert.ok(error instanceof MissingStatutoryValueError);
      assert.equal(error.key, "jp_annual_wage_cap");
      return true;
    },
  );

  const capped = bpjs({ wage: 11_000_000n });
  assert.equal(capped.jp.monthlyWageCap, monthlyCap);
  assert.equal(capped.jp.wageBasis, 10_000_000n);
  assert.equal(capped.jp.employer, 200_000n);
  assert.equal(capped.jp.employee, 100_000n);
  assert.equal(capped.jht.wageBasis, 11_000_000n);
  assert.equal(capped.jht.employer, 407_000n);

  const under = bpjs({ wage: 8_000_000n });
  assert.equal(under.jp.wageBasis, 8_000_000n);
  assert.equal(under.jp.employer, 160_000n);
  assert.equal(under.jp.employee, 80_000n);

  const atCeiling = bpjs({ wage: 10_000_000n });
  assert.equal(atCeiling.jp.wageBasis, 10_000_000n);
});

test("the draft table is refused, and allowUndeclared still rejects its missing JP cap", () => {
  const input = {
    wage: 5_000_000n,
    additionalFamilyMembers: 0,
    applyWageFloor: false,
    jkkRiskClass: 1,
    table: id2026DraftTable,
  } as const;
  assert.throws(
    () => calculateBpjs(input),
    (error: unknown) => {
      assert.ok(error instanceof PayrollInputError);
      assert.match(error.message, /draft/);
      return true;
    },
  );
  assert.throws(
    () => calculateBpjs({ ...input, allowUndeclared: true }),
    (error: unknown) => {
      assert.ok(error instanceof MissingStatutoryValueError);
      assert.equal(error.key, "jp_annual_wage_cap");
      return true;
    },
  );
});

test("a JP annual cap that does not divide by 12 is rejected", () => {
  assert.throws(
    () =>
      bpjs({
        wage: 5_000_000n,
        table: withJpAnnualCap("120000001"),
      }),
    (error: unknown) => {
      assert.ok(error instanceof PayrollInputError);
      assert.match(error.message, /12/);
      return true;
    },
  );
});

test("a present JP cap of zero ceilings the JP wage at zero", () => {
  const result = bpjs({ wage: 5_000_000n, table: withJpAnnualCap("0") });
  assert.equal(result.jp.monthlyWageCap, 0n);
  assert.equal(result.jp.wageBasis, 0n);
  assert.equal(result.jp.employer, 0n);
  assert.equal(result.jp.employee, 0n);
  assert.equal(result.jht.employer, 185_000n);
});

test("JKP is 0.36 percent, capped at Rp5,000,000, and payable totals omit it", () => {
  assert.equal(JKP_WAGE_CAP, 5_000_000n);
  assert.equal(
    jkpRecompositionParts.governmentPerScale +
      jkpRecompositionParts.fromJkkPerScale +
      jkpRecompositionParts.fromJkmPerScale,
    36n,
  );
  assert.equal(jkpRecompositionParts.fromJkmPerScale, 0n);
  assert.equal(jkpRecompositionParts.rateScale, 10_000n);

  const wage = 10_000_000n;
  const direct = jkpRecomposition(wage);
  const result = bpjs({ wage, jkkRiskClass: 3, additionalFamilyMembers: 1 });
  assert.equal(result.jkp.wageBasis, 5_000_000n);
  assert.equal(result.jkp.government, 11_000n);
  assert.equal(result.jkp.fromJkk, 7_000n);
  assert.equal(result.jkp.fromJkm, 0n);
  assert.equal(result.jkp.total, 18_000n);
  assert.equal(result.jkp.total, direct.total);
  assert.equal(jkpRecomposition(5_000_000n).wageBasis, 5_000_000n);
  assert.equal(jkpRecomposition(5_000_001n).wageBasis, 5_000_000n);
  assert.equal(jkpRecomposition(4_000_000n).total, 14_400n);
  assert.equal(result.jkk.employer, 89_000n);
  assert.equal(result.jkm.employer, 30_000n);
  assert.equal(result.kesehatan.additionalFamilyEmployee, 100_000n);
  assert.equal(result.kesehatan.employer, 400_000n);
  assert.equal(result.kesehatan.employee, 200_000n);
  assert.equal(result.employerPayable, 1_089_000n);
  assert.equal(result.employeePayable, 500_000n);
});

test("JKP total is the sum of half-up parts, not one rounding of 0.36 percent", () => {
  const parts = jkpRecomposition(227n);
  assert.equal(parts.wageBasis, 227n);
  assert.equal(parts.government, 0n);
  assert.equal(parts.fromJkk, 0n);
  assert.equal(parts.fromJkm, 0n);
  assert.equal(parts.total, 0n);
  assert.equal(applyScaledRate(227n, 36n, 10_000n, "half_up"), 1n);
});

test("JKP recomposition rates live only in jkp.ts", () => {
  const files = readdirSync(bpjsDir).filter((name) => name.endsWith(".ts") && name !== "jkp.ts");
  assert.ok(files.includes("calculate.ts"));
  assert.ok(files.includes("jkk.ts"));
  for (const name of files) {
    const source = readFileSync(path.join(bpjsDir, name), "utf8");
    assert.doesNotMatch(source, /22n|14n|10n|46n|0\.46|0\.22|0\.14|0\.10/, name);
  }
  const jkp = readFileSync(path.join(bpjsDir, "jkp.ts"), "utf8");
  assert.match(jkp, /22n/);
  assert.match(jkp, /14n/);
  assert.match(jkp, /5_000_000n/);
  assert.doesNotMatch(jkp, /10n|46n/);
});

test("BPJS rejects negative wage, a bad risk class, and a missing floor", () => {
  assert.throws(() => bpjs({ wage: -1n }), PayrollInputError);
  assert.throws(() => bpjs({ wage: 1n, additionalFamilyMembers: -1 }), PayrollInputError);
  assert.throws(() => bpjs({ wage: 1n, additionalFamilyMembers: 1.5 }), PayrollInputError);
  assert.throws(() => bpjs({ wage: 1n, jkkRiskClass: 0 }), PayrollInputError);
  assert.throws(() => bpjs({ wage: 1n, jkkRiskClass: 6 }), PayrollInputError);
  assert.throws(() => bpjs({ wage: 1n, applyWageFloor: true }), PayrollInputError);
  assert.throws(
    () => bpjs({ wage: 1n, applyWageFloor: true, umpUmk: -1n }),
    PayrollInputError,
  );
  assert.throws(
    () => calculateBpjs({ ...bpjsInput(1n), table: null as never }),
    PayrollInputError,
  );
});

test("the same BPJS input returns the same bigint", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 20_000_000n }),
      fc.integer({ min: 0, max: 5 }),
      fc.integer({ min: 1, max: 5 }),
      fc.boolean(),
      (wage, family, riskClass, floor) => {
        const input = {
          wage,
          additionalFamilyMembers: family,
          applyWageFloor: floor,
          jkkRiskClass: riskClass,
          table: capTable,
          ...(floor ? { umpUmk: 4_000_000n } : {}),
        };
        const first = calculateBpjs(input);
        const second = calculateBpjs(input);
        return (
          first.employerPayable === second.employerPayable &&
          first.employeePayable === second.employeePayable &&
          first.jkp.total === first.jkp.government + first.jkp.fromJkk + first.jkp.fromJkm &&
          first.kesehatan.wageBasis <= KESEHATAN_WAGE_CAP &&
          first.jp.wageBasis <= monthlyCap &&
          first.jkp.wageBasis <= JKP_WAGE_CAP
        );
      },
    ),
    { seed: 20261125, numRuns: 40 },
  );
});

function bpjsInput(wage: bigint): CalculateBpjsInput {
  return {
    wage,
    additionalFamilyMembers: 0,
    applyWageFloor: false,
    jkkRiskClass: 1,
    table: capTable,
  };
}
