import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addIsoDays, contractExpiryDedupeKey, jakartaDate } from "./dates.ts";

describe("contract expiry dates", () => {
  it("uses the Asia/Jakarta calendar day", () => {
    assert.equal(jakartaDate(new Date("2026-11-24T17:30:00.000Z")), "2026-11-25");
    assert.equal(jakartaDate(new Date("2026-11-24T16:30:00.000Z")), "2026-11-24");
  });

  it("lands the 90, 60, and 30 day windows on real dates", () => {
    const noticeOn = "2026-11-25";
    assert.equal(addIsoDays(noticeOn, 30), "2026-12-25");
    assert.equal(addIsoDays(noticeOn, 60), "2027-01-24");
    assert.equal(addIsoDays(noticeOn, 90), "2027-02-23");
  });

  it("builds one dedupe key per contract, window, and day", () => {
    const contractId = "018f3a4c-7b2a-7c3d-8e4f-123456789abc";
    assert.equal(
      contractExpiryDedupeKey(contractId, 30, "2026-11-25"),
      "contract:018f3a4c-7b2a-7c3d-8e4f-123456789abc:window:30:on:2026-11-25",
    );
  });
});
