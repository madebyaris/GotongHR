import { PayrollInputError } from "./errors.ts";

/** A count of months, minutes, or people. This is not money. */
export function wholeCount(value: number, label: string, min: number, max?: number): number {
  const ceiling = max === undefined ? "" : ` and at most ${max.toString()}`;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    (max !== undefined && value > max)
  ) {
    throw new PayrollInputError(`${label} must be an integer of at least ${min.toString()}${ceiling}.`);
  }
  return value;
}
