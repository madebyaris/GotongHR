import type { Idr } from "@gotonghr/contracts";

export const bankBatchIds = ["bca-klikbisnis", "mandiri-kopra", "bni-direct", "bri-qlola"] as const;

export type BankBatchId = (typeof bankBatchIds)[number];

export interface BankPayment {
  readonly employeeId: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly amountIdr: Idr;
  readonly remark: string;
  readonly email?: string;
  readonly addressLine1?: string;
  readonly bankCode?: string;
}

export interface BankBatchInput {
  readonly debitAccountNumber: string;
  readonly effectiveDate: string;
  readonly payments: readonly BankPayment[];
}

export interface BankBatchExclusion {
  readonly employeeId: string;
  readonly field: string;
  readonly reason: string;
}

export interface BankBatchFile {
  readonly bank: BankBatchId;
  readonly fileName: string;
  readonly mediaType: "text/csv";
  readonly body: string;
  readonly detailCount: number;
  readonly totalIdr: Idr;
  readonly excluded: readonly BankBatchExclusion[];
}

export type BankBatchVerification =
  | {
      readonly ok: true;
      readonly headerTotalIdr: bigint;
      readonly detailTotalIdr: bigint;
      readonly detailCount: number;
    }
  | {
      readonly ok: false;
      readonly headerTotalIdr: bigint;
      readonly detailTotalIdr: bigint;
      readonly detailCount: number;
      readonly reason: string;
    };
