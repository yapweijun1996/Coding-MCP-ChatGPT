import type express from "express";
import { recordActivity } from "../activity.js";
import type { ServerConfig } from "../config.js";
import { toolDefinitions } from "../mcp/registry.js";
import { callTool } from "../mcp/router.js";
import type { ToolResult } from "../mcp/types.js";
import { closeAllBrowserSessions } from "../mcp/tools/browser.js";
import {
  getClientIdForAccessToken,
  getUserIdForAccessToken,
  isValidAccessToken,
  recordClientUse
} from "../oauth.js";
import {
  consumeVisibleBrowserExpiredCleanup,
  isVisibleBrowserControlEnabled,
  isVisibleBrowserToolName,
  visibleBrowserToolNames
} from "../special-tools.js";
import { getToolAccess, isToolEffectivelyEnabled, listEffectiveToolStates } from "../tool-state.js";
import {
  getProjectRootForUser,
  getWorkspaceRootForUser,
  getPublicShareBasePathForUser,
  getUserById
} from "../user-store.js";
import { asyncRoute } from "./util.js";
import { asJsonRpcRequest, jsonRpcError, jsonRpcResult } from "./json-rpc.js";

const supportedProtocolVersions = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

// Remembers which client TYPE (ChatGPT / Gemini / Claude ...) each OAuth clientId is, from
// the clientInfo it sends on initialize, so every subsequent tools/call can be tagged with
// it. clientId alone is an opaque OAuth id; clientType is the per-client analytic the
// multi-client setup actually needs. In-memory: rebuilt whenever a client re-initializes.
const clientTypeById = new Map<string, string>();
const maxArgsPreviewChars = 4000;

// Bounded preview of tool arguments for telemetry: returns the byte size of the full input
// plus a preview that is truncated so a large payload (e.g. a base64 asset upload) can never
// bloat the telemetry log.
function previewArgs(value: unknown): { inputBytes: number; preview: unknown } {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return { inputBytes: 0, preview: "[unserializable]" };
  }
  const inputBytes = Buffer.byteLength(serialized, "utf8");
  if (serialized.length > maxArgsPreviewChars) {
    return { inputBytes, preview: `${serialized.slice(0, maxArgsPreviewChars)}...[truncated ${serialized.length} chars]` };
  }
  return { inputBytes, preview: value };
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

export function registerMcpRoutes(app: express.Express, config: ServerConfig): void {
  const { publicBaseUrl, projectRoot, workspaceRoot, shareRoot, artifactRoot, feedbackRoot, commandTimeoutMs, devToken } = config;

  function unauthorized(res: express.Response): undefined {
    res
      .status(401)
      .setHeader("WWW-Authenticate", `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource/mcp"`)
      .json({ ok: false, error: "Unauthorized" });
    return undefined;
  }

  async function requireMcpAuth(req: express.Request, res: express.Response): Promise<McpAuth | undefined> {
    const token = getBearerToken(req.header("authorization"));
    const clientId = getClientIdForAccessToken(token);
    if (token && isValidAccessToken(token) && clientId) {
      recordClientUse(clientId);
      const userId = getUserIdForAccessToken(token);
      if (userId) {
        const user = await getUserById(userId);
        if (!user || user.status !== "active") return unauthorized(res);
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
    return unauthorized(res);
  }

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

    // JSON-RPC notifications carry no id and MUST NOT receive a response body. MCP clients
    // (Claude Desktop/Code, Gemini) send notifications/initialized right after initialize and
    // notifications/cancelled mid-call; replying with a "Method not found" error to a
    // notification breaks stricter clients. Acknowledge with 202 and an empty body.
    if (request.id === undefined && request.method.startsWith("notifications/")) {
      res.status(202).end();
      return;
    }

    // Keepalive ping is a request (has an id) and expects an empty result object.
    if (request.method === "ping") {
      res.json(jsonRpcResult(request.id, {}));
      return;
    }

    if (request.method === "initialize") {
      // Remember the client type for telemetry tagging of later calls on this clientId.
      const params = request.params as { protocolVersion?: unknown; clientInfo?: { name?: unknown; version?: unknown } } | undefined;
      const clientInfo = params?.clientInfo;
      if (clientInfo && typeof clientInfo.name === "string") {
        const version = typeof clientInfo.version === "string" ? ` ${clientInfo.version}` : "";
        clientTypeById.set(clientId, `${clientInfo.name}${version}`.slice(0, 80));
      }
      const clientType = clientTypeById.get(clientId);
      recordActivity({ clientId, userId, clientType, method: "initialize", ok: true, summary: `Client initialized: ${clientType ?? "unknown"}` });
      // Echo the client's requested protocol version when we support it, otherwise fall back
      // to our floor. This server is a stateless tools-only request/response endpoint that is
      // compatible with every published MCP revision, so honoring the client's version avoids
      // forcing a downgrade on newer Claude/Gemini clients.
      const requestedVersion = typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;
      const protocolVersion = requestedVersion && supportedProtocolVersions.has(requestedVersion) ? requestedVersion : "2024-11-05";
      res.json(jsonRpcResult(request.id, {
        protocolVersion,
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

      const toolArgs = params.arguments ?? {};
      const clientType = clientTypeById.get(clientId);
      const { inputBytes, preview } = previewArgs(toolArgs);
      const startedAt = Date.now();
      try {
        const result = await callTool(name, toolArgs, {
          publicBaseUrl,
          workspaceRoot: auth.workspaceRoot,
          commandTimeoutMs,
          shareRoot,
          artifactRoot,
          feedbackRoot,
          projectRoot: auth.projectRoot,
          clientId,
          userId,
          publicShareBasePath: auth.publicShareBasePath
        });
        recordActivity({
          userId,
          clientId,
          clientType,
          method: request.method,
          toolName: name,
          ok: result.ok,
          summary: result.summary,
          durationMs: Date.now() - startedAt,
          inputBytes,
          args: preview,
          errorMessage: result.ok ? undefined : (result.errors?.join("; ") || undefined)
        });
        res.json(jsonRpcResult(request.id, resultToMcpContent(result)));
      } catch (error) {
        // A thrown error (unknown tool, schema rejection, crash) is still a call worth
        // measuring. Record it richly, then re-throw to the error middleware which emits the
        // JSON-RPC error response.
        const message = error instanceof Error ? error.message : "Tool execution failed.";
        recordActivity({
          userId,
          clientId,
          clientType,
          method: request.method,
          toolName: name,
          ok: false,
          summary: `${name} threw: ${message}`,
          durationMs: Date.now() - startedAt,
          inputBytes,
          args: preview,
          errorMessage: message
        });
        throw error;
      }
      return;
    }

    // Unknown notification (no id): acknowledge without a response body.
    if (request.id === undefined) {
      res.status(202).end();
      return;
    }
    recordActivity({ userId, clientId, method: request.method, ok: false, summary: "Method not found." });
    res.json(jsonRpcError(request.id, -32601, `Method not found: ${request.method}`));
  }));
}
