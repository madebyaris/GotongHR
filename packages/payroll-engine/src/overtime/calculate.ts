import type { Idr } from "@gotonghr/contracts";
import { PayrollInputError } from "../errors.ts";
import { applyScaledRate, rupiah } from "../money.ts";
import { wholeCount } from "../whole-count.ts";
import {
  isOvertimeDayKind,
  overtimeSchedule,
  type OvertimeDayKind,
  type OvertimeSchedule,
} from "./schedules.ts";

const HOUR_DIVISOR = 173n;
const MINUTES_PER_HOUR = 60n;
const HALF_SCALE = 2n;

export interface OvertimeInput {
  readonly monthlyWage: bigint;
  readonly minutes: number;
  readonly dayKind: OvertimeDayKind;
}

export interface OvertimeResult {
  readonly dayKind: OvertimeDayKind;
  readonly minutes: number;
  readonly hourlyWage: Idr;
  readonly pay: Idr;
}

/**
 * Hourly overtime wage is monthlyWage / 173, rounded half up to the nearest rupiah.
 * A remainder of 87 or more out of 173 rounds up. A remainder of 86 stays down.
 * The caller passes the monthly wage basis. This function does not add allowances.
 */
export function overtimeHourlyWage(monthlyWage: bigint): Idr {
  return rupiah(applyScaledRate(requireWage(monthlyWage), 1n, HOUR_DIVISOR, "half_up"));
}

/**
 * PP 35/2021 overtime pay.
 * The hourly wage rounds half up, as overtimeHourlyWage states.
 * A partial hour is a pro-rata share of that hour's multiplier. Thirty minutes is half the hour.
 * The rupiah total is one half-up rounding of hourlyWage times the minute weights, divided by 60.
 * It does not round each minute on its own.
 * On a workday, pass overtime minutes only. Hour 1 is 1.5x and every later hour is 2x.
 * On a rest day or public holiday, pass the minutes worked that day, from the first hour.
 * Five-day rest or holiday: hours 1 to 8 at 2x, hour 9 at 3x, hours 10 to 12 at 4x.
 * Six-day rest or holiday: hours 1 to 7 at 2x, hour 8 at 3x, hours 9 to 11 at 4x.
 * A public holiday on the shortest day of a six-day week: hours 1 to 5 at 2x, hour 6 at 3x, hours 7 to 9 at 4x.
 * A normal short Saturday uses the workday schedule, and only the overtime minutes.
 * Minutes past the last hour of a rest or holiday schedule throw PayrollInputError.
 */
export function calculateOvertime(input: OvertimeInput): OvertimeResult {
  const hourlyWage = overtimeHourlyWage(input.monthlyWage);
  const minutes = wholeCount(input.minutes, "minutes", 0);
  if (!isOvertimeDayKind(input.dayKind)) {
    throw new PayrollInputError(
      "dayKind must be workday, five_day_rest_or_holiday, six_day_rest_or_holiday, or six_day_short_holiday.",
    );
  }
  const schedule = overtimeSchedule(input.dayKind);
  const weightedHalves = minuteWeights(minutes, input.dayKind, schedule);
  const pay = applyScaledRate(hourlyWage, weightedHalves, HALF_SCALE * MINUTES_PER_HOUR, "half_up");
  return {
    dayKind: input.dayKind,
    minutes,
    hourlyWage,
    pay: rupiah(pay),
  };
}

function requireWage(monthlyWage: bigint): bigint {
  if (typeof monthlyWage !== "bigint" || monthlyWage < 0n) {
    throw new PayrollInputError("monthlyWage must be non-negative bigint rupiah.");
  }
  return monthlyWage;
}

function minuteWeights(minutes: number, dayKind: OvertimeDayKind, schedule: OvertimeSchedule): bigint {
  if (schedule.maxMinutes !== null && minutes > schedule.maxMinutes) {
    throw new PayrollInputError(
      `${dayKind} prices at most ${schedule.maxMinutes.toString()} minutes.`,
    );
  }
  let weighted = 0n;
  let covered = 0;
  for (const band of schedule.bands) {
    const end = band.toMinute === null ? minutes : band.toMinute;
    const takeFrom = covered > band.fromMinute ? covered : band.fromMinute;
    const takeTo = minutes < end ? minutes : end;
    if (takeTo > takeFrom) {
      weighted += BigInt(takeTo - takeFrom) * BigInt(band.halves);
      covered = takeTo;
    }
  }
  if (covered !== minutes) {
    throw new PayrollInputError(`${dayKind} has no multiplier after ${covered.toString()} minutes.`);
  }
  return weighted;
}
