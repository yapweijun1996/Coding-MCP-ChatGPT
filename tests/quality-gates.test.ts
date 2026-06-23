import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, readProjectFile } from "../src/projects/store.js";
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
    clientId: "quality-gates-test"
  };
}

test("quality gate tools create preset plans, evaluate results, and export reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "quality-gates-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Quality gate project", createdByClientId: "quality" });

    const list = getToolModule("list_quality_gate_presets");
    const plan = getToolModule("create_quality_gate_plan");
    const evaluate = getToolModule("evaluate_quality_gate_results");
    const runbook = getToolModule("create_quality_gate_runbook");
    const compare = getToolModule("compare_quality_gate_presets");
    const report = getToolModule("export_quality_gate_report");
    for (const [name, tool] of Object.entries({ list, plan, evaluate, runbook, compare, report })) assert.ok(tool, `${name} registered`);

    const listResult = await list!.handler({}, ctx);
    assert.equal(listResult.ok, true);
    const listPayload = listResult.structuredContent as { presets: Array<{ preset: string; checks: Array<{ id: string }> }> };
    assert.deepEqual(listPayload.presets.map((item) => item.preset).sort(), ["accessibility", "data_app", "demo", "game", "mobile", "production", "pwa"].sort());

    const planResult = await plan!.handler({ projectId: project.id, preset: "pwa", strictness: "strict" }, ctx);
    assert.equal(planResult.ok, true);
    const planPayload = planResult.structuredContent as { checks: Array<{ id: string; recommendedTools: string[] }> };
    assert.equal(planPayload.checks.some((check) => check.id === "pwa-audit" && check.recommendedTools.includes("audit_project_pwa")), true);
    assert.equal(planPayload.checks.some((check) => check.id === "evidence-complete"), true);

    const blockedResult = await evaluate!.handler({
      projectId: project.id,
      preset: "pwa",
      strictness: "standard",
      results: [
        { checkId: "static-validation", status: "passed", evidence: ["validate_project ok"] },
        { checkId: "browser-smoke", status: "passed", evidence: ["browser screenshot"] },
        { checkId: "console-clean", status: "passed", evidence: ["console report"] },
        { checkId: "pwa-audit", status: "failed", evidence: ["missing service worker"] }
      ]
    }, ctx);
    assert.equal(blockedResult.ok, false);
    const blockedPayload = blockedResult.structuredContent as { status: string; blockingCheckIds: string[]; nextActions: string[] };
    assert.equal(blockedPayload.status, "blocked");
    assert.deepEqual(blockedPayload.blockingCheckIds, ["pwa-audit"]);
    assert.equal(blockedPayload.nextActions.some((action) => action.includes("pwa-audit")), true);

    const passedResult = await evaluate!.handler({
      projectId: project.id,
      preset: "demo",
      results: [
        { checkId: "static-validation", status: "passed", evidence: ["validate_project ok"] },
        { checkId: "browser-smoke", status: "passed", evidence: ["browser screenshot"] },
        { checkId: "console-clean", status: "passed", evidence: ["console report"] },
        { checkId: "demo-content-ready", status: "passed", evidence: ["visual review"] }
      ]
    }, ctx);
    assert.equal(passedResult.ok, true);
    const passedPayload = passedResult.structuredContent as { status: string; blockingCheckIds: string[] };
    assert.equal(passedPayload.status, "passed");
    assert.deepEqual(passedPayload.blockingCheckIds, []);

    const runbookResult = await runbook!.handler({ projectId: project.id, preset: "mobile" }, ctx);
    assert.equal(runbookResult.ok, true);
    const runbookMarkdown = await readProjectFile(ctx.projectRoot, project.id, "quality-gates/quality-gate-runbook.md");
    assert.match(runbookMarkdown, /mobile Quality Gate Runbook/);
    assert.match(runbookMarkdown, /mobile-viewports/);

    const compareResult = await compare!.handler({ presets: ["demo", "production", "game"] }, ctx);
    assert.equal(compareResult.ok, true);
    const comparePayload = compareResult.structuredContent as { comparison: Array<{ preset: string; criticalChecks: string[] }> };
    assert.equal(comparePayload.comparison.some((item) => item.preset === "game" && item.criticalChecks.includes("game-loop")), true);

    const reportResult = await report!.handler({ projectId: project.id, preset: "demo", evaluation: passedPayload }, ctx);
    assert.equal(reportResult.ok, true);
    const reportMarkdown = await readProjectFile(ctx.projectRoot, project.id, "quality-gates/quality-gate-report.md");
    assert.match(reportMarkdown, /Quality Gate Report/);
    assert.match(reportMarkdown, /"status": "passed"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quality-gates skill exposes tools through coding and debug skills", () => {
  const toolNames = [
    "list_quality_gate_presets",
    "create_quality_gate_plan",
    "evaluate_quality_gate_results",
    "create_quality_gate_runbook",
    "compare_quality_gate_presets",
    "export_quality_gate_report"
  ];
  const quality = skillRegistry.find((entry) => entry.id === "quality-gates");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(quality);
  for (const toolName of toolNames) {
    assert.ok(quality!.toolNames.includes(toolName), `${toolName} exposed in quality-gates`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
