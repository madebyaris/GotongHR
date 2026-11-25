import assert from "node:assert/strict";
import test from "node:test";
import { redactPii, scrubFreeTextPii } from "./redact.ts";

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
  const hashed = redactPii({ bpjs_tk_no_hash: "abc123" }) as Record<string, string>;
  assert.equal(hashed.bpjs_tk_no_hash, "[redacted]");
});

test("redactPii redacts toJSON output and keeps dates and proto keys", () => {
  const when = new Date("2026-11-25T01:02:03.000Z");
  const hidden = {
    label: "ok",
    toJSON() {
      return { nik: "3273011508950001", label: "ok", created: when };
    },
  };
  const redacted = redactPii(hidden) as { nik: string; label: string; created: string };
  assert.equal(redacted.nik, "[redacted]");
  assert.equal(redacted.label, "ok");
  assert.equal(redacted.created, "2026-11-25T01:02:03.000Z");
  assert.equal(JSON.stringify(redacted).includes("3273011508950001"), false);
  assert.equal("toJSON" in redacted, false);

  const withProto: Record<string, unknown> = { label: "ok" };
  Object.defineProperty(withProto, "__proto__", {
    value: { nik: "3273011508950001" },
    enumerable: true,
  });
  const kept = redactPii(withProto) as Record<string, unknown>;
  const proto = kept["__proto__"] as { nik: string };
  assert.equal(proto.nik, "[redacted]");
  assert.equal(Object.getPrototypeOf(kept), null);
  assert.equal(JSON.stringify(kept).includes("3273011508950001"), false);
});

test("scrubFreeTextPii removes raw NIK, NPWP, bank, phone, and email from strings", () => {
  const scrubbed = scrubFreeTextPii({
    note: "NIK 3175012345670001 NPWP 09.876.543.2-109.000 rekening 123456789012 +6281234567890 andi.hr@example.co.id",
    city: "Jakarta",
  }) as { note: string; city: string };
  const encoded = JSON.stringify(scrubbed);
  assert.equal(encoded.includes("3175012345670001"), false);
  assert.equal(encoded.includes("09.876.543.2-109.000"), false);
  assert.equal(encoded.includes("123456789012"), false);
  assert.equal(encoded.includes("+6281234567890"), false);
  assert.equal(encoded.includes("andi.hr@example.co.id"), false);
  assert.equal(scrubbed.city, "Jakarta");
});

test("redactPii copies a shared object and still rejects a cycle", () => {
  const shared = { city: "Jakarta", nik: "3273011508950001" };
  const redacted = redactPii({ left: shared, right: shared }) as {
    left: { city: string; nik: string };
    right: { city: string; nik: string };
  };
  assert.equal(redacted.left.city, "Jakarta");
  assert.equal(redacted.right.city, "Jakarta");
  assert.equal(redacted.left.nik, "[redacted]");
  assert.equal(redacted.right.nik, "[redacted]");
  assert.equal(JSON.stringify(redacted).includes("3273011508950001"), false);

  const cycle: { label: string; self?: unknown } = { label: "loop" };
  cycle.self = cycle;
  assert.throws(() => redactPii(cycle), /cycle/);
});
