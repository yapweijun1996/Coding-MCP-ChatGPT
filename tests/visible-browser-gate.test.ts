import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerMcpRoutes } from "../src/http/mcp-routes.js";
import { callTool } from "../src/mcp/router.js";
import { getToolAccess } from "../src/tool-state.js";
import { skillRegistry } from "../src/skills/registry.js";
import { disableVisibleBrowserControl, enableVisibleBrowserControl, isVisibleBrowserControlEnabled } from "../src/special-tools.js";
import type { ServerConfig } from "../src/config.js";

const strongDevToken = "abcdefghijklmnopqrstuvwxyz1234567890";

const browserToolNames = [
  "open_browser_session",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_screenshot",
  "browser_wait",
  "close_browser_session"
];

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

async function listedToolNames(): Promise<string[]> {
  const root = await mkdtemp(path.join(tmpdir(), "visible-browser-gate-"));
  const app = express();
  app.use(express.json());
  registerMcpRoutes(app, makeConfig(root));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${strongDevToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    const payload = await response.json() as { result: { tools: Array<{ name: string }> } };
    return payload.result.tools.map((tool) => tool.name);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

// The bug: these eight tools were stripped from tools/list unconditionally and re-added only
// while a 15/30/60-minute admin toggle was on, so enabledByDefault and skill membership were
// both inert for them. They must now be reachable through the ordinary two gates.
test("browser tools reach tools/list through the normal two gates, with the timer off", async () => {
  disableVisibleBrowserControl("test-setup");
  assert.equal(isVisibleBrowserControlEnabled(), false, "precondition: the timer is off");

  const listed = new Set(await listedToolNames());
  for (const name of browserToolNames) {
    assert.ok(listed.has(name), `${name} should be listed while visible browser control is OFF`);
  }
});

test("each browser tool passes both gates and is exposed by a skill", () => {
  for (const name of browserToolNames) {
    const access = getToolAccess(name);
    assert.equal(access.toolEnabled, true, `${name} tool state`);
    assert.equal(access.skillEnabled, true, `${name} skill exposure`);
    assert.equal(access.access, "enabled", `${name} effective access`);
  }
  const browserQa = skillRegistry.find((skill) => skill.id === "browser-qa");
  assert.ok(browserQa, "browser-qa skill pack exists");
  for (const name of browserToolNames) {
    assert.ok(browserQa!.toolNames.includes(name), `browser-qa exposes ${name}`);
  }
});

// The security property that survives: the timer no longer gates the tool family, it gates
// putting a real window on the server's display. Headless automation must not need it;
// headed must.
test("a headed session is refused while visible browser control is off", async () => {
  disableVisibleBrowserControl("test-setup");
  const root = await mkdtemp(path.join(tmpdir(), "visible-browser-headed-"));
  const ctx = {
    publicBaseUrl: "https://example.test",
    workspaceRoot: path.join(root, "workspace"),
    commandTimeoutMs: 10000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "test-client"
  } as never;
  try {
    const result = await callTool("open_browser_session", { headless: false }, ctx);
    assert.equal(result.ok, false, "headed must be refused without the operator toggle");
    assert.match(result.errors.join(" "), /visible browser control/i);
    // The refusal has to tell the agent what to do instead, or it will just retry the same call.
    assert.match(result.errors.join(" "), /headless: true/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("turning visible browser control on lifts the headed restriction", () => {
  disableVisibleBrowserControl("test-setup");
  assert.equal(isVisibleBrowserControlEnabled(), false);
  enableVisibleBrowserControl(15, "test-admin");
  assert.equal(isVisibleBrowserControlEnabled(), true, "the operator toggle still governs headed mode");
  disableVisibleBrowserControl("test-teardown");
  assert.equal(isVisibleBrowserControlEnabled(), false);
});

test("headless is the default, so an argument-free call does not need the toggle", () => {
  const tool = skillRegistry.find((skill) => skill.id === "browser-qa");
  assert.ok(tool);
  // Parsing an empty payload is what an agent calling with no arguments produces.
  const parsed = (async () => {
    const { browserTools } = await import("../src/mcp/tools/browser.js");
    const open = browserTools.find((entry) => entry.definition.name === "open_browser_session");
    assert.ok(open?.schema, "open_browser_session has a zod schema");
    return open!.schema!.parse({}) as { headless: boolean };
  })();
  return parsed.then((value) => {
    assert.equal(value.headless, true, "default must be headless, or every plain call needs an admin toggle");
  });
});
