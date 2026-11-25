import assert from "node:assert/strict";
import test from "node:test";
import { getTableName } from "drizzle-orm";
import {
  payStatutoryTables,
  statutoryRuleTypes,
  statutoryStatuses,
  sysPlans,
  sysPlatformAuditEvents,
  sysPlatformOperators,
  sysSupportGrants,
  sysTenantQuotas,
  tenantExports,
} from "./schema.ts";

test("platform tables use the sys_ names from the spec", () => {
  assert.equal(getTableName(sysPlans), "sys_plans");
  assert.equal(getTableName(sysTenantQuotas), "sys_tenant_quotas");
  assert.equal(getTableName(sysSupportGrants), "sys_support_grants");
  assert.equal(getTableName(sysPlatformAuditEvents), "sys_platform_audit_events");
  assert.equal(getTableName(sysPlatformOperators), "sys_platform_operators");
  assert.equal(getTableName(payStatutoryTables), "pay_statutory_tables");
  assert.equal(getTableName(tenantExports), "tenant_exports");
});

test("statutory rule types keep the engine document and the spec codes", () => {
  assert.deepEqual(statutoryStatuses, ["draft", "published", "archived"]);
  assert.deepEqual(statutoryRuleTypes, [
    "pph21",
    "ter_a",
    "ter_b",
    "ter_c",
    "pasal17",
    "bpjs_caps",
    "ptkp",
  ]);
});
