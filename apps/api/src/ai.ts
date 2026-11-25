import { appendAuditEvent, provisionTenantKeys } from "@gotonghr/audit";
import type { AuditAppendPort, AuditEventDraft, DomainActionExecutor } from "@gotonghr/contracts";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import type { GotongAuthContext } from "@gotonghr/identity";
import { requireMember } from "@gotonghr/identity";
import {
  createAiRuntime,
  createFakeProvider,
  createLlmProvider,
  registerAiRoutes,
  type AiCaller,
  type AiRuntimeDeps,
  type LlmProvider,
} from "@gotonghr/ai";
import type { FastifyInstance } from "fastify";

export interface TenantAiOptions {
  database: TenantDatabase;
  env: NodeJS.ProcessEnv;
  domain?: DomainActionExecutor;
  provider?: LlmProvider;
  loadTable?: AiRuntimeDeps["loadTable"];
}

/**
 * Wires the assistant. The domain executor is the only path that may change
 * employee data, and only after confirm. The default executor writes nothing.
 */
export async function registerTenantAi(
  app: FastifyInstance,
  options: TenantAiOptions,
): Promise<{ provider: LlmProvider; domain: DomainActionExecutor }> {
  const provider = options.provider ?? providerFor(options.env);
  const domain = options.domain ?? unchangedDomain();
  const runtime = createAiRuntime({
    database: options.database,
    provider,
    domain,
    audit: auditPort(options.env),
    ...(options.loadTable ? { loadTable: options.loadTable } : {}),
  });
  await registerAiRoutes(app, {
    runtime,
    guard: requireMember(),
    readCaller(request) {
      return callerFrom(request.gotongAuth);
    },
  });
  return { provider, domain };
}

function providerFor(env: NodeJS.ProcessEnv): LlmProvider {
  if (env.NODE_ENV === "test") return createFakeProvider();
  return createLlmProvider(env);
}

function unchangedDomain(): DomainActionExecutor {
  return {
    execute(command) {
      return Promise.resolve({
        applied: false,
        reason: "no_domain_table",
        toolName: command.toolName,
        proposalId: command.proposalId,
      });
    },
  };
}

function auditPort(env: NodeJS.ProcessEnv): AuditAppendPort {
  return {
    async append(tx, event) {
      const tenantTx = tx as TenantTx;
      await provisionTenantKeys(tenantTx, event.tenantId, env);
      await appendAuditEvent(tenantTx, auditInput(event));
    },
  };
}

function auditInput(event: AuditEventDraft) {
  return {
    tenantId: event.tenantId,
    actorUserId: event.actorUserId,
    actorRole: event.actorRole,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    diff: event.diff,
    aiProposalId: event.aiProposalId,
    supportGrantId: null,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
  };
}

function callerFrom(auth: GotongAuthContext | null): AiCaller | null {
  if (!auth) return null;
  return {
    tenantId: auth.tenantId,
    userId: auth.userId,
    role: auth.role,
    permissions: auth.permissions,
    scopeEntityIds: auth.scopeEntityIds,
    scopeBranchIds: auth.scopeBranchIds,
    directReportsOnly: auth.directReportsOnly,
    selfOnly: auth.selfOnly,
    selfEmployeeId: null,
    sessionTotpVerified: auth.sessionTotpVerified,
  };
}
