import { z } from "zod";
import { writeProjectFile } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const numericPointSchema = z.object({
  time: z.string().min(1).max(120),
  value: z.number()
});

const predictionPairSchema = z.object({
  actual: z.number(),
  predicted: z.number(),
  time: z.string().min(1).max(120).optional(),
  segment: z.string().min(1).max(120).optional(),
  features: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().default({})
});

const createPredictionModelSpecInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160),
  objective: z.string().min(1).max(1000),
  target: z.string().min(1).max(120),
  horizon: z.string().min(1).max(120),
  method: z.enum(["naive", "moving_average", "linear_trend", "scenario_model", "custom"]).optional().default("linear_trend"),
  features: z.array(z.string().min(1).max(120)).max(80).optional().default([]),
  assumptions: z.array(z.string().min(1).max(300)).max(40).optional().default([]),
  metrics: z.array(z.enum(["mae", "rmse", "mape", "bias", "r2"])).max(5).optional().default(["mae", "rmse", "mape"]),
  outputPath: z.string().min(1).max(240).optional().default("prediction-simulation/model-spec.json")
});

const scenarioDriverSchema = z.object({
  name: z.string().min(1).max(120),
  baseline: z.number().optional().default(0),
  unit: z.string().min(1).max(40).optional(),
  description: z.string().min(1).max(240).optional()
});

const scenarioSchema = z.object({
  name: z.string().min(1).max(120),
  changes: z.record(z.string(), z.number()).optional().default({}),
  probability: z.number().min(0).max(1).optional()
});

const runScenarioSimulationInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  baselineValue: z.number(),
  drivers: z.array(scenarioDriverSchema).min(1).max(50),
  scenarios: z.array(scenarioSchema).min(1).max(100),
  mode: z.enum(["additive", "multiplicative"]).optional().default("additive"),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("prediction-simulation/scenario-simulation.json")
});

const backtestTimeSeriesForecastInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  observations: z.array(numericPointSchema).min(4).max(2000),
  method: z.enum(["naive", "moving_average", "linear_trend"]).optional().default("moving_average"),
  window: z.number().int().min(2).max(365).optional().default(3),
  horizon: z.number().int().min(1).max(30).optional().default(1),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("prediction-simulation/backtest-report.json")
});

const calculatePredictionIntervalsInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  predictions: z.array(z.object({
    time: z.string().min(1).max(120).optional(),
    predicted: z.number()
  })).min(1).max(1000),
  residuals: z.array(z.number()).min(2).max(5000).optional(),
  errorStdDev: z.number().min(0).optional(),
  confidence: z.enum(["0.8", "0.9", "0.95"]).optional().default("0.9"),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("prediction-simulation/prediction-intervals.json")
}).refine((input) => Boolean(input.residuals || input.errorStdDev !== undefined), {
  message: "Provide residuals or errorStdDev."
});

const evaluatePredictionModelInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  pairs: z.array(predictionPairSchema).min(1).max(5000),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("prediction-simulation/model-evaluation.json")
});

const explainPredictionErrorsInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  pairs: z.array(predictionPairSchema).min(1).max(5000),
  topN: z.number().int().min(1).max(50).optional().default(10),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("prediction-simulation/error-explanation.json")
});

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function metrics(pairs: Array<{ actual: number; predicted: number }>): Record<string, number> {
  const errors = pairs.map((pair) => pair.predicted - pair.actual);
  const absolutes = errors.map((error) => Math.abs(error));
  const squared = errors.map((error) => error ** 2);
  const actuals = pairs.map((pair) => pair.actual);
  const actualMean = mean(actuals);
  const ssResidual = pairs.reduce((sum, pair) => sum + (pair.actual - pair.predicted) ** 2, 0);
  const ssTotal = pairs.reduce((sum, pair) => sum + (pair.actual - actualMean) ** 2, 0);
  const mapeValues = pairs.filter((pair) => pair.actual !== 0).map((pair) => Math.abs((pair.actual - pair.predicted) / pair.actual));
  return {
    count: pairs.length,
    mae: round(mean(absolutes)),
    rmse: round(Math.sqrt(mean(squared))),
    mape: round(mean(mapeValues) * 100),
    bias: round(mean(errors)),
    r2: ssTotal === 0 ? 0 : round(1 - ssResidual / ssTotal)
  };
}

function linearPrediction(values: number[], nextIndex: number): number {
  if (values.length < 2) return values.at(-1) ?? 0;
  const xs = values.map((_, index) => index + 1);
  const xMean = mean(xs);
  const yMean = mean(values);
  const numerator = xs.reduce((sum, x, index) => sum + (x - xMean) * (values[index] - yMean), 0);
  const denominator = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = yMean - slope * xMean;
  return intercept + slope * nextIndex;
}

function forecast(values: number[], method: "naive" | "moving_average" | "linear_trend", window: number, horizon: number): number {
  if (method === "naive") return values.at(-1) ?? 0;
  if (method === "moving_average") return mean(values.slice(-window));
  return linearPrediction(values, values.length + horizon);
}

function backtest(observations: Array<z.infer<typeof numericPointSchema>>, method: "naive" | "moving_average" | "linear_trend", window: number, horizon: number) {
  const sorted = observations.slice();
  const predictions: Array<{ time: string; actual: number; predicted: number; trainSize: number }> = [];
  for (let index = window; index + horizon - 1 < sorted.length; index += 1) {
    const train = sorted.slice(0, index).map((point) => point.value);
    const target = sorted[index + horizon - 1];
    predictions.push({
      time: target.time,
      actual: target.value,
      predicted: round(forecast(train, method, window, horizon)),
      trainSize: train.length
    });
  }
  return {
    method,
    window,
    horizon,
    predictions,
    metrics: metrics(predictions),
    caveats: ["Backtest uses the input row order as time order.", "No seasonality, external drivers, or uncertainty model is inferred."]
  };
}

function runScenarios(input: z.infer<typeof runScenarioSimulationInputSchema>) {
  const driverBaselines = Object.fromEntries(input.drivers.map((driver) => [driver.name, driver.baseline]));
  const rows = input.scenarios.map((scenario) => {
    const unknownDrivers = Object.keys(scenario.changes).filter((name) => !(name in driverBaselines));
    const value = Object.entries(scenario.changes).reduce((current, [name, change]) => {
      const base = driverBaselines[name] ?? 0;
      if (input.mode === "multiplicative") return current * (1 + change);
      return current + base + change;
    }, input.baselineValue);
    return {
      name: scenario.name,
      probability: scenario.probability,
      value: round(value),
      delta: round(value - input.baselineValue),
      unknownDrivers
    };
  });
  const expectedValue = rows.every((row) => typeof row.probability === "number")
    ? round(rows.reduce((sum, row) => sum + row.value * (row.probability ?? 0), 0))
    : undefined;
  return {
    baselineValue: input.baselineValue,
    mode: input.mode,
    drivers: input.drivers,
    scenarios: rows,
    expectedValue,
    caveats: ["Scenario outputs are deterministic arithmetic from provided assumptions, not statistical forecasts."]
  };
}

function zScore(confidence: "0.8" | "0.9" | "0.95"): number {
  return confidence === "0.95" ? 1.96 : confidence === "0.9" ? 1.645 : 1.282;
}

function intervals(input: z.infer<typeof calculatePredictionIntervalsInputSchema>) {
  const sigma = input.errorStdDev ?? stddev(input.residuals ?? []);
  const margin = zScore(input.confidence) * sigma;
  return {
    confidence: Number(input.confidence),
    errorStdDev: round(sigma),
    margin: round(margin),
    intervals: input.predictions.map((item) => ({
      time: item.time,
      predicted: item.predicted,
      lower: round(item.predicted - margin),
      upper: round(item.predicted + margin)
    })),
    caveats: ["Intervals assume symmetric normally distributed residuals and do not model changing variance."]
  };
}

function explainErrors(pairs: Array<z.infer<typeof predictionPairSchema>>, topN: number) {
  const enriched = pairs.map((pair, index) => {
    const error = pair.predicted - pair.actual;
    return {
      index,
      time: pair.time,
      segment: pair.segment,
      actual: pair.actual,
      predicted: pair.predicted,
      error: round(error),
      absoluteError: round(Math.abs(error)),
      percentError: pair.actual === 0 ? undefined : round((error / pair.actual) * 100),
      features: pair.features
    };
  });
  const bySegment = new Map<string, { count: number; absoluteError: number; bias: number }>();
  for (const row of enriched) {
    const key = row.segment ?? "unsegmented";
    const current = bySegment.get(key) ?? { count: 0, absoluteError: 0, bias: 0 };
    current.count += 1;
    current.absoluteError += row.absoluteError;
    current.bias += row.error;
    bySegment.set(key, current);
  }
  const segmentSummary = [...bySegment.entries()].map(([segment, item]) => ({
    segment,
    count: item.count,
    mae: round(item.absoluteError / item.count),
    bias: round(item.bias / item.count)
  })).sort((left, right) => right.mae - left.mae);
  return {
    topErrors: enriched.sort((left, right) => right.absoluteError - left.absoluteError).slice(0, topN),
    segmentSummary,
    likelyPatterns: [
      "Large positive bias means predictions are systematically above actuals.",
      "Large negative bias means predictions are systematically below actuals.",
      "Segments with high MAE should be reviewed for missing drivers, data quality issues, or regime changes."
    ],
    metrics: metrics(pairs)
  };
}

async function maybeWrite(ctx: ToolContext, projectId: string | undefined, enabled: boolean, outputPath: string, content: unknown): Promise<string[]> {
  if (!enabled) return [];
  if (!projectId) throw new Error("projectId is required when writeToProject is true.");
  const file = await writeProjectFile(ctx.projectRoot, projectId, outputPath, `${JSON.stringify(content, null, 2)}\n`);
  return [file.path];
}

export const predictionSimulationTools: ToolModule[] = [
  {
    definition: {
      name: "create_prediction_model_spec",
      description: "Create a project-local prediction model specification with target, horizon, assumptions, features, and evaluation metrics.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, objective: { type: "string" }, target: { type: "string" }, horizon: { type: "string" }, method: { type: "string", enum: ["naive", "moving_average", "linear_trend", "scenario_model", "custom"] }, features: { type: "array", items: { type: "string" } }, assumptions: { type: "array", items: { type: "string" } }, metrics: { type: "array", items: { type: "string" } }, outputPath: { type: "string" } }, required: ["projectId", "title", "objective", "target", "horizon"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createPredictionModelSpecInputSchema,
    handler: async (input, ctx) => {
      const parsed = createPredictionModelSpecInputSchema.parse(input);
      const spec = { ...parsed, createdAt: new Date().toISOString(), validationPlan: ["Backtest against holdout periods.", "Report MAE/RMSE/MAPE/bias.", "Explain largest errors before using decisions."] };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(spec, null, 2)}\n`);
      return { ok: true, summary: `Created prediction model spec for ${parsed.target}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: spec, logs: [JSON.stringify(spec, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "run_scenario_simulation",
      description: "Run a deterministic scenario simulation from baseline value, drivers, scenario changes, and optional probabilities.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, baselineValue: { type: "number" }, drivers: { type: "array" }, scenarios: { type: "array" }, mode: { type: "string", enum: ["additive", "multiplicative"] }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["baselineValue", "drivers", "scenarios"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: runScenarioSimulationInputSchema,
    handler: async (input, ctx) => {
      const parsed = runScenarioSimulationInputSchema.parse(input);
      const report = runScenarios(parsed);
      const artifacts = await maybeWrite(ctx, parsed.projectId, parsed.writeToProject, parsed.outputPath, report);
      return { ok: true, summary: `Ran ${parsed.scenarios.length} scenario(s).`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "backtest_time_series_forecast",
      description: "Backtest naive, moving-average, or linear-trend forecasts over bounded time-series observations.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, observations: { type: "array" }, method: { type: "string", enum: ["naive", "moving_average", "linear_trend"] }, window: { type: "number" }, horizon: { type: "number" }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["observations"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: backtestTimeSeriesForecastInputSchema,
    handler: async (input, ctx) => {
      const parsed = backtestTimeSeriesForecastInputSchema.parse(input);
      const report = backtest(parsed.observations, parsed.method, parsed.window, parsed.horizon);
      const artifacts = await maybeWrite(ctx, parsed.projectId, parsed.writeToProject, parsed.outputPath, report);
      return { ok: true, summary: `Backtested ${report.predictions.length} forecast point(s), MAE ${report.metrics.mae}.`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "calculate_prediction_intervals",
      description: "Create symmetric prediction intervals from forecast values plus residuals or explicit error standard deviation.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, predictions: { type: "array" }, residuals: { type: "array", items: { type: "number" } }, errorStdDev: { type: "number" }, confidence: { type: "string", enum: ["0.8", "0.9", "0.95"] }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["predictions"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: calculatePredictionIntervalsInputSchema,
    handler: async (input, ctx) => {
      const parsed = calculatePredictionIntervalsInputSchema.parse(input);
      const report = intervals(parsed);
      const artifacts = await maybeWrite(ctx, parsed.projectId, parsed.writeToProject, parsed.outputPath, report);
      return { ok: true, summary: `Calculated ${report.intervals.length} prediction interval(s) at ${report.confidence} confidence.`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "evaluate_prediction_model",
      description: "Evaluate prediction pairs with MAE, RMSE, MAPE, bias, R2, and residual summary.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, pairs: { type: "array" }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["pairs"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: evaluatePredictionModelInputSchema,
    handler: async (input, ctx) => {
      const parsed = evaluatePredictionModelInputSchema.parse(input);
      const residuals = parsed.pairs.map((pair) => round(pair.predicted - pair.actual));
      const report = { metrics: metrics(parsed.pairs), residuals, residualStdDev: round(stddev(residuals)), caveats: ["MAPE excludes rows where actual is zero."] };
      const artifacts = await maybeWrite(ctx, parsed.projectId, parsed.writeToProject, parsed.outputPath, report);
      return { ok: true, summary: `Evaluated ${parsed.pairs.length} prediction pair(s), MAE ${report.metrics.mae}.`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "explain_prediction_errors",
      description: "Explain prediction errors by ranking largest misses, segment MAE/bias, and likely diagnostic patterns.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, pairs: { type: "array" }, topN: { type: "number" }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["pairs"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: explainPredictionErrorsInputSchema,
    handler: async (input, ctx) => {
      const parsed = explainPredictionErrorsInputSchema.parse(input);
      const report = explainErrors(parsed.pairs, parsed.topN);
      const artifacts = await maybeWrite(ctx, parsed.projectId, parsed.writeToProject, parsed.outputPath, report);
      return { ok: true, summary: `Explained prediction errors across ${parsed.pairs.length} row(s).`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  }
];
