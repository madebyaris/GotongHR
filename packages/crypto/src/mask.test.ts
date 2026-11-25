import assert from "node:assert/strict";
import test from "node:test";
import { maskBankAccount, maskNik, maskNpwp, maskPii } from "./mask.ts";

const nik = "3273011508950001";

test("maskNik hides the middle eight digits", () => {
  const masked = maskNik(nik);
  assert.equal(masked, "3273********0001");
  assert.equal(masked.includes("01150895"), false);
  assert.equal(masked.includes(nik.slice(4, 12)), false);
  assert.equal(masked.length, 16);
});

test("maskNpwp hides the middle digits of 15- and 16-digit values", () => {
  const sixteen = maskNpwp("12.345.678.9-012.3456");
  assert.equal(sixteen, "1234********3456");
  assert.equal(sixteen.includes("56789012"), false);
  const fifteen = maskNpwp("01.234.567.8-901.000");
  assert.equal(fifteen, "01*********1000");
  assert.equal(fifteen.includes("234567890"), false);
  assert.throws(() => maskNpwp("1234"), /15 or 16/);
  assert.throws(() => maskNpwp("12.345.678.9-012.3456a"), /invalid character/);
});

test("maskBankAccount keeps only the last four digits", () => {
  assert.equal(maskBankAccount("1234567890"), "******7890");
  assert.equal(maskBankAccount("1234-5678-9012"), "********9012");
  assert.equal(maskBankAccount("1234567890").includes("123456"), false);
  assert.throws(() => maskBankAccount("1234"), /8 to 20/);
  assert.throws(() => maskBankAccount("1234-5678-9012x"), /invalid character/);
});

test("maskPii covers every PII field and hides the middle digits", () => {
  assert.equal(maskPii("nik", nik), "3273********0001");
  assert.equal(maskPii("npwp", "12.345.678.9-012.3456"), "1234********3456");
  assert.equal(maskPii("kk_number", "3273 0115 0895 0001"), "3273********0001");
  assert.equal(maskPii("bpjs_kesehatan_no", "0001234567890"), "0001*****7890");
  assert.equal(maskPii("bpjs_tk_no", "12345678901"), "1234***8901");
  assert.equal(maskPii("bank_account_number", "1234567890"), "******7890");
  assert.equal(maskPii("kk_number", "3273 0115 0895 0001").includes("01150895"), false);
  assert.throws(() => maskPii("bpjs_kesehatan_no", "0001234567890a"), /invalid character/);
  assert.throws(() => maskPii("bpjs_tk_no", "12345 67890x"), /invalid character/);
});
