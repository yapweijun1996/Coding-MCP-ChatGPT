import assert from "node:assert/strict";
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
    clientId: "legacy-modernization-test"
  };
}

const legacyHtml = `<!doctype html>
<html>
<head>
  <title>Legacy Demo</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; }
    .panel { border: 1px solid #ccc; padding: 16px; }
  </style>
</head>
<body>
  <main class="panel" style="background: #fff">
    <h1 id="title">Legacy Demo</h1>
    <button onclick="increment()">Increment</button>
    <output id="count">0</output>
  </main>
  <script>
    let count = 0;
    function increment() {
      count += 1;
      document.getElementById('count').textContent = String(count);
    }
  </script>
</body>
</html>`;

test("modernize_legacy_project splits inline CSS and JS into validated modular files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-modernization-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Legacy Demo", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", legacyHtml);

    const result = await callTool("modernize_legacy_project", {
      projectId: project.id,
      outputDir: "modernized"
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal(result.jobId, project.id);
    assert.deepEqual(result.artifacts.sort(), [
      "modernized/app.js",
      "modernized/index.html",
      "modernized/migration-report.json",
      "modernized/migration-report.md",
      "modernized/styles.css"
    ].sort());

    const original = await readProjectFile(ctx.projectRoot, project.id, "index.html");
    assert.match(original, /onclick="increment\(\)"/);

    const html = await readProjectFile(ctx.projectRoot, project.id, "modernized/index.html");
    assert.match(html, /<link rel="stylesheet" href="styles.css">/);
    assert.match(html, /<script src="app.js" defer><\/script>/);
    assert.match(html, /<meta name="viewport"/);
    assert.doesNotMatch(html, /<style>/);
    assert.doesNotMatch(html, /let count = 0/);

    const css = await readProjectFile(ctx.projectRoot, project.id, "modernized/styles.css");
    assert.match(css, /Extracted from inline <style> block 1/);
    assert.match(css, /\.panel/);

    const js = await readProjectFile(ctx.projectRoot, project.id, "modernized/app.js");
    assert.match(js, /Extracted from inline <script> block 1/);
    assert.match(js, /function increment/);

    const report = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "modernized/migration-report.json")) as {
      findings: Array<{ id: string }>;
      validation: { ok: boolean; entryFile: string };
      extracted: { cssBytes: number; jsBytes: number };
    };
    assert.ok(report.findings.some((finding) => finding.id === "inline-style-blocks"));
    assert.ok(report.findings.some((finding) => finding.id === "inline-script-blocks"));
    assert.ok(report.findings.some((finding) => finding.id === "inline-event-handlers"));
    assert.equal(report.validation.ok, true);
    assert.equal(report.validation.entryFile, "modernized/index.html");
    assert.ok(report.extracted.cssBytes > 0);
    assert.ok(report.extracted.jsBytes > 0);

    const manifest = await getProjectManifest(ctx.projectRoot, project.id);
    assert.ok(manifest.lastValidation?.ok);
    assert.ok(manifest.taskHistory.some((item) => item.toolName === "modernize_legacy_project"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("modernize_legacy_project plan mode writes reports without modular files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-modernization-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Plan Only", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", legacyHtml);

    const result = await callTool("modernize_legacy_project", {
      projectId: project.id,
      mode: "plan",
      outputDir: "migration"
    }, ctx);

    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts.sort(), ["migration/migration-report.json", "migration/migration-report.md"].sort());
    await assert.rejects(readProjectFile(ctx.projectRoot, project.id, "migration/index.html"));
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "migration/migration-report.md");
    assert.match(markdown, /Migration Plan/);
    assert.match(markdown, /inline-event-handlers/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy modernization tool is exposed through coding and debug skills", () => {
  for (const skillId of ["coding", "debug"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill!.toolNames.includes("modernize_legacy_project"), `${skillId} exposes modernize_legacy_project`);
  }
});
