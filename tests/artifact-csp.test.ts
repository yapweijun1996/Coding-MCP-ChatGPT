import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerContentRoutes } from "../src/http/content-routes.js";
import { createArtifact } from "../src/artifacts/store.js";
import type { ServerConfig } from "../src/config.js";

function makeConfig(root: string): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    publicBaseUrl: "https://example.test",
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
    siteStatePath: path.join(root, "site.json"),
    blogStatePath: path.join(root, "blog.json"),
    commandTimeoutMs: 10000,
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

// Regression: HTML artifacts are served from the app's own (admin-shared) origin, so
// the response must carry a sandbox CSP WITHOUT allow-same-origin — otherwise stored
// HTML could read the admin session cookie.
test("/artifact serves HTML under a sandbox CSP with no allow-same-origin", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-artifact-csp-"));
  try {
    const config = makeConfig(root);
    const record = await createArtifact({
      artifactRoot: config.artifactRoot,
      filename: "page.html",
      contentType: "text/html",
      content: "<h1>hi</h1>"
    });

    const app = express();
    registerContentRoutes(app, config);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object", "server bound to a port");
    const url = `http://127.0.0.1:${addr.port}/artifact/${record.id}/${record.filename}`;

    try {
      const res = await fetch(url);
      assert.equal(res.status, 200);
      const csp = res.headers.get("content-security-policy") ?? "";
      assert.match(csp, /sandbox/, "artifact response sets a sandbox CSP");
      assert.doesNotMatch(csp, /allow-same-origin/, "sandbox must NOT grant same-origin access");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
