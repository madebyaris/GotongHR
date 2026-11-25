import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { employeePiiFields, parseEmployeeNik, parseEmployeeNpwp } from "@gotonghr/contracts";
import { piiFields } from "@gotonghr/crypto";

describe("NIK and NPWP", () => {
  it("accepts a male date and a female day+40 date", () => {
    assert.equal(parseEmployeeNik("3273011508950001").ok, true);
    assert.equal(parseEmployeeNik("3273015508950001").ok, true);
    assert.equal(parseEmployeeNik(" 3273017101000001 ").ok, true);
    assert.equal(parseEmployeeNik("3273012902000001").ok, true);
  });

  it("rejects a bad length, a zero region, and a date that is not real", () => {
    assert.equal(message(parseEmployeeNik("327301150895000")), "NIK must be 16 digits.");
    assert.equal(message(parseEmployeeNik("32730115089500011")), "NIK must be 16 digits.");
    assert.equal(message(parseEmployeeNik("3273-0115-0895-0001")), "NIK must be 16 digits.");
    assert.equal(message(parseEmployeeNik("0073011508950001")), "NIK region code is not valid.");
    assert.equal(message(parseEmployeeNik("3200011508950001")), "NIK region code is not valid.");
    assert.equal(message(parseEmployeeNik("3273001508950001")), "NIK region code is not valid.");
    assert.equal(message(parseEmployeeNik("3273013208950001")), "NIK birth date is not a real date.");
    assert.equal(message(parseEmployeeNik("3273012902010001")), "NIK birth date is not a real date.");
    assert.equal(message(parseEmployeeNik("3273013104000001")), "NIK birth date is not a real date.");
    assert.equal(message(parseEmployeeNik("3273017104000001")), "NIK birth date is not a real date.");
    assert.equal(message(parseEmployeeNik("3273014008950001")), "NIK birth date is not a real date.");
    assert.equal(message(parseEmployeeNik("3273017208950001")), "NIK birth date is not a real date.");
  });

  it("accepts 15 or 16 NPWP digits and rejects anything else", () => {
    assert.deepEqual(parseEmployeeNpwp(undefined), { ok: true, value: null });
    assert.deepEqual(parseEmployeeNpwp("   "), { ok: true, value: null });
    assert.deepEqual(parseEmployeeNpwp("123456789012345"), { ok: true, value: "123456789012345" });
    assert.deepEqual(parseEmployeeNpwp("1234567890123456"), { ok: true, value: "1234567890123456" });
    assert.equal(message(parseEmployeeNpwp("12345678901234")), "NPWP must be 15 or 16 digits.");
    assert.equal(message(parseEmployeeNpwp("12.3456789012345")), "NPWP must be 15 or 16 digits.");
  });

  it("keeps the PII field list aligned with the crypto package", () => {
    assert.deepEqual(employeePiiFields, piiFields);
  });
});

function message(result: { ok: boolean; message?: string }): string {
  return result.ok ? "" : (result.message ?? "");
}
