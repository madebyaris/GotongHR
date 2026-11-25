import type { Idr } from "@gotonghr/contracts";
import { MissingStatutoryValueError } from "../errors.ts";
import { rupiah } from "../money.ts";
import type { StatutoryTable } from "./types.ts";

/** Reads the JP annual wage cap. A missing key throws instead of using a guessed cap. */
export function jpAnnualWageCap(table: StatutoryTable): Idr {
  const cap = table.jpAnnualWageCap;
  if (cap.kind !== "present") {
    throw new MissingStatutoryValueError("jp_annual_wage_cap");
  }
  return rupiah(cap.rupiah);
}
