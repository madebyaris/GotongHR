import type { FakeStep } from "./provider.ts";

const PROPOSE_PHRASE =
  /propose display name\s+(.+?)\s+for employee\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/iu;

/**
 * Gives the fake provider a tool call when no test script was sent.
 * A live provider ignores this. The phrase is the admin's own message.
 */
export function defaultFakeSteps(message: string): FakeStep[] {
  const named = PROPOSE_PHRASE.exec(message);
  const value = named?.[1]?.trim() ?? "";
  const employeeId = named?.[2]?.toLowerCase() ?? "";
  if (!named || value.length === 0 || value.length > 80) return [];
  return [
    {
      text: "I prepared the display name change. Confirm it before anything is saved.",
      toolCalls: [
        {
          name: "propose_employee_change",
          arguments: { employeeId, field: "display_name", value },
        },
      ],
    },
  ];
}
