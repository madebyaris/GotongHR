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
  tenantAccessForAuthUser,
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

type AuthChallenge = "totp_enrollment" | "totp_verification";

export type AuthResult =
  | { ok: true; context: GotongAuthContext }
  | {
      ok: false;
      status: 400 | 401 | 403;
      code: string;
      message: string;
      meta?: { challenge: AuthChallenge };
    };

/**
 * Order: session, suspended tenant, tenant header, permission, then TOTP.
 * Scope flags are attached for later slices. This slice does not filter rows by them.
 * Omit `permission` when the caller only needs a membership, such as a support grant.
 */
export async function authenticateRequest(
  request: FastifyRequest,
  options?: { permission?: PermissionAtom },
): Promise<AuthResult> {
  const handle = request.server.gotongIdentity;
  if (!handle) throw new Error("Identity plugin is not registered.");
  const session = readSession(
    await handle.auth.api.getSession({ headers: webHeaders(request.headers) }),
  );
  if (!session) return denied(401, "unauthenticated", "Sign in required.");
  const access = await tenantAccessForAuthUser(handle.appDb.pool, session.user.id);
  const header = tenantHeader(request.headers);
  if (
    typeof header === "string" &&
    access.some((row) => row.tenantId.toLowerCase() === header && row.status === "suspended")
  ) {
    return denied(403, "tenant_suspended", "Tenant is suspended.");
  }
  const memberships = await membershipsForAuthUser(handle.appDb.pool, session.user.id);
  if (memberships.length === 0 && access.some((row) => row.status === "suspended")) {
    return denied(403, "tenant_suspended", "Tenant is suspended.");
  }
  const selected = selectMembership(memberships, header, session.session.activeOrganizationId);
  if (selected === "none") return denied(403, "no_membership", "No active membership.");
  if (selected === "mismatch") {
    return denied(403, "tenant_mismatch", "The tenant header does not match a membership.");
  }
  if (selected === "required") return denied(400, "tenant_required", "Choose a tenant.");
  const permission = options?.permission;
  if (permission && !selected.permissions.includes(permission)) {
    return denied(403, "forbidden", "Missing permission.");
  }
  const twoFactorEnabled = session.user.twoFactorEnabled === true;
  let sessionTotpVerified = false;
  if (permission && permissionRequiresPrivilegedTotp(permission) && isPrivilegedRole(selected.role)) {
    if (!twoFactorEnabled) {
      return denied(
        403,
        "totp_enrollment_required",
        "Set up an authenticator before using this route.",
        { challenge: "totp_enrollment" },
      );
    }
    sessionTotpVerified = session.session.id
      ? await sessionHasTotpVerification(handle.appDb, selected.tenantId, session.session.id)
      : false;
    if (!sessionTotpVerified) {
      return denied(
        403,
        "totp_verification_required",
        "Confirm this sign-in with an authenticator code.",
        { challenge: "totp_verification" },
      );
    }
  }
  return {
    ok: true,
    context: {
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
    },
  };
}

export function requireSession() {
  return async function sessionGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await sendAuthResult(request, reply, await authenticateRequest(request));
  };
}

export function requirePermission(atom: PermissionAtom) {
  return async function permissionGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await sendAuthResult(request, reply, await authenticateRequest(request, { permission: atom }));
  };
}

function denied(
  status: 400 | 401 | 403,
  code: string,
  message: string,
  meta?: { challenge: AuthChallenge },
): AuthResult {
  if (meta) return { ok: false, status, code, message, meta };
  return { ok: false, status, code, message };
}

async function sendAuthResult(
  request: FastifyRequest,
  reply: FastifyReply,
  result: AuthResult,
): Promise<void> {
  if (result.ok) {
    request.gotongAuth = result.context;
    return;
  }
  if (result.meta) {
    await reply.code(result.status).send(fail(result.code, result.message, result.meta));
    return;
  }
  await reply.code(result.status).send(fail(result.code, result.message));
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
