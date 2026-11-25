import assert from "node:assert/strict";
import test from "node:test";
import { chunkText, MAX_SOP_CHUNKS } from "./chunk.ts";

test("chunkText keeps a short note in one chunk", () => {
  assert.deepEqual(chunkText("Line one.\n\nLine two."), ["Line one.\nLine two."]);
});

test("chunkText splits a long paragraph and rejects a document past the cap", () => {
  const parts = chunkText("a".repeat(2_000));
  assert.ok(parts);
  assert.equal(parts.join(""), "a".repeat(2_000));
  assert.equal(parts.length > 1, true);
  assert.deepEqual(chunkText("  \n"), []);
  assert.equal(chunkText("b".repeat(900 * MAX_SOP_CHUNKS + 1)), null);
});
