import {
  idrToJson,
  type CompensationCreateInput,
  type CompensationRecord,
  type ContractCreateInput,
  type ContractRecord,
  type ContractType,
  type DepartmentRecord,
  type PositionCreateInput,
  type PositionRecord,
} from "@gotonghr/contracts";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { assertReadable, assertWritable } from "../access.ts";
import type { CoreHrAuth } from "../auth.ts";
import { EmployeeConflictError, EmployeeFieldError, EmployeeNotFoundError } from "../errors.ts";
import { findEmployeeTx } from "../read.ts";
import { errorCode, errorConstraint, queryRows } from "../sql.ts";

export async function listDepartments(appDb: TenantDatabase, auth: CoreHrAuth): Promise<DepartmentRecord[]> {
  assertReadable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const rows = queryRows<{ id: string; name: string }>(
      await tx.execute(sql`
        SELECT id::text AS id, name
        FROM hr_departments
        ORDER BY name, id
      `),
    );
    return rows.map((row) => ({ id: row.id, name: row.name }));
  });
}

export async function createDepartment(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  name: string,
): Promise<DepartmentRecord> {
  assertWritable(auth);
  try {
    return await appDb.withTenantContext(auth.tenantId, async (tx) => {
      const inserted = queryRows<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO hr_departments (tenant_id, name)
          VALUES (${auth.tenantId}::uuid, ${name})
          RETURNING id::text AS id
        `),
      );
      const id = inserted[0]?.id;
      if (!id) throw new Error("department insert returned no row");
      return { id, name };
    });
  } catch (error) {
    rethrowDirectory(error, "name");
  }
}

export async function listPositions(appDb: TenantDatabase, auth: CoreHrAuth): Promise<PositionRecord[]> {
  assertReadable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const rows = queryRows<{ id: string; department_id: string | null; name: string }>(
      await tx.execute(sql`
        SELECT id::text AS id, department_id::text AS department_id, name
        FROM hr_positions
        ORDER BY name, id
      `),
    );
    return rows.map((row) => ({ id: row.id, departmentId: row.department_id, name: row.name }));
  });
}

export async function createPosition(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  input: PositionCreateInput,
): Promise<PositionRecord> {
  assertWritable(auth);
  try {
    return await appDb.withTenantContext(auth.tenantId, async (tx) => {
      if (input.departmentId) {
        const found = queryRows<{ id: string }>(
          await tx.execute(sql`SELECT id::text AS id FROM hr_departments WHERE id = ${input.departmentId}::uuid`),
        );
        if (!found[0]) {
          throw new EmployeeFieldError([{ field: "departmentId", message: "Choose a department." }]);
        }
      }
      const inserted = queryRows<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO hr_positions (tenant_id, department_id, name)
          VALUES (${auth.tenantId}::uuid, ${input.departmentId}::uuid, ${input.name})
          RETURNING id::text AS id
        `),
      );
      const id = inserted[0]?.id;
      if (!id) throw new Error("position insert returned no row");
      return { id, departmentId: input.departmentId, name: input.name };
    });
  } catch (error) {
    rethrowDirectory(error, "name");
  }
}

export async function listContracts(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  employeeId: string,
): Promise<ContractRecord[]> {
  assertReadable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const employee = await findEmployeeTx(tx, auth, employeeId);
    if (!employee) throw new EmployeeNotFoundError();
    const rows = queryRows<ContractRow>(
      await tx.execute(sql`
        SELECT
          id::text AS id,
          employee_id::text AS employee_id,
          contract_type,
          start_date::text AS start_date,
          end_date::text AS end_date,
          compensation_paid
        FROM hr_contracts
        WHERE employee_id = ${employeeId}::uuid
        ORDER BY start_date DESC, id DESC
      `),
    );
    return rows.map(toContract);
  });
}

export async function createContract(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  employeeId: string,
  input: ContractCreateInput,
): Promise<ContractRecord> {
  assertWritable(auth);
  try {
    return await appDb.withTenantContext(auth.tenantId, async (tx) => {
      const employee = await findEmployeeTx(tx, auth, employeeId);
      if (!employee) throw new EmployeeNotFoundError();
      const inserted = queryRows<ContractRow>(
        await tx.execute(sql`
          INSERT INTO hr_contracts (
            tenant_id, employee_id, contract_type, start_date, end_date
          )
          VALUES (
            ${auth.tenantId}::uuid,
            ${employeeId}::uuid,
            ${input.contractType},
            ${input.startDate}::date,
            ${input.endDate}::date
          )
          RETURNING
            id::text AS id,
            employee_id::text AS employee_id,
            contract_type,
            start_date::text AS start_date,
            end_date::text AS end_date,
            compensation_paid
        `),
      );
      const row = inserted[0];
      if (!row) throw new Error("contract insert returned no row");
      return toContract(row);
    });
  } catch (error) {
    rethrowDirectory(error, "endDate");
  }
}

export async function listCompensation(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  employeeId: string,
): Promise<CompensationRecord[]> {
  assertReadable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    const employee = await findEmployeeTx(tx, auth, employeeId);
    if (!employee) throw new EmployeeNotFoundError();
    return readCompensation(tx, employeeId);
  });
}

export async function createCompensation(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  employeeId: string,
  input: CompensationCreateInput,
): Promise<CompensationRecord> {
  assertWritable(auth);
  try {
    return await appDb.withTenantContext(auth.tenantId, async (tx) => {
      const employee = await findEmployeeTx(tx, auth, employeeId);
      if (!employee) throw new EmployeeNotFoundError();
      const inserted = queryRows<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO hr_compensation_profiles (
            tenant_id, employee_id, base_salary_idr, fixed_allowances_json, bpjs_flags_json, effective_from
          )
          VALUES (
            ${auth.tenantId}::uuid,
            ${employeeId}::uuid,
            ${input.baseSalaryIdr.toString()}::bigint,
            '{}'::jsonb,
            '{}'::jsonb,
            ${input.effectiveFrom}::date
          )
          RETURNING id::text AS id
        `),
      );
      const id = inserted[0]?.id;
      if (!id) throw new Error("compensation insert returned no row");
      const saved = (await readCompensation(tx, employeeId)).find((row) => row.id === id);
      if (!saved) throw new Error("compensation insert could not be read");
      return saved;
    });
  } catch (error) {
    rethrowDirectory(error, "effectiveFrom");
  }
}

interface ContractRow {
  id: string;
  employee_id: string;
  contract_type: string;
  start_date: string;
  end_date: string | null;
  compensation_paid: boolean;
}

interface PayRow {
  id: string;
  employee_id: string;
  base_salary_idr: string | number | bigint;
  effective_from: string;
}

async function readCompensation(tx: TenantTx, employeeId: string): Promise<CompensationRecord[]> {
  const rows = queryRows<PayRow>(
    await tx.execute(sql`
      SELECT
        id::text AS id,
        employee_id::text AS employee_id,
        base_salary_idr::text AS base_salary_idr,
        effective_from::text AS effective_from
      FROM hr_compensation_profiles
      WHERE employee_id = ${employeeId}::uuid
      ORDER BY effective_from DESC, id DESC
    `),
  );
  return rows.map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    baseSalaryIdr: idrToJson(BigInt(row.base_salary_idr)),
    effectiveFrom: row.effective_from,
  }));
}

function toContract(row: ContractRow): ContractRecord {
  return {
    id: row.id,
    employeeId: row.employee_id,
    contractType: asContractType(row.contract_type),
    startDate: row.start_date,
    endDate: row.end_date,
    compensationPaid: row.compensation_paid,
  };
}

function asContractType(value: string): ContractType {
  if (value === "PKWT" || value === "PKWTT") return value;
  throw new Error("contract type is not valid");
}

function rethrowDirectory(error: unknown, conflictField: string): never {
  if (
    error instanceof EmployeeFieldError ||
    error instanceof EmployeeNotFoundError ||
    error instanceof EmployeeConflictError
  ) {
    throw error;
  }
  const code = errorCode(error);
  const constraint = errorConstraint(error);
  if (code === "23505") {
    const message =
      constraint.includes("effective")
        ? "A pay profile already starts on that date."
        : "That name is already used.";
    throw new EmployeeConflictError([{ field: conflictField, message }]);
  }
  if (code === "23514" || code === "23503") {
    throw new EmployeeFieldError([{ field: conflictField, message: "Check the highlighted fields." }]);
  }
  throw error;
}
