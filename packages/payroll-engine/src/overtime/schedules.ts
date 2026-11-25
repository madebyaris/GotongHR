export const overtimeDayKinds = [
  "workday",
  "five_day_rest_or_holiday",
  "six_day_rest_or_holiday",
  "six_day_short_holiday",
] as const;

export type OvertimeDayKind = (typeof overtimeDayKinds)[number];

export interface OvertimeBand {
  /** Inclusive start, in minutes from the beginning of the priced period. */
  readonly fromMinute: number;
  /** Exclusive end. Null means the band runs to the end of the passed minutes. */
  readonly toMinute: number | null;
  /** Multiplier in halves. 3 is 1.5x, 4 is 2x, 6 is 3x, and 8 is 4x. */
  readonly halves: 3 | 4 | 6 | 8;
}

export interface OvertimeSchedule {
  readonly maxMinutes: number | null;
  readonly bands: readonly OvertimeBand[];
}

const schedules: Record<OvertimeDayKind, OvertimeSchedule> = {
  workday: schedule("workday", null, [
    { fromMinute: 0, toMinute: 60, halves: 3 },
    { fromMinute: 60, toMinute: null, halves: 4 },
  ]),
  five_day_rest_or_holiday: schedule("five_day_rest_or_holiday", 12 * 60, [
    { fromMinute: 0, toMinute: 8 * 60, halves: 4 },
    { fromMinute: 8 * 60, toMinute: 9 * 60, halves: 6 },
    { fromMinute: 9 * 60, toMinute: 12 * 60, halves: 8 },
  ]),
  six_day_rest_or_holiday: schedule("six_day_rest_or_holiday", 11 * 60, [
    { fromMinute: 0, toMinute: 7 * 60, halves: 4 },
    { fromMinute: 7 * 60, toMinute: 8 * 60, halves: 6 },
    { fromMinute: 8 * 60, toMinute: 11 * 60, halves: 8 },
  ]),
  six_day_short_holiday: schedule("six_day_short_holiday", 9 * 60, [
    { fromMinute: 0, toMinute: 5 * 60, halves: 4 },
    { fromMinute: 5 * 60, toMinute: 6 * 60, halves: 6 },
    { fromMinute: 6 * 60, toMinute: 9 * 60, halves: 8 },
  ]),
};

export function isOvertimeDayKind(value: unknown): value is OvertimeDayKind {
  return typeof value === "string" && (overtimeDayKinds as readonly string[]).includes(value);
}

export function overtimeSchedule(dayKind: OvertimeDayKind): OvertimeSchedule {
  return schedules[dayKind];
}

function schedule(
  dayKind: string,
  maxMinutes: number | null,
  bands: readonly OvertimeBand[],
): OvertimeSchedule {
  let cursor = 0;
  for (const band of bands) {
    if (band.fromMinute !== cursor) {
      throw new Error(`${dayKind} overtime bands must cover every minute.`);
    }
    if (band.toMinute !== null && band.toMinute <= band.fromMinute) {
      throw new Error(`${dayKind} overtime band must end after it starts.`);
    }
    if (band.halves !== 3 && band.halves !== 4 && band.halves !== 6 && band.halves !== 8) {
      throw new Error(`${dayKind} overtime halves must be 3, 4, 6, or 8.`);
    }
    if (band.toMinute !== null) cursor = band.toMinute;
  }
  const last = bands[bands.length - 1];
  if (last === undefined) throw new Error(`${dayKind} needs an overtime band.`);
  if (maxMinutes === null) {
    if (last.toMinute !== null) throw new Error(`${dayKind} open schedule must end open.`);
  } else if (last.toMinute !== maxMinutes) {
    throw new Error(`${dayKind} max minutes must match the last band.`);
  }
  return { maxMinutes, bands };
}
