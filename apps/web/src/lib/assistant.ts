import { formatIdr } from "@gotonghr/ui";

export interface ImpactAmount {
  unit?: string;
  label?: string;
  amount?: string;
}

export interface ImpactDiff {
  label?: string;
  before?: string | null;
  after?: string | null;
}

export interface ImpactPreview {
  summary?: string;
  warnings?: string[];
  diff?: ImpactDiff[];
  amounts?: ImpactAmount[];
}

export interface AssistantProposal {
  id: string;
  toolName: string;
  status: string;
  expiresAt: string;
  impactPreview: ImpactPreview;
  requiresTotp: boolean;
  confirmationNonce?: string;
  executionResult: { applied?: boolean } | null;
}

export interface ThreadMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationThread {
  conversationId: string | null;
  messages: ThreadMessage[];
  proposals: AssistantProposal[];
}

export type AssistantEvent =
  | { type: "token"; text: string }
  | { type: "tool"; name: string; result: unknown }
  | { type: "proposal"; proposal: AssistantProposal }
  | { type: "done"; conversationId: string; message: string }
  | { type: "error"; code: string; message: string };

const REDACTION_TOKEN = /\[EMP_\d{2}_(?:NIK|NPWP|BANK|PHONE|EMAIL)\]/gu;
const NIK = /\b\d{16}\b/gu;
const NPWP_PLAIN = /\b\d{15}\b/gu;
const NPWP = /\d{2}[.\s]\d{3}[.\s]\d{3}[.\s]\d[-]\d{3}[.\s]\d{3,4}/gu;
const BANK = /(?<![\da-f-])\b\d{10,14}\b(?![\da-f-])/giu;

/** Hides government ids and account numbers before they reach the screen. */
export function maskSensitiveText(text: string): string {
  return text
    .replace(REDACTION_TOKEN, "[hidden]")
    .replace(NPWP, "[hidden]")
    .replace(NIK, "[hidden]")
    .replace(NPWP_PLAIN, "[hidden]")
    .replace(BANK, "[hidden]");
}

export function impactSummary(impact: ImpactPreview, toolName: string): string {
  if (typeof impact.summary === "string" && impact.summary.trim().length > 0) return impact.summary;
  if (toolName === "propose_payroll_finalize") return "Finalize payroll.";
  return "Confirm this change.";
}

export function impactWarnings(impact: ImpactPreview): string[] {
  if (!Array.isArray(impact.warnings)) return [];
  return impact.warnings.filter((warning): warning is string => typeof warning === "string" && warning.length > 0);
}

export function impactDiff(impact: ImpactPreview): Array<{ label: string; before: string; after: string }> {
  if (!Array.isArray(impact.diff)) return [];
  return impact.diff.flatMap((row) => {
    const label = typeof row.label === "string" && row.label.length > 0 ? row.label : "Field";
    return [{ label, before: displayValue(row.before), after: displayValue(row.after) }];
  });
}

export function impactLines(impact: ImpactPreview): string[] {
  if (!Array.isArray(impact.amounts) || impact.amounts.length === 0) return ["No rupiah or day change."];
  return impact.amounts.map((amount) => formatAmount(amount));
}

export function formatAmount(amount: ImpactAmount): string {
  const label = typeof amount.label === "string" && amount.label.length > 0 ? amount.label : "Impact";
  const raw = typeof amount.amount === "string" ? amount.amount : "";
  if (amount.unit === "idr" && /^(0|[1-9]\d*)$/u.test(raw)) {
    return `${label}: ${formatIdr(BigInt(raw))}`;
  }
  if (amount.unit === "days" && /^-?(0|[1-9]\d*)$/u.test(raw)) {
    const days = Number(raw);
    const noun = Math.abs(days) === 1 ? "day" : "days";
    return `${label}: ${raw} ${noun}`;
  }
  return `${label}: unavailable`;
}

function displayValue(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim().length === 0) return "—";
  return maskSensitiveText(value);
}

export async function streamAssistant(
  body: { message: string; conversationId?: string },
  onEvent: (event: AssistantEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/v1/ai/chat", {
    method: "POST",
    credentials: "include",
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!response.ok || !response.body) {
    let message = "The assistant could not reply.";
    try {
      const parsed = (await response.json()) as { error?: { message?: string } | null };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      message = "The assistant could not reply.";
    }
    onEvent({ type: "error", code: "request_failed", message });
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminal = false;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseEvent(block);
        if (!event) continue;
        if (event.type === "done" || event.type === "error") sawTerminal = true;
        onEvent(event);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!sawTerminal && !signal.aborted) {
    onEvent({ type: "error", code: "incomplete", message: "The reply stopped." });
  }
}

function parseEvent(block: string): AssistantEvent | null {
  let name = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : name;
  if (type === "token" && typeof record.text === "string") return { type: "token", text: record.text };
  if (type === "tool" && typeof record.name === "string") return { type: "tool", name: record.name, result: record.result };
  if (type === "proposal" && record.proposal && typeof record.proposal === "object") {
    return { type: "proposal", proposal: record.proposal as AssistantProposal };
  }
  if (type === "done" && typeof record.conversationId === "string" && typeof record.message === "string") {
    return { type: "done", conversationId: record.conversationId, message: record.message };
  }
  if (type === "error" && typeof record.message === "string") {
    return { type: "error", code: typeof record.code === "string" ? record.code : "request_failed", message: record.message };
  }
  return null;
}
