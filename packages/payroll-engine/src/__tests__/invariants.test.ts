import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { ptkpStatuses, type PtkpStatus } from "@gotonghr/contracts";
import {
  applyScaledRate,
  calculateMonthlyPph21,
  civilDate,
  pasal17Tax,
  reconcilePph21,
  rupiah,
  terRate,
  terTax,
} from "../index.ts";
import type { StatutoryTable } from "../tables/types.ts";
import { components, loadSyntheticFixture, withTerBrackets, type JsonBracket } from "./fixture-table.ts";

const synthetic = loadSyntheticFixture();
const assertOptions = { seed: 20261125, numRuns: 80 } as const;

function gap(left: bigint, right: bigint): bigint {
  return left >= right ? left - right : right - left;
}

function flatBrackets(ratePerScale: number): JsonBracket[] {
  return [{ up_to: null, rate_per_scale: ratePerScale }];
}

function steppedBrackets(rates: readonly number[]): JsonBracket[] {
  const sorted = [...rates].sort((left, right) => left - right);
  let bound = 0;
  return sorted.map((rate, index) => {
    if (index === sorted.length - 1) return { up_to: null, rate_per_scale: rate };
    bound += 1_000_000;
    return { up_to: String(bound), rate_per_scale: rate };
  });
}

test("scaled rates are exact integer rupiah", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 10n ** 18n }),
      fc.integer({ min: 0, max: 10000 }),
      (amount, rateNum) => {
        const rate = BigInt(rateNum);
        const scale = 10000n;
        const product = amount * rate;
        const quotient = product / scale;
        const remainder = product % scale;
        const expected = remainder * 2n >= scale ? quotient + 1n : quotient;
        const halfUp = applyScaledRate(amount, rate, scale, "half_up");
        const floored = applyScaledRate(amount, rate, scale, "floor");
        return halfUp === expected && floored === quotient && typeof halfUp === "bigint";
      },
    ),
    assertOptions,
  );
});

test("the same input and the same table return the same bigint", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 80_000_000n }),
      fc.integer({ min: 0, max: 3400 }),
      fc.integer({ min: 1, max: 11 }),
      fc.constantFrom(...ptkpStatuses),
      fc.constantFrom("gross" as const, "nett" as const, "gross_up" as const),
      (gross, rateNum, month, status, method) => {
        const table = withTerBrackets(flatBrackets(rateNum));
        const input = {
          payrollDate: civilDate(2026, month, 28),
          periodMonth: month,
          table,
          ptkpStatus: status,
          method,
          components: components(gross),
        } as const;
        const first = calculateMonthlyPph21(input);
        const second = calculateMonthlyPph21(input);
        return (
          first.tax === second.tax &&
          first.taxAllowance === second.taxAllowance &&
          first.employeeWithheld === second.employeeWithheld &&
          first.employerBorneTax === second.employerBorneTax &&
          typeof first.tax === "bigint"
        );
      },
    ),
    assertOptions,
  );
});

test("gross-up allowance equals the tax on the grossed base within Rp1", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 5_000_000_000n }),
      fc.integer({ min: 0, max: 3500 }),
      fc.constantFrom(...ptkpStatuses),
      (gross, rateNum, status) => {
        const table = withTerBrackets(flatBrackets(rateNum));
        const result = calculateMonthlyPph21({
          payrollDate: civilDate(2026, 3, 31),
          periodMonth: 3,
          table,
          ptkpStatus: status,
          method: "gross_up",
          components: components(gross),
        });
        const tax = terTax(table, result.category, result.grossedTaxable);
        return gap(result.taxAllowance, tax) <= 1n && result.iterations <= 10 && result.iterations >= 1;
      },
    ),
    assertOptions,
  );
});

test("stepped TER gross-up still converges within 10 iterations", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 3400 }), { minLength: 1, maxLength: 12 }),
      fc.bigInt({ min: 0n, max: 80_000_000n }),
      (rates, gross) => {
        const table = withTerBrackets(steppedBrackets(rates));
        const result = calculateMonthlyPph21({
          payrollDate: civilDate(2026, 4, 30),
          periodMonth: 4,
          table,
          ptkpStatus: "K/0",
          method: "gross_up",
          components: components(gross),
        });
        const tax = terTax(table, "A", result.grossedTaxable);
        return gap(result.taxAllowance, tax) <= 1n && result.iterations <= 10;
      },
    ),
    assertOptions,
  );
});

test("a higher gross taxable never yields a lower TER rate inside one category", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 3400 }), { minLength: 1, maxLength: 12 }),
      fc.bigInt({ min: 0n, max: 100_000_000n }),
      fc.bigInt({ min: 0n, max: 100_000_000n }),
      (rates, left, right) => {
        const table = withTerBrackets(steppedBrackets(rates));
        const low = left < right ? left : right;
        const high = left < right ? right : left;
        return terRate(table, "A", low).ratePerScale <= terRate(table, "A", high).ratePerScale;
      },
    ),
    assertOptions,
  );
  if (synthetic.ter.source !== "missing") {
    let previous = 0n;
    let gross = 0n;
    for (let step = 0; step < 16; step += 1) {
      const rate = terRate(synthetic, "A", gross).ratePerScale;
      assert.ok(rate >= previous);
      previous = rate;
      gross = gross === 0n ? 1n : gross * 3n;
    }
  }
});

test("December settlement equals Pasal 17 on the rounded PKP minus tax already withheld", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 2_000_000_000n }),
      fc.integer({ min: 1, max: 12 }),
      fc.bigInt({ min: 0n, max: 50_000_000n }),
      fc.bigInt({ min: 0n, max: 50_000_000n }),
      fc.bigInt({ min: 0n, max: 20_000_000n }),
      fc.bigInt({ min: 0n, max: 500_000_000n }),
      fc.constantFrom(...ptkpStatuses),
      fc.constantFrom("december" as const, "exit" as const),
      (ytd, months, jht, jp, zakat, withheld, status, reason) => {
        const payrollDate = reason === "december" ? civilDate(2026, 12, 31) : civilDate(2026, months, 15);
        const activeMonths = reason === "december" ? 12 : months;
        const result = reconcilePph21({
          payrollDate,
          reason,
          table: synthetic,
          ptkpStatus: status,
          activeMonths,
          ytdGrossTaxable: rupiah(ytd),
          ytdEmployeeJht: rupiah(jht),
          ytdEmployeeJp: rupiah(jp),
          verifiedZakat: rupiah(zakat),
          ytdPph21Withheld: rupiah(withheld),
        });
        const expectedPkp = independentPkp(synthetic, status, ytd, activeMonths, jht, jp, zakat);
        const expectedTax = pasal17Tax(synthetic, expectedPkp);
        return (
          result.pkp === expectedPkp &&
          result.pkp % 1000n === 0n &&
          result.annualTax === expectedTax &&
          result.withholding - result.refund === expectedTax - withheld &&
          (result.withholding === 0n || result.refund === 0n) &&
          result.withholding >= 0n &&
          result.refund >= 0n
        );
      },
    ),
    assertOptions,
  );
});

function independentPkp(
  table: StatutoryTable,
  status: PtkpStatus,
  ytd: bigint,
  months: number,
  jht: bigint,
  jp: bigint,
  zakat: bigint,
): bigint {
  const rule = table.biayaJabatan;
  const rawBiaya = (ytd * rule.ratePerScale) / rule.rateScale;
  const cap = rule.monthlyCap * BigInt(months);
  const biaya = rawBiaya < cap ? rawBiaya : cap;
  let neto = ytd - biaya - jht - jp - zakat;
  if (neto < 0n) neto = 0n;
  const amount = table.ptkpAnnual.amounts[status];
  if (amount.kind !== "present") throw new Error("Synthetic PTKP is missing.");
  const ptkp = amount.rupiah;
  let raw = neto - ptkp;
  if (raw < 0n) raw = 0n;
  return raw - (raw % 1000n);
}

test("Pasal 17 tax does not fall when rounded PKP rises", () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 0n, max: 6_000_000_000n }),
      fc.bigInt({ min: 0n, max: 6_000_000_000n }),
      (left, right) => {
        const low = (left < right ? left : right) / 1000n * 1000n;
        const high = (left < right ? right : left) / 1000n * 1000n;
        return pasal17Tax(synthetic, low) <= pasal17Tax(synthetic, high);
      },
    ),
    assertOptions,
  );
});
