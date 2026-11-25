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
  "bpjstknowhash",
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

/** Replaces PII field values with `[redacted]`, including nested objects. */
export function redactPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactPii(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isPiiKey(key) ? "[redacted]" : redactPii(child);
  }
  return out;
}
