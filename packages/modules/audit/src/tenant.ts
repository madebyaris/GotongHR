import type { TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { assertUuid, queryRows } from "./sql.ts";

export async function assertSameTenant(tx: TenantTx, tenantId: string): Promise<string> {
  const expected = assertUuid(tenantId, "tenant id");
  const rows = queryRows<{ tenant: string | null }>(
    await tx.execute(
      sql`SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS tenant`,
    ),
  );
  const current = rows[0]?.tenant?.toLowerCase() ?? "";
  if (current !== expected) {
    throw new Error("tenant context does not match");
  }
  return expected;
}
