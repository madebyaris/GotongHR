import { APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE, tenantIsolationPolicySql } from "@gotonghr/db";
import pg from "pg";

const tables = [
  "hr_departments",
  "hr_positions",
  "hr_contracts",
  "hr_compensation_profiles",
] as const;

/** Departments, positions, PKWT/PKWTT contracts, and append-only pay profiles. */
export async function migrateDirectory(client: pg.Client): Promise<void> {
  await client.query(directorySql);
  for (const table of tables) {
    await client.query(tenantIsolationPolicySql(table));
    await grantAppDml(client, table);
  }
  await client.query(touchSql);
}

async function grantAppDml(client: pg.Client, table: string): Promise<void> {
  await client.query(`REVOKE ALL ON TABLE ${table} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${PLATFORM_ROLE}`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${QUEUE_ROLE}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO ${APP_ROLE}`);
}

const directorySql = `
CREATE TABLE IF NOT EXISTS hr_departments (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT hr_departments_name_key UNIQUE (tenant_id, name),
  CONSTRAINT hr_departments_name_check CHECK (
    name = btrim(name)
    AND char_length(name) BETWEEN 1 AND 80
  )
);

CREATE TABLE IF NOT EXISTS hr_positions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  department_id uuid,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT hr_positions_department_fkey
    FOREIGN KEY (department_id, tenant_id)
    REFERENCES hr_departments (id, tenant_id) ON DELETE SET NULL (department_id),
  CONSTRAINT hr_positions_name_key UNIQUE (tenant_id, name),
  CONSTRAINT hr_positions_name_check CHECK (
    name = btrim(name)
    AND char_length(name) BETWEEN 1 AND 80
  )
);
CREATE INDEX IF NOT EXISTS hr_positions_department_idx
  ON hr_positions (tenant_id, department_id);

CREATE TABLE IF NOT EXISTS hr_contracts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  contract_type text NOT NULL,
  start_date date NOT NULL,
  end_date date,
  compensation_paid boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT hr_contracts_employee_fkey
    FOREIGN KEY (employee_id, tenant_id)
    REFERENCES hr_employees (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT hr_contracts_type_check CHECK (contract_type IN ('PKWT', 'PKWTT')),
  CONSTRAINT hr_contracts_dates_check CHECK (
    (contract_type = 'PKWT' AND end_date IS NOT NULL AND end_date >= start_date)
    OR (contract_type = 'PKWTT' AND end_date IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS hr_contracts_employee_idx
  ON hr_contracts (tenant_id, employee_id, start_date);

CREATE TABLE IF NOT EXISTS hr_compensation_profiles (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  base_salary_idr bigint NOT NULL,
  fixed_allowances_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  bpjs_flags_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT hr_compensation_employee_fkey
    FOREIGN KEY (employee_id, tenant_id)
    REFERENCES hr_employees (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT hr_compensation_effective_key UNIQUE (tenant_id, employee_id, effective_from),
  CONSTRAINT hr_compensation_salary_check CHECK (base_salary_idr >= 0),
  CONSTRAINT hr_compensation_allowances_check CHECK (jsonb_typeof(fixed_allowances_json) = 'object'),
  CONSTRAINT hr_compensation_bpjs_check CHECK (jsonb_typeof(bpjs_flags_json) = 'object')
);
CREATE INDEX IF NOT EXISTS hr_compensation_employee_idx
  ON hr_compensation_profiles (tenant_id, employee_id, effective_from);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hr_employees_department_fkey'
  ) THEN
    ALTER TABLE hr_employees
      ADD CONSTRAINT hr_employees_department_fkey
      FOREIGN KEY (department_id, tenant_id)
      REFERENCES hr_departments (id, tenant_id)
      ON DELETE SET NULL (department_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hr_employees_position_fkey'
  ) THEN
    ALTER TABLE hr_employees
      ADD CONSTRAINT hr_employees_position_fkey
      FOREIGN KEY (position_id, tenant_id)
      REFERENCES hr_positions (id, tenant_id)
      ON DELETE SET NULL (position_id);
  END IF;
END $$;

COMMENT ON TABLE hr_departments IS
  'Tenant departments. FORCE RLS. platform_admin has no privileges.';
COMMENT ON TABLE hr_positions IS
  'Positions. A row may belong to one department. FORCE RLS. platform_admin has no privileges.';
COMMENT ON TABLE hr_contracts IS
  'PKWT and PKWTT contracts. PKWT stores an end date. PKWTT does not. New rows are appended. FORCE RLS.';
COMMENT ON TABLE hr_compensation_profiles IS
  'Append-only pay profiles. A later salary is a new row. Payroll snapshots the row effective for the period. FORCE RLS.';
COMMENT ON COLUMN hr_employees.department_id IS
  'Optional department. Null when the employee is not assigned.';
COMMENT ON COLUMN hr_employees.position_id IS
  'Optional position. Null when the employee is not assigned.';
`;

const touchSql = `
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
`;
