import { appendAuditEvent, auditedUpdate } from "@gotonghr/audit";
import type { EmployeeCreateInput, EmployeePatch, EmployeeRecord } from "@gotonghr/contracts";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql, type SQL } from "drizzle-orm";
import { assertInScope, assertWritable } from "./access.ts";
import type { CoreHrAuth } from "./auth.ts";
import {
  EmployeeConflictError,
  EmployeeFieldError,
  EmployeeForbiddenError,
  EmployeeNotFoundError,
} from "./errors.ts";
import { assertOrgAssignment } from "./directory/placement.ts";
import { findEmployeeTx } from "./read.ts";
import { nikHashFor, npwpHashFor, sealField, sealPii } from "./seal.ts";
import { asObject, clip, errorCode, errorConstraint, queryRows } from "./sql.ts";

export async function createEmployee(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  input: EmployeeCreateInput,
): Promise<EmployeeRecord> {
  assertWritable(auth);
  assertInScope(auth, input.legalEntityId, input.branchId);
  try {
    return await appDb.withTenantContext(auth.tenantId, async (tx) => {
      await assertPlacement(tx, input.legalEntityId, input.branchId);
      await assertOrgAssignment(tx, input.departmentId, input.positionId);
      const sealed = await sealPii(tx, auth.tenantId, input);
      const employeeId = await insertEmployee(tx, auth, input);
      await insertPii(tx, auth, employeeId, sealed);
      const saved = await findEmployeeTx(tx, auth, employeeId);
      if (!saved) throw new EmployeeNotFoundError();
      return saved;
    });
  } catch (error) {
    rethrowEmployee(error);
  }
}

export async function updateEmployee(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  id: string,
  patch: EmployeePatch,
): Promise<EmployeeRecord> {
  assertWritable(auth);
  try {
    return await appDb.withTenantContext(auth.tenantId, async (tx) => {
      const current = await findEmployeeTx(tx, auth, id);
      if (!current) throw new EmployeeNotFoundError();
      const next = merged(current, patch);
      assertInScope(auth, next.legalEntityId, next.branchId);
      await assertPlacement(tx, next.legalEntityId, next.branchId);
      await assertOrgAssignment(tx, next.departmentId, next.positionId);
      const employeeChanged = await updateEmployeeRow(tx, auth, id, current, next);
      const piiChanged = await updatePiiRow(tx, auth, id, patch);
      if (!employeeChanged && !piiChanged) return current;
      const saved = await findEmployeeTx(tx, auth, id);
      if (!saved) throw new EmployeeNotFoundError();
      return saved;
    });
  } catch (error) {
    rethrowEmployee(error);
  }
}

async function insertEmployee(tx: TenantTx, auth: CoreHrAuth, input: EmployeeCreateInput): Promise<string> {
  const inserted = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(
    await tx.execute(sql`
      INSERT INTO hr_employees (
        tenant_id, employee_code, full_name, legal_entity_id, branch_id,
        department_id, position_id, employment_status, join_date, ptkp_status,
        tax_method, pph21_subject_type
      )
      VALUES (
        ${auth.tenantId}::uuid,
        ${input.employeeCode},
        ${input.fullName},
        ${input.legalEntityId}::uuid,
        ${input.branchId}::uuid,
        ${input.departmentId}::uuid,
        ${input.positionId}::uuid,
        ${input.employmentStatus},
        ${input.joinDate}::date,
        ${input.ptkpStatus},
        ${input.taxMethod},
        ${input.pph21SubjectType}
      )
      RETURNING WITH (
        OLD AS before_row,
        NEW AS after_row
      )
      id::text AS id,
      to_jsonb(before_row) AS before_json,
      to_jsonb(after_row) AS after_json
    `),
  );
  const row = inserted[0];
  if (!row?.id) throw new Error("employee insert returned no row");
  await appendAuditEvent(
    tx,
    {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorRole: auth.role,
      action: "employee.create",
      resourceType: "hr_employees",
      resourceId: row.id,
      diff: { before: asObject(row.before_json), after: asObject(row.after_json) },
      aiProposalId: null,
      supportGrantId: null,
      ipAddress: clip(auth.ipAddress, 64),
      userAgent: clip(auth.userAgent, 512),
    },
    { requireTenantKeys: true },
  );
  return row.id;
}

async function insertPii(
  tx: TenantTx,
  auth: CoreHrAuth,
  employeeId: string,
  sealed: Awaited<ReturnType<typeof sealPii>>,
): Promise<void> {
  const inserted = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(
    await tx.execute(sql`
      INSERT INTO hr_employee_pii (
        tenant_id, employee_id, nik_enc, npwp_enc, kk_number_enc,
        bpjs_kesehatan_no_enc, bpjs_tk_no_enc, bank_account_number_enc,
        nik_hash, npwp_hash, nik_mask, npwp_mask, kk_number_mask,
        bpjs_kesehatan_no_mask, bpjs_tk_no_mask, bank_account_number_mask
      )
      VALUES (
        ${auth.tenantId}::uuid,
        ${employeeId}::uuid,
        ${sealed.nikEnc},
        ${sealed.npwpEnc},
        ${sealed.kkNumberEnc},
        ${sealed.bpjsKesehatanNoEnc},
        ${sealed.bpjsTkNoEnc},
        ${sealed.bankAccountNumberEnc},
        ${sealed.nikHash},
        ${sealed.npwpHash},
        ${sealed.nikMask},
        ${sealed.npwpMask},
        ${sealed.kkNumberMask},
        ${sealed.bpjsKesehatanNoMask},
        ${sealed.bpjsTkNoMask},
        ${sealed.bankAccountNumberMask}
      )
      RETURNING WITH (
        OLD AS before_row,
        NEW AS after_row
      )
      id::text AS id,
      to_jsonb(before_row) AS before_json,
      to_jsonb(after_row) AS after_json
    `),
  );
  const row = inserted[0];
  if (!row?.id) throw new Error("employee pii insert returned no row");
  await appendAuditEvent(
    tx,
    {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorRole: auth.role,
      action: "employee.pii.create",
      resourceType: "hr_employee_pii",
      resourceId: employeeId,
      diff: { before: asObject(row.before_json), after: asObject(row.after_json) },
      aiProposalId: null,
      supportGrantId: null,
      ipAddress: clip(auth.ipAddress, 64),
      userAgent: clip(auth.userAgent, 512),
    },
    { requireTenantKeys: true },
  );
}

async function updateEmployeeRow(
  tx: TenantTx,
  auth: CoreHrAuth,
  id: string,
  current: EmployeeRecord,
  next: EmployeeRecord,
): Promise<boolean> {
  const sets: SQL[] = [];
  if (next.employeeCode !== current.employeeCode) sets.push(sql`employee_code = ${next.employeeCode}`);
  if (next.fullName !== current.fullName) sets.push(sql`full_name = ${next.fullName}`);
  if (next.legalEntityId !== current.legalEntityId) {
    sets.push(sql`legal_entity_id = ${next.legalEntityId}::uuid`);
  }
  if (next.branchId !== current.branchId) sets.push(sql`branch_id = ${next.branchId}::uuid`);
  if (next.departmentId !== current.departmentId) {
    sets.push(sql`department_id = ${next.departmentId}::uuid`);
  }
  if (next.positionId !== current.positionId) sets.push(sql`position_id = ${next.positionId}::uuid`);
  if (next.employmentStatus !== current.employmentStatus) {
    sets.push(sql`employment_status = ${next.employmentStatus}`);
  }
  if (next.joinDate !== current.joinDate) sets.push(sql`join_date = ${next.joinDate}::date`);
  if (next.ptkpStatus !== current.ptkpStatus) sets.push(sql`ptkp_status = ${next.ptkpStatus}`);
  if (next.taxMethod !== current.taxMethod) sets.push(sql`tax_method = ${next.taxMethod}`);
  if (next.pph21SubjectType !== current.pph21SubjectType) {
    sets.push(sql`pph21_subject_type = ${next.pph21SubjectType}`);
  }
  if (sets.length === 0) return false;
  const updated = queryRows<{ before_json: unknown; after_json: unknown }>(
    await tx.execute(sql`
      UPDATE hr_employees
      SET ${sql.join(sets, sql`, `)}
      WHERE id = ${id}::uuid
        AND tenant_id = ${auth.tenantId}::uuid
      RETURNING WITH (OLD AS before_row, NEW AS after_row)
        to_jsonb(before_row) AS before_json,
        to_jsonb(after_row) AS after_json
    `),
  );
  const row = updated[0];
  if (!row) throw new EmployeeNotFoundError();
  await appendAuditEvent(
    tx,
    {
      tenantId: auth.tenantId,
      actorUserId: auth.userId,
      actorRole: auth.role,
      action: "employee.update",
      resourceType: "hr_employees",
      resourceId: id,
      diff: { before: asObject(row.before_json), after: asObject(row.after_json) },
      aiProposalId: null,
      supportGrantId: null,
      ipAddress: clip(auth.ipAddress, 64),
      userAgent: clip(auth.userAgent, 512),
    },
    { requireTenantKeys: true },
  );
  return true;
}

async function updatePiiRow(
  tx: TenantTx,
  auth: CoreHrAuth,
  employeeId: string,
  patch: EmployeePatch,
): Promise<boolean> {
  const hashes = queryRows<{ nik_hash: string; npwp_hash: string | null }>(
    await tx.execute(sql`
      SELECT nik_hash, npwp_hash
      FROM hr_employee_pii
      WHERE employee_id = ${employeeId}::uuid
    `),
  )[0];
  if (!hashes) throw new EmployeeNotFoundError();
  const assignments: Record<string, string | null> = {};
  if (patch.nik !== undefined) {
    const hash = await nikHashFor(tx, auth.tenantId, patch.nik);
    if (hash !== hashes.nik_hash) {
      const sealed = await sealField(tx, auth.tenantId, "nik", patch.nik);
      assignments.nik_enc = sealed.enc;
      assignments.nik_hash = sealed.hash;
      assignments.nik_mask = sealed.mask;
    }
  }
  if (patch.npwp !== undefined) {
    const hash = await npwpHashFor(tx, auth.tenantId, patch.npwp);
    if (hash !== hashes.npwp_hash) {
      const sealed = await sealField(tx, auth.tenantId, "npwp", patch.npwp);
      assignments.npwp_enc = sealed.enc;
      assignments.npwp_hash = sealed.hash;
      assignments.npwp_mask = sealed.mask;
    }
  }
  await assignOptional(assignments, tx, auth.tenantId, "kk_number", patch.kkNumber);
  await assignOptional(assignments, tx, auth.tenantId, "bpjs_kesehatan_no", patch.bpjsKesehatanNo);
  await assignOptional(assignments, tx, auth.tenantId, "bpjs_tk_no", patch.bpjsTkNo);
  await assignOptional(assignments, tx, auth.tenantId, "bank_account_number", patch.bankAccountNumber);
  if (Object.keys(assignments).length === 0) return false;
  await auditedUpdate(tx, {
    table: "hr_employee_pii",
    idColumn: "employee_id",
    tenantId: auth.tenantId,
    assignments,
    action: "employee.pii.update",
    resourceType: "hr_employee_pii",
    resourceId: employeeId,
    actorUserId: auth.userId,
    actorRole: auth.role,
    ...optionalActor(auth),
  });
  return true;
}

async function assignOptional(
  assignments: Record<string, string | null>,
  tx: TenantTx,
  tenantId: string,
  field: "kk_number" | "bpjs_kesehatan_no" | "bpjs_tk_no" | "bank_account_number",
  value: string | null | undefined,
): Promise<void> {
  if (value === undefined) return;
  const sealed = await sealField(tx, tenantId, field, value);
  assignments[`${field}_enc`] = sealed.enc;
  assignments[`${field}_mask`] = sealed.mask;
}

function merged(current: EmployeeRecord, patch: EmployeePatch): EmployeeRecord {
  return {
    ...current,
    employeeCode: patch.employeeCode ?? current.employeeCode,
    fullName: patch.fullName ?? current.fullName,
    legalEntityId: patch.legalEntityId ?? current.legalEntityId,
    branchId: patch.branchId ?? current.branchId,
    departmentId: patch.departmentId === undefined ? current.departmentId : patch.departmentId,
    positionId: patch.positionId === undefined ? current.positionId : patch.positionId,
    employmentStatus: patch.employmentStatus ?? current.employmentStatus,
    joinDate: patch.joinDate ?? current.joinDate,
    ptkpStatus: patch.ptkpStatus ?? current.ptkpStatus,
    taxMethod: patch.taxMethod ?? current.taxMethod,
    pph21SubjectType: patch.pph21SubjectType ?? current.pph21SubjectType,
  };
}

async function assertPlacement(tx: TenantTx, legalEntityId: string, branchId: string): Promise<void> {
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

function optionalActor(auth: CoreHrAuth): { ipAddress?: string; userAgent?: string } {
  const ipAddress = clip(auth.ipAddress, 64);
  const userAgent = clip(auth.userAgent, 512);
  return {
    ...(ipAddress ? { ipAddress } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

function rethrowEmployee(error: unknown): never {
  if (
    error instanceof EmployeeFieldError ||
    error instanceof EmployeeConflictError ||
    error instanceof EmployeeNotFoundError ||
    error instanceof EmployeeForbiddenError
  ) {
    throw error;
  }
  const code = errorCode(error);
  const constraint = errorConstraint(error);
  if (code === "23505" && constraint.includes("nik_hash")) {
    throw new EmployeeConflictError([{ field: "nik", message: "This NIK is already used." }]);
  }
  if (code === "23505" && constraint.includes("code")) {
    throw new EmployeeConflictError([{ field: "employeeCode", message: "This employee code is already used." }]);
  }
  if (code === "23505") {
    throw new EmployeeConflictError([{ field: "body", message: "That value is already used." }]);
  }
  if (code === "23503" && constraint.includes("department")) {
    throw new EmployeeFieldError([{ field: "departmentId", message: "Choose a department." }]);
  }
  if (code === "23503" && constraint.includes("position")) {
    throw new EmployeeFieldError([{ field: "positionId", message: "Choose a position." }]);
  }
  if (code === "23503") {
    throw new EmployeeFieldError([{ field: "branchId", message: "Choose a branch in this company." }]);
  }
  if (code === "23514") {
    throw new EmployeeFieldError([{ field: "body", message: "A value does not match the employee rules." }]);
  }
  if (error instanceof Error && error.message === "audit target was not found") {
    throw new EmployeeNotFoundError();
  }
  throw error;
}
