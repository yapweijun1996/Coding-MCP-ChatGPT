import { z } from "zod";
import { lastNDays } from "../../telemetry/aggregate.js";
import { readTelemetryDay } from "../../telemetry/store.js";
import { readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const categorySchema = z.enum(["model_call", "tool_call", "storage", "publish", "browser_qa", "workflow", "other"]);

const usageEventSchema = z.object({
  id: z.string().regex(/^usage_[a-zA-Z0-9_-]{1,80}$/).optional(),
  category: categorySchema,
  title: z.string().min(1).max(200),
  occurredAt: z.string().datetime().optional(),
  toolName: z.string().min(1).max(160).optional(),
  model: z.string().min(1).max(160).optional(),
  workflowId: z.string().min(1).max(160).optional(),
  units: z.object({
    calls: z.number().min(0).optional(),
    inputTokens: z.number().min(0).optional(),
    outputTokens: z.number().min(0).optional(),
    totalTokens: z.number().min(0).optional(),
    durationMs: z.number().min(0).optional(),
    storageBytes: z.number().min(0).optional(),
    browserRuns: z.number().min(0).optional(),
    publishes: z.number().min(0).optional()
  }).optional().default({}),
  pricing: z.object({
    inputTokenUsdPer1K: z.number().min(0).optional(),
    outputTokenUsdPer1K: z.number().min(0).optional(),
    unitCostUsd: z.number().min(0).optional(),
    unitCount: z.number().min(0).optional()
  }).optional().default({}),
  estimatedCostUsd: z.number().min(0).optional(),
  notes: z.string().max(1000).optional().default("")
});

const recordUsageEventInputSchema = usageEventSchema.extend({
  projectId: z.string().min(8).max(80),
  usagePath: z.string().min(1).max(240).default("usage-cost/usage-ledger.json")
});

const createUsageBudgetInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  budgetUsd: z.number().min(0),
  period: z.string().min(1).max(120).default("project"),
  warnAtPercent: z.number().min(1).max(100).default(80),
  hardLimit: z.boolean().default(false),
  usagePath: z.string().min(1).max(240).default("usage-cost/usage-ledger.json")
});

const summarizeUsageCostsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  usagePath: z.string().min(1).max(240).default("usage-cost/usage-ledger.json"),
  category: categorySchema.optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional()
});

const importTelemetryUsageInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  windowDays: z.number().int().min(1).max(30).default(7),
  costPerToolCallUsd: z.number().min(0).default(0),
  includeFailedCalls: z.boolean().default(true),
  usagePath: z.string().min(1).max(240).default("usage-cost/usage-ledger.json")
});

const exportUsageCostReportInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(200).default("Usage and Cost Report"),
  usagePath: z.string().min(1).max(240).default("usage-cost/usage-ledger.json"),
  outputPath: z.string().min(1).max(240).default("usage-cost/usage-report.md")
});

type UsageEvent = z.infer<typeof usageEventSchema> & { id: string; occurredAt: string; estimatedCostUsd: number };
type UsageBudget = z.infer<typeof createUsageBudgetInputSchema> & { updatedAt: string };

interface UsageLedger {
  version: 1;
  projectId: string;
  updatedAt: string;
  budget?: Omit<UsageBudget, "projectId" | "usagePath">;
  events: UsageEvent[];
}

function eventId(): string {
  return `usage_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function estimateCost(input: z.infer<typeof usageEventSchema>): number {
  if (input.estimatedCostUsd !== undefined) return roundUsd(input.estimatedCostUsd);
  const inputCost = ((input.units.inputTokens ?? 0) / 1000) * (input.pricing.inputTokenUsdPer1K ?? 0);
  const outputCost = ((input.units.outputTokens ?? 0) / 1000) * (input.pricing.outputTokenUsdPer1K ?? 0);
  const unitCost = (input.pricing.unitCount ?? input.units.calls ?? input.units.browserRuns ?? input.units.publishes ?? 0) * (input.pricing.unitCostUsd ?? 0);
  return roundUsd(inputCost + outputCost + unitCost);
}

async function readLedger(projectRoot: string, projectId: string, usagePath: string): Promise<UsageLedger> {
  try {
    const raw = await readProjectFile(projectRoot, projectId, usagePath, 2 * 1024 * 1024);
    const parsed = JSON.parse(raw) as Partial<UsageLedger>;
    if (parsed.version === 1 && Array.isArray(parsed.events)) {
      return {
        version: 1,
        projectId,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        budget: parsed.budget,
        events: parsed.events as UsageEvent[]
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/not found|ENOENT|no such file/i.test(message)) throw error;
  }
  return { version: 1, projectId, updatedAt: new Date().toISOString(), events: [] };
}

async function writeLedger(projectRoot: string, projectId: string, usagePath: string, ledger: UsageLedger) {
  const payload: UsageLedger = {
    ...ledger,
    updatedAt: new Date().toISOString(),
    events: ledger.events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
  };
  const file = await writeProjectFile(projectRoot, projectId, usagePath, `${JSON.stringify(payload, null, 2)}\n`);
  return { payload, file };
}

function summarizeEvents(events: UsageEvent[], budget?: UsageLedger["budget"]) {
  const totalCostUsd = roundUsd(events.reduce((sum, event) => sum + event.estimatedCostUsd, 0));
  const byCategory: Record<string, { count: number; estimatedCostUsd: number }> = {};
  const byTool: Record<string, { count: number; estimatedCostUsd: number }> = {};
  const byModel: Record<string, { count: number; estimatedCostUsd: number }> = {};
  const units = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0, storageBytes: 0, browserRuns: 0, publishes: 0 };
  for (const event of events) {
    const category = byCategory[event.category] ?? { count: 0, estimatedCostUsd: 0 };
    category.count += 1;
    category.estimatedCostUsd = roundUsd(category.estimatedCostUsd + event.estimatedCostUsd);
    byCategory[event.category] = category;
    if (event.toolName) {
      const tool = byTool[event.toolName] ?? { count: 0, estimatedCostUsd: 0 };
      tool.count += 1;
      tool.estimatedCostUsd = roundUsd(tool.estimatedCostUsd + event.estimatedCostUsd);
      byTool[event.toolName] = tool;
    }
    if (event.model) {
      const model = byModel[event.model] ?? { count: 0, estimatedCostUsd: 0 };
      model.count += 1;
      model.estimatedCostUsd = roundUsd(model.estimatedCostUsd + event.estimatedCostUsd);
      byModel[event.model] = model;
    }
    for (const key of Object.keys(units) as Array<keyof typeof units>) units[key] += event.units[key] ?? 0;
  }
  const budgetStatus = budget ? {
    budgetUsd: budget.budgetUsd,
    period: budget.period,
    warnAtPercent: budget.warnAtPercent,
    hardLimit: budget.hardLimit,
    spentPercent: budget.budgetUsd === 0 ? 0 : Math.round((totalCostUsd / budget.budgetUsd) * 10000) / 100,
    remainingUsd: roundUsd(Math.max(0, budget.budgetUsd - totalCostUsd)),
    status: totalCostUsd >= budget.budgetUsd ? "over_budget" : totalCostUsd >= budget.budgetUsd * (budget.warnAtPercent / 100) ? "warning" : "within_budget"
  } : undefined;
  return { totalEvents: events.length, totalCostUsd, units, byCategory, byTool, byModel, budgetStatus };
}

function filterEvents(events: UsageEvent[], input: z.infer<typeof summarizeUsageCostsInputSchema>): UsageEvent[] {
  return events
    .filter((event) => !input.category || event.category === input.category)
    .filter((event) => !input.since || event.occurredAt >= input.since)
    .filter((event) => !input.until || event.occurredAt <= input.until);
}

function markdown(title: string, summary: ReturnType<typeof summarizeEvents>, events: UsageEvent[]): string {
  const rows = events.slice(-50).reverse().map((event) => `| ${event.occurredAt} | ${event.category} | ${event.toolName ?? event.model ?? "-"} | $${event.estimatedCostUsd.toFixed(6)} | ${event.title.replaceAll("|", "\\|")} |`).join("\n");
  return `# ${title}

- Total events: ${summary.totalEvents}
- Estimated cost: $${summary.totalCostUsd.toFixed(6)}
- Budget status: ${summary.budgetStatus ? `${summary.budgetStatus.status} (${summary.budgetStatus.spentPercent}% of $${summary.budgetStatus.budgetUsd})` : "none"}

## By Category

\`\`\`json
${JSON.stringify(summary.byCategory, null, 2)}
\`\`\`

## Recent Events

| Time | Category | Tool/Model | Cost | Title |
| --- | --- | --- | ---: | --- |
${rows || "| - | - | - | $0.000000 | No events. |"}
`;
}

export const usageCostTools: ToolModule[] = [
  {
    definition: { name: "record_usage_event", description: "Record a project-local usage/cost event for model calls, tool calls, storage, publishes, browser QA, or long workflows.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, category: { type: "string" }, title: { type: "string" }, occurredAt: { type: "string" }, toolName: { type: "string" }, model: { type: "string" }, workflowId: { type: "string" }, units: { type: "object" }, pricing: { type: "object" }, estimatedCostUsd: { type: "number" }, notes: { type: "string" }, usagePath: { type: "string" } }, required: ["projectId", "category", "title"], additionalProperties: false } },
    enabledByDefault: true,
    schema: recordUsageEventInputSchema,
    handler: async (input, ctx) => {
      const parsed = recordUsageEventInputSchema.parse(input);
      const ledger = await readLedger(ctx.projectRoot, parsed.projectId, parsed.usagePath);
      const event: UsageEvent = { ...usageEventSchema.parse(parsed), id: parsed.id ?? eventId(), occurredAt: parsed.occurredAt ?? new Date().toISOString(), estimatedCostUsd: estimateCost(parsed) };
      const { payload, file } = await writeLedger(ctx.projectRoot, parsed.projectId, parsed.usagePath, { ...ledger, events: [...ledger.events, event] });
      const summary = summarizeEvents(payload.events, payload.budget);
      return { ok: true, summary: `Recorded usage event ${event.id} ($${event.estimatedCostUsd.toFixed(6)}).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { event, summary }, logs: [JSON.stringify({ event, summary }, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "create_usage_budget", description: "Create or update a project-local cost budget with warning threshold and optional hard-limit metadata.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, budgetUsd: { type: "number" }, period: { type: "string" }, warnAtPercent: { type: "number" }, hardLimit: { type: "boolean" }, usagePath: { type: "string" } }, required: ["projectId", "budgetUsd"], additionalProperties: false } },
    enabledByDefault: true,
    schema: createUsageBudgetInputSchema,
    handler: async (input, ctx) => {
      const parsed = createUsageBudgetInputSchema.parse(input);
      const ledger = await readLedger(ctx.projectRoot, parsed.projectId, parsed.usagePath);
      const budget = { budgetUsd: parsed.budgetUsd, period: parsed.period, warnAtPercent: parsed.warnAtPercent, hardLimit: parsed.hardLimit, updatedAt: new Date().toISOString() };
      const { payload, file } = await writeLedger(ctx.projectRoot, parsed.projectId, parsed.usagePath, { ...ledger, budget });
      const summary = summarizeEvents(payload.events, payload.budget);
      return { ok: true, summary: `Updated usage budget to $${parsed.budgetUsd}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { budget, summary }, logs: [JSON.stringify({ budget, summary }, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "summarize_usage_costs", description: "Summarize project-local usage and estimated costs by category, tool, model, units, and budget status.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, usagePath: { type: "string" }, category: { type: "string" }, since: { type: "string" }, until: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: summarizeUsageCostsInputSchema,
    handler: async (input, ctx) => {
      const parsed = summarizeUsageCostsInputSchema.parse(input);
      const ledger = await readLedger(ctx.projectRoot, parsed.projectId, parsed.usagePath);
      const events = filterEvents(ledger.events, parsed);
      const summary = summarizeEvents(events, ledger.budget);
      return { ok: true, summary: `Usage ledger has ${summary.totalEvents} event(s), estimated cost $${summary.totalCostUsd.toFixed(6)}.`, jobId: parsed.projectId, artifacts: [], structuredContent: { ...summary, events }, logs: [JSON.stringify({ ...summary, events }, null, 2)], errors: summary.budgetStatus?.status === "over_budget" && summary.budgetStatus.hardLimit ? ["Usage budget hard limit exceeded."] : [] };
    }
  },
  {
    definition: { name: "import_telemetry_usage", description: "Import recent MCP telemetry tool calls into a project usage ledger with an optional per-call cost estimate.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, windowDays: { type: "number" }, costPerToolCallUsd: { type: "number" }, includeFailedCalls: { type: "boolean" }, usagePath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: importTelemetryUsageInputSchema,
    handler: async (input, ctx) => {
      const parsed = importTelemetryUsageInputSchema.parse(input);
      const days = lastNDays(new Date(), parsed.windowDays);
      const telemetry = (await Promise.all(days.map((day) => readTelemetryDay(day)))).flat();
      const imported = telemetry
        .filter((event) => event.method === "tools/call" && event.toolName)
        .filter((event) => parsed.includeFailedCalls || event.ok)
        .map((event): UsageEvent => ({
          id: `usage_telemetry_${event.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)}`,
          category: "tool_call",
          title: `${event.toolName} ${event.ok ? "succeeded" : "failed"}`,
          occurredAt: event.time,
          toolName: event.toolName,
          units: { calls: 1, durationMs: event.durationMs ?? 0 },
          pricing: { unitCostUsd: parsed.costPerToolCallUsd, unitCount: 1 },
          estimatedCostUsd: roundUsd(parsed.costPerToolCallUsd),
          notes: event.summary ?? event.errorMessage ?? ""
        }));
      const ledger = await readLedger(ctx.projectRoot, parsed.projectId, parsed.usagePath);
      const existing = new Set(ledger.events.map((event) => event.id));
      const newEvents = imported.filter((event) => !existing.has(event.id));
      const { payload, file } = await writeLedger(ctx.projectRoot, parsed.projectId, parsed.usagePath, { ...ledger, events: [...ledger.events, ...newEvents] });
      const summary = summarizeEvents(payload.events, payload.budget);
      return { ok: true, summary: `Imported ${newEvents.length} telemetry usage event(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { imported: newEvents, summary }, logs: [JSON.stringify({ imported: newEvents, summary }, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "export_usage_cost_report", description: "Export a Markdown usage and cost report from the project-local usage ledger.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, usagePath: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: exportUsageCostReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportUsageCostReportInputSchema.parse(input);
      const ledger = await readLedger(ctx.projectRoot, parsed.projectId, parsed.usagePath);
      const summary = summarizeEvents(ledger.events, ledger.budget);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown(parsed.title, summary, ledger.events));
      return { ok: true, summary: `Exported usage cost report to ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { outputPath: file.path, summary }, logs: [JSON.stringify({ outputPath: file.path, summary }, null, 2)], errors: [] };
    }
  }
];
