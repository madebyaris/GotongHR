import { errorResponse, PRIVATE_NO_STORE, withSecurityHeaders } from "./headers.ts";

export const API_PREFIX = "/api";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "content-length",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "forwarded",
  "x-real-ip",
  "true-client-ip",
  "x-client-ip",
  "cf-connecting-ip",
  "cf-visitor",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "content-encoding",
  "content-length",
]);

export type OriginDecision =
  | { ok: true; origin: string }
  | { ok: false; message: string };

export function allowsInsecureOrigin(environment: string | undefined): boolean {
  return environment === "development" || environment === "test";
}

export function resolveApiOrigin(
  raw: string | undefined,
  environment: string | undefined,
): OriginDecision {
  if (raw === undefined || raw.trim() === "") {
    return { ok: false, message: "API origin is not configured." };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: "API origin is invalid." };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, message: "API origin is invalid." };
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return { ok: false, message: "API origin is invalid." };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, message: "API origin is invalid." };
  }
  if (url.protocol === "https:") {
    return { ok: true, origin: url.origin };
  }
  if (url.protocol === "http:" && allowsInsecureOrigin(environment)) {
    return { ok: true, origin: url.origin };
  }
  return { ok: false, message: "API origin must use HTTPS." };
}

export function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

export function isAuthPath(pathname: string): boolean {
  return pathname === "/auth" || pathname.startsWith("/auth/");
}

export function trustedClientIp(request: Request): string | undefined {
  const value = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (!isSingleIp(value)) return undefined;
  return value;
}

export function buildUpstreamUrl(requestUrl: URL, origin: string): string {
  const rest = requestUrl.pathname === API_PREFIX ? "/" : requestUrl.pathname.slice(API_PREFIX.length);
  const dest = new URL(rest, `${origin}/`);
  if (dest.origin !== new URL(origin).origin) {
    throw new Error("API upstream escaped its origin.");
  }
  dest.search = requestUrl.search;
  return dest.toString();
}

export function forwardedHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  for (const name of STRIP_REQUEST_HEADERS) headers.delete(name);
  const clientIp = trustedClientIp(request);
  const url = new URL(request.url);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol === "https:" ? "https" : "http");
  if (clientIp) {
    headers.set("cf-connecting-ip", clientIp);
    headers.set("x-forwarded-for", clientIp);
  }
  return headers;
}

export async function proxyApi(
  request: Request,
  url: URL,
  apiOrigin: string | undefined,
  environment: string | undefined,
  upstream: (input: string, init: RequestInit) => Promise<Response>,
): Promise<Response> {
  const decision = resolveApiOrigin(apiOrigin, environment);
  if (!decision.ok) return errorResponse(502, "bad_gateway", decision.message);

  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return errorResponse(413, "too_large", "Request body is too large.");
  }

  let body: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      return errorResponse(413, "too_large", "Request body is too large.");
    }
  }

  let upstreamUrl: string;
  try {
    upstreamUrl = buildUpstreamUrl(url, decision.origin);
  } catch {
    return errorResponse(502, "bad_gateway", "API origin is invalid.");
  }

  let upstreamResponse: Response;
  try {
    const init: RequestInit = {
      method: request.method,
      headers: forwardedHeaders(request),
      redirect: "manual",
    };
    if (body !== undefined) init.body = body;
    upstreamResponse = await upstream(upstreamUrl, init);
  } catch {
    return errorResponse(502, "bad_gateway", "API origin is unreachable.");
  }

  return withSecurityHeaders(sanitizeUpstream(upstreamResponse), {
    "cache-control": PRIVATE_NO_STORE,
  });
}

function sanitizeUpstream(response: Response): Response {
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key)) headers.append(key, value);
  });
  if (typeof response.headers.getSetCookie === "function") {
    headers.delete("set-cookie");
    for (const cookie of response.headers.getSetCookie()) {
      headers.append("set-cookie", cookie);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isSingleIp(value: string): boolean {
  if (value === "" || value.length > 45 || /[\s,]/.test(value)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return value.split(".").every((part) => {
      if (part.length > 1 && part.startsWith("0")) return false;
      const n = Number(part);
      return n >= 0 && n <= 255;
    });
  }
  return value.includes(":") && /^[0-9a-f:.]+$/i.test(value);
}
