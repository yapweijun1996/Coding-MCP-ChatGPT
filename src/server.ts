import express from "express";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { recordActivity } from "./activity.js";
import { readArtifact } from "./artifacts/store.js";
import { readSessionIdFromRequest, registerAdminApi } from "./admin-api.js";
import { renderPublicSharePage, type PublicShareLocale } from "./admin.js";
import { getJob } from "./jobs/store.js";
import { toolDefinitions } from "./mcp/registry.js";
import { callTool } from "./mcp/router.js";
import type { ToolResult } from "./mcp/types.js";
import { closeAllBrowserSessions } from "./mcp/tools/browser.js";
import {
  createAuthorizationRedirectForUser,
  assignUnownedClientsToUser,
  exchangeToken,
  getClientIdForAccessToken,
  getUserIdForAccessToken,
  initializeOAuthState,
  isValidAccessToken,
  parseAuthorizeParams,
  recordClientUse,
  registerClient,
  renderConsentPage,
  revokeToken,
  validateAuthorizeRequest,
  type AuthorizeParams,
  type OAuthConfig
} from "./oauth.js";
import { renderPreviewPage } from "./preview.js";
import {
  getProject,
  getProjectFileContentType,
  getProjectStoredFilePath,
  isProjectTextFilePath,
  listProjects,
  readProjectFile,
} from "./projects/store.js";
import { readShareArtifact } from "./share/store.js";
import { getBlogPostBySlug, getBlogTheme, initializeBlogStore, listBlogPosts } from "./blog/store.js";
import { renderBlogIndex, renderBlogPost, renderBlogRss } from "./blog/render.js";
import { getHomepage, initializeSiteState } from "./site/store.js";
import { initializeSkillState } from "./skills/state.js";
import {
  consumeVisibleBrowserExpiredCleanup,
  isVisibleBrowserControlEnabled,
  isVisibleBrowserToolName,
  visibleBrowserToolNames
} from "./special-tools.js";
import { getToolAccess, isToolEffectivelyEnabled, listEffectiveToolStates } from "./tool-state.js";
import {
  getAllProjectRoots,
  getProjectRootForUser,
  getWorkspaceRootForUser,
  getPublicShareBasePathForUser,
  getSession as getUserSession,
  getUserByEmail,
  getUserById,
  getUserByProjectRoot,
  getUserByUsername,
  initializeUserStore
} from "./user-store.js";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

export const app = express();

const port = Number.parseInt(process.env.PORT ?? "6859", 10);
const host = process.env.HOST ?? "127.0.0.1";
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "https://gmb01.xyz";
const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
const shareRoot = process.env.SHARE_ROOT ?? `${workspaceRoot}/.shares`;
const artifactRoot = process.env.ARTIFACT_ROOT ?? `${workspaceRoot}/.artifacts`;
const projectRoot = process.env.PROJECT_ROOT ?? `${workspaceRoot}/.projects`;
const usersRoot = process.env.USERS_ROOT ?? `${workspaceRoot}/.users`;
const userStatePath = process.env.USER_STATE_PATH ?? `${workspaceRoot}/.state/users-state.json`;
const skillStatePath = process.env.SKILL_STATE_PATH ?? `${workspaceRoot}/.state/skill-state.json`;
const siteStatePath = process.env.SITE_STATE_PATH ?? `${workspaceRoot}/.state/site-state.json`;
const blogStatePath = process.env.BLOG_STATE_PATH ?? `${workspaceRoot}/.state/blog-state.json`;
const commandTimeoutMs = Number.parseInt(process.env.COMMAND_TIMEOUT_MS ?? "30000", 10);
const devToken = process.env.MCP_DEV_TOKEN;
const adminPasscode = process.env.ADMIN_PASSCODE ?? process.env.KB_MCP_OAUTH_PASSCODE ?? "";
const oauthConfig: OAuthConfig = {
  issuer: process.env.KB_MCP_OAUTH_ISSUER ?? publicBaseUrl,
  ownerPasscode: process.env.KB_MCP_OAUTH_PASSCODE ?? "",
  accessTokenTtlSeconds: Number.parseInt(process.env.OAUTH_ACCESS_TOKEN_TTL_SECONDS ?? "3600", 10),
  authCodeTtlSeconds: Number.parseInt(process.env.OAUTH_AUTH_CODE_TTL_SECONDS ?? "300", 10),
  statePath: process.env.OAUTH_STATE_PATH ?? `${workspaceRoot}/.state/oauth-state.json`
};
initializeOAuthState(oauthConfig.statePath);
initializeSkillState(skillStatePath);
initializeSiteState(siteStatePath);
await initializeBlogStore({ databaseUrl: process.env.DATABASE_URL, statePath: blogStatePath });
await initializeUserStore({
  databaseUrl: process.env.DATABASE_URL,
  statePath: userStatePath,
  projectRoot,
  usersRoot,
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  fallbackAdminPasscode: adminPasscode,
  sessionTtlMs: 8 * 60 * 60 * 1000
});
const legacyUser = await getUserByEmail("legacy-user@local");
if (legacyUser) assignUnownedClientsToUser(legacyUser.id);

const adminDistPath = process.env.ADMIN_UI_DIST ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../admin-ui/dist");

app.use(express.json({ limit: "40mb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

function jsonRpcResult(id: JsonRpcRequest["id"], result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// Express 4 does not catch rejections from async route handlers — an unhandled
// rejection there hangs the request and (without a process guard) can crash the
// process. Wrap async handlers so any rejection is forwarded to the error middleware.
function asyncRoute(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function getBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

interface McpAuth {
  clientId: string;
  userId?: string;
  projectRoot: string;
  workspaceRoot: string;
  publicShareBasePath?: string;
}

async function requireMcpAuth(req: express.Request, res: express.Response): Promise<McpAuth | undefined> {
  const token = getBearerToken(req.header("authorization"));
  const clientId = getClientIdForAccessToken(token);
  if (token && isValidAccessToken(token) && clientId) {
    recordClientUse(clientId);
    const userId = getUserIdForAccessToken(token);
    if (userId) {
      const user = await getUserById(userId);
      if (!user || user.status !== "active") {
        res
          .status(401)
          .setHeader("WWW-Authenticate", `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource/mcp"`)
          .json({ ok: false, error: "Unauthorized" });
        return undefined;
      }
      return {
        clientId,
        userId,
        projectRoot: await getProjectRootForUser(userId),
        workspaceRoot: await getWorkspaceRootForUser(userId),
        publicShareBasePath: getPublicShareBasePathForUser(user)
      };
    }
    // Legacy token without a bound user: falls back to the global roots. These clients
    // are migrated to the legacy user on startup, so this path is an edge case only.
    return { clientId, projectRoot, workspaceRoot };
  }
  if (devToken && token === devToken) return { clientId: "dev-token", projectRoot, workspaceRoot };

  res
    .status(401)
    .setHeader("WWW-Authenticate", `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource/mcp"`)
    .json({ ok: false, error: "Unauthorized" });
  return undefined;
}

function asJsonRpcRequest(value: unknown): JsonRpcRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0" || typeof record.method !== "string") return undefined;
  const id = typeof record.id === "string" || typeof record.id === "number" || record.id === null || record.id === undefined ? record.id : null;
  return {
    jsonrpc: "2.0",
    id,
    method: record.method,
    params: record.params
  };
}

function resultToMcpContent(result: ToolResult): Record<string, unknown> {
  const response: Record<string, unknown> = {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ],
    isError: !result.ok
  };
  if (result.structuredContent) response.structuredContent = result.structuredContent;
  return response;
}

async function cleanupExpiredVisibleBrowserControl(): Promise<void> {
  if (!consumeVisibleBrowserExpiredCleanup()) return;
  const closed = await closeAllBrowserSessions();
  recordActivity({
    clientId: "system",
    method: "special-tools/expired",
    toolName: "visible_browser_control",
    ok: true,
    summary: `Visible browser control expired. Closed ${closed.length} browser session(s).`
  });
}

function getPublicShareLocale(req: express.Request): PublicShareLocale {
  if (req.query.lang === "zh" || req.query.lang === "en") return req.query.lang;
  const preferredLanguage = req.acceptsLanguages("zh-CN", "zh", "en");
  return typeof preferredLanguage === "string" && preferredLanguage.startsWith("zh") ? "zh" : "en";
}

function injectCanonicalLink(html: string, canonicalUrl: string): string {
  const link = `<link rel="canonical" href="${canonicalUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`;
  if (/<link\s+[^>]*rel=["']canonical["'][^>]*>/i.test(html)) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${link}</head>`);
  return `${link}\n${html}`;
}

async function sendPublishedProjectFile(res: express.Response, root: string, projectId: string, filename: string, canonicalUrl?: string): Promise<boolean> {
  const project = await getProject(root, projectId);
  if (project.status !== "published") return false;
  const contentType = getProjectFileContentType(filename);
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
  if (canonicalUrl && contentType === "text/html") res.setHeader("Link", `<${canonicalUrl}>; rel="canonical"`);
  if (isProjectTextFilePath(filename)) {
    const content = await readProjectFile(root, project.id, filename, 1024 * 1024);
    res.type(contentType).send(contentType === "text/html" && canonicalUrl ? injectCanonicalLink(content, canonicalUrl) : content);
    return true;
  }

  const absolutePath = await getProjectStoredFilePath(root, project.id, filename);
  res.type(contentType).sendFile(absolutePath, (error) => {
    if (error && !res.headersSent) {
      res.status(404).type("text/plain").send("Share not found.");
    }
  });
  return true;
}

const homepageCsp = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:; base-uri 'none'; form-action 'self';";

async function serveHomepageFile(res: express.Response, relativePath?: string): Promise<boolean> {
  const home = getHomepage();
  if (!home.homeProjectId || !home.homeOwnerUserId) return false;
  try {
    const root = await getProjectRootForUser(home.homeOwnerUserId);
    const project = await getProject(root, home.homeProjectId);
    if (project.status !== "published") return false;
    const filename = relativePath && relativePath !== "/" ? relativePath.replace(/^\/+/, "") : project.entryFile;
    res.setHeader("Content-Security-Policy", homepageCsp);
    return await sendPublishedProjectFile(res, root, home.homeProjectId, filename, `${publicBaseUrl.replace(/\/$/, "")}/`);
  } catch {
    return false;
  }
}

function renderDefaultLanding(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coding MCP</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, sans-serif; background: #0f1511; color: #e8efe9; }
  main { text-align: center; padding: 32px; }
  h1 { font-size: clamp(28px, 5vw, 44px); margin: 0 0 12px; }
  p { color: #9fb0a4; margin: 0 0 24px; }
  a { display: inline-block; margin: 6px; padding: 11px 18px; border-radius: 8px; text-decoration: none; font-weight: 650; }
  .primary { background: #16615a; color: #fff; }
  .ghost { border: 1px solid #2c3a31; color: #cfe0d4; }
</style>
</head>
<body>
  <main>
    <h1>Coding MCP</h1>
    <p>No homepage has been published yet.</p>
    <a class="primary" href="/admin">Admin console</a>
    <a class="ghost" href="/blog/">Blog</a>
    <a class="ghost" href="/share">Public projects</a>
  </main>
</body>
</html>`;
}

app.get("/", asyncRoute(async (_req, res) => {
  if (await serveHomepageFile(res)) return;
  res.type("html").send(renderDefaultLanding());
}));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: "0.1.0",
    service: "coding-mcp-chatgpt"
  });
});

app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
  res.json({
    resource: `${publicBaseUrl}/mcp`,
    authorization_servers: [publicBaseUrl],
    bearer_methods_supported: ["header"],
    resource_name: "Coding MCP ChatGPT"
  });
});

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: oauthConfig.issuer,
    authorization_endpoint: `${publicBaseUrl}/authorize`,
    token_endpoint: `${publicBaseUrl}/token`,
    registration_endpoint: `${publicBaseUrl}/register`,
    revocation_endpoint: `${publicBaseUrl}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"]
  });
});

function appOrigin(): string {
  try {
    return new URL(publicBaseUrl).origin;
  } catch {
    return "";
  }
}

function isSameOriginRequest(req: express.Request): boolean {
  const expected = appOrigin();
  const origin = req.header("origin");
  if (origin) return origin === expected;
  // Fall back to Referer when Origin is absent (older clients/proxies).
  const referer = req.header("referer");
  if (referer) {
    try {
      return new URL(referer).origin === expected;
    } catch {
      return false;
    }
  }
  // No Origin and no Referer: cannot prove same-origin; the CSRF token check still applies.
  return true;
}

function isValidCsrfToken(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

app.get("/authorize", asyncRoute(async (req, res) => {
  const params = parseAuthorizeParams(req);
  if (!params) {
    res.status(400).send("Invalid authorization request.");
    return;
  }
  const session = await getUserSession(readSessionIdFromRequest(req));
  if (!session) {
    res.redirect(302, `/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    return;
  }

  const validation = validateAuthorizeRequest(params);
  const switchAccountUrl = `/admin/login?next=${encodeURIComponent(req.originalUrl)}`;
  res.type("html").send(renderConsentPage(params, validation, { email: session.user.email, role: session.user.role }, switchAccountUrl, session.session.csrfToken));
}));

app.post("/oauth/approve", asyncRoute(async (req, res) => {
  const session = await getUserSession(readSessionIdFromRequest(req));
  if (!session) {
    res.redirect(302, `/admin/login?next=${encodeURIComponent("/authorize")}`);
    return;
  }
  // Defense-in-depth: reject cross-origin POSTs. The session cookie is SameSite=Lax,
  // but published content is served from this same origin, so also require an explicit
  // per-session CSRF token. (Full isolation requires serving shares from a separate origin.)
  if (!isSameOriginRequest(req)) {
    res.status(403).type("text/plain").send("Cross-origin authorization is not allowed.");
    return;
  }
  const body = req.body as Partial<Record<string, string>>;
  const suppliedCsrf = body.csrf_token ?? "";
  if (!isValidCsrfToken(suppliedCsrf, session.session.csrfToken)) {
    res.status(403).type("text/plain").send("Invalid or missing CSRF token.");
    return;
  }
  const params: AuthorizeParams = {
    responseType: body.responseType ?? body.response_type ?? "",
    clientId: body.clientId ?? body.client_id ?? "",
    redirectUri: body.redirectUri ?? body.redirect_uri ?? "",
    state: body.state,
    scope: body.scope ?? "",
    codeChallenge: body.codeChallenge ?? body.code_challenge ?? "",
    codeChallengeMethod: body.codeChallengeMethod ?? body.code_challenge_method ?? ""
  };

  try {
    const redirectUrl = createAuthorizationRedirectForUser(params, session.user.id, oauthConfig);
    res.redirect(302, redirectUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Authorization failed.";
    const switchAccountUrl = `/admin/login?next=${encodeURIComponent("/authorize")}`;
    res.status(400).type("html").send(renderConsentPage(params, message, { email: session.user.email, role: session.user.role }, switchAccountUrl, session.session.csrfToken));
  }
}));

app.post("/token", (req, res) => {
  try {
    res.json(exchangeToken(req.body, oauthConfig));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Token exchange failed.";
    res.status(400).json({ error: "invalid_grant", error_description: message });
  }
});

app.post("/register", (req, res) => {
  try {
    res.status(201).json(registerClient(req.body));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Client registration failed.";
    res.status(400).json({ error: "invalid_client_metadata", error_description: message });
  }
});

app.post("/revoke", (req, res) => {
  revokeToken(req.body);
  res.status(200).json({ ok: true });
});

app.post("/mcp", asyncRoute(async (req, res) => {
  const auth = await requireMcpAuth(req, res);
  if (!auth) return;
  const { clientId, userId } = auth;
  await cleanupExpiredVisibleBrowserControl();

  const request = asJsonRpcRequest(req.body);
  if (!request) {
    recordActivity({ userId, clientId, method: "invalid", ok: false, summary: "Invalid JSON-RPC request." });
    res.status(400).json(jsonRpcError(null, -32600, "Invalid JSON-RPC request."));
    return;
  }

  if (request.method === "initialize") {
    res.json(jsonRpcResult(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: "coding-mcp-chatgpt",
        version: "0.1.0"
      }
    }));
    return;
  }

  if (request.method === "tools/list") {
    recordActivity({ userId, clientId, method: request.method, ok: true, summary: "Listed tools." });
    const enabledToolNames = new Set(listEffectiveToolStates().filter((tool) => tool.enabled && !isVisibleBrowserToolName(tool.name)).map((tool) => tool.name));
    if (isVisibleBrowserControlEnabled()) {
      for (const name of visibleBrowserToolNames) enabledToolNames.add(name);
    }
    res.json(jsonRpcResult(request.id, { tools: toolDefinitions.filter((tool) => enabledToolNames.has(tool.name)) }));
    return;
  }

  if (request.method === "tools/call") {
    const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
    const name = typeof params.name === "string" ? params.name : undefined;
    if (!name) {
      recordActivity({ userId, clientId, method: request.method, ok: false, summary: "Missing tool name." });
      res.json(jsonRpcError(request.id, -32602, "tools/call requires params.name."));
      return;
    }
    if (isVisibleBrowserToolName(name) && !isVisibleBrowserControlEnabled()) {
      recordActivity({ userId, clientId, method: request.method, toolName: name, ok: false, summary: "Visible browser control is off." });
      res.json(jsonRpcError(request.id, -32603, "Tool is disabled: visible browser control is off"));
      return;
    }
    if (!isVisibleBrowserToolName(name) && !isToolEffectivelyEnabled(name)) {
      const access = getToolAccess(name);
      const summary = access.access === "blocked_by_skill" ? "Tool is disabled by skill catalog." : "Tool is disabled.";
      recordActivity({ userId, clientId, method: request.method, toolName: name, ok: false, summary });
      res.json(jsonRpcError(request.id, -32603, access.access === "blocked_by_skill" ? `Tool is disabled by skill catalog: ${name}` : `Tool is disabled: ${name}`));
      return;
    }

    const result = await callTool(name, params.arguments ?? {}, {
      publicBaseUrl,
      workspaceRoot: auth.workspaceRoot,
      commandTimeoutMs,
      shareRoot,
      artifactRoot,
      projectRoot: auth.projectRoot,
      clientId,
      userId,
      publicShareBasePath: auth.publicShareBasePath
    });
    recordActivity({ userId, clientId, method: request.method, toolName: name, ok: result.ok, summary: result.summary });
    res.json(jsonRpcResult(request.id, resultToMcpContent(result)));
    return;
  }

  recordActivity({ userId, clientId, method: request.method, ok: false, summary: "Method not found." });
  res.json(jsonRpcError(request.id, -32601, `Method not found: ${request.method}`));
}));

registerAdminApi(app, {
  adminPasscode,
  publicBaseUrl,
  projectRoot,
  workspaceRoot,
  shareRoot,
  artifactRoot
});

app.use("/admin/assets", express.static(path.join(adminDistPath, "assets"), {
  immutable: true,
  maxAge: "1y"
}));

app.get(/^\/admin(?:\/.*)?$/, (req, res, next) => {
  if (req.path.startsWith("/admin/api")) {
    next();
    return;
  }
  res.sendFile(path.join(adminDistPath, "index.html"), (error) => {
    if (error && !res.headersSent) {
      res.status(503).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin UI unavailable</title><style>body{font-family:ui-sans-serif,system-ui,sans-serif;background:#f4f6f8;color:#18231f;margin:0}main{width:min(520px,calc(100vw - 32px));margin:72px auto;background:#fff;border:1px solid #dce3df;border-radius:8px;padding:24px}code{background:#eef3f0;padding:2px 5px;border-radius:4px}</style></head><body><main><h1>Admin UI is not built</h1><p>Run <code>npm run build:admin</code> or <code>npm run build</code>, then restart the server.</p></main></body></html>`);
    }
  });
});

app.get(["/share", "/share/"], asyncRoute(async (req, res) => {
  try {
    const roots = await getAllProjectRoots();
    const projects = (await Promise.all(roots.map((root) => listProjects(root, false).catch(() => [])))).flat().filter((project) => project.status === "published");
    res.type("html").send(renderPublicSharePage({
      publicBaseUrl,
      projects,
      locale: getPublicShareLocale(req)
    }));
  } catch {
    res.status(500).type("text/plain").send("Unable to load public share index.");
  }
}));

app.get("/outcome/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).send("Outcome not found.");
    return;
  }

  res.type("html").send(renderPreviewPage(job));
});

app.get("/@:username", asyncRoute(async (req, res) => {
  try {
    const user = await getUserByUsername(req.params.username);
    if (!user?.username || !user.publicShareUsernameEnabled || !user.projectRoot) {
      res.status(404).type("text/plain").send("Public profile not found.");
      return;
    }
    const projects = (await listProjects(user.projectRoot, false)).filter((project) => project.status === "published");
    res.type("html").send(renderPublicSharePage({
      publicBaseUrl,
      projects,
      locale: getPublicShareLocale(req)
    }));
  } catch {
    res.status(404).type("text/plain").send("Public profile not found.");
  }
}));

app.get("/@:username/share/:shareId/:filename(*)", asyncRoute(async (req, res) => {
  try {
    const user = await getUserByUsername(req.params.username);
    if (!user?.username || !user.publicShareUsernameEnabled || !user.projectRoot) {
      res.status(404).type("text/plain").send("Share not found.");
      return;
    }
    const canonicalUrl = `${publicBaseUrl.replace(/\/$/, "")}/@${user.username}/share/${req.params.shareId}/${req.params.filename}`;
    if (await sendPublishedProjectFile(res, user.projectRoot, req.params.shareId, req.params.filename, canonicalUrl)) return;
  } catch {
    // Fall through to 404.
  }
  if (!res.headersSent) res.status(404).type("text/plain").send("Share not found.");
}));

app.get("/share/:shareId/:filename(*)", asyncRoute(async (req, res) => {
  try {
    for (const root of await getAllProjectRoots()) {
      try {
        const owner = await getUserByProjectRoot(root);
        const canonicalBase = getPublicShareBasePathForUser(owner);
        const canonicalUrl = `${publicBaseUrl.replace(/\/$/, "")}${canonicalBase}/${req.params.shareId}/${req.params.filename}`;
        if (await sendPublishedProjectFile(res, root, req.params.shareId, req.params.filename, canonicalUrl)) return;
      } catch {
        continue;
      }
    }
  } catch {
    // Not a published project share; fall back to legacy standalone shares.
  }

  const artifact = await readShareArtifact(req.params.shareId, req.params.filename);
  if (!artifact || artifact.record.filename !== req.params.filename) {
    res.status(404).type("text/plain").send("Share not found.");
    return;
  }
  res.setHeader("Content-Security-Policy", "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; base-uri 'none'; form-action 'self';");
  res.type("html").send(artifact.html);
}));

app.get("/artifact/:artifactId/:filename(*)", asyncRoute(async (req, res) => {
  try {
    const artifact = await readArtifact(artifactRoot, req.params.artifactId, req.params.filename);
    if (!artifact) {
      res.status(404).type("text/plain").send("Artifact not found.");
      return;
    }
    res.type(artifact.record.contentType).send(artifact.content);
  } catch {
    res.status(404).type("text/plain").send("Artifact not found.");
  }
}));

const blogCsp = "default-src 'self' 'unsafe-inline' data: https:; base-uri 'none'; form-action 'self';";

app.get(["/blog", "/blog/"], asyncRoute(async (_req, res) => {
  const [posts, theme] = await Promise.all([listBlogPosts({ status: "published" }), getBlogTheme()]);
  res.setHeader("Content-Security-Policy", blogCsp);
  res.type("html").send(renderBlogIndex(posts, theme));
}));

app.get("/blog/rss.xml", asyncRoute(async (_req, res) => {
  const [posts, theme] = await Promise.all([listBlogPosts({ status: "published" }), getBlogTheme()]);
  res.type("application/rss+xml").send(renderBlogRss(posts, theme, publicBaseUrl));
}));

app.get("/blog/:slug", asyncRoute(async (req, res) => {
  const post = await getBlogPostBySlug(req.params.slug);
  if (!post || post.status !== "published") {
    res.status(404).type("text/plain").send("Post not found.");
    return;
  }
  const theme = await getBlogTheme();
  res.setHeader("Content-Security-Policy", blogCsp);
  res.type("html").send(renderBlogPost(post, theme));
}));

// Fallback: serve root-level assets of the homepage project (e.g. /styles.css, /assets/app.js).
// Registered last so it never shadows a named route; falls through to 404 when no homepage is set.
app.get("/:asset(*)", asyncRoute(async (req, res) => {
  if (await serveHomepageFile(res, req.params.asset)) return;
  res.status(404).type("text/plain").send("Not found.");
}));

// Terminal error middleware. Registered last so it catches anything forwarded by
// asyncRoute (or thrown synchronously) instead of letting the request hang.
app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`Request failed: ${req.method} ${req.originalUrl}`, error);
  if (res.headersSent) return;
  if (req.path === "/mcp") {
    res.status(500).json(jsonRpcError(null, -32603, "Internal server error."));
    return;
  }
  res.status(500).type("text/plain").send("Internal server error.");
});

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // Last-resort guards. An unhandled rejection is usually a missed catch in one
  // request — log it and keep serving. An uncaught exception leaves process state
  // undefined (half-mutated stores, leaked handles), so log and exit; PM2
  // (autorestart: true in ecosystem.config.cjs) brings a clean process back.
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception, exiting for a clean restart:", error);
    process.exit(1);
  });

  const server = app.listen(port, host, () => {
    console.log(`coding-mcp-chatgpt listening on http://${host}:${port}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);
    server.close(() => console.log("HTTP server closed."));
    try {
      const closed = await closeAllBrowserSessions();
      if (closed.length) console.log(`Closed ${closed.length} browser session(s).`);
    } catch (error) {
      console.error("Error while closing browser sessions:", error);
    }
    // Give the server a moment to drain, then exit.
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
