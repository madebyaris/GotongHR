const PII_KEYS = new Set([
  "nik",
  "nikenc",
  "nikhash",
  "npwp",
  "npwp16",
  "npwpenc",
  "npwphash",
  "kknumber",
  "kknumberenc",
  "kknumberhash",
  "bpjskesehatanno",
  "bpjskesehatanenc",
  "bpjskesehatannoenc",
  "bpjskesehatannohash",
  "bpjskesno",
  "bpjskesenc",
  "bpjstkno",
  "bpjstkenc",
  "bpjstknoenc",
  "bpjstknohash",
  "bankaccount",
  "bankaccountnumber",
  "bankaccountno",
  "bankaccountenc",
  "bankaccountnumberenc",
  "bankaccounthash",
  "bankaccountnumberhash",
]);

function normalizeKey(key: string): string {
  return key.replace(/[_-]/gu, "").toLowerCase();
}

export function isPiiKey(key: string): boolean {
  return PII_KEYS.has(normalizeKey(key));
}

/**
 * Replaces PII field values with `[redacted]`, including nested objects.
 * `toJSON` runs first, then the result is redacted, so a method cannot hide plaintext.
 * Dates become ISO strings. Functions are dropped. `__proto__` stays an own key.
 * A shared object is visited again at each use. A cycle still throws.
 */
export function redactPii(value: unknown): unknown {
  return redactNormalized(normalizeJsonValue(value, new WeakSet()));
}

function normalizeJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "bigint") throw new Error("audit value cannot include bigint");
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error("audit value cannot include a cycle");
  seen.add(value);
  try {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") {
      return normalizeJsonValue(toJson.call(value), seen);
    }
    if (Array.isArray(value)) {
      return value.map((item) => normalizeJsonValue(item, seen));
    }
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys(value)) {
      const child = (value as Record<string, unknown>)[key];
      if (typeof child === "function") continue;
      defineOwn(out, key, normalizeJsonValue(child, seen));
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function redactNormalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactNormalized(item));
  if (!value || typeof value !== "object") return value;
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys(value)) {
    const child = (value as Record<string, unknown>)[key];
    defineOwn(out, key, isPiiKey(key) ? "[redacted]" : redactNormalized(child));
  }
  return out;
}

function ownKeys(value: object): string[] {
  return Object.getOwnPropertyNames(value).filter((key) => {
    return Object.getOwnPropertyDescriptor(value, key)?.enumerable === true;
  });
}

const FREE_TEXT_PII = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu,
  /\d{2}[.\s]\d{3}[.\s]\d{3}[.\s]\d[-]\d{3}[.\s]\d{3,4}/gu,
  /(?:\+62|62)[\s.-]?8\d{2,3}(?:[\s.-]?\d{3,4}){2,3}/gu,
  /\b08\d{8,11}\b/gu,
  /\+[1-9]\d{7,14}\b/gu,
  /\b\d{10,}\b/gu,
];

/**
 * Key redaction, then any NIK, NPWP, bank, phone, or email still sitting in a string.
 * Append-only AI events use this. `redactPii` itself stays key-based.
 */
export function scrubFreeTextPii(value: unknown): unknown {
  return maskWalk(redactPii(value));
}

function maskWalk(value: unknown): unknown {
  if (typeof value === "string") return maskText(value);
  if (Array.isArray(value)) return value.map((item) => maskWalk(item));
  if (!value || typeof value !== "object") return value;
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    defineOwn(out, key, maskWalk((value as Record<string, unknown>)[key]));
  }
  return out;
}

const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

function maskText(text: string): string {
  const uuids: string[] = [];
  UUID_TEXT.lastIndex = 0;
  const parked = text.replace(UUID_TEXT, (match) => {
    const token = `«u${uuids.length}»`;
    uuids.push(match);
    return token;
  });
  let out = parked;
  for (const pattern of FREE_TEXT_PII) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[redacted]");
  }
  return out.replace(/«u(\d+)»/gu, (_match, index: string) => uuids[Number(index)] ?? "");
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
