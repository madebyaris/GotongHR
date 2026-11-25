import assert from "node:assert/strict";
import test from "node:test";
import { redactPii } from "./redact.ts";

test("redactPii replaces PII keys and keeps the other fields", () => {
  const redacted = redactPii({
    label: "Sari",
    nik: "3273011508950001",
    nik_enc: "ciphertext",
    nested: {
      bankAccountNumber: "1234567890",
      city: "Jakarta",
    },
    rows: [{ npwp: "012345678901234", nickname: "Sari" }],
  }) as {
    label: string;
    nik: string;
    nik_enc: string;
    nested: { bankAccountNumber: string; city: string };
    rows: Array<{ npwp: string; nickname: string }>;
  };

  assert.equal(redacted.label, "Sari");
  assert.equal(redacted.nik, "[redacted]");
  assert.equal(redacted.nik_enc, "[redacted]");
  assert.equal(redacted.nested.bankAccountNumber, "[redacted]");
  assert.equal(redacted.nested.city, "Jakarta");
  assert.equal(redacted.rows[0]?.npwp, "[redacted]");
  assert.equal(redacted.rows[0]?.nickname, "Sari");
  assert.equal(JSON.stringify(redacted).includes("3273011508950001"), false);
  assert.equal(JSON.stringify(redacted).includes("1234567890"), false);
  const columns = redactPii({
    bank_account_number_enc: "sealed-account",
    bpjs_kesehatan_no_enc: "sealed-health",
    bpjs_tk_no_enc: "sealed-tk",
    bank_name: "BCA",
  }) as Record<string, string>;
  assert.equal(columns.bank_account_number_enc, "[redacted]");
  assert.equal(columns.bpjs_kesehatan_no_enc, "[redacted]");
  assert.equal(columns.bpjs_tk_no_enc, "[redacted]");
  assert.equal(columns.bank_name, "BCA");
});
