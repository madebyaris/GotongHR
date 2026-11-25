export function queryRows<T>(result: unknown): T[] {
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  if (Array.isArray(result)) return result as T[];
  return [];
}

export function asJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value) as unknown;
  return value;
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
}

export function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
