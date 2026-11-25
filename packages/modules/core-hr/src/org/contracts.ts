import type { ContractInput, ContractRecord } from "@gotonghr/contracts";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql, type SQL } from "drizzle-orm";
import { assertInScope, assertReadable, assertWritable, scopeClause } from "../access.ts";
import type { CoreHrAuth } from "../auth.ts";
import { queryRows } from "../sql.ts";
import { writeAudit } from "./audit.ts";
import { OrgFieldError, OrgNotFoundError } from "./errors.ts";

const columns = sql`
  c.id::text AS id,
  c.employee_id::text AS employee_id,
  c.contract_type,
  c.status,
  c.start_date::text AS start_date,
  c.end_date::text AS end_date,
  c.department_id::text AS department_id,
  c.position_id::text AS position_id,
  c.manager_employee_id::text AS manager_employee_id,
  c.compensation_paid
`;

interface ContractRow {
  id: string;
  employee_id: string;
  contract_type: ContractRecord["contractType"];
  status: ContractRecord["status"];
  start_date: string;
  end_date: string | null;
  department_id: string | null;
  position_id: string | null;
  manager_employee_id: string | null;
  compensation_paid: boolean;
}

interface EmployeePlacement {
  id: string;
  legal_entity_id: string;
  branch_id: string;
}

export async function listContracts(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  employeeId: string,
  page: { limit: number; offset: number },
): Promise<ContractRecord[]> {
  assertReadable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const rows = queryRows<ContractRow>(
      await tx.execute(sql`
        SELECT ${columns}
        FROM hr_contracts AS c
        JOIN hr_employees AS e ON e.id = c.employee_id AND e.tenant_id = c.tenant_id
        WHERE c.employee_id = ${employeeId}::uuid
        ${scopeClause(auth)}
        ORDER BY c.start_date, c.id
        LIMIT ${page.limit} OFFSET ${page.offset}
      `),
    );
    return rows.map(toRecord);
  });
}

export async function createContract(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  employeeId: string,
  input: ContractInput,
): Promise<ContractRecord> {
  assertWritable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const employee = await findEmployee(tx, employeeId);
    if (!employee) throw new OrgNotFoundError("That employee was not found.");
    assertInScope(auth, employee.legal_entity_id, employee.branch_id);
    const linked = await resolveLinks(tx, employee, employeeId, input);
    const inserted = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(
      await tx.execute(sql`
        INSERT INTO hr_contracts (
          tenant_id, employee_id, contract_type, status, start_date, end_date,
          department_id, position_id, manager_employee_id, compensation_paid
        ) VALUES (
          ${auth.tenantId}::uuid,
          ${employeeId}::uuid,
          ${input.contractType},
          ${input.status},
          ${input.startDate}::date,
          ${input.endDate}::date,
          ${linked.departmentId}::uuid,
          ${linked.positionId}::uuid,
          ${linked.managerEmployeeId}::uuid,
          ${input.compensationPaid}
        )
        RETURNING WITH (OLD AS before_row, NEW AS after_row)
          id::text AS id,
          to_jsonb(before_row) AS before_json,
          to_jsonb(after_row) AS after_json
      `),
    );
    const row = inserted[0];
    if (!row?.id) throw new Error("contract insert returned no row");
    await writeAudit(tx, auth, "contract.create", "hr_contracts", row.id, row.before_json, row.after_json);
    await linkEmployee(tx, auth, employeeId, linked);
    const saved = await findContract(tx, auth, row.id);
    if (!saved) throw new OrgNotFoundError("That contract was not found.");
    return saved;
  });
}

async function resolveLinks(
  tx: TenantTx,
  employee: EmployeePlacement,
  employeeId: string,
  input: ContractInput,
): Promise<{ departmentId: string | null; positionId: string | null; managerEmployeeId: string | null }> {
  let departmentId = input.departmentId;
  const positionId = input.positionId;
  if (positionId) {
    const positions = queryRows<{ department_id: string }>(
      await tx.execute(sql`
        SELECT department_id::text AS department_id
        FROM hr_positions
        WHERE id = ${positionId}::uuid
      `),
    );
    const position = positions[0];
    if (!position) throw new OrgFieldError([{ field: "positionId", message: "Choose a position in this company." }]);
    if (departmentId && departmentId !== position.department_id) {
      throw new OrgFieldError([{ field: "positionId", message: "That position is not in this department." }]);
    }
    departmentId = position.department_id;
  }
  if (departmentId) {
    const departments = queryRows<{ legal_entity_id: string; branch_id: string | null }>(
      await tx.execute(sql`
        SELECT legal_entity_id::text AS legal_entity_id, branch_id::text AS branch_id
        FROM hr_departments
        WHERE id = ${departmentId}::uuid
      `),
    );
    const department = departments[0];
    if (!department) {
      throw new OrgFieldError([{ field: "departmentId", message: "Choose a department in this company." }]);
    }
    if (department.legal_entity_id !== employee.legal_entity_id) {
      throw new OrgFieldError([{ field: "departmentId", message: "That department is in another legal entity." }]);
    }
    if (department.branch_id && department.branch_id !== employee.branch_id) {
      throw new OrgFieldError([{ field: "departmentId", message: "That department is for another branch." }]);
    }
  }
  if (input.managerEmployeeId) {
    if (input.managerEmployeeId === employeeId) {
      throw new OrgFieldError([{ field: "managerEmployeeId", message: "An employee cannot report to themselves." }]);
    }
    const managers = queryRows<{ legal_entity_id: string }>(
      await tx.execute(sql`
        SELECT legal_entity_id::text AS legal_entity_id
        FROM hr_employees
        WHERE id = ${input.managerEmployeeId}::uuid
      `),
    );
    const manager = managers[0];
    if (!manager) {
      throw new OrgFieldError([{ field: "managerEmployeeId", message: "Choose a manager in this company." }]);
    }
    if (manager.legal_entity_id !== employee.legal_entity_id) {
      throw new OrgFieldError([
        { field: "managerEmployeeId", message: "Choose a manager in the same legal entity." },
      ]);
    }
  }
  return { departmentId, positionId, managerEmployeeId: input.managerEmployeeId };
}

async function linkEmployee(
  tx: TenantTx,
  auth: CoreHrAuth,
  employeeId: string,
  linked: { departmentId: string | null; positionId: string | null; managerEmployeeId: string | null },
): Promise<void> {
  const sets: SQL[] = [];
  if (linked.departmentId) sets.push(sql`department_id = ${linked.departmentId}::uuid`);
  if (linked.positionId) sets.push(sql`position_id = ${linked.positionId}::uuid`);
  if (linked.managerEmployeeId) sets.push(sql`manager_employee_id = ${linked.managerEmployeeId}::uuid`);
  if (sets.length === 0) return;
  const updated = queryRows<{ before_json: unknown; after_json: unknown }>(
    await tx.execute(sql`
      UPDATE hr_employees
      SET ${sql.join(sets, sql`, `)}
      WHERE id = ${employeeId}::uuid AND tenant_id = ${auth.tenantId}::uuid
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        to_jsonb(before_row) AS before_json,
        to_jsonb(after_row) AS after_json
    `),
  );
  const row = updated[0];
  if (!row) throw new OrgNotFoundError("That employee was not found.");
  await writeAudit(tx, auth, "employee.assignment", "hr_employees", employeeId, row.before_json, row.after_json);
}

async function findEmployee(tx: TenantTx, employeeId: string): Promise<EmployeePlacement | null> {
  const rows = queryRows<EmployeePlacement>(
    await tx.execute(sql`
      SELECT id::text AS id,
             legal_entity_id::text AS legal_entity_id,
             branch_id::text AS branch_id
      FROM hr_employees
      WHERE id = ${employeeId}::uuid
    `),
  );
  return rows[0] ?? null;
}

async function findContract(tx: TenantTx, auth: CoreHrAuth, id: string): Promise<ContractRecord | null> {
  const rows = queryRows<ContractRow>(
    await tx.execute(sql`
      SELECT ${columns}
      FROM hr_contracts AS c
      JOIN hr_employees AS e ON e.id = c.employee_id AND e.tenant_id = c.tenant_id
      WHERE c.id = ${id}::uuid
      ${scopeClause(auth)}
    `),
  );
  const row = rows[0];
  return row ? toRecord(row) : null;
}

function toRecord(row: ContractRow): ContractRecord {
  return {
    id: row.id,
    employeeId: row.employee_id,
    contractType: row.contract_type,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    departmentId: row.department_id,
    positionId: row.position_id,
    managerEmployeeId: row.manager_employee_id,
    compensationPaid: row.compensation_paid,
  };
}
