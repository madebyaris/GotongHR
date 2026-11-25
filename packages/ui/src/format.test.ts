import assert from "node:assert/strict";
import test from "node:test";
import { formatDate, formatIdr } from "./format.ts";

test("formatIdr groups integer rupiah", () => {
  assert.equal(formatIdr(0n), "Rp0");
  assert.equal(formatIdr(1500000n), "Rp1.500.000");
  assert.equal(formatIdr(-1500000n, "en-ID"), "-IDR 1,500,000");
  assert.throws(() => formatIdr(1 as never), /bigint/);
});

test("formatDate renders id-ID and en-ID in Jakarta", () => {
  // 18:00 UTC is still 14 January in UTC and already 15 January in Jakarta.
  const value = new Date("2026-01-14T18:00:00.000Z");
  const indonesian = formatDate(value, "id-ID");
  const english = formatDate(value, "en-ID");
  assert.match(indonesian, /15/);
  assert.match(indonesian, /2026/);
  assert.match(english, /15/);
  assert.match(english, /2026/);
  assert.doesNotMatch(indonesian, /\b14\b/);
  assert.doesNotMatch(english, /\b14\b/);
  assert.throws(() => formatDate(new Date("not-a-date"), "id-ID"), /valid Date/);
});
