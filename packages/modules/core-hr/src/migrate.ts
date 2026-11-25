import { APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE, tenantIsolationPolicySql } from "@gotonghr/db";
import pg from "pg";

const { Client } = pg;

export interface CoreHrMigrateInput {
  migratorUrl: string;
}

const tenantTables = ["hr_employees", "hr_employee_pii"] as const;

/**
 * Employee master and the PII vault.
 * Run this after identity migrate so legal entities and branches exist.
 * `app_tenant` is the only role with DML. `platform_admin` keeps zero privileges.
 * Both tables use FORCE ROW LEVEL SECURITY.
 */
export async function migrateCoreHr(input: CoreHrMigrateInput): Promise<void> {
  const migrator = new Client({ connectionString: input.migratorUrl });
  await migrator.connect();
  try {
    await migrator.query("BEGIN");
    try {
      await migrator.query(tableSql);
      for (const table of tenantTables) {
        await migrator.query(tenantIsolationPolicySql(table));
        await grantAppDml(migrator, table);
      }
      await migrator.query("COMMIT");
    } catch (error) {
      await migrator.query("ROLLBACK");
      throw error;
    }
  } finally {
    await migrator.end();
  }
}

async function grantAppDml(client: pg.Client, table: string): Promise<void> {
  await client.query(`REVOKE ALL ON TABLE ${table} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${PLATFORM_ROLE}`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${QUEUE_ROLE}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO ${APP_ROLE}`);
}

const tableSql = `
CREATE UNIQUE INDEX IF NOT EXISTS id_branches_id_tenant_entity_uidx
  ON id_branches (id, tenant_id, legal_entity_id);

CREATE TABLE IF NOT EXISTS hr_employees (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  employee_code text NOT NULL,
  full_name text NOT NULL,
  legal_entity_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  department_id uuid,
  position_id uuid,
  employment_status text NOT NULL,
  join_date date NOT NULL,
  ptkp_status text NOT NULL,
  tax_method text NOT NULL,
  pph21_subject_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT hr_employees_code_key UNIQUE (tenant_id, employee_code),
  CONSTRAINT hr_employees_entity_fkey
    FOREIGN KEY (legal_entity_id, tenant_id)
    REFERENCES id_legal_entities (id, tenant_id),
  CONSTRAINT hr_employees_branch_entity_fkey
    FOREIGN KEY (branch_id, tenant_id, legal_entity_id)
    REFERENCES id_branches (id, tenant_id, legal_entity_id),
  CONSTRAINT hr_employees_code_check CHECK (
    employee_code = btrim(employee_code)
    AND char_length(employee_code) BETWEEN 1 AND 32
    AND employee_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
  ),
  CONSTRAINT hr_employees_full_name_check CHECK (
    full_name = btrim(full_name)
    AND char_length(full_name) BETWEEN 1 AND 160
  ),
  CONSTRAINT hr_employees_status_check CHECK (
    employment_status IN ('active', 'probation', 'resigned', 'terminated')
  ),
  CONSTRAINT hr_employees_ptkp_check CHECK (
    ptkp_status IN ('TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3')
  ),
  CONSTRAINT hr_employees_tax_method_check CHECK (
    tax_method IN ('gross', 'nett', 'gross_up')
  ),
  CONSTRAINT hr_employees_subject_check CHECK (
    pph21_subject_type IN ('permanent', 'non_permanent', 'expat')
  )
);
CREATE INDEX IF NOT EXISTS hr_employees_tenant_branch_idx
  ON hr_employees (tenant_id, branch_id);

CREATE TABLE IF NOT EXISTS hr_employee_pii (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  nik_enc text NOT NULL,
  npwp_enc text,
  kk_number_enc text,
  bpjs_kesehatan_no_enc text,
  bpjs_tk_no_enc text,
  bank_account_number_enc text,
  nik_hash text NOT NULL,
  npwp_hash text,
  nik_mask text NOT NULL,
  npwp_mask text,
  kk_number_mask text,
  bpjs_kesehatan_no_mask text,
  bpjs_tk_no_mask text,
  bank_account_number_mask text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT hr_employee_pii_employee_key UNIQUE (tenant_id, employee_id),
  CONSTRAINT hr_employee_pii_nik_hash_key UNIQUE (tenant_id, nik_hash),
  CONSTRAINT hr_employee_pii_employee_fkey
    FOREIGN KEY (employee_id, tenant_id)
    REFERENCES hr_employees (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT hr_employee_pii_ciphertext_check CHECK (
    char_length(nik_enc) >= 24
    AND nik_enc !~ '^[0-9]{16}$'
    AND (npwp_enc IS NULL OR (char_length(npwp_enc) >= 24 AND npwp_enc !~ '^[0-9]+$'))
    AND (kk_number_enc IS NULL OR (char_length(kk_number_enc) >= 24 AND kk_number_enc !~ '^[0-9]+$'))
    AND (bpjs_kesehatan_no_enc IS NULL OR (char_length(bpjs_kesehatan_no_enc) >= 24 AND bpjs_kesehatan_no_enc !~ '^[0-9]+$'))
    AND (bpjs_tk_no_enc IS NULL OR (char_length(bpjs_tk_no_enc) >= 24 AND bpjs_tk_no_enc !~ '^[0-9]+$'))
    AND (bank_account_number_enc IS NULL OR (
      char_length(bank_account_number_enc) >= 24 AND bank_account_number_enc !~ '^[0-9]+$'
    ))
  ),
  CONSTRAINT hr_employee_pii_hash_check CHECK (
    nik_hash ~ '^[0-9a-f]{64}$'
    AND (npwp_hash IS NULL OR npwp_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT hr_employee_pii_mask_check CHECK (
    nik_mask ~ '^[0-9*]{8,32}$'
    AND position('*' IN nik_mask) > 0
    AND nik_mask !~ '^[0-9]{15,16}$'
    AND (npwp_mask IS NULL OR (npwp_mask ~ '^[0-9*]{8,32}$' AND position('*' IN npwp_mask) > 0))
  )
);
CREATE INDEX IF NOT EXISTS hr_employee_pii_npwp_hash_idx
  ON hr_employee_pii (tenant_id, npwp_hash)
  WHERE npwp_hash IS NOT NULL;

COMMENT ON TABLE hr_employees IS
  'Employee master without ciphertext. department_id and position_id have no target table until slice 2.2. FORCE RLS. platform_admin has no privileges.';
COMMENT ON TABLE hr_employee_pii IS
  'One row per employee. Ciphertext plus blind indexes. Lists read nik_mask and npwp_mask and do not decrypt. nik_hash is unique per tenant.';
COMMENT ON COLUMN hr_employees.department_id IS 'Nullable until hr_departments exists in slice 2.2. No foreign key.';
COMMENT ON COLUMN hr_employees.position_id IS 'Nullable until hr_positions exists in slice 2.2. No foreign key.';

CREATE OR REPLACE FUNCTION hr_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION hr_touch_updated_at() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hr_touch_updated_at() TO ${APP_ROLE};

DROP TRIGGER IF EXISTS hr_employees_touch ON hr_employees;
CREATE TRIGGER hr_employees_touch
  BEFORE UPDATE ON hr_employees
  FOR EACH ROW
  EXECUTE FUNCTION hr_touch_updated_at();

DROP TRIGGER IF EXISTS hr_employee_pii_touch ON hr_employee_pii;
CREATE TRIGGER hr_employee_pii_touch
  BEFORE UPDATE ON hr_employee_pii
  FOR EACH ROW
  EXECUTE FUNCTION hr_touch_updated_at();
`;
