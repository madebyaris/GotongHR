import type { FastifyServerOptions } from "fastify";
import {
  trustProxyFunction,
  type TrustProxySetting,
} from "@gotonghr/identity";

/**
 * Fastify 5.12 ignores a numeric `trustProxy` because a hop count cannot see
 * who the peer is. `GOTONG_TRUST_PROXY=1` therefore trusts one forwarding hop
 * only from a loopback, link-local, or private socket peer.
 *
 * That default assumes port 3000 is reachable only by the reverse proxy or the
 * Docker internal network, never directly from an untrusted client. Compose
 * publishes the API on `127.0.0.1:3000`. If a client can open that port, set
 * an explicit trusted-proxy address or CIDR list instead of `1`.
 */
export function trustProxyHops(
  hops: number,
): (address: string | undefined, hop: number) => boolean {
  return trustProxyFunction(hops);
}

export function resolveTrustProxy(
  value: TrustProxySetting | undefined,
): Exclude<FastifyServerOptions["trustProxy"], undefined> {
  const setting = value ?? 1;
  if (setting === false) return false;
  return trustProxyFunction(setting);
}
