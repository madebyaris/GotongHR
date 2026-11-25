import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("anomaly inbox surface", () => {
  it("sends both inbox routes through one list function", () => {
    const routes = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
    const query = readFileSync(new URL("./query.ts", import.meta.url), "utf8");
    assert.match(routes, /\/api\/v1\/attendance\/anomalies/);
    assert.match(routes, /\/api\/v1\/mobile\/approvals\/pending/);
    assert.match(routes, /\/api\/v1\/attendance\/anomalies\/:id\/review/);
    assert.equal(routes.split("listPendingAnomalies(").length - 1, 1);
    assert.equal(query.includes("FROM att_clock_events"), true);
    assert.equal(query.split("FROM att_clock_events").length - 1, 1);
    assert.match(query, /review_status = 'needs_review'/);
    assert.equal(routes.includes("FROM att_clock_events"), false);
  });
});
