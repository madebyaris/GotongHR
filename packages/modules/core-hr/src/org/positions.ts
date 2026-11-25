import type { PositionInput, PositionPatch, PositionRecord } from "@gotonghr/contracts";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql, type SQL } from "drizzle-orm";
import { assertReadable, assertWritable } from "../access.ts";
import type { CoreHrAuth } from "../auth.ts";
import { queryRows } from "../sql.ts";
import { writeAudit } from "./audit.ts";
import { OrgConflictError, OrgFieldError, OrgNotFoundError } from "./errors.ts";
import { assertOrgScope, departmentScope } from "./scope.ts";
import { positionCycle } from "./tree.ts";

const columns = sql`
  p.id::text AS id,
  p.department_id::text AS department_id,
  p.title,
  p.code,
  p.level_code,
  p.reports_to_position_id::text AS reports_to_position_id
`;

interface PositionRow {
  id: string;
  department_id: string;
  title: string;
  code: string;
  level_code: string | null;
  reports_to_position_id: string | null;
}

interface Placement {
  legalEntityId: string;
  branchId: string | null;
}

export async function listPositions(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  page: { limit: number; offset: number },
  departmentId: string | null,
): Promise<PositionRecord[]> {
  assertReadable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const filter = departmentId ? sql`AND p.department_id = ${departmentId}::uuid` : sql``;
    const rows = queryRows<PositionRow>(
      await tx.execute(sql`
        SELECT ${columns}
        FROM hr_positions AS p
        JOIN hr_departments AS d ON d.id = p.department_id AND d.tenant_id = p.tenant_id
        WHERE true
        ${departmentScope(auth)}
        ${filter}
        ORDER BY p.code, p.id
        LIMIT ${page.limit} OFFSET ${page.offset}
      `),
    );
    return rows.map(toRecord);
  });
}

export async function getPosition(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  id: string,
): Promise<PositionRecord | null> {
  assertReadable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => findPosition(tx, auth, id));
}

export async function createPosition(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  input: PositionInput,
): Promise<PositionRecord> {
  assertWritable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    await assertDepartment(tx, auth, input.departmentId);
    await assertReportsTo(tx, input.reportsToPositionId, null);
    const inserted = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(
      await tx.execute(sql`
        INSERT INTO hr_positions (
          tenant_id, department_id, title, code, level_code, reports_to_position_id
        ) VALUES (
          ${auth.tenantId}::uuid,
          ${input.departmentId}::uuid,
          ${input.title},
          ${input.code},
          ${input.levelCode},
          ${input.reportsToPositionId}::uuid
        )
        RETURNING WITH (OLD AS before_row, NEW AS after_row)
          id::text AS id,
          to_jsonb(before_row) AS before_json,
          to_jsonb(after_row) AS after_json
      `),
    );
    const row = inserted[0];
    if (!row?.id) throw new Error("position insert returned no row");
    await writeAudit(tx, auth, "position.create", "hr_positions", row.id, row.before_json, row.after_json);
    const saved = await findPosition(tx, auth, row.id);
    if (!saved) throw new OrgNotFoundError("That position was not found.");
    return saved;
  });
}

export async function updatePosition(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  id: string,
  patch: PositionPatch,
): Promise<PositionRecord> {
  assertWritable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const current = await findPosition(tx, auth, id);
    if (!current) throw new OrgNotFoundError("That position was not found.");
    const next = merged(current, patch);
    await assertDepartment(tx, auth, next.departmentId);
    await assertReportsTo(tx, next.reportsToPositionId, id);
    const sets = changes(current, next);
    if (sets.length === 0) return current;
    const updated = queryRows<{ before_json: unknown; after_json: unknown }>(
      await tx.execute(sql`
        UPDATE hr_positions
        SET ${sql.join(sets, sql`, `)}
        WHERE id = ${id}::uuid AND tenant_id = ${auth.tenantId}::uuid
        RETURNING WITH (OLD AS before_row, NEW AS after_row)
          to_jsonb(before_row) AS before_json,
          to_jsonb(after_row) AS after_json
      `),
    );
    const row = updated[0];
    if (!row) throw new OrgNotFoundError("That position was not found.");
    await writeAudit(tx, auth, "position.update", "hr_positions", id, row.before_json, row.after_json);
    const saved = await findPosition(tx, auth, id);
    if (!saved) throw new OrgNotFoundError("That position was not found.");
    return saved;
  });
}

export async function deletePosition(appDb: TenantDatabase, auth: CoreHrAuth, id: string): Promise<void> {
  assertWritable(auth);
  await appDb.withTenantContext(auth.tenantId, async (tx) => {
    const current = await findPosition(tx, auth, id);
    if (!current) throw new OrgNotFoundError("That position was not found.");
    await assertDepartment(tx, auth, current.departmentId);
    const used = queryRows<{ n: string }>(
      await tx.execute(sql`
        SELECT (
          (SELECT count(*) FROM hr_positions WHERE reports_to_position_id = ${id}::uuid)
          + (SELECT count(*) FROM hr_contracts WHERE position_id = ${id}::uuid)
          + (SELECT count(*) FROM hr_employees WHERE position_id = ${id}::uuid)
        )::text AS n
      `),
    );
    if ((used[0]?.n ?? "0") !== "0") {
      throw new OrgConflictError([{ field: "id", message: "This position is still in use." }]);
    }
    const deleted = queryRows<{ before_json: unknown; after_json: unknown }>(
      await tx.execute(sql`
        DELETE FROM hr_positions
        WHERE id = ${id}::uuid AND tenant_id = ${auth.tenantId}::uuid
        RETURNING WITH (OLD AS before_row, NEW AS after_row)
          to_jsonb(before_row) AS before_json,
          to_jsonb(after_row) AS after_json
      `),
    );
    const row = deleted[0];
    if (!row) throw new OrgNotFoundError("That position was not found.");
    await writeAudit(tx, auth, "position.delete", "hr_positions", id, row.before_json, row.after_json);
  });
}

async function findPosition(tx: TenantTx, auth: CoreHrAuth, id: string): Promise<PositionRecord | null> {
  const rows = queryRows<PositionRow>(
    await tx.execute(sql`
      SELECT ${columns}
      FROM hr_positions AS p
      JOIN hr_departments AS d ON d.id = p.department_id AND d.tenant_id = p.tenant_id
      WHERE p.id = ${id}::uuid
      ${departmentScope(auth)}
    `),
  );
  const row = rows[0];
  return row ? toRecord(row) : null;
}

async function assertDepartment(tx: TenantTx, auth: CoreHrAuth, departmentId: string): Promise<Placement> {
  const rows = queryRows<{ legal_entity_id: string; branch_id: string | null }>(
    await tx.execute(sql`
      SELECT legal_entity_id::text AS legal_entity_id, branch_id::text AS branch_id
      FROM hr_departments
      WHERE id = ${departmentId}::uuid
    `),
  );
  const row = rows[0];
  if (!row) throw new OrgFieldError([{ field: "departmentId", message: "Choose a department in this company." }]);
  assertOrgScope(auth, row.legal_entity_id, row.branch_id);
  return { legalEntityId: row.legal_entity_id, branchId: row.branch_id };
}

async function assertReportsTo(tx: TenantTx, reportsToId: string | null, selfId: string | null): Promise<void> {
  if (!reportsToId) return;
  if (selfId && reportsToId === selfId) {
    throw new OrgFieldError([{ field: "reportsToPositionId", message: "A position cannot report to itself." }]);
  }
  const rows = queryRows<{ id: string }>(
    await tx.execute(sql`SELECT id::text AS id FROM hr_positions WHERE id = ${reportsToId}::uuid`),
  );
  if (!rows[0]) {
    throw new OrgFieldError([{ field: "reportsToPositionId", message: "Choose a reporting position in this company." }]);
  }
  if (!selfId) return;
  const cycle = await positionCycle(tx, reportsToId, selfId);
  if (cycle === "cycle") {
    throw new OrgFieldError([
      { field: "reportsToPositionId", message: "That position already reports to this one." },
    ]);
  }
  if (cycle === "deep") {
    throw new OrgFieldError([{ field: "reportsToPositionId", message: "That reporting line is too deep." }]);
  }
}

function merged(current: PositionRecord, patch: PositionPatch): PositionRecord {
  return {
    ...current,
    departmentId: patch.departmentId ?? current.departmentId,
    title: patch.title ?? current.title,
    code: patch.code ?? current.code,
    levelCode: patch.levelCode === undefined ? current.levelCode : patch.levelCode,
    reportsToPositionId:
      patch.reportsToPositionId === undefined ? current.reportsToPositionId : patch.reportsToPositionId,
  };
}

function changes(current: PositionRecord, next: PositionRecord): SQL[] {
  const sets: SQL[] = [];
  if (next.departmentId !== current.departmentId) sets.push(sql`department_id = ${next.departmentId}::uuid`);
  if (next.title !== current.title) sets.push(sql`title = ${next.title}`);
  if (next.code !== current.code) sets.push(sql`code = ${next.code}`);
  if (next.levelCode !== current.levelCode) sets.push(sql`level_code = ${next.levelCode}`);
  if (next.reportsToPositionId !== current.reportsToPositionId) {
    sets.push(sql`reports_to_position_id = ${next.reportsToPositionId}::uuid`);
  }
  return sets;
}

function toRecord(row: PositionRow): PositionRecord {
  return {
    id: row.id,
    departmentId: row.department_id,
    title: row.title,
    code: row.code,
    levelCode: row.level_code,
    reportsToPositionId: row.reports_to_position_id,
  };
}
