import { sql, type SQL } from "drizzle-orm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asBool(value: unknown): boolean | null {
  if (value === true || value === "t" || value === "true") return true;
  if (value === false || value === "f" || value === "false") return false;
  return null;
}

export function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

/** Empty scope is the whole tenant. A non-empty list is the only branches in view. */
export function branchScopeSql(scopeBranchIds: readonly string[]): SQL {
  if (scopeBranchIds.length === 0) return sql`TRUE`;
  for (const id of scopeBranchIds) {
    if (!UUID.test(id)) throw new Error("branch scope is not a uuid");
  }
  const ids = scopeBranchIds.map((id) => sql`${id}::uuid`);
  return sql`e.branch_id IN (${sql.join(ids, sql`, `)})`;
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
