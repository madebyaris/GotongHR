import { APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE, tenantIsolationPolicySql } from "@gotonghr/db";
import pg from "pg";
import { curatedSummaries } from "./summaries.ts";

const { Client } = pg;

export interface AiMigrateInput {
  migratorUrl: string;
  superuserUrl: string;
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
      await migrator.query(knowledgeSql);
      await grantAppDml(migrator, "ai_knowledge_chunks");
      await grantCurrentTenantFunction(migrator);
      await migrator.query("COMMIT");
    } catch (error) {
      await migrator.query("ROLLBACK");
      throw error;
    }
  } finally {
    await migrator.end();
  }
  await seedCuratedSummaries(input.superuserUrl);
}

async function grantCurrentTenantFunction(client: pg.Client): Promise<void> {
  await client.query("REVOKE ALL ON FUNCTION public.current_tenant_id() FROM PUBLIC");
  await client.query(`REVOKE ALL ON FUNCTION public.current_tenant_id() FROM ${PLATFORM_ROLE}`);
  await client.query(`REVOKE ALL ON FUNCTION public.current_tenant_id() FROM ${QUEUE_ROLE}`);
  await client.query(`GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO ${APP_ROLE}`);
}

async function seedCuratedSummaries(superuserUrl: string): Promise<void> {
  const admin = new Client({ connectionString: superuserUrl });
  await admin.connect();
  try {
    await admin.query("BEGIN");
    try {
      for (const item of curatedSummaries) {
        await admin.query(
          `INSERT INTO ai_knowledge_chunks (
             tenant_id, source_type, citation_ref, title, content, is_statute_text, document_id, chunk_index
           ) VALUES (NULL, 'curated_summary', $1, $2, $3, false, $4::uuid, 0)
           ON CONFLICT (citation_ref) WHERE tenant_id IS NULL
           DO UPDATE SET
             title = EXCLUDED.title,
             content = EXCLUDED.content,
             is_statute_text = false,
             updated_at = now()`,
          [item.citationRef, item.title, item.content, item.documentId],
        );
      }
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  } finally {
    await admin.end();
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

const knowledgeSql = `
CREATE TABLE IF NOT EXISTS ai_knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid,
  source_type text NOT NULL,
  citation_ref text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  is_statute_text boolean NOT NULL,
  document_id uuid NOT NULL,
  chunk_index integer NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce(title, '') || ' ' || coalesce(content, '') || ' ' || coalesce(citation_ref, '')
    )
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_knowledge_chunks_source_check CHECK (source_type IN ('tenant_sop', 'curated_summary')),
  CONSTRAINT ai_knowledge_chunks_scope_check CHECK (
    (
      source_type = 'curated_summary'
      AND tenant_id IS NULL
      AND is_statute_text = false
      AND position('not the statute' in content) > 0
    )
    OR (
      source_type = 'tenant_sop'
      AND tenant_id IS NOT NULL
      AND is_statute_text = false
    )
  ),
  CONSTRAINT ai_knowledge_chunks_chunk_check CHECK (chunk_index >= 0)
);

CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_tenant_idx
  ON ai_knowledge_chunks (tenant_id);
CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_search_idx
  ON ai_knowledge_chunks USING GIN (search_vector);
CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_chunks_global_citation_uidx
  ON ai_knowledge_chunks (citation_ref)
  WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_chunks_document_chunk_uidx
  ON ai_knowledge_chunks (document_id, chunk_index);

COMMENT ON TABLE ai_knowledge_chunks IS
  'Keyword corpus. Curated rows have a null tenant_id and are not statute text. There is no pgvector column.';

CREATE OR REPLACE FUNCTION public.current_tenant_id() RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
$$;

ALTER TABLE ai_knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_knowledge_chunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_knowledge_chunks_select ON ai_knowledge_chunks;
DROP POLICY IF EXISTS ai_knowledge_chunks_insert ON ai_knowledge_chunks;
DROP POLICY IF EXISTS ai_knowledge_chunks_update ON ai_knowledge_chunks;
DROP POLICY IF EXISTS ai_knowledge_chunks_delete ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_select ON ai_knowledge_chunks
  FOR SELECT
  USING (tenant_id = public.current_tenant_id() OR tenant_id IS NULL);
CREATE POLICY ai_knowledge_chunks_insert ON ai_knowledge_chunks
  FOR INSERT
  WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY ai_knowledge_chunks_update ON ai_knowledge_chunks
  FOR UPDATE
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
CREATE POLICY ai_knowledge_chunks_delete ON ai_knowledge_chunks
  FOR DELETE
  USING (tenant_id = public.current_tenant_id());
`;
