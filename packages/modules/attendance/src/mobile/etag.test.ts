import assert from "node:assert/strict";
import test from "node:test";
import { etagMatches, strongEtag } from "./etag.ts";

test("a strong etag matches itself, a weak copy, and a list", () => {
  const tag = strongEtag('{"data":1}');
  assert.equal(tag.startsWith('"'), true);
  assert.equal(etagMatches(tag, tag), true);
  assert.equal(etagMatches(`W/${tag}`, tag), true);
  assert.equal(etagMatches(`"other", ${tag}`, tag), true);
  assert.equal(etagMatches("*", tag), true);
  assert.equal(etagMatches('"other"', tag), false);
  assert.equal(etagMatches(undefined, tag), false);
});

test("the same bytes keep the same etag", () => {
  assert.equal(strongEtag("abc"), strongEtag("abc"));
  assert.notEqual(strongEtag("abc"), strongEtag("abd"));
});
