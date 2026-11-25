import type { Idr } from "./idr.ts";
import type { BpjsFlags } from "./org-structure.ts";

export type TaxMethod = "gross" | "nett" | "gross_up";

export type Pph21SubjectType = "permanent" | "non_permanent" | "expat";

export const ptkpStatuses = ["TK/0", "TK/1", "TK/2", "TK/3", "K/0", "K/1", "K/2", "K/3"] as const;

export type PtkpStatus = (typeof ptkpStatuses)[number];

export interface EmployeePayrollProfileDTO {
  tenantId: string;
  employeeId: string;
  legalEntityId: string;
  branchId: string;
  /** Login that may download this employee's payslip. Null until ESS is linked. */
  userId: string | null;
  employeeCode: string;
  fullName: string;
  jobTitle: string;
  /** Civil date `YYYY-MM-DD`. The payslip password is `ddMMyyyy`. */
  dateOfBirth: string;
  ptkpStatus: PtkpStatus;
  taxMethod: TaxMethod;
  pph21SubjectType: Pph21SubjectType;
  baseSalaryIdr: Idr;
  fixedAllowancesIdr: Idr;
  bpjsFlags: BpjsFlags;
  nik: string;
  bankAccountNumber: string;
  nitku: string;
  companyName: string;
  companyNpwp: string;
  umpUmkIdr: Idr;
  jkkRiskClass: number;
}

export interface CoreHrPayrollPort {
  getActivePayrollProfiles(input: {
    tenantId: string;
    legalEntityId: string;
    periodYear: number;
    periodMonth: number;
  }): Promise<EmployeePayrollProfileDTO[]>;
  /** Login linked on the employee. Null when ESS is not linked. */
  employeeIdForUser(input: { tenantId: string; userId: string }): Promise<string | null>;
}
