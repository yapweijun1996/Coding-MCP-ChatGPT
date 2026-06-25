import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, writeProjectFile } from "../src/projects/store.js";
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
    clientId: "export-package-test"
  };
}

test("export package tools create manifest, HTML bundle, ZIP, listing, and report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "export-package-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Export package project", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><h1>Export package</h1>");
    await writeProjectFile(ctx.projectRoot, project.id, "reports/summary.md", "# Summary\n\nReady for handoff.\n");

    const manifestResult = await callTool("create_export_package_manifest", {
      projectId: project.id,
      title: "Release Handoff",
      formats: ["zip", "html-bundle", "pdf", "docx", "pptx", "screenshots", "share-archive"],
      includeProjectFiles: true,
      includeReports: true,
      includeScreenshots: false,
      notes: ["Send to stakeholder review."]
    }, ctx);
    assert.equal(manifestResult.ok, true);
    assert.deepEqual(manifestResult.artifacts, ["exports/export-package-manifest.json"]);
    const manifest = (manifestResult.structuredContent as { manifest: { readiness: Array<{ format: string; ready: boolean }> } }).manifest;
    assert.equal(manifest.readiness.find((item) => item.format === "zip")?.ready, true);
    assert.equal(manifest.readiness.find((item) => item.format === "pdf")?.ready, false);

    const htmlResult = await callTool("create_html_export_bundle", { projectId: project.id }, ctx);
    assert.equal(htmlResult.ok, true);
    assert.deepEqual(htmlResult.artifacts, ["exports/html-bundle-index.html"]);
    const html = await readFile(path.join(ctx.projectRoot, project.id, "files/exports/html-bundle-index.html"), "utf8");
    assert.match(html, /Release Handoff/);
    assert.match(html, /pending: pdf/);

    const zipResult = await callTool("build_zip_export_package", { projectId: project.id }, ctx);
    assert.equal(zipResult.ok, true);
    assert.deepEqual(zipResult.artifacts, ["exports/project-export-package.zip"]);
    const zipPath = path.join(ctx.projectRoot, project.id, "files/exports/project-export-package.zip");
    const zipInfo = await stat(zipPath);
    assert.ok(zipInfo.size > 0);
    const zipBytes = await readFile(zipPath);
    assert.deepEqual([...zipBytes.subarray(0, 2)], [0x50, 0x4b]);

    const listResult = await callTool("list_export_packages", { projectId: project.id }, ctx);
    assert.equal(listResult.ok, true);
    const listed = listResult.structuredContent as { manifest: { packages: Array<{ path: string }> } };
    assert.ok(listed.manifest.packages.some((item) => item.path === "exports/html-bundle-index.html"));
    assert.ok(listed.manifest.packages.some((item) => item.path === "exports/project-export-package.zip"));

    const reportResult = await callTool("export_package_report", { projectId: project.id }, ctx);
    assert.equal(reportResult.ok, true);
    assert.deepEqual(reportResult.artifacts, ["exports/export-package-report.md"]);
    const report = await readFile(path.join(ctx.projectRoot, project.id, "files/exports/export-package-report.md"), "utf8");
    assert.match(report, /# Export Package Report/);
    assert.match(report, /pending: pdf/);
    assert.match(report, /exports\/project-export-package\.zip/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export package tools are exposed through core, coding, debug, and export-package skills", () => {
  const toolNames = ["create_export_package_manifest", "build_zip_export_package", "create_html_export_bundle", "list_export_packages", "export_package_report"];
  for (const skillId of ["core", "coding", "debug", "export-package"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    for (const toolName of toolNames) {
      assert.ok(skill!.toolNames.includes(toolName), `${skillId} exposes ${toolName}`);
    }
  }
});
