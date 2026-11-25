import { appendAuditEvent } from "@gotonghr/audit";
import type { EmployeeCreateInput } from "@gotonghr/contracts";
import { blindIndex } from "@gotonghr/crypto";
import type { TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { sealPiiWithSecrets } from "../seal.ts";
import { asObject, clip, queryRows } from "../sql.ts";

export interface ImportActor {
  tenantId: string;
  userId: string;
  role: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface ImportSecrets {
  dek: Buffer;
  pepper: Buffer;
}

export function hashNik(secrets: ImportSecrets, nik: string): string {
  return blindIndex(secrets.pepper, nik);
}

/** Inserts one employee and the sealed PII row in the caller's transaction. */
export async function insertImportedEmployee(
  tx: TenantTx,
  actor: ImportActor,
  input: EmployeeCreateInput,
  secrets: ImportSecrets,
): Promise<void> {
  const employeeId = await insertEmployee(tx, actor, input);
  const sealed = sealPiiWithSecrets(secrets, actor.tenantId, input);
  await insertPii(tx, actor, employeeId, sealed);
}

async function insertEmployee(tx: TenantTx, actor: ImportActor, input: EmployeeCreateInput): Promise<string> {
  const inserted = queryRows<{ id: string; before_json: unknown; after_json: unknown }>(
    await tx.execute(sql`
      INSERT INTO hr_employees (
        tenant_id, employee_code, full_name, legal_entity_id, branch_id,
        department_id, position_id, employment_status, join_date, ptkp_status,
        tax_method, pph21_subject_type
      )
      VALUES (
        ${actor.tenantId}::uuid,
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
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "employee.create",
      resourceType: "hr_employees",
      resourceId: row.id,
      diff: { before: asObject(row.before_json), after: asObject(row.after_json) },
      aiProposalId: null,
      supportGrantId: null,
      ipAddress: clip(actor.ipAddress, 64),
      userAgent: clip(actor.userAgent, 512),
    },
    { requireTenantKeys: true },
  );
  return row.id;
}

async function insertPii(
  tx: TenantTx,
  actor: ImportActor,
  employeeId: string,
  sealed: ReturnType<typeof sealPiiWithSecrets>,
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
        ${actor.tenantId}::uuid,
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
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "employee.pii.create",
      resourceType: "hr_employee_pii",
      resourceId: employeeId,
      diff: { before: asObject(row.before_json), after: asObject(row.after_json) },
      aiProposalId: null,
      supportGrantId: null,
      ipAddress: clip(actor.ipAddress, 64),
      userAgent: clip(actor.userAgent, 512),
    },
    { requireTenantKeys: true },
  );
}
