import { APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE, tenantIsolationPolicySql } from "@gotonghr/db";
import pg from "pg";

const { Client } = pg;

export interface IdentityMigrateInput {
  superuserUrl: string;
  migratorUrl: string;
}

const tenantTables = [
  "id_roles",
  "id_users",
  "id_memberships",
  "id_sessions",
  "id_legal_entities",
  "id_branches",
] as const;

const appTables = [
  "id_tenants",
  ...tenantTables,
  "id_rate_limits",
  "ba_user",
  "ba_session",
  "ba_account",
  "ba_verification",
  "ba_organization",
  "ba_member",
  "ba_invitation",
  "ba_two_factor",
] as const;

/**
 * Identity tables and the pre-tenant resolver functions.
 * Run this after `@gotonghr/db` migrate so the login roles exist.
 * The API process calls it with the superuser URL only from the migrate entrypoint.
 */
export async function migrateIdentity(input: IdentityMigrateInput): Promise<void> {
  const migrator = new Client({ connectionString: input.migratorUrl });
  await migrator.connect();
  try {
    await migrator.query("BEGIN");
    try {
      await migrator.query(tableSql);
      for (const table of tenantTables) {
        await migrator.query(tenantIsolationPolicySql(table));
      }
      await migrator.query(tenantRootPolicySql);
      for (const table of appTables) {
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

  const admin = new Client({ connectionString: input.superuserUrl });
  await admin.connect();
  try {
      await admin.query("BEGIN");
    try {
      await admin.query(superuserRepairSql);
      for (const fn of resolverFunctions) {
        await admin.query(`DROP FUNCTION IF EXISTS ${fn.signature}`);
        await admin.query(fn.body);
        await admin.query(`REVOKE ALL ON FUNCTION ${fn.signature} FROM PUBLIC`);
        await admin.query(`REVOKE ALL ON FUNCTION ${fn.signature} FROM ${PLATFORM_ROLE}`);
        await admin.query(`REVOKE ALL ON FUNCTION ${fn.signature} FROM ${QUEUE_ROLE}`);
        await admin.query(`GRANT EXECUTE ON FUNCTION ${fn.signature} TO ${APP_ROLE}`);
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
  if (!/^[a-z_]+$/u.test(table)) {
    throw new Error(`invalid table name: ${table}`);
  }
  await client.query(`REVOKE ALL ON TABLE ${table} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${PLATFORM_ROLE}`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${QUEUE_ROLE}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO ${APP_ROLE}`);
}

const tenantRootPolicySql = `
ALTER TABLE id_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE id_tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS id_tenants_tenant_isolation ON id_tenants;
CREATE POLICY id_tenants_tenant_isolation ON id_tenants
  USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
`;

/**
 * ba_* holds Better Auth state that is read before a tenant is known: the
 * credential, the session, and the TOTP secret. Better Auth checks out a pool
 * connection that is not inside withTenantContext, so a tenant GUC is not
 * visible there. Those tables have no RLS. app_tenant is the only request
 * role that can read or write them. platform_admin and gotong_queue are
 * revoked. Tenant HR data stays on id_*, which use FORCE RLS
 * (NULLIF(current_setting('app.current_tenant_id', true), '')::uuid).
 * id_rate_limits is global because a login is counted before the session
 * has a tenant.
 *
 * id_memberships_for_auth_user is SECURITY DEFINER and owned by the superuser
 * so the request role can resolve a membership without BYPASSRLS. It is static
 * SQL with a pinned search_path. Request handlers must pass the session user id,
 * not a client-supplied id.
 */
const tableSql = `
CREATE TABLE IF NOT EXISTS ba_user (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  two_factor_enabled boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS ba_session (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES ba_user (id) ON DELETE CASCADE,
  active_organization_id text
);
CREATE INDEX IF NOT EXISTS ba_session_user_id_idx ON ba_session (user_id);

CREATE TABLE IF NOT EXISTS ba_account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES ba_user (id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, account_id)
);
CREATE INDEX IF NOT EXISTS ba_account_user_id_idx ON ba_account (user_id);

CREATE TABLE IF NOT EXISTS ba_verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ba_verification_identifier_idx ON ba_verification (identifier);

CREATE TABLE IF NOT EXISTS ba_organization (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  logo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata text
);

CREATE TABLE IF NOT EXISTS ba_member (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES ba_organization (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES ba_user (id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS ba_invitation (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES ba_organization (id) ON DELETE CASCADE,
  email text NOT NULL,
  role text,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  inviter_id text NOT NULL REFERENCES ba_user (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ba_two_factor (
  id text PRIMARY KEY,
  secret text NOT NULL,
  backup_codes text NOT NULL,
  user_id text NOT NULL UNIQUE REFERENCES ba_user (id) ON DELETE CASCADE,
  verified boolean DEFAULT false,
  failed_verification_count integer DEFAULT 0,
  locked_until timestamptz
);

CREATE TABLE IF NOT EXISTS id_tenants (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id text NOT NULL UNIQUE REFERENCES ba_organization (id) ON DELETE RESTRICT,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT id_tenants_status_check CHECK (status IN ('active', 'suspended'))
);

CREATE TABLE IF NOT EXISTS id_roles (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  code text NOT NULL,
  permissions text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS id_users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  auth_user_id text NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, auth_user_id),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS id_memberships (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  auth_user_id text NOT NULL,
  role_id uuid NOT NULL,
  scope_entity_ids uuid[] NOT NULL DEFAULT '{}',
  scope_branch_ids uuid[] NOT NULL DEFAULT '{}',
  direct_reports_only boolean NOT NULL DEFAULT false,
  self_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, auth_user_id),
  FOREIGN KEY (user_id, tenant_id) REFERENCES id_users (id, tenant_id),
  FOREIGN KEY (role_id, tenant_id) REFERENCES id_roles (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS id_memberships_auth_user_id_idx ON id_memberships (auth_user_id);

CREATE TABLE IF NOT EXISTS id_sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  auth_session_id text NOT NULL REFERENCES ba_session (id) ON DELETE CASCADE,
  auth_user_id text NOT NULL,
  user_id uuid NOT NULL,
  totp_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, auth_session_id),
  FOREIGN KEY (user_id, tenant_id) REFERENCES id_users (id, tenant_id)
);
ALTER TABLE id_sessions ADD COLUMN IF NOT EXISTS totp_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS id_rate_limits (
  key text PRIMARY KEY,
  hits integer NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS id_legal_entities (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  company_name text NOT NULL,
  npwp_16 text NOT NULL,
  jkk_risk_class smallint,
  bpjs_bu_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT id_legal_entities_npwp_16_key UNIQUE (tenant_id, npwp_16),
  CONSTRAINT id_legal_entities_company_name_check CHECK (
    char_length(company_name) BETWEEN 1 AND 160
    AND company_name = btrim(company_name)
  ),
  CONSTRAINT id_legal_entities_npwp_16_check CHECK (npwp_16 ~ '^[0-9]{16}$'),
  CONSTRAINT id_legal_entities_jkk_risk_class_check CHECK (
    jkk_risk_class IS NULL OR jkk_risk_class BETWEEN 1 AND 5
  ),
  CONSTRAINT id_legal_entities_bpjs_bu_code_check CHECK (
    bpjs_bu_code IS NULL OR (
      char_length(bpjs_bu_code) BETWEEN 1 AND 32
      AND bpjs_bu_code ~ '^[A-Za-z0-9.-]+$'
    )
  )
);

CREATE TABLE IF NOT EXISTS id_branches (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL,
  name text NOT NULL,
  nitku_22 text NOT NULL,
  timezone text NOT NULL,
  ump_umk_idr bigint NOT NULL,
  geofence_lat numeric(9, 6),
  geofence_lng numeric(9, 6),
  geofence_radius_m integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT id_branches_nitku_22_key UNIQUE (tenant_id, nitku_22),
  FOREIGN KEY (legal_entity_id, tenant_id)
    REFERENCES id_legal_entities (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT id_branches_name_check CHECK (
    char_length(name) BETWEEN 1 AND 120
    AND name = btrim(name)
  ),
  CONSTRAINT id_branches_nitku_22_check CHECK (nitku_22 ~ '^[0-9]{22}$'),
  CONSTRAINT id_branches_timezone_check CHECK (
    timezone IN ('Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura')
  ),
  CONSTRAINT id_branches_ump_check CHECK (ump_umk_idr >= 0),
  CONSTRAINT id_branches_geofence_lat_check CHECK (
    geofence_lat IS NULL OR (geofence_lat >= -90 AND geofence_lat <= 90)
  ),
  CONSTRAINT id_branches_geofence_lng_check CHECK (
    geofence_lng IS NULL OR (geofence_lng >= -180 AND geofence_lng <= 180)
  ),
  CONSTRAINT id_branches_geofence_radius_check CHECK (
    geofence_radius_m IS NULL OR (geofence_radius_m >= 1 AND geofence_radius_m <= 2000000000)
  ),
  CONSTRAINT id_branches_geofence_complete_check CHECK (
    (
      geofence_lat IS NULL
      AND geofence_lng IS NULL
      AND geofence_radius_m IS NULL
    )
    OR (
      geofence_lat IS NOT NULL
      AND geofence_lng IS NOT NULL
      AND geofence_radius_m IS NOT NULL
    )
  )
);
CREATE INDEX IF NOT EXISTS id_branches_legal_entity_idx ON id_branches (legal_entity_id);

COMMENT ON TABLE ba_user IS 'Better Auth credentials and TOTP. No RLS: sign-in runs before a tenant is known. platform_admin and gotong_queue have no privileges. Tenant rows live in id_* under FORCE RLS.';
COMMENT ON TABLE id_rate_limits IS 'Login and password-reset counters. Not tenant data.';
COMMENT ON TABLE id_tenants IS 'One row per Better Auth organization. Isolation predicate is id, not tenant_id.';
COMMENT ON TABLE id_legal_entities IS 'Tenant PT/CV. npwp_16 is exactly 16 digits. FORCE RLS compares tenant_id to app.current_tenant_id.';
COMMENT ON TABLE id_branches IS 'Branch NITKU, IANA timezone, UMP/UMK bigint rupiah, and geofence. FORCE RLS compares tenant_id to app.current_tenant_id.';
COMMENT ON COLUMN id_branches.geofence_lat IS 'Geofence latitude. API field latitude.';
COMMENT ON COLUMN id_branches.geofence_lng IS 'Geofence longitude. API field longitude.';
COMMENT ON COLUMN id_branches.geofence_radius_m IS 'Geofence radius in meters. API field geofenceRadiusM.';
COMMENT ON COLUMN id_branches.ump_umk_idr IS 'UMP or UMK floor in integer rupiah. API field umpUmkIdr, JSON string.';
`;

/**
 * Fresh databases get the foreign keys from CREATE TABLE. Databases created
 * before those keys existed get them here. Orphan rows are not deleted: the
 * operator has to remove them, then rerun migrations.
 *
 * The ON DELETE CASCADE on id_sessions.auth_session_id is enough. On
 * PostgreSQL 18.7, with FORCE RLS on id_sessions and no BYPASSRLS, dropping
 * ba_session_delete_id_sessions and then `SET ROLE app_tenant; DELETE FROM
 * ba_session` removed the child row and did not raise. The same delete
 * succeeded as gotong_migrator, the table owner, who also has no BYPASSRLS.
 * Referential actions are not filtered by the tenant policy, so the
 * security-definer trigger is dropped instead of kept.
 */
const superuserRepairSql = `
DO $$
DECLARE
  orphan_tenants bigint;
  orphan_sessions bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'id_tenants_organization_id_fkey'
  ) THEN
    SELECT count(*) INTO orphan_tenants
    FROM id_tenants AS t
    WHERE NOT EXISTS (
      SELECT 1 FROM ba_organization AS o WHERE o.id = t.organization_id
    );
    IF orphan_tenants > 0 THEN
      RAISE EXCEPTION
        'id_tenants has % row(s) whose organization_id is not in ba_organization. Delete those rows, then rerun migrations. Example: DELETE FROM id_tenants AS t WHERE NOT EXISTS (SELECT 1 FROM ba_organization AS o WHERE o.id = t.organization_id);',
        orphan_tenants;
    END IF;
    ALTER TABLE id_tenants
      ADD CONSTRAINT id_tenants_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES ba_organization (id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'id_sessions_auth_session_id_fkey'
  ) THEN
    SELECT count(*) INTO orphan_sessions
    FROM id_sessions AS s
    WHERE NOT EXISTS (
      SELECT 1 FROM ba_session AS b WHERE b.id = s.auth_session_id
    );
    IF orphan_sessions > 0 THEN
      RAISE EXCEPTION
        'id_sessions has % row(s) whose auth_session_id is not in ba_session. Delete those rows, then rerun migrations. Example: DELETE FROM id_sessions AS s WHERE NOT EXISTS (SELECT 1 FROM ba_session AS b WHERE b.id = s.auth_session_id);',
        orphan_sessions;
    END IF;
    ALTER TABLE id_sessions
      ADD CONSTRAINT id_sessions_auth_session_id_fkey
      FOREIGN KEY (auth_session_id) REFERENCES ba_session (id) ON DELETE CASCADE;
  END IF;
END $$;

DROP TRIGGER IF EXISTS ba_session_delete_id_sessions ON ba_session;
DROP FUNCTION IF EXISTS id_delete_sessions_for_auth_session();
`;

const resolverFunctions: ReadonlyArray<{ signature: string; body: string }> = [
  {
    signature: "id_tenant_count()",
    body: `
      CREATE FUNCTION id_tenant_count()
      RETURNS integer
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $$
        SELECT count(*)::integer FROM id_tenants;
      $$
    `,
  },
  {
    signature: "id_tenant_id_for_organization(text)",
    body: `
      CREATE FUNCTION id_tenant_id_for_organization(p_organization_id text)
      RETURNS uuid
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $$
        SELECT id FROM id_tenants WHERE organization_id = p_organization_id;
      $$
    `,
  },
  {
    signature: "id_single_tenant_owner()",
    body: `
      CREATE FUNCTION id_single_tenant_owner()
      RETURNS TABLE (
        tenant_id uuid,
        organization_id text,
        owner_email text,
        owner_auth_user_id text
      )
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $$
        SELECT t.id, t.organization_id, u.email, u.auth_user_id
        FROM id_tenants t
        JOIN id_memberships m ON m.tenant_id = t.id
        JOIN id_roles r ON r.id = m.role_id AND r.tenant_id = t.id AND r.code = 'org_owner'
        JOIN id_users u ON u.id = m.user_id AND u.tenant_id = t.id
        ORDER BY t.created_at
        LIMIT 1;
      $$
    `,
  },
  {
    signature: "id_tenant_access_for_auth_user(text)",
    body: `
      CREATE FUNCTION id_tenant_access_for_auth_user(p_auth_user_id text)
      RETURNS TABLE (
        tenant_id uuid,
        status text
      )
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $$
        SELECT t.id, t.status
        FROM id_memberships m
        JOIN id_tenants t ON t.id = m.tenant_id
        WHERE m.auth_user_id = p_auth_user_id;
      $$
    `,
  },
  {
    signature: "id_memberships_for_auth_user(text)",
    body: `
      CREATE FUNCTION id_memberships_for_auth_user(p_auth_user_id text)
      RETURNS TABLE (
        tenant_id uuid,
        organization_id text,
        auth_user_id text,
        user_id uuid,
        email text,
        role_code text,
        permissions text[],
        scope_entity_ids uuid[],
        scope_branch_ids uuid[],
        direct_reports_only boolean,
        self_only boolean,
        status text
      )
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $$
        SELECT
          t.id,
          t.organization_id,
          u.auth_user_id,
          u.id,
          u.email,
          r.code,
          r.permissions,
          m.scope_entity_ids,
          m.scope_branch_ids,
          m.direct_reports_only,
          m.self_only,
          t.status
        FROM id_memberships m
        JOIN id_tenants t ON t.id = m.tenant_id
        JOIN id_users u ON u.id = m.user_id AND u.tenant_id = m.tenant_id
        JOIN id_roles r ON r.id = m.role_id AND r.tenant_id = m.tenant_id
        WHERE m.auth_user_id = p_auth_user_id;
      $$
    `,
  },
];
