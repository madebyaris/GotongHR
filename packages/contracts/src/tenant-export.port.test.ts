import assert from "node:assert/strict";
import test from "node:test";
import { tenantExportTableNames } from "./tenant-export.port.ts";

test("a tenant export lists the five archive tables", () => {
  assert.deepEqual(tenantExportTableNames, [
    "employees",
    "contracts",
    "attendance",
    "leave",
    "payroll_runs",
  ]);
});
