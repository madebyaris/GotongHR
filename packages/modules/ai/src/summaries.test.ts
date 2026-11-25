import assert from "node:assert/strict";
import test from "node:test";
import { curatedSummaries } from "./summaries.ts";

const expectedRefs = [
  "summary:pp-58-2023",
  "summary:pmk-168-2023",
  "summary:pp-35-2021",
  "summary:uu-pdp-27-2022",
];

test("curated summaries are short original notes with stable citation ids", () => {
  assert.deepEqual(
    curatedSummaries.map((item) => item.citationRef),
    expectedRefs,
  );
  const ids = new Set(curatedSummaries.map((item) => item.documentId));
  assert.equal(ids.size, curatedSummaries.length);
  for (const item of curatedSummaries) {
    assert.equal(item.content.toLowerCase().includes("not the statute"), true, item.citationRef);
    assert.equal(item.content.length < 800, true, item.citationRef);
    assert.equal(item.title.length > 0, true);
    assert.equal(/\b\d{10,}\b/u.test(item.content), false, item.citationRef);
  }
});
