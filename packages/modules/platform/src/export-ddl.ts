/** Owner export jobs. migratePlatform applies this, then FORCE RLS. */
export const tenantExportTableSql = `
CREATE TABLE IF NOT EXISTS tenant_exports (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  requested_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  storage_key text,
  byte_size bigint,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (id, tenant_id),
  FOREIGN KEY (requested_by, tenant_id) REFERENCES id_users (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT tenant_exports_status_check CHECK (
    status IN ('queued', 'running', 'ready', 'failed')
  ),
  CONSTRAINT tenant_exports_shape_check CHECK (
    (
      status = 'ready'
      AND storage_key IS NOT NULL
      AND byte_size > 0
      AND completed_at IS NOT NULL
      AND error_code IS NULL
    )
    OR (
      status = 'failed'
      AND storage_key IS NULL
      AND byte_size IS NULL
      AND completed_at IS NULL
      AND error_code ~ '^[a-z0-9_]{1,40}$'
    )
    OR (
      status IN ('queued', 'running')
      AND storage_key IS NULL
      AND byte_size IS NULL
      AND completed_at IS NULL
      AND error_code IS NULL
    )
  ),
  CONSTRAINT tenant_exports_storage_key_check CHECK (
    storage_key IS NULL
    OR (
      char_length(storage_key) BETWEEN 1 AND 201
      AND storage_key !~ '\\.\\.'
      AND storage_key !~ '//'
    )
  )
);

COMMENT ON TABLE tenant_exports IS
  'One owner archive job. The ZIP lives in object storage. FORCE RLS. platform_admin has no privileges.';
`;
