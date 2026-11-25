import { idrToJson, type BpjsFlags, type CompensationCreateInput, type CompensationProfileRecord } from "@gotonghr/contracts";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { assertInScope, assertReadable, assertWritable } from "../access.ts";
import type { CoreHrAuth } from "../auth.ts";
import { queryRows } from "../sql.ts";
import { writeAudit } from "./audit.ts";
import { OrgFieldError, OrgNotFoundError } from "./errors.ts";

const columns = sql`
  id::text AS id,
  employee_id::text AS employee_id,
  base_salary_idr::text AS base_salary_idr,
  fixed_allowances_json,
  bpjs_flags_json,
  effective_from::text AS effective_from,
  effective_to::text AS effective_to,
  superseded_by::text AS superseded_by
`;

interface ProfileRow {
  id: string;
  employee_id: string;
  base_salary_idr: string;
  fixed_allowances_json: unknown;
  bpjs_flags_json: unknown;
  effective_from: string;
  effective_to: string | null;
  superseded_by: string | null;
}

export interface EffectiveCompensation {
  profile: CompensationProfileRecord;
  baseSalaryIdr: bigint;
  fixedAllowancesIdr: bigint;
}

export async function listCompensation(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  employeeId: string,
  page: { limit: number; offset: number },
): Promise<CompensationProfileRecord[]> {
  assertReadable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    await assertEmployee(tx, auth, employeeId);
    const rows = queryRows<ProfileRow>(
      await tx.execute(sql`
        SELECT ${columns}
        FROM hr_compensation_profiles
        WHERE employee_id = ${employeeId}::uuid
        ORDER BY effective_from, id
        LIMIT ${page.limit} OFFSET ${page.offset}
      `),
    );
    return rows.map(toRecord);
  });
}

export async function appendCompensation(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  employeeId: string,
  input: CompensationCreateInput,
): Promise<CompensationProfileRecord> {
  assertWritable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    await assertEmployee(tx, auth, employeeId);
    const prior = queryRows<{ id: string; effective_from: string; effective_to: string | null }>(
      await tx.execute(sql`
        SELECT id::text AS id,
               effective_from::text AS effective_from,
               effective_to::text AS effective_to
        FROM hr_compensation_profiles
        WHERE employee_id = ${employeeId}::uuid
        ORDER BY effective_from DESC
        LIMIT 1
        FOR UPDATE
      `),
    )[0];
    if (prior && input.effectiveFrom <= prior.effective_from) {
      throw new OrgFieldError([
        { field: "effectiveFrom", message: "The new profile must start after the current one." },
      ]);
    }
    const minted = queryRows<{ id: string }>(await tx.execute(sql`SELECT uuidv7()::text AS id`))[0];
    if (!minted?.id) throw new Error("uuidv7 failed");
    if (prior && prior.effective_to === null) {
      const closed = queryRows<{ before_json: unknown; after_json: unknown }>(
        await tx.execute(sql`
          UPDATE hr_compensation_profiles
          SET effective_to = (${input.effectiveFrom}::date - 1),
              superseded_by = ${minted.id}::uuid
          WHERE id = ${prior.id}::uuid
            AND effective_to IS NULL
          RETURNING WITH (OLD AS before_row, NEW AS after_row)
            to_jsonb(before_row) AS before_json,
            to_jsonb(after_row) AS after_json
        `),
      );
      const closedRow = closed[0];
      if (!closedRow) {
        throw new OrgFieldError([
          { field: "effectiveFrom", message: "A newer profile was saved first. Reload and try again." },
        ]);
      }
      await writeAudit(
        tx,
        auth,
        "compensation.supersede",
        "hr_compensation_profiles",
        prior.id,
        closedRow.before_json,
        closedRow.after_json,
      );
    }
    const allowances = stringifyAllowances(input.fixedAllowances);
    const inserted = queryRows<{ before_json: unknown; after_json: unknown }>(
      await tx.execute(sql`
        INSERT INTO hr_compensation_profiles (
          id, tenant_id, employee_id, base_salary_idr, fixed_allowances_json, bpjs_flags_json, effective_from
        ) VALUES (
          ${minted.id}::uuid,
          ${auth.tenantId}::uuid,
          ${employeeId}::uuid,
          ${input.baseSalaryIdr.toString()}::bigint,
          ${JSON.stringify(allowances)}::jsonb,
          ${JSON.stringify(input.bpjsFlags)}::jsonb,
          ${input.effectiveFrom}::date
        )
        RETURNING WITH (OLD AS before_row, NEW AS after_row)
          to_jsonb(before_row) AS before_json,
          to_jsonb(after_row) AS after_json
      `),
    );
    const row = inserted[0];
    if (!row) throw new Error("compensation insert returned no row");
    await writeAudit(
      tx,
      auth,
      "compensation.append",
      "hr_compensation_profiles",
      minted.id,
      row.before_json,
      row.after_json,
    );
    const saved = await findProfile(tx, minted.id);
    if (!saved) throw new OrgNotFoundError("That compensation profile was not found.");
    return saved;
  });
}

/** Profile effective on `on` (inclusive). Payroll snapshots read this row, not a later edit. */
export async function compensationEffectiveOn(
  appDb: TenantDatabase,
  auth: CoreHrAuth,
  employeeId: string,
  on: string,
): Promise<EffectiveCompensation | null> {
  assertReadable(auth);
  return appDb.withTenantContext(auth.tenantId, async (tx) => {
    await assertEmployee(tx, auth, employeeId);
    const rows = queryRows<ProfileRow>(
      await tx.execute(sql`
        SELECT ${columns}
        FROM hr_compensation_profiles
        WHERE employee_id = ${employeeId}::uuid
          AND effective_from <= ${on}::date
          AND (effective_to IS NULL OR effective_to >= ${on}::date)
        ORDER BY effective_from DESC
        LIMIT 1
      `),
    );
    const row = rows[0];
    if (!row) return null;
    const profile = toRecord(row);
    return {
      profile,
      baseSalaryIdr: BigInt(profile.baseSalaryIdr),
      fixedAllowancesIdr: sumAllowanceIdr(profile.fixedAllowances),
    };
  });
}

export function sumAllowanceIdr(allowances: Record<string, string>): bigint {
  let total = 0n;
  for (const amount of Object.values(allowances)) total += BigInt(amount);
  return total;
}

async function assertEmployee(tx: TenantTx, auth: CoreHrAuth, employeeId: string): Promise<void> {
  const rows = queryRows<{ legal_entity_id: string; branch_id: string }>(
    await tx.execute(sql`
      SELECT legal_entity_id::text AS legal_entity_id, branch_id::text AS branch_id
      FROM hr_employees
      WHERE id = ${employeeId}::uuid
    `),
  );
  const employee = rows[0];
  if (!employee) throw new OrgNotFoundError("That employee was not found.");
  assertInScope(auth, employee.legal_entity_id, employee.branch_id);
}

async function findProfile(tx: TenantTx, id: string): Promise<CompensationProfileRecord | null> {
  const rows = queryRows<ProfileRow>(
    await tx.execute(sql`SELECT ${columns} FROM hr_compensation_profiles WHERE id = ${id}::uuid`),
  );
  const row = rows[0];
  return row ? toRecord(row) : null;
}

function stringifyAllowances(allowances: Record<string, bigint>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, amount] of Object.entries(allowances)) out[key] = idrToJson(amount);
  return out;
}

function toRecord(row: ProfileRow): CompensationProfileRecord {
  return {
    id: row.id,
    employeeId: row.employee_id,
    baseSalaryIdr: row.base_salary_idr,
    fixedAllowances: allowanceMap(row.fixed_allowances_json),
    bpjsFlags: flagMap(row.bpjs_flags_json),
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    supersededBy: row.superseded_by,
  };
}

function allowanceMap(value: unknown): Record<string, string> {
  const record = asJsonObject(value);
  const out: Record<string, string> = {};
  for (const [key, amount] of Object.entries(record)) {
    if (typeof amount !== "string" || !/^(?:0|[1-9]\d*)$/u.test(amount)) {
      throw new Error("fixed allowance was not integer rupiah");
    }
    out[key] = amount;
  }
  return out;
}

function flagMap(value: unknown): BpjsFlags {
  const record = asJsonObject(value);
  return {
    kesehatan: flag(record.kesehatan),
    jht: flag(record.jht),
    jkk: flag(record.jkk),
    jkm: flag(record.jkm),
    jp: flag(record.jp),
    jkp: flag(record.jkp),
  };
}

function flag(value: unknown): boolean {
  return value === true;
}

function asJsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("compensation json was not an object");
  }
  return parsed as Record<string, unknown>;
}
