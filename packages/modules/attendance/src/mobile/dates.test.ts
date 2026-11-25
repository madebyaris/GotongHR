import assert from "node:assert/strict";
import test from "node:test";
import { addIsoDays, hhmm, localIsoDate } from "./dates.ts";

test("local today follows the branch timezone", () => {
  const evening = new Date("2026-11-24T17:30:00.000Z");
  assert.equal(localIsoDate(evening, "Asia/Jakarta"), "2026-11-25");
  assert.equal(localIsoDate(evening, "UTC"), "2026-11-24");
  assert.equal(localIsoDate(new Date("2026-11-25T02:00:00.000Z"), "Asia/Jakarta"), "2026-11-25");
});

test("adding days stays on the calendar", () => {
  assert.equal(addIsoDays("2026-11-25", 13), "2026-12-08");
  assert.equal(addIsoDays("2026-12-31", 1), "2027-01-01");
});

test("shift times drop seconds", () => {
  assert.equal(hhmm("08:00:00"), "08:00");
  assert.equal(hhmm("17:05"), "17:05");
});
