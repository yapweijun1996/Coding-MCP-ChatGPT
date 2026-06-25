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
    clientId: "design-system-audit-test"
  };
}

test("audit_design_system_consistency reports token, color, spacing, typography, button, and table drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "design-system-audit-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Admin UI", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", `<!doctype html>
<html><head><style>
.hero { color: #101010; background: #f9fafb; padding: 11px; font-size: 31px; border-radius: 19px; }
</style><link rel="stylesheet" href="styles.css"></head><body>
<button class="btn primary">Save</button><table><tr><td>Row</td></tr></table>
</body></html>`);
    await writeProjectFile(ctx.projectRoot, project.id, "styles.css", `
.btn { background: #2255ff; color: #ffffff; padding: 7px 13px; border-radius: 3px; font-size: 13px; }
.btn.secondary { background: #22aa88; padding: 9px 19px; border-radius: 6px; font-size: 14px; }
.button-danger { background: #cc2244; padding: 11px 23px; border-radius: 12px; font-size: 15px; }
.cta { background: #ffbb00; padding: 15px 29px; border-radius: 24px; font-size: 17px; }
.button-alt { background: #663399; padding: 5px 17px; border-radius: 2px; font-size: 19px; }
.panel { color: #334455; background: #eef2ff; margin: 3px; padding: 5px; gap: 7px; font-size: 21px; border-radius: 9px; }
.card { color: #556677; background: #fff7ed; margin: 13px; padding: 17px; gap: 23px; font-size: 23px; border-radius: 15px; }
td { padding: 4px; }
th { padding: 24px; }
table.compact td { padding: 9px; }
table.spacious td { padding: 31px; }
`);

    const result = await callTool("audit_design_system_consistency", {
      projectId: project.id,
      maxColors: 5,
      maxFontSizes: 4,
      maxSpacingValues: 6,
      maxRadiusValues: 3
    }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts.sort(), ["design-system/design-system-audit.json", "design-system/design-system-audit.md"].sort());

    const report = result.structuredContent as {
      findings: Array<{ id: string; category: string }>;
      metrics: { colorCount: number; fontSizeCount: number; spacingValueCount: number; radiusValueCount: number };
      suggestedCssVariables: Record<string, string>;
    };
    assert.equal(report.metrics.colorCount > 5, true);
    assert.equal(report.metrics.fontSizeCount > 4, true);
    assert.equal(report.metrics.spacingValueCount > 6, true);
    assert.equal(report.metrics.radiusValueCount > 3, true);
    const ids = new Set(report.findings.map((finding) => finding.id));
    for (const id of ["missing-css-tokens", "color-drift", "font-size-drift", "spacing-drift", "radius-drift", "button-variant-drift", "table-density-drift"]) {
      assert.ok(ids.has(id), `expected ${id}`);
    }
    assert.ok(report.suggestedCssVariables["--color-1"]);
    assert.ok(report.suggestedCssVariables["--space-1"]);

    const jsonReport = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "design-system/design-system-audit.json")) as { findings: unknown[] };
    assert.equal(jsonReport.findings.length, report.findings.length);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "design-system/design-system-audit.md");
    assert.match(markdown, /# Design System Consistency Audit/);
    assert.match(markdown, /Suggested CSS Variables/);
    assert.match(markdown, /button-variant-drift/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audit_design_system_consistency accepts scoped paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "design-system-audit-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Scoped UI", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "styles.css", ":root { --color-primary: #2563eb; --space-1: 8px; } .btn { color: var(--color-primary); padding: var(--space-1); }\n");
    await writeProjectFile(ctx.projectRoot, project.id, "unused.css", ".bad { color: #111; background: #222; border-radius: 1px; font-size: 11px; margin: 11px; }\n");

    const result = await callTool("audit_design_system_consistency", { projectId: project.id, paths: ["styles.css"] }, ctx);
    assert.equal(result.ok, true);
    const report = result.structuredContent as { cssFiles: string[]; findings: Array<{ id: string }> };
    assert.deepEqual(report.cssFiles, ["styles.css"]);
    assert.equal(report.findings.some((finding) => finding.id === "missing-css-tokens"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("design system audit is exposed through coding and debug skills", () => {
  for (const skillId of ["coding", "debug"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill!.toolNames.includes("audit_design_system_consistency"), `${skillId} exposes audit_design_system_consistency`);
  }
});
