import {
  isPrivilegedRole,
  permissionRequiresPrivilegedTotp,
  type AuditAppendPort,
  type AuditEventDraft,
  type DomainActionExecutor,
} from "@gotonghr/contracts";
import type { TenantDatabase, TenantTx } from "@gotonghr/db";
import { id2026DraftTable } from "@gotonghr/payroll-engine/draft";
import type { StatutoryTable } from "@gotonghr/payroll-engine";
import { sql } from "drizzle-orm";
import type { AiCaller, RequestMeta } from "./caller.ts";
import { createConfirmationNonce, nonceMatches } from "./nonce.ts";
import type { FakeStep, LlmMessage, LlmProvider, LlmToolCall } from "./provider.ts";
import { RedactionSession } from "./redact.ts";
import {
  asJsonRecord,
  claimProposal,
  conversationOwnedBy,
  insertConversation,
  insertMessage,
  insertProposal,
  iso,
  listMessages,
  listOwnProposals,
  lockProposal,
  markExpired,
  rejectPending,
  saveExecution,
  touchConversation,
  type ProposalRow,
} from "./store.ts";
import { dispatchTool, isMutatingTool, toolsForCaller } from "./tools.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_MESSAGE = 8_000;
const MAX_ROUNDS = 3;

const SYSTEM_PROMPT =
  "You are the GotongHR assistant. Use only the provided tools. Do not calculate tax, BPJS, or leave balances yourself. A mutating tool does not change records until a person confirms it.";

export interface AiFailure {
  ok: false;
  status: 400 | 403 | 404 | 409;
  code: string;
  message: string;
}

export interface ProposalView {
  id: string;
  conversationId: string | null;
  toolName: string;
  status: string;
  expiresAt: string;
  impactPreview: unknown;
  arguments: unknown;
  executedAt: string | null;
  executionResult: unknown;
  confirmationNonce?: string;
}

export interface ChatResult {
  conversationId: string;
  message: string;
  proposals: ProposalView[];
  toolResults: Array<{ name: string; result: unknown }>;
}

export interface AiLogEvent {
  msg: string;
  conversationId?: string;
  tool?: string;
  status?: number;
}

export interface AiRuntimeDeps {
  database: TenantDatabase;
  provider: LlmProvider;
  audit: AuditAppendPort;
  domain: DomainActionExecutor;
  loadTable?: () => StatutoryTable;
  log?: (event: AiLogEvent) => void;
}

export interface AiRuntime {
  chat(caller: AiCaller, input: { message: string; conversationId?: string; script?: FakeStep[] }, meta: RequestMeta): Promise<
    { ok: true; data: ChatResult } | AiFailure
  >;
  listProposals(caller: AiCaller): Promise<{ ok: true; data: ProposalView[] } | AiFailure>;
  getProposal(caller: AiCaller, proposalId: string): Promise<{ ok: true; data: ProposalView } | AiFailure>;
  confirmProposal(
    caller: AiCaller,
    proposalId: string,
    nonce: string,
    meta: RequestMeta,
  ): Promise<{ ok: true; data: ProposalView } | AiFailure>;
  rejectProposal(
    caller: AiCaller,
    proposalId: string,
    meta: RequestMeta,
  ): Promise<{ ok: true; data: ProposalView } | AiFailure>;
}

export function draftStatutoryTable(): StatutoryTable {
  return id2026DraftTable;
}

export function createAiRuntime(deps: AiRuntimeDeps): AiRuntime {
  const loadTable = deps.loadTable ?? draftStatutoryTable;
  const sessions = new Map<string, RedactionSession>();
  const log = deps.log ?? (() => undefined);

  function sessionFor(conversationId: string): RedactionSession {
    const existing = sessions.get(conversationId);
    if (existing) return existing;
    const created = new RedactionSession();
    sessions.set(conversationId, created);
    return created;
  }

  return {
    chat(caller, input, meta) {
      return chat(deps, loadTable, sessionFor, log, caller, input, meta);
    },
    listProposals(caller) {
      return deps.database.withTenantContext(caller.tenantId, async (tx) => ({
        ok: true as const,
        data: (await listOwnProposals(tx, caller.userId)).map((row) => presentProposal(row, sessionFor, caller, null)),
      }));
    },
    getProposal(caller, proposalId) {
      if (!UUID.test(proposalId)) return Promise.resolve(failure(404, "not_found", "Proposal not found."));
      return deps.database.withTenantContext(caller.tenantId, async (tx) => {
        const row = await lockProposal(tx, proposalId);
        if (!row || row.created_by_user_id !== caller.userId) {
          return failure(404, "not_found", "Proposal not found.");
        }
        return { ok: true as const, data: presentProposal(row, sessionFor, caller, null) };
      });
    },
    confirmProposal(caller, proposalId, nonce, meta) {
      return confirm(deps, sessionFor, caller, proposalId, nonce, meta);
    },
    rejectProposal(caller, proposalId, meta) {
      return reject(deps, sessionFor, caller, proposalId, meta);
    },
  };
}

async function chat(
  deps: AiRuntimeDeps,
  loadTable: () => StatutoryTable,
  sessionFor: (conversationId: string) => RedactionSession,
  log: (event: AiLogEvent) => void,
  caller: AiCaller,
  input: { message: string; conversationId?: string; script?: FakeStep[] },
  meta: RequestMeta,
): Promise<{ ok: true; data: ChatResult } | AiFailure> {
  const message = input.message.trim();
  if (message.length === 0 || message.length > MAX_MESSAGE) {
    return failure(400, "invalid_body", "Message is empty or too long.");
  }
  if (input.conversationId !== undefined && !UUID.test(input.conversationId)) {
    return failure(400, "invalid_body", "Conversation id is not a uuid.");
  }
  const conversationId = await deps.database.withTenantContext(caller.tenantId, async (tx) => {
    if (input.conversationId) {
      const owned = await conversationOwnedBy(tx, {
        conversationId: input.conversationId,
        userId: caller.userId,
      });
      if (!owned) return null;
      return input.conversationId;
    }
    return insertConversation(tx, {
      tenantId: caller.tenantId,
      userId: caller.userId,
      title: "Chat",
    });
  });
  if (!conversationId) return failure(404, "not_found", "Conversation not found.");
  const session = sessionFor(conversationId);
  const redactedUser = session.redact(message);
  await deps.database.withTenantContext(caller.tenantId, async (tx) => {
    await tx.execute(sql`
      UPDATE ai_conversations
      SET title = ${redactedUser.slice(0, 80)}, updated_at = now()
      WHERE id = ${conversationId}::uuid
    `);
    await insertMessage(tx, {
      tenantId: caller.tenantId,
      conversationId,
      role: "user",
      content: redactedUser,
      toolCalls: null,
    });
    await touchConversation(tx, conversationId);
  });

  if (deps.provider.name === "fake" && "useScript" in deps.provider) {
    const scripted = deps.provider as { useScript(steps: readonly FakeStep[]): void };
    scripted.useScript(input.script?.slice(0, 4) ?? []);
  }

  const tools = toolsForCaller(caller);
  const history = await deps.database.withTenantContext(caller.tenantId, (tx) => listMessages(tx, conversationId));
  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((row) => messageFromRow(row)),
  ];
  log({ msg: "ai chat", conversationId });

  const proposals: ProposalView[] = [];
  const toolResults: Array<{ name: string; result: unknown }> = [];
  let completion = await deps.provider.complete({ messages, tools });
  for (let round = 0; round < MAX_ROUNDS && completion.toolCalls.length > 0; round += 1) {
    const assistantContent = session.redact(completion.text);
    const storedCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
    const followUps: Array<{ callId: string; content: string }> = [];
    for (const call of completion.toolCalls) {
      const handled = await handleTool(deps, loadTable, session, caller, conversationId, call, meta);
      if (handled.proposal) proposals.push(handled.proposal);
      toolResults.push({ name: call.name, result: handled.publicResult });
      storedCalls.push({
        id: call.id,
        name: call.name,
        arguments: handled.echoArguments ? session.redactValue(call.arguments) : {},
      });
      followUps.push({
        callId: call.id,
        content: JSON.stringify(session.redactValue(handled.providerResult)),
      });
      log({ msg: "ai tool", conversationId, tool: call.name });
    }
    await deps.database.withTenantContext(caller.tenantId, async (tx) => {
      await insertMessage(tx, {
        tenantId: caller.tenantId,
        conversationId,
        role: "assistant",
        content: assistantContent,
        toolCalls: storedCalls,
      });
      for (const followUp of followUps) {
        await insertMessage(tx, {
          tenantId: caller.tenantId,
          conversationId,
          role: "tool",
          content: followUp.content,
          toolCalls: { toolCallId: followUp.callId },
        });
      }
    });
    messages.push({ role: "assistant", content: assistantContent, toolCalls: storedCalls });
    for (const followUp of followUps) {
      messages.push({ role: "tool", content: followUp.content, toolCallId: followUp.callId });
    }
    completion = await deps.provider.complete({ messages, tools });
  }

  const assistantText = session.redact(completion.text);
  await deps.database.withTenantContext(caller.tenantId, async (tx) => {
    await insertMessage(tx, {
      tenantId: caller.tenantId,
      conversationId,
      role: "assistant",
      content: assistantText,
      toolCalls: null,
    });
    await touchConversation(tx, conversationId);
  });
  return {
    ok: true,
    data: {
      conversationId,
      message: canReadPii(caller) ? session.restore(assistantText) : assistantText,
      proposals: proposals.map((proposal) =>
        canReadPii(caller)
          ? { ...proposal, impactPreview: session.restoreValue(proposal.impactPreview), arguments: session.restoreValue(proposal.arguments) }
          : proposal,
      ),
      toolResults: toolResults.map((item) => ({
        name: item.name,
        result: canReadPii(caller) ? session.restoreValue(item.result) : item.result,
      })),
    },
  };
}

async function handleTool(
  deps: AiRuntimeDeps,
  loadTable: () => StatutoryTable,
  session: RedactionSession,
  caller: AiCaller,
  conversationId: string,
  call: LlmToolCall,
  meta: RequestMeta,
): Promise<{
  publicResult: unknown;
  providerResult: unknown;
  proposal: ProposalView | null;
  echoArguments: boolean;
}> {
  const dispatched = dispatchTool(caller, call.name, call.arguments, loadTable());
  if (!dispatched.ok) {
    await writeAudit(deps, caller, meta, {
      action: "ai.tool.denied",
      resourceType: "ai_tool",
      resourceId: null,
      aiProposalId: null,
      diff: { toolName: call.name, code: dispatched.code },
    });
    const result = { error: dispatched.code };
    return { publicResult: result, providerResult: result, proposal: null, echoArguments: false };
  }
  if (!dispatched.mutating) {
    const redacted = session.redactValue(dispatched.result);
    await writeAudit(deps, caller, meta, {
      action: "ai.tool.completed",
      resourceType: "ai_tool",
      resourceId: null,
      aiProposalId: null,
      diff: { toolName: call.name, result: asJsonRecord(redacted) },
    });
    return { publicResult: redacted, providerResult: redacted, proposal: null, echoArguments: true };
  }

  const argumentsJson = asJsonRecord(session.redactValue(dispatched.arguments));
  const impactJson = asJsonRecord(session.redactValue(dispatched.impact));
  const secret = createConfirmationNonce();
  const created = await deps.database.withTenantContext(caller.tenantId, async (tx) => {
    const proposal = await insertProposal(tx, {
      tenantId: caller.tenantId,
      conversationId,
      userId: caller.userId,
      toolName: call.name,
      argumentsJson,
      impactJson,
      nonceHash: secret.hash,
    });
    await appendAudit(deps.audit, tx, caller, meta, {
      action: "ai.proposal.created",
      resourceType: "ai_action_proposal",
      resourceId: proposal.id,
      aiProposalId: proposal.id,
      diff: { toolName: call.name, status: "pending", impact: impactJson },
    });
    return proposal;
  });
  const view: ProposalView = {
    id: created.id,
    conversationId,
    toolName: call.name,
    status: "pending",
    expiresAt: created.expiresAt,
    impactPreview: impactJson,
    arguments: argumentsJson,
    executedAt: null,
    executionResult: null,
    confirmationNonce: secret.nonce,
  };
  return {
    publicResult: { proposalId: created.id, status: "pending", expiresAt: created.expiresAt },
    providerResult: { proposalId: created.id, status: "pending" },
    proposal: view,
    echoArguments: true,
  };
}

async function confirm(
  deps: AiRuntimeDeps,
  sessionFor: (conversationId: string) => RedactionSession,
  caller: AiCaller,
  proposalId: string,
  nonce: string,
  meta: RequestMeta,
): Promise<{ ok: true; data: ProposalView } | AiFailure> {
  if (!UUID.test(proposalId)) return failure(404, "not_found", "Proposal not found.");
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 200) {
    return failure(400, "invalid_nonce", "The confirmation code does not match.");
  }
  return deps.database.withTenantContext(caller.tenantId, async (tx) => {
      const row = await lockProposal(tx, proposalId);
      const nonceOk = nonceMatches(nonce, row?.confirmation_nonce ?? "");
      if (!row) return failure(404, "not_found", "Proposal not found.");
      if (row.created_by_user_id !== caller.userId) {
        return failure(403, "forbidden", "Only the person who proposed this can confirm.");
      }
      if (!nonceOk) return failure(400, "invalid_nonce", "The confirmation code does not match.");
      if (row.status !== "pending") {
        return failure(409, "conflict", "This proposal is no longer pending.");
      }
      if (!isMutatingTool(row.tool_name) || !toolStillAllowed(caller, row.tool_name, asJsonRecord(row.arguments_json))) {
        return failure(403, "forbidden", "Missing permission.");
      }
      if (await markExpired(tx, proposalId)) {
        return failure(409, "expired", "This proposal has expired.");
      }
      const claimed = await claimProposal(tx, { proposalId, userId: caller.userId });
      if (!claimed) return failure(409, "conflict", "This proposal is no longer pending.");
      const execution = await deps.domain.execute({
        tenantId: caller.tenantId,
        actorUserId: caller.userId,
        proposalId,
        toolName: row.tool_name,
        arguments: asJsonRecord(row.arguments_json),
      });
      const stored = asJsonRecord(execution);
      await saveExecution(tx, { proposalId, result: stored });
      await appendAudit(deps.audit, tx, caller, meta, {
        action: "ai.proposal.executed",
        resourceType: "ai_action_proposal",
        resourceId: proposalId,
        aiProposalId: proposalId,
        diff: { toolName: row.tool_name, status: "executed" },
      });
      const next = await lockProposal(tx, proposalId);
      if (!next) return failure(404, "not_found", "Proposal not found.");
      return { ok: true as const, data: presentProposal(next, sessionFor, caller, null) };
    });
}

async function reject(
  deps: AiRuntimeDeps,
  sessionFor: (conversationId: string) => RedactionSession,
  caller: AiCaller,
  proposalId: string,
  meta: RequestMeta,
): Promise<{ ok: true; data: ProposalView } | AiFailure> {
  if (!UUID.test(proposalId)) return failure(404, "not_found", "Proposal not found.");
  return deps.database.withTenantContext(caller.tenantId, async (tx) => {
    const row = await lockProposal(tx, proposalId);
    if (!row) return failure(404, "not_found", "Proposal not found.");
    if (row.created_by_user_id !== caller.userId) {
      return failure(403, "forbidden", "Only the person who proposed this can reject.");
    }
    if (row.status !== "pending") return failure(409, "conflict", "This proposal is no longer pending.");
    const rejected = await rejectPending(tx, { proposalId, userId: caller.userId });
    if (!rejected) return failure(409, "conflict", "This proposal is no longer pending.");
    await appendAudit(deps.audit, tx, caller, meta, {
      action: "ai.proposal.rejected",
      resourceType: "ai_action_proposal",
      resourceId: proposalId,
      aiProposalId: proposalId,
      diff: { toolName: row.tool_name, status: "rejected" },
    });
    const next = await lockProposal(tx, proposalId);
    if (!next) return failure(404, "not_found", "Proposal not found.");
    return { ok: true as const, data: presentProposal(next, sessionFor, caller, null) };
  });
}

function toolStillAllowed(caller: AiCaller, toolName: string, args: unknown): boolean {
  if (toolName === "propose_employee_change") {
    return dispatchTool(caller, toolName, args, id2026DraftTable).ok;
  }
  return false;
}

function presentProposal(
  row: ProposalRow,
  sessionFor: (conversationId: string) => RedactionSession,
  caller: AiCaller,
  nonce: string | null,
): ProposalView {
  const session = row.conversation_id ? sessionFor(row.conversation_id) : null;
  const impact = asJsonRecord(row.impact_preview_json);
  const args = asJsonRecord(row.arguments_json);
  const result = row.execution_result_json === null ? null : asJsonRecord(row.execution_result_json);
  const reveal = canReadPii(caller) ? session : null;
  const view: ProposalView = {
    id: row.id,
    conversationId: row.conversation_id,
    toolName: row.tool_name,
    status: row.status,
    expiresAt: iso(row.expires_at),
    impactPreview: reveal ? reveal.restoreValue(impact) : impact,
    arguments: reveal ? reveal.restoreValue(args) : args,
    executedAt: row.executed_at ? iso(row.executed_at) : null,
    executionResult: reveal && result ? reveal.restoreValue(result) : result,
  };
  if (nonce) view.confirmationNonce = nonce;
  return view;
}

function canReadPii(caller: AiCaller): boolean {
  if (!caller.permissions.includes("employee.pii.read")) return false;
  if (isPrivilegedRole(caller.role) && permissionRequiresPrivilegedTotp("employee.pii.read")) {
    return caller.sessionTotpVerified;
  }
  return true;
}

function messageFromRow(row: { role: string; content_redacted: string; tool_calls_json: unknown }): LlmMessage {
  if (row.role === "assistant") {
    const toolCalls = Array.isArray(row.tool_calls_json) ? (row.tool_calls_json as LlmMessage["toolCalls"]) : undefined;
    return toolCalls
      ? { role: "assistant", content: row.content_redacted, toolCalls }
      : { role: "assistant", content: row.content_redacted };
  }
  if (row.role === "tool") {
    const stored = asJsonRecord(row.tool_calls_json);
    const toolCallId = typeof stored.toolCallId === "string" ? stored.toolCallId : undefined;
    return toolCallId
      ? { role: "tool", content: row.content_redacted, toolCallId }
      : { role: "tool", content: row.content_redacted };
  }
  if (row.role === "system") return { role: "system", content: row.content_redacted };
  return { role: "user", content: row.content_redacted };
}

async function writeAudit(
  deps: AiRuntimeDeps,
  caller: AiCaller,
  meta: RequestMeta,
  event: Omit<AuditEventDraft, "tenantId" | "actorUserId" | "actorRole" | "ipAddress" | "userAgent">,
): Promise<void> {
  await deps.database.withTenantContext(caller.tenantId, (tx) => appendAudit(deps.audit, tx, caller, meta, event));
}

async function appendAudit(
  audit: AuditAppendPort,
  tx: TenantTx,
  caller: AiCaller,
  meta: RequestMeta,
  event: Omit<AuditEventDraft, "tenantId" | "actorUserId" | "actorRole" | "ipAddress" | "userAgent">,
): Promise<void> {
  await audit.append(tx, {
    tenantId: caller.tenantId,
    actorUserId: caller.userId,
    actorRole: caller.role,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    ...event,
  });
}

function failure(status: AiFailure["status"], code: string, message: string): AiFailure {
  return { ok: false, status, code, message };
}
