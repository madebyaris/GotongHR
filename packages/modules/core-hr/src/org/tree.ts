import type { TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { queryRows } from "../sql.ts";

export async function departmentCycle(
  tx: TenantTx,
  parentId: string,
  selfId: string,
): Promise<"cycle" | "deep" | null> {
  const rows = queryRows<{ id: string }>(
    await tx.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_department_id, 1 AS depth
        FROM hr_departments
        WHERE id = ${parentId}::uuid
        UNION ALL
        SELECT parent.id, parent.parent_department_id, chain.depth + 1
        FROM hr_departments AS parent
        JOIN chain ON parent.id = chain.parent_department_id
        WHERE chain.parent_department_id IS NOT NULL
          AND chain.depth < 32
      )
      SELECT id::text AS id
      FROM chain
      WHERE id = ${selfId}::uuid OR depth >= 32
      ORDER BY CASE WHEN id = ${selfId}::uuid THEN 0 ELSE 1 END
      LIMIT 1
    `),
  );
  const row = rows[0];
  if (!row) return null;
  return row.id === selfId ? "cycle" : "deep";
}

export async function positionCycle(
  tx: TenantTx,
  reportsToId: string,
  selfId: string,
): Promise<"cycle" | "deep" | null> {
  const rows = queryRows<{ id: string }>(
    await tx.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT id, reports_to_position_id, 1 AS depth
        FROM hr_positions
        WHERE id = ${reportsToId}::uuid
        UNION ALL
        SELECT parent.id, parent.reports_to_position_id, chain.depth + 1
        FROM hr_positions AS parent
        JOIN chain ON parent.id = chain.reports_to_position_id
        WHERE chain.reports_to_position_id IS NOT NULL
          AND chain.depth < 32
      )
      SELECT id::text AS id
      FROM chain
      WHERE id = ${selfId}::uuid OR depth >= 32
      ORDER BY CASE WHEN id = ${selfId}::uuid THEN 0 ELSE 1 END
      LIMIT 1
    `),
  );
  const row = rows[0];
  if (!row) return null;
  return row.id === selfId ? "cycle" : "deep";
}
