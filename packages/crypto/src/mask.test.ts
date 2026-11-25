import assert from "node:assert/strict";
import test from "node:test";
import { maskBankAccount, maskNik, maskNpwp } from "./mask.ts";

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
});

test("maskBankAccount keeps only the last four digits", () => {
  assert.equal(maskBankAccount("1234567890"), "******7890");
  assert.equal(maskBankAccount("1234-5678-9012"), "********9012");
  assert.equal(maskBankAccount("1234567890").includes("123456"), false);
  assert.throws(() => maskBankAccount("1234"), /8 to 20/);
});
