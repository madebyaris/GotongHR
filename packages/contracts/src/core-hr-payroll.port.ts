import type { Idr } from "./idr.ts";

export type TaxMethod = "gross" | "nett" | "gross_up";

export type Pph21SubjectType = "permanent" | "non_permanent" | "expat";

export const ptkpStatuses = ["TK/0", "TK/1", "TK/2", "TK/3", "K/0", "K/1", "K/2", "K/3"] as const;

export type PtkpStatus = (typeof ptkpStatuses)[number];

export interface EmployeePayrollProfileDTO {
  tenantId: string;
  employeeId: string;
  legalEntityId: string;
  branchId: string;
  ptkpStatus: PtkpStatus;
  taxMethod: TaxMethod;
  pph21SubjectType: Pph21SubjectType;
  baseSalaryIdr: Idr;
  fixedAllowancesIdr: Idr;
}

export interface CoreHrPayrollPort {
  getActivePayrollProfiles(input: {
    tenantId: string;
    legalEntityId: string;
    periodYear: number;
    periodMonth: number;
  }): Promise<EmployeePayrollProfileDTO[]>;
}
