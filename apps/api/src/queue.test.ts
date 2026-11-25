import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETED_JOB_RETENTION_SECONDS,
  WORKER_CONCURRENCY,
  WORKER_POLLING_INTERVAL_SECONDS,
  queueDefaults,
  workerDefaults,
} from "./queue.ts";

test("queue defaults poll every 5 seconds and delete completed jobs after 7 days", () => {
  assert.equal(WORKER_POLLING_INTERVAL_SECONDS, 5);
  assert.equal(WORKER_CONCURRENCY, 2);
  assert.equal(COMPLETED_JOB_RETENTION_SECONDS, 7 * 24 * 60 * 60);
  assert.deepEqual(workerDefaults(), {
    pollingIntervalSeconds: 5,
    localConcurrency: 2,
  });
  assert.deepEqual(queueDefaults(), { deleteAfterSeconds: 7 * 24 * 60 * 60 });
});
