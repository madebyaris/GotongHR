import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PAYROLL_BATCH_SIZE } from "./ports.ts";
import { chunk } from "./period.ts";

describe("payroll batches", () => {
  it("keeps each job at 100 employees", () => {
    const oneHundredOne = chunk(
      Array.from({ length: 101 }, (_, index) => index),
      PAYROLL_BATCH_SIZE,
    );
    assert.deepEqual(
      oneHundredOne.map((batch) => batch.length),
      [100, 1],
    );
    const twoHundredFifty = chunk(
      Array.from({ length: 250 }, (_, index) => index),
      PAYROLL_BATCH_SIZE,
    );
    assert.deepEqual(
      twoHundredFifty.map((batch) => batch.length),
      [100, 100, 50],
    );
  });
});
