import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, readProjectFile, writeProjectFile } from "../src/projects/store.js";
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
    clientId: "seo-meta-audit-test"
  };
}

test("audit_seo_social_meta reports SEO and social metadata gaps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "seo-meta-audit-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Published demo", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", `<!doctype html>
<html><head>
  <title>Demo</title>
  <meta name="robots" content="noindex">
  <meta property="og:title" content="Demo share title">
</head><body>Demo</body></html>`);

    const result = await callTool("audit_seo_social_meta", { projectId: project.id, siteUrl: "https://demo.example" }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts.sort(), ["seo/seo-meta-audit.json", "seo/seo-meta-audit.md"].sort());

    const report = result.structuredContent as {
      pageCount: number;
      score: number;
      pages: Array<{ sharePreview: { title?: string } }>;
      findings: Array<{ id: string; category: string; severity: string }>;
    };
    assert.equal(report.pageCount, 1);
    assert.equal(report.score < 100, true);
    assert.equal(report.pages[0]?.sharePreview.title, "Demo share title");
    const ids = new Set(report.findings.map((finding) => finding.id));
    for (const id of ["title-length-risk", "missing-description", "missing-canonical-url", "missing-favicon", "missing-viewport", "robots-blocks-indexing", "missing-theme-color", "missing-og-image", "missing-twitter-card", "incomplete-share-preview"]) {
      assert.ok(ids.has(id), `expected ${id}`);
    }

    const json = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "seo/seo-meta-audit.json")) as { findings: unknown[] };
    assert.equal(json.findings.length, report.findings.length);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "seo/seo-meta-audit.md");
    assert.match(markdown, /# SEO and Social Meta Audit/);
    assert.match(markdown, /Share Preview Summary/);
    assert.match(markdown, /robots-blocks-indexing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audit_seo_social_meta recognizes complete metadata and scoped paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "seo-meta-audit-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Complete demo", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", `<!doctype html>
<html><head>
  <title>Complete Product Demo</title>
  <meta name="description" content="A useful published demo for testing complete SEO and social share metadata coverage.">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#2563eb">
  <link rel="canonical" href="https://demo.example/">
  <link rel="icon" href="/favicon.ico">
  <meta property="og:title" content="Complete Product Demo">
  <meta property="og:description" content="A useful published demo for testing complete SEO and social share metadata coverage.">
  <meta property="og:image" content="https://demo.example/share.png">
  <meta property="og:url" content="https://demo.example/">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Complete Product Demo">
  <meta name="twitter:description" content="A useful published demo for testing complete SEO and social share metadata coverage.">
  <meta name="twitter:image" content="https://demo.example/share.png">
</head><body>Demo</body></html>`);
    await writeProjectFile(ctx.projectRoot, project.id, "draft.html", "<html><head><title>X</title></head><body>Draft</body></html>");

    const result = await callTool("audit_seo_social_meta", { projectId: project.id, paths: ["index.html"], siteUrl: "https://demo.example" }, ctx);
    assert.equal(result.ok, true);
    const report = result.structuredContent as { score: number; pages: Array<{ path: string; sharePreview: { image?: string; card?: string } }>; findings: Array<{ id: string }> };
    assert.equal(report.pages.length, 1);
    assert.equal(report.pages[0]?.path, "index.html");
    assert.equal(report.pages[0]?.sharePreview.image, "https://demo.example/share.png");
    assert.equal(report.pages[0]?.sharePreview.card, "summary_large_image");
    assert.equal(report.score, 100);
    assert.equal(report.findings.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SEO social meta audit is exposed through coding and debug skills", () => {
  for (const skillId of ["coding", "debug"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill!.toolNames.includes("audit_seo_social_meta"), `${skillId} exposes audit_seo_social_meta`);
  }
});
