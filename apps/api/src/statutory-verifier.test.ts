import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyStatutoryPayload } from "./statutory-verifier.ts";

function readRepoJson(relativePath: string): unknown {
  const file = fileURLToPath(new URL(relativePath, import.meta.url));
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

test("the publish verifier rejects the shipped draft and accepts the labeled synthetic table", () => {
  const draft = verifyStatutoryPayload(
    readRepoJson("../../../packages/payroll-engine/src/tables/id-2026.draft.json"),
  );
  assert.equal(draft.ok, false);
  if (!draft.ok) assert.match(draft.message, /draft/);

  const synthetic = verifyStatutoryPayload(
    readRepoJson("../../../packages/payroll-engine/src/__tests__/fixtures/synthetic-pph21.json"),
  );
  assert.equal(synthetic.ok, true);
  if (synthetic.ok) {
    assert.equal(synthetic.ruleType, "pph21");
    assert.equal(synthetic.effectiveFrom, "2026-01-01");
  }
});
