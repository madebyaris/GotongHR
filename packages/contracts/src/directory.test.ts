import assert from "node:assert/strict";
import test from "node:test";
import {
  contractEndLabel,
  daysUntil,
  filterDirectoryRows,
  parseCompensationCreate,
  parseContractCreate,
  parseDepartmentCreate,
  parsePositionCreate,
  type DirectoryRow,
} from "./directory.ts";

const today = "2026-11-25";

const sari: DirectoryRow = {
  id: "1",
  fullName: "Sari Wulandari",
  employeeCode: "E001",
  employmentStatus: "active",
  departmentId: "dept-people",
  contractType: "PKWTT",
  contractEndDate: null,
};

const longName: DirectoryRow = {
  id: "2",
  fullName: "Anastasia Putri Widyaningrum Kartikasari",
  employeeCode: "E-LONG-02",
  employmentStatus: "probation",
  departmentId: "dept-people",
  contractType: "PKWT",
  contractEndDate: "2027-01-09",
};

test("PKWT needs an end date and PKWTT refuses one", () => {
  const missing = parseContractCreate({ contractType: "PKWT", startDate: "2026-01-01" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.fields[0]?.field, "endDate");

  const permanent = parseContractCreate({
    contractType: "PKWTT",
    startDate: "2026-01-01",
    endDate: "2027-01-01",
  });
  assert.equal(permanent.ok, false);
  if (!permanent.ok) assert.equal(permanent.fields.some((field) => field.field === "endDate"), true);

  const fixed = parseContractCreate({
    contractType: "PKWT",
    startDate: "2026-01-01",
    endDate: "2027-01-09",
  });
  assert.equal(fixed.ok, true);
  if (fixed.ok) assert.equal(fixed.value.endDate, "2027-01-09");
});

test("pay accepts grouped rupiah and rejects a fraction", () => {
  const parsed = parseCompensationCreate({ baseSalaryIdr: "8.500.000", effectiveFrom: "2026-11-01" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.baseSalaryIdr, 8_500_000n);
  const fraction = parseCompensationCreate({ baseSalaryIdr: "8.500.000,50", effectiveFrom: "2026-11-01" });
  assert.equal(fraction.ok, false);
});

test("department and position names are trimmed", () => {
  const department = parseDepartmentCreate({ name: "  People Operations  " });
  assert.equal(department.ok, true);
  if (department.ok) assert.equal(department.value.name, "People Operations");
  const position = parsePositionCreate({ name: "HR Generalist", departmentId: "" });
  assert.equal(position.ok, true);
  if (position.ok) assert.equal(position.value.departmentId, null);
});

test("the end label names the 90-day window and a past end", () => {
  assert.equal(daysUntil(today, "2027-01-09"), 45);
  assert.equal(contractEndLabel("2027-01-09", today).includes("ends in 45 days"), true);
  assert.equal(contractEndLabel("2026-11-25", today).includes("Ends today"), true);
  assert.equal(contractEndLabel("2026-11-24", today).startsWith("Ended "), true);
  assert.equal(contractEndLabel(null, today), "No end date");
  assert.equal(contractEndLabel("2027-11-25", today).includes("ends in"), false);
});

test("directory filters match name, code, status, department, and expiry", () => {
  const rows = [sari, longName];
  assert.deepEqual(
    filterDirectoryRows(rows, { query: "widyaningrum", status: "", departmentId: "", contract: "" }, today).map(
      (row) => row.id,
    ),
    ["2"],
  );
  assert.deepEqual(
    filterDirectoryRows(rows, { query: "e-long", status: "", departmentId: "", contract: "" }, today).map(
      (row) => row.id,
    ),
    ["2"],
  );
  assert.deepEqual(
    filterDirectoryRows(rows, { query: "", status: "active", departmentId: "", contract: "" }, today).map(
      (row) => row.id,
    ),
    ["1"],
  );
  assert.deepEqual(
    filterDirectoryRows(rows, { query: "", status: "", departmentId: "missing", contract: "" }, today).map(
      (row) => row.id,
    ),
    [],
  );
  assert.deepEqual(
    filterDirectoryRows(rows, { query: "", status: "", departmentId: "", contract: "ending" }, today).map(
      (row) => row.id,
    ),
    ["2"],
  );
  assert.deepEqual(
    filterDirectoryRows(rows, { query: "", status: "", departmentId: "", contract: "PKWTT" }, today).map(
      (row) => row.id,
    ),
    ["1"],
  );
});
