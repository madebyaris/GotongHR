import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("employee read surface", () => {
  it("does not decrypt or select ciphertext", () => {
    const read = readFileSync(new URL("./read.ts", import.meta.url), "utf8");
    assert.equal(read.includes("decrypt"), false);
    assert.equal(read.includes("_enc"), false);
    assert.equal(read.includes("revealPii"), false);
    assert.equal(read.includes("nik_hash"), false);
  });

  it("keeps decrypt and reveal out of the write path", () => {
    const write = readFileSync(new URL("./write.ts", import.meta.url), "utf8");
    assert.equal(write.includes("decryptField"), false);
    assert.equal(write.includes("revealPii"), false);
  });
});
