import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { PayrollInputError, calculateThr } from "../index.ts";

const base = 10_000_000n;
const fixed = 2_000_000n;
const wage = 12_000_000n;

test("tenure under 1 month pays 0 because THR starts at one month", () => {
  assert.equal(calculateThr({ tenureMonths: 0, baseSalary: base, fixedAllowances: fixed }), 0n);
});

test("THR for 1 month floors one twelfth of base plus fixed allowances", () => {
  assert.equal(calculateThr({ tenureMonths: 1, baseSalary: base, fixedAllowances: fixed }), 1_000_000n);
  assert.equal(calculateThr({ tenureMonths: 1, baseSalary: 10_000_001n, fixedAllowances: 0n }), 833_333n);
});

test("THR for 11 months floors eleven twelfths, and 12 or 24 months pay one month", () => {
  assert.equal(calculateThr({ tenureMonths: 11, baseSalary: base, fixedAllowances: fixed }), 11_000_000n);
  assert.equal(calculateThr({ tenureMonths: 12, baseSalary: base, fixedAllowances: fixed }), wage);
  assert.equal(calculateThr({ tenureMonths: 13, baseSalary: base, fixedAllowances: fixed }), wage);
  assert.equal(calculateThr({ tenureMonths: 24, baseSalary: base, fixedAllowances: fixed }), wage);
});

test("negative or fractional THR tenure is rejected", () => {
  assert.throws(
    () => calculateThr({ tenureMonths: -1, baseSalary: base, fixedAllowances: fixed }),
    PayrollInputError,
  );
  assert.throws(
    () => calculateThr({ tenureMonths: 1.5, baseSalary: base, fixedAllowances: fixed }),
    PayrollInputError,
  );
  assert.throws(
    () => calculateThr({ tenureMonths: 12, baseSalary: -1n, fixedAllowances: fixed }),
    PayrollInputError,
  );
  assert.throws(
    () => calculateThr({ tenureMonths: 12, baseSalary: base, fixedAllowances: -1n }),
    PayrollInputError,
  );
});

test("THR never exceeds one month of base plus fixed allowances", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 240 }),
      fc.bigInt({ min: 0n, max: 50_000_000n }),
      fc.bigInt({ min: 0n, max: 20_000_000n }),
      (months, baseSalary, fixedAllowances) => {
        const sum = baseSalary + fixedAllowances;
        const got = calculateThr({ tenureMonths: months, baseSalary, fixedAllowances });
        const full = calculateThr({ tenureMonths: 12, baseSalary, fixedAllowances });
        if (months < 1) return got === 0n && full === sum;
        if (months >= 12) return got === sum && full === sum;
        return got === (sum * BigInt(months)) / 12n && got <= full;
      },
    ),
    { seed: 20261125, numRuns: 40 },
  );
});
