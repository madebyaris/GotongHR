const FORMULA_START = new Set(["=", "+", "-", "@"]);

/**
 * Removes delimiters and new lines, then prefixes a spreadsheet formula trigger.
 * The result can sit in a comma-separated field without quoting.
 */
export function sanitizeBankText(value: string, maxLength: number): string {
  if (typeof value !== "string" || maxLength < 1) return "";
  let cleaned = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127 || char === "," || char === ";" || char === "|" || char === '"') {
      cleaned += " ";
      continue;
    }
    cleaned += char;
  }
  const collapsed = cleaned.replace(/ {2,}/g, " ").trim();
  if (collapsed.length === 0) return "";
  const first = collapsed[0] ?? "";
  const guarded = FORMULA_START.has(first) ? `'${collapsed}` : collapsed;
  return [...guarded].slice(0, maxLength).join("");
}

/** Keeps digits. Spaces and hyphens are removed. Any other character rejects the account. */
export function sanitizeAccountNumber(value: string): string | null {
  if (typeof value !== "string") return null;
  let result = "";
  for (const char of value) {
    if (char === " " || char === "-") continue;
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) return null;
    result += char;
  }
  if (result.length < 8 || result.length > 18) return null;
  return result;
}

export function sanitizeEmail(value: string | undefined): string {
  if (value === undefined) return "";
  const cleaned = sanitizeBankText(value, 64);
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(cleaned)) return "";
  return cleaned;
}

/** Three digits, or empty when the caller omitted a code. Null means the code is present and unusable. */
export function sanitizeBankCode(value: string | undefined): string | null {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length === 0) return null;
  if (!/^[0-9]{3}$/.test(value)) return null;
  return value;
}
