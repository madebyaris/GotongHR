import assert from "node:assert/strict";
import test from "node:test";
import {
  GrossUpDidNotConvergeError,
  PayrollInputError,
  calculateMonthlyPph21,
  civilDate,
  grossTaxableOf,
  parseStatutoryTable,
  terTax,
} from "../index.ts";
import { GROSS_UP_MAX_ITERATIONS, solveGrossUp } from "../pph21/gross-up.ts";
import { MAX_TER_BRACKETS } from "../tables/limits.ts";
import { components, loadSyntheticFixture, readJson } from "./fixture-table.ts";

const table = loadSyntheticFixture();
const january = civilDate(2026, 1, 31);

function gap(left: bigint, right: bigint): bigint {
  return left >= right ? left - right : right - left;
}

test("gross taxable is the spec sum and does not subtract employee JHT", () => {
  assert.equal(
    grossTaxableOf(
      components(1n, {
        fixedAllowances: 2n,
        overtime: 3n,
        bonusOrThr: 4n,
        employerJkk: 5n,
        employerJkm: 6n,
        employerBpjsKesehatan: 7n,
      }),
    ),
    28n,
  );
  assert.throws(() => grossTaxableOf(components(-1n)), PayrollInputError);
});

test("gross method withholds the synthetic TER tax and adds no allowance", () => {
  const result = calculateMonthlyPph21({
    payrollDate: january,
    periodMonth: 1,
    table,
    ptkpStatus: "TK/0",
    method: "gross",
    components: components(5_000_000n),
  });
  assert.equal(result.category, "A");
  assert.equal(result.tax, 100_000n);
  assert.equal(result.taxAllowance, 0n);
  assert.equal(result.employeeWithheld, 100_000n);
  assert.equal(result.employerBorneTax, 0n);
  assert.equal(result.grossedCost, 5_000_000n);
  assert.equal(result.iterations, 1);

  assert.equal(
    calculateMonthlyPph21({
      payrollDate: january,
      periodMonth: 1,
      table,
      ptkpStatus: "TK/2",
      method: "gross",
      components: components(5_000_000n),
    }).tax,
    150_000n,
  );
  assert.equal(
    calculateMonthlyPph21({
      payrollDate: january,
      periodMonth: 1,
      table,
      ptkpStatus: "K/3",
      method: "gross",
      components: components(5_000_000n),
    }).tax,
    200_000n,
  );
  assert.equal(
    calculateMonthlyPph21({
      payrollDate: january,
      periodMonth: 1,
      table,
      ptkpStatus: "K/0",
      method: "gross",
      components: components(5_000_000n),
    }).category,
    "A",
  );
});

test("TER brackets are inclusive on the upper bound", () => {
  assert.equal(terTax(table, "A", 10_000_000n), 200_000n);
  assert.equal(terTax(table, "A", 10_000_001n), 400_000n);
  assert.equal(terTax(table, "A", 0n), 0n);
});

test("gross-up allowance matches the tax on the grossed base", () => {
  const inside = calculateMonthlyPph21({
    payrollDate: january,
    periodMonth: 1,
    table,
    ptkpStatus: "TK/0",
    method: "gross_up",
    components: components(5_000_000n),
  });
  assert.equal(inside.taxAllowance, 102_041n);
  assert.equal(inside.tax, 102_041n);
  assert.equal(inside.grossedTaxable, 5_102_041n);
  assert.equal(inside.employeeWithheld, 102_041n);
  assert.equal(inside.employerBorneTax, 0n);
  assert.ok(inside.iterations <= 10);
  assert.equal(gap(inside.taxAllowance, terTax(table, "A", inside.grossedTaxable)), 0n);

  const crossed = calculateMonthlyPph21({
    payrollDate: january,
    periodMonth: 1,
    table,
    ptkpStatus: "TK/0",
    method: "gross_up",
    components: components(9_900_000n),
  });
  assert.equal(crossed.taxAllowance, 412_500n);
  assert.equal(crossed.tax, 412_500n);
  assert.equal(crossed.grossedTaxable, 10_312_500n);
  assert.equal(gap(crossed.taxAllowance, terTax(table, "A", crossed.grossedTaxable)), 0n);
  assert.ok(gap(crossed.grossedTaxable - crossed.employeeWithheld, 9_900_000n) <= 1n);
});

test("nett returns the employer-borne tax and the grossed cost", () => {
  const result = calculateMonthlyPph21({
    payrollDate: january,
    periodMonth: 1,
    table,
    ptkpStatus: "TK/0",
    method: "nett",
    components: components(5_000_000n),
  });
  assert.equal(result.employeeWithheld, 0n);
  assert.equal(result.employerBorneTax, 102_041n);
  assert.equal(result.grossedCost, 5_102_041n);
  assert.equal(result.tax, 102_041n);
  assert.equal(result.grossedCost, result.grossTaxable + result.tax);
  assert.ok(gap(result.grossedCost - result.grossTaxable, terTax(table, "A", result.grossedCost)) <= 1n);
});

test("monthly TER rejects December, a mismatched month, and a date outside the table", () => {
  assert.throws(
    () =>
      calculateMonthlyPph21({
        payrollDate: civilDate(2026, 12, 31),
        periodMonth: 12,
        table,
        ptkpStatus: "TK/0",
        method: "gross",
        components: components(1n),
      }),
    /December/,
  );
  assert.throws(
    () =>
      calculateMonthlyPph21({
        payrollDate: civilDate(2026, 2, 28),
        periodMonth: 1,
        table,
        ptkpStatus: "TK/0",
        method: "gross",
        components: components(1n),
      }),
    /periodMonth/,
  );
  assert.throws(
    () =>
      calculateMonthlyPph21({
        payrollDate: civilDate(2025, 6, 30),
        periodMonth: 6,
        table,
        ptkpStatus: "TK/0",
        method: "gross",
        components: components(1n),
      }),
    /does not cover/,
  );
});

test("the same monthly input returns the same bigint", () => {
  const input = {
    payrollDate: january,
    periodMonth: 1,
    table,
    ptkpStatus: "K/2" as const,
    method: "gross_up" as const,
    components: components(8_000_000n, { overtime: 250_000n, employerJkk: 24_000n }),
  };
  const first = calculateMonthlyPph21(input);
  const second = calculateMonthlyPph21(input);
  assert.equal(first.tax, second.tax);
  assert.equal(first.taxAllowance, second.taxAllowance);
  assert.equal(typeof first.tax, "bigint");
});

test("a 100 percent rate does not converge", () => {
  assert.equal(GROSS_UP_MAX_ITERATIONS, MAX_TER_BRACKETS);
  assert.throws(
    () => solveGrossUp(10_000n, "half_up", () => ({ ratePerScale: 10000n, rateScale: 10000n })),
    (error: unknown) => {
      assert.ok(error instanceof GrossUpDidNotConvergeError);
      assert.match(error.message, /ratePerScale/);
      assert.equal(error.message.includes("10 iterations"), false);
      return true;
    },
  );
});

test("a fixed point found on the last gross-up iteration is kept", () => {
  const gross = 1_000_000n;
  const step = 1_000n;
  const finalAllowance = step * BigInt(GROSS_UP_MAX_ITERATIONS);
  const solved = solveGrossUp(gross, "floor", (base) => {
    const allowance = base - gross;
    const next = allowance < finalAllowance ? allowance + step : finalAllowance;
    return { ratePerScale: next, rateScale: gross + next };
  });
  assert.equal(solved.iterations, GROSS_UP_MAX_ITERATIONS);
  assert.equal(solved.allowance, finalAllowance);
  assert.equal(gap(solved.allowance, solved.tax), 0n);
});

test("monthly TER refuses a draft table with rates unless allowUndeclared is set", () => {
  const raw = structuredClone(readJson("./fixtures/synthetic-pph21.json")) as Record<string, unknown>;
  raw.status = "draft";
  const draft = parseStatutoryTable(raw);
  const input = {
    payrollDate: january,
    periodMonth: 1,
    table: draft,
    ptkpStatus: "TK/0" as const,
    method: "gross_up" as const,
    components: components(5_000_000n),
  };
  assert.throws(() => calculateMonthlyPph21(input), {
    name: "PayrollInputError",
    message: /Pass allowUndeclared to calculate with it/,
  });
  const allowed = calculateMonthlyPph21({ ...input, allowUndeclared: true });
  assert.equal(allowed.tax, 102_041n);
  assert.equal(allowed.method, "gross_up");
});

test("monthly TER does not require a PTKP rupiah amount", () => {
  const raw = structuredClone(readJson("./fixtures/synthetic-pph21.json")) as Record<string, unknown>;
  const amounts: Record<string, { source: string }> = {};
  for (const status of ["TK/0", "TK/1", "TK/2", "TK/3", "K/0", "K/1", "K/2", "K/3"]) {
    amounts[status] = { source: "missing" };
  }
  raw.ptkp_annual = { source: "missing", amounts };
  const result = calculateMonthlyPph21({
    payrollDate: january,
    periodMonth: 1,
    table: parseStatutoryTable(raw),
    ptkpStatus: "TK/0",
    method: "gross",
    components: components(5_000_000n),
  });
  assert.equal(result.tax, 100_000n);
  assert.throws(() => terTax(table, "A", -1n), PayrollInputError);
});
