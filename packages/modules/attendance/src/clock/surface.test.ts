import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("clock storage surface", () => {
  it("keeps selfie bytes out of the table and inserts with the idempotency conflict clause", () => {
    const migrate = readFileSync(new URL("./migrate.ts", import.meta.url), "utf8");
    const service = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
    assert.equal(migrate.includes("bytea"), false);
    assert.match(migrate, /selfie_storage_key text/);
    assert.match(migrate, /FORCE ROW LEVEL SECURITY|tenantIsolationPolicySql/);
    assert.match(service, /ON CONFLICT \(tenant_id, idempotency_key\) DO NOTHING/);
    assert.equal(service.includes("bytea"), false);
  });
});
