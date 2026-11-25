import { APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE, tenantIsolationPolicySql } from "@gotonghr/db";
import pg from "pg";

const { Client } = pg;

export interface AttendanceMigrateInput {
  migratorUrl: string;
}

const tenantTables = [
  "att_shifts",
  "att_rosters",
  "att_holidays",
  "att_leave_types",
  "att_leave_balances",
  "att_leave_requests",
  "att_overtime_requests",
  "att_approval_delegations",
  "att_daily_summaries",
] as const;

/**
 * Schedule, leave, overtime, and locked daily summaries.
 * Run this after `@gotonghr/db` migrate so `app_tenant` exists.
 * `platform_admin` and `gotong_queue` receive no privileges.
 * Every table uses FORCE ROW LEVEL SECURITY.
 * `locked_for_payroll_run_id` stays null until a payroll run attaches.
 */
export async function migrateAttendance(input: AttendanceMigrateInput): Promise<void> {
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
  if (!/^[a-z_]+$/u.test(table)) throw new Error(`invalid table name: ${table}`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${PLATFORM_ROLE}`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${QUEUE_ROLE}`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${APP_ROLE}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO ${APP_ROLE}`);
}

const tableSql = `
CREATE TABLE IF NOT EXISTS att_shifts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  start_local_time time NOT NULL,
  end_local_time time NOT NULL,
  grace_minutes integer NOT NULL DEFAULT 0,
  workweek_type text NOT NULL,
  is_overnight boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT att_shifts_code_key UNIQUE (tenant_id, code),
  CONSTRAINT att_shifts_code_check CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
  CONSTRAINT att_shifts_name_check CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 80
  ),
  CONSTRAINT att_shifts_grace_check CHECK (grace_minutes BETWEEN 0 AND 180),
  CONSTRAINT att_shifts_workweek_check CHECK (workweek_type IN ('5_day', '6_day')),
  CONSTRAINT att_shifts_span_check CHECK (is_overnight OR end_local_time > start_local_time)
);
CREATE INDEX IF NOT EXISTS att_shifts_tenant_idx ON att_shifts (tenant_id);

CREATE TABLE IF NOT EXISTS att_rosters (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  shift_id uuid NOT NULL REFERENCES att_shifts (id),
  work_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT att_rosters_day_key UNIQUE (tenant_id, employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS att_rosters_shift_idx ON att_rosters (shift_id);

CREATE TABLE IF NOT EXISTS att_holidays (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  holiday_date date NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  source_status text NOT NULL,
  calendar_year integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT att_holidays_date_key UNIQUE (tenant_id, holiday_date),
  CONSTRAINT att_holidays_name_check CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 120
  ),
  CONSTRAINT att_holidays_kind_check CHECK (kind IN ('national', 'joint')),
  CONSTRAINT att_holidays_status_check CHECK (source_status IN ('draft', 'official')),
  CONSTRAINT att_holidays_year_check CHECK (calendar_year BETWEEN 2000 AND 2100)
);
CREATE INDEX IF NOT EXISTS att_holidays_year_idx ON att_holidays (tenant_id, calendar_year);

COMMENT ON TABLE att_holidays IS
  'Holiday rows loaded from the SKB draft file or entered by HR. Day type reads this table. It does not scrape a ministry site.';

CREATE TABLE IF NOT EXISTS att_leave_types (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  tenure_months integer,
  entitlement_days integer,
  deducts_annual boolean NOT NULL DEFAULT false,
  deduction_toggle boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT att_leave_types_code_key UNIQUE (tenant_id, code),
  CONSTRAINT att_leave_types_code_check CHECK (
    code IN (
      'cuti_tahunan', 'cuti_bersama', 'melahirkan', 'haid', 'sakit',
      'menikah', 'duka', 'haji', 'umrah'
    )
  ),
  CONSTRAINT att_leave_types_name_check CHECK (
    name = btrim(name) AND char_length(name) BETWEEN 1 AND 80
  ),
  CONSTRAINT att_leave_types_toggle_check CHECK (
    (code = 'cuti_bersama' AND deduction_toggle)
    OR (code <> 'cuti_bersama' AND NOT deduction_toggle)
  ),
  CONSTRAINT att_leave_types_deduct_check CHECK (
    code = 'cuti_bersama' OR NOT deducts_annual
  )
);
COMMENT ON COLUMN att_leave_types.deducts_annual IS
  'Cuti Bersama deducts Cuti Tahunan when true. The tenant can turn it off. The default is true.';

CREATE TABLE IF NOT EXISTS att_leave_balances (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  leave_type_id uuid NOT NULL REFERENCES att_leave_types (id),
  balance_year integer NOT NULL,
  entitled_days integer NOT NULL,
  used_days integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT att_leave_balances_year_key UNIQUE (tenant_id, employee_id, leave_type_id, balance_year),
  CONSTRAINT att_leave_balances_year_check CHECK (balance_year BETWEEN 2000 AND 2100),
  CONSTRAINT att_leave_balances_days_check CHECK (
    entitled_days BETWEEN 0 AND 366 AND used_days BETWEEN 0 AND entitled_days
  )
);

CREATE TABLE IF NOT EXISTS att_leave_requests (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  leave_type_id uuid NOT NULL REFERENCES att_leave_types (id),
  start_date date NOT NULL,
  end_date date NOT NULL,
  day_count integer NOT NULL,
  status text NOT NULL DEFAULT 'pending_line_manager',
  requested_by_user_id uuid NOT NULL,
  line_decision text,
  line_decided_by uuid,
  line_decided_at timestamptz,
  final_decision text,
  final_decided_by uuid,
  final_decided_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT att_leave_requests_status_check CHECK (
    status IN ('pending_line_manager', 'pending_final', 'approved', 'rejected')
  ),
  CONSTRAINT att_leave_requests_days_check CHECK (
    day_count BETWEEN 1 AND 366 AND end_date >= start_date
  ),
  CONSTRAINT att_leave_requests_line_check CHECK (
    line_decision IS NULL OR line_decision IN ('approved', 'rejected')
  ),
  CONSTRAINT att_leave_requests_final_check CHECK (
    final_decision IS NULL OR final_decision IN ('approved', 'rejected')
  ),
  CONSTRAINT att_leave_requests_reason_check CHECK (
    decision_reason IS NULL OR char_length(decision_reason) <= 200
  )
);
CREATE INDEX IF NOT EXISTS att_leave_requests_employee_idx
  ON att_leave_requests (tenant_id, employee_id, start_date);
CREATE INDEX IF NOT EXISTS att_leave_requests_status_idx
  ON att_leave_requests (tenant_id, status);

CREATE TABLE IF NOT EXISTS att_overtime_requests (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  work_date date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  workweek_type text NOT NULL,
  day_type text NOT NULL,
  requested_minutes integer NOT NULL,
  approved_minutes integer,
  status text NOT NULL DEFAULT 'pending_line_manager',
  requested_by_user_id uuid NOT NULL,
  line_decision text,
  line_decided_by uuid,
  line_decided_at timestamptz,
  final_decision text,
  final_decided_by uuid,
  final_decided_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT att_overtime_requests_status_check CHECK (
    status IN ('pending_line_manager', 'pending_final', 'approved', 'rejected')
  ),
  CONSTRAINT att_overtime_requests_workweek_check CHECK (workweek_type IN ('5_day', '6_day')),
  CONSTRAINT att_overtime_requests_day_type_check CHECK (
    day_type IN ('workday', 'weekend', 'national_holiday')
  ),
  CONSTRAINT att_overtime_requests_minutes_check CHECK (
    requested_minutes BETWEEN 1 AND 720
    AND (approved_minutes IS NULL OR approved_minutes BETWEEN 1 AND requested_minutes)
  ),
  CONSTRAINT att_overtime_requests_approved_status_check CHECK (
    status <> 'approved' OR approved_minutes IS NOT NULL
  ),
  CONSTRAINT att_overtime_requests_span_check CHECK (ends_at > starts_at),
  CONSTRAINT att_overtime_requests_line_check CHECK (
    line_decision IS NULL OR line_decision IN ('approved', 'rejected')
  ),
  CONSTRAINT att_overtime_requests_final_check CHECK (
    final_decision IS NULL OR final_decision IN ('approved', 'rejected')
  ),
  CONSTRAINT att_overtime_requests_reason_check CHECK (
    decision_reason IS NULL OR char_length(decision_reason) <= 200
  )
);
CREATE INDEX IF NOT EXISTS att_overtime_requests_employee_idx
  ON att_overtime_requests (tenant_id, employee_id, work_date);
CREATE INDEX IF NOT EXISTS att_overtime_requests_status_idx
  ON att_overtime_requests (tenant_id, status);

COMMENT ON COLUMN att_overtime_requests.approved_minutes IS
  'Minutes stored at final approval. Payroll reads this column and does not re-read the clock times.';
COMMENT ON COLUMN att_overtime_requests.day_type IS
  'Derived from att_holidays and workweek_type. A client value is not stored.';

CREATE TABLE IF NOT EXISTS att_approval_delegations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  delegator_user_id uuid NOT NULL,
  delegate_user_id uuid NOT NULL,
  role_code text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT att_approval_delegations_role_check CHECK (
    role_code IN ('line_manager', 'branch_manager', 'hr_admin')
  ),
  CONSTRAINT att_approval_delegations_span_check CHECK (ends_at > starts_at),
  CONSTRAINT att_approval_delegations_distinct_check CHECK (delegator_user_id <> delegate_user_id)
);
CREATE INDEX IF NOT EXISTS att_approval_delegations_delegate_idx
  ON att_approval_delegations (tenant_id, delegate_user_id, role_code);

COMMENT ON TABLE att_approval_delegations IS
  'Active rows let the delegate decide as the named role. Approval does not hardcode a user.';

CREATE TABLE IF NOT EXISTS att_daily_summaries (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  work_date date NOT NULL,
  status text NOT NULL DEFAULT 'open',
  late_minutes integer NOT NULL DEFAULT 0,
  worked_minutes integer NOT NULL DEFAULT 0,
  approved_overtime_minutes integer NOT NULL DEFAULT 0,
  locked_for_payroll_run_id uuid,
  is_locked boolean NOT NULL DEFAULT false,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT att_daily_summaries_day_key UNIQUE (tenant_id, employee_id, work_date),
  CONSTRAINT att_daily_summaries_status_check CHECK (status IN ('open', 'scheduled', 'leave')),
  CONSTRAINT att_daily_summaries_minutes_check CHECK (
    late_minutes >= 0 AND worked_minutes >= 0 AND approved_overtime_minutes >= 0
  ),
  CONSTRAINT att_daily_summaries_lock_check CHECK (
    (is_locked = false AND locked_at IS NULL)
    OR (is_locked = true AND locked_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS att_daily_summaries_locked_idx
  ON att_daily_summaries (tenant_id, work_date, is_locked);

COMMENT ON COLUMN att_daily_summaries.locked_for_payroll_run_id IS
  'Null until a payroll run attaches. Period lock sets is_locked and locked_at without writing a run id.';
`;
