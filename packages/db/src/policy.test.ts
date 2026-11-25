import assert from "node:assert/strict";
import test from "node:test";
import { tenantIsolationPolicySql } from "./policy.ts";

test("the policy helper forces tenant isolation", () => {
  const sqlText = tenantIsolationPolicySql("rls_probe");
  assert.match(sqlText, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sqlText, /FORCE ROW LEVEL SECURITY/);
  assert.match(
    sqlText,
    /tenant_id = current_setting\('app\.current_tenant_id', true\)::uuid/,
  );
  assert.match(sqlText, /WITH CHECK/);
});

test("the policy helper rejects a table name that is not an identifier", () => {
  assert.throws(() => tenantIsolationPolicySql("hr_employees; drop table hr_employees"), /invalid table name/);
});
