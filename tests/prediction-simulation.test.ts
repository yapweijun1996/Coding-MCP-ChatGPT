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
    clientId: "prediction-simulation-test"
  };
}

test("prediction and simulation tools create specs, scenarios, backtests, intervals, evaluations, and explanations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prediction-simulation-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Prediction project", createdByClientId: "analyst" });
    const spec = getToolModule("create_prediction_model_spec");
    const scenario = getToolModule("run_scenario_simulation");
    const backtest = getToolModule("backtest_time_series_forecast");
    const intervals = getToolModule("calculate_prediction_intervals");
    const evaluate = getToolModule("evaluate_prediction_model");
    const explain = getToolModule("explain_prediction_errors");
    for (const [name, tool] of Object.entries({ spec, scenario, backtest, intervals, evaluate, explain })) assert.ok(tool, `${name} registered`);

    const specResult = await spec!.handler({
      projectId: project.id,
      title: "Revenue forecast",
      objective: "Forecast next-quarter revenue for planning.",
      target: "revenue",
      horizon: "next quarter",
      features: ["pipeline", "seasonality"],
      assumptions: ["Sales process is stable."]
    }, ctx);
    assert.equal(specResult.ok, true);
    assert.ok(specResult.artifacts.includes("prediction-simulation/model-spec.json"));
    const specFile = await readProjectFile(ctx.projectRoot, project.id, "prediction-simulation/model-spec.json");
    assert.match(specFile, /Revenue forecast/);

    const scenarioResult = await scenario!.handler({
      projectId: project.id,
      baselineValue: 100,
      drivers: [
        { name: "pipeline", baseline: 10 },
        { name: "discount", baseline: 0 }
      ],
      scenarios: [
        { name: "base", changes: { pipeline: 0, discount: 0 }, probability: 0.6 },
        { name: "upside", changes: { pipeline: 15, discount: -2 }, probability: 0.4 }
      ],
      writeToProject: true
    }, ctx);
    const scenarioPayload = scenarioResult.structuredContent as { scenarios: Array<{ name: string; value: number }>; expectedValue: number };
    assert.equal(scenarioPayload.scenarios[0].value, 110);
    assert.equal(scenarioPayload.scenarios[1].value, 123);
    assert.equal(scenarioPayload.expectedValue, 115.2);
    assert.ok(scenarioResult.artifacts.includes("prediction-simulation/scenario-simulation.json"));

    const backtestResult = await backtest!.handler({
      projectId: project.id,
      observations: [
        { time: "2026-01", value: 10 },
        { time: "2026-02", value: 12 },
        { time: "2026-03", value: 14 },
        { time: "2026-04", value: 16 },
        { time: "2026-05", value: 18 }
      ],
      method: "moving_average",
      window: 2,
      writeToProject: true
    }, ctx);
    const backtestPayload = backtestResult.structuredContent as { predictions: unknown[]; metrics: { mae: number } };
    assert.equal(backtestPayload.predictions.length, 3);
    assert.equal(backtestPayload.metrics.mae, 3);
    assert.ok(backtestResult.artifacts.includes("prediction-simulation/backtest-report.json"));

    const intervalResult = await intervals!.handler({
      projectId: project.id,
      predictions: [{ time: "2026-06", predicted: 20 }],
      residuals: [1, -1, 2, -2],
      confidence: "0.9"
    }, ctx);
    const intervalPayload = intervalResult.structuredContent as { margin: number; intervals: Array<{ lower: number; upper: number }> };
    assert.equal(intervalPayload.margin, 3.003);
    assert.equal(intervalPayload.intervals[0].lower, 16.997);
    assert.equal(intervalPayload.intervals[0].upper, 23.003);

    const pairs = [
      { actual: 100, predicted: 110, segment: "enterprise", time: "a", features: { region: "north" } },
      { actual: 80, predicted: 70, segment: "smb", time: "b", features: { region: "south" } },
      { actual: 120, predicted: 130, segment: "enterprise", time: "c", features: { region: "north" } }
    ];
    const evaluationResult = await evaluate!.handler({ projectId: project.id, pairs, writeToProject: true }, ctx);
    const evaluationPayload = evaluationResult.structuredContent as { metrics: { mae: number; rmse: number; bias: number; mape: number }; residualStdDev: number };
    assert.equal(evaluationPayload.metrics.mae, 10);
    assert.equal(evaluationPayload.metrics.rmse, 10);
    assert.equal(evaluationPayload.metrics.bias, 3.333);
    assert.equal(evaluationPayload.metrics.mape, 10.278);
    assert.equal(evaluationPayload.residualStdDev, 11.547);

    const explanationResult = await explain!.handler({ projectId: project.id, pairs, topN: 2, writeToProject: true }, ctx);
    const explanationPayload = explanationResult.structuredContent as { topErrors: unknown[]; segmentSummary: Array<{ segment: string; mae: number }> };
    assert.equal(explanationPayload.topErrors.length, 2);
    assert.equal(explanationPayload.segmentSummary.some((item) => item.segment === "enterprise" && item.mae === 10), true);
    assert.ok(explanationResult.artifacts.includes("prediction-simulation/error-explanation.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prediction-simulation skill exposes prediction tools through dedicated, coding, and debug skills", () => {
  const toolNames = [
    "create_prediction_model_spec",
    "run_scenario_simulation",
    "backtest_time_series_forecast",
    "calculate_prediction_intervals",
    "evaluate_prediction_model",
    "explain_prediction_errors"
  ];
  const prediction = skillRegistry.find((entry) => entry.id === "prediction-simulation");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(prediction);
  for (const toolName of toolNames) {
    assert.ok(prediction!.toolNames.includes(toolName), `${toolName} exposed in prediction-simulation`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
