/**
 * Trusted-proxy matching for Fastify and the Cloudflare rate-limit key.
 * `GOTONG_TRUST_PROXY=1` trusts one hop only from a loopback, link-local, or
 * private peer. That default assumes port 3000 is reachable only from the
 * reverse proxy or the Docker internal network, never directly from an
 * untrusted client. An explicit address or CIDR list trusts those proxies
 * instead of every private peer.
 */
export type TrustProxySetting = number | false | string | readonly string[];

interface V4 {
  kind: "v4";
  value: number;
}

interface V6 {
  kind: "v6";
  value: bigint;
}

type ParsedIp = V4 | V6;

interface Cidr {
  kind: "v4" | "v6";
  network: number | bigint;
  bits: number;
}

const LOOPBACK = ["127.0.0.0/8", "::1/128"] as const;
const LINK_LOCAL = ["169.254.0.0/16", "fe80::/10"] as const;
const UNIQUE_LOCAL = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"] as const;

const NAMED_RANGES: Record<string, readonly string[]> = {
  loopback: LOOPBACK,
  linklocal: LINK_LOCAL,
  uniquelocal: UNIQUE_LOCAL,
};

const PRIVATE_RANGES = [...LOOPBACK, ...LINK_LOCAL, ...UNIQUE_LOCAL];

const privateNetworks = compileAllowlist(PRIVATE_RANGES);

export function isPrivateProxyAddress(address: string | undefined): boolean {
  const ip = parseIp(address);
  if (!ip) return false;
  return privateNetworks.some((network) => matches(ip, network));
}

export function isTrustedProxyPeer(
  address: string | undefined,
  setting: TrustProxySetting,
): boolean {
  if (setting === false || setting === 0) return false;
  if (typeof setting === "number") return isPrivateProxyAddress(address);
  return addressInAllowlist(address, allowlistEntries(setting));
}

/**
 * Fastify trust function. A hop count trusts that many forwarding hops, and
 * the socket peer must be private. An allowlist trusts a proxy address at any
 * hop when it matches, which is how a chain of named proxies is walked.
 */
export function trustProxyFunction(
  setting: Exclude<TrustProxySetting, false>,
): (address: string | undefined, hop: number) => boolean {
  if (typeof setting === "number") {
    return (address, hop) => hop < setting && (hop > 0 || isPrivateProxyAddress(address));
  }
  const networks = compileAllowlist(allowlistEntries(setting));
  return (address) => {
    const ip = parseIp(address);
    if (!ip) return false;
    return networks.some((network) => matches(ip, network));
  };
}

export function assertTrustedProxyAllowlist(entries: readonly string[]): void {
  compileAllowlist(entries);
}

function allowlistEntries(setting: string | readonly string[]): string[] {
  const raw = typeof setting === "string" ? setting.split(",") : [...setting];
  return raw.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function addressInAllowlist(address: string | undefined, entries: readonly string[]): boolean {
  const ip = parseIp(address);
  if (!ip) return false;
  return compileAllowlist(entries).some((network) => matches(ip, network));
}

function compileAllowlist(entries: readonly string[]): Cidr[] {
  const networks: Cidr[] = [];
  for (const entry of entries) {
    const named = NAMED_RANGES[entry.toLowerCase()];
    if (named) {
      networks.push(...compileAllowlist(named));
      continue;
    }
    networks.push(parseCidr(entry));
  }
  return networks;
}

function parseCidr(entry: string): Cidr {
  const slash = entry.lastIndexOf("/");
  const addressText = slash === -1 ? entry : entry.slice(0, slash);
  const bitsText = slash === -1 ? undefined : entry.slice(slash + 1);
  const ip = parseIp(addressText);
  if (!ip) throw new Error(`GOTONG_TRUST_PROXY address is invalid: ${entry}`);
  const maxBits = ip.kind === "v4" ? 32 : 128;
  const bits = bitsText === undefined ? maxBits : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) {
    throw new Error(`GOTONG_TRUST_PROXY address is invalid: ${entry}`);
  }
  return { kind: ip.kind, network: networkAddress(ip, bits), bits };
}

function parseIp(address: string | undefined): ParsedIp | null {
  if (!address) return null;
  const text = address.trim().toLowerCase().replace(/%.+$/u, "");
  if (!text) return null;
  if (text.includes(":")) return parseV6(text);
  const v4 = parseV4(text);
  return v4 === null ? null : { kind: "v4", value: v4 };
}

function parseV4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

function parseV6(address: string): ParsedIp | null {
  let text = address;
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    const v4 = parseV4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = (v4 >>> 16).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/u.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  const mappedPrefix = 0xffffn;
  if (value >> 32n === mappedPrefix) {
    return { kind: "v4", value: Number(value & 0xffffffffn) };
  }
  return { kind: "v6", value };
}

function networkAddress(ip: ParsedIp, bits: number): number | bigint {
  if (ip.kind === "v4") return ip.value & maskV4(bits);
  return ip.value & maskV6(bits);
}

function matches(ip: ParsedIp, cidr: Cidr): boolean {
  if (ip.kind !== cidr.kind) return false;
  if (ip.kind === "v4") return (ip.value & maskV4(cidr.bits)) === cidr.network;
  return (ip.value & maskV6(cidr.bits)) === cidr.network;
}

function maskV4(bits: number): number {
  if (bits <= 0) return 0;
  if (bits >= 32) return 0xffffffff;
  return (0xffffffff << (32 - bits)) >>> 0;
}

function maskV6(bits: number): bigint {
  if (bits <= 0) return 0n;
  if (bits >= 128) return (1n << 128n) - 1n;
  const host = (1n << BigInt(128 - bits)) - 1n;
  return ((1n << 128n) - 1n) ^ host;
}
