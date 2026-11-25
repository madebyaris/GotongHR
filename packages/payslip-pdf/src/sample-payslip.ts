import type { PayslipDto } from "./types.ts";

const base: PayslipDto = {
  companyName: "Sinar Terang Group",
  companyNpwp: "01.234.567.8-012.000",
  legalEntityName: "PT Sinar Terang Nusantara",
  periodYear: 2026,
  periodMonth: 8,
  employeeName: "Sari Wulandari",
  employeeNik: "3174091708950001",
  jobTitle: "Staff Keuangan",
  ptkpStatus: "TK/0",
  earnings: [
    { labelId: "Gaji pokok", labelEn: "Base salary", amountIdr: 8_500_000n },
    { labelId: "Tunjangan tetap", labelEn: "Fixed allowance", amountIdr: 1_500_000n },
    { labelId: "Bonus", labelEn: "Bonus", amountIdr: 12_345_678n },
  ],
  deductions: [
    { labelId: "BPJS Kesehatan", labelEn: "Health", amountIdr: 100_000n },
    { labelId: "JHT", labelEn: "JHT", amountIdr: 200_000n },
    { labelId: "JP", labelEn: "JP", amountIdr: 100_000n },
    { labelId: "PPh 21", labelEn: "PPh 21", amountIdr: 450_000n },
  ],
  pph21Method: "gross",
  pph21Status: "TER",
  tableUndeclared: true,
  bpjs: {
    kesehatanEmployeeIdr: 100_000n,
    jhtEmployeeIdr: 200_000n,
    jpEmployeeIdr: 100_000n,
    kesehatanEmployerIdr: 400_000n,
    jhtEmployerIdr: 370_000n,
    jkkEmployerIdr: 54_000n,
    jkmEmployerIdr: 30_000n,
    jpEmployerIdr: 200_000n,
    jkpEmployerIdr: 46_000n,
  },
  netPayIdr: 21_495_678n,
};

export function samplePayslip(patch?: {
  tableUndeclared?: boolean;
  netPayIdr?: bigint;
}): PayslipDto {
  const payslip: PayslipDto = {
    ...base,
    earnings: base.earnings.map((line) => ({ ...line })),
    deductions: base.deductions.map((line) => ({ ...line })),
    bpjs: { ...base.bpjs },
  };
  if (patch?.tableUndeclared !== undefined) {
    payslip.tableUndeclared = patch.tableUndeclared;
  }
  if (patch?.netPayIdr !== undefined) {
    payslip.netPayIdr = patch.netPayIdr;
  }
  return payslip;
}
