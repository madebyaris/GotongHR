import pg from "pg";

const { Client } = pg;

export interface MobileMigrateInput {
  migratorUrl: string;
}

/**
 * Links a sign-in to one employee so the ESS bootstrap can load that profile.
 * Run this after core-hr migrate. The column stays null until a row is linked.
 * Deleting the user clears the link. It does not delete the employee.
 */
export async function migrateMobile(input: MobileMigrateInput): Promise<void> {
  const migrator = new Client({ connectionString: input.migratorUrl });
  await migrator.connect();
  try {
    await migrator.query("BEGIN");
    try {
      await migrator.query(linkSql);
      await migrator.query("COMMIT");
    } catch (error) {
      await migrator.query("ROLLBACK");
      throw error;
    }
  } finally {
    await migrator.end();
  }
}

const linkSql = `
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS user_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS hr_employees_user_key
  ON hr_employees (tenant_id, user_id)
  WHERE user_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hr_employees_user_fkey'
  ) THEN
    ALTER TABLE hr_employees
      ADD CONSTRAINT hr_employees_user_fkey
      FOREIGN KEY (user_id, tenant_id)
      REFERENCES id_users (id, tenant_id)
      ON DELETE SET NULL (user_id);
  END IF;
END $$;

COMMENT ON COLUMN hr_employees.user_id IS
  'Sign-in that opens ESS for this employee. Null until linked. One user per tenant.';
`;
