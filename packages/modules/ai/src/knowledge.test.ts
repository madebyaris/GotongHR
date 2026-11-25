import assert from "node:assert/strict";
import test from "node:test";
import { keywordQuery } from "./knowledge.ts";

test("keywordQuery keeps PP 58 and drops question words", () => {
  assert.equal(keywordQuery("What does PP 58 say about withholding?"), "pp | 58 | withholding");
  assert.equal(keywordQuery("the"), null);
  assert.equal(keywordQuery("lembur PKWT"), "lembur | pkwt");
});
