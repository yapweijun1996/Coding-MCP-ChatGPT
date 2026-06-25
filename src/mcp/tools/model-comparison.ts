import { z } from "zod";
import { readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const modelComparisonPath = "model-comparison/model-comparison.json";

const taskTypeEnum = z.enum(["coding", "analysis", "writing", "vision", "general"]);

const criterionSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().min(1).max(160),
  weight: z.number().min(0).max(100).default(1),
  higherIsBetter: z.boolean().default(true)
});

const createModelComparisonSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(3).max(180),
  taskType: taskTypeEnum.default("general"),
  prompt: z.string().min(1).max(8000),
  criteria: z.array(criterionSchema).min(1).max(30).default([
    { id: "quality", label: "Quality", weight: 5, higherIsBetter: true },
    { id: "cost", label: "Cost efficiency", weight: 2, higherIsBetter: true },
    { id: "speed", label: "Speed", weight: 2, higherIsBetter: true },
    { id: "reliability", label: "Reliability", weight: 3, higherIsBetter: true }
  ])
});

const candidateSchema = z.object({
  model: z.string().min(1).max(160),
  provider: z.string().min(1).max(120).optional(),
  output: z.string().max(30000).optional(),
  notes: z.string().max(3000).optional(),
  latencyMs: z.number().min(0).optional(),
  estimatedCostUsd: z.number().min(0).optional(),
  reliability: z.number().min(0).max(100).optional(),
  scores: z.record(z.string(), z.number().min(0).max(100)).default({})
});

const addModelCandidateSchema = z.object({
  projectId: z.string().min(8).max(80),
  comparisonId: z.string().min(1).max(80),
  candidate: candidateSchema
});

const scoreModelComparisonSchema = z.object({
  projectId: z.string().min(8).max(80),
  comparisonId: z.string().min(1).max(80)
});

const compareModelTradeoffsSchema = z.object({
  projectId: z.string().min(8).max(80),
  comparisonId: z.string().min(1).max(80),
  priorities: z.array(z.string().min(1).max(80)).max(10).default([])
});

const exportModelComparisonSchema = z.object({
  projectId: z.string().min(8).max(80),
  comparisonId: z.string().min(1).max(80).optional(),
  outputPath: z.string().min(1).max(240).default("model-comparison/model-comparison-report.md")
});

interface ModelCandidate {
  id: string;
  model: string;
  provider?: string;
  output?: string;
  notes?: string;
  latencyMs?: number;
  estimatedCostUsd?: number;
  reliability?: number;
  scores: Record<string, number>;
  addedAt: string;
}

interface ModelComparison {
  id: string;
  title: string;
  taskType: z.infer<typeof taskTypeEnum>;
  prompt: string;
  criteria: Array<z.infer<typeof criterionSchema>>;
  candidates: ModelCandidate[];
  createdAt: string;
  updatedAt: string;
}

interface ModelComparisonStore {
  version: 1;
  comparisons: ModelComparison[];
}

function emptyStore(): ModelComparisonStore {
  return { version: 1, comparisons: [] };
}

async function readStore(ctx: ToolContext, projectId: string): Promise<ModelComparisonStore> {
  try {
    const raw = await readProjectFile(ctx.projectRoot, projectId, modelComparisonPath);
    const parsed = JSON.parse(raw) as ModelComparisonStore;
    return { version: 1, comparisons: Array.isArray(parsed.comparisons) ? parsed.comparisons : [] };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(ctx: ToolContext, projectId: string, store: ModelComparisonStore) {
  return writeProjectFile(ctx.projectRoot, projectId, modelComparisonPath, `${JSON.stringify(store, null, 2)}\n`);
}

function nextId(prefix: string, count: number): string {
  return `${prefix}_${String(count + 1).padStart(3, "0")}`;
}

function findComparison(store: ModelComparisonStore, comparisonId: string): ModelComparison {
  const comparison = store.comparisons.find((item) => item.id === comparisonId);
  if (!comparison) throw new Error(`Model comparison ${comparisonId} not found.`);
  return comparison;
}

function normalizedMetric(value: number | undefined, all: Array<number | undefined>, invert = false): number | undefined {
  if (value === undefined) return undefined;
  const values = all.filter((item): item is number => typeof item === "number");
  if (values.length <= 1) return 100;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 100;
  const normalized = ((value - min) / (max - min)) * 100;
  return Number((invert ? 100 - normalized : normalized).toFixed(2));
}

function enrichedScores(comparison: ModelComparison, candidate: ModelCandidate): Record<string, number> {
  const scores = { ...candidate.scores };
  const costEfficiency = normalizedMetric(candidate.estimatedCostUsd, comparison.candidates.map((item) => item.estimatedCostUsd), true);
  const speed = normalizedMetric(candidate.latencyMs, comparison.candidates.map((item) => item.latencyMs), true);
  if (costEfficiency !== undefined && scores.cost === undefined) scores.cost = costEfficiency;
  if (speed !== undefined && scores.speed === undefined) scores.speed = speed;
  if (candidate.reliability !== undefined && scores.reliability === undefined) scores.reliability = candidate.reliability;
  return scores;
}

function rankComparison(comparison: ModelComparison) {
  return comparison.candidates.map((candidate) => {
    const scores = enrichedScores(comparison, candidate);
    let totalWeight = 0;
    const weightedScore = comparison.criteria.reduce((total, criterion) => {
      const raw = scores[criterion.id];
      if (raw === undefined) return total;
      totalWeight += criterion.weight;
      const adjusted = criterion.higherIsBetter ? raw : 100 - raw;
      return total + adjusted * criterion.weight;
    }, 0);
    const score = totalWeight ? Number((weightedScore / totalWeight).toFixed(2)) : 0;
    return { candidate: { ...candidate, scores }, score };
  }).sort((left, right) => right.score - left.score || left.candidate.model.localeCompare(right.candidate.model));
}

function summarizeTradeoffs(comparison: ModelComparison, priorities: string[]) {
  const ranked = rankComparison(comparison);
  const winner = ranked[0];
  const fastest = [...comparison.candidates].filter((item) => item.latencyMs !== undefined).sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))[0];
  const cheapest = [...comparison.candidates].filter((item) => item.estimatedCostUsd !== undefined).sort((a, b) => (a.estimatedCostUsd ?? Infinity) - (b.estimatedCostUsd ?? Infinity))[0];
  const mostReliable = [...comparison.candidates].filter((item) => item.reliability !== undefined).sort((a, b) => (b.reliability ?? 0) - (a.reliability ?? 0))[0];
  return {
    winner,
    fastest,
    cheapest,
    mostReliable,
    priorities,
    recommendation: winner ? `Use ${winner.candidate.model} for ${comparison.taskType} when weighted quality/reliability/cost/speed tradeoffs match this rubric.` : "Add model candidates before choosing a winner.",
    caveats: ["Scores depend on supplied outputs and metrics.", "This tool ranks recorded candidates; it does not call external model APIs."]
  };
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function renderMarkdown(store: ModelComparisonStore, comparisonId?: string): string {
  const comparisons = comparisonId ? [findComparison(store, comparisonId)] : store.comparisons;
  return `# Model Comparison Report

${comparisons.map((comparison) => {
  const ranked = rankComparison(comparison);
  const rows = ranked.map((item, index) => `| ${index + 1} | ${escapeMarkdown(item.candidate.model)} | ${item.score} | ${item.candidate.estimatedCostUsd ?? ""} | ${item.candidate.latencyMs ?? ""} | ${item.candidate.reliability ?? ""} | ${escapeMarkdown(item.candidate.notes ?? "")} |`).join("\n");
  return `## ${comparison.title}

- ID: \`${comparison.id}\`
- Task type: ${comparison.taskType}
- Candidates: ${comparison.candidates.length}

| Rank | Model | Score | Cost USD | Latency ms | Reliability | Notes |
| --- | --- | --- | --- | --- | --- | --- |
${rows || "| - | - | - | - | - | - | - |"}`;
}).join("\n\n")}
`;
}

export const modelComparisonTools: ToolModule[] = [
  {
    definition: {
      name: "create_model_comparison",
      description: "Create a project-local model comparison run with task type, prompt, and weighted criteria for coding, analysis, writing, vision, or general work.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, taskType: { type: "string", enum: ["coding", "analysis", "writing", "vision", "general"] }, prompt: { type: "string" }, criteria: { type: "array", items: { type: "object" } } }, required: ["projectId", "title", "prompt"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createModelComparisonSchema,
    handler: async (input, ctx) => {
      const parsed = createModelComparisonSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const now = new Date().toISOString();
      const comparison: ModelComparison = { id: nextId("comparison", store.comparisons.length), title: parsed.title, taskType: parsed.taskType, prompt: parsed.prompt, criteria: parsed.criteria, candidates: [], createdAt: now, updatedAt: now };
      store.comparisons.push(comparison);
      const file = await writeStore(ctx, parsed.projectId, store);
      return { ok: true, summary: `Created model comparison ${comparison.id}.`, jobId: parsed.projectId, artifacts: [file.path, comparison.id], structuredContent: { projectId: parsed.projectId, comparison }, logs: [comparison.title], errors: [] };
    }
  },
  {
    definition: {
      name: "add_model_comparison_candidate",
      description: "Add a model candidate output and metrics such as cost, latency, reliability, and rubric scores to a comparison run.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, comparisonId: { type: "string" }, candidate: { type: "object" } }, required: ["projectId", "comparisonId", "candidate"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: addModelCandidateSchema,
    handler: async (input, ctx) => {
      const parsed = addModelCandidateSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const comparison = findComparison(store, parsed.comparisonId);
      const now = new Date().toISOString();
      const candidate: ModelCandidate = { id: nextId("candidate", comparison.candidates.length), ...parsed.candidate, addedAt: now };
      comparison.candidates.push(candidate);
      comparison.updatedAt = now;
      const file = await writeStore(ctx, parsed.projectId, store);
      return { ok: true, summary: `Added ${candidate.model} to comparison ${comparison.id}.`, jobId: parsed.projectId, artifacts: [file.path, candidate.id], structuredContent: { projectId: parsed.projectId, comparisonId: comparison.id, candidate }, logs: [`${candidate.id}: ${candidate.model}`], errors: [] };
    }
  },
  {
    definition: {
      name: "score_model_comparison",
      description: "Score and rank model candidates using weighted criteria plus supplied cost, speed, and reliability metrics.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, comparisonId: { type: "string" } }, required: ["projectId", "comparisonId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: scoreModelComparisonSchema,
    handler: async (input, ctx) => {
      const parsed = scoreModelComparisonSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const comparison = findComparison(store, parsed.comparisonId);
      const ranking = rankComparison(comparison);
      return { ok: true, summary: `Ranked ${ranking.length} model candidate(s).`, jobId: parsed.projectId, artifacts: ranking.map((item) => item.candidate.id), structuredContent: { projectId: parsed.projectId, comparison, ranking }, logs: ranking.map((item, index) => `${index + 1}. ${item.candidate.model}: ${item.score}`), errors: [] };
    }
  },
  {
    definition: {
      name: "compare_model_tradeoffs",
      description: "Summarize model tradeoffs and identify winner, fastest, cheapest, and most reliable candidates for a comparison run.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, comparisonId: { type: "string" }, priorities: { type: "array", items: { type: "string" } } }, required: ["projectId", "comparisonId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: compareModelTradeoffsSchema,
    handler: async (input, ctx) => {
      const parsed = compareModelTradeoffsSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const comparison = findComparison(store, parsed.comparisonId);
      const tradeoffs = summarizeTradeoffs(comparison, parsed.priorities);
      return { ok: true, summary: tradeoffs.recommendation, jobId: parsed.projectId, artifacts: [], structuredContent: { projectId: parsed.projectId, comparisonId: comparison.id, tradeoffs }, logs: [JSON.stringify(tradeoffs, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "export_model_comparison_report",
      description: "Export model comparison rankings and tradeoffs as a Markdown report.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, comparisonId: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportModelComparisonSchema,
    handler: async (input, ctx) => {
      const parsed = exportModelComparisonSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, renderMarkdown(store, parsed.comparisonId));
      return { ok: true, summary: `Exported model comparison report to ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, outputPath: file.path, comparisonCount: parsed.comparisonId ? 1 : store.comparisons.length }, logs: [file.path], errors: [] };
    }
  }
];
