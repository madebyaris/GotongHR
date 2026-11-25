import { APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE, tenantIsolationPolicySql } from "@gotonghr/db";
import pg from "pg";

const { Client } = pg;

export interface ClockMigrateInput {
  migratorUrl: string;
}

const tenantTables = ["att_clock_events"] as const;

/**
 * Clock events, FORCE RLS, and DML for app_tenant only.
 * Run this after core-hr migrate so hr_employees and id_branches exist.
 * The selfie column is an object key. Raw image bytes are not a column.
 */
export async function migrateClock(input: ClockMigrateInput): Promise<void> {
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
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO ${APP_ROLE}`);
}

const tableSql = `
CREATE TABLE IF NOT EXISTS att_clock_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  punch_type text NOT NULL,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  clock_drift_seconds integer NOT NULL,
  sync_source text NOT NULL,
  lat numeric(9, 6) NOT NULL,
  lng numeric(9, 6) NOT NULL,
  accuracy_meters numeric(10, 2),
  distance_meters numeric(12, 2),
  geofence_ok boolean NOT NULL,
  speed_kmh numeric(12, 2),
  liveness_ok boolean,
  mock_location_flag boolean NOT NULL DEFAULT false,
  selfie_storage_key text,
  review_status text NOT NULL,
  review_reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT att_clock_events_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT att_clock_events_employee_fkey
    FOREIGN KEY (employee_id, tenant_id)
    REFERENCES hr_employees (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT att_clock_events_branch_fkey
    FOREIGN KEY (branch_id, tenant_id)
    REFERENCES id_branches (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT att_clock_events_punch_type_check CHECK (punch_type IN ('clock_in', 'clock_out')),
  CONSTRAINT att_clock_events_sync_source_check CHECK (sync_source IN ('online', 'offline_queue')),
  CONSTRAINT att_clock_events_review_status_check CHECK (
    review_status IN ('ok', 'needs_review', 'reviewed')
  ),
  CONSTRAINT att_clock_events_lat_check CHECK (lat >= -90 AND lat <= 90),
  CONSTRAINT att_clock_events_lng_check CHECK (lng >= -180 AND lng <= 180),
  CONSTRAINT att_clock_events_accuracy_check CHECK (
    accuracy_meters IS NULL OR (accuracy_meters >= 0 AND accuracy_meters <= 10000000)
  ),
  CONSTRAINT att_clock_events_distance_check CHECK (
    distance_meters IS NULL OR distance_meters >= 0
  ),
  CONSTRAINT att_clock_events_speed_check CHECK (speed_kmh IS NULL OR speed_kmh >= 0),
  CONSTRAINT att_clock_events_selfie_key_check CHECK (
    selfie_storage_key IS NULL OR (
      char_length(selfie_storage_key) BETWEEN 1 AND 201
      AND selfie_storage_key ~ '^[A-Za-z0-9][A-Za-z0-9/_.-]*$'
      AND selfie_storage_key !~* 'data:'
    )
  )
);
CREATE INDEX IF NOT EXISTS att_clock_events_employee_captured_idx
  ON att_clock_events (tenant_id, employee_id, captured_at);

COMMENT ON TABLE att_clock_events IS
  'Append-mostly clock punches. selfie_storage_key is an object key. Raw selfie bytes are not stored. FORCE RLS. platform_admin has no privileges.';
COMMENT ON COLUMN att_clock_events.selfie_storage_key IS
  'Object storage key from the presigned upload. Never the image bytes.';
COMMENT ON COLUMN att_clock_events.clock_drift_seconds IS
  'received_at minus captured_at, in seconds. Drift over 600s without offline_queue needs review.';
COMMENT ON COLUMN att_clock_events.idempotency_key IS
  'Client UUIDv7. Unique per tenant. A retry returns the stored row.';

CREATE OR REPLACE FUNCTION att_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION att_touch_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION att_touch_updated_at() FROM ${PLATFORM_ROLE};
REVOKE ALL ON FUNCTION att_touch_updated_at() FROM ${QUEUE_ROLE};
GRANT EXECUTE ON FUNCTION att_touch_updated_at() TO ${APP_ROLE};

DROP TRIGGER IF EXISTS att_clock_events_touch ON att_clock_events;
CREATE TRIGGER att_clock_events_touch
  BEFORE UPDATE ON att_clock_events
  FOR EACH ROW
  EXECUTE FUNCTION att_touch_updated_at();
`;
