import assert from "node:assert/strict";
import test from "node:test";
import { defaultFakeSteps } from "./script.ts";

const employeeId = "11111111-1111-4111-8111-111111111111";

test("defaultFakeSteps proposes the named display name and ignores other chat", () => {
  const steps = defaultFakeSteps(
    `Propose display name Sari for employee ${employeeId}. NIK 3175012345670001`,
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.toolCalls?.[0]?.name, "propose_employee_change");
  assert.deepEqual(steps[0]?.toolCalls?.[0]?.arguments, {
    employeeId,
    field: "display_name",
    value: "Sari",
  });
  assert.equal(defaultFakeSteps("What is the cutoff?").length, 0);
});
