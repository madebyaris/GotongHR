import type { DepartmentInput, DepartmentPatch, DepartmentRecord } from "@gotonghr/contracts";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql, type SQL } from "drizzle-orm";
import { assertReadable, assertWritable } from "../access.ts";
import type { CoreHrAuth } from "../auth.ts";
import { queryRows } from "../sql.ts";
import { writeAudit } from "./audit.ts";
import { OrgConflictError, OrgFieldError, OrgNotFoundError } from "./errors.ts";
import { assertOrgScope, departmentScope } from "./scope.ts";
import { departmentCycle } from "./tree.ts";

const columns = sql`
  d.id::text AS id,
  d.legal_entity_id::text AS legal_entity_id,
  d.branch_id::text AS branch_id,
  d.parent_department_id::text AS parent_department_id,
  d.name,
  d.code,
  d.cost_center_code
`;

interface DepartmentRow {
  id: string;
  legal_entity_id: string;
  branch_id: string | null;
  parent_department_id: string | null;
  name: string;
  code: string;
  cost_center_code: string | null;
}

export async function listDepartments(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  page: { limit: number; offset: number },
  legalEntityId: string | null,
): Promise<DepartmentRecord[]> {
  assertReadable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const entityFilter = legalEntityId ? sql`AND d.legal_entity_id = ${legalEntityId}::uuid` : sql``;
    const rows = queryRows<DepartmentRow>(
      await tx.execute(sql`
        SELECT ${columns}
        FROM hr_departments AS d
        WHERE true
        ${departmentScope(auth)}
        ${entityFilter}
        ORDER BY d.code, d.id
        LIMIT ${page.limit} OFFSET ${page.offset}
      `),
    );
    return rows.map(toRecord);
  });
}

export async function getDepartment(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  id: string,
): Promise<DepartmentRecord | null> {
  assertReadable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => findDepartment(tx, auth, id));
}

export async function createDepartment(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  input: DepartmentInput,
): Promise<DepartmentRecord> {
  assertWritable(auth);
  assertOrgScope(auth, input.legalEntityId, input.branchId);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    await assertEntityBranch(tx, input.legalEntityId, input.branchId);
    await assertParent(tx, input.legalEntityId, input.parentDepartmentId, null);
    const inserted = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(
      await tx.execute(sql`
        INSERT INTO hr_departments (
          tenant_id, legal_entity_id, branch_id, parent_department_id, name, code, cost_center_code
        ) VALUES (
          ${auth.tenantId}::uuid,
          ${input.legalEntityId}::uuid,
          ${input.branchId}::uuid,
          ${input.parentDepartmentId}::uuid,
          ${input.name},
          ${input.code},
          ${input.costCenterCode}
        )
        RETURNING WITH (OLD AS before_row, NEW AS after_row)
          id::text AS id,
          to_jsonb(before_row) AS before_json,
          to_jsonb(after_row) AS after_json
      `),
    );
    const row = inserted[0];
    if (!row?.id) throw new Error("department insert returned no row");
    await writeAudit(tx, auth, "department.create", "hr_departments", row.id, row.before_json, row.after_json);
    const saved = await findDepartment(tx, auth, row.id);
    if (!saved) throw new OrgNotFoundError("That department was not found.");
    return saved;
  });
}

export async function updateDepartment(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  id: string,
  patch: DepartmentPatch,
): Promise<DepartmentRecord> {
  assertWritable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const current = await findDepartment(tx, auth, id);
    if (!current) throw new OrgNotFoundError("That department was not found.");
    const next = merged(current, patch);
    assertOrgScope(auth, next.legalEntityId, next.branchId);
    await assertEntityBranch(tx, next.legalEntityId, next.branchId);
    await assertParent(tx, next.legalEntityId, next.parentDepartmentId, id);
    const sets = changes(current, next);
    if (sets.length === 0) return current;
    const updated = queryRows<{ before_json: unknown; after_json: unknown }>(
      await tx.execute(sql`
        UPDATE hr_departments
        SET ${sql.join(sets, sql`, `)}
        WHERE id = ${id}::uuid AND tenant_id = ${auth.tenantId}::uuid
        RETURNING WITH (OLD AS before_row, NEW AS after_row)
          to_jsonb(before_row) AS before_json,
          to_jsonb(after_row) AS after_json
      `),
    );
    const row = updated[0];
    if (!row) throw new OrgNotFoundError("That department was not found.");
    await writeAudit(tx, auth, "department.update", "hr_departments", id, row.before_json, row.after_json);
    const saved = await findDepartment(tx, auth, id);
    if (!saved) throw new OrgNotFoundError("That department was not found.");
    return saved;
  });
}

export async function deleteDepartment(appDb: TenantDatabase, auth: CoreHrAuth, id: string): Promise<void> {
  assertWritable(auth);
  await appDb.withTenantContext(auth.tenantId, async (tx) => {
    const current = await findDepartment(tx, auth, id);
    if (!current) throw new OrgNotFoundError("That department was not found.");
    assertOrgScope(auth, current.legalEntityId, current.branchId);
    const used = queryRows<{ n: string }>(
      await tx.execute(sql`
        SELECT (
          (SELECT count(*) FROM hr_departments WHERE parent_department_id = ${id}::uuid)
          + (SELECT count(*) FROM hr_positions WHERE department_id = ${id}::uuid)
          + (SELECT count(*) FROM hr_contracts WHERE department_id = ${id}::uuid)
          + (SELECT count(*) FROM hr_employees WHERE department_id = ${id}::uuid)
        )::text AS n
      `),
    );
    if ((used[0]?.n ?? "0") !== "0") {
      throw new OrgConflictError([{ field: "id", message: "This department is still in use." }]);
    }
    const deleted = queryRows<{ before_json: unknown; after_json: unknown }>(
      await tx.execute(sql`
        DELETE FROM hr_departments
        WHERE id = ${id}::uuid AND tenant_id = ${auth.tenantId}::uuid
        RETURNING WITH (OLD AS before_row, NEW AS after_row)
          to_jsonb(before_row) AS before_json,
          to_jsonb(after_row) AS after_json
      `),
    );
    const row = deleted[0];
    if (!row) throw new OrgNotFoundError("That department was not found.");
    await writeAudit(tx, auth, "department.delete", "hr_departments", id, row.before_json, row.after_json);
  });
}

async function findDepartment(tx: TenantTx, auth: CoreHrAuth, id: string): Promise<DepartmentRecord | null> {
  const rows = queryRows<DepartmentRow>(
    await tx.execute(sql`
      SELECT ${columns}
      FROM hr_departments AS d
      WHERE d.id = ${id}::uuid
      ${departmentScope(auth)}
    `),
  );
  const row = rows[0];
  return row ? toRecord(row) : null;
}

async function assertEntityBranch(tx: TenantTx, legalEntityId: string, branchId: string | null): Promise<void> {
  const entities = queryRows<{ id: string }>(
    await tx.execute(sql`SELECT id::text AS id FROM id_legal_entities WHERE id = ${legalEntityId}::uuid`),
  );
  if (!entities[0]) {
    throw new OrgFieldError([{ field: "legalEntityId", message: "Choose a legal entity in this company." }]);
  }
  if (!branchId) return;
  const branches = queryRows<{ legal_entity_id: string }>(
    await tx.execute(sql`
      SELECT legal_entity_id::text AS legal_entity_id
      FROM id_branches
      WHERE id = ${branchId}::uuid
    `),
  );
  const branch = branches[0];
  if (!branch) throw new OrgFieldError([{ field: "branchId", message: "Choose a branch in this company." }]);
  if (branch.legal_entity_id !== legalEntityId) {
    throw new OrgFieldError([{ field: "branchId", message: "That branch is not part of this legal entity." }]);
  }
}

async function assertParent(
  tx: TenantTx,
  legalEntityId: string,
  parentId: string | null,
  selfId: string | null,
): Promise<void> {
  if (!parentId) return;
  if (selfId && parentId === selfId) {
    throw new OrgFieldError([{ field: "parentDepartmentId", message: "A department cannot be its own parent." }]);
  }
  const parents = queryRows<{ legal_entity_id: string }>(
    await tx.execute(sql`
      SELECT legal_entity_id::text AS legal_entity_id
      FROM hr_departments
      WHERE id = ${parentId}::uuid
    `),
  );
  const parent = parents[0];
  if (!parent) {
    throw new OrgFieldError([{ field: "parentDepartmentId", message: "Choose a parent department in this company." }]);
  }
  if (parent.legal_entity_id !== legalEntityId) {
    throw new OrgFieldError([{ field: "parentDepartmentId", message: "The parent department is in another legal entity." }]);
  }
  if (!selfId) return;
  const cycle = await departmentCycle(tx, parentId, selfId);
  if (cycle === "cycle") {
    throw new OrgFieldError([{ field: "parentDepartmentId", message: "That parent is already under this department." }]);
  }
  if (cycle === "deep") {
    throw new OrgFieldError([{ field: "parentDepartmentId", message: "That department tree is too deep." }]);
  }
}

function merged(current: DepartmentRecord, patch: DepartmentPatch): DepartmentRecord {
  return {
    ...current,
    legalEntityId: patch.legalEntityId ?? current.legalEntityId,
    branchId: patch.branchId === undefined ? current.branchId : patch.branchId,
    parentDepartmentId:
      patch.parentDepartmentId === undefined ? current.parentDepartmentId : patch.parentDepartmentId,
    name: patch.name ?? current.name,
    code: patch.code ?? current.code,
    costCenterCode: patch.costCenterCode === undefined ? current.costCenterCode : patch.costCenterCode,
  };
}

function changes(current: DepartmentRecord, next: DepartmentRecord): SQL[] {
  const sets: SQL[] = [];
  if (next.legalEntityId !== current.legalEntityId) sets.push(sql`legal_entity_id = ${next.legalEntityId}::uuid`);
  if (next.branchId !== current.branchId) sets.push(sql`branch_id = ${next.branchId}::uuid`);
  if (next.parentDepartmentId !== current.parentDepartmentId) {
    sets.push(sql`parent_department_id = ${next.parentDepartmentId}::uuid`);
  }
  if (next.name !== current.name) sets.push(sql`name = ${next.name}`);
  if (next.code !== current.code) sets.push(sql`code = ${next.code}`);
  if (next.costCenterCode !== current.costCenterCode) sets.push(sql`cost_center_code = ${next.costCenterCode}`);
  return sets;
}

function toRecord(row: DepartmentRow): DepartmentRecord {
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    branchId: row.branch_id,
    parentDepartmentId: row.parent_department_id,
    name: row.name,
    code: row.code,
    costCenterCode: row.cost_center_code,
  };
}
