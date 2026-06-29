import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, listProjectReviewComments, writeProjectFile } from "../src/projects/store.js";
import { skillRegistry } from "../src/skills/registry.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 5000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "reviewer-client"
  };
}

const SMELLY_HTML = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; }
    .a { width: 16px; } .b { width: 16px; } .c { width: 16px; }
    .d { width: 16px; } .e { width: 16px; } .f { width: 16px; }
    .g { width: 16px; } .h { width: 16px; } .i { width: 16px; }
    .j { width: 16px; } .k { width: 16px; }
  </style>
</head>
<body>
  <img src="logo.png">
  <button></button>
  <div onclick="doSomething()" onmouseenter="doMore()" onkeydown="doKey()">click me</div>
  <script>
    document.getElementById("x").innerHTML = userInput;
  </script>
</body>
</html>`;

const SMELLY_CSS = `
/* TODO: clean this up */
body { margin: 0 !important; }
.a { padding: 32px !important; }
.b { gap: 32px !important; }
.c { margin-top: 32px !important; }
.d { margin-bottom: 32px !important; }
.e { border-radius: 32px !important; }
.f { font-size: 32px !important; }
`.repeat(5);

const SMELLY_JS = `
import a from './a.js';
import b from './b.js';
import c from './c.js';
import d from './d.js';
import e from './e.js';
import f from './f.js';
import g from './g.js';
import h from './h.js';
import i from './i.js';
import j from './j.js';
import k from './k.js';
import l from './l.js';
import m from './m.js';
import n from './n.js';
import o from './o.js';
import p from './p.js';
import q from './q.js';
import r from './r.js';
import s from './s.js';
import t from './t.js';
import u from './u.js';

// TODO: refactor this
// TODO: clean up later
// TODO: more todos
// TODO: even more todos
// FIXME: broken

const btn = document.querySelector('button');
btn.innerHTML = eval(userCode);
fetch('/api/data').then(r => {
  const fs = require('fs');
  fs.readFileSync('/tmp/test');
  process.env.SECRET;
  const db = 'SELECT * FROM users';
});
`;

const CLEAN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clean Page</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <img src="hero.png" alt="Hero image">
  <button aria-label="Submit form">Submit</button>
  <script src="app.js"></script>
</body>
</html>`;

test("review_project_code detects accessibility, security, maintainability findings in smelly files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-review-smelly-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Smelly project", createdByClientId: "coder" });

    await writeProjectFile(ctx.projectRoot, project.id, "index.html", SMELLY_HTML);
    await writeProjectFile(ctx.projectRoot, project.id, "style.css", SMELLY_CSS);
    await writeProjectFile(ctx.projectRoot, project.id, "app.js", SMELLY_JS);

    const result = await callTool("review_project_code", {
      projectId: project.id,
      includeValidation: false,
      syncComments: true
    }, ctx);

    assert.equal(result.ok, false, "Should not be ok when high/critical findings exist");

    const sc = result.structuredContent as {
      findings: Array<{ category: string; severity: string; filePath?: string; lineStart?: number }>;
      metrics: Record<string, number>;
      nextActions: string[];
      createdCommentIds: string[];
    };

    // Should have findings across multiple categories
    const categories = new Set(sc.findings.map((f) => f.category));
    assert.ok(categories.has("accessibility"), "Should have accessibility findings");
    assert.ok(categories.has("security"), "Should have security findings");
    assert.ok(categories.has("maintainability"), "Should have maintainability findings");

    // Should have file/line references
    const withFile = sc.findings.filter((f) => f.filePath);
    assert.ok(withFile.length > 0, "Findings should include file paths");
    const withLine = sc.findings.filter((f) => f.lineStart != null);
    assert.ok(withLine.length > 0, "Some findings should include line numbers");

    // Severity coverage
    const severities = new Set(sc.findings.map((f) => f.severity));
    assert.ok(severities.has("high") || severities.has("critical"), "Should have high or critical severity");

    // Metrics
    assert.ok(sc.metrics.filesScanned >= 3, "Should scan all 3 files");
    assert.equal(sc.metrics.findingsTotal, sc.findings.length, "Metrics should match findings count");

    // Next actions
    assert.ok(sc.nextActions.length > 0, "Should suggest next actions");

    // syncComments should write review comments
    assert.ok(sc.createdCommentIds.length > 0, "Should create review comments when syncComments=true");
    const comments = await listProjectReviewComments(ctx.projectRoot, project.id);
    assert.equal(comments.length, sc.createdCommentIds.length, "Comment count should match createdCommentIds");

    // Artifacts should be written
    assert.ok(result.artifacts.includes("review/code-review.md"), "Should produce markdown report");
    assert.ok(result.artifacts.includes("review/code-review.json"), "Should produce JSON report");

    // Markdown content
    const md = await readFile(path.join(ctx.projectRoot, project.id, "files/review/code-review.md"), "utf8");
    assert.match(md, /# Code Review Report/, "Markdown should have report header");
    assert.match(md, /Files scanned/, "Markdown should include metrics");
    assert.match(md, /Next Actions/, "Markdown should include next actions");

    // JSON content
    const json = JSON.parse(await readFile(path.join(ctx.projectRoot, project.id, "files/review/code-review.json"), "utf8")) as {
      findings: unknown[];
      metrics: Record<string, unknown>;
    };
    assert.ok(Array.isArray(json.findings), "JSON should have findings array");
    assert.ok(typeof json.metrics === "object", "JSON should have metrics object");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review_project_code syncComments=false does not write review comments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-review-nosync-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "No sync project", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", SMELLY_HTML);

    const result = await callTool("review_project_code", {
      projectId: project.id,
      includeValidation: false,
      syncComments: false
    }, ctx);

    const sc = result.structuredContent as { createdCommentIds: string[]; findings: unknown[] };
    assert.equal(sc.createdCommentIds.length, 0, "Should not create comments when syncComments=false");
    const comments = await listProjectReviewComments(ctx.projectRoot, project.id);
    assert.equal(comments.length, 0, "No comments should exist in project");

    // Report files should still be written
    assert.ok(result.artifacts.includes("review/code-review.md"), "Report should still be written");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review_project_code scopePaths limits scan to specified files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-review-scope-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Scope test project", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", SMELLY_HTML);
    await writeProjectFile(ctx.projectRoot, project.id, "style.css", SMELLY_CSS);

    const result = await callTool("review_project_code", {
      projectId: project.id,
      scopePaths: ["index.html"],
      includeValidation: false,
      syncComments: false
    }, ctx);

    const sc = result.structuredContent as {
      findings: Array<{ filePath?: string }>;
      metrics: { filesScanned: number };
    };
    assert.equal(sc.metrics.filesScanned, 1, "Should only scan 1 scoped file");
    const cssFindings = sc.findings.filter((f) => f.filePath === "style.css");
    assert.equal(cssFindings.length, 0, "Should not include CSS findings when CSS not in scope");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review_project_code on a clean project returns ok=true and low/zero findings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-review-clean-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Clean project", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", CLEAN_HTML);

    const result = await callTool("review_project_code", {
      projectId: project.id,
      includeValidation: false,
      syncComments: false
    }, ctx);

    const sc = result.structuredContent as {
      findings: Array<{ severity: string }>;
      metrics: { findingsCritical: number; findingsHigh: number };
    };

    // Clean file should have no critical/high findings
    assert.equal(sc.metrics.findingsCritical, 0, "Clean project should have no critical findings");
    assert.equal(sc.metrics.findingsHigh, 0, "Clean project should have no high findings");
    // ok should be true (no critical/high)
    assert.equal(result.ok, true, "Clean project should return ok=true");

    // Reports should still be written
    assert.ok(result.artifacts.includes("review/code-review.md"), "Should still write markdown report");
    assert.ok(result.artifacts.includes("review/code-review.json"), "Should still write JSON report");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review_project_code export_project_review_summary lists synced comments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-review-summary-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Summary test project", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", SMELLY_HTML);

    await callTool("review_project_code", {
      projectId: project.id,
      includeValidation: false,
      syncComments: true
    }, ctx);

    const summary = await callTool("export_project_review_summary", { projectId: project.id }, ctx);
    assert.equal(summary.ok, true);
    const md = await readFile(path.join(ctx.projectRoot, project.id, "files/review/review-summary.md"), "utf8");
    assert.match(md, /# Project Review Summary/, "Summary should have header");
    assert.match(md, /Total comments/, "Summary should show comment counts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review_project_code tool is exposed through coding and debug skills", () => {
  for (const skillId of ["coding", "debug"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill!.toolNames.includes("review_project_code"), `${skillId} exposes review_project_code`);
  }
});
