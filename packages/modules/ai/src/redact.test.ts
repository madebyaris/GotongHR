import assert from "node:assert/strict";
import test from "node:test";
import { RedactionSession } from "./redact.ts";

const NIK = "3175012345670001";
const NPWP = "09.876.543.2-109.000";
const NPWP_PLAIN = "098765432109000";
const BANK = "123456789012";
const PHONE = "+6281234567890";
const LOCAL = "081298765432";
const EMAIL = "andi.hr@example.co.id";

test("redact replaces each PII kind and restore puts the same value back", () => {
  const session = new RedactionSession();
  const source = `NIK ${NIK}, NPWP ${NPWP}, plain ${NPWP_PLAIN}, rekening ${BANK}, ${PHONE}, ${LOCAL}, ${EMAIL}`;
  const redacted = session.redact(source);
  const encoded = JSON.stringify(session.redactValue({ note: source, nested: [source] }));
  for (const sample of [NIK, NPWP, NPWP_PLAIN, BANK, PHONE, LOCAL, EMAIL]) {
    assert.equal(redacted.includes(sample), false, sample);
    assert.equal(encoded.includes(sample), false, sample);
  }
  assert.match(redacted, /\[EMP_01_NIK\]/u);
  assert.match(redacted, /\[EMP_01_NPWP\]/u);
  assert.match(redacted, /\[EMP_01_BANK\]/u);
  assert.match(redacted, /\[EMP_01_PHONE\]/u);
  assert.match(redacted, /\[EMP_01_EMAIL\]/u);
  assert.equal(session.restore(redacted), source);
  assert.equal(session.redact(EMAIL), "[EMP_01_EMAIL]");
});

test("a rupiah amount is not treated as a bank account", () => {
  const session = new RedactionSession();
  const source = "gaji Rp 5000000 dan idr 88888888";
  assert.equal(session.redact(source), source);
});

test("a uuid is not treated as a bank account", () => {
  const session = new RedactionSession();
  const source = "employee 11111111-1111-4111-8111-111111111111";
  assert.equal(session.redact(source), source);
});
