import assert from "node:assert/strict";
import test from "node:test";
import { platformTenantHealthSql } from "./health-sql.ts";

test("platform health SQL counts aggregates and names no PII table", () => {
  assert.equal(platformTenantHealthSql.includes("hr_employee_pii"), false);
  assert.equal(platformTenantHealthSql.includes("pay_run_items"), false);
  assert.equal(platformTenantHealthSql.includes("hr_employees"), false);
  assert.equal(platformTenantHealthSql.includes("id_users"), false);
  assert.equal(platformTenantHealthSql.includes("id_legal_entities"), false);
  assert.equal(/nik/iu.test(platformTenantHealthSql), false);
  assert.equal(platformTenantHealthSql.includes("id_memberships"), true);
  assert.equal(platformTenantHealthSql.includes("att_clock_events"), true);
  assert.equal(platformTenantHealthSql.includes("pgboss.job"), true);
  assert.equal(platformTenantHealthSql.includes("hr_documents"), true);
  assert.equal(platformTenantHealthSql.includes("pay_exports"), true);
  assert.equal(platformTenantHealthSql.includes("SECURITY DEFINER"), true);
  assert.equal(platformTenantHealthSql.includes("clock_in"), true);
});
