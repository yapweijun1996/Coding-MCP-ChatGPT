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
    clientId: "test-automation-test"
  };
}

const target = {
  id: "checkout_smoke",
  kind: "smoke",
  title: "Checkout smoke test",
  subject: "checkout page",
  expectedBehavior: "Cart checkout remains available and no runtime errors appear.",
  selectors: ["button[type=submit]", "#cart-total"],
  risk: "high"
};

test("test automation tools plan, generate, run-map, explain, cover, and report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "test-automation-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Test automation project", createdByClientId: "qa" });
    const planTool = getToolModule("create_test_automation_plan");
    const caseTool = getToolModule("generate_test_case_spec");
    const matrixTool = getToolModule("create_test_run_matrix");
    const explainTool = getToolModule("explain_test_results");
    const coverageTool = getToolModule("create_coverage_report");
    const reportTool = getToolModule("export_test_automation_report");
    for (const [name, tool] of Object.entries({ planTool, caseTool, matrixTool, explainTool, coverageTool, reportTool })) assert.ok(tool, `${name} registered`);

    const plan = await planTool!.handler({
      projectId: project.id,
      title: "Checkout Test Plan",
      framework: "mixed",
      targets: [
        target,
        { id: "pricing_api", kind: "api", title: "Pricing API contract", subject: "pricing endpoint", apiEndpoint: "/api/pricing", expectedBehavior: "Response includes price and currency." },
        { id: "unit_discount", kind: "unit", title: "Discount calculation", subject: "calculateDiscount", expectedBehavior: "Discount is rounded consistently." }
      ],
      coverageThreshold: 85
    }, ctx);
    assert.equal(plan.ok, true);
    assert.ok(plan.artifacts.includes("test-automation/test-plan.json"));
    const planPayload = plan.structuredContent as { testCases: Array<{ id: string; data: { recommendedMcpTool: string } }> };
    assert.equal(planPayload.testCases.length, 3);
    assert.equal(planPayload.testCases[0].data.recommendedMcpTool, "run_smoke_flow");

    const generated = await caseTool!.handler({ projectId: project.id, target, framework: "playwright" }, ctx);
    assert.equal(generated.ok, true);
    assert.ok(generated.artifacts.includes("test-automation/cases/checkout_smoke_smoke.json"));

    const matrix = await matrixTool!.handler({
      projectId: project.id,
      suites: [
        { name: "unit", kind: "unit", command: "npm test", required: true },
        { name: "browser smoke", kind: "browser", required: true },
        { name: "api contract", kind: "api", required: false }
      ]
    }, ctx);
    assert.equal(matrix.ok, true);
    const matrixPayload = matrix.structuredContent as { suites: Array<{ name: string; mcpTool: string; order: number }> };
    assert.deepEqual(matrixPayload.suites.map((suite) => suite.mcpTool), ["run_tests", "run_smoke_flow", "api_contract_test"]);
    assert.equal(matrixPayload.suites[2].order, 3);

    const explained = await explainTool!.handler({
      logs: "ok 1 unit\nnot ok 2 checkout timeout\nError: button not found",
      expectedSuites: ["unit", "checkout"]
    }, ctx);
    assert.equal(explained.ok, false);
    const explanation = explained.structuredContent as { status: string; failedLines: string[] };
    assert.equal(explanation.status, "failed");
    assert.equal(explanation.failedLines.some((line) => line.includes("timeout")), true);

    const coverage = await coverageTool!.handler({
      projectId: project.id,
      summary: { lines: 78, branches: 65, functions: 91, statements: 82 },
      thresholds: { lines: 80, branches: 70, functions: 80, statements: 80 },
      files: [{ path: "src/checkout.ts", lines: 62, uncoveredLines: [12, 24] }]
    }, ctx);
    assert.equal(coverage.ok, false);
    const coveragePayload = coverage.structuredContent as { failures: string[]; weakestFiles: Array<{ path: string }> };
    assert.deepEqual(coveragePayload.failures, ["branches coverage 65% is below 70%.", "lines coverage 78% is below 80%."]);
    assert.equal(coveragePayload.weakestFiles[0].path, "src/checkout.ts");

    const report = await reportTool!.handler({
      projectId: project.id,
      title: "Test Automation Report",
      plan: plan.structuredContent,
      runMatrix: matrix.structuredContent,
      resultExplanation: explanation,
      coverage: coveragePayload,
      recommendations: ["Add checkout button presence assertion before submit."]
    }, ctx);
    assert.equal(report.ok, true);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "test-automation/test-automation-report.md");
    assert.match(markdown, /# Test Automation Report/);
    assert.match(markdown, /checkout button presence/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("test-automation skill exposes tools through dedicated, coding, and debug skills", () => {
  const toolNames = [
    "create_test_automation_plan",
    "generate_test_case_spec",
    "create_test_run_matrix",
    "explain_test_results",
    "create_coverage_report",
    "export_test_automation_report"
  ];
  const testAutomation = skillRegistry.find((entry) => entry.id === "test-automation");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(testAutomation);
  for (const toolName of toolNames) {
    assert.ok(testAutomation!.toolNames.includes(toolName), `${toolName} exposed in test-automation`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
