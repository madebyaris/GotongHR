import type { FieldIssue } from "@gotonghr/contracts";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldIssue[];

  constructor(status: number, code: string, message: string, fields: FieldIssue[]) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export async function apiData<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  let body: { data?: T; error?: { code?: string; message?: string; fields?: FieldIssue[] } | null };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new ApiRequestError(response.status, "request_failed", "Request failed.", []);
  }
  if (!response.ok || body.error) {
    throw new ApiRequestError(
      response.status,
      body.error?.code ?? "request_failed",
      body.error?.message ?? "Request failed.",
      body.error?.fields ?? [],
    );
  }
  if (body.data === undefined) {
    throw new ApiRequestError(response.status, "request_failed", "Request failed.", []);
  }
  return body.data;
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  const response = await fetch("/api/auth/sign-in/email", {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (response.status === 429) {
    throw new ApiRequestError(429, "rate_limited", "Too many attempts. Wait a minute.", []);
  }
  if (response.status >= 500) {
    throw new ApiRequestError(response.status, "server_error", "Sign-in failed. Try again.", []);
  }
  if (!response.ok) {
    throw new ApiRequestError(response.status, "invalid_login", "Email or password is wrong.", []);
  }
}
