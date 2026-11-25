import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  GoldenCaseMismatchError,
  InvalidStatutoryTableError,
  assertGoldenCase,
  findTableForDate,
  isStatutoryDeclared,
  parseGoldenFile,
  parseStatutoryTable,
  type StatutoryTable,
} from "../index.ts";
import { loadSyntheticFixture } from "./fixture-table.ts";

function loadShippedTables(): StatutoryTable[] {
  const dir = fileURLToPath(new URL("../tables", import.meta.url));
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) =>
      parseStatutoryTable(JSON.parse(readFileSync(path.join(dir, name), "utf8"))),
    );
}

test("verified golden cases match the engine", () => {
  const filePath = fileURLToPath(new URL("./golden/pph21.verified.json", import.meta.url));
  const golden = parseGoldenFile(JSON.parse(readFileSync(filePath, "utf8")));
  const tables = loadShippedTables();
  const declared = tables.some((table) => isStatutoryDeclared(table));
  if (golden.cases.length === 0) {
    if (declared) {
      assert.fail(
        "Statutory tables are declared present but pph21.verified.json has no verified cases.",
      );
    }
    // `t.skip("no verified fixtures")` does not write that exact line under the spec reporter.
    process.stdout.write("no verified fixtures\n");
    return;
  }
  for (const goldenCase of golden.cases) {
    const table = findTableForDate(tables, goldenCase.payrollDate);
    assertGoldenCase(table, goldenCase);
  }
});

test("the golden runner rejects a mismatched verified case", () => {
  const golden = parseGoldenFile({
    description: "In-memory synthetic case. Not a DJP example.",
    cases: [
      {
        id: "synthetic-mismatch",
        verified: true,
        operation: "monthly_ter",
        payroll_date: "2026-01-31",
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
          tax: "1",
          tax_allowance: "0",
          employee_withheld: "1",
          employer_borne_tax: "0",
          grossed_taxable: "5000000",
          grossed_cost: "5000000",
        },
      },
    ],
  });
  const goldenCase = golden.cases[0];
  assert.ok(goldenCase);
  assert.throws(() => assertGoldenCase(loadSyntheticFixture(), goldenCase), GoldenCaseMismatchError);
});

test("the golden runner accepts an in-memory synthetic case without writing it as verified", () => {
  const golden = parseGoldenFile({
    description: "In-memory synthetic case. Not a DJP example.",
    cases: [
      {
        id: "synthetic-match",
        verified: true,
        operation: "monthly_ter",
        payroll_date: "2026-01-31",
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
          tax: "100000",
          tax_allowance: "0",
          employee_withheld: "100000",
          employer_borne_tax: "0",
          grossed_taxable: "5000000",
          grossed_cost: "5000000",
        },
      },
    ],
  });
  const goldenCase = golden.cases[0];
  assert.ok(goldenCase);
  assert.doesNotThrow(() => assertGoldenCase(loadSyntheticFixture(), goldenCase));
});

test("unverified cases are ignored by the golden file parser", () => {
  const golden = parseGoldenFile({
    description: "Unverified cases are not DJP examples.",
    cases: [{ id: "draft-note", verified: false }],
  });
  assert.equal(golden.cases.length, 0);
});

test("golden cases reject a bad date, a duplicate id, and an active month outside 1 to 12", () => {
  assert.throws(
    () =>
      parseGoldenFile({
        description: "Malformed payroll date.",
        cases: [{ id: "bad-date", verified: true, operation: "monthly_ter", payroll_date: "2026/01/31" }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidStatutoryTableError);
      return true;
    },
  );
  assert.throws(
    () =>
      parseGoldenFile({
        description: "Impossible payroll date.",
        cases: [{ id: "impossible-date", verified: true, operation: "monthly_ter", payroll_date: "2026-02-30" }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidStatutoryTableError);
      assert.match(error.message, /calendar date/);
      return true;
    },
  );
  assert.throws(
    () =>
      parseGoldenFile({
        description: "Duplicate ids.",
        cases: [
          { id: "same", verified: false },
          { id: "same", verified: false },
        ],
      }),
    /duplicates same/,
  );
  assert.throws(
    () =>
      parseGoldenFile({
        description: "Active months out of range.",
        cases: [
          {
            id: "months",
            verified: true,
            operation: "reconcile",
            payroll_date: "2026-06-30",
            reason: "exit",
            ptkp_status: "TK/0",
            active_months: 13,
            ytd_gross_taxable: "0",
            ytd_employee_jht: "0",
            ytd_employee_jp: "0",
            verified_zakat: "0",
            ytd_pph21_withheld: "0",
            expected: {
              withholding: "0",
              refund: "0",
              pkp: "0",
              annual_tax: "0",
              biaya_jabatan: "0",
            },
          },
        ],
      }),
    /active_months/,
  );
});
