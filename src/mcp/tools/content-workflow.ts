import { z } from "zod";
import { readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const contentStorePath = "content/content-workflow.json";

const contentTypeEnum = z.enum(["article", "email", "doc", "script", "slide-outline", "video-script", "social-post"]);
const statusEnum = z.enum(["draft", "in_review", "approved", "rejected", "archived"]);
const reviewDecisionEnum = z.enum(["approve", "request_changes", "reject"]);

const createContentBriefSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(3).max(200),
  contentType: contentTypeEnum,
  audience: z.string().min(1).max(300),
  goal: z.string().min(1).max(500),
  tone: z.string().min(1).max(160).default("clear and useful"),
  channels: z.array(z.string().min(1).max(80)).max(20).default([]),
  constraints: z.array(z.string().min(1).max(240)).max(30).default([]),
  reviewChecklist: z.array(z.string().min(1).max(240)).max(30).default(["Matches brief", "Clear call to action", "No unsupported claims"])
});

const createContentVersionSchema = z.object({
  projectId: z.string().min(8).max(80),
  briefId: z.string().min(1).max(80),
  title: z.string().min(3).max(200).optional(),
  body: z.string().min(1).max(50000),
  summary: z.string().max(1000).optional(),
  sourcePrompt: z.string().max(5000).optional(),
  notes: z.string().max(3000).optional(),
  status: statusEnum.default("draft")
});

const reviewContentVersionSchema = z.object({
  projectId: z.string().min(8).max(80),
  briefId: z.string().min(1).max(80),
  versionId: z.string().min(1).max(80),
  reviewer: z.string().min(1).max(120).default("reviewer"),
  decision: reviewDecisionEnum,
  comments: z.array(z.string().min(1).max(1000)).max(30).default([]),
  checklistResults: z.array(z.object({
    check: z.string().min(1).max(240),
    passed: z.boolean(),
    note: z.string().max(500).optional()
  })).max(50).default([])
});

const listContentVersionsSchema = z.object({
  projectId: z.string().min(8).max(80),
  briefId: z.string().min(1).max(80).optional(),
  contentType: contentTypeEnum.optional(),
  status: statusEnum.optional()
});

const approveContentVersionSchema = z.object({
  projectId: z.string().min(8).max(80),
  briefId: z.string().min(1).max(80),
  versionId: z.string().min(1).max(80),
  approvalNote: z.string().max(1000).optional()
});

const exportContentWorkflowSchema = z.object({
  projectId: z.string().min(8).max(80),
  briefId: z.string().min(1).max(80).optional(),
  outputPath: z.string().min(1).max(240).default("content/content-workflow-report.md")
});

type ContentType = z.infer<typeof contentTypeEnum>;
type ContentStatus = z.infer<typeof statusEnum>;
type ReviewDecision = z.infer<typeof reviewDecisionEnum>;

interface ContentReview {
  id: string;
  reviewer: string;
  decision: ReviewDecision;
  comments: string[];
  checklistResults: Array<{ check: string; passed: boolean; note?: string }>;
  reviewedAt: string;
}

interface ContentVersion {
  id: string;
  title: string;
  body: string;
  summary?: string;
  sourcePrompt?: string;
  notes?: string;
  status: ContentStatus;
  reviews: ContentReview[];
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvalNote?: string;
}

interface ContentBrief {
  id: string;
  title: string;
  contentType: ContentType;
  audience: string;
  goal: string;
  tone: string;
  channels: string[];
  constraints: string[];
  reviewChecklist: string[];
  versions: ContentVersion[];
  createdAt: string;
  updatedAt: string;
}

interface ContentWorkflowStore {
  version: 1;
  briefs: ContentBrief[];
}

function emptyStore(): ContentWorkflowStore {
  return { version: 1, briefs: [] };
}

async function readStore(ctx: ToolContext, projectId: string): Promise<ContentWorkflowStore> {
  try {
    const raw = await readProjectFile(ctx.projectRoot, projectId, contentStorePath);
    const parsed = JSON.parse(raw) as ContentWorkflowStore;
    return { version: 1, briefs: Array.isArray(parsed.briefs) ? parsed.briefs : [] };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(ctx: ToolContext, projectId: string, store: ContentWorkflowStore) {
  return writeProjectFile(ctx.projectRoot, projectId, contentStorePath, `${JSON.stringify(store, null, 2)}\n`);
}

function nextId(prefix: string, count: number): string {
  return `${prefix}_${String(count + 1).padStart(3, "0")}`;
}

function findBrief(store: ContentWorkflowStore, briefId: string): ContentBrief {
  const brief = store.briefs.find((item) => item.id === briefId);
  if (!brief) throw new Error(`Content brief ${briefId} not found.`);
  return brief;
}

function findVersion(brief: ContentBrief, versionId: string): ContentVersion {
  const version = brief.versions.find((item) => item.id === versionId);
  if (!version) throw new Error(`Content version ${versionId} not found.`);
  return version;
}

function summarize(store: ContentWorkflowStore) {
  return store.briefs.reduce((acc, brief) => {
    acc.briefs += 1;
    acc.byType[brief.contentType] = (acc.byType[brief.contentType] ?? 0) + 1;
    for (const version of brief.versions) {
      acc.versions += 1;
      acc.byStatus[version.status] = (acc.byStatus[version.status] ?? 0) + 1;
    }
    return acc;
  }, { briefs: 0, versions: 0, byType: {} as Record<string, number>, byStatus: {} as Record<string, number> });
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").trim();
}

function renderMarkdown(store: ContentWorkflowStore, briefId?: string): string {
  const briefs = briefId ? [findBrief(store, briefId)] : store.briefs;
  return `# Content Workflow Report

${briefs.map((brief) => `## ${escapeMarkdown(brief.title)}

- ID: \`${brief.id}\`
- Type: ${brief.contentType}
- Audience: ${escapeMarkdown(brief.audience)}
- Goal: ${escapeMarkdown(brief.goal)}
- Versions: ${brief.versions.length}

| Version | Status | Title | Reviews | Updated |
| --- | --- | --- | --- | --- |
${brief.versions.map((version) => `| ${version.id} | ${version.status} | ${escapeMarkdown(version.title)} | ${version.reviews.length} | ${version.updatedAt} |`).join("\n") || "| - | - | - | - | - |"}

${brief.versions.map((version) => `### ${version.id}: ${escapeMarkdown(version.title)}

Status: ${version.status}

${version.body}

${version.reviews.length ? `#### Reviews\n\n${version.reviews.map((review) => `- ${review.decision} by ${review.reviewer}: ${review.comments.join("; ") || "No comments"}`).join("\n")}` : ""}`).join("\n\n")}
`).join("\n\n")}
`;
}

export const contentWorkflowTools: ToolModule[] = [
  {
    definition: {
      name: "create_content_brief",
      description: "Create a project-local content brief for an article, email, doc, script, slide outline, video script, or social post.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, contentType: { type: "string", enum: ["article", "email", "doc", "script", "slide-outline", "video-script", "social-post"] }, audience: { type: "string" }, goal: { type: "string" }, tone: { type: "string" }, channels: { type: "array", items: { type: "string" } }, constraints: { type: "array", items: { type: "string" } }, reviewChecklist: { type: "array", items: { type: "string" } } }, required: ["projectId", "title", "contentType", "audience", "goal"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createContentBriefSchema,
    handler: async (input, ctx) => {
      const parsed = createContentBriefSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const now = new Date().toISOString();
      const brief: ContentBrief = { id: nextId("brief", store.briefs.length), title: parsed.title, contentType: parsed.contentType, audience: parsed.audience, goal: parsed.goal, tone: parsed.tone, channels: parsed.channels, constraints: parsed.constraints, reviewChecklist: parsed.reviewChecklist, versions: [], createdAt: now, updatedAt: now };
      store.briefs.push(brief);
      const file = await writeStore(ctx, parsed.projectId, store);
      return { ok: true, summary: `Created content brief ${brief.id}.`, jobId: parsed.projectId, artifacts: [file.path, brief.id], structuredContent: { projectId: parsed.projectId, brief, summary: summarize(store) }, logs: [brief.title], errors: [] };
    }
  },
  {
    definition: {
      name: "create_content_version",
      description: "Create a versioned draft for a content brief with source prompt, summary, notes, and review status.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, briefId: { type: "string" }, title: { type: "string" }, body: { type: "string" }, summary: { type: "string" }, sourcePrompt: { type: "string" }, notes: { type: "string" }, status: { type: "string", enum: ["draft", "in_review", "approved", "rejected", "archived"] } }, required: ["projectId", "briefId", "body"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createContentVersionSchema,
    handler: async (input, ctx) => {
      const parsed = createContentVersionSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const brief = findBrief(store, parsed.briefId);
      const now = new Date().toISOString();
      const version: ContentVersion = { id: nextId("version", brief.versions.length), title: parsed.title ?? brief.title, body: parsed.body, summary: parsed.summary, sourcePrompt: parsed.sourcePrompt, notes: parsed.notes, status: parsed.status, reviews: [], createdAt: now, updatedAt: now };
      brief.versions.push(version);
      brief.updatedAt = now;
      const file = await writeStore(ctx, parsed.projectId, store);
      return { ok: true, summary: `Created content version ${version.id}.`, jobId: parsed.projectId, artifacts: [file.path, brief.id, version.id], structuredContent: { projectId: parsed.projectId, briefId: brief.id, version, summary: summarize(store) }, logs: [`${brief.id}/${version.id}: ${version.title}`], errors: [] };
    }
  },
  {
    definition: {
      name: "review_content_version",
      description: "Attach a review decision, comments, and checklist results to a content version.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, briefId: { type: "string" }, versionId: { type: "string" }, reviewer: { type: "string" }, decision: { type: "string", enum: ["approve", "request_changes", "reject"] }, comments: { type: "array", items: { type: "string" } }, checklistResults: { type: "array", items: { type: "object" } } }, required: ["projectId", "briefId", "versionId", "decision"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: reviewContentVersionSchema,
    handler: async (input, ctx) => {
      const parsed = reviewContentVersionSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const brief = findBrief(store, parsed.briefId);
      const version = findVersion(brief, parsed.versionId);
      const now = new Date().toISOString();
      const review: ContentReview = { id: nextId("review", version.reviews.length), reviewer: parsed.reviewer, decision: parsed.decision, comments: parsed.comments, checklistResults: parsed.checklistResults, reviewedAt: now };
      version.reviews.push(review);
      version.status = parsed.decision === "approve" ? "in_review" : parsed.decision === "reject" ? "rejected" : "in_review";
      version.updatedAt = now;
      brief.updatedAt = now;
      const file = await writeStore(ctx, parsed.projectId, store);
      return { ok: true, summary: `Reviewed content version ${version.id}: ${review.decision}.`, jobId: parsed.projectId, artifacts: [file.path, review.id], structuredContent: { projectId: parsed.projectId, briefId: brief.id, version, review }, logs: [`${review.decision}: ${review.comments.join("; ")}`], errors: [] };
    }
  },
  {
    definition: {
      name: "list_content_versions",
      description: "List content briefs and versions with optional brief, content type, and status filters.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, briefId: { type: "string" }, contentType: { type: "string", enum: ["article", "email", "doc", "script", "slide-outline", "video-script", "social-post"] }, status: { type: "string", enum: ["draft", "in_review", "approved", "rejected", "archived"] } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listContentVersionsSchema,
    handler: async (input, ctx) => {
      const parsed = listContentVersionsSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const briefs = store.briefs
        .filter((brief) => !parsed.briefId || brief.id === parsed.briefId)
        .filter((brief) => !parsed.contentType || brief.contentType === parsed.contentType)
        .map((brief) => ({ ...brief, versions: brief.versions.filter((version) => !parsed.status || version.status === parsed.status) }))
        .filter((brief) => !parsed.status || brief.versions.length > 0);
      return { ok: true, summary: `${briefs.reduce((count, brief) => count + brief.versions.length, 0)} content version(s) returned.`, jobId: parsed.projectId, artifacts: [], structuredContent: { projectId: parsed.projectId, briefs, summary: summarize({ version: 1, briefs }) }, logs: briefs.flatMap((brief) => brief.versions.map((version) => `${brief.id}/${version.id}: ${version.status} ${version.title}`)), errors: [] };
    }
  },
  {
    definition: {
      name: "approve_content_version",
      description: "Mark a content version approved with an optional approval note.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, briefId: { type: "string" }, versionId: { type: "string" }, approvalNote: { type: "string" } }, required: ["projectId", "briefId", "versionId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: approveContentVersionSchema,
    handler: async (input, ctx) => {
      const parsed = approveContentVersionSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const brief = findBrief(store, parsed.briefId);
      const version = findVersion(brief, parsed.versionId);
      const now = new Date().toISOString();
      version.status = "approved";
      version.approvedAt = now;
      version.approvalNote = parsed.approvalNote;
      version.updatedAt = now;
      brief.updatedAt = now;
      const file = await writeStore(ctx, parsed.projectId, store);
      return { ok: true, summary: `Approved content version ${version.id}.`, jobId: parsed.projectId, artifacts: [file.path, brief.id, version.id], structuredContent: { projectId: parsed.projectId, briefId: brief.id, version, summary: summarize(store) }, logs: [parsed.approvalNote ?? "Approved"], errors: [] };
    }
  },
  {
    definition: {
      name: "export_content_workflow_report",
      description: "Export content briefs, versions, reviews, and approval status as a Markdown workflow report.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, briefId: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportContentWorkflowSchema,
    handler: async (input, ctx) => {
      const parsed = exportContentWorkflowSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, renderMarkdown(store, parsed.briefId));
      return { ok: true, summary: `Exported content workflow report to ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, outputPath: file.path, summary: summarize(store) }, logs: [file.path], errors: [] };
    }
  }
];
