import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { appendProjectTaskHistory, createProject, publishProject, readProjectFile, validateProject, writeProjectFile } from "../src/projects/store.js";
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
    clientId: "project-docs-test"
  };
}

test("generate_project_docs creates README and CHANGELOG from project files, validation, history, and published URL", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-docs-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Docs Demo", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", `<!doctype html>
<html><head><title>Inventory Dashboard</title><meta name="description" content="Operational dashboard for inventory and order review."></head>
<body><h1>Inventory Control Center</h1><script src="app.js"></script></body></html>`);
    await writeProjectFile(ctx.projectRoot, project.id, "styles.css", "body { font-family: sans-serif; }\n");
    await writeProjectFile(ctx.projectRoot, project.id, "app.js", "console.log('ready');\n");
    await validateProject(ctx.projectRoot, project.id);
    const published = await publishProject(ctx.projectRoot, project.id, "https://example.test", "index.html");
    await appendProjectTaskHistory(ctx.projectRoot, project.id, { toolName: "audit_seo_social_meta", ok: true, summary: "SEO/social meta audit found 0 finding(s).", details: { reportUrl: "seo/seo-meta-audit.md" } });
    await appendProjectTaskHistory(ctx.projectRoot, project.id, { toolName: "inspect_webpage_plus", ok: false, summary: "Mobile menu overlap remains on narrow screens.", details: { selector: ".menu" } });

    const result = await callTool("generate_project_docs", {
      projectId: project.id,
      version: "v1.0.0",
      knownLimitations: ["Demo data only; no live backend."],
      nextSteps: ["Connect live inventory API.", "Run mobile browser QA."]
    }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts.sort(), ["CHANGELOG.md", "README.md"].sort());
    assert.equal(result.previewUrl, published.publishedUrl);

    const readme = await readProjectFile(ctx.projectRoot, project.id, "README.md");
    assert.match(readme, /# Inventory Dashboard/);
    assert.match(readme, /Operational dashboard for inventory and order review/);
    assert.match(readme, new RegExp(published.publishedUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(readme, /Status: valid \(passing\)/);
    assert.match(readme, /Static HTML/);
    assert.match(readme, /Demo data only; no live backend/);
    assert.match(readme, /Connect live inventory API/);

    const changelog = await readProjectFile(ctx.projectRoot, project.id, "CHANGELOG.md");
    assert.match(changelog, /## v1\.0\.0/);
    assert.match(changelog, /SEO\/social meta audit found 0 finding/);
    assert.match(changelog, /Mobile menu overlap remains/);
    assert.match(changelog, /Published URL:/);

    const payload = result.structuredContent as { features: string[]; limitations: string[]; nextSteps: string[]; validation: { ok: boolean } };
    assert.equal(payload.validation.ok, true);
    assert.ok(payload.features.some((feature) => feature.includes("Inventory Control Center")));
    assert.ok(payload.limitations.includes("Demo data only; no live backend."));
    assert.ok(payload.nextSteps.includes("Run mobile browser QA."));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate_project failure summary names the concrete reason, not just 'validation failed'", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "validate-summary-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Broken refs", createdByClientId: "coder" });
    // index.html references a local audio file that does not exist — the exact #5 failure shape.
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", `<!doctype html><html><head><title>Music</title></head><body><audio src="track.wav"></audio></body></html>`);

    const result = await callTool("validate_project", { projectId: project.id, entryFile: "index.html" }, ctx);
    assert.equal(result.ok, false);
    // The generic phrase alone (with nothing after the colon) is the regression we are guarding against.
    assert.doesNotMatch(result.summary, /validation failed\.$/);
    assert.match(result.summary, /validation failed: /);
    assert.match(result.summary, /track\.wav|not found/i);
    // The detail must match the first concrete error the validator reported.
    assert.ok((result.errors ?? []).length > 0);
    assert.ok(result.summary.includes((result.errors ?? [])[0]!.slice(0, 20)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generate_project_docs supports custom output paths without publish", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-docs-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Private Demo", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><head><title>Private Demo</title></head><body><h1>Private Demo</h1></body></html>");

    const result = await callTool("generate_project_docs", {
      projectId: project.id,
      readmePath: "docs/README.generated.md",
      changelogPath: "docs/CHANGELOG.generated.md"
    }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts.sort(), ["docs/CHANGELOG.generated.md", "docs/README.generated.md"].sort());
    const readme = await readProjectFile(ctx.projectRoot, project.id, "docs/README.generated.md");
    assert.match(readme, /Published URL: Not published yet/);
    assert.match(readme, /Publish the project after validation passes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project docs generator is exposed through coding and debug skills", () => {
  for (const skillId of ["coding", "debug"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill!.toolNames.includes("generate_project_docs"), `${skillId} exposes generate_project_docs`);
  }
});
