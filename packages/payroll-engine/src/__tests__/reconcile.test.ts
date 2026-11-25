import assert from "node:assert/strict";
import test from "node:test";
import {
  PayrollInputError,
  calculateMonthlyPph21,
  civilDate,
  parseStatutoryTable,
  reconcilePph21,
  rupiah,
} from "../index.ts";
import { components, loadSyntheticFixture, readJson } from "./fixture-table.ts";

const table = loadSyntheticFixture();

function gap(left: bigint, right: bigint): bigint {
  return left >= right ? left - right : right - left;
}

test("December settlement equals Pasal 17 tax minus January through November withholding", () => {
  let withheld = 0n;
  for (let month = 1; month <= 11; month += 1) {
    const monthly = calculateMonthlyPph21({
      payrollDate: civilDate(2026, month, 28),
      periodMonth: month,
      table,
      ptkpStatus: "TK/0",
      method: "gross",
      components: components(5_000_000n),
    });
    assert.equal(monthly.tax, 100_000n);
    withheld += monthly.tax;
  }
  const result = reconcilePph21({
    payrollDate: civilDate(2026, 12, 31),
    reason: "december",
    table,
    ptkpStatus: "TK/0",
    activeMonths: 12,
    ytdGrossTaxable: rupiah(60_000_000n),
    ytdEmployeeJht: rupiah(0n),
    ytdEmployeeJp: rupiah(0n),
    verifiedZakat: rupiah(0n),
    ytdPph21Withheld: rupiah(withheld),
  });
  assert.equal(result.biayaJabatan, 3_000_000n);
  assert.equal(result.neto, 57_000_000n);
  assert.equal(result.ptkp, 1_000_000n);
  assert.equal(result.pkp, 56_000_000n);
  assert.equal(result.pkp % 1000n, 0n);
  assert.equal(result.annualTax, 2_800_000n);
  assert.equal(result.withholding, 1_700_000n);
  assert.equal(result.refund, 0n);
  assert.equal(result.withholding - result.refund, result.annualTax - withheld);
});

test("a June exit uses the same annual identity and does not withhold a further TER month", () => {
  const result = reconcilePph21({
    payrollDate: civilDate(2026, 6, 30),
    reason: "exit",
    table,
    ptkpStatus: "TK/0",
    activeMonths: 6,
    ytdGrossTaxable: rupiah(30_000_000n),
    ytdEmployeeJht: rupiah(0n),
    ytdEmployeeJp: rupiah(0n),
    verifiedZakat: rupiah(0n),
    ytdPph21Withheld: rupiah(500_000n),
  });
  assert.equal(result.reason, "exit");
  assert.equal(result.biayaJabatan, 1_500_000n);
  assert.equal(result.pkp, 27_500_000n);
  assert.equal(result.annualTax, 1_375_000n);
  assert.equal(result.withholding, 875_000n);
  assert.equal(result.refund, 0n);
  assert.equal(result.withholding - result.refund, result.annualTax - 500_000n);
});

test("a negative December delta is a refund and not another withholding", () => {
  const result = reconcilePph21({
    payrollDate: civilDate(2026, 12, 31),
    reason: "december",
    table,
    ptkpStatus: "TK/0",
    activeMonths: 1,
    ytdGrossTaxable: rupiah(100_000n),
    ytdEmployeeJht: rupiah(0n),
    ytdEmployeeJp: rupiah(0n),
    verifiedZakat: rupiah(0n),
    ytdPph21Withheld: rupiah(50_000n),
  });
  assert.equal(result.pkp, 0n);
  assert.equal(result.annualTax, 0n);
  assert.equal(result.withholding, 0n);
  assert.equal(result.refund, 50_000n);
});

test("PKP rounds down to Rp1,000 after biaya jabatan, JHT, JP, zakat, and PTKP", () => {
  const result = reconcilePph21({
    payrollDate: civilDate(2026, 12, 31),
    reason: "december",
    table,
    ptkpStatus: "TK/0",
    activeMonths: 1,
    ytdGrossTaxable: rupiah(3_000_000n),
    ytdEmployeeJht: rupiah(0n),
    ytdEmployeeJp: rupiah(0n),
    verifiedZakat: rupiah(501n),
    ytdPph21Withheld: rupiah(0n),
  });
  assert.equal(result.biayaJabatan, 150_000n);
  assert.equal(result.neto, 2_849_499n);
  assert.equal(result.pkp, 1_849_000n);
  assert.equal(result.annualTax, 92_450n);
  assert.equal(result.withholding, 92_450n);
});

test("exit and December use the same money result for the same inputs", () => {
  const input = {
    table,
    ptkpStatus: "TK/2" as const,
    activeMonths: 12,
    ytdGrossTaxable: rupiah(60_000_000n),
    ytdEmployeeJht: rupiah(1_000_000n),
    ytdEmployeeJp: rupiah(400_000n),
    verifiedZakat: rupiah(250_000n),
    ytdPph21Withheld: rupiah(2_000_000n),
  };
  const december = reconcilePph21({
    ...input,
    payrollDate: civilDate(2026, 12, 31),
    reason: "december",
  });
  const exit = reconcilePph21({
    ...input,
    payrollDate: civilDate(2026, 12, 31),
    reason: "exit",
  });
  assert.equal(december.category, "B");
  assert.equal(december.withholding, exit.withholding);
  assert.equal(december.refund, exit.refund);
  assert.equal(december.pkp, exit.pkp);
  assert.equal(december.pkp % 1000n, 0n);
  assert.equal(gap(december.withholding - december.refund, december.annualTax - 2_000_000n), 0n);
  assert.throws(
    () =>
      reconcilePph21({
        ...input,
        payrollDate: civilDate(2026, 6, 30),
        reason: "december",
      }),
    PayrollInputError,
  );
  assert.throws(
    () =>
      reconcilePph21({
        ...input,
        payrollDate: civilDate(2026, 6, 30),
        reason: "exit",
      }),
    { name: "PayrollInputError", message: /activeMonths cannot exceed/ },
  );
});

test("reconciliation refuses a draft unless allowUndeclared is set", () => {
  const raw = structuredClone(readJson("./fixtures/synthetic-pph21.json")) as Record<string, unknown>;
  raw.status = "draft";
  const draft = parseStatutoryTable(raw);
  const input = {
    payrollDate: civilDate(2026, 6, 30),
    reason: "exit" as const,
    table: draft,
    ptkpStatus: "TK/0" as const,
    activeMonths: 6,
    ytdGrossTaxable: rupiah(30_000_000n),
    ytdEmployeeJht: rupiah(0n),
    ytdEmployeeJp: rupiah(0n),
    verifiedZakat: rupiah(0n),
    ytdPph21Withheld: rupiah(500_000n),
  };
  assert.throws(() => reconcilePph21(input), {
    name: "PayrollInputError",
    message: /Pass allowUndeclared to calculate with it/,
  });
  const allowed = reconcilePph21({ ...input, allowUndeclared: true });
  assert.equal(allowed.withholding, 875_000n);
});

test("reconciliation does not need TER rates and does not cap JP with a guessed number", () => {
  const raw = structuredClone(readJson("./fixtures/synthetic-pph21.json")) as Record<string, unknown>;
  raw.ter = {
    source: "missing",
    tax_rounding: "half_up",
    rate_scale: 10000,
    categories: {
      A: { source: "missing" },
      B: { source: "missing" },
      C: { source: "missing" },
    },
  };
  raw.jp_annual_wage_cap = { source: "missing" };
  const result = reconcilePph21({
    payrollDate: civilDate(2026, 6, 30),
    reason: "exit",
    table: parseStatutoryTable(raw),
    ptkpStatus: "TK/0",
    activeMonths: 6,
    ytdGrossTaxable: rupiah(60_000_000n),
    ytdEmployeeJht: rupiah(0n),
    ytdEmployeeJp: rupiah(40_000_000n),
    verifiedZakat: rupiah(0n),
    ytdPph21Withheld: rupiah(0n),
  });
  assert.equal(result.neto, 17_000_000n);
  assert.equal(result.pkp, 16_000_000n);
  assert.equal(result.annualTax, 800_000n);
});
