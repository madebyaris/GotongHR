import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import * as payrollEngine from "../index.ts";
import { PayrollInputError, calculatePkwtCompensation, calculateThr } from "../index.ts";

const src = fileURLToPath(new URL("../", import.meta.url));
const base = 10_000_000n;
const fixed = 2_000_000n;
const wage = 12_000_000n;

test("PKWT compensation floors completed months over 12 times base plus fixed allowances", () => {
  assert.equal(
    calculatePkwtCompensation({ completedMonths: 1, baseSalary: base, fixedAllowances: fixed }),
    1_000_000n,
  );
  assert.equal(
    calculatePkwtCompensation({ completedMonths: 1, baseSalary: 10_000_001n, fixedAllowances: 0n }),
    833_333n,
  );
  assert.equal(
    calculatePkwtCompensation({ completedMonths: 11, baseSalary: base, fixedAllowances: fixed }),
    11_000_000n,
  );
  assert.equal(
    calculatePkwtCompensation({ completedMonths: 12, baseSalary: base, fixedAllowances: fixed }),
    wage,
  );
  assert.equal(
    calculatePkwtCompensation({ completedMonths: 13, baseSalary: base, fixedAllowances: fixed }),
    13_000_000n,
  );
  assert.equal(
    calculatePkwtCompensation({ completedMonths: 24, baseSalary: base, fixedAllowances: fixed }),
    24_000_000n,
  );
});

test("PKWT compensation keeps growing after 12 months, unlike THR", () => {
  const input = { baseSalary: base, fixedAllowances: fixed };
  assert.equal(calculatePkwtCompensation({ completedMonths: 24, ...input }), wage * 2n);
  assert.equal(calculateThr({ tenureMonths: 24, ...input }), wage);
});

test("PKWT compensation rejects fewer than 1 completed month and negative wage", () => {
  assert.throws(
    () => calculatePkwtCompensation({ completedMonths: 0, baseSalary: base, fixedAllowances: fixed }),
    PayrollInputError,
  );
  assert.throws(
    () => calculatePkwtCompensation({ completedMonths: -3, baseSalary: base, fixedAllowances: fixed }),
    PayrollInputError,
  );
  assert.throws(
    () => calculatePkwtCompensation({ completedMonths: 1.5, baseSalary: base, fixedAllowances: 0n }),
    PayrollInputError,
  );
  assert.throws(
    () => calculatePkwtCompensation({ completedMonths: 12, baseSalary: -1n, fixedAllowances: 0n }),
    PayrollInputError,
  );
  assert.throws(
    () => calculatePkwtCompensation({ completedMonths: 12, baseSalary: 0n, fixedAllowances: -1n }),
    PayrollInputError,
  );
});

test("pesangon, UPMK, and UPH are not in the public API", () => {
  assert.equal(existsSync(path.join(src, "pkwt", "severance.ts")), false);
  for (const name of Object.keys(payrollEngine)) {
    assert.doesNotMatch(name, /severance|pesangon|upmk|uph/i, name);
  }
});

test("PKWT compensation matches the floor formula for completed months", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 60 }),
      fc.bigInt({ min: 0n, max: 40_000_000n }),
      fc.bigInt({ min: 0n, max: 10_000_000n }),
      (completedMonths, baseSalary, fixedAllowances) => {
        const sum = baseSalary + fixedAllowances;
        const got = calculatePkwtCompensation({ completedMonths, baseSalary, fixedAllowances });
        return got === (sum * BigInt(completedMonths)) / 12n;
      },
    ),
    { seed: 20261125, numRuns: 40 },
  );
});
