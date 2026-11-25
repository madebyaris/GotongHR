import { APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE, tenantIsolationPolicySql } from "@gotonghr/db";
import pg from "pg";

/** Queued CSV import. The worker streams the object. Commit is all-or-nothing. FORCE RLS. */
export async function migrateHrImportJobs(client: pg.Client): Promise<void> {
  await client.query(importSql);
  await client.query(tenantIsolationPolicySql("hr_import_jobs"));
  await grantAppDml(client, "hr_import_jobs");
  await client.query(touchSql);
}

async function grantAppDml(client: pg.Client, table: string): Promise<void> {
  await client.query(`REVOKE ALL ON TABLE ${table} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${PLATFORM_ROLE}`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${QUEUE_ROLE}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO ${APP_ROLE}`);
}

const importSql = `
CREATE TABLE IF NOT EXISTS hr_import_jobs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  status text NOT NULL,
  mode text NOT NULL,
  storage_key text NOT NULL,
  legal_entity_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  total_rows integer NOT NULL DEFAULT 0,
  valid_rows integer NOT NULL DEFAULT 0,
  error_rows integer NOT NULL DEFAULT 0,
  written_rows integer NOT NULL DEFAULT 0,
  line_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_json jsonb,
  requested_by uuid NOT NULL,
  actor_role text NOT NULL DEFAULT 'hr_admin',
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT hr_import_jobs_storage_key_key UNIQUE (tenant_id, storage_key),
  CONSTRAINT hr_import_jobs_entity_fkey
    FOREIGN KEY (legal_entity_id, tenant_id)
    REFERENCES id_legal_entities (id, tenant_id),
  CONSTRAINT hr_import_jobs_branch_fkey
    FOREIGN KEY (branch_id, tenant_id, legal_entity_id)
    REFERENCES id_branches (id, tenant_id, legal_entity_id),
  CONSTRAINT hr_import_jobs_status_check CHECK (
    status IN ('queued', 'running', 'completed', 'failed')
  ),
  CONSTRAINT hr_import_jobs_mode_check CHECK (
    mode IN ('dry_run', 'commit')
  ),
  CONSTRAINT hr_import_jobs_counts_check CHECK (
    total_rows >= 0 AND valid_rows >= 0 AND error_rows >= 0 AND written_rows >= 0
    AND valid_rows <= total_rows AND error_rows <= total_rows AND written_rows <= total_rows
  ),
  CONSTRAINT hr_import_jobs_line_errors_check CHECK (jsonb_typeof(line_errors) = 'array'),
  CONSTRAINT hr_import_jobs_error_json_check CHECK (
    error_json IS NULL OR jsonb_typeof(error_json) = 'object'
  ),
  CONSTRAINT hr_import_jobs_storage_key_check CHECK (
    char_length(storage_key) BETWEEN 1 AND 201
    AND storage_key !~ '\\.\\.'
    AND storage_key !~ '//'
  ),
  CONSTRAINT hr_import_jobs_actor_check CHECK (
    char_length(actor_role) BETWEEN 1 AND 80
    AND (ip_address IS NULL OR char_length(ip_address) <= 64)
    AND (user_agent IS NULL OR char_length(user_agent) <= 512)
  )
);
CREATE INDEX IF NOT EXISTS hr_import_jobs_status_idx
  ON hr_import_jobs (tenant_id, status);

COMMENT ON TABLE hr_import_jobs IS
  'CSV import job. storage_key points at the object. line_errors lists row failures. Commit writes every valid row or none. FORCE RLS. platform_admin has no privileges.';
`;

const touchSql = `
DROP TRIGGER IF EXISTS hr_import_jobs_touch ON hr_import_jobs;
CREATE TRIGGER hr_import_jobs_touch
  BEFORE UPDATE ON hr_import_jobs
  FOR EACH ROW
  EXECUTE FUNCTION hr_touch_updated_at();
`;
