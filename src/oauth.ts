import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteSync } from "./shared/atomic-write.js";
import { constantTimeEqual } from "./shared/crypto.js";
import type { Request } from "express";
import { z } from "zod";

export interface OAuthConfig {
  issuer: string;
  ownerPasscode: string;
  accessTokenTtlSeconds: number;
  authCodeTtlSeconds: number;
  statePath: string;
}

interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
  ownerUserId?: string;
}

interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  expiresAt: number;
  // The user whose session approved this authorization. The token's tenant is resolved from
  // this, NOT from client.ownerUserId, so two different users authorizing the same clientId
  // can never be conflated (the confused-deputy bug).
  userId?: string;
}

interface AccessToken {
  token: string;
  clientId: string;
  scope: string;
  expiresAt: number;
  userId?: string;
}

interface RefreshToken {
  token: string;
  clientId: string;
  scope: string;
  userId?: string;
}

export interface OAuthClientStatus {
  clientId: string;
  clientName: string;
  redirectHost: string;
  ownerUserId?: string;
  activeAccessTokens: number;
  refreshTokens: number;
  lastUsedAt?: string;
  requestCount: number;
}

export interface AuthorizeParams {
  responseType: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

const registerSchema = z.object({
  client_name: z.string().min(1).max(160).optional(),
  redirect_uris: z.array(z.string().url()).min(1).max(20).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional()
});

const tokenSchema = z.object({
  grant_type: z.string(),
  code: z.string().optional(),
  redirect_uri: z.string().url().optional(),
  client_id: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional()
});

const clients = new Map<string, OAuthClient>();
const authCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, AccessToken>();
const refreshTokens = new Map<string, RefreshToken>();
const clientStats = new Map<string, { lastUsedAt?: string; requestCount: number }>();
let persistedStatePath: string | undefined;
let hasLoadedState = false;

const persistedStateSchema = z.object({
  clients: z.array(z.object({
    clientId: z.string(),
    clientName: z.string(),
    redirectUris: z.array(z.string()),
    createdAt: z.number(),
    ownerUserId: z.string().optional()
  })).optional(),
  authCodes: z.array(z.object({
    code: z.string(),
    clientId: z.string(),
    redirectUri: z.string(),
    scope: z.string(),
    codeChallenge: z.string(),
    codeChallengeMethod: z.literal("S256"),
    expiresAt: z.number(),
    userId: z.string().optional()
  })).optional(),
  accessTokens: z.array(z.object({
    token: z.string(),
    clientId: z.string(),
    scope: z.string(),
    expiresAt: z.number(),
    userId: z.string().optional()
  })).optional(),
  refreshTokens: z.array(z.object({
    token: z.string(),
    clientId: z.string(),
    scope: z.string(),
    userId: z.string().optional()
  })).optional(),
  clientStats: z.array(z.object({
    clientId: z.string(),
    lastUsedAt: z.string().optional(),
    requestCount: z.number()
  })).optional()
});

function now(): number {
  return Date.now();
}

export function initializeOAuthState(statePath: string): void {
  persistedStatePath = statePath;
  if (hasLoadedState) return;
  hasLoadedState = true;

  try {
    const raw = readFileSync(statePath, "utf8");
    const parsed = persistedStateSchema.parse(JSON.parse(raw));
    for (const client of parsed.clients ?? []) clients.set(client.clientId, client);
    for (const code of parsed.authCodes ?? []) authCodes.set(code.code, code);
    for (const token of parsed.accessTokens ?? []) accessTokens.set(token.token, token);
    for (const token of parsed.refreshTokens ?? []) refreshTokens.set(token.token, token);
    for (const stat of parsed.clientStats ?? []) clientStats.set(stat.clientId, { lastUsedAt: stat.lastUsedAt, requestCount: stat.requestCount });
    cleanupExpired();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Failed to load OAuth state from ${statePath}:`, error);
    }
  }
}

function saveState(): void {
  if (!persistedStatePath) return;
  mkdirSync(path.dirname(persistedStatePath), { recursive: true });
  const state = {
    clients: Array.from(clients.values()),
    authCodes: Array.from(authCodes.values()),
    accessTokens: Array.from(accessTokens.values()),
    refreshTokens: Array.from(refreshTokens.values()),
    clientStats: Array.from(clientStats.entries()).map(([clientId, stats]) => ({ clientId, ...stats }))
  };
  atomicWriteSync(persistedStatePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function isRedirectAllowed(client: OAuthClient, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}

function adoptClientFromAuthorize(params: AuthorizeParams, ownerUserId?: string): OAuthClient {
  const client: OAuthClient = {
    clientId: params.clientId,
    clientName: "ChatGPT MCP Connector",
    redirectUris: [params.redirectUri],
    createdAt: now(),
    ownerUserId
  };
  clients.set(client.clientId, client);
  saveState();
  return client;
}

function cleanupExpired(): void {
  const ts = now();
  // Runs on every authenticated request (via isValidAccessToken). Only persist when
  // something actually expired — otherwise this did a synchronous disk write on the
  // hot path on every call, growing more expensive as the state file grows.
  let changed = false;
  for (const [code, record] of authCodes.entries()) {
    if (record.expiresAt <= ts) {
      authCodes.delete(code);
      changed = true;
    }
  }
  for (const [token, record] of accessTokens.entries()) {
    if (record.expiresAt <= ts) {
      accessTokens.delete(token);
      changed = true;
    }
  }
  if (changed) saveState();
}

export function parseAuthorizeParams(req: Request): AuthorizeParams | undefined {
  const query = req.query;
  const responseType = typeof query.response_type === "string" ? query.response_type : undefined;
  const clientId = typeof query.client_id === "string" ? query.client_id : undefined;
  const redirectUri = typeof query.redirect_uri === "string" ? query.redirect_uri : undefined;
  const state = typeof query.state === "string" ? query.state : undefined;
  const scope = typeof query.scope === "string" ? query.scope : "";
  const codeChallenge = typeof query.code_challenge === "string" ? query.code_challenge : undefined;
  const codeChallengeMethod = typeof query.code_challenge_method === "string" ? query.code_challenge_method : undefined;

  if (!responseType || !clientId || !redirectUri || !codeChallenge || !codeChallengeMethod) {
    return undefined;
  }

  return {
    responseType,
    clientId,
    redirectUri,
    state,
    scope,
    codeChallenge,
    codeChallengeMethod
  };
}

export function registerClient(rawBody: unknown): Record<string, unknown> {
  const input = registerSchema.parse(rawBody ?? {});
  const clientId = `client_${randomUUID()}`;
  const redirectUris = input.redirect_uris ?? [];
  const client: OAuthClient = {
    clientId,
    clientName: input.client_name ?? "ChatGPT MCP Connector",
    redirectUris,
    createdAt: now()
  };
  clients.set(clientId, client);
  saveState();

  return {
    client_id: clientId,
    client_name: client.clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"]
  };
}

export function validateAuthorizeRequest(params: AuthorizeParams): string | undefined {
  if (params.responseType !== "code") return "Unsupported response_type.";
  if (params.codeChallengeMethod !== "S256") return "Only PKCE S256 is supported.";
  const client = clients.get(params.clientId);
  if (!client) return undefined;
  if (!isRedirectAllowed(client, params.redirectUri)) return "redirect_uri is not registered for this client.";
  return undefined;
}

export function renderConsentPage(params: AuthorizeParams, error?: string, user?: { email: string; role: string }, switchAccountUrl?: string, csrfToken?: string): string {
  const safe = (value: string | undefined): string => (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

  // Show WHERE the authorization code will be delivered. Without this the user
  // cannot tell a legitimate client from a phishing client whose redirect_uri
  // points at an attacker host, so approving would hand the attacker a token
  // bound to this user's tenant.
  let redirectHost = "an unknown destination";
  try {
    redirectHost = new URL(params.redirectUri).host || redirectHost;
  } catch {
    // Leave the fallback; an unparseable redirect_uri is itself worth flagging.
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Coding MCP</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #f6f7f4; color: #18211c; }
    main { width: min(520px, calc(100vw - 32px)); margin: 56px auto; background: #fff; border: 1px solid #d8ddd2; border-radius: 8px; padding: 28px; }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { color: #5d665d; line-height: 1.5; }
    label { display: block; margin: 18px 0 6px; font-weight: 650; }
    input { width: 100%; box-sizing: border-box; font: inherit; padding: 11px; border: 1px solid #bdc5b8; border-radius: 6px; }
    button { margin-top: 18px; width: 100%; font: inherit; padding: 12px; border: 0; border-radius: 6px; background: #16615a; color: #fff; cursor: pointer; }
    a { color: #16615a; font-weight: 700; }
    .error { color: #a11f1f; }
    .account { margin: 16px 0; padding: 12px; border: 1px solid #d8ddd2; border-radius: 6px; background: #f7faf8; }
    .redirect { margin: 16px 0; padding: 12px; border: 1px solid #e0c98a; border-radius: 6px; background: #fcf7e8; }
    code { background: #eef1eb; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize Coding MCP</h1>
    <p>Client <code>${safe(params.clientId)}</code> is requesting access to <code>${safe(params.scope || "mcp")}</code>.</p>
    ${user ? `<div class="account"><strong>Signed in as ${safe(user.email)}</strong><p>This connector will be bound to this ${safe(user.role)} account.</p>${switchAccountUrl ? `<a href="${safe(switchAccountUrl)}">Switch account</a>` : ""}</div>` : ""}
    <div class="redirect"><strong>After you authorize, you will be sent to <code>${safe(redirectHost)}</code>.</strong><p>Only approve if you recognize and trust this destination.</p></div>
    ${error ? `<p class="error">${safe(error)}</p>` : ""}
    <form method="post" action="/oauth/approve">
      <input type="hidden" name="csrf_token" value="${safe(csrfToken)}">
      <input type="hidden" name="response_type" value="${safe(params.responseType)}">
      <input type="hidden" name="client_id" value="${safe(params.clientId)}">
      <input type="hidden" name="redirect_uri" value="${safe(params.redirectUri)}">
      <input type="hidden" name="state" value="${safe(params.state)}">
      <input type="hidden" name="scope" value="${safe(params.scope)}">
      <input type="hidden" name="code_challenge" value="${safe(params.codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${safe(params.codeChallengeMethod)}">
      <button type="submit">Authorize</button>
    </form>
  </main>
</body>
</html>`;
}

export function createAuthorizationRedirect(params: AuthorizeParams, passcode: string, config: OAuthConfig): string {
  if (!constantTimeEqual(passcode, config.ownerPasscode)) throw new Error("Invalid owner passcode.");
  return createAuthorizationRedirectForUser(params, undefined, config);
}

export function createAuthorizationRedirectForUser(params: AuthorizeParams, ownerUserId: string | undefined, config: OAuthConfig): string {
  if (!clients.has(params.clientId)) {
    if (ownerUserId) {
      adoptClientFromAuthorize(params, ownerUserId);
    } else {
      throw new Error("Unknown OAuth client. Register the client via /oauth/register before authorizing.");
    }
  } else if (ownerUserId) {
    const client = clients.get(params.clientId);
    if (client && !client.ownerUserId) {
      client.ownerUserId = ownerUserId;
      saveState();
    }
  }
  const validation = validateAuthorizeRequest(params);
  if (validation) throw new Error(validation);

  const code = randomToken("code");
  authCodes.set(code, {
    code,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    scope: params.scope,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: "S256",
    expiresAt: now() + config.authCodeTtlSeconds * 1000,
    userId: ownerUserId
  });
  saveState();

  const redirect = new URL(params.redirectUri);
  redirect.searchParams.set("code", code);
  if (params.state) redirect.searchParams.set("state", params.state);
  return redirect.toString();
}

export function exchangeToken(rawBody: unknown, config: OAuthConfig): Record<string, unknown> {
  cleanupExpired();
  const input = tokenSchema.parse(rawBody ?? {});

  if (input.grant_type === "authorization_code") {
    if (!input.code || !input.client_id || !input.redirect_uri || !input.code_verifier) {
      throw new Error("authorization_code grant requires code, client_id, redirect_uri, and code_verifier.");
    }

    const code = authCodes.get(input.code);
    if (!code || code.expiresAt <= now()) throw new Error("Invalid or expired authorization code.");
    if (code.clientId !== input.client_id) throw new Error("client_id does not match authorization code.");
    if (code.redirectUri !== input.redirect_uri) throw new Error("redirect_uri does not match authorization code.");
    if (!constantTimeEqual(pkceS256(input.code_verifier), code.codeChallenge)) throw new Error("PKCE verification failed.");

    authCodes.delete(input.code);
    saveState();
    return issueTokens(code.clientId, code.scope, config, code.userId);
  }

  if (input.grant_type === "refresh_token") {
    if (!input.refresh_token) throw new Error("refresh_token grant requires refresh_token.");
    const refresh = refreshTokens.get(input.refresh_token);
    if (!refresh) throw new Error("Invalid refresh token.");
    if (input.client_id && input.client_id !== refresh.clientId) throw new Error("client_id does not match refresh token.");
    // Rotate: a refresh token is single-use, so a captured one cannot be replayed indefinitely.
    refreshTokens.delete(input.refresh_token);
    return issueTokens(refresh.clientId, refresh.scope, config, refresh.userId);
  }

  throw new Error("Unsupported grant_type.");
}

function issueTokens(clientId: string, scope: string, config: OAuthConfig, userId?: string): Record<string, unknown> {
  const accessToken = randomToken("access");
  const refreshToken = randomToken("refresh");
  accessTokens.set(accessToken, {
    token: accessToken,
    clientId,
    scope,
    expiresAt: now() + config.accessTokenTtlSeconds * 1000,
    userId
  });
  refreshTokens.set(refreshToken, {
    token: refreshToken,
    clientId,
    scope,
    userId
  });
  clientStats.set(clientId, {
    ...clientStats.get(clientId),
    lastUsedAt: new Date().toISOString(),
    requestCount: clientStats.get(clientId)?.requestCount ?? 0
  });
  saveState();

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: config.accessTokenTtlSeconds,
    refresh_token: refreshToken,
    scope
  };
}

export function revokeToken(rawBody: unknown): void {
  const body = rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {};
  const token = typeof body.token === "string" ? body.token : undefined;
  if (!token) return;
  accessTokens.delete(token);
  refreshTokens.delete(token);
  saveState();
}

export function revokeClient(clientId: string): void {
  clients.delete(clientId);
  clientStats.delete(clientId);
  for (const [code, record] of authCodes.entries()) {
    if (record.clientId === clientId) authCodes.delete(code);
  }
  for (const [token, record] of accessTokens.entries()) {
    if (record.clientId === clientId) accessTokens.delete(token);
  }
  for (const [token, record] of refreshTokens.entries()) {
    if (record.clientId === clientId) refreshTokens.delete(token);
  }
  saveState();
}

export function isValidAccessToken(token: string | undefined): boolean {
  cleanupExpired();
  if (!token) return false;
  const accessToken = accessTokens.get(token);
  return Boolean(accessToken && accessToken.expiresAt > now());
}

export function getClientIdForAccessToken(token: string | undefined): string | undefined {
  cleanupExpired();
  if (!token) return undefined;
  const accessToken = accessTokens.get(token);
  return accessToken && accessToken.expiresAt > now() ? accessToken.clientId : undefined;
}

export function getUserIdForClient(clientId: string | undefined): string | undefined {
  if (!clientId) return undefined;
  return clients.get(clientId)?.ownerUserId;
}

export function getUserIdForAccessToken(token: string | undefined): string | undefined {
  cleanupExpired();
  if (token) {
    const record = accessTokens.get(token);
    // Tenant is resolved from the token's own approver. Fall back to the client owner only for
    // legacy tokens issued before per-token userId binding (they expire within the access TTL).
    if (record && record.expiresAt > now() && record.userId) return record.userId;
  }
  return getUserIdForClient(getClientIdForAccessToken(token));
}

export function getOAuthClientStatus(clientId: string): OAuthClientStatus | undefined {
  return listOAuthClientStatus().find((client) => client.clientId === clientId);
}

export function assignUnownedClientsToUser(ownerUserId: string): number {
  let changed = 0;
  for (const client of clients.values()) {
    if (!client.ownerUserId) {
      client.ownerUserId = ownerUserId;
      changed += 1;
    }
  }
  if (changed > 0) saveState();
  return changed;
}

export function recordClientUse(clientId: string): void {
  const current = clientStats.get(clientId);
  clientStats.set(clientId, {
    lastUsedAt: new Date().toISOString(),
    requestCount: (current?.requestCount ?? 0) + 1
  });
  saveState();
}

export function listOAuthClientStatus(): OAuthClientStatus[] {
  cleanupExpired();
  return Array.from(clients.values()).map((client) => {
    const stats = clientStats.get(client.clientId);
    const redirectHost = client.redirectUris[0] ? new URL(client.redirectUris[0]).host : "-";
    let activeAccessTokenCount = 0;
    let refreshTokenCount = 0;
    for (const token of accessTokens.values()) {
      if (token.clientId === client.clientId) activeAccessTokenCount += 1;
    }
    for (const token of refreshTokens.values()) {
      if (token.clientId === client.clientId) refreshTokenCount += 1;
    }
    return {
      clientId: client.clientId,
      clientName: client.clientName,
      redirectHost,
      ownerUserId: client.ownerUserId,
      activeAccessTokens: activeAccessTokenCount,
      refreshTokens: refreshTokenCount,
      lastUsedAt: stats?.lastUsedAt,
      requestCount: stats?.requestCount ?? 0
    };
  });
}
