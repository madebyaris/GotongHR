import { APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE, tenantIsolationPolicySql } from "@gotonghr/db";
import pg from "pg";

const { Client } = pg;

export interface PayrollMigrateInput {
  migratorUrl: string;
}

const tenantTables = ["pay_runs", "pay_run_items", "pay_exports"] as const;

/**
 * Payroll runs, frozen line items, and export files.
 * No foreign keys into core HR or attendance. Those snapshots are JSON.
 * `app_tenant` is the only request role with DML. `platform_admin` has none.
 */
export async function migratePayroll(input: PayrollMigrateInput): Promise<void> {
  const migrator = new Client({ connectionString: input.migratorUrl });
  await migrator.connect();
  try {
    await migrator.query("BEGIN");
    try {
      await migrator.query(tableSql(APP_ROLE));
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

function tableSql(appRole: string): string {
  return `
CREATE TABLE IF NOT EXISTS pay_runs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  period_year_month text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  statutory_table_version_id uuid,
  total_gross_idr bigint NOT NULL DEFAULT 0,
  total_tax_idr bigint NOT NULL DEFAULT 0,
  total_net_idr bigint NOT NULL DEFAULT 0,
  pdf_batch_enqueued_count integer NOT NULL DEFAULT 0,
  calc_batch_total integer NOT NULL DEFAULT 0,
  calc_completed_batches integer[] NOT NULL DEFAULT '{}',
  approved_by uuid,
  approved_at timestamptz,
  finalized_by uuid,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT pay_runs_entity_period_key UNIQUE (tenant_id, legal_entity_id, period_year_month),
  CONSTRAINT pay_runs_period_check CHECK (period_year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT pay_runs_status_check CHECK (status IN ('draft', 'calculated', 'approved', 'finalized')),
  CONSTRAINT pay_runs_money_check CHECK (
    total_gross_idr >= 0 AND total_tax_idr >= 0 AND total_net_idr >= 0
  ),
  CONSTRAINT pay_runs_batch_check CHECK (
    pdf_batch_enqueued_count >= 0
    AND calc_batch_total >= 0
    AND cardinality(calc_completed_batches) <= calc_batch_total
  ),
  CONSTRAINT pay_runs_approval_check CHECK (
    (
      status IN ('draft', 'calculated')
      AND approved_by IS NULL
      AND approved_at IS NULL
      AND finalized_by IS NULL
      AND finalized_at IS NULL
      AND pdf_batch_enqueued_count = 0
    )
    OR (
      status = 'approved'
      AND approved_by IS NOT NULL
      AND approved_at IS NOT NULL
      AND finalized_by IS NULL
      AND finalized_at IS NULL
      AND pdf_batch_enqueued_count = 0
    )
    OR (
      status = 'finalized'
      AND approved_by IS NOT NULL
      AND approved_at IS NOT NULL
      AND finalized_by IS NOT NULL
      AND finalized_at IS NOT NULL
      AND pdf_batch_enqueued_count >= 1
    )
  )
);

CREATE TABLE IF NOT EXISTS pay_run_items (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  owner_user_id uuid,
  employee_snapshot_json jsonb NOT NULL,
  attendance_snapshot_json jsonb NOT NULL,
  earnings_json jsonb NOT NULL,
  deductions_json jsonb NOT NULL,
  bpjs_json jsonb NOT NULL,
  pph21_json jsonb NOT NULL,
  gross_idr bigint NOT NULL,
  tax_idr bigint NOT NULL,
  net_idr bigint NOT NULL,
  payslip_storage_key text,
  payslip_generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT pay_run_items_run_employee_key UNIQUE (tenant_id, run_id, employee_id),
  CONSTRAINT pay_run_items_run_fkey
    FOREIGN KEY (run_id, tenant_id) REFERENCES pay_runs (id, tenant_id),
  CONSTRAINT pay_run_items_money_check CHECK (gross_idr >= 0 AND tax_idr >= 0 AND net_idr >= 0),
  CONSTRAINT pay_run_items_payslip_check CHECK (
    (payslip_storage_key IS NULL AND payslip_generated_at IS NULL)
    OR (payslip_storage_key IS NOT NULL AND payslip_generated_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS pay_run_items_run_idx ON pay_run_items (tenant_id, run_id);

CREATE TABLE IF NOT EXISTS pay_exports (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  export_kind text NOT NULL,
  slip_type text,
  bank_id text,
  storage_key text NOT NULL,
  checksum_sha256 text NOT NULL,
  byte_size bigint NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT pay_exports_run_fkey
    FOREIGN KEY (run_id, tenant_id) REFERENCES pay_runs (id, tenant_id),
  CONSTRAINT pay_exports_kind_check CHECK (export_kind IN ('coretax', 'bank_batch')),
  CONSTRAINT pay_exports_checksum_check CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT pay_exports_size_check CHECK (byte_size >= 0),
  CONSTRAINT pay_exports_storage_key_key UNIQUE (tenant_id, storage_key)
);

COMMENT ON TABLE pay_runs IS
  'One payroll month for one company. Status moves draft, calculated, approved, finalized. FORCE RLS.';
COMMENT ON TABLE pay_run_items IS
  'Frozen employee line. Money and snapshots do not change after insert. FORCE RLS.';
COMMENT ON TABLE pay_exports IS
  'Coretax XML and bank batch files already written to storage. FORCE RLS.';
COMMENT ON COLUMN pay_runs.pdf_batch_enqueued_count IS
  'Number of payslip PDF jobs enqueued at finalize. A second finalize does not add more.';
COMMENT ON COLUMN pay_run_items.employee_snapshot_json IS
  'Compensation, tax, and bank fields used for this line. A later profile does not replace it.';

CREATE OR REPLACE FUNCTION pay_run_items_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM pay_runs
      WHERE id = OLD.run_id AND tenant_id = OLD.tenant_id AND status <> 'draft'
    ) THEN
      RAISE EXCEPTION 'pay run items are immutable after calculation'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     OR NEW.employee_snapshot_json IS DISTINCT FROM OLD.employee_snapshot_json
     OR NEW.attendance_snapshot_json IS DISTINCT FROM OLD.attendance_snapshot_json
     OR NEW.earnings_json IS DISTINCT FROM OLD.earnings_json
     OR NEW.deductions_json IS DISTINCT FROM OLD.deductions_json
     OR NEW.bpjs_json IS DISTINCT FROM OLD.bpjs_json
     OR NEW.pph21_json IS DISTINCT FROM OLD.pph21_json
     OR NEW.gross_idr IS DISTINCT FROM OLD.gross_idr
     OR NEW.tax_idr IS DISTINCT FROM OLD.tax_idr
     OR NEW.net_idr IS DISTINCT FROM OLD.net_idr
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'pay run items are immutable after calculation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pay_run_items_immutable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pay_run_items_immutable() TO ${appRole};

DROP TRIGGER IF EXISTS pay_run_items_immutable_trg ON pay_run_items;
CREATE TRIGGER pay_run_items_immutable_trg
  BEFORE UPDATE OR DELETE ON pay_run_items
  FOR EACH ROW
  EXECUTE FUNCTION pay_run_items_immutable();
`;
}
