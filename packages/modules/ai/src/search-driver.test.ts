import assert from "node:assert/strict";
import test from "node:test";
import { readSearchDriver } from "./search-driver.ts";

test("search defaults to keyword and does not enable vector", () => {
  assert.equal(readSearchDriver({}), "keyword");
  assert.equal(readSearchDriver({ SEARCH_DRIVER: "keyword" }), "keyword");
  assert.equal(readSearchDriver({ SEARCH_DRIVER: " vector " }), "unsupported");
  assert.equal(readSearchDriver({ SEARCH_DRIVER: "vector" }), "unsupported");
});
