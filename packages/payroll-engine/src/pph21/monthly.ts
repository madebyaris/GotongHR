import type { Idr, PtkpStatus, TaxMethod } from "@gotonghr/contracts";
import { civilDate, type CivilDate } from "../civil-date.ts";
import { PayrollInputError } from "../errors.ts";
import { rupiah } from "../money.ts";
import { assertTableCovers } from "../tables/select.ts";
import type { StatutoryTable, TerCategory } from "../tables/types.ts";
import { grossTaxableOf, type GrossTaxableComponents } from "./gross-taxable.ts";
import { solveGrossUp } from "./gross-up.ts";
import { terCategoryForPtkp } from "./ptkp.ts";
import { terRate, terTax } from "./ter.ts";

export interface MonthlyPph21Input {
  readonly payrollDate: CivilDate;
  readonly periodMonth: number;
  readonly table: StatutoryTable;
  readonly ptkpStatus: PtkpStatus;
  readonly method: TaxMethod;
  readonly components: GrossTaxableComponents;
}

export interface MonthlyPph21Result {
  readonly method: TaxMethod;
  readonly periodMonth: number;
  readonly category: TerCategory;
  readonly grossTaxable: Idr;
  readonly taxAllowance: Idr;
  readonly grossedTaxable: Idr;
  readonly tax: Idr;
  readonly employeeWithheld: Idr;
  readonly employerBorneTax: Idr;
  readonly grossedCost: Idr;
  readonly iterations: number;
}

function zero(): Idr {
  return rupiah(0n);
}

/**
 * January through November TER withholding.
 * gross: the employee bears the tax.
 * gross_up: a tax allowance is added until it matches the tax within Rp1.
 * nett: the agreed components are the employee's net, and the employer bears the tax.
 * Nett grossed cost is that net plus the tax, including a Rp1 solver gap.
 * December and exit months use reconcilePph21. This function does not read the clock.
 */
export function calculateMonthlyPph21(input: MonthlyPph21Input): MonthlyPph21Result {
  const payrollDate = civilDate(input.payrollDate.year, input.payrollDate.month, input.payrollDate.day);
  if (!Number.isInteger(input.periodMonth) || input.periodMonth < 1 || input.periodMonth > 11) {
    throw new PayrollInputError(
      "Monthly TER covers January through November. Use reconcilePph21 for December or an exit.",
    );
  }
  if (payrollDate.month !== input.periodMonth) {
    throw new PayrollInputError("periodMonth must match the payroll date.");
  }
  if (input.method !== "gross" && input.method !== "nett" && input.method !== "gross_up") {
    throw new PayrollInputError("Tax method must be gross, nett, or gross_up.");
  }
  assertTableCovers(input.table, payrollDate);
  const category = terCategoryForPtkp(input.ptkpStatus);
  const grossTaxable = grossTaxableOf(input.components);
  if (input.method === "gross") {
    const tax = terTax(input.table, category, grossTaxable);
    return {
      method: "gross",
      periodMonth: input.periodMonth,
      category,
      grossTaxable,
      taxAllowance: zero(),
      grossedTaxable: grossTaxable,
      tax,
      employeeWithheld: tax,
      employerBorneTax: zero(),
      grossedCost: grossTaxable,
      iterations: 1,
    };
  }
  const solved = solveGrossUp(grossTaxable, input.table.ter.taxRounding, (base) =>
    terRate(input.table, category, base),
  );
  const taxAllowance = rupiah(solved.allowance);
  const tax = rupiah(solved.tax);
  const grossedTaxable = rupiah(grossTaxable + solved.allowance);
  if (input.method === "gross_up") {
    return {
      method: "gross_up",
      periodMonth: input.periodMonth,
      category,
      grossTaxable,
      taxAllowance,
      grossedTaxable,
      tax,
      employeeWithheld: tax,
      employerBorneTax: zero(),
      grossedCost: grossedTaxable,
      iterations: solved.iterations,
    };
  }
  return {
    method: "nett",
    periodMonth: input.periodMonth,
    category,
    grossTaxable,
    taxAllowance,
    grossedTaxable,
    tax,
    employeeWithheld: zero(),
    employerBorneTax: tax,
    grossedCost: rupiah(grossTaxable + solved.tax),
    iterations: solved.iterations,
  };
}
