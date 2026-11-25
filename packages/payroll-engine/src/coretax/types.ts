import type { Idr } from "@gotonghr/contracts";

export const coretaxSlipTypes = ["BPMP", "BP21", "BP26", "BPA1"] as const;

export type CoretaxSlipType = (typeof coretaxSlipTypes)[number];

export type CounterpartOpt = "Resident" | "Foreign";

/** Same shape as TerRate. The builder does not look up a TER table. */
export interface ScaledRate {
  readonly ratePerScale: bigint;
  readonly rateScale: bigint;
}

export interface CoretaxWithholder {
  readonly npwp: string;
  readonly nitku: string;
}

interface CoretaxRecordBase {
  readonly employeeId: string;
  readonly nik: string;
  readonly name: string;
  readonly ptkpStatus: string;
  readonly nitku: string;
  readonly taxPeriodYear: number;
  readonly taxObjectCode: string;
  readonly withholdingDate: string;
}

/** Monthly withholding for a permanent employee. Root element MmPayrollBulk. */
export interface BpmpRecord extends CoretaxRecordBase {
  readonly slipType: "BPMP";
  readonly taxPeriodMonth: number;
  readonly counterpartOpt: CounterpartOpt;
  readonly passportNumber: string;
  readonly position: string;
  readonly taxCertificate: string;
  readonly grossIdr: Idr;
  readonly rate: ScaledRate;
}

/** Pasal 21 slip for a non-permanent employee. Root element Bp21Bulk. */
export interface Bp21Record extends CoretaxRecordBase {
  readonly slipType: "BP21";
  readonly taxPeriodMonth: number;
  readonly recipientNitku: string;
  readonly taxCertificate: string;
  readonly grossIdr: Idr;
  readonly deemed: ScaledRate;
  readonly rate: ScaledRate;
  readonly document: string;
  readonly documentNumber: string;
  readonly documentDate: string;
}

/** Pasal 26 slip for a foreign taxpayer. Root element Bp26Bulk. */
export interface Bp26Record extends CoretaxRecordBase {
  readonly slipType: "BP26";
  readonly taxPeriodMonth: number;
  readonly countryCode: string;
  readonly address: string;
  readonly birthPlace: string;
  readonly birthDate: string;
  readonly passportNumber: string;
  readonly taxCertificate: string;
  readonly grossIdr: Idr;
  readonly deemed: ScaledRate;
  readonly rate: ScaledRate;
  readonly document: string;
  readonly documentNumber: string;
  readonly documentDate: string;
}

export interface Bpa1Amounts {
  readonly grossIdr: Idr;
  readonly positionCostIdr: Idr;
  readonly pensionContributionIdr: Idr;
  readonly zakatIdr: Idr;
  readonly netIncomeIdr: Idr;
  readonly previousNetIncomeIdr: Idr;
  readonly ptkpIdr: Idr;
  readonly taxableIncomeIdr: Idr;
  readonly article17TaxIdr: Idr;
  readonly previousWithholdingIdr: Idr;
  readonly incomeTaxIdr: Idr;
  /** December or exit delta. Negative means a refund. The builder does not recompute Pasal 17. */
  readonly incomeTaxPayableIdr: Idr;
}

/** Annual A1 slip. Root element A1Bulk. */
export interface Bpa1Record extends CoretaxRecordBase {
  readonly slipType: "BPA1";
  readonly taxPeriodMonthStart: number;
  readonly taxPeriodMonthEnd: number;
  readonly counterpartOpt: CounterpartOpt;
  readonly passportNumber: string;
  readonly position: string;
  readonly slipStatus: "FullYear" | "PartialYear" | "Annualized";
  readonly nextEmployer: "Yes" | "No";
  readonly amounts: Bpa1Amounts;
}

export type CoretaxRecord = BpmpRecord | Bp21Record | Bp26Record | Bpa1Record;

export interface CoretaxFieldIssue {
  readonly field: string;
  readonly reason: string;
}

export interface CoretaxPreflightIssue extends CoretaxFieldIssue {
  readonly index: number;
  readonly employeeId: string;
}

export interface CoretaxPreflightReport {
  readonly issues: readonly CoretaxPreflightIssue[];
  readonly withholderIssues: readonly CoretaxFieldIssue[];
  readonly acceptedEmployeeIds: readonly string[];
  readonly rejectedEmployeeIds: readonly string[];
}

export interface CoretaxBatchResult {
  readonly slipType: CoretaxSlipType;
  readonly xml: string;
  readonly preflight: CoretaxPreflightReport;
}
