/**
 * Published PPh 21 table the payroll run pins at calculate time.
 * `payload` is the payroll-engine document. The payroll module parses it.
 */
export interface StatutoryTableVersion {
  id: string;
  payload: unknown;
}

export interface StatutoryPayrollPort {
  getEffectiveTable(input: { payrollDate: string }): Promise<StatutoryTableVersion | null>;
}
