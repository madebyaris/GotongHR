import type { FastifyServerOptions } from "fastify";

/**
 * Fastify 5.12 ignores a numeric `trustProxy` (it cannot see who the peer is).
 * A hop count therefore trusts that many forwarding hops only when the socket
 * peer is loopback or a private address, which is the Caddy or tunnel hop.
 * A client that connects directly cannot spoof `X-Forwarded-For`.
 */
export function trustProxyHops(hops: number): (address: string, hop: number) => boolean {
  return (address, hop) => hop < hops && (hop > 0 || isPrivateProxyAddress(address));
}

export function resolveTrustProxy(
  value: boolean | number | string | string[] | undefined,
): Exclude<FastifyServerOptions["trustProxy"], undefined> {
  const setting = value ?? 1;
  if (typeof setting === "number") return trustProxyHops(setting);
  return setting;
}

function isPrivateProxyAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/iu, "");
  if (ip === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(ip);
  if (match) {
    const octets = match.slice(1).map((part) => Number(part));
    if (octets.some((part) => part > 255)) return false;
    const a = octets[0] ?? 256;
    const b = octets[1] ?? 256;
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  return (
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  );
}
