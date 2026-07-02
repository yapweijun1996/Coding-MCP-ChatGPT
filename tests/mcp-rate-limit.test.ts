import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerMcpRoutes } from "../src/http/mcp-routes.js";
import type { ServerConfig } from "../src/config.js";

const strongDevToken = "abcdefghijklmnopqrstuvwxyz1234567890";

function makeConfig(root: string): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    publicBaseUrl: "https://example.test",
    contentBaseUrl: "https://example.test",
    workspaceRoot: path.join(root, "workspace"),
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    telemetryRoot: path.join(root, "telemetry"),
    jobsRoot: path.join(root, "jobs"),
    jobRetentionDays: 7,
    projectRoot: path.join(root, "projects"),
    usersRoot: path.join(root, "users"),
    userStatePath: path.join(root, "users.json"),
    skillStatePath: path.join(root, "skills.json"),
    toolStatePath: path.join(root, "tools.json"),
    siteStatePath: path.join(root, "site.json"),
    blogStatePath: path.join(root, "blog.json"),
    commandTimeoutMs: 10000,
    mcpRateLimit: { windowMs: 60_000, maxRequests: 1 },
    devToken: strongDevToken,
    configWarnings: [],
    adminPasscode: "",
    oauthConfig: {
      issuer: "https://example.test",
      ownerPasscode: "",
      accessTokenTtlSeconds: 3600,
      authCodeTtlSeconds: 300,
      refreshTokenTtlSeconds: 2592000,
      statePath: path.join(root, "oauth.json")
    },
    adminDistPath: path.join(root, "admin-dist")
  };
}

async function withServer<T>(config: ServerConfig, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  registerMcpRoutes(app, config);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object", "server bound to a port");
  try {
    return await run(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postMcp(baseUrl: string, id: number): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${strongDevToken}`
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: {} })
  });
}

test("/mcp returns 429 when one client exceeds the configured request limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-rate-limit-"));
  try {
    await withServer(makeConfig(root), async (baseUrl) => {
      const first = await postMcp(baseUrl, 1);
      assert.equal(first.status, 200);

      const limited = await postMcp(baseUrl, 2);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.has("retry-after"), true);
      const payload = await limited.json() as { ok: boolean; error: string; retryAfterSeconds: number };
      assert.equal(payload.ok, false);
      assert.match(payload.error, /rate limit/i);
      assert.ok(payload.retryAfterSeconds >= 1);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
