import assert from "node:assert/strict";
import test from "node:test";
import { buildCoretaxSlip, validateCoretaxXml } from "../index.ts";
import { bpmp, withholder } from "./coretax-fixture.ts";

test("coretax XSD validation", (t) => {
  const xml = buildCoretaxSlip(withholder, bpmp());
  const result = validateCoretaxXml({ xml, slipType: "BPMP" });
  if (result.status === "skipped") {
    assert.equal(result.reason, "xsd missing");
    process.stdout.write("xsd missing\n");
    t.skip("xsd missing");
    return;
  }
  if (result.status === "unavailable") {
    t.skip("xmllint unavailable");
    return;
  }
  assert.equal(result.status, "valid");
});
