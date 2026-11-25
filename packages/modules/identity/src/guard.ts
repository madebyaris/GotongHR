import {
  fail,
  isPrivilegedRole,
  permissionRequiresPrivilegedTotp,
  type PermissionAtom,
} from "@gotonghr/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  membershipsForAuthUser,
  sessionHasTotpVerification,
  type MembershipRecord,
} from "./directory.ts";

export const TENANT_HEADER = "x-gotong-tenant-id";

export interface GotongAuthContext {
  tenantId: string;
  organizationId: string;
  authUserId: string;
  userId: string;
  email: string;
  role: string;
  permissions: readonly PermissionAtom[];
  scopeEntityIds: readonly string[];
  scopeBranchIds: readonly string[];
  directReportsOnly: boolean;
  selfOnly: boolean;
  twoFactorEnabled: boolean;
  sessionTotpVerified: boolean;
}

interface AuthSession {
  user: { id: string; twoFactorEnabled?: boolean };
  session: { id?: string; activeOrganizationId?: string };
}

/**
 * Order: session, tenant header, permission, then TOTP for privileged payroll/PII.
 * Scope flags are attached for later slices. This slice does not filter rows by them.
 */
export function requirePermission(atom: PermissionAtom) {
  return async function permissionGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const handle = request.server.gotongIdentity;
    if (!handle) throw new Error("Identity plugin is not registered.");
    const session = readSession(
      await handle.auth.api.getSession({ headers: webHeaders(request.headers) }),
    );
    if (!session) {
      await reply.code(401).send(fail("unauthenticated", "Sign in required."));
      return;
    }
    const memberships = await membershipsForAuthUser(handle.appDb.pool, session.user.id);
    const header = tenantHeader(request.headers);
    const selected = selectMembership(memberships, header, session.session.activeOrganizationId);
    if (selected === "none") {
      await reply.code(403).send(fail("no_membership", "No active membership."));
      return;
    }
    if (selected === "mismatch") {
      await reply.code(403).send(fail("tenant_mismatch", "The tenant header does not match a membership."));
      return;
    }
    if (selected === "required") {
      await reply.code(400).send(fail("tenant_required", "Choose a tenant."));
      return;
    }
    if (!selected.permissions.includes(atom)) {
      await reply.code(403).send(fail("forbidden", "Missing permission."));
      return;
    }
    const twoFactorEnabled = session.user.twoFactorEnabled === true;
    let sessionTotpVerified = false;
    if (permissionRequiresPrivilegedTotp(atom) && isPrivilegedRole(selected.role)) {
      if (!twoFactorEnabled) {
        await reply.code(403).send(
          fail(
            "totp_enrollment_required",
            "Set up an authenticator before using this route.",
            { challenge: "totp_enrollment" },
          ),
        );
        return;
      }
      sessionTotpVerified = session.session.id
        ? await sessionHasTotpVerification(handle.appDb, selected.tenantId, session.session.id)
        : false;
      if (!sessionTotpVerified) {
        await reply.code(403).send(
          fail(
            "totp_verification_required",
            "Confirm this sign-in with an authenticator code.",
            { challenge: "totp_verification" },
          ),
        );
        return;
      }
    }
    request.gotongAuth = {
      tenantId: selected.tenantId,
      organizationId: selected.organizationId,
      authUserId: selected.authUserId,
      userId: selected.userId,
      email: selected.email,
      role: selected.role,
      permissions: selected.permissions,
      scopeEntityIds: selected.scopeEntityIds,
      scopeBranchIds: selected.scopeBranchIds,
      directReportsOnly: selected.directReportsOnly,
      selfOnly: selected.selfOnly,
      twoFactorEnabled,
      sessionTotpVerified,
    };
  };
}

function selectMembership(
  memberships: readonly MembershipRecord[],
  header: string | null | "invalid",
  activeOrganizationId: string | undefined,
): MembershipRecord | "none" | "mismatch" | "required" {
  if (memberships.length === 0) return "none";
  if (header === "invalid") return "mismatch";
  const resolved = resolveActiveMembership(memberships, activeOrganizationId);
  if (resolved === "required") {
    // A header must not pick a tenant the session has not already resolved.
    return header ? "mismatch" : "required";
  }
  if (header && header !== resolved.tenantId) return "mismatch";
  return resolved;
}

function resolveActiveMembership(
  memberships: readonly MembershipRecord[],
  activeOrganizationId: string | undefined,
): MembershipRecord | "required" {
  if (memberships.length === 1) return memberships[0] ?? "required";
  if (activeOrganizationId) {
    const matches = memberships.filter(
      (membership) => membership.organizationId === activeOrganizationId,
    );
    if (matches.length === 1) return matches[0] ?? "required";
  }
  return "required";
}

function tenantHeader(headers: FastifyRequest["headers"]): string | null | "invalid" {
  if (!(TENANT_HEADER in headers)) return null;
  const value = headers[TENANT_HEADER];
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
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

function readSession(value: unknown): AuthSession | null {
  if (!value || typeof value !== "object") return null;
  const record = value as {
    user?: { id?: unknown; twoFactorEnabled?: unknown };
    session?: { id?: unknown; activeOrganizationId?: unknown };
  };
  if (!record.user || typeof record.user.id !== "string") return null;
  const twoFactorEnabled =
    typeof record.user.twoFactorEnabled === "boolean" ? record.user.twoFactorEnabled : undefined;
  const sessionId = typeof record.session?.id === "string" ? record.session.id : undefined;
  const activeOrganizationId =
    typeof record.session?.activeOrganizationId === "string"
      ? record.session.activeOrganizationId
      : undefined;
  const session: AuthSession["session"] = {};
  if (sessionId) session.id = sessionId;
  if (activeOrganizationId) session.activeOrganizationId = activeOrganizationId;
  return {
    user: twoFactorEnabled === undefined ? { id: record.user.id } : { id: record.user.id, twoFactorEnabled },
    session,
  };
}
