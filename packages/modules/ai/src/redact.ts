export type PiiKind = "nik" | "npwp" | "bank" | "phone" | "email";

const KIND_LABEL: Record<PiiKind, string> = {
  nik: "NIK",
  npwp: "NPWP",
  bank: "BANK",
  phone: "PHONE",
  email: "EMAIL",
};

interface Span {
  start: number;
  end: number;
  kind: PiiKind;
  value: string;
  priority: number;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const NPWP_FORMATTED = /\d{2}[.\s]\d{3}[.\s]\d{3}[.\s]\d[-]\d{3}[.\s]\d{3,4}/gu;
const PHONE =
  /(?:\+62|62)[\s.-]?8\d{2,3}(?:[\s.-]?\d{3,4}){2,3}|\b08\d{8,11}\b|\+[1-9]\d{7,14}\b/gu;
const LABELED_NIK = /\bNIK\b\s*[:#-]?\s*(\d{16})\b/giu;
const LABELED_NPWP = /\bNPWP\b\s*[:#-]?\s*(\d{15,16})\b/giu;
const LABELED_BANK =
  /\b(?:rekening|no\.?\s*rekening|bank(?:\s+account)?|account(?:\s+number)?)\b\s*[:#-]?\s*(\d{8,16})\b/giu;
const BARE_16 = /\b\d{16}\b/gu;
const BARE_15 = /\b\d{15}\b/gu;
const BARE_LONG = /\b\d{10,}\b/gu;

/**
 * Server-side token map. It is not written to messages, proposals, audit rows, or logs.
 * The same raw value keeps the same token for the life of this object.
 */
export class RedactionSession {
  private readonly tokens = new Map<string, string>();
  private readonly byValue = new Map<string, string>();
  private readonly counts: Record<PiiKind, number> = {
    nik: 0,
    npwp: 0,
    bank: 0,
    phone: 0,
    email: 0,
  };

  redact(text: string): string {
    const spans = selectSpans(findSpans(text));
    let out = text;
    for (const span of [...spans].reverse()) {
      const token = this.tokenFor(span.kind, span.value);
      out = `${out.slice(0, span.start)}${token}${out.slice(span.end)}`;
    }
    return out;
  }

  redactValue(value: unknown): unknown {
    return mapStrings(value, (text) => this.redact(text));
  }

  /** Puts the original text back. Callers without employee.pii.read must not use this. */
  restore(text: string): string {
    let out = text;
    const entries = [...this.tokens.entries()].sort((left, right) => right[0].length - left[0].length);
    for (const [token, secret] of entries) {
      out = out.split(token).join(secret);
    }
    return out;
  }

  restoreValue(value: unknown): unknown {
    return mapStrings(value, (text) => this.restore(text));
  }

  private tokenFor(kind: PiiKind, value: string): string {
    const key = `${kind}\n${value}`;
    const existing = this.byValue.get(key);
    if (existing) return existing;
    this.counts[kind] += 1;
    const token = `[EMP_${String(this.counts[kind]).padStart(2, "0")}_${KIND_LABEL[kind]}]`;
    this.byValue.set(key, token);
    this.tokens.set(token, value);
    return token;
  }
}

function mapStrings(value: unknown, visit: (text: string) => string): unknown {
  if (typeof value === "string") return visit(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, visit));
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = mapStrings(child, visit);
  }
  return out;
}

function findSpans(text: string): Span[] {
  const spans: Span[] = [];
  collect(text, EMAIL, "email", 1, spans, false);
  collect(text, NPWP_FORMATTED, "npwp", 2, spans, false);
  collect(text, LABELED_NIK, "nik", 3, spans, true);
  collect(text, LABELED_NPWP, "npwp", 3, spans, true);
  collect(text, LABELED_BANK, "bank", 3, spans, true);
  collect(text, PHONE, "phone", 4, spans, false);
  collect(text, BARE_16, "nik", 5, spans, false);
  collect(text, BARE_15, "npwp", 6, spans, false);
  collect(text, BARE_LONG, "bank", 7, spans, false);
  return spans.filter((span) => {
    if (insideUuid(text, span.start, span.end)) return false;
    if (span.kind === "bank" && looksLikeMoney(text, span.start)) return false;
    return true;
  });
}

function collect(
  text: string,
  pattern: RegExp,
  kind: PiiKind,
  priority: number,
  spans: Span[],
  labeled: boolean,
): void {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const raw = labeled ? match[1] : match[0];
    if (!raw || match.index === undefined) continue;
    const start = labeled ? match.index + match[0].lastIndexOf(raw) : match.index;
    spans.push({ start, end: start + raw.length, kind, value: raw, priority });
  }
}

function selectSpans(spans: readonly Span[]): Span[] {
  const ordered = [...spans].sort(
    (left, right) => left.priority - right.priority || left.start - right.start,
  );
  const kept: Span[] = [];
  for (const span of ordered) {
    if (span.end <= span.start) continue;
    if (kept.some((item) => span.start < item.end && span.end > item.start)) continue;
    kept.push(span);
  }
  kept.sort((left, right) => left.start - right.start);
  return kept;
}

const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

function insideUuid(text: string, start: number, end: number): boolean {
  UUID_TEXT.lastIndex = 0;
  for (const match of text.matchAll(UUID_TEXT)) {
    if (match.index === undefined) continue;
    const matchEnd = match.index + match[0].length;
    if (start >= match.index && end <= matchEnd) return true;
  }
  return false;
}

function looksLikeMoney(text: string, start: number): boolean {
  const prefix = text.slice(Math.max(0, start - 16), start).toLowerCase();
  return /(?:rp|idr|rupiah)\s*$/u.test(prefix);
}

const HOLDBACK = 64;
const PARTIAL_SECRET = /(?:\d+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]*|\+?\d[\d\s.-]*)$/u;

/**
 * Holds back the tail of a provider chunk so a NIK split across reads
 * is redacted before it is shown. `flush` releases the tail at a boundary.
 */
export function createStreamGate(): { push(chunk: string): string; flush(): string } {
  let pending = "";
  return {
    push(chunk: string): string {
      pending += chunk;
      const cut = safeCut(pending);
      if (cut <= 0) return "";
      const ready = pending.slice(0, cut);
      pending = pending.slice(cut);
      return ready;
    },
    flush(): string {
      const ready = pending;
      pending = "";
      return ready;
    },
  };
}

function safeCut(text: string): number {
  if (text.length <= HOLDBACK) return 0;
  let cut = text.length - HOLDBACK;
  const head = text.slice(0, cut);
  const partial = PARTIAL_SECRET.exec(head);
  if (partial && typeof partial.index === "number") cut = partial.index;
  return cut;
}

const PRESERVE_KEYS = new Set(["confirmationNonce", "confirmation_nonce"]);

/** Redacts strings in a payload. Nonce fields are copied through unchanged. */
export function scrubSecrets(value: unknown): unknown {
  return scrubSecretsWith(value, new RedactionSession(), undefined);
}

function scrubSecretsWith(value: unknown, session: RedactionSession, key: string | undefined): unknown {
  if (key && PRESERVE_KEYS.has(key)) return value;
  if (typeof value === "string") return session.redact(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => scrubSecretsWith(item, session, undefined));
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value)) {
    out[childKey] = scrubSecretsWith(child, session, childKey);
  }
  return out;
}
