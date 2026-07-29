import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerMcpRoutes } from "../src/http/mcp-routes.js";
import { initializeTelemetry } from "../src/telemetry/store.js";
import type { ServerConfig } from "../src/config.js";
import type { TelemetryEvent } from "../src/telemetry/store.js";

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
    // High enough that the multi-request flows below are never rate limited.
    mcpRateLimit: { windowMs: 60_000, maxRequests: 1000 },
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

async function rpc(baseUrl: string, id: number, method: string, params: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${strongDevToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  assert.equal(response.status, 200, `${method} should succeed`);
  return await response.json() as Record<string, unknown>;
}

// Telemetry writes are fire-and-forget; poll briefly for the async append to land.
async function readTelemetryEvents(telemetryRoot: string): Promise<TelemetryEvent[]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const files = await readdir(telemetryRoot).catch(() => [] as string[]);
    if (files.length > 0) {
      const raw = await readFile(path.join(telemetryRoot, files[0]), "utf8");
      const events = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as TelemetryEvent);
      if (events.length >= 2) return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const files = await readdir(telemetryRoot).catch(() => [] as string[]);
  if (files.length === 0) return [];
  const raw = await readFile(path.join(telemetryRoot, files[0]), "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as TelemetryEvent);
}

test("negotiated protocolVersion is recorded on initialize and carried onto later calls", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-protocol-version-"));
  const config = makeConfig(root);
  initializeTelemetry(config.telemetryRoot);
  try {
    await withServer(config, async (baseUrl) => {
      const initialized = await rpc(baseUrl, 1, "initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "openai-mcp", version: "1.0.0" }
      });
      const result = initialized.result as { protocolVersion: string };
      assert.equal(result.protocolVersion, "2025-06-18", "server should echo a supported version");

      // tools/list carries no protocolVersion of its own — this asserts the per-client
      // memo actually works, which is the whole point of the change.
      await rpc(baseUrl, 2, "tools/list", {});
    });

    const events = await readTelemetryEvents(config.telemetryRoot);
    const init = events.find((event) => event.method === "initialize");
    const list = events.find((event) => event.method === "tools/list");

    assert.ok(init, "initialize should be recorded");
    assert.equal(init.protocolVersion, "2025-06-18");
    assert.match(init.summary ?? "", /MCP 2025-06-18/);

    assert.ok(list, "tools/list should be recorded");
    assert.equal(list.protocolVersion, "2025-06-18", "later calls must inherit the negotiated version");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unsupported requested version is logged as the negotiated floor, not the request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-protocol-floor-"));
  const config = makeConfig(root);
  initializeTelemetry(config.telemetryRoot);
  try {
    await withServer(config, async (baseUrl) => {
      const initialized = await rpc(baseUrl, 1, "initialize", {
        protocolVersion: "2099-01-01",
        clientInfo: { name: "future-client", version: "9.9" }
      });
      const result = initialized.result as { protocolVersion: string };
      assert.equal(result.protocolVersion, "2024-11-05", "unsupported versions fall back to the floor");
      await rpc(baseUrl, 2, "tools/list", {});
    });

    const events = await readTelemetryEvents(config.telemetryRoot);
    const init = events.find((event) => event.method === "initialize");
    assert.ok(init, "initialize should be recorded");
    // The session is governed by the negotiated version, so that is what must be logged.
    // Logging the requested "2099-01-01" would make the corpus lie about what the client got.
    assert.equal(init.protocolVersion, "2024-11-05");
    assert.match(init.summary ?? "", /requested 2099-01-01/, "the requested version is kept for diagnosis");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
