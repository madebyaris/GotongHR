import { sql } from "drizzle-orm";
import { index, pgTable, uuid } from "drizzle-orm/pg-core";

export const rlsProbe = pgTable(
  "rls_probe",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
  },
  (table) => [index("rls_probe_tenant_id_idx").on(table.tenantId)],
);
