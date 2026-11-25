import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { blindIndex } from "./blind-index.ts";
import { PiiCryptoError } from "./errors.ts";
import { decodeKek, loadKek } from "./kek.ts";
import { generateKey, unwrapDek, unwrapPepper, wrapDek, wrapPepper } from "./keys.ts";
import { decryptField, encryptField } from "./pii.ts";
import type { PiiField } from "./fields.ts";

const tenantA = "11111111-1111-7111-8111-111111111111";
const tenantB = "22222222-2222-7222-8222-222222222222";
const nik = "3273011508950001";
const kek = Buffer.alloc(32, 0x7a);

function bitFlip(envelope: string): string {
  const packed = Buffer.from(envelope, "base64url");
  const last = packed.length - 1;
  const byte = packed[last];
  if (byte === undefined) throw new Error("empty envelope");
  packed[last] = byte ^ 0xff;
  return packed.toString("base64url");
}

test("loadKek reads hex and base64 and rejects a placeholder", () => {
  const hex = kek.toString("hex");
  assert.deepEqual(loadKek({ GOTONG_PII_KEK: hex }), kek);
  assert.deepEqual(loadKek({ GOTONG_PII_KEK: kek.toString("base64") }), kek);
  assert.deepEqual(loadKek({ GOTONG_PII_KEK: kek.toString("base64url") }), kek);
  assert.throws(() => loadKek({}), /Missing GOTONG_PII_KEK/);
  assert.throws(
    () => decodeKek("replace-with-32-byte-base64-or-hex"),
    /32 bytes/,
  );
  assert.throws(() => decodeKek(`${hex}aa`), /32 bytes/);
  assert.throws(() => decodeKek(kek.subarray(0, 16).toString("base64")), /32 bytes/);
});

test("ciphertext is not the plaintext and a fresh IV changes the envelope", () => {
  const dek = generateKey();
  const first = encryptField(dek, tenantA, "nik", nik);
  const second = encryptField(dek, tenantA, "nik", nik);
  assert.notEqual(first, nik);
  assert.equal(first.includes(nik), false);
  assert.notEqual(first, second);
  assert.equal(decryptField(dek, tenantA, "nik", first), nik);
  const packed = Buffer.from(first, "base64url");
  assert.equal(packed[0], 1);
  assert.equal(packed.length > 29, true);
});

test("tampered ciphertext or a different AAD fails authentication", () => {
  const dek = generateKey();
  const envelope = encryptField(dek, tenantA, "nik", nik);
  assert.throws(
    () => decryptField(dek, tenantA, "nik", bitFlip(envelope)),
    (error: unknown) => error instanceof PiiCryptoError && /authentication/.test(error.message),
  );
  const otherFields: PiiField[] = ["npwp", "kk_number", "bpjs_kesehatan_no", "bpjs_tk_no", "bank_account_number"];
  for (const field of otherFields) {
    assert.throws(
      () => decryptField(dek, tenantA, field, envelope),
      (error: unknown) => error instanceof PiiCryptoError,
    );
  }
  assert.throws(
    () => decryptField(dek, tenantB, "nik", envelope),
    (error: unknown) => error instanceof PiiCryptoError,
  );
  assert.throws(
    () => decryptField(generateKey(), tenantA, "nik", envelope),
    (error: unknown) => error instanceof PiiCryptoError,
  );
  const version = Buffer.from(envelope, "base64url");
  version[0] = 2;
  assert.throws(
    () => decryptField(dek, tenantA, "nik", version.toString("base64url")),
    /unsupported envelope version/,
  );
});

test("the same NIK and pepper hash alike, and a different pepper does not", () => {
  const pepperA = generateKey();
  const pepperB = generateKey();
  const first = blindIndex(pepperA, nik);
  assert.equal(blindIndex(pepperA, `  ${nik}  `), first);
  assert.equal(first.length, 64);
  assert.notEqual(blindIndex(pepperB, nik), first);
  assert.notEqual(pepperA.equals(pepperB), true);
  assert.throws(() => blindIndex(pepperA, "   "), /empty/);
});

test("a wrapped DEK and pepper round-trip only with the matching AAD", () => {
  const dek = generateKey();
  const pepper = generateKey();
  const wrappedDek = wrapDek(kek, dek, tenantA);
  const wrappedPepper = wrapPepper(kek, pepper, tenantA);
  assert.notEqual(wrappedDek, dek.toString("base64url"));
  assert.deepEqual(unwrapDek(kek, wrappedDek, tenantA), dek);
  assert.deepEqual(unwrapPepper(kek, wrappedPepper, tenantA), pepper);
  assert.throws(
    () => unwrapDek(kek, wrappedPepper, tenantA),
    (error: unknown) => error instanceof PiiCryptoError,
  );
  assert.throws(
    () => unwrapDek(kek, wrappedDek, tenantB),
    (error: unknown) => error instanceof PiiCryptoError,
  );
  assert.throws(
    () => unwrapPepper(kek, wrappedPepper, randomUUID()),
    (error: unknown) => error instanceof PiiCryptoError,
  );
});
