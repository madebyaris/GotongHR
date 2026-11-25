import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  annualEntitlement,
  completedMonths,
  defaultLeaveTypes,
  deriveDayType,
  inclusiveDays,
  monthBounds,
  readHolidayFile,
  weekdayUtc,
} from "./calendar.ts";

describe("schedule calendar", () => {
  it("reads the 2026 SKB file as draft and does not treat a plain Saturday as a holiday", () => {
    const file = readHolidayFile();
    assert.equal(file.status, "draft");
    assert.equal(file.calendar, "skb_3_menteri");
    assert.equal(file.year, 2026);
    assert.match(file.note, /do not scrape/iu);
    const dates = new Set(file.holidays.map((holiday) => holiday.date));
    assert.equal(dates.has("2026-01-01"), true);
    assert.equal(dates.has("2026-01-03"), false);
    assert.equal(dates.has("2026-08-17"), true);
    const bersama = defaultLeaveTypes.find((type) => type.code === "cuti_bersama");
    const tahunan = defaultLeaveTypes.find((type) => type.code === "cuti_tahunan");
    assert.equal(bersama?.deductsAnnual, true);
    assert.equal(bersama?.deductionToggle, true);
    assert.equal(tahunan?.entitlementDays, 12);
    assert.equal(tahunan?.tenureMonths, 12);
    assert.equal(defaultLeaveTypes.length, 9);
  });

  it("derives a 5-day weekend, a Sunday on a 6-day week, and a holiday over both", () => {
    assert.equal(weekdayUtc("2026-01-01"), 4);
    assert.equal(weekdayUtc("2026-01-03"), 6);
    assert.equal(weekdayUtc("2026-01-04"), 0);
    const holidays = new Set(["2026-01-01", "2026-01-10"]);
    assert.equal(deriveDayType("2026-01-02", "5_day", holidays), "workday");
    assert.equal(deriveDayType("2026-01-03", "5_day", holidays), "weekend");
    assert.equal(deriveDayType("2026-01-04", "5_day", holidays), "weekend");
    assert.equal(deriveDayType("2026-01-01", "5_day", holidays), "national_holiday");
    assert.equal(deriveDayType("2026-01-10", "5_day", holidays), "national_holiday");
    assert.equal(deriveDayType("2026-01-03", "6_day", holidays), "workday");
    assert.equal(deriveDayType("2026-01-04", "6_day", holidays), "weekend");
    assert.equal(deriveDayType("2026-01-10", "6_day", holidays), "national_holiday");
  });

  it("counts tenure, inclusive leave days, and month bounds", () => {
    assert.equal(completedMonths("2024-01-15", "2025-01-14"), 11);
    assert.equal(completedMonths("2024-01-15", "2025-01-15"), 12);
    assert.equal(annualEntitlement("2024-01-15", "2025-01-14"), 0);
    assert.equal(annualEntitlement("2024-01-15", "2025-01-15"), 12);
    assert.equal(annualEntitlement("2026-06-02", "2026-06-01"), null);
    assert.equal(inclusiveDays("2026-06-01", "2026-06-02"), 2);
    assert.equal(inclusiveDays("2026-06-02", "2026-06-01"), null);
    assert.deepEqual(monthBounds("2026-04"), { start: "2026-04-01", end: "2026-04-30" });
    assert.deepEqual(monthBounds("2026-02"), { start: "2026-02-01", end: "2026-02-28" });
    assert.equal(monthBounds("2026-13"), null);
  });
});
