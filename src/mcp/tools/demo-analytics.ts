import { z } from "zod";
import { readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const analyticsStorePath = "analytics/demo-analytics.json";

const eventTypeEnum = z.enum(["page_view", "click", "error", "funnel_step", "custom"]);
const deviceTypeEnum = z.enum(["desktop", "mobile", "tablet", "unknown"]);

const funnelStepSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().min(1).max(160),
  eventType: eventTypeEnum.default("funnel_step"),
  path: z.string().min(1).max(500).optional(),
  target: z.string().min(1).max(240).optional()
});

const createDemoAnalyticsPlanSchema = z.object({
  projectId: z.string().min(8).max(80),
  name: z.string().min(3).max(160),
  goals: z.array(z.string().min(1).max(240)).max(20).default([]),
  trackedEvents: z.array(eventTypeEnum).min(1).max(5).default(["page_view", "click", "error", "funnel_step"]),
  funnels: z.array(z.object({
    id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
    label: z.string().min(1).max(160),
    steps: z.array(funnelStepSchema).min(2).max(20)
  })).max(10).default([]),
  privacyNotes: z.array(z.string().min(1).max(240)).max(20).default(["Do not collect secrets, raw credentials, or unnecessary personal data."])
});

const analyticsEventSchema = z.object({
  eventType: eventTypeEnum,
  sessionId: z.string().min(1).max(160),
  timestamp: z.string().datetime().optional(),
  path: z.string().min(1).max(500).optional(),
  url: z.string().url().max(1000).optional(),
  deviceType: deviceTypeEnum.default("unknown"),
  target: z.string().min(1).max(240).optional(),
  label: z.string().min(1).max(240).optional(),
  funnelId: z.string().min(1).max(80).optional(),
  stepId: z.string().min(1).max(80).optional(),
  errorMessage: z.string().min(1).max(1000).optional(),
  errorSource: z.string().min(1).max(240).optional(),
  value: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

const recordDemoAnalyticsEventSchema = z.object({
  projectId: z.string().min(8).max(80),
  events: z.array(analyticsEventSchema).min(1).max(500)
});

const listDemoAnalyticsEventsSchema = z.object({
  projectId: z.string().min(8).max(80),
  eventType: eventTypeEnum.optional(),
  sessionId: z.string().min(1).max(160).optional(),
  deviceType: deviceTypeEnum.optional(),
  path: z.string().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(1000).default(100)
});

const summarizeDemoAnalyticsSchema = z.object({
  projectId: z.string().min(8).max(80),
  topLimit: z.number().int().min(1).max(50).default(10)
});

const analyzeDemoFunnelSchema = z.object({
  projectId: z.string().min(8).max(80),
  funnelId: z.string().min(1).max(80),
  sessionLimit: z.number().int().min(1).max(10000).default(10000)
});

const exportDemoAnalyticsReportSchema = z.object({
  projectId: z.string().min(8).max(80),
  outputPath: z.string().min(1).max(240).default("analytics/demo-analytics-report.md")
});

type EventType = z.infer<typeof eventTypeEnum>;
type DeviceType = z.infer<typeof deviceTypeEnum>;

interface DemoAnalyticsPlan {
  id: string;
  name: string;
  goals: string[];
  trackedEvents: EventType[];
  funnels: Array<{
    id: string;
    label: string;
    steps: Array<z.infer<typeof funnelStepSchema>>;
  }>;
  privacyNotes: string[];
  createdAt: string;
  updatedAt: string;
}

interface DemoAnalyticsEvent {
  id: string;
  eventType: EventType;
  sessionId: string;
  timestamp: string;
  path?: string;
  url?: string;
  deviceType: DeviceType;
  target?: string;
  label?: string;
  funnelId?: string;
  stepId?: string;
  errorMessage?: string;
  errorSource?: string;
  value?: number;
  metadata: Record<string, unknown>;
}

interface DemoAnalyticsStore {
  version: 1;
  plans: DemoAnalyticsPlan[];
  events: DemoAnalyticsEvent[];
}

function emptyStore(): DemoAnalyticsStore {
  return { version: 1, plans: [], events: [] };
}

async function readStore(ctx: ToolContext, projectId: string): Promise<DemoAnalyticsStore> {
  try {
    const raw = await readProjectFile(ctx.projectRoot, projectId, analyticsStorePath);
    const parsed = JSON.parse(raw) as DemoAnalyticsStore;
    return {
      version: 1,
      plans: Array.isArray(parsed.plans) ? parsed.plans : [],
      events: Array.isArray(parsed.events) ? parsed.events : []
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(ctx: ToolContext, projectId: string, store: DemoAnalyticsStore) {
  return writeProjectFile(ctx.projectRoot, projectId, analyticsStorePath, `${JSON.stringify(store, null, 2)}\n`);
}

function nextId(prefix: string, count: number): string {
  return `${prefix}_${String(count + 1).padStart(3, "0")}`;
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {} as Record<T, number>);
}

function topEntries(record: Record<string, number>, limit: number) {
  return Object.entries(record)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function summarize(events: DemoAnalyticsEvent[], topLimit = 10) {
  const sessions = new Set(events.map((event) => event.sessionId));
  const pageViews = events.filter((event) => event.eventType === "page_view");
  const clicks = events.filter((event) => event.eventType === "click");
  const errors = events.filter((event) => event.eventType === "error");
  return {
    totalEvents: events.length,
    sessions: sessions.size,
    pageViews: pageViews.length,
    clicks: clicks.length,
    errors: errors.length,
    byEventType: countBy(events.map((event) => event.eventType)),
    byDeviceType: countBy(events.map((event) => event.deviceType)),
    topPages: topEntries(countBy(pageViews.map((event) => event.path ?? event.url ?? "unknown")), topLimit),
    topClickTargets: topEntries(countBy(clicks.map((event) => event.target ?? event.label ?? "unknown")), topLimit),
    topErrors: topEntries(countBy(errors.map((event) => event.errorMessage ?? "unknown error")), topLimit)
  };
}

function analyzeFunnel(plan: DemoAnalyticsPlan, funnelId: string, events: DemoAnalyticsEvent[], sessionLimit: number) {
  const funnel = plan.funnels.find((item) => item.id === funnelId);
  if (!funnel) throw new Error(`Funnel ${funnelId} not found.`);
  const sessionEvents = new Map<string, DemoAnalyticsEvent[]>();
  for (const event of events.filter((item) => item.funnelId === funnelId || item.eventType === "page_view" || item.eventType === "click" || item.eventType === "funnel_step")) {
    const list = sessionEvents.get(event.sessionId) ?? [];
    list.push(event);
    sessionEvents.set(event.sessionId, list);
  }
  const limited = [...sessionEvents.entries()].slice(0, sessionLimit);
  const reachedCounts = funnel.steps.map(() => 0);
  for (const [, list] of limited) {
    const ordered = [...list].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    let cursor = 0;
    for (const event of ordered) {
      const step = funnel.steps[cursor];
      if (!step) break;
      const matchesType = event.eventType === step.eventType;
      const matchesPath = !step.path || event.path === step.path || event.url?.endsWith(step.path);
      const matchesTarget = !step.target || event.target === step.target || event.label === step.target;
      const matchesStep = !event.stepId || event.stepId === step.id;
      if (matchesType && matchesPath && matchesTarget && matchesStep) {
        reachedCounts[cursor] += 1;
        cursor += 1;
      }
    }
  }
  const totalSessions = limited.length;
  const steps = funnel.steps.map((step, index) => {
    const reached = reachedCounts[index] ?? 0;
    const previous = index === 0 ? totalSessions : reachedCounts[index - 1] ?? 0;
    const dropOff = Math.max(0, previous - reached);
    return {
      id: step.id,
      label: step.label,
      reached,
      conversionRate: previous ? Number((reached / previous).toFixed(4)) : 0,
      dropOff,
      dropOffRate: previous ? Number((dropOff / previous).toFixed(4)) : 0
    };
  });
  return {
    funnelId,
    label: funnel.label,
    totalSessions,
    completedSessions: reachedCounts.at(-1) ?? 0,
    completionRate: totalSessions ? Number(((reachedCounts.at(-1) ?? 0) / totalSessions).toFixed(4)) : 0,
    steps
  };
}

function eventLine(event: DemoAnalyticsEvent): string {
  return `${event.id} ${event.eventType} session=${event.sessionId} device=${event.deviceType}${event.path ? ` path=${event.path}` : ""}${event.target ? ` target=${event.target}` : ""}`;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function markdown(projectId: string, store: DemoAnalyticsStore) {
  const summary = summarize(store.events);
  const latestPlan = store.plans.at(-1);
  const funnelReports = latestPlan?.funnels.map((funnel) => analyzeFunnel(latestPlan, funnel.id, store.events, 10000)) ?? [];
  const pageRows = summary.topPages.map((item) => `| ${escapeMarkdown(item.key)} | ${item.count} |`).join("\n");
  const clickRows = summary.topClickTargets.map((item) => `| ${escapeMarkdown(item.key)} | ${item.count} |`).join("\n");
  const errorRows = summary.topErrors.map((item) => `| ${escapeMarkdown(item.key)} | ${item.count} |`).join("\n");
  return `# Demo Analytics Report

- Project: \`${projectId}\`
- Events: ${summary.totalEvents}
- Sessions: ${summary.sessions}
- Page views: ${summary.pageViews}
- Clicks: ${summary.clicks}
- Errors: ${summary.errors}

## Device Types

${Object.entries(summary.byDeviceType).map(([device, count]) => `- ${device}: ${count}`).join("\n") || "- No device data."}

## Top Pages

| Page | Views |
| --- | --- |
${pageRows || "| - | 0 |"}

## Top Click Targets

| Target | Clicks |
| --- | --- |
${clickRows || "| - | 0 |"}

## Top Errors

| Error | Count |
| --- | --- |
${errorRows || "| - | 0 |"}

## Funnels

${funnelReports.map((report) => `### ${report.label}

- Sessions: ${report.totalSessions}
- Completed: ${report.completedSessions}
- Completion rate: ${Math.round(report.completionRate * 100)}%

| Step | Reached | Conversion | Drop-off |
| --- | --- | --- | --- |
${report.steps.map((step) => `| ${escapeMarkdown(step.label)} | ${step.reached} | ${Math.round(step.conversionRate * 100)}% | ${step.dropOff} (${Math.round(step.dropOffRate * 100)}%) |`).join("\n")}`).join("\n\n") || "No funnel plan configured."}
`;
}

export const demoAnalyticsTools: ToolModule[] = [
  {
    definition: {
      name: "create_demo_analytics_plan",
      description: "Define a project-local demo analytics plan with tracked event types, privacy notes, and interaction funnels.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, name: { type: "string" }, goals: { type: "array", items: { type: "string" } }, trackedEvents: { type: "array", items: { type: "string", enum: ["page_view", "click", "error", "funnel_step", "custom"] } }, funnels: { type: "array", items: { type: "object" } }, privacyNotes: { type: "array", items: { type: "string" } } }, required: ["projectId", "name"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createDemoAnalyticsPlanSchema,
    handler: async (input, ctx) => {
      const parsed = createDemoAnalyticsPlanSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const now = new Date().toISOString();
      const plan: DemoAnalyticsPlan = { id: nextId("analytics_plan", store.plans.length), name: parsed.name, goals: parsed.goals, trackedEvents: parsed.trackedEvents, funnels: parsed.funnels, privacyNotes: parsed.privacyNotes, createdAt: now, updatedAt: now };
      store.plans.push(plan);
      const file = await writeStore(ctx, parsed.projectId, store);
      return { ok: true, summary: `Created demo analytics plan ${plan.id}.`, jobId: parsed.projectId, artifacts: [file.path, plan.id], structuredContent: { projectId: parsed.projectId, plan }, logs: [plan.name], errors: [] };
    }
  },
  {
    definition: {
      name: "record_demo_analytics_event",
      description: "Record project-local demo analytics events such as page views, clicks, errors, funnel steps, device type, and session ids.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, events: { type: "array", items: { type: "object" } } }, required: ["projectId", "events"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: recordDemoAnalyticsEventSchema,
    handler: async (input, ctx) => {
      const parsed = recordDemoAnalyticsEventSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const base = store.events.length;
      const now = new Date().toISOString();
      const events: DemoAnalyticsEvent[] = parsed.events.map((event, index) => ({ id: nextId("event", base + index), eventType: event.eventType, sessionId: event.sessionId, timestamp: event.timestamp ?? now, path: event.path, url: event.url, deviceType: event.deviceType, target: event.target, label: event.label, funnelId: event.funnelId, stepId: event.stepId, errorMessage: event.errorMessage, errorSource: event.errorSource, value: event.value, metadata: event.metadata }));
      store.events.push(...events);
      const file = await writeStore(ctx, parsed.projectId, store);
      return { ok: true, summary: `Recorded ${events.length} demo analytics event(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, events, summary: summarize(store.events) }, logs: events.map(eventLine), errors: [] };
    }
  },
  {
    definition: {
      name: "list_demo_analytics_events",
      description: "List raw demo analytics events with optional type, session, device, path, and limit filters for debugging and audit.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, eventType: { type: "string", enum: ["page_view", "click", "error", "funnel_step", "custom"] }, sessionId: { type: "string" }, deviceType: { type: "string", enum: ["desktop", "mobile", "tablet", "unknown"] }, path: { type: "string" }, limit: { type: "number" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listDemoAnalyticsEventsSchema,
    handler: async (input, ctx) => {
      const parsed = listDemoAnalyticsEventsSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const events = store.events
        .filter((event) => !parsed.eventType || event.eventType === parsed.eventType)
        .filter((event) => !parsed.sessionId || event.sessionId === parsed.sessionId)
        .filter((event) => !parsed.deviceType || event.deviceType === parsed.deviceType)
        .filter((event) => !parsed.path || event.path === parsed.path)
        .slice(-parsed.limit);
      return { ok: true, summary: `${events.length} demo analytics event(s) returned.`, jobId: parsed.projectId, artifacts: [], structuredContent: { projectId: parsed.projectId, events, summary: summarize(events) }, logs: events.map(eventLine), errors: [] };
    }
  },
  {
    definition: {
      name: "summarize_demo_analytics",
      description: "Summarize demo analytics by page views, device type, errors, click targets, sessions, and event type.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, topLimit: { type: "number" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: summarizeDemoAnalyticsSchema,
    handler: async (input, ctx) => {
      const parsed = summarizeDemoAnalyticsSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const summary = summarize(store.events, parsed.topLimit);
      return { ok: true, summary: `Demo analytics: ${summary.pageViews} page view(s), ${summary.clicks} click(s), ${summary.errors} error(s), ${summary.sessions} session(s).`, jobId: parsed.projectId, artifacts: [], structuredContent: { projectId: parsed.projectId, plans: store.plans, summary }, logs: [JSON.stringify(summary, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "analyze_demo_interaction_funnel",
      description: "Analyze a configured demo interaction funnel and report reached counts, conversion rates, and drop-off points by step.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, funnelId: { type: "string" }, sessionLimit: { type: "number" } }, required: ["projectId", "funnelId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: analyzeDemoFunnelSchema,
    handler: async (input, ctx) => {
      const parsed = analyzeDemoFunnelSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const plan = [...store.plans].reverse().find((item) => item.funnels.some((funnel) => funnel.id === parsed.funnelId));
      if (!plan) throw new Error(`Funnel ${parsed.funnelId} not found.`);
      const report = analyzeFunnel(plan, parsed.funnelId, store.events, parsed.sessionLimit);
      return { ok: true, summary: `Funnel ${parsed.funnelId}: ${report.completedSessions}/${report.totalSessions} session(s) completed.`, jobId: parsed.projectId, artifacts: [], structuredContent: { projectId: parsed.projectId, report }, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "export_demo_analytics_report",
      description: "Export a Markdown demo analytics report with page views, devices, errors, clicks, funnels, and drop-off points.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportDemoAnalyticsReportSchema,
    handler: async (input, ctx) => {
      const parsed = exportDemoAnalyticsReportSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown(parsed.projectId, store));
      return { ok: true, summary: `Exported demo analytics report with ${store.events.length} event(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, outputPath: file.path, summary: summarize(store.events) }, logs: [file.path], errors: [] };
    }
  }
];
