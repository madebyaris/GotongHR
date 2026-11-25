export const tenantExportTableNames = [
  "employees",
  "contracts",
  "attendance",
  "leave",
  "payroll_runs",
] as const;

export type TenantExportTableName = (typeof tenantExportTableNames)[number];

export interface TenantExportTable {
  name: TenantExportTableName;
  columns: readonly string[];
  rows(): AsyncIterable<readonly (string | null)[]>;
}

export interface TenantExportFile {
  zipPath: string;
  open(): Promise<AsyncIterable<Uint8Array | string>>;
}

/** Cross-module read for a tenant archive. apps/api supplies the adapter. */
export interface TenantExportReadPort {
  tables(tenantId: string): Promise<readonly TenantExportTable[]>;
  files(tenantId: string): Promise<readonly TenantExportFile[]>;
}
