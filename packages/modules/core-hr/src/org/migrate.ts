import { APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE, tenantIsolationPolicySql } from "@gotonghr/db";
import pg from "pg";

const { Client } = pg;

const fullTables = ["hr_departments", "hr_positions", "hr_contracts"] as const;

/**
 * Departments, positions, contracts, compensation, and expiry notices.
 * Run this after the employee tables exist.
 * Compensation pay columns cannot change in place. The guard trigger rejects that update.
 * `gotong_queue` can read the contract columns the daily expiry scan needs, and nothing else.
 */
export async function migrateOrg(input: { migratorUrl: string }): Promise<void> {
  const migrator = new Client({ connectionString: input.migratorUrl });
  await migrator.connect();
  try {
    await migrator.query("BEGIN");
    try {
      await migrator.query(tableSql);
      for (const table of [
        ...fullTables,
        "hr_compensation_profiles",
        "hr_contract_expiry_notices",
      ]) {
        await migrator.query(tenantIsolationPolicySql(table));
      }
      for (const table of fullTables) await grantFull(migrator, table);
      await grantCompensation(migrator);
      await grantNotices(migrator);
      await grantContractScan(migrator);
      await migrator.query("COMMIT");
    } catch (error) {
      await migrator.query("ROLLBACK");
      throw error;
    }
  } finally {
    await migrator.end();
  }
}

async function grantFull(client: pg.Client, table: string): Promise<void> {
  await revokeAll(client, table);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO ${APP_ROLE}`);
}

async function grantCompensation(client: pg.Client): Promise<void> {
  const table = "hr_compensation_profiles";
  await revokeAll(client, table);
  await client.query(`GRANT SELECT, INSERT, UPDATE ON TABLE ${table} TO ${APP_ROLE}`);
}

async function grantNotices(client: pg.Client): Promise<void> {
  const table = "hr_contract_expiry_notices";
  await revokeAll(client, table);
  await client.query(`GRANT SELECT, INSERT ON TABLE ${table} TO ${APP_ROLE}`);
}

async function grantContractScan(client: pg.Client): Promise<void> {
  await client.query(`GRANT USAGE ON SCHEMA public TO ${QUEUE_ROLE}`);
  await client.query(`
    GRANT SELECT (id, tenant_id, employee_id, contract_type, status, end_date)
    ON hr_contracts TO ${QUEUE_ROLE}
  `);
  await client.query(`
    DROP POLICY IF EXISTS hr_contracts_expiry_scan ON hr_contracts;
    CREATE POLICY hr_contracts_expiry_scan ON hr_contracts
      FOR SELECT
      TO ${QUEUE_ROLE}
      USING (true);
  `);
}

async function revokeAll(client: pg.Client, table: string): Promise<void> {
  await client.query(`REVOKE ALL ON TABLE ${table} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${PLATFORM_ROLE}`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${QUEUE_ROLE}`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${APP_ROLE}`);
}

const tableSql = `
CREATE TABLE IF NOT EXISTS hr_departments (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL,
  branch_id uuid,
  parent_department_id uuid,
  name text NOT NULL,
  code text NOT NULL,
  cost_center_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT hr_departments_code_key UNIQUE (tenant_id, code),
  CONSTRAINT hr_departments_entity_fkey
    FOREIGN KEY (legal_entity_id, tenant_id)
    REFERENCES id_legal_entities (id, tenant_id),
  CONSTRAINT hr_departments_branch_fkey
    FOREIGN KEY (branch_id, tenant_id, legal_entity_id)
    REFERENCES id_branches (id, tenant_id, legal_entity_id),
  CONSTRAINT hr_departments_parent_fkey
    FOREIGN KEY (parent_department_id, tenant_id)
    REFERENCES hr_departments (id, tenant_id),
  CONSTRAINT hr_departments_parent_not_self CHECK (
    parent_department_id IS NULL OR parent_department_id <> id
  ),
  CONSTRAINT hr_departments_name_check CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 160
  ),
  CONSTRAINT hr_departments_code_check CHECK (
    code = btrim(code)
    AND char_length(code) BETWEEN 1 AND 32
    AND code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
  ),
  CONSTRAINT hr_departments_cost_center_check CHECK (
    cost_center_code IS NULL OR (
      cost_center_code = btrim(cost_center_code)
      AND char_length(cost_center_code) BETWEEN 1 AND 32
      AND cost_center_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    )
  )
);
CREATE INDEX IF NOT EXISTS hr_departments_parent_idx
  ON hr_departments (tenant_id, parent_department_id);

CREATE TABLE IF NOT EXISTS hr_positions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  department_id uuid NOT NULL,
  title text NOT NULL,
  code text NOT NULL,
  level_code text,
  reports_to_position_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT hr_positions_code_key UNIQUE (tenant_id, code),
  CONSTRAINT hr_positions_department_fkey
    FOREIGN KEY (department_id, tenant_id)
    REFERENCES hr_departments (id, tenant_id),
  CONSTRAINT hr_positions_reports_to_fkey
    FOREIGN KEY (reports_to_position_id, tenant_id)
    REFERENCES hr_positions (id, tenant_id),
  CONSTRAINT hr_positions_reports_not_self CHECK (
    reports_to_position_id IS NULL OR reports_to_position_id <> id
  ),
  CONSTRAINT hr_positions_title_check CHECK (
    title = btrim(title) AND char_length(title) BETWEEN 1 AND 120
  ),
  CONSTRAINT hr_positions_code_check CHECK (
    code = btrim(code)
    AND char_length(code) BETWEEN 1 AND 32
    AND code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
  ),
  CONSTRAINT hr_positions_level_check CHECK (
    level_code IS NULL OR (
      level_code = btrim(level_code)
      AND char_length(level_code) BETWEEN 1 AND 32
      AND level_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    )
  )
);
CREATE INDEX IF NOT EXISTS hr_positions_department_idx
  ON hr_positions (tenant_id, department_id);

ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS manager_employee_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_employees_department_fkey') THEN
    IF EXISTS (
      SELECT 1 FROM hr_employees AS e
      WHERE e.department_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM hr_departments AS d
          WHERE d.id = e.department_id AND d.tenant_id = e.tenant_id
        )
    ) THEN
      RAISE EXCEPTION
        'hr_employees has department_id values that are not in hr_departments. Clear them, then rerun migrations.';
    END IF;
    ALTER TABLE hr_employees
      ADD CONSTRAINT hr_employees_department_fkey
      FOREIGN KEY (department_id, tenant_id)
      REFERENCES hr_departments (id, tenant_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_employees_position_fkey') THEN
    IF EXISTS (
      SELECT 1 FROM hr_employees AS e
      WHERE e.position_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM hr_positions AS p
          WHERE p.id = e.position_id AND p.tenant_id = e.tenant_id
        )
    ) THEN
      RAISE EXCEPTION
        'hr_employees has position_id values that are not in hr_positions. Clear them, then rerun migrations.';
    END IF;
    ALTER TABLE hr_employees
      ADD CONSTRAINT hr_employees_position_fkey
      FOREIGN KEY (position_id, tenant_id)
      REFERENCES hr_positions (id, tenant_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_employees_manager_not_self') THEN
    ALTER TABLE hr_employees
      ADD CONSTRAINT hr_employees_manager_not_self
      CHECK (manager_employee_id IS NULL OR manager_employee_id <> id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_employees_manager_fkey') THEN
    IF EXISTS (
      SELECT 1 FROM hr_employees AS e
      WHERE e.manager_employee_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM hr_employees AS manager
          WHERE manager.id = e.manager_employee_id AND manager.tenant_id = e.tenant_id
        )
    ) THEN
      RAISE EXCEPTION
        'hr_employees has manager_employee_id values that are not employees. Clear them, then rerun migrations.';
    END IF;
    ALTER TABLE hr_employees
      ADD CONSTRAINT hr_employees_manager_fkey
      FOREIGN KEY (manager_employee_id, tenant_id)
      REFERENCES hr_employees (id, tenant_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS hr_employees_manager_idx
  ON hr_employees (tenant_id, manager_employee_id)
  WHERE manager_employee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_contracts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  contract_type text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  start_date date NOT NULL,
  end_date date,
  department_id uuid,
  position_id uuid,
  manager_employee_id uuid,
  compensation_paid boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT hr_contracts_employee_fkey
    FOREIGN KEY (employee_id, tenant_id)
    REFERENCES hr_employees (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT hr_contracts_department_fkey
    FOREIGN KEY (department_id, tenant_id)
    REFERENCES hr_departments (id, tenant_id),
  CONSTRAINT hr_contracts_position_fkey
    FOREIGN KEY (position_id, tenant_id)
    REFERENCES hr_positions (id, tenant_id),
  CONSTRAINT hr_contracts_manager_fkey
    FOREIGN KEY (manager_employee_id, tenant_id)
    REFERENCES hr_employees (id, tenant_id),
  CONSTRAINT hr_contracts_manager_not_self CHECK (
    manager_employee_id IS NULL OR manager_employee_id <> employee_id
  ),
  CONSTRAINT hr_contracts_type_check CHECK (contract_type IN ('PKWT', 'PKWTT')),
  CONSTRAINT hr_contracts_status_check CHECK (status IN ('draft', 'active', 'ended', 'cancelled')),
  CONSTRAINT hr_contracts_dates_check CHECK (
    (contract_type = 'PKWT' AND end_date IS NOT NULL AND end_date >= start_date)
    OR (contract_type = 'PKWTT' AND (end_date IS NULL OR end_date >= start_date))
  )
);
CREATE INDEX IF NOT EXISTS hr_contracts_employee_idx
  ON hr_contracts (tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS hr_contracts_active_end_idx
  ON hr_contracts (end_date)
  WHERE status = 'active' AND end_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_compensation_profiles (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  base_salary_idr bigint NOT NULL,
  fixed_allowances_json jsonb NOT NULL,
  bpjs_flags_json jsonb NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  superseded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT hr_compensation_profiles_employee_fkey
    FOREIGN KEY (employee_id, tenant_id)
    REFERENCES hr_employees (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT hr_compensation_profiles_start_key UNIQUE (tenant_id, employee_id, effective_from),
  CONSTRAINT hr_compensation_profiles_salary_check CHECK (base_salary_idr >= 0),
  CONSTRAINT hr_compensation_profiles_range_check CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT hr_compensation_profiles_supersede_not_self CHECK (
    superseded_by IS NULL OR superseded_by <> id
  ),
  CONSTRAINT hr_compensation_profiles_allowances_check CHECK (
    jsonb_typeof(fixed_allowances_json) = 'object'
  ),
  CONSTRAINT hr_compensation_profiles_bpjs_check CHECK (jsonb_typeof(bpjs_flags_json) = 'object')
);
CREATE INDEX IF NOT EXISTS hr_compensation_profiles_employee_idx
  ON hr_compensation_profiles (tenant_id, employee_id, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS hr_compensation_profiles_open_uidx
  ON hr_compensation_profiles (tenant_id, employee_id)
  WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS hr_contract_expiry_notices (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  window_days smallint NOT NULL,
  notice_on date NOT NULL,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT hr_contract_expiry_notices_contract_fkey
    FOREIGN KEY (contract_id, tenant_id)
    REFERENCES hr_contracts (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT hr_contract_expiry_notices_dedupe_key UNIQUE (tenant_id, dedupe_key),
  CONSTRAINT hr_contract_expiry_notices_window_check CHECK (window_days IN (30, 60, 90)),
  CONSTRAINT hr_contract_expiry_notices_dedupe_check CHECK (
    char_length(dedupe_key) BETWEEN 16 AND 200
  )
);

COMMENT ON TABLE hr_departments IS
  'Department tree inside one legal entity. branch_id null means the whole entity. FORCE RLS.';
COMMENT ON TABLE hr_positions IS
  'Position in a department, with an optional level and reporting position. FORCE RLS.';
COMMENT ON TABLE hr_contracts IS
  'PKWT requires an end date. PKWTT end date is optional. The expiry scan reads active end dates. FORCE RLS.';
COMMENT ON TABLE hr_compensation_profiles IS
  'Append-only pay. A new row closes the open row. base_salary_idr is integer rupiah. FORCE RLS.';
COMMENT ON TABLE hr_contract_expiry_notices IS
  'One row per contract, window, and Jakarta day. The unique dedupe key stops a second expiry event.';
COMMENT ON COLUMN hr_employees.department_id IS
  'Department. Null until HR assigns one. A contract link can set this.';
COMMENT ON COLUMN hr_employees.position_id IS
  'Position. Null until HR assigns one. A contract link can set this.';
COMMENT ON COLUMN hr_employees.manager_employee_id IS
  'Line manager in the same company. Null when the employee has no manager.';
COMMENT ON COLUMN hr_compensation_profiles.base_salary_idr IS
  'Integer rupiah. Never updated in place. A later profile supersedes this row.';

CREATE OR REPLACE FUNCTION hr_compensation_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.base_salary_idr IS DISTINCT FROM OLD.base_salary_idr
     OR NEW.fixed_allowances_json IS DISTINCT FROM OLD.fixed_allowances_json
     OR NEW.bpjs_flags_json IS DISTINCT FROM OLD.bpjs_flags_json
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'compensation profiles are append-only'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'compensation profiles are append-only'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_by IS NOT NULL AND NEW.superseded_by IS DISTINCT FROM OLD.superseded_by THEN
    RAISE EXCEPTION 'compensation profiles are append-only'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION hr_compensation_append_only() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hr_compensation_append_only() TO ${APP_ROLE};

DROP TRIGGER IF EXISTS hr_departments_touch ON hr_departments;
CREATE TRIGGER hr_departments_touch
  BEFORE UPDATE ON hr_departments
  FOR EACH ROW
  EXECUTE FUNCTION hr_touch_updated_at();

DROP TRIGGER IF EXISTS hr_positions_touch ON hr_positions;
CREATE TRIGGER hr_positions_touch
  BEFORE UPDATE ON hr_positions
  FOR EACH ROW
  EXECUTE FUNCTION hr_touch_updated_at();

DROP TRIGGER IF EXISTS hr_contracts_touch ON hr_contracts;
CREATE TRIGGER hr_contracts_touch
  BEFORE UPDATE ON hr_contracts
  FOR EACH ROW
  EXECUTE FUNCTION hr_touch_updated_at();

DROP TRIGGER IF EXISTS hr_compensation_profiles_guard ON hr_compensation_profiles;
CREATE TRIGGER hr_compensation_profiles_guard
  BEFORE UPDATE ON hr_compensation_profiles
  FOR EACH ROW
  EXECUTE FUNCTION hr_compensation_append_only();

DROP TRIGGER IF EXISTS hr_compensation_profiles_touch ON hr_compensation_profiles;
CREATE TRIGGER hr_compensation_profiles_touch
  BEFORE UPDATE ON hr_compensation_profiles
  FOR EACH ROW
  EXECUTE FUNCTION hr_touch_updated_at();
`;
