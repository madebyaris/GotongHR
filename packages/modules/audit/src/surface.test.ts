import assert from "node:assert/strict";
import test from "node:test";
import * as audit from "./index.ts";

test("the audit barrel does not export revealPii", () => {
  assert.equal("revealPii" in audit, false);
  assert.equal("decryptField" in audit, false);
  assert.equal(typeof audit.auditedUpdate, "function");
  assert.equal(typeof audit.appendAuditEvent, "function");
  assert.equal(typeof audit.enqueueOutboxEvent, "function");
  assert.equal(typeof audit.provisionTenantKeys, "function");
});
