import assert from "node:assert/strict";
import test from "node:test";
import { quoteIdentifier } from "./sql.ts";

test("quoteIdentifier rejects names longer than 63 bytes", () => {
  assert.equal(quoteIdentifier("a".repeat(63)), `"${"a".repeat(63)}"`);
  assert.throws(() => quoteIdentifier("a".repeat(64)), /invalid identifier/);
  assert.throws(() => quoteIdentifier(`${"a".repeat(62)}é`), /invalid identifier/);
});
