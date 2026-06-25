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
    clientId: "model-comparison-test"
  };
}

test("model comparison tools rank candidates by quality, cost, speed, and reliability", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "model-comparison-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Model comparison project", createdByClientId: "coder" });

    const comparisonResult = await callTool("create_model_comparison", {
      projectId: project.id,
      title: "Coding model comparison",
      taskType: "coding",
      prompt: "Fix the failing TypeScript test and explain the patch.",
      criteria: [
        { id: "quality", label: "Correctness", weight: 5 },
        { id: "cost", label: "Cost efficiency", weight: 2 },
        { id: "speed", label: "Speed", weight: 1 },
        { id: "reliability", label: "Reliability", weight: 2 }
      ]
    }, ctx);
    assert.equal(comparisonResult.ok, true);
    const comparisonId = (comparisonResult.structuredContent as { comparison: { id: string } }).comparison.id;
    assert.equal(comparisonId, "comparison_001");

    await callTool("add_model_comparison_candidate", {
      projectId: project.id,
      comparisonId,
      candidate: {
        model: "model-fast",
        provider: "provider-a",
        output: "Short patch with missing edge case.",
        latencyMs: 800,
        estimatedCostUsd: 0.01,
        reliability: 80,
        scores: { quality: 70 },
        notes: "Fast and cheap."
      }
    }, ctx);
    await callTool("add_model_comparison_candidate", {
      projectId: project.id,
      comparisonId,
      candidate: {
        model: "model-balanced",
        provider: "provider-b",
        output: "Correct patch with regression test and explanation.",
        latencyMs: 1400,
        estimatedCostUsd: 0.03,
        reliability: 95,
        scores: { quality: 92 },
        notes: "Best correctness and reliability."
      }
    }, ctx);
    await callTool("add_model_comparison_candidate", {
      projectId: project.id,
      comparisonId,
      candidate: {
        model: "model-expensive",
        provider: "provider-c",
        output: "Verbose patch with extra refactor.",
        latencyMs: 2500,
        estimatedCostUsd: 0.2,
        reliability: 88,
        scores: { quality: 86 },
        notes: "High cost."
      }
    }, ctx);

    const scored = await callTool("score_model_comparison", { projectId: project.id, comparisonId }, ctx);
    const ranking = (scored.structuredContent as { ranking: Array<{ candidate: { model: string; scores: Record<string, number> }; score: number }> }).ranking;
    assert.equal(ranking.length, 3);
    assert.equal(ranking[0].candidate.model, "model-balanced");
    assert.ok(ranking[0].score > ranking[1].score);
    assert.equal(ranking.find((item) => item.candidate.model === "model-fast")?.candidate.scores.cost, 100);
    assert.equal(ranking.find((item) => item.candidate.model === "model-fast")?.candidate.scores.speed, 100);

    const tradeoffs = await callTool("compare_model_tradeoffs", { projectId: project.id, comparisonId, priorities: ["correctness", "reliability"] }, ctx);
    const tradeoffPayload = tradeoffs.structuredContent as {
      tradeoffs: {
        winner: { candidate: { model: string } };
        fastest: { model: string };
        cheapest: { model: string };
        mostReliable: { model: string };
        caveats: string[];
      };
    };
    assert.equal(tradeoffPayload.tradeoffs.winner.candidate.model, "model-balanced");
    assert.equal(tradeoffPayload.tradeoffs.fastest.model, "model-fast");
    assert.equal(tradeoffPayload.tradeoffs.cheapest.model, "model-fast");
    assert.equal(tradeoffPayload.tradeoffs.mostReliable.model, "model-balanced");
    assert.match(tradeoffPayload.tradeoffs.caveats.join(" "), /does not call external model APIs/);

    const report = await callTool("export_model_comparison_report", { projectId: project.id, comparisonId }, ctx);
    assert.equal(report.ok, true);
    assert.deepEqual(report.artifacts, ["model-comparison/model-comparison-report.md"]);
    const markdown = await readFile(path.join(ctx.projectRoot, project.id, "files/model-comparison/model-comparison-report.md"), "utf8");
    assert.match(markdown, /# Model Comparison Report/);
    assert.match(markdown, /model-balanced/);
    assert.match(markdown, /model-fast/);

    const store = JSON.parse(await readFile(path.join(ctx.projectRoot, project.id, "files/model-comparison/model-comparison.json"), "utf8")) as { comparisons: Array<{ candidates: unknown[] }> };
    assert.equal(store.comparisons.length, 1);
    assert.equal(store.comparisons[0].candidates.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("score_model_comparison rejects unknown comparison ids", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "model-comparison-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Model comparison project", createdByClientId: "coder" });
    const result = await callTool("score_model_comparison", { projectId: project.id, comparisonId: "comparison_999" }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.summary, /Model comparison comparison_999 not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model comparison tools are exposed through core, coding, debug, and model-comparison skills", () => {
  const toolNames = ["create_model_comparison", "add_model_comparison_candidate", "score_model_comparison", "compare_model_tradeoffs", "export_model_comparison_report"];
  for (const skillId of ["core", "coding", "debug", "model-comparison"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    for (const toolName of toolNames) {
      assert.ok(skill!.toolNames.includes(toolName), `${skillId} exposes ${toolName}`);
    }
  }
});
