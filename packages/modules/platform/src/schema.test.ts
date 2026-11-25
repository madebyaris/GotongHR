import assert from "node:assert/strict";
import test from "node:test";
import { getTableName } from "drizzle-orm";
import {
  sysPlans,
  sysPlatformAuditEvents,
  sysPlatformOperators,
  sysSupportGrants,
  sysTenantQuotas,
} from "./schema.ts";

test("platform tables use the sys_ names from the spec", () => {
  assert.equal(getTableName(sysPlans), "sys_plans");
  assert.equal(getTableName(sysTenantQuotas), "sys_tenant_quotas");
  assert.equal(getTableName(sysSupportGrants), "sys_support_grants");
  assert.equal(getTableName(sysPlatformAuditEvents), "sys_platform_audit_events");
  assert.equal(getTableName(sysPlatformOperators), "sys_platform_operators");
});
