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
  /**
   * Writes `locked_for_payroll_run_id` on locked daily summaries for the period.
   * The payroll module does not touch attendance tables itself.
   */
  attachPayrollRun(input: {
    tenantId: string;
    legalEntityId: string;
    periodYear: number;
    periodMonth: number;
    runId: string;
  }): Promise<{ attached: number }>;
}
