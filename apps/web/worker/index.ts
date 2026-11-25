import { errorResponse, withSecurityHeaders, PRIVATE_NO_STORE } from "./headers.ts";
import { isApiPath, isAuthPath, proxyApi } from "./proxy.ts";

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export interface WorkerEnv {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  API_ORIGIN?: string;
  ENVIRONMENT?: string;
}

export interface HandlerDeps {
  assets: (request: Request) => Promise<Response>;
  upstream?: (input: string, init: RequestInit) => Promise<Response>;
}

export async function handleRequest(
  request: Request,
  env: WorkerEnv,
  deps: HandlerDeps,
): Promise<Response> {
  if (!ALLOWED_METHODS.has(request.method)) {
    return errorResponse(405, "method_not_allowed", "Method not allowed.");
  }

  const url = new URL(request.url);
  if (isApiPath(url.pathname)) {
    const upstream = deps.upstream ?? ((input, init) => fetch(input, init));
    return proxyApi(request, url, env.API_ORIGIN, env.ENVIRONMENT, upstream);
  }

  const asset = await deps.assets(request);
  if (isAuthPath(url.pathname)) {
    return withSecurityHeaders(asset, { "cache-control": PRIVATE_NO_STORE });
  }
  return withSecurityHeaders(asset);
}

const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(request, env, {
      assets: (assetRequest) => env.ASSETS.fetch(assetRequest),
    });
  },
};

export default worker;
