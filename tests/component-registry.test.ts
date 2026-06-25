import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject } from "../src/projects/store.js";
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
    clientId: "component-registry-test"
  };
}

test("component registry registers, filters, recommends, plans reuse, and exports reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "component-registry-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Component registry project", createdByClientId: "coder" });

    const button = await callTool("register_reusable_component", {
      projectId: project.id,
      component: {
        id: "primary-action-button",
        name: "Primary Action Button",
        kind: "component",
        summary: "Accessible primary button with loading and destructive variants.",
        tags: ["button", "accessibility", "forms"],
        files: [
          { path: "src/components/Button.tsx", role: "source", exportName: "Button" },
          { path: "src/components/Button.test.tsx", role: "test" }
        ],
        props: [
          { name: "variant", type: "\"primary\" | \"danger\"", description: "Visual treatment." },
          { name: "loading", type: "boolean", required: false, description: "Shows loading state." }
        ],
        variants: ["primary", "danger", "loading"],
        dependencies: ["react"],
        usageNotes: ["Use for form submission and critical action rows."],
        accessibilityNotes: ["Keep an accessible label when icon-only."],
        maturity: "stable"
      }
    }, ctx);
    assert.equal(button.ok, true);

    const chart = await callTool("register_reusable_component", {
      projectId: project.id,
      component: {
        id: "kpi-trend-chart",
        name: "KPI Trend Chart",
        kind: "chart",
        summary: "Responsive line chart pattern for KPI trend and segment comparison.",
        tags: ["chart", "kpi", "dashboard"],
        files: [{ path: "src/charts/KpiTrend.tsx", role: "source", exportName: "KpiTrend" }],
        props: [{ name: "series", type: "Array<{date:string,value:number}>", required: true }],
        variants: ["single-series", "multi-series"],
        dependencies: ["recharts"],
        usageNotes: ["Use one row per time bucket and keep axes labeled."],
        accessibilityNotes: ["Provide a table fallback for screen readers."],
        maturity: "usable"
      }
    }, ctx);
    assert.equal(chart.ok, true);

    const listed = await callTool("list_reusable_components", { projectId: project.id, kind: "chart", tag: "dashboard" }, ctx);
    const listedPayload = listed.structuredContent as { components: Array<{ id: string }>; summary: { total: number; byKind: Record<string, number> } };
    assert.equal(listedPayload.components.length, 1);
    assert.equal(listedPayload.components[0].id, "kpi-trend-chart");
    assert.equal(listedPayload.summary.byKind.chart, 1);

    const recommendations = await callTool("recommend_reusable_components", {
      projectId: project.id,
      need: "Need a dashboard KPI chart with responsive trend comparison",
      kind: "chart",
      desiredTags: ["dashboard", "kpi"]
    }, ctx);
    const ranked = (recommendations.structuredContent as { recommendations: Array<{ component: { id: string }; score: number }> }).recommendations;
    assert.equal(ranked[0].component.id, "kpi-trend-chart");
    assert.ok(ranked[0].score > 0);

    const plan = await callTool("create_component_reuse_plan", {
      projectId: project.id,
      componentIds: ["primary-action-button", "kpi-trend-chart"],
      targetProjectId: "project_target_123456",
      outputPath: "components/reuse-plan.md"
    }, ctx);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.artifacts.slice(0, 3), ["components/reuse-plan.md", "primary-action-button", "kpi-trend-chart"]);
    const planMarkdown = await readFile(path.join(ctx.projectRoot, project.id, "files/components/reuse-plan.md"), "utf8");
    assert.match(planMarkdown, /# Component Reuse Plan/);
    assert.match(planMarkdown, /Primary Action Button/);
    assert.match(planMarkdown, /KPI Trend Chart/);
    assert.match(planMarkdown, /table fallback/);

    const exported = await callTool("export_component_registry_report", { projectId: project.id }, ctx);
    assert.equal(exported.ok, true);
    assert.deepEqual(exported.artifacts, ["components/component-registry.md"]);
    const reportMarkdown = await readFile(path.join(ctx.projectRoot, project.id, "files/components/component-registry.md"), "utf8");
    assert.match(reportMarkdown, /# Component Registry/);
    assert.match(reportMarkdown, /primary-action-button/);
    assert.match(reportMarkdown, /kpi-trend-chart/);

    const registry = JSON.parse(await readFile(path.join(ctx.projectRoot, project.id, "files/components/component-registry.json"), "utf8")) as { components: unknown[] };
    assert.equal(registry.components.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create_component_reuse_plan rejects missing registry entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "component-registry-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Component registry project", createdByClientId: "coder" });
    const result = await callTool("create_component_reuse_plan", { projectId: project.id, componentIds: ["missing-component"] }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.summary, /Reusable component missing-component not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("component registry tools are exposed through core, coding, debug, and component-registry skills", () => {
  const toolNames = ["register_reusable_component", "list_reusable_components", "recommend_reusable_components", "create_component_reuse_plan", "export_component_registry_report"];
  for (const skillId of ["core", "coding", "debug", "component-registry"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    for (const toolName of toolNames) {
      assert.ok(skill!.toolNames.includes(toolName), `${skillId} exposes ${toolName}`);
    }
  }
});
