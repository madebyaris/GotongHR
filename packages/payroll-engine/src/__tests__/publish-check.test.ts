import assert from "node:assert/strict";
import test from "node:test";
import { civilDateToIso, parseGoldenFile, verifyStatutoryPublish } from "../index.ts";
import { readJson } from "./fixture-table.ts";

const emptyGolden = {
  description: "In-memory synthetic cases. Not a DJP example.",
  cases: [],
};

const shippedGolden = readJson("./golden/pph21.verified.json");

function synthetic(): Record<string, unknown> {
  return structuredClone(readJson("./fixtures/synthetic-pph21.json")) as Record<string, unknown>;
}

test("the shipped golden file is the DJP list and does not certify a synthetic table", () => {
  const golden = parseGoldenFile(shippedGolden);
  assert.match(golden.description, /Do not mark an invented case as verified/);
});

test("publish checks accept the labeled synthetic table when no verified case covers it", () => {
  const payload = synthetic();
  const golden = parseGoldenFile(shippedGolden);
  const verdict = verifyStatutoryPublish(payload, shippedGolden);
  const covered = golden.cases.some((goldenCase) => {
    const iso = civilDateToIso(goldenCase.payrollDate);
    return String(payload.effective_from) <= iso && iso <= String(payload.effective_to);
  });
  if (covered) {
    assert.equal(verdict.ok, false);
    return;
  }
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.ruleType, "pph21");
    assert.equal(verdict.effectiveFrom, "2026-01-01");
    assert.equal(verdict.effectiveTo, "2026-12-31");
  }
});

test("a draft status cannot be published", () => {
  const payload = synthetic();
  payload.status = "draft";
  const verdict = verifyStatutoryPublish(payload, emptyGolden);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.message, /draft/);
});

test("the shipped 2026 draft cannot be published", () => {
  const verdict = verifyStatutoryPublish(readJson("../tables/id-2026.draft.json"), emptyGolden);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.message, /draft/);
});

test("a missing TER, PTKP, or JP source cannot be published", () => {
  const payload = synthetic();
  payload.jp_annual_wage_cap = { source: "missing" };
  const verdict = verifyStatutoryPublish(payload, emptyGolden);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.message, /jp_annual_wage_cap.source is missing/);
});

test("a structurally invalid table cannot be published", () => {
  const verdict = verifyStatutoryPublish({ schema_version: 1 }, emptyGolden);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.message, /schema_version|rule_type|required/);
});

test("a verified case outside the window does not block publish", () => {
  const verdict = verifyStatutoryPublish(synthetic(), {
    description: "In-memory synthetic case. Not a DJP example.",
    cases: [monthlyCase("2025-06-15", "1")],
  });
  assert.equal(verdict.ok, true);
});

test("a verified case the window covers must match", () => {
  const mismatch = verifyStatutoryPublish(synthetic(), {
    description: "In-memory synthetic case. Not a DJP example.",
    cases: [monthlyCase("2026-01-31", "1")],
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.match(mismatch.message, /synthetic-mismatch/);

  const match = verifyStatutoryPublish(synthetic(), {
    description: "In-memory synthetic case. Not a DJP example.",
    cases: [monthlyCase("2026-01-31", "100000")],
  });
  assert.equal(match.ok, true);
});

function monthlyCase(payrollDate: string, tax: string): Record<string, unknown> {
  return {
    id: "synthetic-mismatch",
    verified: true,
    operation: "monthly_ter",
    payroll_date: payrollDate,
    ptkp_status: "TK/0",
    method: "gross",
    components: {
      base_salary: "5000000",
      fixed_allowances: "0",
      overtime: "0",
      bonus_or_thr: "0",
      employer_jkk: "0",
      employer_jkm: "0",
      employer_bpjs_kesehatan: "0",
    },
    expected: {
      tax,
      tax_allowance: "0",
      employee_withheld: tax,
      employer_borne_tax: "0",
      grossed_taxable: "5000000",
      grossed_cost: "5000000",
    },
  };
}
