import type { TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { EmployeeFieldError } from "../errors.ts";
import { queryRows } from "../sql.ts";

/** A department and position must exist in this tenant. A position stays in its department. */
export async function assertOrgAssignment(
  tx: TenantTx,
  departmentId: string | null,
  positionId: string | null,
): Promise<void> {
  if (departmentId) {
    const found = queryRows<{ id: string }>(
      await tx.execute(sql`SELECT id::text AS id FROM hr_departments WHERE id = ${departmentId}::uuid`),
    );
    if (!found[0]) {
      throw new EmployeeFieldError([{ field: "departmentId", message: "Choose a department." }]);
    }
  }
  if (!positionId) return;
  const positions = queryRows<{ department_id: string | null }>(
    await tx.execute(sql`
      SELECT department_id::text AS department_id
      FROM hr_positions
      WHERE id = ${positionId}::uuid
    `),
  );
  const position = positions[0];
  if (!position) {
    throw new EmployeeFieldError([{ field: "positionId", message: "Choose a position." }]);
  }
  if (departmentId && position.department_id && position.department_id !== departmentId) {
    throw new EmployeeFieldError([
      { field: "positionId", message: "That position is in another department." },
    ]);
  }
}
