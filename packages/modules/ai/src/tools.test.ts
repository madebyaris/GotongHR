import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseStatutoryTable } from "@gotonghr/payroll-engine";
import { id2026DraftTable } from "@gotonghr/payroll-engine/draft";
import type { AiCaller } from "./caller.ts";
import { dispatchTool, proposalRequiresTotp, simulatePayrollItem, toolsForCaller } from "./tools.ts";

const employeeId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const salary = "88888888";

function caller(overrides: Partial<AiCaller>): AiCaller {
  return {
    tenantId: "33333333-3333-4333-8333-333333333333",
    userId: "44444444-4444-4444-8444-444444444444",
    role: "employee",
    permissions: [],
    scopeEntityIds: [],
    scopeBranchIds: [],
    directReportsOnly: false,
    selfOnly: true,
    selfEmployeeId: null,
    sessionTotpVerified: false,
    ...overrides,
  };
}

function syntheticTable() {
  const file = new URL("../../../payroll-engine/src/__tests__/fixtures/synthetic-pph21.json", import.meta.url);
  return parseStatutoryTable(JSON.parse(readFileSync(file, "utf8")));
}

function simulateArgs(target: string) {
  return {
    employeeId: target,
    payrollDate: "2026-01-31",
    periodMonth: 1,
    ptkpStatus: "TK/0",
    method: "gross",
    baseSalaryIdr: "5000000",
  };
}

test("simulatePayrollItem returns bigint rupiah from the injected table", () => {
  const result = simulatePayrollItem(
    caller({
      role: "hr_admin",
      permissions: ["payroll.run.prepare"],
      selfOnly: false,
    }),
    simulateArgs(employeeId),
    syntheticTable(),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(typeof result.amounts.taxIdr, "bigint");
  assert.equal(result.amounts.taxIdr, 100_000n);
  assert.equal(result.amounts.grossTaxableIdr, 5_000_000n);
  assert.equal(result.amounts.employeeWithheldIdr, 100_000n);
});

test("the draft table does not invent a tax amount", () => {
  const result = simulatePayrollItem(
    caller({ role: "hr_admin", permissions: ["payroll.run.prepare"], selfOnly: false }),
    simulateArgs(employeeId),
    id2026DraftTable,
  );
  assert.deepEqual(result, { ok: false, code: "statutory_table_incomplete" });
});

test("an employee cannot see privileged tools or another salary", () => {
  const employee = caller({});
  assert.deepEqual(toolsForCaller(employee), []);
  const hidden = caller({
    permissions: ["payroll.run.prepare"],
    selfOnly: true,
    selfEmployeeId: null,
  });
  assert.equal(toolsForCaller(hidden).some((tool) => tool.name === "simulate_payroll_item"), false);
  const scoped = caller({
    permissions: ["payroll.run.prepare"],
    selfOnly: true,
    selfEmployeeId: employeeId,
  });
  const denied = dispatchTool(scoped, "simulate_payroll_item", {
    ...simulateArgs(otherId),
    baseSalaryIdr: salary,
  }, syntheticTable());
  assert.equal(denied.ok, false);
  assert.equal(JSON.stringify(denied).includes(salary), false);
  const own = dispatchTool(scoped, "simulate_payroll_item", simulateArgs(employeeId), syntheticTable());
  assert.equal(own.ok, true);
  const hr = caller({
    role: "hr_admin",
    permissions: ["payroll.run.prepare", "ai.action.approve"],
    selfOnly: false,
  });
  assert.equal(toolsForCaller(hr).some((tool) => tool.name.toLowerCase().includes("sql")), false);
  assert.deepEqual(dispatchTool(hr, "run_sql", { query: "select 1" }, syntheticTable()), {
    ok: false,
    code: "forbidden",
  });
  const owner = caller({
    role: "org_owner",
    permissions: ["payroll.run.finalize", "ai.action.approve"],
    selfOnly: false,
  });
  assert.equal(toolsForCaller(owner).some((tool) => tool.name === "propose_payroll_finalize"), true);
  assert.equal(proposalRequiresTotp("propose_payroll_finalize"), true);
  assert.equal(proposalRequiresTotp("propose_employee_change"), false);
  const payroll = dispatchTool(
    owner,
    "propose_payroll_finalize",
    {
      payrollRunId: "55555555-5555-4555-8555-555555555555",
      periodLabel: "2026-01",
      netPayIdr: "15000000",
    },
    syntheticTable(),
  );
  assert.equal(payroll.ok, true);
  if (!payroll.ok || !payroll.mutating) return;
  assert.equal(payroll.impact.requiresTotp, true);
  const amounts = payroll.impact.amounts as Array<{ unit: string; amount: string }>;
  assert.equal(amounts[0]?.unit, "idr");
  assert.equal(amounts[0]?.amount, "15000000");
  assert.equal(dispatchTool(hr, "propose_payroll_finalize", { payrollRunId: "x" }, syntheticTable()).ok, false);
  const reader = caller({
    role: "hr_admin",
    permissions: ["ai.knowledge.read"],
    selfOnly: false,
  });
  assert.equal(toolsForCaller(reader).some((tool) => tool.name === "search_policy_knowledge"), true);
  assert.equal(toolsForCaller(employee).some((tool) => tool.name === "search_policy_knowledge"), false);
  assert.deepEqual(dispatchTool(employee, "search_policy_knowledge", { query: "PP 58" }, syntheticTable()), {
    ok: false,
    code: "forbidden",
  });
});
