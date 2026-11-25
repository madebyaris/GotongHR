import { APP_ROLE, PLATFORM_ROLE, QUEUE_ROLE, tenantIsolationPolicySql } from "@gotonghr/db";
import pg from "pg";

/** Metadata for an employee file. Bytes stay in object storage. FORCE RLS. */
export async function migrateHrDocuments(client: pg.Client): Promise<void> {
  await client.query(documentSql);
  await client.query(tenantIsolationPolicySql("hr_documents"));
  await grantAppDml(client, "hr_documents");
  await client.query(touchSql);
}

async function grantAppDml(client: pg.Client, table: string): Promise<void> {
  await client.query(`REVOKE ALL ON TABLE ${table} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${PLATFORM_ROLE}`);
  await client.query(`REVOKE ALL ON TABLE ${table} FROM ${QUEUE_ROLE}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO ${APP_ROLE}`);
}

const documentSql = `
CREATE TABLE IF NOT EXISTS hr_documents (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES id_tenants (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  doc_type text NOT NULL,
  file_name text NOT NULL,
  storage_key text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  CONSTRAINT hr_documents_employee_fkey
    FOREIGN KEY (employee_id, tenant_id)
    REFERENCES hr_employees (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT hr_documents_storage_key_key UNIQUE (tenant_id, storage_key),
  CONSTRAINT hr_documents_doc_type_check CHECK (
    doc_type IN ('ktp', 'npwp', 'kk', 'bpjs', 'contract', 'other')
  ),
  CONSTRAINT hr_documents_file_name_check CHECK (
    file_name = btrim(file_name)
    AND char_length(file_name) BETWEEN 1 AND 60
    AND file_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
  ),
  CONSTRAINT hr_documents_storage_key_check CHECK (
    char_length(storage_key) BETWEEN 1 AND 201
    AND storage_key !~ '\\.\\.'
    AND storage_key !~ '//'
  ),
  CONSTRAINT hr_documents_content_type_check CHECK (
    content_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
  ),
  CONSTRAINT hr_documents_byte_size_check CHECK (
    byte_size > 0 AND byte_size <= 2097152
  )
);
CREATE INDEX IF NOT EXISTS hr_documents_employee_idx
  ON hr_documents (tenant_id, employee_id);

COMMENT ON TABLE hr_documents IS
  'Employee document metadata and the object-storage key. File bytes are not stored. FORCE RLS. platform_admin has no privileges.';
`;

const touchSql = `
DROP TRIGGER IF EXISTS hr_documents_touch ON hr_documents;
CREATE TRIGGER hr_documents_touch
  BEFORE UPDATE ON hr_documents
  FOR EACH ROW
  EXECUTE FUNCTION hr_touch_updated_at();
`;
