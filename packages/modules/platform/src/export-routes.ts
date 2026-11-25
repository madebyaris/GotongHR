import { fail, ok } from "@gotonghr/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createTenantExport,
  markTenantExportFailed,
  readTenantExport,
} from "./export-job.ts";
import { PlatformError } from "./errors.ts";
import type { PlatformDeps, TenantAdmin } from "./routes.ts";

const DOWNLOAD_TTL_SECONDS = 900;

const idParam = z.object({
  id: z.uuid(),
});

/** Owner archive routes. Mounted in every deployment mode, including single_tenant. */
export async function registerTenantExportRoutes(
  app: FastifyInstance,
  deps: PlatformDeps,
): Promise<void> {
  app.post("/api/v1/tenant/exports", async (request, reply) => {
    const owner = await requireTenantOwner(deps, request, reply);
    if (!owner) return;
    await run(reply, async () => {
      const created = await createTenantExport(deps.app, {
        tenantId: owner.tenantId,
        userId: owner.userId,
      });
      try {
        await deps.enqueueTenantExport({ tenantId: owner.tenantId, exportId: created.id });
      } catch (error) {
        await markTenantExportFailed(deps.app, {
          tenantId: owner.tenantId,
          exportId: created.id,
        }).catch(() => undefined);
        throw error;
      }
      return reply.code(201).send(
        ok({
          id: created.id,
          status: created.status,
          byteSize: null,
          download: null,
        }),
      );
    });
  });

  app.get("/api/v1/tenant/exports/:id", async (request, reply) => {
    const owner = await requireTenantOwner(deps, request, reply);
    if (!owner) return;
    const params = await parseParams(reply, request.params);
    if (!params) return;
    await run(reply, async () => {
      const record = await readTenantExport(deps.app, {
        tenantId: owner.tenantId,
        exportId: params.id,
      });
      if (!record) throw new PlatformError(404, "not_found", "Export was not found.");
      const download = await downloadFor(deps, record);
      return reply.send(
        ok({
          id: record.id,
          status: record.status,
          byteSize: record.byteSize,
          download,
        }),
      );
    });
  });
}

async function downloadFor(
  deps: PlatformDeps,
  record: { status: string; storageKey: string | null; byteSize: number | null },
): Promise<{ url: string; expiresInSeconds: number } | null> {
  if (record.status !== "ready") return null;
  if (!record.storageKey || record.byteSize == null) {
    throw new PlatformError(500, "internal_error", "Export file is missing.");
  }
  const signed = await deps.presignExportDownload({
    key: record.storageKey,
    expiresInSeconds: DOWNLOAD_TTL_SECONDS,
  });
  return { url: signed.url, expiresInSeconds: DOWNLOAD_TTL_SECONDS };
}

async function requireTenantOwner(
  deps: PlatformDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<TenantAdmin | undefined> {
  const result = await deps.readTenantOwner(request);
  if (result.kind === "ok") return result.admin;
  if (result.meta) {
    await reply.code(result.status).send(fail(result.code, result.message, result.meta));
  } else {
    await reply.code(result.status).send(fail(result.code, result.message));
  }
  return undefined;
}

async function parseParams(
  reply: FastifyReply,
  value: unknown,
): Promise<{ id: string } | undefined> {
  const parsed = idParam.safeParse(value);
  if (parsed.success) return parsed.data;
  await reply.code(400).send(fail("invalid", "The request was invalid."));
  return undefined;
}

async function run(reply: FastifyReply, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (reply.sent) return;
    if (error instanceof PlatformError) {
      await reply.code(error.status).send(fail(error.code, error.message));
      return;
    }
    reply.log.error({ err: error }, "tenant export failed");
    await reply.code(500).send(fail("internal_error", "Request failed."));
  }
}
