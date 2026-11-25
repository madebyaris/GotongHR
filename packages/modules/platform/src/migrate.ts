import { APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE } from "@gotonghr/db";
import pg from "pg";

const { Client } = pg;

export interface PlatformMigrateInput {
  superuserUrl: string;
  migratorUrl: string;
}

const PROVISION =
  "sys_provision_tenant(text, text, text, text, text, text, jsonb, text)";
const SET_STATUS = "sys_set_tenant_status(uuid, text)";
const OPERATOR_EXISTS = "sys_platform_operator_exists(uuid)";

/**
 * Platform tables and the two definer functions request handlers call.
 * Run this after identity migrate. Handlers use `DATABASE_URL_PLATFORM` and
 * do not call this function.
 */
export async function migratePlatform(input: PlatformMigrateInput): Promise<void> {
  const migrator = new Client({ connectionString: input.migratorUrl });
  await migrator.connect();
  try {
    await migrator.query("BEGIN");
    try {
      await migrator.query(tableSql);
      await grantPlatformTables(migrator);
      await grantTenantMetadata(migrator);
      await grantSupportGrants(migrator);
      await migrator.query("COMMIT");
    } catch (error) {
      await migrator.query("ROLLBACK");
      throw error;
    }
  } finally {
    await migrator.end();
  }

  const admin = new Client({ connectionString: input.superuserUrl });
  await admin.connect();
  try {
    await admin.query("BEGIN");
    try {
      await admin.query(functionSql);
      for (const signature of [PROVISION, SET_STATUS]) {
        await admin.query(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
        await admin.query(`REVOKE ALL ON FUNCTION ${signature} FROM ${APP_ROLE}`);
        await admin.query(`REVOKE ALL ON FUNCTION ${signature} FROM ${QUEUE_ROLE}`);
        await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${PLATFORM_ROLE}`);
      }
      await admin.query(`REVOKE ALL ON FUNCTION ${OPERATOR_EXISTS} FROM PUBLIC`);
      await admin.query(`REVOKE ALL ON FUNCTION ${OPERATOR_EXISTS} FROM ${PLATFORM_ROLE}`);
      await admin.query(`REVOKE ALL ON FUNCTION ${OPERATOR_EXISTS} FROM ${QUEUE_ROLE}`);
      await admin.query(`GRANT EXECUTE ON FUNCTION ${OPERATOR_EXISTS} TO ${APP_ROLE}`);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  } finally {
    await admin.end();
  }
}

async function grantPlatformTables(client: pg.Client): Promise<void> {
  for (const table of [
    "sys_plans",
    "sys_tenant_quotas",
    "sys_platform_operators",
    "sys_support_grants",
    "sys_platform_audit_events",
  ]) {
    await client.query(`REVOKE ALL ON TABLE ${table} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON TABLE ${table} FROM ${APP_ROLE}`);
    await client.query(`REVOKE ALL ON TABLE ${table} FROM ${QUEUE_ROLE}`);
    await client.query(`REVOKE ALL ON TABLE ${table} FROM ${PLATFORM_ROLE}`);
  }
  for (const table of ["sys_plans", "sys_platform_operators"]) {
    await client.query(`GRANT SELECT, INSERT, UPDATE ON TABLE ${table} TO ${PLATFORM_ROLE}`);
  }
  await client.query(`GRANT SELECT, INSERT ON TABLE sys_tenant_quotas TO ${PLATFORM_ROLE}`);
  await client.query(`
    GRANT UPDATE (
      plan_id, subdomain, custom_domain, max_seats, max_branches, max_storage_mb,
      monthly_ai_tokens, feature_flags_json, owner_invite_token_hash, updated_at
    ) ON TABLE sys_tenant_quotas TO ${PLATFORM_ROLE}
  `);
  await client.query(
    `GRANT SELECT, INSERT ON TABLE sys_platform_audit_events TO ${PLATFORM_ROLE}`,
  );
}

async function grantTenantMetadata(client: pg.Client): Promise<void> {
  await client.query(`
    GRANT SELECT (id, organization_id, name, slug, status, created_at, updated_at)
    ON TABLE id_tenants TO ${PLATFORM_ROLE}
  `);
  await client.query(`
    DROP POLICY IF EXISTS id_tenants_platform_metadata ON id_tenants
  `);
  await client.query(`
    CREATE POLICY id_tenants_platform_metadata ON id_tenants
      FOR SELECT
      TO ${PLATFORM_ROLE}
      USING (true)
  `);
}

async function grantSupportGrants(client: pg.Client): Promise<void> {
  await client.query(`
    GRANT SELECT, INSERT, UPDATE ON TABLE sys_support_grants TO ${PLATFORM_ROLE}
  `);
  await client.query(`
    GRANT INSERT (
      tenant_id, granted_by_user_id, grantee_platform_user_id, token_hash,
      scope, allow_pii_reveal, reason, expires_at
    ) ON TABLE sys_support_grants TO ${APP_ROLE}
  `);
  await client.query(`
    GRANT SELECT (
      id, tenant_id, granted_by_user_id, grantee_platform_user_id,
      scope, allow_pii_reveal, reason, expires_at, revoked_at, consumed_at,
      activated_at, created_at, updated_at
    ) ON TABLE sys_support_grants TO ${APP_ROLE}
  `);
  await client.query(`
    GRANT UPDATE (revoked_at, updated_at) ON TABLE sys_support_grants TO ${APP_ROLE}
  `);
}

const tableSql = `
CREATE TABLE IF NOT EXISTS sys_plans (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  default_quotas_json jsonb NOT NULL,
  default_feature_flags_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sys_platform_operators (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  auth_user_id text NOT NULL UNIQUE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sys_platform_operators_role_check CHECK (role IN ('platform_super_admin', 'platform_ops'))
);

CREATE TABLE IF NOT EXISTS sys_tenant_quotas (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES id_tenants (id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES sys_plans (id),
  status text NOT NULL DEFAULT 'active',
  custom_domain text,
  subdomain text,
  max_seats integer NOT NULL,
  max_branches integer NOT NULL,
  max_storage_mb integer NOT NULL,
  monthly_ai_tokens integer NOT NULL,
  feature_flags_json jsonb NOT NULL,
  owner_invite_token_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sys_tenant_quotas_status_check CHECK (status IN ('active', 'suspended')),
  CONSTRAINT sys_tenant_quotas_positive CHECK (
    max_seats > 0 AND max_branches > 0 AND max_storage_mb > 0 AND monthly_ai_tokens >= 0
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS sys_tenant_quotas_subdomain_uidx
  ON sys_tenant_quotas (subdomain) WHERE subdomain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sys_tenant_quotas_custom_domain_uidx
  ON sys_tenant_quotas (custom_domain) WHERE custom_domain IS NOT NULL;

CREATE TABLE IF NOT EXISTS sys_support_grants (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  granted_by_user_id uuid NOT NULL,
  grantee_platform_user_id uuid NOT NULL REFERENCES sys_platform_operators (id),
  token_hash text NOT NULL UNIQUE,
  scope text NOT NULL DEFAULT 'read_only',
  allow_pii_reveal boolean NOT NULL DEFAULT false,
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  consumed_at timestamptz,
  session_token_hash text,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sys_support_grants_scope_check CHECK (scope IN ('read_only', 'read_write')),
  CONSTRAINT sys_support_grants_expiry_after_create CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '4 hours'
  ),
  CONSTRAINT sys_support_grants_reason_check CHECK (length(trim(reason)) > 0)
);
CREATE INDEX IF NOT EXISTS sys_support_grants_tenant_id_idx ON sys_support_grants (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS sys_support_grants_session_hash_uidx
  ON sys_support_grants (session_token_hash) WHERE session_token_hash IS NOT NULL;

ALTER TABLE sys_support_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE sys_support_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sys_support_grants_tenant_isolation ON sys_support_grants;
CREATE POLICY sys_support_grants_tenant_isolation ON sys_support_grants
  FOR ALL
  TO ${APP_ROLE}
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS sys_support_grants_platform ON sys_support_grants;
CREATE POLICY sys_support_grants_platform ON sys_support_grants
  FOR ALL
  TO ${PLATFORM_ROLE}
  USING (true)
  WITH CHECK (true);

CREATE TABLE IF NOT EXISTS sys_platform_audit_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  actor_platform_user_id uuid NOT NULL,
  action text NOT NULL,
  target_tenant_id uuid,
  support_grant_id uuid,
  diff_json jsonb,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sys_platform_audit_events_created_at_idx
  ON sys_platform_audit_events (created_at DESC);

INSERT INTO sys_plans (code, name, default_quotas_json, default_feature_flags_json)
VALUES (
  'starter',
  'Starter',
  '{"maxSeats":25,"maxBranches":3,"maxStorageMb":5120,"monthlyAiTokens":100000}'::jsonb,
  '{"aiAssistant":false,"coretaxXml":true,"sso":false}'::jsonb
)
ON CONFLICT (code) DO NOTHING;

COMMENT ON TABLE sys_support_grants IS 'Break-glass grant. token_hash is SHA-256 of a single-use token. The plaintext is not stored.';
COMMENT ON TABLE sys_platform_audit_events IS 'Append-only platform operator log. platform_admin has INSERT and SELECT only.';

ALTER TABLE sys_support_grants DROP CONSTRAINT IF EXISTS sys_support_grants_expiry_after_create;
ALTER TABLE sys_support_grants ADD CONSTRAINT sys_support_grants_expiry_after_create
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '4 hours');
`;

const functionSql = `
CREATE OR REPLACE FUNCTION sys_set_tenant_status(p_tenant_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF p_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'tenant status is invalid' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE id_tenants
  SET status = p_status, updated_at = now()
  WHERE id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant not found' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE sys_tenant_quotas
  SET status = p_status, updated_at = now()
  WHERE tenant_id = p_tenant_id;
END
$fn$;

CREATE OR REPLACE FUNCTION sys_provision_tenant(
  p_name text,
  p_slug text,
  p_owner_email text,
  p_owner_name text,
  p_password_hash text,
  p_plan_code text,
  p_roles jsonb,
  p_invite_token_hash text
) RETURNS TABLE (
  tenant_id uuid,
  organization_id text,
  auth_user_id text,
  owner_user_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_org_id text;
  v_user_id text;
  v_tenant_id uuid;
  v_owner_id uuid;
  v_plan_id uuid;
BEGIN
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'tenant name is empty' USING ERRCODE = 'check_violation';
  END IF;
  IF p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'tenant slug is invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF p_plan_code IS NULL THEN
    RAISE EXCEPTION 'plan is unknown' USING ERRCODE = 'check_violation';
  END IF;
  SELECT id INTO v_plan_id FROM sys_plans WHERE code = p_plan_code;
  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'plan is unknown' USING ERRCODE = 'check_violation';
  END IF;

  v_user_id := gen_random_uuid()::text;
  v_org_id := gen_random_uuid()::text;
  v_tenant_id := uuidv7();

  INSERT INTO ba_user (id, name, email, email_verified, created_at, updated_at)
  VALUES (v_user_id, p_owner_name, lower(trim(p_owner_email)), true, now(), now());

  INSERT INTO ba_account (id, account_id, provider_id, user_id, password, created_at, updated_at)
  VALUES (gen_random_uuid()::text, v_user_id, 'credential', v_user_id, p_password_hash, now(), now());

  INSERT INTO ba_organization (id, name, slug, created_at)
  VALUES (v_org_id, p_name, p_slug, now());

  INSERT INTO ba_member (id, organization_id, user_id, role, created_at)
  VALUES (gen_random_uuid()::text, v_org_id, v_user_id, 'member', now());

  INSERT INTO id_tenants (id, organization_id, name, slug, status)
  VALUES (v_tenant_id, v_org_id, p_name, p_slug, 'active');

  INSERT INTO id_roles (tenant_id, code, permissions)
  SELECT
    v_tenant_id,
    item->>'code',
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(item->'permissions')), ARRAY[]::text[])
  FROM jsonb_array_elements(p_roles) AS item;

  INSERT INTO id_users (tenant_id, auth_user_id, email, display_name)
  VALUES (v_tenant_id, v_user_id, lower(trim(p_owner_email)), p_owner_name)
  RETURNING id INTO v_owner_id;

  INSERT INTO id_memberships (
    tenant_id, user_id, auth_user_id, role_id, direct_reports_only, self_only
  )
  SELECT
    v_tenant_id,
    v_owner_id,
    v_user_id,
    id_roles.id,
    COALESCE((item->>'directReportsOnly')::boolean, false),
    COALESCE((item->>'selfOnly')::boolean, false)
  FROM id_roles
  JOIN jsonb_array_elements(p_roles) AS item ON item->>'code' = id_roles.code
  WHERE id_roles.tenant_id = v_tenant_id
    AND id_roles.code = 'org_owner';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'org_owner role was not seeded' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO sys_tenant_quotas (
    tenant_id, plan_id, status, max_seats, max_branches, max_storage_mb,
    monthly_ai_tokens, feature_flags_json, owner_invite_token_hash
  )
  SELECT
    v_tenant_id,
    sys_plans.id,
    'active',
    (sys_plans.default_quotas_json->>'maxSeats')::integer,
    (sys_plans.default_quotas_json->>'maxBranches')::integer,
    (sys_plans.default_quotas_json->>'maxStorageMb')::integer,
    (sys_plans.default_quotas_json->>'monthlyAiTokens')::integer,
    sys_plans.default_feature_flags_json,
    p_invite_token_hash
  FROM sys_plans
  WHERE sys_plans.id = v_plan_id;

  RETURN QUERY SELECT v_tenant_id, v_org_id, v_user_id, v_owner_id;
END
$fn$;

CREATE OR REPLACE FUNCTION sys_platform_operator_exists(p_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (SELECT 1 FROM sys_platform_operators WHERE id = p_id);
$fn$;
`;
