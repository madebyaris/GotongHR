import { createHash } from "node:crypto";

/** Strong ETag of the exact JSON bytes the route sends. */
export function strongEtag(body: string): string {
  return `"${createHash("sha256").update(body).digest("base64url")}"`;
}

/**
 * True when If-None-Match is `*`, the strong tag, or the same tag marked weak.
 * A list matches if any member matches.
 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const want = unwrap(etag);
  if (!want) return false;
  return header.split(",").some((part) => {
    const token = unwrap(part);
    return token === "*" || token === want;
  });
}

function unwrap(value: string): string {
  let token = value.trim();
  if (token.startsWith("W/")) token = token.slice(2).trim();
  if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
    token = token.slice(1, -1);
  }
  return token;
}
