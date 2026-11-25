export interface AttendancePeriodSummaryDTO {
  tenantId: string;
  employeeId: string;
  legalEntityId: string;
  periodYear: number;
  periodMonth: number;
  approvedOvertimeMinutes: number;
  locked: boolean;
}

export interface AttendancePayrollPort {
  getLockedPeriodSummaries(input: {
    tenantId: string;
    legalEntityId: string;
    periodYear: number;
    periodMonth: number;
  }): Promise<AttendancePeriodSummaryDTO[]>;
}
