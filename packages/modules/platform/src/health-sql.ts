/**
 * The only statement platform operators use for tenant health.
 * It returns one aggregate row per tenant.
 * It does not read hr_employee_pii or pay_run_items.
 * Payslip sizes live on pay_run_items, so storage_bytes omits them.
 * Missing tables count as zero so a database that has not migrated attendance
 * or payroll still answers.
 */
export const platformTenantHealthSql = `
CREATE OR REPLACE FUNCTION platform_tenant_health()
RETURNS TABLE (
  tenant_id uuid,
  tenant_status text,
  active_users bigint,
  clock_in_count bigint,
  queue_depth bigint,
  storage_bytes bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  tenant_row record;
  export_bytes bigint;
BEGIN
  FOR tenant_row IN
    SELECT id_tenants.id, id_tenants.status
    FROM id_tenants
    ORDER BY id_tenants.id
  LOOP
    tenant_id := tenant_row.id;
    tenant_status := tenant_row.status;
    active_users := 0;
    clock_in_count := 0;
    queue_depth := 0;
    storage_bytes := 0;
    export_bytes := 0;

    IF to_regclass('public.id_memberships') IS NOT NULL THEN
      EXECUTE 'SELECT count(*)::bigint FROM id_memberships WHERE tenant_id = $1'
        INTO active_users
        USING tenant_row.id;
    END IF;

    IF to_regclass('public.att_clock_events') IS NOT NULL THEN
      EXECUTE 'SELECT count(*)::bigint FROM att_clock_events WHERE tenant_id = $1 AND punch_type = ''clock_in'''
        INTO clock_in_count
        USING tenant_row.id;
    END IF;

    IF to_regclass('pgboss.job') IS NOT NULL THEN
      EXECUTE 'SELECT count(*)::bigint FROM pgboss.job WHERE state IN (''created'', ''retry'', ''active'') AND data->>''tenantId'' = $1::text'
        INTO queue_depth
        USING tenant_row.id;
    END IF;

    IF to_regclass('public.hr_documents') IS NOT NULL THEN
      EXECUTE 'SELECT COALESCE(sum(byte_size), 0)::bigint FROM hr_documents WHERE tenant_id = $1'
        INTO storage_bytes
        USING tenant_row.id;
    END IF;

    IF to_regclass('public.pay_exports') IS NOT NULL THEN
      EXECUTE 'SELECT COALESCE(sum(byte_size), 0)::bigint FROM pay_exports WHERE tenant_id = $1'
        INTO export_bytes
        USING tenant_row.id;
      storage_bytes := storage_bytes + export_bytes;
    END IF;

    RETURN NEXT;
  END LOOP;
  RETURN;
END
$fn$;

COMMENT ON FUNCTION platform_tenant_health() IS
  'Per-tenant counters for a platform operator: memberships, clock-in punches, queued jobs, and stored file bytes.';
`;
