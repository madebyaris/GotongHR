# Cloudflare edge

The browser loads the Vite SPA from a Cloudflare Worker. The VPS runs the API and Postgres. Hashed files are served by Workers Static Assets, so those requests do not invoke the Worker.

This repository does not change `apps/api`. The `trustProxy` patch at the end of this file waits until Slice 1.1 has merged.

## Deploy the Worker

From the repo root, with a Cloudflare API token that can edit Workers:

```bash
pnpm --filter @gotonghr/web deploy
```

That script typechecks the Worker, runs its tests, builds the SPA, and then runs `wrangler deploy`.

`apps/web/wrangler.jsonc` uploads `apps/web/dist`. `run_worker_first` is `/api` and `/api/*` only. `/assets/*` and HTML navigations stay on the asset path. `compatibility_date` is `2026-11-25`, so a browser navigation does not invoke the Worker. `observability.enabled` is true.

Set `API_ORIGIN` when this Worker should proxy `/api/*`:

```bash
pnpm --filter @gotonghr/web exec wrangler secret put API_ORIGIN
```

The value is an origin with no path, for example `https://origin.example.co.id`. Production refuses an unset origin and refuses `http://`. Copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars` for `wrangler dev`, which may use `http://127.0.0.1:3000`.

Attach the public hostname in the Workers custom domains screen. `workers_dev` is false, so deploy does not publish a `workers.dev` URL.

## Same-origin `/api` or an `api.` host

Use one public hostname for the SPA and the API.

1. Point `hr.example.co.id` at the Worker.
2. Point a tunnel or origin-pull hostname, such as `origin.example.co.id`, at the API. Users do not type this name.
3. Set `API_ORIGIN` to `https://origin.example.co.id`.

The browser calls `https://hr.example.co.id/api/...`. The Worker strips the `/api` prefix and forwards the rest, matching `docker/Caddyfile`. `/api/readyz` reaches Fastify as `/readyz`. `/api/auth/sign-in` reaches Fastify as `/auth/sign-in`. Mount new Fastify routes without a second `/api` prefix, or change the Worker and both Caddyfiles together.

The Worker forwards `Origin`, `Cookie`, and the browser `Host` as `X-Forwarded-Host`. It sets `X-Forwarded-Proto` from the public request. It deletes `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, and `True-Client-IP`. It then sets `CF-Connecting-IP` and `X-Forwarded-For` to the single `CF-Connecting-IP` value Cloudflare put on the Worker request. A comma-separated value is dropped, not forwarded.

`Content-Security-Policy` `connect-src` is `'self'`. That matches this same-origin proxy. There is no CORS preflight.

An `api.` hostname is the other layout. Leave `API_ORIGIN` unset so this Worker does not proxy. Point `api.example.co.id` at the tunnel. The SPA then calls that host from the browser. That needs CORS on the API and a `connect-src` change in both `apps/web/worker/headers.ts` and `apps/web/public/_headers`. This repo does not add that CORS policy. Prefer the same-origin proxy.

Do not skip `http_request_firewall_custom` or `http_ratelimit` by hostname. A skip for `origin.example.co.id` also matches someone who opens that name directly.

Prefer a tunnel. If `API_ORIGIN` is a proxied hostname in the same zone, Cloudflare does not apply custom WAF rules to the Worker subrequest. Rate-limit rules may still count that subrequest. Keep both phases enabled so a direct request to the origin hostname is still checked. Do not add a hostname skip. You can also require a credential that only this Worker sends and that the origin checks. That credential does not replace the rules.

## Cache

`apps/web/public/_headers` is copied to `dist/_headers`. Workers apply it to asset responses and do not serve the file. `/_headers` is also hidden on the VPS Caddyfile.

| Path | Cache-Control |
| :--- | :--- |
| `/`, `/clock-in`, other HTML routes, `/index.html`, `/manifest.webmanifest`, `/sw.js` | `public, max-age=0, must-revalidate` |
| `/assets/*` | `public, max-age=31536000, immutable` |
| `/api`, `/api/*`, `/auth`, `/auth/*` | `private, no-store` |

`/*` sets the short HTML lifetime, so `/` and a SPA route such as `/clock-in` revalidate after a deploy. Later rules replace that value for hashed assets, `/api`, and `/auth`.

Responses also send `Strict-Transport-Security: max-age=31536000`. `includeSubDomains` is off, so a new hostname is not pinned before it has a certificate. `preload` is off. Preload is difficult to reverse. Removal can take months to reach browsers. Turn those two on in the zone HSTS screen only after every name in the zone is HTTPS.

The cache rules in `infra/cloudflare/rulesets/cache-rules.json` repeat the bypass at the zone. The first matching rule wins. API and auth bypass first. `/assets/*` then stores HTTP 200 at the edge for 31536000 seconds. The edge default for every other status is 0, which is no-cache. `status_code_ttl` also sets 400–499 and 500–599 to 0, so a removed hashed file is not kept for a year. Value 0 means no-cache. It does not mean a one-year store. Browser TTL follows the origin, so `apps/web/public/_headers` is what the browser sees, including `immutable` on `/assets/*`. A Better Auth session cookie bypasses cache on every other path. The cookie name checked is `better-auth.session_token`, which also matches the `__Secure-` prefix. Hashed assets stay cached for a logged-in browser, because those URLs change when the bytes change.

Vite still writes `.br` and `.gz` next to the files for Caddy on a full VPS. `apps/web/public/.assetsignore` keeps those sidecars out of the Worker upload. Cloudflare Brotli compresses the plain files on the way out.

## Network settings for slow links

Set these on the zone. They sit on the path between an Indonesian phone and Cloudflare, where round trip time is often 200–600 ms.

| Setting | Value | Why |
| :--- | :--- | :--- |
| SSL/TLS encryption mode | Full (strict) | Cloudflare checks the origin certificate. Authenticated Origin Pulls does not run in Flexible mode. |
| Minimum TLS version | TLS 1.3 | The handshake is one round trip shorter than TLS 1.2. |
| HTTP/3 (with QUIC) | On | Lossy 4G does not stall every stream when one packet drops. |
| Brotli | On | The JS shell is smaller on a 300 Kbps link. |
| Early Hints | On | Starts working when `index.html` sends `Link: rel=preload`. This repo does not hard-code hashed names, so the switch is ready and currently idle. |
| Smart Tiered Cache | On | A cold colo can reuse a regional copy of `/assets/*`. `/api/*` is not cached, so this does not speed the API. |
| 0-RTT | Off | See below. |

The origin Caddyfile speaks HTTP/1.1 and HTTP/2 to Cloudflare. It does not open UDP/443. QUIC stays between the phone and Cloudflare.

### 0-RTT

Turn 0-RTT off. Sign-in, password reset, clock-in, and payroll posts are not idempotent. A replayed ClientHello payload would run the request twice. Clock-in will grow an idempotency key in the API, and that key does not make an edge replay safe. The zone switch is SSL/TLS, Edge Certificates, 0-RTT Connection Resumption, off. The API setting name is `0rtt` with value `off`.

## Rulesets

The JSON files are create-ruleset bodies. `kind` is `zone`. Apply each file to its `phase`. If the phase entry point already exists, PUT the `rules` array onto that ruleset instead of POSTing again. A PUT replaces every rule already in that phase.

```bash
ZONE_ID=your-zone-id
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data @infra/cloudflare/rulesets/waf-custom-rules.json
```

Repeat for `rate-limit-rules.json` (`http_ratelimit`) and `cache-rules.json` (`http_request_cache_settings`).

Custom WAF rules:

- Block dotfiles, backup extensions, and common probe paths. `/.well-known/` stays open.
- Block methods outside GET, HEAD, POST, PUT, PATCH, DELETE, and OPTIONS.
- Block `/api/platform` and `/api/v1/platform` unless a Cloudflare Access JWT cookie, `Cf-Access-Jwt-Assertion`, or `CF-Access-Client-Id` is present. The header check stops anonymous scans. Access still has to validate the credential.
- On `/api/auth/`, block known scanner user agents. The query is lowercased. The path check also uses `url_decode`, so `/api/auth/%2e%2e%2ffoo` matches `../`. The rule matches `../`, `<script`, `%2e%2e`, `%3cscript`, and encoded traversal that contains `%2f` (`..%2f`, `%2e%2e%2f`, `%2f%2e%2e`). A bare `%2f` is not a match, because an auth query can carry an encoded URL. The rule does not use country, threat score, or bot score, and it does not challenge. Telkomsel, XL, Indosat, Tri, Smartfren, and office NAT stay through.

Rate limits count by `cf.colo.id` and `ip.src`. They do not count by a cookie or a header, because a client can rotate those and get a new counter. One office is one IP at one colo. The whole budget can be spent in the first seconds of the window.

| Path | Requests per 60 seconds per IP | Lockout |
| :--- | :--- | :--- |
| `/api/auth/sign-in*` | 120 | 60 seconds |
| `/api/auth/two-factor*` | 90 | 60 seconds |
| `/api/auth/forget-password*` | 30 | 120 seconds |
| `/api/attendance/clock*`, `/api/v1/attendance/clock*` | 180 | 10 seconds |
| `/api/v1/mobile/clock*` | none at the edge | none in the API yet, required after Slice 1.1 |
| `/api/ai/*` | 60 | 30 seconds |

180 office clock-in requests cover 30 people with a status read and retries at 08:00 WIB. A limit of 10 or 30 per minute would block that office. `/api/v1/attendance/clock` is included so a versioned mount is covered. Periods of 60 seconds need a plan that allows that period. If the account only allows 10 second periods, keep `requests_per_period` at least 120 for office clock-in.

`/api/v1/mobile/clock` is not on the per-IP rule. A carrier CGNAT address is shared by subscribers who do not work together, so the 180 per minute office cap would return 429 to people outside that office. The API must limit that route per authenticated user and per device after Slice 1.1. Until that limit exists, one CGNAT address can send an unlimited number of mobile clock requests. That is the trade-off. Do not put the mobile path back on `ip.src` to close it.

## Platform Super-Admin

Create two Cloudflare Access applications on the public hostname:

- `hr.example.co.id/platform` and `hr.example.co.id/platform/*`
- `hr.example.co.id/api/platform` and `hr.example.co.id/api/platform/*`

Add `/api/v1/platform` if the API is mounted there. The policy allows the platform operator group and requires the identity provider's MFA. Keep the Access session short.

The WAF does not block the HTML `/platform` route. Access can still show its login page. The API rule blocks calls that have none of the Access credentials. After login, the browser sends `CF_Authorization`. Automation uses an Access service token.

The SPA route is still only a front door. The API must keep its own platform role check after Slice 1.1.

## API-only VPS

Compose 2.24 or newer is required.

2 GB, tunnel, no public ports:

```bash
docker compose --env-file .env \
  -f docker/docker-compose.vps.yml \
  -f infra/docker/compose.cloudflare.yml \
  --profile tunnel \
  up -d --build
```

1 GB, same profile. The 1 GB file is last so its memory caps win:

```bash
docker compose --env-file .env \
  -f docker/docker-compose.vps.yml \
  -f infra/docker/compose.cloudflare.yml \
  -f docker/docker-compose.vps.1g.yml \
  --profile tunnel \
  up -d --build
```

Direct HTTPS origin instead of a tunnel. Do not enable both profiles.

```bash
export ORIGIN_CERT_PATH=/etc/gotonghr/origin.pem
export ORIGIN_KEY_PATH=/etc/gotonghr/origin.key
docker compose --env-file .env \
  -f docker/docker-compose.vps.yml \
  -f infra/docker/compose.cloudflare.yml \
  --profile origin-pull \
  up -d --build
```

Create the origin certificate in the Cloudflare dashboard (SSL/TLS, Origin Server). Install the PEM and key on the VPS. The compose file mounts them read-only. Full (strict) must already be on. Leave the global Authenticated Origin Pulls toggle off.

`cloudflared` is `2026.11.2`, pinned by the multi-arch index digest in the compose file. It uses HTTP/2 (`TUNNEL_TRANSPORT_PROTOCOL=http2`) because some networks block QUIC from the VPS. Set `CLOUDFLARE_TUNNEL_TOKEN`. In the tunnel UI, the public hostname for the origin points at `http://api:3000`.

The static `caddy` service is on profile `vps-frontend` and does not start. Its 64 MB cap leaves the box. `cloudflared` or `caddy-api` is capped at 48 MB, with swap capped at the same number. API and Postgres caps are unchanged from the file you stacked. API logs are capped at three files of 10 MB.

The tunnel profile removes the published API port. Postgres remains on `127.0.0.1:5432` from the base file. That bind is not a public interface. Do not add a `0.0.0.0` publish.

The origin-pull profile publishes TCP 443. Close 80. On the host firewall, allow 443 only from the same Cloudflare ranges. The Caddyfile rejects any other peer before the proxy, and it requires a client certificate signed by this zone's CA.

`infra/caddy/Caddyfile.api-only` reads the client IP only from `CF-Connecting-IP`, and only when `trusted_proxies_strict` accepts the peer. It then deletes `X-Forwarded-For` and the other forwarding headers and sets one `X-Forwarded-For` and one `CF-Connecting-IP` to `{client_ip}`. A client-supplied chain does not survive. The two CIDR lists in that file are the same list. Refresh them together when Cloudflare publishes new ranges.

Do not install the global Origin Pull CA from `authenticated_origin_pull_ca.pem`. That CA is shared by every Cloudflare zone. Another customer who can connect from a Cloudflare IP would pass the certificate check and skip this zone's Worker WAF. The IP allowlist does not stop that. Tunnel mode does not use Origin Pulls. The tunnel credential is the authentication, and it is the setup to use.

Zone-level Authenticated Origin Pulls uses a CA that only this zone presents. Generate it on a machine that is not the public VPS. Upload the leaf to Cloudflare. Keep the CA key off the VPS. Copy only `rootca.crt` to the VPS.

```bash
openssl genrsa -aes256 -out rootca.key 4096
openssl req -x509 -new -nodes -key rootca.key -sha256 -days 1826 -out rootca.crt
openssl req -new -nodes -out cert.csr -newkey rsa:4096 -keyout cert.key
printf 'basicConstraints=CA:FALSE\n' > cert.v3.ext
openssl x509 -req -in cert.csr -CA rootca.crt -CAkey rootca.key -CAcreateserial -out cert.crt -days 730 -sha256 -extfile cert.v3.ext
```

In the dashboard, open SSL/TLS, Origin Server, Authenticated Origin Pulls. Under Zone-level, upload `cert.crt` and `cert.key`. The upload rejects a CA that has no leaf. Turn zone-level Authenticated Origin Pulls on. Leave the global toggle off.

Copy `rootca.crt` to `infra/caddy/certs/cloudflare-zone-origin-pull-ca.pem` on the VPS before `docker compose up`. That filename is gitignored. The compose file mounts it at `/etc/caddy/certs/cloudflare-zone-origin-pull-ca.pem`. Paths in the overlay are relative to `docker/`, because `docker/docker-compose.vps.yml` is the first `-f` file. If the CA file is missing, Compose creates a directory at that path and Caddy does not start cleanly. Do not commit the CA, `rootca.key`, or `cert.key`.

## API patch after Slice 1.1

Do not set Fastify `trustProxy: true`. That trusts `X-Forwarded-For` from every caller who can open the port.

Add `apps/api/src/client-ip.ts`:

```typescript
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";

const LOOPBACK = ["127.0.0.1/32", "::1/128"];

export function trustProxy(address: string): boolean {
  return isTrustedHop(address);
}

export function isTrustedHop(address: string): boolean {
  const peer = normalize(address);
  return configuredCidrs().some((cidr) => contains(peer, cidr));
}

export function clientIp(request: FastifyRequest): string {
  const peer = normalize(request.socket.remoteAddress ?? "");
  if (!isTrustedHop(peer)) return peer;
  const header = request.headers["cf-connecting-ip"];
  if (typeof header === "string" && header !== "" && !header.includes(",") && isIP(header) !== 0) {
    return header;
  }
  return peer;
}

function configuredCidrs(): string[] {
  const raw = process.env.TRUSTED_PROXY_CIDRS ?? "";
  const extra = raw.split(",").map((item) => item.trim()).filter((item) => item !== "");
  return [...LOOPBACK, ...extra];
}

function normalize(address: string): string {
  const withoutZone = address.split("%")[0] ?? address;
  return withoutZone.startsWith("::ffff:") ? withoutZone.slice("::ffff:".length) : withoutZone;
}

function contains(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  const range = slash === -1 ? cidr : cidr.slice(0, slash);
  const bits = slash === -1 ? 32 : Number(cidr.slice(slash + 1));
  if (range === "" || !Number.isInteger(bits)) return false;
  if (ip.includes(":") || range.includes(":")) return ip === range;
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === undefined || rangeInt === undefined || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    value = (value * 256 + n) >>> 0;
  }
  return value;
}
```

In `apps/api/src/server.ts`, pass the function into Fastify:

```typescript
import { trustProxy } from "./client-ip.ts";

const app = Fastify({
  logger: deps.logger ? { level: "info" } : false,
  bodyLimit: 2 * 1024 * 1024,
  trustProxy,
});
```

Use `clientIp(request)` anywhere the audit log or a rate limit needs the employee IP. `request.ip` agrees when the only trusted peer is Caddy or cloudflared, because those proxies replace `X-Forwarded-For` with the same single address. If the peer is not in `TRUSTED_PROXY_CIDRS`, both values stay the socket address and a spoofed header is ignored.

The compose overlay sets `TRUSTED_PROXY_CIDRS` to `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` unless you override it. That is safe only while port 3000 is not published. The IPv6 helper above matches loopback and exact addresses. Add an exact IPv6 proxy address if the compose network is IPv6.

`TRUSTED_ORIGINS` is the browser origin list for Better Auth, not the internal API URL. For the same-origin Worker it is one value, the public site:

```bash
TRUSTED_ORIGINS=https://hr.example.co.id
BETTER_AUTH_URL=https://hr.example.co.id
```

Add this next to the Better Auth constructor in the identity module:

```typescript
import { readTrustedOrigins } from "../trusted-origins.ts";

trustedOrigins: readTrustedOrigins(process.env.TRUSTED_ORIGINS, process.env),
baseURL: process.env.BETTER_AUTH_URL,
```

```typescript
export function readTrustedOrigins(raw: string | undefined, env: NodeJS.ProcessEnv): string[] {
  const origins = (raw ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
  if (env.NODE_ENV === "production" && origins.length === 0) {
    throw new Error("TRUSTED_ORIGINS is required in production.");
  }
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("TRUSTED_ORIGINS has an invalid origin.");
    }
    if (url.origin !== origin) {
      throw new Error("TRUSTED_ORIGINS must be an origin without a path.");
    }
    if (env.NODE_ENV === "production" && url.protocol !== "https:") {
      throw new Error("TRUSTED_ORIGINS must use HTTPS in production.");
    }
  }
  return origins;
}
```

Session cookies stay `HttpOnly`, `Secure`, and `SameSite=Lax`. The Worker does not rewrite `Set-Cookie`. `BETTER_AUTH_URL` must be the public `https` origin so redirects and cookie domains do not point at `http://api:3000`.
