import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, writeProjectFile } from "../src/projects/store.js";
import type { ToolContext } from "../src/mcp/types.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "pwa-audit-test"
  };
}

test("audit_project_pwa reports missing PWA essentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pwa-audit-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Plain page", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><head><title>Plain</title></head><body><h1>Plain</h1></body></html>");

    const audit = getToolModule("audit_project_pwa");
    assert.ok(audit, "audit_project_pwa registered");
    const result = await audit!.handler({ projectId: project.id }, ctx);

    assert.equal(result.ok, false);
    const report = result.structuredContent as { errors: string[]; findings: Array<{ id: string; severity: string }> };
    assert.ok(report.errors.some((entry) => entry.includes("manifest-link")));
    assert.ok(report.errors.some((entry) => entry.includes("service-worker-register")));
    assert.equal(report.findings.some((entry) => entry.id === "viewport-meta" && entry.severity === "error"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audit_project_pwa passes a complete static PWA project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pwa-audit-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "PWA page", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", `<!doctype html>
<html><head>
  <title>PWA</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="manifest" href="manifest.json">
  <link rel="apple-touch-icon" href="icons/icon.svg">
  <link rel="stylesheet" href="styles.css">
</head><body>
  <h1>PWA</h1>
  <button id="install">Install app</button>
  <p id="offline">Offline mode ready. Update available when a new version ships.</p>
  <script src="app.js"></script>
</body></html>`);
    await writeProjectFile(ctx.projectRoot, project.id, "styles.css", "body{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}");
    await writeProjectFile(ctx.projectRoot, project.id, "app.js", "navigator.serviceWorker.register('sw.js'); window.addEventListener('beforeinstallprompt', event => event.preventDefault());");
    await writeProjectFile(ctx.projectRoot, project.id, "sw.js", "self.addEventListener('install',event=>{self.skipWaiting();event.waitUntil(caches.open('v1').then(c=>c.addAll(['offline.html'])))});self.addEventListener('activate',event=>event.waitUntil(clients.claim()));self.addEventListener('fetch',event=>event.respondWith(caches.match(event.request).then(r=>r||fetch(event.request))));");
    await writeProjectFile(ctx.projectRoot, project.id, "offline.html", "<!doctype html><html><body>Offline fallback</body></html>");
    await writeProjectFile(ctx.projectRoot, project.id, "icons/icon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><rect width=\"512\" height=\"512\" fill=\"#16685f\"/></svg>");
    await writeProjectFile(ctx.projectRoot, project.id, "manifest.json", JSON.stringify({
      name: "PWA Page",
      short_name: "PWA",
      start_url: ".",
      display: "standalone",
      theme_color: "#16685f",
      background_color: "#ffffff",
      icons: [
        { src: "icons/icon.svg", sizes: "192x192", type: "image/svg+xml" },
        { src: "icons/icon.svg", sizes: "512x512", type: "image/svg+xml" }
      ]
    }));

    const audit = getToolModule("audit_project_pwa");
    const result = await audit!.handler({ projectId: project.id }, ctx);
    assert.equal(result.ok, true);
    const report = result.structuredContent as { errors: string[]; findings: Array<{ id: string; severity: string }> };
    assert.deepEqual(report.errors, []);
    assert.equal(report.findings.some((entry) => entry.id === "service-worker-file" && entry.severity === "pass"), true);
    assert.equal(report.findings.some((entry) => entry.id === "ios-touch-icon" && entry.severity === "pass"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
