const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const importKey = /^t\/([0-9a-f-]{36})\/import\/([0-9a-f-]{36})\.csv$/u;

export function importStorageKey(tenantId: string, jobId: string): string {
  return `t/${tenantId.toLowerCase()}/import/${jobId.toLowerCase()}.csv`;
}

export function parseImportKey(key: string): { tenantId: string; jobId: string } | null {
  const match = importKey.exec(key);
  if (!match) return null;
  const tenantId = match[1]?.toLowerCase() ?? "";
  const jobId = match[2]?.toLowerCase() ?? "";
  if (!UUID.test(tenantId) || !UUID.test(jobId)) return null;
  return { tenantId, jobId };
}
