import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("contract expiry surface", () => {
  it("records an outbox event and does not send email", () => {
    const source = readFileSync(new URL("./expiry.ts", import.meta.url), "utf8");
    assert.equal(source.includes("core_hr.contract_expiring"), true);
    assert.equal(source.includes("sendMail"), false);
    assert.equal(source.includes("nodemailer"), false);
    assert.equal(source.includes("ON CONFLICT (tenant_id, dedupe_key) DO NOTHING"), true);
  });
});
