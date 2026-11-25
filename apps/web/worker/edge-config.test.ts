import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SECURITY_HEADERS } from "./headers.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface RulesetRule {
  description: string;
  expression: string;
  action: string;
  enabled: boolean;
  action_parameters?: {
    cache?: boolean;
    edge_ttl?: { mode?: string; default?: number };
    browser_ttl?: { mode?: string; default?: number };
    response?: { status_code?: number; content_type?: string; content?: string };
  };
  ratelimit?: {
    characteristics: string[];
    period: number;
    requests_per_period: number;
    mitigation_timeout: number;
  };
}

interface RulesetFile {
  name: string;
  description: string;
  kind: string;
  phase: string;
  rules: RulesetRule[];
}

test("wrangler runs the Worker only for /api and serves the SPA from dist", () => {
  const config = parseJsonc(readRepo("apps/web/wrangler.jsonc")) as {
    main: string;
    compatibility_date: string;
    observability: { enabled: boolean };
    assets: {
      directory: string;
      not_found_handling: string;
      binding: string;
      run_worker_first: string[] | boolean;
    };
  };
  assert.equal(config.main, "worker/index.ts");
  assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(config.observability.enabled, true);
  assert.equal(config.assets.directory, "./dist");
  assert.equal(config.assets.not_found_handling, "single-page-application");
  assert.equal(config.assets.binding, "ASSETS");
  assert.equal(Array.isArray(config.assets.run_worker_first), true);
  const routes = config.assets.run_worker_first as string[];
  assert.ok(routes.includes("/api/*"));
  assert.ok(routes.every((route) => route === "/api" || route.startsWith("/api/")));
  assert.equal(routes.includes("/assets/*"), false);
  assert.equal(routes.includes("/*"), false);
});

test("_headers keeps API and auth private and hashed assets immutable", () => {
  const file = readRepo("apps/web/public/_headers");
  const samples = {
    "/assets/app-abc123.js": "public, max-age=31536000, immutable",
    "/index.html": "public, max-age=0, must-revalidate",
    "/manifest.webmanifest": "public, max-age=0, must-revalidate",
    "/sw.js": "public, max-age=0, must-revalidate",
    "/api/auth/sign-in": "private, no-store",
    "/api": "private, no-store",
    "/auth/sign-in": "private, no-store",
    "/auth": "private, no-store",
  };
  for (const [pathname, cacheControl] of Object.entries(samples)) {
    const headers = headersFor(file, pathname);
    assert.equal(headers.get("cache-control"), cacheControl, pathname);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(headers.get(name), value, `${pathname} ${name}`);
    }
  }
  assert.equal(
    headersFor(file, "/assets/app-abc123.js").get("cache-control")?.includes("no-store"),
    false,
  );
});

test("asset ignore list does not drop _headers", () => {
  const ignore = readRepo("apps/web/public/.assetsignore");
  assert.equal(ignore.includes("_headers"), false);
  assert.match(ignore, /\*\*\/\*\.br/);
  assert.match(ignore, /\*\*\/\*\.gz/);
});

test("WAF ruleset blocks probes and methods without challenging Indonesian networks", () => {
  const ruleset = readRuleset("waf-custom-rules.json", "http_request_firewall_custom");
  const probe = ruleMatching(ruleset, "contains \"/.\"");
  assert.equal(probe.action, "block");
  assert.match(probe.expression, /\.well-known/);
  assert.match(probe.expression, /\.bak/);
  assert.match(probe.expression, /wp-admin/);

  const methods = ruleMatching(ruleset, "http.request.method");
  assert.equal(methods.action, "block");
  assert.match(methods.expression, /OPTIONS/);
  assert.match(methods.expression, /"GET"/);

  const platform = ruleMatching(ruleset, "/api/platform");
  assert.equal(platform.action, "block");
  assert.match(platform.expression, /CF_Authorization/);
  assert.match(platform.expression, /cf-access-jwt-assertion/);
  assert.match(platform.expression, /cf-access-client-id/);

  const auth = ruleMatching(ruleset, "/api/auth/");
  assert.equal(auth.action, "block");
  assert.match(auth.expression, /sqlmap/);
  assert.doesNotMatch(auth.expression, /http\.request\.uri\.path eq "\/api\/auth/);

  for (const rule of ruleset.rules) {
    assert.equal(rule.action === "challenge" || rule.action === "managed_challenge" || rule.action === "js_challenge", false);
    assert.doesNotMatch(rule.expression, /country|threat_score|bot_management|cf\.client\.bot/i);
  }
});

test("rate limits let a 30-person office NAT clock in together", () => {
  const ruleset = readRuleset("rate-limit-rules.json", "http_ratelimit");
  const expectations = [
    { needle: "/api/auth/sign-in", floor: 90 },
    { needle: "/api/auth/two-factor", floor: 60 },
    { needle: "/api/auth/forget-password", floor: 20 },
    { needle: "/api/attendance/clock", floor: 120 },
    { needle: "/api/ai/", floor: 30 },
  ];
  for (const item of expectations) {
    const rule = ruleMatching(ruleset, item.needle);
    assert.equal(rule.action, "block");
    const limit = rule.ratelimit;
    assert.ok(limit, item.needle);
    assert.ok(limit.characteristics.includes("ip.src"));
    assert.equal(limit.characteristics.some((key) => /cookie|header/i.test(key)), false);
    assert.ok(limit.period >= 10);
    assert.ok(limit.requests_per_period >= item.floor, `${item.needle} allows ${limit.requests_per_period}`);
    assert.ok(limit.mitigation_timeout >= 0);
  }
  const clock = ruleMatching(ruleset, "/api/attendance/clock");
  assert.ok(clock.ratelimit);
  assert.ok(clock.ratelimit.requests_per_period >= 120);
  assert.match(clock.expression, /\/api\/attendance\/clock/);
});

test("cache rules never store API or auth and keep hashed assets for a year", () => {
  const ruleset = readRuleset("cache-rules.json", "http_request_cache_settings");
  const api = ruleMatching(ruleset, "/api/");
  const assets = ruleMatching(ruleset, "/assets/");
  const cookies = ruleset.rules.find((rule) => rule.expression.includes("better-auth.session_token"));
  assert.ok(cookies);
  assert.equal(api.action, "set_cache_settings");
  assert.equal(api.action_parameters?.cache, false);
  assert.match(api.expression, /\/auth\//);
  assert.equal(assets.action_parameters?.cache, true);
  assert.equal(assets.action_parameters?.edge_ttl?.mode, "override_origin");
  assert.equal(assets.action_parameters?.edge_ttl?.default, 31536000);
  assert.equal(assets.action_parameters?.browser_ttl?.default, 31536000);
  assert.match(cookies.expression, /not starts_with\(http\.request\.uri\.path, "\/assets\/"\)/);
  assert.ok(ruleset.rules.indexOf(api) < ruleset.rules.indexOf(assets));
  assert.ok(ruleset.rules.indexOf(assets) < ruleset.rules.indexOf(cookies));
});

test("API-only Caddy trusts CF-Connecting-IP only from Cloudflare hops", () => {
  const file = readRepo("infra/caddy/Caddyfile.api-only");
  assert.match(file, /mode require_and_verify/);
  assert.match(file, /trust_pool file \/etc\/caddy\/certs\/cloudflare-origin-pull-ca\.pem/);
  assert.match(file, /client_ip_headers CF-Connecting-IP\n/);
  assert.doesNotMatch(file, /client_ip_headers[^\n]*X-Forwarded-For/);
  assert.match(file, /header_up -X-Forwarded-For/);
  assert.match(file, /header_up CF-Connecting-IP \{client_ip\}/);
  assert.match(file, /header_up X-Forwarded-For \{client_ip\}/);
  assert.match(file, /not remote_ip/);
  assert.doesNotMatch(file, /file_server/);
  assert.doesNotMatch(file, /\/srv/);
  const trusted = cidrSection(file, "trusted_proxies");
  const remote = cidrSection(file, "remote_ip");
  assert.deepEqual(trusted, remote);
  assert.equal(trusted.length, 22);
  assert.ok(trusted.includes("173.245.48.0/20"));
  assert.ok(trusted.includes("2c0f:f248::/32"));
  assert.equal(readRepo("infra/caddy/certs/cloudflare-origin-pull-ca.pem").includes("BEGIN CERTIFICATE"), true);
});

test("Cloudflare compose drops the static frontend and caps the tunnel", () => {
  const file = readRepo("infra/docker/compose.cloudflare.yml");
  assert.match(file, /vps-frontend/);
  assert.match(file, /!reset \[\]/);
  assert.match(file, /profiles: \["tunnel"\]/);
  assert.match(file, /mem_limit: 48m/);
  assert.match(file, /cloudflare\/cloudflared:2026\.11\.2@sha256:55c7e3e8d89d5e8d20b75a82f3602cbf98e06db406e73e282073cfdc5a9a3af6/);
  assert.match(file, /TUNNEL_TRANSPORT_PROTOCOL: http2/);
  assert.match(file, /Caddyfile\.api-only/);
  assert.match(file, /profiles: \["origin-pull"\]/);
  assert.doesNotMatch(file, /80:8080/);
  assert.match(file, /TRUSTED_ORIGINS:/);
  assert.match(file, /TRUSTED_PROXY_CIDRS:/);
});

function readRepo(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

function parseJsonc(text: string): unknown {
  const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLine = withoutBlock.replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(withoutLine);
}

function readRuleset(name: string, phase: string): RulesetFile {
  const parsed = JSON.parse(readRepo(`infra/cloudflare/rulesets/${name}`)) as RulesetFile;
  assert.equal(parsed.kind, "zone");
  assert.equal(parsed.phase, phase);
  assert.equal(typeof parsed.name, "string");
  assert.ok(parsed.name.length > 0);
  assert.equal(typeof parsed.description, "string");
  assert.ok(parsed.rules.length > 0);
  for (const rule of parsed.rules) {
    assert.equal(typeof rule.description, "string");
    assert.ok(rule.description.length > 0);
    assert.equal(typeof rule.expression, "string");
    assert.ok(rule.expression.length > 0);
    assert.equal(rule.enabled, true);
    assert.equal("id" in rule, false);
    assert.doesNotMatch(rule.expression, /ZONE_ID|\$\{/);
  }
  return parsed;
}

function ruleMatching(ruleset: RulesetFile, needle: string): RulesetRule {
  const rule = ruleset.rules.find((item) => item.expression.includes(needle));
  assert.ok(rule, needle);
  return rule;
}

function headersFor(file: string, pathname: string): Map<string, string> {
  const headers = new Map<string, string>();
  let pattern = "";
  for (const rawLine of file.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!rawLine.startsWith(" ") && !rawLine.startsWith("\t")) {
      pattern = line;
      continue;
    }
    if (!pathMatches(pattern, pathname)) continue;
    if (line.startsWith("! ")) {
      headers.delete(line.slice(2).trim().toLowerCase());
      continue;
    }
    const splitAt = line.indexOf(":");
    assert.ok(splitAt > 0, line);
    const name = line.slice(0, splitAt).trim().toLowerCase();
    const value = line.slice(splitAt + 1).trim();
    const existing = headers.get(name);
    headers.set(name, existing === undefined ? value : `${existing}, ${value}`);
  }
  return headers;
}

function pathMatches(pattern: string, pathname: string): boolean {
  if (!pattern.includes("*")) return pattern === pathname;
  const star = pattern.indexOf("*");
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return pathname.startsWith(prefix) && pathname.endsWith(suffix) && pathname.length >= prefix.length + suffix.length;
}

function cidrSection(file: string, name: string): string[] {
  const match = file.match(new RegExp(`# cidr-list: ${name}\\n([\\s\\S]*?)\\n\\s*# cidr-end: ${name}`));
  assert.ok(match, name);
  const body = match[1] ?? "";
  return body
    .split("\n")
    .map((line) => line.trim().replace(/\\$/, "").trim())
    .filter((line) => line.includes("/"));
}
