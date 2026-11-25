import type { Idr } from "./idr.ts";

export type TaxMethod = "gross" | "nett" | "gross_up";

export type Pph21SubjectType = "permanent" | "non_permanent" | "expat";

export interface EmployeePayrollProfileDTO {
  tenantId: string;
  employeeId: string;
  legalEntityId: string;
  branchId: string;
  ptkpStatus: string;
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
