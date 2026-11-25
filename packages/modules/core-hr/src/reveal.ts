import { asCiphertext, revealPii } from "@gotonghr/audit/reveal";
import { supportPiiRevealDeny, supportPiiRevealSetting, type EmployeePiiField } from "@gotonghr/contracts";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { assertLinkedScope } from "./access.ts";
import type { CoreHrAuth } from "./auth.ts";
import { EmployeeFieldError, EmployeeForbiddenError, EmployeeNotFoundError } from "./errors.ts";
import { findEmployeeTx } from "./read.ts";
import { clip, queryRows } from "./sql.ts";

const encColumn: Record<EmployeePiiField, string> = {
  nik: "nik_enc",
  npwp: "npwp_enc",
  kk_number: "kk_number_enc",
  bpjs_kesehatan_no: "bpjs_kesehatan_no_enc",
  bpjs_tk_no: "bpjs_tk_no_enc",
  bank_account_number: "bank_account_number_enc",
};

export interface RevealedEmployeePii {
  employeeId: string;
  values: Partial<Record<EmployeePiiField, string>>;
}

/**
 * Decrypts the requested fields after `revealPii` writes one access log row each.
 * A missing stored field fails before any reveal call, so a bad field leaves no log row.
 */
export async function revealEmployeePii(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  employeeId: string,
  input: { reason: string; fields: readonly EmployeePiiField[] },
): Promise<RevealedEmployeePii> {
  if (!auth.permissions.includes("employee.pii.reveal")) {
    throw new EmployeeForbiddenError("Missing permission.");
  }
  if (input.fields.length === 0) {
    throw new EmployeeFieldError([{ field: "fields", message: "Choose a field to reveal." }]);
  }
  assertLinkedScope(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    if (auth.supportGrantAllowPiiReveal === false) {
      await tx.execute(
        sql`select set_config(${supportPiiRevealSetting}, ${supportPiiRevealDeny}, true)`,
      );
    }
    const visible = await findEmployeeTx(tx, auth, employeeId);
    if (!visible) throw new EmployeeNotFoundError();
    const stored = await loadCiphertext(tx, employeeId, input.fields);
    const missing = input.fields.filter((field) => !stored[field]);
    const firstMissing = missing[0];
    if (firstMissing) {
      throw new EmployeeFieldError([{ field: firstMissing, message: "That field is not stored." }]);
    }
    const values: Partial<Record<EmployeePiiField, string>> = {};
    for (const field of input.fields) {
      const ciphertext = stored[field];
      if (!ciphertext) {
        throw new EmployeeFieldError([{ field, message: "That field is not stored." }]);
      }
      const ipAddress = clip(auth.ipAddress, 64);
      const revealed = await revealPii(tx, {
        tenantId: auth.tenantId,
        userId: auth.userId,
        permissions: auth.permissions,
        ...(ipAddress ? { ipAddress } : {}),
        ...(auth.supportGrantAllowPiiReveal === false ? { supportGrantAllowPiiReveal: false } : {}),
      }, {
        field,
        ciphertext: asCiphertext(ciphertext),
        resourceType: "hr_employee_pii",
        resourceId: employeeId,
        reason: input.reason,
      });
      values[field] = revealed;
    }
    return { employeeId, values };
  });
}

async function loadCiphertext(
  tx: TenantTx,
  employeeId: string,
  fields: readonly EmployeePiiField[],
): Promise<Partial<Record<EmployeePiiField, string | null>>> {
  const selected = sql.join(
    fields.map((field) => {
      const column = encColumn[field];
      if (!column) throw new Error("unknown pii field");
      return sql`${sql.raw(column)} AS ${sql.raw(field)}`;
    }),
    sql`, `,
  );
  const rows = queryRows<Partial<Record<EmployeePiiField, string | null>>>(
    await tx.execute(sql`
      SELECT ${selected}
      FROM hr_employee_pii
      WHERE employee_id = ${employeeId}::uuid
    `),
  );
  return rows[0] ?? {};
}
