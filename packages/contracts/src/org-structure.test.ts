import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCompensationCreate,
  parseContractCreate,
  parseDepartmentCreate,
  parsePositionCreate,
} from "./org-structure.ts";

const entity = "018f3a4c-7b2a-7c3d-8e4f-123456789abc";

test("a PKWT contract needs an end date and a PKWTT contract does not", () => {
  const missing = parseContractCreate({ contractType: "PKWT", startDate: "2026-01-01" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.fields.some((field) => field.field === "endDate"), true);
  const permanent = parseContractCreate({
    contractType: "PKWTT",
    startDate: "2026-01-01",
    endDate: null,
  });
  assert.equal(permanent.ok, true);
  if (permanent.ok) {
    assert.equal(permanent.value.endDate, null);
    assert.equal(permanent.value.status, "active");
    assert.equal(permanent.value.compensationPaid, false);
  }
  const reversed = parseContractCreate({
    contractType: "PKWT",
    startDate: "2026-06-01",
    endDate: "2026-01-01",
  });
  assert.equal(reversed.ok, false);
});

test("salary and allowances stay whole rupiah, including values above the JSON safe integer", () => {
  const parsed = parseCompensationCreate({
    baseSalaryIdr: "9007199254740993",
    fixedAllowances: { transport: "1500000", meal: "5.000.000" },
    bpjsFlags: { kesehatan: true, jht: true },
    effectiveFrom: "2026-01-01",
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.baseSalaryIdr, 9007199254740993n);
    assert.equal(parsed.value.fixedAllowances.transport, 1500000n);
    assert.equal(parsed.value.fixedAllowances.meal, 5000000n);
    assert.equal(parsed.value.bpjsFlags.kesehatan, true);
    assert.equal(parsed.value.bpjsFlags.jkk, false);
  }
  const fraction = parseCompensationCreate({
    baseSalaryIdr: "1000.50",
    effectiveFrom: "2026-01-01",
  });
  assert.equal(fraction.ok, false);
  const leap = parseCompensationCreate({
    baseSalaryIdr: "1",
    effectiveFrom: "2026-02-31",
  });
  assert.equal(leap.ok, false);
});

test("department and position codes reject blanks and a department needs a legal entity", () => {
  const department = parseDepartmentCreate({
    legalEntityId: entity,
    name: "  Finance  ",
    code: "FIN-1",
    costCenterCode: "CC-01",
  });
  assert.equal(department.ok, true);
  if (department.ok) {
    assert.equal(department.value.name, "Finance");
    assert.equal(department.value.branchId, null);
    assert.equal(department.value.costCenterCode, "CC-01");
  }
  const position = parsePositionCreate({
    departmentId: entity,
    title: "Staff Admin",
    code: "bad code",
    levelCode: "L2",
  });
  assert.equal(position.ok, false);
  if (!position.ok) assert.equal(position.fields.some((field) => field.field === "code"), true);
});
