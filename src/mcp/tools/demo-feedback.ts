import { z } from "zod";
import {
  getProjectTask,
  readProjectFile,
  recordProjectTaskEvidence,
  writeProjectFile,
  type ProjectTaskEvidenceLink
} from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const feedbackStorePath = "feedback/demo-feedback.json";

const sentimentEnum = z.enum(["positive", "neutral", "negative", "mixed"]);
const statusEnum = z.enum(["new", "triaged", "linked", "resolved", "wontfix"]);
const fieldTypeEnum = z.enum(["text", "textarea", "rating", "select", "checkbox", "url", "email"]);

const feedbackFieldSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().min(1).max(160),
  type: fieldTypeEnum,
  required: z.boolean().default(false),
  options: z.array(z.string().min(1).max(120)).max(20).optional()
});

const ratingScaleSchema = z.object({
  min: z.number().int().min(0).max(10).default(1),
  max: z.number().int().min(1).max(10).default(5),
  label: z.string().min(1).max(120).default("Overall rating")
}).refine((scale) => scale.max > scale.min, { message: "ratingScale.max must be greater than min" });

const createFeedbackFormSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(3).max(180),
  description: z.string().max(1000).optional(),
  fields: z.array(feedbackFieldSchema).min(1).max(30).optional(),
  ratingScale: ratingScaleSchema.default({ min: 1, max: 5, label: "Overall rating" }),
  screenshotEnabled: z.boolean().default(true),
  taskLinkingEnabled: z.boolean().default(true),
  publicPrompt: z.string().max(1000).optional()
});

const submitFeedbackSchema = z.object({
  projectId: z.string().min(8).max(80),
  formId: z.string().min(1).max(80).optional(),
  rating: z.number().int().min(0).max(10).optional(),
  sentiment: sentimentEnum.default("neutral"),
  summary: z.string().min(3).max(240),
  detail: z.string().max(5000).optional(),
  pageUrl: z.string().url().max(1000).optional(),
  screenshotUrl: z.string().url().max(1000).optional(),
  screenshotPath: z.string().min(1).max(240).optional(),
  screenshotNote: z.string().max(2000).optional(),
  selector: z.string().max(400).optional(),
  taskId: z.string().min(1).max(120).optional(),
  tags: z.array(z.string().min(1).max(60)).max(20).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

const listFeedbackSchema = z.object({
  projectId: z.string().min(8).max(80),
  status: statusEnum.optional(),
  sentiment: sentimentEnum.optional(),
  taskId: z.string().min(1).max(120).optional(),
  tag: z.string().min(1).max(60).optional(),
  limit: z.number().int().min(1).max(500).default(50)
});

const linkFeedbackSchema = z.object({
  projectId: z.string().min(8).max(80),
  feedbackId: z.string().min(1).max(80),
  taskId: z.string().min(1).max(120),
  note: z.string().max(2000).optional(),
  status: statusEnum.default("linked")
});

const exportFeedbackReportSchema = z.object({
  projectId: z.string().min(8).max(80),
  outputPath: z.string().min(1).max(240).default("feedback/demo-feedback-report.md")
});

interface FeedbackForm {
  id: string;
  title: string;
  description?: string;
  fields: Array<z.infer<typeof feedbackFieldSchema>>;
  ratingScale: z.infer<typeof ratingScaleSchema>;
  screenshotEnabled: boolean;
  taskLinkingEnabled: boolean;
  publicPrompt?: string;
  createdAt: string;
  updatedAt: string;
}

interface DemoFeedback {
  id: string;
  formId?: string;
  submittedAt: string;
  rating?: number;
  sentiment: z.infer<typeof sentimentEnum>;
  summary: string;
  detail?: string;
  pageUrl?: string;
  screenshot?: {
    url?: string;
    path?: string;
    note?: string;
    selector?: string;
  };
  taskId?: string;
  tags: string[];
  status: z.infer<typeof statusEnum>;
  metadata: Record<string, unknown>;
}

interface DemoFeedbackStore {
  version: 1;
  forms: FeedbackForm[];
  feedback: DemoFeedback[];
}

function defaultFields(): FeedbackForm["fields"] {
  return [
    { id: "summary", label: "What should we improve?", type: "text", required: true },
    { id: "detail", label: "Details", type: "textarea", required: false },
    { id: "pageUrl", label: "Page URL", type: "url", required: false }
  ];
}

function emptyStore(): DemoFeedbackStore {
  return { version: 1, forms: [], feedback: [] };
}

async function readStore(ctx: ToolContext, projectId: string): Promise<DemoFeedbackStore> {
  try {
    const raw = await readProjectFile(ctx.projectRoot, projectId, feedbackStorePath);
    const parsed = JSON.parse(raw) as DemoFeedbackStore;
    return {
      version: 1,
      forms: Array.isArray(parsed.forms) ? parsed.forms : [],
      feedback: Array.isArray(parsed.feedback) ? parsed.feedback : []
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return emptyStore();
    }
    throw error;
  }
}

async function writeStore(ctx: ToolContext, projectId: string, store: DemoFeedbackStore) {
  return writeProjectFile(ctx.projectRoot, projectId, feedbackStorePath, `${JSON.stringify(store, null, 2)}\n`);
}

function nextId(prefix: string, count: number): string {
  return `${prefix}_${String(count + 1).padStart(3, "0")}`;
}

function summarize(feedback: DemoFeedback[]) {
  const ratings = feedback.filter((item) => typeof item.rating === "number").map((item) => item.rating as number);
  return feedback.reduce((acc, item) => {
    acc.total += 1;
    acc.byStatus[item.status] = (acc.byStatus[item.status] ?? 0) + 1;
    acc.bySentiment[item.sentiment] = (acc.bySentiment[item.sentiment] ?? 0) + 1;
    if (item.taskId) acc.linkedToTasks += 1;
    for (const tag of item.tags) acc.byTag[tag] = (acc.byTag[tag] ?? 0) + 1;
    return acc;
  }, {
    total: 0,
    averageRating: ratings.length ? Number((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length).toFixed(2)) : undefined,
    linkedToTasks: 0,
    byStatus: {} as Record<string, number>,
    bySentiment: {} as Record<string, number>,
    byTag: {} as Record<string, number>
  });
}

function feedbackLine(item: DemoFeedback): string {
  const rating = typeof item.rating === "number" ? ` rating=${item.rating}` : "";
  const task = item.taskId ? ` task=${item.taskId}` : "";
  return `${item.id} (${item.status}/${item.sentiment}${rating}${task}): ${item.summary}`;
}

function evidenceFor(item: DemoFeedback, note?: string): ProjectTaskEvidenceLink {
  const detail = [
    item.detail,
    item.pageUrl ? `Page: ${item.pageUrl}` : undefined,
    item.screenshot?.note ? `Screenshot note: ${item.screenshot.note}` : undefined,
    note
  ].filter(Boolean).join("\n\n");
  return {
    label: `Demo feedback ${item.id}: ${item.summary}`,
    kind: item.screenshot?.url || item.screenshot?.path ? "screenshot" : "note",
    url: item.screenshot?.url ?? item.pageUrl,
    artifact: item.screenshot?.path,
    note: detail || undefined
  };
}

async function recordTaskLink(ctx: ToolContext, projectId: string, item: DemoFeedback, taskId: string, note?: string) {
  await getProjectTask(ctx.projectRoot, projectId, taskId);
  await recordProjectTaskEvidence(ctx.projectRoot, projectId, taskId, [evidenceFor({ ...item, taskId }, note)]);
}

function markdown(projectId: string, forms: FeedbackForm[], feedback: DemoFeedback[]): string {
  const summary = summarize(feedback);
  const rows = feedback.map((item) => `| ${item.id} | ${item.status} | ${item.sentiment} | ${item.rating ?? ""} | ${item.taskId ?? ""} | ${item.summary.replaceAll("|", "\\|")} | ${item.screenshot?.note?.replaceAll("|", "\\|") ?? ""} |`).join("\n");
  return `# Demo Feedback Report

- Project: \`${projectId}\`
- Forms: ${forms.length}
- Feedback items: ${summary.total}
- Average rating: ${summary.averageRating ?? "n/a"}
- Linked to tasks: ${summary.linkedToTasks}

## Open Feedback

${feedback.filter((item) => !["resolved", "wontfix"].includes(item.status)).map((item) => `- ${feedbackLine(item)}`).join("\n") || "- No open demo feedback."}

## Feedback Table

| ID | Status | Sentiment | Rating | Task | Summary | Screenshot note |
| --- | --- | --- | --- | --- | --- | --- |
${rows || "| - | - | - | - | - | No feedback | - |"}
`;
}

export const demoFeedbackTools: ToolModule[] = [
  {
    definition: {
      name: "create_demo_feedback_form",
      description: "Create or update a project-local demo feedback form definition with rating, screenshot note, and task-linking settings.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, fields: { type: "array", items: { type: "object" } }, ratingScale: { type: "object" }, screenshotEnabled: { type: "boolean" }, taskLinkingEnabled: { type: "boolean" }, publicPrompt: { type: "string" } }, required: ["projectId", "title"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createFeedbackFormSchema,
    handler: async (input, ctx) => {
      const parsed = createFeedbackFormSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const now = new Date().toISOString();
      const form: FeedbackForm = {
        id: nextId("form", store.forms.length),
        title: parsed.title,
        description: parsed.description,
        fields: parsed.fields ?? defaultFields(),
        ratingScale: parsed.ratingScale,
        screenshotEnabled: parsed.screenshotEnabled,
        taskLinkingEnabled: parsed.taskLinkingEnabled,
        publicPrompt: parsed.publicPrompt,
        createdAt: now,
        updatedAt: now
      };
      store.forms.push(form);
      const file = await writeStore(ctx, parsed.projectId, store);
      return { ok: true, summary: `Created demo feedback form ${form.id}.`, jobId: parsed.projectId, artifacts: [file.path, form.id], structuredContent: { projectId: parsed.projectId, form }, logs: [form.title], errors: [] };
    }
  },
  {
    definition: {
      name: "submit_demo_feedback",
      description: "Capture a demo user's feedback submission with optional rating, page URL, screenshot note, tags, and project task link.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, formId: { type: "string" }, rating: { type: "number" }, sentiment: { type: "string", enum: ["positive", "neutral", "negative", "mixed"] }, summary: { type: "string" }, detail: { type: "string" }, pageUrl: { type: "string" }, screenshotUrl: { type: "string" }, screenshotPath: { type: "string" }, screenshotNote: { type: "string" }, selector: { type: "string" }, taskId: { type: "string" }, tags: { type: "array", items: { type: "string" } }, metadata: { type: "object" } }, required: ["projectId", "summary"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: submitFeedbackSchema,
    handler: async (input, ctx) => {
      const parsed = submitFeedbackSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      if (parsed.formId && !store.forms.some((form) => form.id === parsed.formId)) throw new Error(`Feedback form ${parsed.formId} not found.`);
      const now = new Date().toISOString();
      const item: DemoFeedback = {
        id: nextId("feedback", store.feedback.length),
        formId: parsed.formId,
        submittedAt: now,
        rating: parsed.rating,
        sentiment: parsed.sentiment,
        summary: parsed.summary,
        detail: parsed.detail,
        pageUrl: parsed.pageUrl,
        screenshot: parsed.screenshotUrl || parsed.screenshotPath || parsed.screenshotNote || parsed.selector ? { url: parsed.screenshotUrl, path: parsed.screenshotPath, note: parsed.screenshotNote, selector: parsed.selector } : undefined,
        taskId: parsed.taskId,
        tags: parsed.tags,
        status: parsed.taskId ? "linked" : "new",
        metadata: parsed.metadata
      };
      if (parsed.taskId) await recordTaskLink(ctx, parsed.projectId, item, parsed.taskId);
      store.feedback.push(item);
      const file = await writeStore(ctx, parsed.projectId, store);
      return { ok: true, summary: `Captured demo feedback ${item.id}.`, jobId: parsed.projectId, artifacts: [file.path, item.id], structuredContent: { projectId: parsed.projectId, feedback: item, summary: summarize(store.feedback) }, logs: [feedbackLine(item)], errors: [] };
    }
  },
  {
    definition: {
      name: "list_demo_feedback",
      description: "List captured demo feedback with status, sentiment, task, tag, and limit filters plus aggregate rating/status counts.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, status: { type: "string", enum: ["new", "triaged", "linked", "resolved", "wontfix"] }, sentiment: { type: "string", enum: ["positive", "neutral", "negative", "mixed"] }, taskId: { type: "string" }, tag: { type: "string" }, limit: { type: "number" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listFeedbackSchema,
    handler: async (input, ctx) => {
      const parsed = listFeedbackSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const feedback = store.feedback
        .filter((item) => !parsed.status || item.status === parsed.status)
        .filter((item) => !parsed.sentiment || item.sentiment === parsed.sentiment)
        .filter((item) => !parsed.taskId || item.taskId === parsed.taskId)
        .filter((item) => !parsed.tag || item.tags.includes(parsed.tag))
        .slice(-parsed.limit);
      return { ok: true, summary: `${feedback.length} demo feedback item(s) returned.`, jobId: parsed.projectId, artifacts: [], structuredContent: { projectId: parsed.projectId, forms: store.forms, feedback, summary: summarize(feedback) }, logs: feedback.map(feedbackLine), errors: [] };
    }
  },
  {
    definition: {
      name: "link_demo_feedback_to_task",
      description: "Link an existing demo feedback item to a project task and record it as task evidence for follow-up implementation.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, feedbackId: { type: "string" }, taskId: { type: "string" }, note: { type: "string" }, status: { type: "string", enum: ["new", "triaged", "linked", "resolved", "wontfix"] } }, required: ["projectId", "feedbackId", "taskId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: linkFeedbackSchema,
    handler: async (input, ctx) => {
      const parsed = linkFeedbackSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const index = store.feedback.findIndex((item) => item.id === parsed.feedbackId);
      if (index < 0) throw new Error(`Demo feedback ${parsed.feedbackId} not found.`);
      const next: DemoFeedback = { ...store.feedback[index], taskId: parsed.taskId, status: parsed.status };
      await recordTaskLink(ctx, parsed.projectId, next, parsed.taskId, parsed.note);
      store.feedback = [...store.feedback.slice(0, index), next, ...store.feedback.slice(index + 1)];
      const file = await writeStore(ctx, parsed.projectId, store);
      return { ok: true, summary: `Linked demo feedback ${next.id} to task ${parsed.taskId}.`, jobId: parsed.projectId, artifacts: [file.path, next.id, parsed.taskId], structuredContent: { projectId: parsed.projectId, feedback: next, summary: summarize(store.feedback) }, logs: [feedbackLine(next)], errors: [] };
    }
  },
  {
    definition: {
      name: "export_demo_feedback_report",
      description: "Export a Markdown report of demo feedback forms, ratings, screenshot notes, open items, and task links.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportFeedbackReportSchema,
    handler: async (input, ctx) => {
      const parsed = exportFeedbackReportSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown(parsed.projectId, store.forms, store.feedback));
      return { ok: true, summary: `Exported demo feedback report with ${store.feedback.length} item(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, outputPath: file.path, summary: summarize(store.feedback) }, logs: [file.path], errors: [] };
    }
  }
];
