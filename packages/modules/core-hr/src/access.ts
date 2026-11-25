import { sql, type SQL } from "drizzle-orm";
import type { CoreHrAuth } from "./auth.ts";
import { EmployeeForbiddenError } from "./errors.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function assertReadable(auth: CoreHrAuth): void {
  if (!auth.permissions.includes("employee.read")) {
    throw new EmployeeForbiddenError("Missing permission.");
  }
  assertLinkedScope(auth);
}

export function assertWritable(auth: CoreHrAuth): void {
  if (!auth.permissions.includes("employee.write")) {
    throw new EmployeeForbiddenError("Missing permission.");
  }
  assertLinkedScope(auth);
}

export function assertInScope(auth: CoreHrAuth, legalEntityId: string, branchId: string): void {
  const entities = lower(auth.scopeEntityIds);
  const branches = lower(auth.scopeBranchIds);
  if (entities.length > 0 && !entities.includes(legalEntityId.toLowerCase())) {
    throw new EmployeeForbiddenError();
  }
  if (branches.length > 0 && !branches.includes(branchId.toLowerCase())) {
    throw new EmployeeForbiddenError();
  }
}

/** Empty scope arrays mean the whole tenant. A non-empty list limits the rows. */
export function scopeClause(auth: CoreHrAuth): SQL {
  const parts: SQL[] = [];
  const entities = lower(auth.scopeEntityIds);
  const branches = lower(auth.scopeBranchIds);
  if (entities.length > 0) {
    parts.push(sql`e.legal_entity_id IN (${uuidParams(entities)})`);
  }
  if (branches.length > 0) {
    parts.push(sql`e.branch_id IN (${uuidParams(branches)})`);
  }
  if (parts.length === 0) return sql``;
  return sql`AND ${sql.join(parts, sql` AND `)}`;
}

export function assertLinkedScope(auth: CoreHrAuth): void {
  if (auth.selfOnly || auth.directReportsOnly) {
    throw new EmployeeForbiddenError("Employee directory scope is not available for this role yet.");
  }
}

function lower(ids: readonly string[]): string[] {
  return ids.map((id) => id.toLowerCase());
}

function uuidParams(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => {
      if (!UUID.test(id)) throw new Error("scope id must be a uuid");
      return sql`${id}::uuid`;
    }),
    sql`, `,
  );
}
