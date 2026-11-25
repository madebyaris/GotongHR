import type { Idr, PtkpStatus } from "@gotonghr/contracts";
import { civilDate, type CivilDate } from "../civil-date.ts";
import { PayrollInputError } from "../errors.ts";
import { nonNegativeRupiah, rupiah } from "../money.ts";
import { assertTableCovers } from "../tables/select.ts";
import type { StatutoryTable, TerCategory } from "../tables/types.ts";
import { biayaJabatan } from "./biaya-jabatan.ts";
import { pasal17Tax, roundPkpDown } from "./pasal17.ts";
import { annualPtkp, terCategoryForPtkp } from "./ptkp.ts";

export type ReconciliationReason = "december" | "exit";

export interface ReconcilePph21Input {
  readonly payrollDate: CivilDate;
  readonly reason: ReconciliationReason;
  readonly table: StatutoryTable;
  readonly ptkpStatus: PtkpStatus;
  readonly activeMonths: number;
  readonly ytdGrossTaxable: Idr;
  readonly ytdEmployeeJht: Idr;
  readonly ytdEmployeeJp: Idr;
  readonly verifiedZakat: Idr;
  readonly ytdPph21Withheld: Idr;
}

export interface ReconcilePph21Result {
  readonly reason: ReconciliationReason;
  readonly category: TerCategory;
  readonly biayaJabatan: Idr;
  readonly neto: Idr;
  readonly ptkp: Idr;
  readonly pkp: Idr;
  readonly annualTax: Idr;
  readonly ytdPph21Withheld: Idr;
  readonly withholding: Idr;
  readonly refund: Idr;
}

function floorAtZero(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

/**
 * December and mid-year exit use Pasal 17 on the year, not monthly TER.
 * PKP is rounded down to Rp1,000. A negative delta is an overpayment refund.
 * The payroll date is injected. This function does not read the clock.
 */
export function reconcilePph21(input: ReconcilePph21Input): ReconcilePph21Result {
  const payrollDate = civilDate(input.payrollDate.year, input.payrollDate.month, input.payrollDate.day);
  if (input.reason !== "december" && input.reason !== "exit") {
    throw new PayrollInputError("Reconciliation reason must be december or exit.");
  }
  if (input.reason === "december" && payrollDate.month !== 12) {
    throw new PayrollInputError("December reconciliation requires a December payroll date.");
  }
  assertTableCovers(input.table, payrollDate);
  const category = terCategoryForPtkp(input.ptkpStatus);
  const ytdGross = nonNegativeRupiah(input.ytdGrossTaxable, "ytdGrossTaxable");
  const ytdJht = nonNegativeRupiah(input.ytdEmployeeJht, "ytdEmployeeJht");
  const ytdJp = nonNegativeRupiah(input.ytdEmployeeJp, "ytdEmployeeJp");
  const zakat = nonNegativeRupiah(input.verifiedZakat, "verifiedZakat");
  const withheld = nonNegativeRupiah(input.ytdPph21Withheld, "ytdPph21Withheld");
  const jabatan = biayaJabatan(input.table, ytdGross, input.activeMonths);
  const neto = rupiah(floorAtZero(ytdGross - jabatan - ytdJht - ytdJp - zakat));
  const ptkp = annualPtkp(input.table, input.ptkpStatus);
  const pkp = rupiah(roundPkpDown(floorAtZero(neto - ptkp)));
  const annualTax = pasal17Tax(input.table, pkp);
  const delta = annualTax - withheld;
  const withholding = rupiah(delta > 0n ? delta : 0n);
  const refund = rupiah(delta < 0n ? -delta : 0n);
  return {
    reason: input.reason,
    category,
    biayaJabatan: jabatan,
    neto,
    ptkp,
    pkp,
    annualTax,
    ytdPph21Withheld: withheld,
    withholding,
    refund,
  };
}
