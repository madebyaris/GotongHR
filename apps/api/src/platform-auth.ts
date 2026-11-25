import { authenticateRequest, type GotongAuth } from "@gotonghr/identity";
import type { PlatformActorResult, PlatformDatabase, TenantAdminResult } from "@gotonghr/platform";
import type { FastifyRequest } from "fastify";

export function platformReaders(input: { auth: GotongAuth; platform: PlatformDatabase }): {
  readPlatformActor(request: FastifyRequest): Promise<PlatformActorResult>;
  readTenantAdmin(request: FastifyRequest): Promise<TenantAdminResult>;
} {
  return {
    async readPlatformActor(request) {
      const session = readSession(
        await input.auth.api.getSession({ headers: webHeaders(request.headers) }),
      );
      if (!session) return { kind: "unauthenticated" };
      const operator = await input.platform.pool.query<{ id: string; role: string }>(
        "SELECT id, role FROM sys_platform_operators WHERE auth_user_id = $1",
        [session.userId],
      );
      const row = operator.rows[0];
      if (!row || (row.role !== "platform_super_admin" && row.role !== "platform_ops")) {
        return { kind: "forbidden" };
      }
      const role = row.role === "platform_super_admin" ? "platform_super_admin" : "platform_ops";
      return { kind: "ok", actor: { id: row.id, role, ip: request.ip || null } };
    },
    async readTenantAdmin(request) {
      const result = await authenticateRequest(request);
      if (!result.ok) {
        const denied: TenantAdminResult = {
          kind: "denied",
          status: result.status,
          code: result.code,
          message: result.message,
        };
        if (result.meta) denied.meta = result.meta;
        return denied;
      }
      if (result.context.role !== "org_owner" && result.context.role !== "it_security_admin") {
        return { kind: "denied", status: 403, code: "forbidden", message: "Missing permission." };
      }
      return {
        kind: "ok",
        admin: {
          tenantId: result.context.tenantId,
          userId: result.context.userId,
          role: result.context.role,
          ip: request.ip || null,
        },
      };
    },
  };
}

function readSession(value: unknown): { userId: string } | null {
  if (!value || typeof value !== "object") return null;
  const user = (value as { user?: { id?: unknown } }).user;
  if (!user || typeof user.id !== "string") return null;
  return { userId: user.id };
}

function webHeaders(headers: FastifyRequest["headers"]): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result.set(key, value);
    else if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    }
  }
  return result;
}
