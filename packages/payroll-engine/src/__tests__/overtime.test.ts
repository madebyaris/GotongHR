import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  PayrollInputError,
  calculateOvertime,
  overtimeDayKinds,
  overtimeHourlyWage,
  type OvertimeDayKind,
} from "../index.ts";

const hourly = 200n;
const wage = hourly * 173n;

function pay(minutes: number, dayKind: OvertimeDayKind): bigint {
  return calculateOvertime({ monthlyWage: wage, minutes, dayKind }).pay;
}

test("hourly wage rounds half up, so a remainder of 86 stays down and 87 rounds up", () => {
  assert.equal(overtimeHourlyWage(0n), 0n);
  assert.equal(overtimeHourlyWage(86n), 0n);
  assert.equal(overtimeHourlyWage(87n), 1n);
  assert.equal(overtimeHourlyWage(173n * 10n + 86n), 10n);
  assert.equal(overtimeHourlyWage(173n * 10n + 87n), 11n);
  assert.equal(overtimeHourlyWage(wage), hourly);
  assert.throws(() => overtimeHourlyWage(-1n), PayrollInputError);
});

test("workday hour 1 is 1.5x and later hours are 2x", () => {
  const result = calculateOvertime({ monthlyWage: wage, minutes: 0, dayKind: "workday" });
  assert.equal(result.pay, 0n);
  assert.equal(result.hourlyWage, hourly);
  assert.equal(pay(60, "workday"), 300n);
  assert.equal(pay(120, "workday"), 700n);
  assert.equal(pay(180, "workday"), 1_100n);
});

test("a 30-minute slice of a 2x hour is half that hour multiplier", () => {
  assert.equal(pay(90, "workday"), 500n);
});

test("pro-rata 30-minute slice of a 1.5x hour rounds half up", () => {
  assert.equal(calculateOvertime({ monthlyWage: 173n, minutes: 30, dayKind: "workday" }).pay, 1n);
  assert.equal(calculateOvertime({ monthlyWage: 346n, minutes: 30, dayKind: "workday" }).pay, 2n);
  assert.equal(calculateOvertime({ monthlyWage: 519n, minutes: 30, dayKind: "workday" }).pay, 2n);
});

test("five-day rest hour 8 is 2x and hour 9 is 3x", () => {
  assert.equal(pay(8 * 60, "five_day_rest_or_holiday"), 3_200n);
  assert.equal(pay(8 * 60 + 1, "five_day_rest_or_holiday"), 3_210n);
  assert.equal(pay(9 * 60, "five_day_rest_or_holiday"), 3_800n);
  assert.equal(pay(9 * 60 + 1, "five_day_rest_or_holiday"), 3_813n);
  assert.equal(pay(12 * 60, "five_day_rest_or_holiday"), 6_200n);
  assert.equal(pay(8 * 60 + 30, "five_day_rest_or_holiday"), 3_500n);
});

test("six-day rest hour 7 is 2x, hour 8 is 3x, and hour 9 is 4x", () => {
  assert.equal(pay(7 * 60, "six_day_rest_or_holiday"), 2_800n);
  assert.equal(pay(7 * 60 + 1, "six_day_rest_or_holiday"), 2_810n);
  assert.equal(pay(8 * 60, "six_day_rest_or_holiday"), 3_400n);
  assert.equal(pay(8 * 60 + 1, "six_day_rest_or_holiday"), 3_413n);
  assert.equal(pay(9 * 60, "six_day_rest_or_holiday"), 4_200n);
  assert.equal(pay(11 * 60, "six_day_rest_or_holiday"), 5_800n);
});

test("six-day short holiday hour 5 is 2x, hour 6 is 3x, and hours 7 to 9 are 4x", () => {
  assert.equal(pay(5 * 60, "six_day_short_holiday"), 2_000n);
  assert.equal(pay(5 * 60 + 1, "six_day_short_holiday"), 2_010n);
  assert.equal(pay(6 * 60, "six_day_short_holiday"), 2_600n);
  assert.equal(pay(6 * 60 + 1, "six_day_short_holiday"), 2_613n);
  assert.equal(pay(7 * 60, "six_day_short_holiday"), 3_400n);
  assert.equal(pay(9 * 60, "six_day_short_holiday"), 5_000n);
});

test("rest and holiday minutes past the last multiplier are rejected", () => {
  assert.throws(() => pay(12 * 60 + 1, "five_day_rest_or_holiday"), PayrollInputError);
  assert.throws(() => pay(11 * 60 + 1, "six_day_rest_or_holiday"), PayrollInputError);
  assert.throws(() => pay(9 * 60 + 1, "six_day_short_holiday"), PayrollInputError);
  assert.equal(pay(24 * 60, "workday") > pay(12 * 60, "workday"), true);
});

test("overtime rejects a negative wage, a fractional minute, and an unknown day", () => {
  assert.throws(
    () => calculateOvertime({ monthlyWage: -1n, minutes: 60, dayKind: "workday" }),
    PayrollInputError,
  );
  assert.throws(
    () => calculateOvertime({ monthlyWage: wage, minutes: -1, dayKind: "workday" }),
    PayrollInputError,
  );
  assert.throws(
    () => calculateOvertime({ monthlyWage: wage, minutes: 30.5, dayKind: "workday" }),
    PayrollInputError,
  );
  assert.throws(
    () =>
      calculateOvertime({
        monthlyWage: wage,
        minutes: 60,
        dayKind: "holiday" as OvertimeDayKind,
      }),
    PayrollInputError,
  );
  assert.deepEqual(overtimeDayKinds, [
    "workday",
    "five_day_rest_or_holiday",
    "six_day_rest_or_holiday",
    "six_day_short_holiday",
  ]);
});

test("workday overtime pay does not fall when the minutes rise", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 600 }),
      fc.integer({ min: 0, max: 600 }),
      fc.bigInt({ min: 0n, max: 30_000_000n }),
      (left, right, monthlyWage) => {
        const low = Math.min(left, right);
        const high = Math.max(left, right);
        const first = calculateOvertime({ monthlyWage, minutes: low, dayKind: "workday" }).pay;
        const second = calculateOvertime({ monthlyWage, minutes: high, dayKind: "workday" }).pay;
        return first <= second;
      },
    ),
    { seed: 20261125, numRuns: 40 },
  );
});
