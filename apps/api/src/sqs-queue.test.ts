import assert from "node:assert/strict";
import test from "node:test";
import type { PayrollCalcMessage, PayrollPdfMessage } from "@gotonghr/payroll";
import {
  SQS_CALC_QUEUE_URL,
  SQS_PDF_QUEUE_URL,
  createMemorySqsClient,
  createSqsPayrollQueue,
} from "./queue/sqs.ts";

const runId = "00000000-0000-4000-8000-000000000010";

test("the in-memory SQS client keeps one message per deduplication id", async () => {
  const client = createMemorySqsClient();
  const queue = createSqsPayrollQueue(client);
  const first = calcMessage(0);
  await queue.enqueueCalculation([first, first]);
  await queue.enqueueCalculation([calcMessage(1)]);
  const calc = client.messages(SQS_CALC_QUEUE_URL);
  assert.equal(calc.length, 2);
  assert.equal(JSON.parse(calc[0]?.body ?? "{}").batchIndex, 0);
  assert.equal(calc[0]?.deduplicationId, `${runId}:0`);
  const pdf: PayrollPdfMessage = {
    tenantId: first.tenantId,
    runId,
    batchIndex: 0,
    itemIds: ["00000000-0000-4000-8000-000000000011"],
  };
  await queue.enqueuePayslips([pdf, pdf]);
  const slips = client.messages(SQS_PDF_QUEUE_URL);
  assert.equal(slips.length, 1);
  assert.equal(slips[0]?.deduplicationId, `${runId}:pdf:0`);
  assert.equal(client.messages("memory://other").length, 0);
  assert.equal(SQS_CALC_QUEUE_URL.startsWith("memory://"), true);
});

function calcMessage(batchIndex: number): PayrollCalcMessage {
  return {
    tenantId: "00000000-0000-4000-8000-000000000001",
    runId,
    batchIndex,
    batchCount: 2,
    statutoryTableVersionId: "00000000-0000-4000-8000-000000000003",
    tablePayload: { status: "published" },
    employees: [],
  };
}
