import type { TenantDatabase } from "@gotonghr/db";
import type { GotongAuth } from "@gotonghr/identity";
import type { FastifyInstance } from "fastify";

/**
 * Session checks without auth HTTP routes.
 * The worker and the AI process validate a cookie issued by another process.
 */
export function attachSessionIdentity(
  app: FastifyInstance,
  handle: { auth: GotongAuth; appDb: TenantDatabase },
): void {
  app.decorate("gotongIdentity", handle);
  app.decorateRequest("gotongAuth", null);
}
