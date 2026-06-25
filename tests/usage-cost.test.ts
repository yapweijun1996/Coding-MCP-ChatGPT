import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getToolModule } from "../src/mcp/registry.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, readProjectFile } from "../src/projects/store.js";
import { initializeTelemetry, recordTelemetry } from "../src/telemetry/store.js";
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
    clientId: "usage-cost-test"
  };
}

async function waitForTelemetry(dir: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    if (entries.length) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("usage cost tools record, budget, summarize, export, and import telemetry usage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "usage-cost-"));
  const telemetryRoot = await mkdtemp(path.join(tmpdir(), "usage-telemetry-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Usage cost project", createdByClientId: "coder" });
    const budget = getToolModule("create_usage_budget");
    const record = getToolModule("record_usage_event");
    const summarize = getToolModule("summarize_usage_costs");
    const report = getToolModule("export_usage_cost_report");
    const telemetryImport = getToolModule("import_telemetry_usage");
    assert.ok(budget, "create_usage_budget registered");
    assert.ok(record, "record_usage_event registered");
    assert.ok(summarize, "summarize_usage_costs registered");
    assert.ok(report, "export_usage_cost_report registered");
    assert.ok(telemetryImport, "import_telemetry_usage registered");

    const budgetResult = await budget!.handler({ projectId: project.id, budgetUsd: 0.02, warnAtPercent: 50, hardLimit: true }, ctx);
    assert.equal(budgetResult.ok, true);
    assert.deepEqual(budgetResult.artifacts, ["usage-cost/usage-ledger.json"]);

    const modelEvent = await record!.handler({
      projectId: project.id,
      category: "model_call",
      title: "Draft implementation",
      model: "gpt-test",
      units: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      pricing: { inputTokenUsdPer1K: 0.01, outputTokenUsdPer1K: 0.02 }
    }, ctx);
    assert.equal(modelEvent.ok, true);
    const modelPayload = modelEvent.structuredContent as { event: { estimatedCostUsd: number }; summary: { totalCostUsd: number } };
    assert.equal(modelPayload.event.estimatedCostUsd, 0.02);
    assert.equal(modelPayload.summary.totalCostUsd, 0.02);

    await record!.handler({
      projectId: project.id,
      category: "browser_qa",
      title: "Mobile visual QA",
      toolName: "inspect_webpage_plus",
      units: { browserRuns: 2 },
      pricing: { unitCostUsd: 0.001, unitCount: 2 }
    }, ctx);

    const summary = (await summarize!.handler({ projectId: project.id }, ctx)).structuredContent as {
      totalEvents: number;
      totalCostUsd: number;
      byCategory: Record<string, { count: number; estimatedCostUsd: number }>;
      byTool: Record<string, { count: number; estimatedCostUsd: number }>;
      byModel: Record<string, { count: number; estimatedCostUsd: number }>;
      budgetStatus?: { status: string; spentPercent: number };
    };
    assert.equal(summary.totalEvents, 2);
    assert.equal(summary.totalCostUsd, 0.022);
    assert.equal(summary.byCategory.model_call.estimatedCostUsd, 0.02);
    assert.equal(summary.byTool.inspect_webpage_plus.count, 1);
    assert.equal(summary.byModel["gpt-test"].count, 1);
    assert.equal(summary.budgetStatus?.status, "over_budget");

    const reportResult = await report!.handler({ projectId: project.id }, ctx);
    assert.equal(reportResult.ok, true);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "usage-cost/usage-report.md");
    assert.match(markdown, /Usage and Cost Report/);
    assert.match(markdown, /over_budget/);

    initializeTelemetry(telemetryRoot);
    recordTelemetry({
      id: "usage-telemetry-1",
      time: new Date().toISOString(),
      method: "tools/call",
      toolName: "run_build",
      ok: true,
      durationMs: 123,
      summary: "build ok"
    });
    await waitForTelemetry(telemetryRoot);
    const imported = await telemetryImport!.handler({ projectId: project.id, windowDays: 1, costPerToolCallUsd: 0.005 }, ctx);
    assert.equal(imported.ok, true);
    const importedPayload = imported.structuredContent as { imported: Array<{ toolName?: string; estimatedCostUsd: number }>; summary: { byTool: Record<string, { count: number }> } };
    assert.equal(importedPayload.imported.some((event) => event.toolName === "run_build" && event.estimatedCostUsd === 0.005), true);
    assert.equal(importedPayload.summary.byTool.run_build.count, 1);
  } finally {
    initializeTelemetry("");
    await rm(root, { recursive: true, force: true });
    await rm(telemetryRoot, { recursive: true, force: true });
  }
});

test("usage cost tools are exposed through core, coding, debug, and dedicated skills", () => {
  for (const skillId of ["core", "coding", "debug", "usage-cost"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill registered`);
    assert.ok(skill!.toolNames.includes("record_usage_event"));
    assert.ok(skill!.toolNames.includes("create_usage_budget"));
    assert.ok(skill!.toolNames.includes("summarize_usage_costs"));
    assert.ok(skill!.toolNames.includes("import_telemetry_usage"));
    assert.ok(skill!.toolNames.includes("export_usage_cost_report"));
  }
});
