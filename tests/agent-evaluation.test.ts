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
    clientId: "agent-evaluation-test"
  };
}

const criteria = [
  { id: "requirements", label: "Requirements covered", weight: 3, passingScore: 80, requiredSignals: ["issue_0069", "agent evaluation", "requirements satisfied"] },
  { id: "verification", label: "Verification evidence", weight: 2, passingScore: 80, requiredSignals: ["npm test", "check:mcp"], negativeSignals: ["not run"] }
];

test("agent evaluation tools score output, requirements, versions, regressions, and reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-evaluation-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Evaluation project", createdByClientId: "eval" });
    const rubric = getToolModule("create_agent_evaluation_rubric");
    const score = getToolModule("score_agent_output");
    const requirements = getToolModule("evaluate_requirement_satisfaction");
    const compare = getToolModule("compare_agent_output_versions");
    const regressions = getToolModule("detect_agent_regressions");
    const report = getToolModule("export_agent_evaluation_report");
    for (const [name, tool] of Object.entries({ rubric, score, requirements, compare, regressions, report })) assert.ok(tool, `${name} registered`);

    const rubricResult = await rubric!.handler({ projectId: project.id, title: "Final Output Rubric", criteria }, ctx);
    assert.equal(rubricResult.ok, true);
    assert.ok(rubricResult.artifacts.includes("agent-evaluation/rubric.json"));

    const finalOutput = "Resolved issue_0069 by adding agent evaluation tools. Requirements satisfied with npm test and check:mcp evidence.";
    const evidence = ["issue_0069 implementation completed", "npm test passed", "check:mcp passed"];
    const scoreResult = await score!.handler({ projectId: project.id, finalOutput, evidence, criteria, writeToProject: true }, ctx);
    assert.equal(scoreResult.ok, true);
    const scorePayload = scoreResult.structuredContent as { overallScore: number; passed: boolean; criteriaResults: Array<{ id: string; score: number }> };
    assert.equal(scorePayload.overallScore, 100);
    assert.equal(scorePayload.passed, true);

    const requirementResult = await requirements!.handler({
      projectId: project.id,
      requirements: [
        { id: "score", text: "score final output quality", priority: "must" },
        { id: "compare", text: "compare versions and detect regressions", priority: "must" }
      ],
      finalOutput: "The tools score final output quality, compare versions, and detect regressions.",
      evidence: ["score requirement covered", "compare versions check covered", "regressions check covered"],
      writeToProject: true
    }, ctx);
    assert.equal(requirementResult.ok, true);
    const requirementPayload = requirementResult.structuredContent as { satisfiedCount: number; totalCount: number };
    assert.equal(requirementPayload.satisfiedCount, 2);
    assert.equal(requirementPayload.totalCount, 2);

    const compareResult = await compare!.handler({
      projectId: project.id,
      baseline: { label: "v1", score: 70, summary: "Initial answer", findings: ["missing evidence", "no regression check"] },
      candidate: { label: "v2", score: 92, summary: "Verified answer", findings: [] },
      writeToProject: true
    }, ctx);
    assert.equal(compareResult.ok, true);
    const comparePayload = compareResult.structuredContent as { decision: string; delta: number; resolvedFindings: string[] };
    assert.equal(comparePayload.decision, "candidate_better");
    assert.equal(comparePayload.delta, 22);
    assert.equal(comparePayload.resolvedFindings.length, 2);

    const regressionResult = await regressions!.handler({
      projectId: project.id,
      baselineChecks: [{ id: "typecheck", status: "pass" }, { id: "npm-test", status: "pass" }],
      candidateChecks: [{ id: "typecheck", status: "pass" }, { id: "npm-test", status: "fail", detail: "one failure" }],
      writeToProject: true
    }, ctx);
    assert.equal(regressionResult.ok, false);
    const regressionPayload = regressionResult.structuredContent as { regressionCount: number; regressions: Array<{ id: string }> };
    assert.equal(regressionPayload.regressionCount, 1);
    assert.equal(regressionPayload.regressions[0].id, "npm-test");

    const reportResult = await report!.handler({
      projectId: project.id,
      title: "Agent Evaluation Report",
      outputScore: scorePayload,
      requirementSatisfaction: requirementPayload,
      versionComparison: comparePayload,
      regressions: regressionPayload,
      recommendations: ["Fix npm-test regression before final handoff."]
    }, ctx);
    assert.equal(reportResult.ok, true);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "agent-evaluation/evaluation-report.md");
    assert.match(markdown, /# Agent Evaluation Report/);
    assert.match(markdown, /Fix npm-test regression/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent-evaluation skill exposes tools through core, coding, and debug skills", () => {
  const toolNames = [
    "create_agent_evaluation_rubric",
    "score_agent_output",
    "evaluate_requirement_satisfaction",
    "compare_agent_output_versions",
    "detect_agent_regressions",
    "export_agent_evaluation_report"
  ];
  const evaluation = skillRegistry.find((entry) => entry.id === "agent-evaluation");
  const core = skillRegistry.find((entry) => entry.id === "core");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(evaluation);
  for (const toolName of toolNames) {
    assert.ok(evaluation!.toolNames.includes(toolName), `${toolName} exposed in agent-evaluation`);
    assert.ok(core?.toolNames.includes(toolName), `${toolName} exposed in core`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
