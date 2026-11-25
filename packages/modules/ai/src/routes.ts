import { fail, ok } from "@gotonghr/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { AiCaller, RequestMeta } from "./caller.ts";
import type { FakeStep } from "./provider.ts";
import { scrubSecrets } from "./redact.ts";
import type { AiRuntime, ChatStreamEvent } from "./service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface AiRouteDeps {
  runtime: AiRuntime;
  guard: preHandlerHookHandler;
  readCaller(request: FastifyRequest): AiCaller | null;
}

export async function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): Promise<void> {
  app.post("/api/v1/ai/chat", { preHandler: deps.guard }, async (request, reply) => {
    const caller = requireCaller(deps, request, reply);
    if (!caller) return;
    const body = asRecord(request.body);
    if (!body || typeof body.message !== "string") {
      return reply.code(400).send(fail("invalid_body", "Message is required."));
    }
    const script = readScript(body.fakeScript);
    if (script === "invalid") return reply.code(400).send(fail("invalid_body", "Script is invalid."));
    if (body.conversationId !== undefined && typeof body.conversationId !== "string") {
      return reply.code(400).send(fail("invalid_body", "Conversation id is not a uuid."));
    }
    if (body.stream !== undefined && typeof body.stream !== "boolean") {
      return reply.code(400).send(fail("invalid_body", "Stream is invalid."));
    }
    if (wantsStream(request, body)) {
      await writeChatStream(request, reply, deps, caller, {
        message: body.message,
        ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
        ...(script ? { script } : {}),
      });
      return;
    }
    try {
      const result = await deps.runtime.chat(
        caller,
        {
          message: body.message,
          ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
          ...(script ? { script } : {}),
        },
        requestMeta(request),
      );
      if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
      return reply.send(ok(result.data));
    } catch {
      return failed(request, reply);
    }
  });

  app.get("/api/v1/ai/conversations/latest", { preHandler: deps.guard }, async (request, reply) => {
    const caller = requireCaller(deps, request, reply);
    if (!caller) return;
    try {
      const result = await deps.runtime.readLatest(caller);
      if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
      return reply.send(ok(result.data));
    } catch {
      return failed(request, reply);
    }
  });

  app.get("/api/v1/ai/proposals", { preHandler: deps.guard }, async (request, reply) => {
    const caller = requireCaller(deps, request, reply);
    if (!caller) return;
    try {
      const result = await deps.runtime.listProposals(caller);
      if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
      return reply.send(ok(result.data));
    } catch {
      return failed(request, reply);
    }
  });

  app.get("/api/v1/ai/proposals/:id", { preHandler: deps.guard }, async (request, reply) => {
    const caller = requireCaller(deps, request, reply);
    if (!caller) return;
    const id = routeId(request);
    if (!id) return reply.code(404).send(fail("not_found", "Proposal not found."));
    try {
      const result = await deps.runtime.getProposal(caller, id);
      if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
      return reply.send(ok(result.data));
    } catch {
      return failed(request, reply);
    }
  });

  app.post("/api/v1/ai/proposals/:id/confirm", { preHandler: deps.guard }, async (request, reply) => {
    const caller = requireCaller(deps, request, reply);
    if (!caller) return;
    const id = routeId(request);
    if (!id) return reply.code(404).send(fail("not_found", "Proposal not found."));
    const body = asRecord(request.body);
    const nonce = confirmationNonce(body);
    try {
      const result = await deps.runtime.confirmProposal(caller, id, nonce, requestMeta(request));
      if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
      return reply.send(ok(result.data));
    } catch {
      return failed(request, reply);
    }
  });

  app.get("/api/v1/ai/knowledge/sops", { preHandler: deps.guard }, async (request, reply) => {
    const caller = requireCaller(deps, request, reply);
    if (!caller) return;
    try {
      const result = await deps.runtime.listSops(caller);
      if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
      return reply.send(ok(result.data));
    } catch {
      return failed(request, reply);
    }
  });

  app.post("/api/v1/ai/knowledge/sops", { preHandler: deps.guard }, async (request, reply) => {
    const caller = requireCaller(deps, request, reply);
    if (!caller) return;
    const body = asRecord(request.body);
    if (!body || typeof body.title !== "string") {
      return reply.code(400).send(fail("invalid_body", "Title is required."));
    }
    if (body.text !== undefined && typeof body.text !== "string") {
      return reply.code(400).send(fail("invalid_body", "Send plain text or a PDF."));
    }
    if (body.pdfBase64 !== undefined && typeof body.pdfBase64 !== "string") {
      return reply.code(400).send(fail("invalid_body", "Send plain text or a PDF."));
    }
    try {
      const result = await deps.runtime.ingestSop(
        caller,
        {
          title: body.title,
          ...(typeof body.text === "string" ? { text: body.text } : {}),
          ...(typeof body.pdfBase64 === "string" ? { pdfBase64: body.pdfBase64 } : {}),
        },
        requestMeta(request),
      );
      if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
      return reply.send(ok(result.data));
    } catch {
      return failed(request, reply);
    }
  });

  app.delete("/api/v1/ai/knowledge/sops/:id", { preHandler: deps.guard }, async (request, reply) => {
    const caller = requireCaller(deps, request, reply);
    if (!caller) return;
    const id = routeId(request);
    if (!id) return reply.code(404).send(fail("not_found", "SOP not found."));
    try {
      const result = await deps.runtime.deleteSop(caller, id, requestMeta(request));
      if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
      return reply.send(ok(result.data));
    } catch {
      return failed(request, reply);
    }
  });

  app.post("/api/v1/ai/proposals/:id/reject", { preHandler: deps.guard }, async (request, reply) => {
    const caller = requireCaller(deps, request, reply);
    if (!caller) return;
    const id = routeId(request);
    if (!id) return reply.code(404).send(fail("not_found", "Proposal not found."));
    try {
      const result = await deps.runtime.rejectProposal(caller, id, requestMeta(request));
      if (!result.ok) return reply.code(result.status).send(fail(result.code, result.message));
      return reply.send(ok(result.data));
    } catch {
      return failed(request, reply);
    }
  });
}

function requireCaller(deps: AiRouteDeps, request: FastifyRequest, reply: FastifyReply): AiCaller | null {
  const caller = deps.readCaller(request);
  if (caller) return caller;
  void reply.code(401).send(fail("unauthenticated", "Sign in required."));
  return null;
}

function failed(request: FastifyRequest, reply: FastifyReply) {
  request.log.error({ msg: "ai request failed" });
  return reply.code(500).send(fail("internal_error", "Request failed."));
}

function requestMeta(request: FastifyRequest): RequestMeta {
  const agent = request.headers["user-agent"];
  return {
    ipAddress: request.ip ? request.ip.slice(0, 64) : null,
    userAgent: typeof agent === "string" ? agent.slice(0, 512) : null,
  };
}

function routeId(request: FastifyRequest): string | null {
  const params = request.params as { id?: unknown };
  return typeof params.id === "string" && UUID.test(params.id) ? params.id : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function wantsStream(request: FastifyRequest, body: Record<string, unknown>): boolean {
  if (body.stream === true) return true;
  const accept = request.headers.accept;
  if (typeof accept !== "string") return false;
  return accept.split(",").some((part) => part.split(";")[0]?.trim() === "text/event-stream");
}

function confirmationNonce(body: Record<string, unknown> | null): string {
  if (!body) return "";
  if (typeof body.confirmationNonce === "string") return body.confirmationNonce;
  if (typeof body.confirmation_nonce === "string") return body.confirmation_nonce;
  return "";
}

async function writeChatStream(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AiRouteDeps,
  caller: AiCaller,
  input: { message: string; conversationId?: string; script?: FakeStep[] },
): Promise<void> {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
  };
  request.raw.on("aborted", onAbort);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  try {
    for await (const event of deps.runtime.chatStream(caller, input, requestMeta(request), controller.signal)) {
      if (controller.signal.aborted || reply.raw.writableEnded || reply.raw.destroyed) break;
      if (!writeEvent(reply, event)) break;
    }
  } catch {
    request.log.error({ msg: "ai request failed" });
    writeEvent(reply, { type: "error", code: "internal_error", message: "Request failed." });
  } finally {
    request.raw.off("aborted", onAbort);
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}

function writeEvent(reply: FastifyReply, event: ChatStreamEvent): boolean {
  if (reply.raw.writableEnded || reply.raw.destroyed) return false;
  const safe = scrubSecrets(event);
  return reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(safe)}\n\n`);
}

function readScript(value: unknown): FakeStep[] | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4) return "invalid";
  const steps: FakeStep[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) return "invalid";
    const text = record.text;
    const toolCalls = record.toolCalls;
    if (text !== undefined && typeof text !== "string") return "invalid";
    if (toolCalls !== undefined && !Array.isArray(toolCalls)) return "invalid";
    const parsed: FakeStep = {};
    if (typeof text === "string") parsed.text = text;
    if (Array.isArray(toolCalls)) {
      const calls: Array<{ name: string; arguments?: unknown }> = [];
      for (const call of toolCalls) {
        const item = asRecord(call);
        if (!item || typeof item.name !== "string" || item.name.length === 0 || item.name.length > 80) {
          return "invalid";
        }
        if (item.arguments === undefined) calls.push({ name: item.name });
        else calls.push({ name: item.name, arguments: item.arguments });
      }
      parsed.toolCalls = calls;
    }
    steps.push(parsed);
  }
  return steps;
}
