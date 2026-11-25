import type { TenantExportReadPort } from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import { sql } from "drizzle-orm";
import { PlatformError } from "./errors.ts";
import { streamTenantExportZip, type TenantExportUpload } from "./zip-stream.ts";

export const TENANT_EXPORT_QUEUE = "gotong.tenant.export";
const EXPORT_FAILED = "export_failed";

export interface TenantExportMessage {
  tenantId: string;
  exportId: string;
}

export interface TenantExportView {
  id: string;
  status: "queued" | "running" | "ready" | "failed";
  byteSize: number | null;
  storageKey: string | null;
}

export interface TenantExportStorage {
  putStream(input: TenantExportUpload): Promise<{ byteSize: number }>;
}

export interface TenantExportDeps {
  appDb: TenantDatabase;
  read: TenantExportReadPort;
  storage: TenantExportStorage;
}

const uuidText = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function tenantExportObjectKey(tenantId: string, exportId: string): string {
  return `tenant-exports/${tenantId}/${exportId}.zip`;
}

export async function createTenantExport(
  appDb: TenantDatabase,
  input: { tenantId: string; userId: string },
): Promise<{ id: string; status: "queued" }> {
  return appDb.withTenantContext(input.tenantId, async (tx) => {
    const rows = queryRows<{ id: string }>(
      await tx.execute(sql`
        INSERT INTO tenant_exports (tenant_id, requested_by, status)
        VALUES (${input.tenantId}::uuid, ${input.userId}::uuid, 'queued')
        RETURNING id::text AS id
      `),
    );
    const id = rows[0]?.id;
    if (!id) throw new PlatformError(500, "internal_error", "Export was not stored.");
    return { id, status: "queued" };
  });
}

export async function readTenantExport(
  appDb: TenantDatabase,
  input: { tenantId: string; exportId: string },
): Promise<TenantExportView | null> {
  return appDb.withTenantContext(input.tenantId, async (tx) => {
    const rows = queryRows<{
      id: string;
      status: string;
      byte_size: string | number | null;
      storage_key: string | null;
    }>(
      await tx.execute(sql`
        SELECT id::text AS id, status, byte_size::text AS byte_size, storage_key
        FROM tenant_exports
        WHERE id = ${input.exportId}::uuid
      `),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      status: exportStatus(row.status),
      byteSize: readByteSize(row.byte_size),
      storageKey: row.storage_key,
    };
  });
}

export async function markTenantExportFailed(
  appDb: TenantDatabase,
  input: { tenantId: string; exportId: string },
): Promise<void> {
  await appDb.withTenantContext(input.tenantId, async (tx) => {
    await tx.execute(sql`
      UPDATE tenant_exports
      SET status = 'failed',
          storage_key = NULL,
          byte_size = NULL,
          error_code = ${EXPORT_FAILED},
          completed_at = NULL,
          updated_at = now()
      WHERE id = ${input.exportId}::uuid
        AND status IN ('queued', 'running')
    `);
  });
}

/**
 * Builds one tenant ZIP and streams it to storage.
 * A ready job returns without writing again. A failed job can be claimed on retry.
 */
export async function processTenantExport(
  deps: TenantExportDeps,
  message: TenantExportMessage,
): Promise<void> {
  const tenantId = assertUuid(message.tenantId);
  const exportId = assertUuid(message.exportId);
  const claimed = await claimExport(deps.appDb, tenantId, exportId);
  if (claimed === "ready") return;
  if (claimed === "missing") throw new Error("Export was not found.");
  const key = tenantExportObjectKey(tenantId, exportId);
  try {
    const tables = await deps.read.tables(tenantId);
    const files = await deps.read.files(tenantId);
    const stored = await streamTenantExportZip({
      key,
      tables,
      files,
      putStream: (input) => deps.storage.putStream(input),
    });
    await markReady(deps.appDb, { tenantId, exportId, key, byteSize: stored.byteSize });
  } catch (error) {
    await markTenantExportFailed(deps.appDb, { tenantId, exportId }).catch(() => undefined);
    throw error;
  }
}

async function claimExport(
  appDb: TenantDatabase,
  tenantId: string,
  exportId: string,
): Promise<"claimed" | "ready" | "missing"> {
  return appDb.withTenantContext(tenantId, async (tx) => {
    const updated = queryRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE tenant_exports
        SET status = 'running', error_code = NULL, updated_at = now()
        WHERE id = ${exportId}::uuid
          AND status IN ('queued', 'running', 'failed')
        RETURNING id::text AS id
      `),
    );
    if (updated[0]?.id) return "claimed";
    const current = queryRows<{ status: string }>(
      await tx.execute(sql`
        SELECT status FROM tenant_exports WHERE id = ${exportId}::uuid
      `),
    );
    if (current[0]?.status === "ready") return "ready";
    return "missing";
  });
}

async function markReady(
  appDb: TenantDatabase,
  input: { tenantId: string; exportId: string; key: string; byteSize: number },
): Promise<void> {
  await appDb.withTenantContext(input.tenantId, async (tx) => {
    const updated = queryRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE tenant_exports
        SET status = 'ready',
            storage_key = ${input.key},
            byte_size = ${input.byteSize}::bigint,
            error_code = NULL,
            completed_at = now(),
            updated_at = now()
        WHERE id = ${input.exportId}::uuid
          AND status = 'running'
        RETURNING id::text AS id
      `),
    );
    if (!updated[0]?.id) throw new Error("Export did not finish.");
  });
}

function assertUuid(value: string): string {
  if (!uuidText.test(value)) throw new Error("Export id is not a uuid.");
  return value.toLowerCase();
}

function exportStatus(value: string): TenantExportView["status"] {
  if (value === "queued" || value === "running" || value === "ready" || value === "failed") return value;
  throw new PlatformError(500, "internal_error", "Export status is invalid.");
}

function readByteSize(value: unknown): number | null {
  if (value == null) return null;
  const size = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new PlatformError(500, "internal_error", "Export size is invalid.");
  }
  return size;
}

function queryRows<T>(result: unknown): T[] {
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  if (Array.isArray(result)) return result as T[];
  return [];
}
