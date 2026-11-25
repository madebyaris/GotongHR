import { APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE, tenantIsolationPolicySql } from "@gotonghr/db";
import pg from "pg";
import { assertIdentifier } from "./sql.ts";

const { Client } = pg;

export interface AuditMigrateInput {
  migratorUrl: string;
}

const appendOnlyTables = ["aud_events", "aud_pii_access_logs", "aud_tenant_keys"] as const;
const tenantTables = [
  "aud_events",
  "aud_pii_access_logs",
  "aud_outbox_events",
  "aud_tenant_keys",
] as const;

/**
 * Audit tables, FORCE RLS, and append-only grants.
 * Run this after `@gotonghr/db` migrate so `app_tenant` exists.
 * `app_tenant` can INSERT and SELECT the append-only tables.
 * UPDATE, DELETE, and TRUNCATE stay revoked, including for `platform_admin`.
 */
export async function migrateAudit(input: AuditMigrateInput): Promise<void> {
  const migrator = new Client({ connectionString: input.migratorUrl });
  await migrator.connect();
  try {
    await migrator.query("BEGIN");
    try {
      await migrator.query(tableSql);
      for (const table of tenantTables) {
        await migrator.query(tenantIsolationPolicySql(table));
      }
      await migrator.query(dispatcherPolicySql);
      for (const table of appendOnlyTables) {
        await grantAppendOnly(migrator, table);
      }
      await grantOutbox(migrator);
      await migrator.query("COMMIT");
    } catch (error) {
      await migrator.query("ROLLBACK");
      throw error;
    }
  } finally {
    await migrator.end();
  }
}

async function grantAppendOnly(client: pg.Client, table: string): Promise<void> {
  assertIdentifier(table);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${PLATFORM_ROLE}`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${QUEUE_ROLE}`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${APP_ROLE}`);
  await client.query(`GRANT SELECT, INSERT ON TABLE ${table} TO ${APP_ROLE}`);
}

async function grantOutbox(client: pg.Client): Promise<void> {
  const table = "aud_outbox_events";
  await client.query(`REVOKE ALL ON TABLE ${table} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${PLATFORM_ROLE}`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${QUEUE_ROLE}`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${APP_ROLE}`);
  await client.query(`GRANT SELECT, INSERT ON TABLE ${table} TO ${APP_ROLE}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${QUEUE_ROLE}`);
  await client.query(`GRANT SELECT ON TABLE ${table} TO ${QUEUE_ROLE}`);
  await client.query(
    `GRANT UPDATE (published_at, attempts, last_error) ON TABLE ${table} TO ${QUEUE_ROLE}`,
  );
}

const dispatcherPolicySql = `
DROP POLICY IF EXISTS aud_outbox_events_dispatcher_select ON aud_outbox_events;
CREATE POLICY aud_outbox_events_dispatcher_select ON aud_outbox_events
  FOR SELECT
  TO ${QUEUE_ROLE}
  USING (true);

DROP POLICY IF EXISTS aud_outbox_events_dispatcher_update ON aud_outbox_events;
CREATE POLICY aud_outbox_events_dispatcher_update ON aud_outbox_events
  FOR UPDATE
  TO ${QUEUE_ROLE}
  USING (true)
  WITH CHECK (true);
`;

const tableSql = `
CREATE TABLE IF NOT EXISTS aud_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  actor_user_id uuid,
  actor_role text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  diff_redacted_json jsonb NOT NULL,
  ai_proposal_id uuid,
  support_grant_id uuid,
  ip_address text,
  user_agent text,
  prev_hash text,
  event_hash text,
  chain_seq bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aud_events_hash_pair CHECK (
    (prev_hash IS NULL AND event_hash IS NULL)
    OR (prev_hash ~ '^[0-9a-f]{64}$' AND event_hash ~ '^[0-9a-f]{64}$')
  )
);
CREATE INDEX IF NOT EXISTS aud_events_tenant_created_idx
  ON aud_events (tenant_id, created_at, id);
ALTER TABLE aud_events ADD COLUMN IF NOT EXISTS chain_seq bigint;
CREATE UNIQUE INDEX IF NOT EXISTS aud_events_tenant_chain_seq_uidx
  ON aud_events (tenant_id, chain_seq)
  WHERE chain_seq IS NOT NULL;

CREATE TABLE IF NOT EXISTS aud_pii_access_logs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  field_name text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  reason text NOT NULL,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aud_pii_access_logs_reason_not_blank CHECK (length(btrim(reason)) > 0),
  CONSTRAINT aud_pii_access_logs_field_name_known CHECK (
    field_name IN (
      'nik', 'npwp', 'kk_number', 'bpjs_kesehatan_no', 'bpjs_tk_no', 'bank_account_number'
    )
  )
);
CREATE INDEX IF NOT EXISTS aud_pii_access_logs_tenant_created_idx
  ON aud_pii_access_logs (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS aud_outbox_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aud_outbox_events_attempts_nonneg CHECK (attempts >= 0),
  CONSTRAINT aud_outbox_events_topic_not_blank CHECK (length(btrim(topic)) > 0)
);
CREATE INDEX IF NOT EXISTS aud_outbox_events_pending_idx
  ON aud_outbox_events (created_at, id)
  WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS aud_tenant_keys (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL UNIQUE,
  wrapped_dek text NOT NULL,
  wrapped_pepper text NOT NULL,
  hash_chain_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE aud_events IS
  'Append-only tenant audit. app_tenant has INSERT and SELECT. UPDATE, DELETE, and TRUNCATE are revoked.';
COMMENT ON TABLE aud_pii_access_logs IS
  'Append-only PII reveal log. app_tenant has INSERT and SELECT only.';
COMMENT ON TABLE aud_outbox_events IS
  'Domain transactions insert. gotong_queue marks published_at. app_tenant cannot update or delete.';
COMMENT ON TABLE aud_tenant_keys IS
  'Per-tenant DEK and blind-index pepper, each wrapped by GOTONG_PII_KEK.';
`;
