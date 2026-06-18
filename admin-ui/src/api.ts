import type { SessionResult } from "./types";

let csrfToken = "";

export function setCsrfToken(token: string | undefined): void {
  csrfToken = token ?? "";
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  if (method !== "GET" && method !== "HEAD" && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(`/admin/api${path}`, {
    ...init,
    method,
    headers,
    credentials: "same-origin"
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() as { error?: string } : undefined;
  if (!response.ok) {
    throw new ApiError(response.status, payload?.error ?? response.statusText);
  }
  return payload as T;
}

export async function loadSession(): Promise<SessionResult> {
  const session = await api<SessionResult>("/session");
  setCsrfToken(session.csrfToken);
  return session;
}

export async function login(email: string, password: string): Promise<SessionResult> {
  const session = await api<SessionResult>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  setCsrfToken(session.csrfToken);
  return session;
}

export async function register(email: string, password: string): Promise<{ ok: boolean; pending: boolean }> {
  return api<{ ok: boolean; pending: boolean }>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}
