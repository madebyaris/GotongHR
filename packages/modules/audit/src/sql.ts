const IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;

export function assertIdentifier(value: string): void {
  if (!IDENTIFIER.test(value) || Buffer.byteLength(value, "utf8") > 63) {
    throw new Error(`invalid identifier: ${value}`);
  }
}

export function quoteIdentifier(value: string): string {
  assertIdentifier(value);
  return `"${value}"`;
}

export function queryRows<T>(result: unknown): T[] {
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  if (Array.isArray(result)) return result as T[];
  return [];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function assertUuid(value: string, label: string): string {
  if (!UUID.test(value)) {
    throw new Error(`${label} must be a uuid`);
  }
  return value.toLowerCase();
}
