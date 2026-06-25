import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getToolModule } from "../src/mcp/registry.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, readProjectFile } from "../src/projects/store.js";
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
    clientId: "math-verification-test"
  };
}

test("math verification tools check numeric claims, counterexamples, roots, and derivation steps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "math-verification-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Math verification project", createdByClientId: "coder" });
    const numeric = getToolModule("verify_numeric_claim");
    const counterexample = getToolModule("search_math_counterexample");
    const solve = getToolModule("solve_equation_numeric");
    const derivation = getToolModule("verify_derivation_steps");
    assert.ok(numeric, "verify_numeric_claim registered");
    assert.ok(counterexample, "search_math_counterexample registered");
    assert.ok(solve, "solve_equation_numeric registered");
    assert.ok(derivation, "verify_derivation_steps registered");

    const numericResult = await numeric!.handler({
      projectId: project.id,
      expression: "sqrt(a^2 + b^2)",
      variables: { a: 3, b: 4 },
      expected: 5,
      writeToProject: true
    }, ctx);
    assert.equal(numericResult.ok, true);
    assert.deepEqual(numericResult.artifacts, ["math-verification/numeric-claim.json"]);
    const numericPayload = numericResult.structuredContent as { status: string; actual: number; caveats: string[] };
    assert.equal(numericPayload.status, "passed");
    assert.equal(numericPayload.actual, 5);
    assert.match(await readProjectFile(ctx.projectRoot, project.id, "math-verification/numeric-claim.json"), /sqrt/);

    const counterexampleResult = await counterexample!.handler({
      statement: "x^2 = x",
      variables: [{ name: "x", min: -2, max: 2, samples: 5 }]
    }, ctx);
    assert.equal(counterexampleResult.ok, false);
    const counterexamplePayload = counterexampleResult.structuredContent as { status: string; counterexample?: { variables: { x: number }; left: number; right: number } };
    assert.equal(counterexamplePayload.status, "counterexample_found");
    assert.ok(counterexamplePayload.counterexample);
    assert.notEqual(counterexamplePayload.counterexample!.left, counterexamplePayload.counterexample!.right);

    const solveResult = await solve!.handler({
      equation: "x^2 - 2 = 0",
      variable: "x",
      min: 1,
      max: 2,
      tolerance: 1e-8
    }, ctx);
    assert.equal(solveResult.ok, true);
    const solvePayload = solveResult.structuredContent as { status: string; root: number; residual: number };
    assert.equal(solvePayload.status, "solved");
    assert.ok(Math.abs(solvePayload.root - Math.sqrt(2)) < 1e-6);
    assert.ok(Math.abs(solvePayload.residual) < 1e-6);

    const derivationResult = await derivation!.handler({
      steps: ["(x + 1)^2", "x^2 + 2*x + 1", "x^2 + 1"],
      variables: [{ name: "x", min: -3, max: 3, samples: 7 }]
    }, ctx);
    assert.equal(derivationResult.ok, false);
    const derivationPayload = derivationResult.structuredContent as { status: string; checks: Array<{ fromStep: number; toStep: number; equivalentOnSamples: boolean; mismatch?: unknown }> };
    assert.equal(derivationPayload.status, "failed");
    assert.equal(derivationPayload.checks[0].equivalentOnSamples, true);
    assert.equal(derivationPayload.checks[1].equivalentOnSamples, false);
    assert.ok(derivationPayload.checks[1].mismatch);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("math verification tools are exposed through core, coding, debug, and dedicated skills", () => {
  for (const skillId of ["core", "coding", "debug", "math-verification"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill registered`);
    assert.ok(skill!.toolNames.includes("verify_numeric_claim"));
    assert.ok(skill!.toolNames.includes("search_math_counterexample"));
    assert.ok(skill!.toolNames.includes("solve_equation_numeric"));
    assert.ok(skill!.toolNames.includes("verify_derivation_steps"));
  }
});
