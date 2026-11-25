import { APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE, tenantIsolationPolicySql } from "@gotonghr/db";
import pg from "pg";

const { Client } = pg;

export interface AiMigrateInput {
  migratorUrl: string;
}

const tenantTables = ["ai_conversations", "ai_messages", "ai_action_proposals"] as const;

/**
 * AI tables, FORCE RLS, and DML for app_tenant only.
 * Run this after `@gotonghr/db` migrate so the login roles exist.
 * platform_admin and gotong_queue receive no privileges.
 */
export async function migrateAi(input: AiMigrateInput): Promise<void> {
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
CREATE TABLE IF NOT EXISTS ai_conversations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL,
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_conversations_tenant_idx
  ON ai_conversations (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS ai_messages (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
  role text NOT NULL,
  content_redacted text NOT NULL,
  tool_calls_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_messages_role_check CHECK (role IN ('user', 'assistant', 'tool'))
);
CREATE INDEX IF NOT EXISTS ai_messages_conversation_idx
  ON ai_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS ai_messages_tenant_idx
  ON ai_messages (tenant_id);

CREATE TABLE IF NOT EXISTS ai_action_proposals (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  conversation_id uuid REFERENCES ai_conversations (id) ON DELETE SET NULL,
  created_by_user_id uuid NOT NULL,
  tool_name text NOT NULL,
  arguments_json jsonb NOT NULL,
  impact_preview_json jsonb NOT NULL,
  confirmation_nonce text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  executed_at timestamptz,
  decided_by_user_id uuid,
  execution_result_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_action_proposals_status_check CHECK (
    status IN ('pending', 'executed', 'rejected', 'expired')
  ),
  CONSTRAINT ai_action_proposals_nonce_hash_check CHECK (
    confirmation_nonce ~ '^[0-9a-f]{64}$'
  )
);
CREATE INDEX IF NOT EXISTS ai_action_proposals_tenant_status_idx
  ON ai_action_proposals (tenant_id, status, expires_at);
CREATE INDEX IF NOT EXISTS ai_action_proposals_creator_idx
  ON ai_action_proposals (tenant_id, created_by_user_id);

COMMENT ON TABLE ai_action_proposals IS
  'HITL proposals. confirmation_nonce is a SHA-256 hex digest. The raw secret is not stored.';
COMMENT ON COLUMN ai_action_proposals.confirmation_nonce IS
  'SHA-256 hex of the confirmation secret. Compare with a constant-time check.';
`;
