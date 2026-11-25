export interface LlmToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
}

export interface LlmCompletion {
  text: string;
  toolCalls: LlmToolCall[];
}

export type LlmStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: LlmToolCall }
  | { type: "done" };

export interface LlmProvider {
  readonly name: "fake" | "xai";
  complete(request: LlmRequest): Promise<LlmCompletion>;
  stream(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
}

export interface FakeStep {
  text?: string;
  toolCalls?: ReadonlyArray<{ name: string; arguments?: unknown }>;
}

export function createLlmProvider(env: NodeJS.ProcessEnv): LlmProvider {
  const name = (env.LLM_PROVIDER ?? "fake").trim();
  if (name === "" || name === "fake") return createFakeProvider();
  if (name === "xai") return createXaiProvider(env);
  throw new Error("LLM_PROVIDER must be fake or xai.");
}

export interface FakeProvider extends LlmProvider {
  readonly name: "fake";
  readonly requests: LlmRequest[];
  useScript(steps: readonly FakeStep[]): void;
}

export function createFakeProvider(): FakeProvider {
  const requests: LlmRequest[] = [];
  let script: FakeStep[] = [];
  let callSeq = 0;

  function record(request: LlmRequest): LlmCompletion {
    requests.push(cloneRequest(request));
    const step = script.shift() ?? {};
    callSeq += 1;
    const toolCalls = (step.toolCalls ?? []).map((call, index) => ({
      id: `call_${callSeq}_${index + 1}`,
      name: call.name,
      arguments: call.arguments ?? {},
    }));
    return { text: step.text ?? "", toolCalls };
  }

  return {
    name: "fake",
    requests,
    useScript(steps) {
      script = steps.map((step) => ({
        ...(step.text !== undefined ? { text: step.text } : {}),
        ...(step.toolCalls !== undefined ? { toolCalls: step.toolCalls.map((call) => ({ ...call })) } : {}),
      }));
    },
    async complete(request) {
      return record(request);
    },
    async *stream(request) {
      const completion = record(request);
      if (completion.text) yield { type: "text", text: completion.text };
      for (const toolCall of completion.toolCalls) yield { type: "tool_call", toolCall };
      yield { type: "done" };
    },
  };
}

function cloneRequest(request: LlmRequest): LlmRequest {
  return JSON.parse(JSON.stringify(request)) as LlmRequest;
}

interface XaiChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  delta?: {
    content?: string;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
}

export function createXaiProvider(env: NodeJS.ProcessEnv): LlmProvider {
  const apiKey = env.XAI_API_KEY?.trim() ?? "";
  const model = env.LLM_MODEL?.trim() || "grok-4";
  const endpoint = "https://api.x.ai/v1/chat/completions";

  async function post(request: LlmRequest, stream: boolean): Promise<Response> {
    if (!apiKey) throw new Error("XAI_API_KEY is not set.");
    return fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(xaiBody(model, request, stream)),
    });
  }

  return {
    name: "xai",
    async complete(request) {
      const response = await post(request, false);
      if (!response.ok) throw new Error(`xAI request failed with status ${response.status}.`);
      const body = (await response.json()) as { choices?: XaiChoice[] };
      return completionFromChoice(body.choices?.[0]);
    },
    async *stream(request) {
      const response = await post(request, true);
      if (!response.ok) throw new Error(`xAI request failed with status ${response.status}.`);
      if (!response.body) throw new Error("xAI stream was empty.");
      yield* readXaiStream(response.body);
    },
  };
}

export function xaiBody(model: string, request: LlmRequest, stream: boolean): Record<string, unknown> {
  return {
    model,
    stream,
    messages: request.messages.map((message) => {
      const base: Record<string, unknown> = { role: message.role, content: message.content };
      if (message.toolCallId) base.tool_call_id = message.toolCallId;
      if (message.toolCalls && message.toolCalls.length > 0) {
        base.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        }));
      }
      return base;
    }),
    tools: request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
  };
}

function completionFromChoice(choice: XaiChoice | undefined): LlmCompletion {
  const message = choice?.message;
  const toolCalls = (message?.tool_calls ?? []).flatMap((call, index) => {
    const name = call.function?.name;
    if (!name) return [];
    return [
      {
        id: call.id ?? `call_${index + 1}`,
        name,
        arguments: parseArguments(call.function?.arguments),
      },
    ];
  });
  return { text: message?.content ?? "", toolCalls };
}

function parseArguments(value: string | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

export async function* readXaiStream(body: ReadableStream<Uint8Array>): AsyncIterable<LlmStreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  const partial = new Map<number, { id: string; name: string; arguments: string }>();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = consumeSseLine(line, partial);
        if (event) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
  yield { type: "done" };
}

function consumeSseLine(
  line: string,
  partial: Map<number, { id: string; name: string; arguments: string }>,
): LlmStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return null;
  let parsed: { choices?: XaiChoice[] };
  try {
    parsed = JSON.parse(data) as { choices?: XaiChoice[] };
  } catch {
    return null;
  }
  const delta = parsed.choices?.[0]?.delta;
  if (!delta) return null;
  if (delta.content) return { type: "text", text: delta.content };
  const piece = delta.tool_calls?.[0];
  if (!piece) return null;
  const index = piece.index ?? 0;
  const current = partial.get(index) ?? { id: "", name: "", arguments: "" };
  if (piece.id) current.id = piece.id;
  if (piece.function?.name) current.name = piece.function.name;
  if (piece.function?.arguments) current.arguments += piece.function.arguments;
  partial.set(index, current);
  if (!current.name || !current.arguments.endsWith("}")) return null;
  partial.delete(index);
  return {
    type: "tool_call",
    toolCall: {
      id: current.id || `call_${index + 1}`,
      name: current.name,
      arguments: parseArguments(current.arguments),
    },
  };
}
