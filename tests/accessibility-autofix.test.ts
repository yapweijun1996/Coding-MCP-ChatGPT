import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getToolModule } from "../src/mcp/registry.js";
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
    clientId: "accessibility-autofix-test"
  };
}

async function createInaccessibleProject(ctx: ToolContext) {
  const project = await createProject(ctx.projectRoot, { title: "Inaccessible UI", createdByClientId: "coder" });
  await writeProjectFile(ctx.projectRoot, project.id, "index.html", `<!doctype html>
<html><head></head><body>
  <img src="hero.png">
  <button class="icon"></button>
  <input name="email">
  <button aria-hidden="true">Save</button>
  <div onclick="openMenu()">Menu</div>
</body></html>`);
  await writeProjectFile(ctx.projectRoot, project.id, "styles.css", ".icon { color: #ccc; transition: opacity .2s; }\n");
  return project;
}

test("auto_fix_accessibility plans generated UI accessibility repairs without mutating files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accessibility-autofix-"));
  try {
    const ctx = toolContext(root);
    const project = await createInaccessibleProject(ctx);
    const tool = getToolModule("auto_fix_accessibility");
    assert.ok(tool, "auto_fix_accessibility registered");

    const result = await tool!.handler({ projectId: project.id, paths: ["index.html", "styles.css"] }, ctx);
    assert.equal(result.ok, true);

    const report = result.structuredContent as {
      applyFixes: boolean;
      changedFiles: string[];
      actionCount: number;
      appliedCount: number;
      manualReviewCount: number;
      actions: Array<{ category: string; applied: boolean }>;
    };
    assert.equal(report.applyFixes, false);
    assert.deepEqual(report.changedFiles, []);
    assert.equal(report.appliedCount, 0);
    assert.equal(report.actionCount >= 9, true);
    assert.equal(report.manualReviewCount, report.actionCount);
    assert.equal(report.actions.every((action) => action.applied === false), true);

    const categories = new Set(report.actions.map((action) => action.category));
    for (const category of ["metadata", "landmarks", "labels", "aria", "keyboard", "focus", "motion", "contrast"]) {
      assert.ok(categories.has(category), `expected ${category} action`);
    }

    const originalHtml = await readProjectFile(ctx.projectRoot, project.id, "index.html");
    assert.equal(originalHtml.includes("lang=\"en\""), false);
    assert.equal(originalHtml.includes("aria-label=\"Button\""), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto_fix_accessibility applies safe HTML and CSS accessibility fixes and writes a report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accessibility-autofix-"));
  try {
    const ctx = toolContext(root);
    const project = await createInaccessibleProject(ctx);
    const tool = getToolModule("auto_fix_accessibility");

    const result = await tool!.handler({ projectId: project.id, paths: ["index.html", "styles.css"], applyFixes: true }, ctx);
    assert.equal(result.ok, true);

    const report = result.structuredContent as {
      changedFiles: string[];
      actionCount: number;
      appliedCount: number;
      manualReviewCount: number;
    };
    assert.deepEqual(report.changedFiles.sort(), ["index.html", "styles.css"].sort());
    assert.equal(report.appliedCount >= 7, true);
    assert.equal(report.manualReviewCount >= 2, true);
    assert.equal(report.actionCount, report.appliedCount + report.manualReviewCount);

    const html = await readProjectFile(ctx.projectRoot, project.id, "index.html");
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<title>Generated UI<\/title>/);
    assert.match(html, /<main id="main-content">/);
    assert.match(html, /<img src="hero\.png" alt="">/);
    assert.match(html, /<button class="icon" aria-label="Button"><\/button>/);
    assert.match(html, /<input name="email" aria-label="email">/);
    assert.equal(html.includes("aria-hidden=\"true\""), false);

    const css = await readProjectFile(ctx.projectRoot, project.id, "styles.css");
    assert.match(css, /:focus-visible/);
    assert.match(css, /prefers-reduced-motion/);

    const reportJson = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "accessibility/autofix-report.json")) as { applyFixes: boolean; changedFiles: string[] };
    assert.equal(reportJson.applyFixes, true);
    assert.deepEqual(reportJson.changedFiles.sort(), ["index.html", "styles.css"].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto_fix_accessibility is exposed through coding, debug, and browser QA skills", () => {
  for (const skillId of ["coding", "debug", "browser-qa"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill!.toolNames.includes("auto_fix_accessibility"), `${skillId} exposes auto_fix_accessibility`);
  }
});
