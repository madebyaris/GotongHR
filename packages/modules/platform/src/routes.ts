import { fail, ok } from "@gotonghr/contracts";
import type { TenantDatabase } from "@gotonghr/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PlatformDatabase } from "./db.ts";
import { PlatformError } from "./errors.ts";
import {
  activateSupportGrant,
  createSupportGrant,
  revokeSupportGrant,
  withSupportSession,
  type GrantScope,
} from "./grants.ts";
import { featureFlagKeys, type FeatureFlagKey } from "./schema.ts";
import { hashToken, randomToken, signInvite } from "./tokens.ts";
import {
  listAuditEvents,
  listTenantHealth,
  listTenants,
  provisionTenant,
  setTenantStatus,
  storeInviteHash,
  updateTenantConfig,
  writeAudit,
  type TenantConfigPatch,
} from "./tenants.ts";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PlatformActor {
  id: string;
  role: "platform_super_admin" | "platform_ops";
  ip: string | null;
}

export type PlatformActorResult =
  | { kind: "ok"; actor: PlatformActor }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" };

export interface TenantAdmin {
  tenantId: string;
  userId: string;
  role: string;
  ip: string | null;
}

export type TenantAdminResult =
  | { kind: "ok"; admin: TenantAdmin }
  | {
      kind: "denied";
      status: 400 | 401 | 403;
      code: string;
      message: string;
      meta?: { challenge: string };
    };

export interface PlatformDeps {
  platform: PlatformDatabase;
  app: TenantDatabase;
  mountPlatformRoutes: boolean;
  inviteSecret: string;
  hashOwnerPassword(password: string): Promise<string>;
  readPlatformActor(request: FastifyRequest): Promise<PlatformActorResult>;
  readTenantAdmin(request: FastifyRequest): Promise<TenantAdminResult>;
}

const flagPatch = z
  .object({
    aiAssistant: z.boolean().optional(),
    coretaxXml: z.boolean().optional(),
    sso: z.boolean().optional(),
  })
  .strict();

const createTenantBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    .max(64),
  ownerEmail: z.string().trim().email().max(254),
  ownerName: z.string().trim().min(1).max(120),
  ownerPassword: z.string().min(12).max(128),
  planCode: z.string().trim().min(1).max(64).optional(),
});

const statusBody = z.object({
  status: z.enum(["active", "suspended"]),
});

const configBody = z
  .object({
    planCode: z.string().trim().min(1).max(64).optional(),
    subdomain: z
      .string()
      .trim()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u)
      .nullable()
      .optional(),
    customDomain: z
      .string()
      .trim()
      .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/u)
      .nullable()
      .optional(),
    maxSeats: z.number().int().positive().max(100_000).optional(),
    maxBranches: z.number().int().positive().max(10_000).optional(),
    maxStorageMb: z.number().int().positive().max(10_000_000).optional(),
    monthlyAiTokens: z.number().int().nonnegative().max(1_000_000_000).optional(),
    featureFlags: flagPatch.optional(),
  })
  .strict();

const grantBody = z.object({
  granteePlatformUserId: z.uuid(),
  reason: z.string().trim().min(1).max(500),
  expiresAt: z.iso.datetime(),
  scope: z.enum(["read_only", "read_write"]).optional(),
  allowPiiReveal: z.boolean().optional(),
});

const activateBody = z.object({
  token: z.string().min(20).max(200),
});

const sessionBody = z.object({
  sessionToken: z.string().min(20).max(200),
});

const idParam = z.object({
  id: z.uuid(),
});

/**
 * Tenant grant routes are always mounted. `/api/v1/platform/*` is mounted only
 * when `mountPlatformRoutes` is true. Slice 1.3 adds the tenant `aud_events` copy.
 */
export async function registerPlatform(app: FastifyInstance, deps: PlatformDeps): Promise<void> {
  app.post("/api/v1/tenant/support-grants", async (request, reply) => {
    const admin = await requireTenantAdmin(deps, request, reply);
    if (!admin) return;
    const body = await parseBody(reply, grantBody, request.body);
    if (!body) return;
    const scope: GrantScope = body.scope ?? "read_only";
    const allowPiiReveal = body.allowPiiReveal ?? false;
    await run(reply, async () => {
      const created = await createSupportGrant(deps.app, {
        tenantId: admin.tenantId,
        grantedByUserId: admin.userId,
        granteePlatformUserId: body.granteePlatformUserId,
        reason: body.reason,
        expiresAt: new Date(body.expiresAt),
        scope,
        allowPiiReveal,
      });
      return reply.code(201).send(ok(created));
    });
  });

  app.post("/api/v1/tenant/support-grants/:id/revoke", async (request, reply) => {
    const admin = await requireTenantAdmin(deps, request, reply);
    if (!admin) return;
    const params = await parseBody(reply, idParam, request.params);
    if (!params) return;
    await run(reply, async () => {
      const revoked = await revokeSupportGrant(deps.app, {
        tenantId: admin.tenantId,
        grantId: params.id,
      });
      return reply.send(ok(revoked));
    });
  });

  if (!deps.mountPlatformRoutes) return;

  app.get("/api/v1/platform/tenants", async (request, reply) => {
    const actor = await requireActor(deps, request, reply);
    if (!actor) return;
    await run(reply, async () => reply.send(ok(await listTenants(deps.platform))));
  });

  app.post("/api/v1/platform/tenants", async (request, reply) => {
    const actor = await requireActor(deps, request, reply);
    if (!actor) return;
    const body = await parseBody(reply, createTenantBody, request.body);
    if (!body) return;
    await run(reply, async () => {
      const planCode = body.planCode ?? "starter";
      const created = await provisionTenant(deps.platform, {
        name: body.name,
        slug: body.slug,
        ownerEmail: body.ownerEmail.toLowerCase(),
        ownerName: body.ownerName,
        passwordHash: await deps.hashOwnerPassword(body.ownerPassword),
        planCode,
        inviteTokenHash: hashToken(randomToken()),
      });
      const inviteToken = signInvite(deps.inviteSecret, {
        tenantId: created.tenantId,
        email: body.ownerEmail.toLowerCase(),
        exp: Date.now() + INVITE_TTL_MS,
      });
      await storeInviteHash(deps.platform, created.tenantId, hashToken(inviteToken));
      await writeAudit(deps.platform.pool, {
        actorId: actor.id,
        action: "tenant.create",
        tenantId: created.tenantId,
        grantId: null,
        diff: { slug: body.slug, planCode },
        ip: actor.ip,
      });
      return reply.code(201).send(
        ok({
          id: created.tenantId,
          organizationId: created.organizationId,
          slug: body.slug,
          planCode,
          inviteToken,
        }),
      );
    });
  });

  app.patch("/api/v1/platform/tenants/:id/status", async (request, reply) => {
    const actor = await requireActor(deps, request, reply);
    if (!actor) return;
    const params = await parseBody(reply, idParam, request.params);
    if (!params) return;
    const body = await parseBody(reply, statusBody, request.body);
    if (!body) return;
    await run(reply, async () => {
      await setTenantStatus(deps.platform, params.id, body.status);
      await writeAudit(deps.platform.pool, {
        actorId: actor.id,
        action: "tenant.status",
        tenantId: params.id,
        grantId: null,
        diff: { status: body.status },
        ip: actor.ip,
      });
      return reply.send(ok({ id: params.id, status: body.status }));
    });
  });

  app.patch("/api/v1/platform/tenants/:id/config", async (request, reply) => {
    const actor = await requireActor(deps, request, reply);
    if (!actor) return;
    const params = await parseBody(reply, idParam, request.params);
    if (!params) return;
    const body = await parseBody(reply, configBody, request.body);
    if (!body) return;
    await run(reply, async () => {
      const patch: TenantConfigPatch = {};
      if (body.planCode !== undefined) patch.planCode = body.planCode;
      if (body.subdomain !== undefined) patch.subdomain = body.subdomain;
      if (body.customDomain !== undefined) patch.customDomain = body.customDomain;
      if (body.maxSeats !== undefined) patch.maxSeats = body.maxSeats;
      if (body.maxBranches !== undefined) patch.maxBranches = body.maxBranches;
      if (body.maxStorageMb !== undefined) patch.maxStorageMb = body.maxStorageMb;
      if (body.monthlyAiTokens !== undefined) patch.monthlyAiTokens = body.monthlyAiTokens;
      if (body.featureFlags) patch.featureFlags = definedFlags(body.featureFlags);
      const updated = await updateTenantConfig(deps.platform, params.id, patch);
      await writeAudit(deps.platform.pool, {
        actorId: actor.id,
        action: "tenant.config",
        tenantId: params.id,
        grantId: null,
        diff: {
          planCode: updated.planCode,
          maxSeats: updated.maxSeats,
          featureFlags: updated.featureFlags,
        },
        ip: actor.ip,
      });
      return reply.send(ok(updated));
    });
  });

  app.get("/api/v1/platform/statutory-tables", async (request, reply) => {
    const actor = await requireActor(deps, request, reply);
    if (!actor) return;
    return reply.send(ok([], { implemented: false }));
  });

  app.post("/api/v1/platform/statutory-tables", async (request, reply) => {
    const actor = await requireActor(deps, request, reply);
    if (!actor) return;
    return reply.code(501).send(fail("not_implemented", "Statutory drafts land in a later slice."));
  });

  app.post("/api/v1/platform/statutory-tables/:id/publish", async (request, reply) => {
    const actor = await requireActor(deps, request, reply);
    if (!actor) return;
    return reply.code(501).send(fail("not_implemented", "Statutory publishing lands in a later slice."));
  });

  app.get("/api/v1/platform/health/tenants", async (request, reply) => {
    const actor = await requireActor(deps, request, reply);
    if (!actor) return;
    await run(reply, async () => reply.send(ok(await listTenantHealth(deps.platform))));
  });

  app.post("/api/v1/platform/support-grants/activate", async (request, reply) => {
    const actor = await requireActor(deps, request, reply);
    if (!actor) return;
    const body = await parseBody(reply, activateBody, request.body);
    if (!body) return;
    await run(reply, async () => {
      const activated = await activateSupportGrant(deps.platform, deps.app, {
        token: body.token,
        actorId: actor.id,
        ip: actor.ip,
      });
      return reply.send(ok(activated));
    });
  });

  app.post("/api/v1/platform/support-grants/session", async (request, reply) => {
    const actor = await requireActor(deps, request, reply);
    if (!actor) return;
    const body = await parseBody(reply, sessionBody, request.body);
    if (!body) return;
    await run(reply, async () => {
      const opened = await withSupportSession(
        deps.platform,
        deps.app,
        { sessionToken: body.sessionToken, actorId: actor.id, ip: actor.ip },
        async () => null,
      );
      return reply.send(
        ok({
          tenantId: opened.tenantId,
          contextTenantId: opened.contextTenantId,
        }),
      );
    });
  });

  app.get("/api/v1/platform/audit-events", async (request, reply) => {
    const actor = await requireActor(deps, request, reply);
    if (!actor) return;
    await run(reply, async () => reply.send(ok(await listAuditEvents(deps.platform))));
  });
}

function definedFlags(
  flags: z.infer<typeof flagPatch>,
): Partial<Record<FeatureFlagKey, boolean>> {
  const patch: Partial<Record<FeatureFlagKey, boolean>> = {};
  for (const key of featureFlagKeys) {
    const value = flags[key];
    if (typeof value === "boolean") patch[key] = value;
  }
  return patch;
}

async function requireActor(
  deps: PlatformDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<PlatformActor | undefined> {
  const result = await deps.readPlatformActor(request);
  if (result.kind === "ok") return result.actor;
  const status = result.kind === "unauthenticated" ? 401 : 403;
  const code = result.kind === "unauthenticated" ? "unauthenticated" : "forbidden";
  const message = result.kind === "unauthenticated" ? "Sign in required." : "Missing permission.";
  await reply.code(status).send(fail(code, message));
  return undefined;
}

async function requireTenantAdmin(
  deps: PlatformDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<TenantAdmin | undefined> {
  const result = await deps.readTenantAdmin(request);
  if (result.kind === "ok") return result.admin;
  if (result.meta) {
    await reply.code(result.status).send(fail(result.code, result.message, result.meta));
  } else {
    await reply.code(result.status).send(fail(result.code, result.message));
  }
  return undefined;
}

async function parseBody<T>(
  reply: FastifyReply,
  schema: z.ZodType<T>,
  value: unknown,
): Promise<T | undefined> {
  const parsed = schema.safeParse(value);
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
    reply.log.error({ err: error }, "platform request failed");
    await reply.code(500).send(fail("internal_error", "Request failed."));
  }
}
