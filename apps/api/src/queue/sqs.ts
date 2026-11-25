import { randomUUID } from "node:crypto";
import type { PayrollCalcMessage, PayrollPdfMessage, PayrollQueuePort } from "@gotonghr/payroll";

/** Not an AWS URL. The in-memory client is the only SQS client in this slice. */
export const SQS_CALC_QUEUE_URL = "memory://gotong.payroll.calculate";

/** Not an AWS URL. The in-memory client is the only SQS client in this slice. */
export const SQS_PDF_QUEUE_URL = "memory://gotong.payroll.payslip";

export interface SqsMessageInput {
  queueUrl: string;
  body: string;
  deduplicationId: string;
}

/**
 * The slice of the SQS SendMessage call this process uses.
 * A live client is not implemented. Tests pass `createMemorySqsClient`.
 */
export interface SqsClient {
  sendMessage(input: SqsMessageInput): Promise<{ messageId: string }>;
}

export interface MemorySqsMessage {
  messageId: string;
  body: string;
  deduplicationId: string;
}

export interface MemorySqsClient extends SqsClient {
  messages(queueUrl: string): readonly MemorySqsMessage[];
}

/** Keeps the first body for a deduplication id. Nothing leaves the process. */
export function createMemorySqsClient(): MemorySqsClient {
  const queues = new Map<string, Map<string, MemorySqsMessage>>();
  return {
    sendMessage(input) {
      const queue = queues.get(input.queueUrl) ?? new Map<string, MemorySqsMessage>();
      queues.set(input.queueUrl, queue);
      const existing = queue.get(input.deduplicationId);
      if (existing) return Promise.resolve({ messageId: existing.messageId });
      const message: MemorySqsMessage = {
        messageId: randomUUID(),
        body: input.body,
        deduplicationId: input.deduplicationId,
      };
      queue.set(input.deduplicationId, message);
      return Promise.resolve({ messageId: message.messageId });
    },
    messages(queueUrl) {
      const queue = queues.get(queueUrl);
      return queue ? [...queue.values()] : [];
    },
  };
}

export function createSqsPayrollQueue(
  client: SqsClient,
  queues: { calcQueueUrl: string; pdfQueueUrl: string } = {
    calcQueueUrl: SQS_CALC_QUEUE_URL,
    pdfQueueUrl: SQS_PDF_QUEUE_URL,
  },
): PayrollQueuePort {
  return {
    async enqueueCalculation(messages) {
      for (const message of messages) await sendCalc(client, queues.calcQueueUrl, message);
    },
    async enqueuePayslips(messages) {
      for (const message of messages) await sendPdf(client, queues.pdfQueueUrl, message);
    },
  };
}

function sendCalc(client: SqsClient, queueUrl: string, message: PayrollCalcMessage): Promise<{ messageId: string }> {
  return client.sendMessage({
    queueUrl,
    body: JSON.stringify(message),
    deduplicationId: `${message.runId}:${message.batchIndex}`,
  });
}

function sendPdf(client: SqsClient, queueUrl: string, message: PayrollPdfMessage): Promise<{ messageId: string }> {
  return client.sendMessage({
    queueUrl,
    body: JSON.stringify(message),
    deduplicationId: `${message.runId}:pdf:${message.batchIndex}`,
  });
}
