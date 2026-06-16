import { ZipArchive } from "archiver";
import express from "express";
import { listActivity, recordActivity } from "./activity.js";
import { renderAdminPage, renderProjectPage } from "./admin.js";
import { countJobs, getJob } from "./jobs/store.js";
import { toolDefinitions } from "./mcp/registry.js";
import { callTool } from "./mcp/router.js";
import type { ToolResult } from "./mcp/types.js";
import {
  createAuthorizationRedirect,
  exchangeToken,
  getClientIdForAccessToken,
  initializeOAuthState,
  isValidAccessToken,
  listOAuthClientStatus,
  parseAuthorizeParams,
  recordClientUse,
  registerClient,
  renderConsentPage,
  revokeToken,
  revokeClient,
  validateAuthorizeRequest,
  type AuthorizeParams,
  type OAuthConfig
} from "./oauth.js";
import { renderPreviewPage } from "./preview.js";
import {
  countProjects,
  deleteProject,
  getProject,
  getProjectFilesDirectory,
  getProjectWithFiles,
  listProjects,
  readProjectFile
} from "./projects/store.js";
import { countShares, readShareArtifact } from "./share/store.js";
import { isToolEnabled, listToolStates, setToolEnabled } from "./tool-state.js";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

const app = express();

const port = Number.parseInt(process.env.PORT ?? "6859", 10);
const host = process.env.HOST ?? "127.0.0.1";
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "https://gmb01.xyz";
const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
const shareRoot = process.env.SHARE_ROOT ?? `${workspaceRoot}/.shares`;
const projectRoot = process.env.PROJECT_ROOT ?? `${workspaceRoot}/.projects`;
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

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

function jsonRpcResult(id: JsonRpcRequest["id"], result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function getBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function requireMcpAuth(req: express.Request, res: express.Response): string | undefined {
  const token = getBearerToken(req.header("authorization"));
  const clientId = getClientIdForAccessToken(token);
  if (token && isValidAccessToken(token) && clientId) {
    recordClientUse(clientId);
    return clientId;
  }
  if (devToken && token === devToken) return "dev-token";

  res
    .status(401)
    .setHeader("WWW-Authenticate", `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource/mcp"`)
    .json({ ok: false, error: "Unauthorized" });
  return undefined;
}

function requireAdmin(req: express.Request, res: express.Response): boolean {
  const token = req.query.token;
  if (adminPasscode && token === adminPasscode) return true;

  res.status(401).type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin Login</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;background:#f4f5f1;margin:0;color:#17211b}main{width:min(420px,calc(100vw - 32px));margin:72px auto;background:white;border:1px solid #d5dbd2;border-radius:8px;padding:24px}input,button{width:100%;box-sizing:border-box;font:inherit;padding:11px;border-radius:6px}input{border:1px solid #bdc5b8}button{margin-top:14px;border:0;background:#12645d;color:white}</style></head>
<body><main><h1>Admin Login</h1><form method="get" action="/admin"><input name="token" type="password" placeholder="Admin passcode" autofocus><button type="submit">Open admin</button></form></main></body></html>`);
  return false;
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
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ],
    isError: !result.ok
  };
}

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

app.get("/authorize", (req, res) => {
  const params = parseAuthorizeParams(req);
  if (!params) {
    res.status(400).send("Invalid authorization request.");
    return;
  }

  const validation = validateAuthorizeRequest(params);
  res.type("html").send(renderConsentPage(params, validation));
});

app.post("/oauth/approve", (req, res) => {
  const body = req.body as Partial<Record<string, string>>;
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
    const redirectUrl = createAuthorizationRedirect(params, body.passcode ?? "", oauthConfig);
    res.redirect(302, redirectUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Authorization failed.";
    res.status(400).type("html").send(renderConsentPage(params, message));
  }
});

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

app.post("/mcp", async (req, res) => {
  const clientId = requireMcpAuth(req, res);
  if (!clientId) return;

  const request = asJsonRpcRequest(req.body);
  if (!request) {
    recordActivity({ clientId, method: "invalid", ok: false, summary: "Invalid JSON-RPC request." });
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
    recordActivity({ clientId, method: request.method, ok: true, summary: "Listed tools." });
    const enabledToolNames = new Set(listToolStates().filter((tool) => tool.enabled).map((tool) => tool.name));
    res.json(jsonRpcResult(request.id, { tools: toolDefinitions.filter((tool) => enabledToolNames.has(tool.name)) }));
    return;
  }

  if (request.method === "tools/call") {
    const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
    const name = typeof params.name === "string" ? params.name : undefined;
    if (!name) {
      recordActivity({ clientId, method: request.method, ok: false, summary: "Missing tool name." });
      res.json(jsonRpcError(request.id, -32602, "tools/call requires params.name."));
      return;
    }
    if (!isToolEnabled(name)) {
      recordActivity({ clientId, method: request.method, toolName: name, ok: false, summary: "Tool is disabled." });
      res.json(jsonRpcError(request.id, -32603, `Tool is disabled: ${name}`));
      return;
    }

    const result = await callTool(name, params.arguments ?? {}, {
      publicBaseUrl,
      workspaceRoot,
      commandTimeoutMs,
      shareRoot,
      projectRoot,
      clientId
    });
    recordActivity({ clientId, method: request.method, toolName: name, ok: result.ok, summary: result.summary });
    res.json(jsonRpcResult(request.id, resultToMcpContent(result)));
    return;
  }

  recordActivity({ clientId, method: request.method, ok: false, summary: "Method not found." });
  res.json(jsonRpcError(request.id, -32601, `Method not found: ${request.method}`));
});

app.get("/admin", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const projects = await listProjects(projectRoot, true);
  const activeProjects = projects.filter((project) => project.status !== "deleted");
  res.type("html").send(renderAdminPage({
    publicBaseUrl,
    adminToken: adminPasscode,
    clients: listOAuthClientStatus(),
    tools: listToolStates(),
    activity: listActivity(),
    projects,
    stats: {
      jobs: countJobs(),
      shares: countShares(),
      projects: activeProjects.length,
      enabledTools: listToolStates().filter((tool) => tool.enabled).length,
      connectedClients: listOAuthClientStatus().length
    }
  }));
});

app.get("/admin/projects/:projectId", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const project = await getProjectWithFiles(projectRoot, req.params.projectId);
    const selectedPath = typeof req.query.path === "string" ? req.query.path : project.files[0]?.path;
    let selectedContent: string | undefined;
    let error: string | undefined;
    if (selectedPath) {
      try {
        selectedContent = await readProjectFile(projectRoot, req.params.projectId, selectedPath, 1024 * 1024);
      } catch (readError) {
        error = readError instanceof Error ? readError.message : "Unable to read file.";
      }
    }

    res.type("html").send(renderProjectPage({
      publicBaseUrl,
      adminToken: adminPasscode,
      project: project.metadata,
      files: project.files,
      selectedPath,
      selectedContent,
      error
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project not found.";
    res.status(404).type("html").send(message);
  }
});

app.get("/admin/projects/:projectId/files", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (typeof req.query.path !== "string") {
    res.status(400).json({ ok: false, error: "Missing path query." });
    return;
  }

  try {
    const content = await readProjectFile(projectRoot, req.params.projectId, req.query.path, 1024 * 1024);
    res.json({ ok: true, projectId: req.params.projectId, path: req.query.path, content });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read project file.";
    res.status(400).json({ ok: false, error: message });
  }
});

app.get("/admin/projects/:projectId/download.zip", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const project = await getProject(projectRoot, req.params.projectId);
    if (project.status === "deleted") {
      res.status(404).send("Project is deleted.");
      return;
    }

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on("error", (error: Error) => {
      if (!res.headersSent) res.status(500).send(error.message);
      else res.end();
    });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${project.id}.zip"`);
    archive.pipe(res);
    archive.directory(getProjectFilesDirectory(projectRoot, project.id), false);
    await archive.finalize();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to download project.";
    res.status(404).send(message);
  }
});

app.post("/admin/projects/:projectId/delete", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    await deleteProject(projectRoot, req.params.projectId);
  } catch {
    // Keep admin delete idempotent from the browser.
  }
  res.redirect(303, `/admin?token=${encodeURIComponent(adminPasscode)}`);
});

app.post("/admin/tools/toggle", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body as Partial<Record<string, string>>;
  try {
    if (!body.name) throw new Error("Missing tool name.");
    setToolEnabled(body.name, body.enabled === "1");
    res.redirect(303, `/admin?token=${encodeURIComponent(adminPasscode)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool toggle failed.";
    res.status(400).send(message);
  }
});

app.post("/admin/connectors/revoke", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body as Partial<Record<string, string>>;
  try {
    if (!body.clientId) throw new Error("Missing clientId.");
    revokeClient(body.clientId);
    res.redirect(303, `/admin?token=${encodeURIComponent(adminPasscode)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connector revoke failed.";
    res.status(400).send(message);
  }
});

app.get("/outcome/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).send("Outcome not found.");
    return;
  }

  res.type("html").send(renderPreviewPage(job));
});

app.get("/share/:shareId/:filename(*)", async (req, res) => {
  try {
    const project = await getProject(projectRoot, req.params.shareId);
    if (project.status === "published") {
      const content = await readProjectFile(projectRoot, project.id, req.params.filename, 1024 * 1024);
      const extension = req.params.filename.toLowerCase().split(".").pop();
      const contentType = extension === "css" ? "text/css" : extension === "js" ? "application/javascript" : extension === "json" ? "application/json" : extension === "svg" ? "image/svg+xml" : "text/html";
      res.type(contentType).send(content);
      return;
    }
  } catch {
    // Not a published project share; fall back to legacy standalone shares.
  }

  const artifact = await readShareArtifact(req.params.shareId, req.params.filename);
  if (!artifact || artifact.record.filename !== req.params.filename) {
    res.status(404).type("text/plain").send("Share not found.");
    return;
  }
  res.type("html").send(artifact.html);
});

app.listen(port, host, () => {
  console.log(`coding-mcp-chatgpt listening on http://${host}:${port}`);
});
