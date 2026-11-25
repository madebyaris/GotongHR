/** One pg-boss job covers at most this many employees. */
export const PAYROLL_BATCH_SIZE = 100;

/** ESS download links expire inside the storage token cap. */
export const PAYSLIP_URL_TTL_SECONDS = 120;

export const PAYROLL_CALC_QUEUE = "gotong.payroll.calculate";
export const PAYROLL_PDF_QUEUE = "gotong.payroll.payslip";

export interface PayrollCalcMessage {
  tenantId: string;
  runId: string;
  batchIndex: number;
  batchCount: number;
  statutoryTableVersionId: string;
  tablePayload: unknown;
  employees: PayrollCalcEmployee[];
}

export interface PayrollCalcEmployee {
  profile: Record<string, unknown>;
  attendance: Record<string, unknown>;
}

export interface PayrollPdfMessage {
  tenantId: string;
  runId: string;
  batchIndex: number;
  itemIds: string[];
}

export interface PayrollQueuePort {
  enqueueCalculation(messages: readonly PayrollCalcMessage[]): Promise<void>;
  enqueuePayslips(messages: readonly PayrollPdfMessage[]): Promise<void>;
}

export interface PayrollStoragePort {
  put(input: { key: string; body: Uint8Array; contentType: string }): Promise<void>;
  presignGet(input: { key: string; expiresInSeconds: number }): Promise<{ url: string }>;
}
