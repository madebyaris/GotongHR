import assert from "node:assert/strict";
import test from "node:test";
import { isPayrollDate } from "./statutory.ts";
import { platformErrorFromDatabase } from "./tenants.ts";

test("payroll dates reject a bad calendar day and years outside the engine window", () => {
  assert.equal(isPayrollDate("2024-02-29"), true);
  assert.equal(isPayrollDate("2025-02-29"), false);
  assert.equal(isPayrollDate("2034-01-01"), true);
  assert.equal(isPayrollDate("1899-12-31"), false);
  assert.equal(isPayrollDate("2200-01-01"), false);
  assert.equal(isPayrollDate("2026-13-01"), false);
});

test("published overlap and immutability errors are conflicts", () => {
  const overlap = Object.assign(new Error("published statutory ranges overlap"), { code: "23P01" });
  const overlapMapped = platformErrorFromDatabase(overlap);
  assert.equal(overlapMapped?.status, 409);
  assert.equal(overlapMapped?.code, "conflict");

  const frozen = Object.assign(new Error("published statutory table is immutable"), {
    code: "55000",
  });
  const frozenMapped = platformErrorFromDatabase(frozen);
  assert.equal(frozenMapped?.status, 409);
  assert.equal(frozenMapped?.code, "conflict");

  const other = Object.assign(new Error("object not in prerequisite state"), { code: "55000" });
  assert.equal(platformErrorFromDatabase(other), null);
});
