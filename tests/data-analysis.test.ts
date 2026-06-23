import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, readProjectFile, writeProjectFile } from "../src/projects/store.js";
import { skillRegistry } from "../src/skills/registry.js";
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
    clientId: "data-analysis-test"
  };
}

test("data analysis tools load, profile, clean, chart, forecast, and export reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "data-analysis-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Data project", createdByClientId: "analyst" });
    await writeProjectFile(ctx.projectRoot, project.id, "data/sales.txt", [
      "month,revenue,region,notes",
      "2026-01,100,North, good ",
      "2026-02,150,North,",
      "2026-03,210,South, strong ",
      "2026-04,,South,"
    ].join("\n"));

    const load = getToolModule("load_dataset_preview");
    const profile = getToolModule("profile_dataset_quality");
    const clean = getToolModule("clean_dataset_preview");
    const chart = getToolModule("create_dataset_chart_spec");
    const forecast = getToolModule("forecast_dataset_trend");
    const report = getToolModule("export_data_analysis_report");
    for (const [name, tool] of Object.entries({ load, profile, clean, chart, forecast, report })) assert.ok(tool, `${name} registered`);

    const loaded = await load!.handler({ projectId: project.id, path: "data/sales.txt", format: "csv", maxRows: 3 }, ctx);
    assert.equal(loaded.ok, true);
    const loadedPayload = loaded.structuredContent as { rows: Array<Record<string, unknown>>; profile: { rowCount: number } };
    assert.equal(loadedPayload.rows.length, 3);
    assert.equal(loadedPayload.profile.rowCount, 3);

    const profiled = await profile!.handler({ projectId: project.id, path: "data/sales.txt", format: "csv" }, ctx);
    const profilePayload = profiled.structuredContent as { rowCount: number; schema: Array<{ name: string; type: string; missing: number; stats?: { mean: number } }>; qualityIssues: string[] };
    assert.equal(profilePayload.rowCount, 4);
    assert.equal(profilePayload.schema.some((field) => field.name === "revenue" && field.type === "number" && field.missing === 1), true);
    assert.equal(profilePayload.schema.some((field) => field.name === "revenue" && field.stats?.mean === 153.333), true);

    const cleaned = await clean!.handler({ projectId: project.id, path: "data/sales.txt", format: "csv", maxRows: 4 }, ctx);
    const cleanedPayload = cleaned.structuredContent as { rows: Array<Record<string, unknown>> };
    assert.equal(cleanedPayload.rows[0].notes, "good");
    assert.equal(cleanedPayload.rows[1].notes, null);
    assert.equal(typeof cleanedPayload.rows[0].revenue, "number");

    const chartSpec = await chart!.handler({ projectId: project.id, path: "data/sales.txt", format: "csv", chartType: "line", xField: "month", yField: "revenue", groupBy: "region" }, ctx);
    const chartPayload = chartSpec.structuredContent as { chartType: string; data: unknown[]; fields: { x: string; y: string; color?: string } };
    assert.equal(chartPayload.chartType, "line");
    assert.equal(chartPayload.fields.x, "month");
    assert.equal(chartPayload.fields.color, "region");
    assert.equal(chartPayload.data.length, 4);

    const forecasted = await forecast!.handler({ projectId: project.id, path: "data/sales.txt", format: "csv", timeField: "month", valueField: "revenue", periods: 2 }, ctx);
    const forecastPayload = forecasted.structuredContent as { forecast: Array<{ predictedValue: number }>; caveats: string[] };
    assert.equal(forecastPayload.forecast.length, 2);
    assert.equal(forecastPayload.caveats.length > 0, true);

    const exported = await report!.handler({ projectId: project.id, path: "data/sales.txt", format: "csv", title: "Sales Analysis", questions: ["How is revenue trending?"], writeToProject: true }, ctx);
    assert.equal(exported.ok, true);
    assert.ok(exported.artifacts.includes("reports/data-analysis-report.md"));
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "reports/data-analysis-report.md");
    assert.match(markdown, /# Sales Analysis/);
    assert.match(markdown, /Rows: 4/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("data analysis tools support inline JSON-style rows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "data-analysis-inline-"));
  try {
    const ctx = toolContext(root);
    const profile = getToolModule("profile_dataset_quality");
    assert.ok(profile);
    const result = await profile!.handler({ rows: [{ segment: "A", value: 1 }, { segment: "B", value: 3 }] }, ctx);
    assert.equal(result.ok, true);
    const payload = result.structuredContent as { schema: Array<{ name: string; type: string }> };
    assert.equal(payload.schema.some((field) => field.name === "value" && field.type === "number"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("data-analysis skill exposes data analysis tools", () => {
  const skill = skillRegistry.find((entry) => entry.id === "data-analysis");
  assert.ok(skill);
  for (const toolName of [
    "load_dataset_preview",
    "profile_dataset_quality",
    "clean_dataset_preview",
    "create_dataset_chart_spec",
    "forecast_dataset_trend",
    "export_data_analysis_report"
  ]) {
    assert.ok(skill!.toolNames.includes(toolName), `${toolName} exposed`);
  }
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(coding?.toolNames.includes("profile_dataset_quality"));
  assert.ok(debug?.toolNames.includes("profile_dataset_quality"));
});
