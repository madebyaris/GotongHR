import { sql, type SQL } from "drizzle-orm";
import type { CoreHrAuth } from "../auth.ts";
import { EmployeeForbiddenError } from "../errors.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Empty scope arrays mean the whole tenant. A branch-scoped user still sees entity-wide departments. */
export function departmentScope(auth: CoreHrAuth): SQL {
  return scoped(auth, sql`d.legal_entity_id`, sql`d.branch_id`, true);
}

export function assertOrgScope(auth: CoreHrAuth, legalEntityId: string, branchId: string | null): void {
  const entities = lower(auth.scopeEntityIds);
  const branches = lower(auth.scopeBranchIds);
  if (entities.length > 0 && !entities.includes(legalEntityId.toLowerCase())) {
    throw new EmployeeForbiddenError();
  }
  if (branchId && branches.length > 0 && !branches.includes(branchId.toLowerCase())) {
    throw new EmployeeForbiddenError();
  }
}

function scoped(auth: CoreHrAuth, entity: SQL, branch: SQL, branchNullable: boolean): SQL {
  const parts: SQL[] = [];
  const entities = lower(auth.scopeEntityIds);
  const branches = lower(auth.scopeBranchIds);
  if (entities.length > 0) parts.push(sql`${entity} IN (${uuidList(entities)})`);
  if (branches.length > 0) {
    const list = uuidList(branches);
    parts.push(branchNullable ? sql`(${branch} IS NULL OR ${branch} IN (${list}))` : sql`${branch} IN (${list})`);
  }
  if (parts.length === 0) return sql``;
  return sql`AND ${sql.join(parts, sql` AND `)}`;
}

function lower(ids: readonly string[]): string[] {
  return ids.map((id) => id.toLowerCase());
}

function uuidList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => {
      if (!UUID.test(id)) throw new Error("scope id must be a uuid");
      return sql`${id}::uuid`;
    }),
    sql`, `,
  );
}
