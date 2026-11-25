export type Pph21Method = "gross" | "nett" | "gross_up";

export interface PayslipAmountLine {
  labelId: string;
  labelEn: string;
  amountIdr: bigint;
}

/** Employee and employer BPJS amounts in integer rupiah. */
export interface PayslipBpjsBreakdown {
  kesehatanEmployeeIdr: bigint;
  jhtEmployeeIdr: bigint;
  jpEmployeeIdr: bigint;
  kesehatanEmployerIdr: bigint;
  jhtEmployerIdr: bigint;
  jkkEmployerIdr: bigint;
  jkmEmployerIdr: bigint;
  jpEmployerIdr: bigint;
  jkpEmployerIdr: bigint;
}

/**
 * One payslip. Every rupiah field is an integer bigint.
 * The generator prints these values. It does not compute tax.
 */
export interface PayslipDto {
  companyName: string;
  companyNpwp: string;
  legalEntityName: string;
  periodYear: number;
  periodMonth: number;
  employeeName: string;
  employeeNik: string;
  jobTitle: string;
  ptkpStatus: string;
  earnings: readonly PayslipAmountLine[];
  deductions: readonly PayslipAmountLine[];
  pph21Method: Pph21Method;
  pph21Status: string;
  /** Draws the draft watermark when the statutory table is not the published one. */
  tableUndeclared: boolean;
  bpjs: PayslipBpjsBreakdown;
  netPayIdr: bigint;
}
