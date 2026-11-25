export type SearchDriver = "keyword" | "unsupported";

/**
 * Keyword search is the only driver on this profile.
 * `SEARCH_DRIVER=vector` is reserved for a later cloud profile and does not load pgvector.
 */
export function readSearchDriver(env: NodeJS.ProcessEnv): SearchDriver {
  const value = (env.SEARCH_DRIVER ?? "").trim();
  if (value === "" || value === "keyword") return "keyword";
  return "unsupported";
}
