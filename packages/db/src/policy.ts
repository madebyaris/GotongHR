const identifier = /^[a-z_][a-z0-9_]*$/;

/**
 * Registers the tenant isolation policy used by every later tenant table.
 * The predicate compares tenant_id to the transaction-local setting.
 */
export function tenantIsolationPolicySql(tableName: string): string {
  if (!identifier.test(tableName)) {
    throw new Error(`invalid table name: ${tableName}`);
  }
  const predicate =
    "tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid";
  return [
    `ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS ${tableName}_tenant_isolation ON ${tableName}`,
    `CREATE POLICY ${tableName}_tenant_isolation ON ${tableName} USING (${predicate}) WITH CHECK (${predicate})`,
  ].join(";\n");
}
