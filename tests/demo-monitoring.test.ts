import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, getProjectManifest, readProjectFile, writeProjectFile } from "../src/projects/store.js";
import { skillRegistry } from "../src/skills/registry.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "demo-monitoring-test"
  };
}

async function serve(routes: Record<string, { status?: number; body: string; contentType?: string }>) {
  const server = http.createServer((req, res) => {
    const route = routes[req.url ?? "/"] ?? { status: 404, body: "missing", contentType: "text/plain" };
    res.writeHead(route.status ?? 200, { "content-type": route.contentType ?? "text/html; charset=utf-8" });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

test("monitor_published_demo_health records passing uptime and deploy history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "demo-monitoring-"));
  const server = await serve({
    "/": { body: "<!doctype html><html><head><title>Healthy Demo</title></head><body><h1>Healthy Demo</h1></body></html>" }
  });
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Healthy Demo", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><body>Healthy</body></html>");
    const result = await callTool("monitor_published_demo_health", {
      projectId: project.id,
      url: server.url,
      viewports: ["desktop"],
      allowPrivateNetwork: true,
      slowLoadMs: 120000
    }, ctx);

    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts.sort(), [
      "monitoring/deploy-health-history.json",
      "monitoring/latest-health-report.json",
      "monitoring/latest-health-report.md"
    ].sort());
    const report = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "monitoring/latest-health-report.json")) as {
      ok: boolean;
      score: number;
      uptime: { ok: boolean; status: number };
      viewports: Array<{ title: string; consoleErrors: string[] }>;
    };
    assert.equal(report.ok, true);
    assert.equal(report.uptime.status, 200);
    assert.equal(report.viewports[0].title, "Healthy Demo");
    assert.equal(report.viewports[0].consoleErrors.length, 0);
    assert.equal(report.score, 100);
    const history = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "monitoring/deploy-health-history.json")) as unknown[];
    assert.equal(history.length, 1);
    const manifest = await getProjectManifest(ctx.projectRoot, project.id);
    assert.ok(manifest.taskHistory.some((item) => item.toolName === "monitor_published_demo_health"));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("monitor_published_demo_health flags console errors and broken assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "demo-monitoring-"));
  const server = await serve({
    "/": {
      body: `<!doctype html><html><head><title>Broken Demo</title><link rel="stylesheet" href="/missing.css"></head><body><h1>Broken</h1><img src="/missing.png"><script>console.error('demo exploded'); setTimeout(() => { throw new Error('runtime boom'); }, 0);</script></body></html>`
    }
  });
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Broken Demo", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><body>Broken</body></html>");
    const result = await callTool("monitor_published_demo_health", {
      projectId: project.id,
      url: server.url,
      viewports: ["desktop"],
      allowPrivateNetwork: true,
      slowLoadMs: 120000
    }, ctx);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("demo exploded") || error.includes("runtime boom") || error.includes("failed")));
    const report = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "monitoring/latest-health-report.json")) as {
      issues: Array<{ category: string; message: string }>;
      viewports: Array<{ brokenAssets: Array<{ url: string; status?: number }>; consoleErrors: string[]; pageErrors: string[] }>;
    };
    assert.ok(report.issues.some((issue) => issue.category === "console" && issue.message.includes("demo exploded")));
    assert.ok(report.issues.some((issue) => issue.category === "asset"));
    assert.ok(report.viewports[0].brokenAssets.some((asset) => asset.url.includes("missing")));
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "monitoring/latest-health-report.md");
    assert.match(markdown, /Current Issues/);
    assert.match(markdown, /Recent Deploy Health/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("published demo monitoring is exposed through coding, debug, and browser QA skills", () => {
  for (const skillId of ["coding", "debug", "browser-qa"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill!.toolNames.includes("monitor_published_demo_health"), `${skillId} exposes monitor_published_demo_health`);
  }
});
