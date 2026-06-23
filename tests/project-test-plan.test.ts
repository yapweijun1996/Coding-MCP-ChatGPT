import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, readProjectFile, writeProjectFile } from "../src/projects/store.js";
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
    clientId: "test-plan-test"
  };
}

test("generate_project_test_plan creates reusable cases and writes artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "test-plan-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Testable page", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", `<!doctype html>
<html><head>
  <title>Testable</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="manifest" href="manifest.json">
</head><body>
  <h1>Project Dashboard</h1>
  <a id="settings-link" href="#settings">Settings</a>
  <button id="save-button">Save</button>
  <form id="lead-form"><label>Email <input name="email" type="email"></label></form>
  <script>navigator.serviceWorker.register('sw.js')</script>
</body></html>`);
    await writeProjectFile(ctx.projectRoot, project.id, "manifest.json", JSON.stringify({ name: "Testable", start_url: ".", display: "standalone", theme_color: "#16685f", icons: [] }));
    await writeProjectFile(ctx.projectRoot, project.id, "sw.js", "self.addEventListener('fetch',event=>event.respondWith(fetch(event.request)))");

    const generate = getToolModule("generate_project_test_plan");
    assert.ok(generate, "generate_project_test_plan registered");
    const result = await generate!.handler({ projectId: project.id }, ctx);

    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts, ["tests/project-test-plan.json", "tests/project-test-plan.md"]);
    const plan = result.structuredContent as { testCases: Array<{ id: string; kind: string; selector?: string; tool: string }>; staticChecks: { validation: { ok: boolean }; pwa?: { ok: boolean } } };
    assert.equal(plan.staticChecks.validation.ok, true);
    assert.equal(plan.testCases.some((item) => item.id === "content-primary-heading" && item.tool === "inspect_interaction_flow"), true);
    assert.equal(plan.testCases.some((item) => item.id === "button-1" && item.selector === "button#save-button"), true);
    assert.equal(plan.testCases.some((item) => item.id === "form-1" && item.kind === "interaction"), true);
    assert.equal(plan.testCases.some((item) => item.id === "pwa-readiness" && item.tool === "audit_project_pwa"), true);

    const json = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "tests/project-test-plan.json")) as { testCases: unknown[] };
    assert.equal(json.testCases.length, plan.testCases.length);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "tests/project-test-plan.md");
    assert.match(markdown, /# Project Test Plan/);
    assert.match(markdown, /button-1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
