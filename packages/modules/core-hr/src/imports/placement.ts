import type { TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { EmployeeFieldError } from "../errors.ts";
import { queryRows } from "../sql.ts";

export async function assertImportPlacement(
  tx: TenantTx,
  legalEntityId: string,
  branchId: string,
): Promise<void> {
  const branches = queryRows<{ legal_entity_id: string }>(
    await tx.execute(sql`
      SELECT legal_entity_id::text AS legal_entity_id
      FROM id_branches
      WHERE id = ${branchId}::uuid
    `),
  );
  const branch = branches[0];
  if (!branch) {
    throw new EmployeeFieldError([{ field: "branchId", message: "Choose a branch in this company." }]);
  }
  if (branch.legal_entity_id !== legalEntityId) {
    throw new EmployeeFieldError([
      { field: "branchId", message: "That branch is not part of this legal entity." },
    ]);
  }
  const entities = queryRows<{ id: string }>(
    await tx.execute(sql`
      SELECT id::text AS id FROM id_legal_entities WHERE id = ${legalEntityId}::uuid
    `),
  );
  if (!entities[0]) {
    throw new EmployeeFieldError([{ field: "legalEntityId", message: "Choose a legal entity in this company." }]);
  }
}
