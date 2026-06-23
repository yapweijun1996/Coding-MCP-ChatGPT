import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { listIssues } from "../../feedback/store.js";
import { atomicWrite } from "../../shared/atomic-write.js";
import { withKeyedLock } from "../../shared/keyed-lock.js";
import type { ToolModule } from "../types.js";

const learningTypeSchema = z.enum(["bug_pattern", "successful_fix", "user_preference", "workflow_pattern"]);
const learningStatusSchema = z.enum(["candidate", "verified", "deprecated"]);

const learningEvidenceSchema = z.object({
  label: z.string().min(1).max(200),
  source: z.string().min(1).max(500).optional(),
  projectId: z.string().min(1).max(120).optional(),
  issueId: z.string().min(1).max(120).optional(),
  filePath: z.string().min(1).max(300).optional(),
  note: z.string().max(1000).optional()
});

const learningRecordSchema = z.object({
  id: z.string().regex(/^learn_[a-zA-Z0-9_-]{1,80}$/),
  type: learningTypeSchema,
  status: learningStatusSchema,
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(3000),
  bugPattern: z.string().max(2000).optional(),
  rootCause: z.string().max(2000).optional(),
  fix: z.string().max(3000).optional(),
  verification: z.string().max(2000).optional(),
  detection: z.string().max(2000).optional(),
  preference: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(80)).max(40).optional().default([]),
  projectIds: z.array(z.string().min(1).max(120)).max(100).optional().default([]),
  evidence: z.array(learningEvidenceSchema).max(100).optional().default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
  seenCount: z.number().int().min(1).max(100000).optional().default(1)
});

const recordFixLearningInputSchema = z.object({
  type: learningTypeSchema.optional().default("bug_pattern"),
  status: learningStatusSchema.optional().default("verified"),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(3000),
  bugPattern: z.string().max(2000).optional(),
  rootCause: z.string().max(2000).optional(),
  fix: z.string().max(3000).optional(),
  verification: z.string().max(2000).optional(),
  detection: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(80)).max(40).optional().default([]),
  projectId: z.string().min(1).max(120).optional(),
  evidence: z.array(learningEvidenceSchema).max(100).optional().default([])
});

const recordUserPreferenceLearningInputSchema = z.object({
  title: z.string().min(1).max(200),
  preference: z.string().min(1).max(2000),
  scope: z.enum(["global", "project", "workflow", "ui", "code_style"]).optional().default("global"),
  projectId: z.string().min(1).max(120).optional(),
  evidence: z.array(learningEvidenceSchema).max(100).optional().default([])
});

const searchFixLearningsInputSchema = z.object({
  query: z.string().min(1).max(500),
  type: learningTypeSchema.optional(),
  status: learningStatusSchema.optional(),
  tags: z.array(z.string().min(1).max(80)).max(20).optional().default([]),
  projectId: z.string().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(100).optional().default(10)
});

const importResolvedFeedbackLearningsInputSchema = z.object({
  toolName: z.string().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
  status: learningStatusSchema.optional().default("verified")
});

const detectRecurringFixPatternInputSchema = z.object({
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(4000),
  tags: z.array(z.string().min(1).max(80)).max(20).optional().default([]),
  threshold: z.number().min(0).max(1).optional().default(0.12),
  limit: z.number().int().min(1).max(50).optional().default(5)
});

const exportFixLearningReportInputSchema = z.object({
  title: z.string().min(1).max(200).optional().default("Fix Learning Report"),
  type: learningTypeSchema.optional(),
  status: learningStatusSchema.optional(),
  outputPath: z.string().min(1).max(240).optional().default("fix-learning-report.md")
});

type LearningRecord = z.infer<typeof learningRecordSchema>;

interface LearningStore {
  version: 1;
  updatedAt: string;
  records: LearningRecord[];
}

function storePath(feedbackRoot: string): string {
  return path.join(feedbackRoot, "fix-learning.json");
}

function reportPath(feedbackRoot: string, outputPath: string): string {
  return path.join(feedbackRoot, outputPath);
}

function learningId(): string {
  return `learn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length >= 2).slice(0, 20000);
}

function scoreRecord(record: LearningRecord, queryTokens: string[], tagBoosts: string[]) {
  const haystack = tokenize([
    record.title,
    record.summary,
    record.bugPattern,
    record.rootCause,
    record.fix,
    record.verification,
    record.detection,
    record.preference,
    record.tags.join(" ")
  ].filter(Boolean).join(" "));
  if (!haystack.length || !queryTokens.length) return 0;
  const haySet = new Set(haystack);
  const matches = queryTokens.filter((token) => haySet.has(token)).length;
  const tagMatches = tagBoosts.filter((tag) => record.tags.includes(tag)).length;
  return Math.round(((matches / queryTokens.length) + tagMatches * 0.15) * 10000) / 10000;
}

async function readStore(feedbackRoot: string): Promise<LearningStore> {
  try {
    const raw = await readFile(storePath(feedbackRoot), "utf8");
    const parsed = JSON.parse(raw) as Partial<LearningStore>;
    if (parsed.version === 1 && Array.isArray(parsed.records)) {
      return {
        version: 1,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        records: parsed.records.map((record) => learningRecordSchema.parse(record))
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { version: 1, updatedAt: new Date().toISOString(), records: [] };
}

async function writeStore(feedbackRoot: string, records: LearningRecord[]): Promise<LearningStore> {
  await mkdir(feedbackRoot, { recursive: true });
  const payload: LearningStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    records: records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  };
  await atomicWrite(storePath(feedbackRoot), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

async function appendOrMerge(feedbackRoot: string, record: LearningRecord): Promise<LearningStore> {
  return withKeyedLock(`fix-learning:${storePath(feedbackRoot)}`, async () => {
    const store = await readStore(feedbackRoot);
    const existingIndex = store.records.findIndex((item) => item.title.toLowerCase() === record.title.toLowerCase() && item.type === record.type);
    if (existingIndex === -1) return writeStore(feedbackRoot, [record, ...store.records]);
    const existing = store.records[existingIndex];
    const merged: LearningRecord = {
      ...existing,
      status: record.status === "verified" ? "verified" : existing.status,
      summary: record.summary.length > existing.summary.length ? record.summary : existing.summary,
      tags: [...new Set([...existing.tags, ...record.tags])],
      projectIds: [...new Set([...existing.projectIds, ...record.projectIds])],
      evidence: [...existing.evidence, ...record.evidence],
      updatedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      seenCount: existing.seenCount + 1
    };
    const next = [...store.records];
    next[existingIndex] = merged;
    return writeStore(feedbackRoot, next);
  });
}

function recordLine(record: LearningRecord): string {
  return `${record.id} (${record.type}/${record.status}, seen ${record.seenCount}): ${record.title}`;
}

function renderReport(title: string, records: LearningRecord[]) {
  return [
    `# ${title}`,
    "",
    `Total learnings: ${records.length}`,
    "",
    "## Learnings",
    ...(records.length ? records.flatMap((record) => [
      "",
      `### ${record.title}`,
      "",
      `- ID: ${record.id}`,
      `- Type: ${record.type}`,
      `- Status: ${record.status}`,
      `- Seen: ${record.seenCount}`,
      `- Tags: ${record.tags.join(", ") || "none"}`,
      `- Projects: ${record.projectIds.join(", ") || "none"}`,
      "",
      record.summary,
      ...(record.rootCause ? ["", `Root cause: ${record.rootCause}`] : []),
      ...(record.fix ? ["", `Fix: ${record.fix}`] : []),
      ...(record.verification ? ["", `Verification: ${record.verification}`] : []),
      ...(record.detection ? ["", `How to detect next time: ${record.detection}`] : []),
      ...(record.preference ? ["", `Preference: ${record.preference}`] : [])
    ]) : ["- No learnings recorded."]),
    ""
  ].join("\n");
}

export const fixLearningTools: ToolModule[] = [
  {
    definition: {
      name: "record_fix_learning",
      description: "Record or merge a cross-project learning about a recurring bug, root cause, successful fix, verification, and future detection signal.",
      inputSchema: { type: "object", properties: { type: { type: "string" }, status: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, bugPattern: { type: "string" }, rootCause: { type: "string" }, fix: { type: "string" }, verification: { type: "string" }, detection: { type: "string" }, tags: { type: "array", items: { type: "string" } }, projectId: { type: "string" }, evidence: { type: "array" } }, required: ["title", "summary"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: recordFixLearningInputSchema,
    handler: async (input, ctx) => {
      const parsed = recordFixLearningInputSchema.parse(input);
      const now = new Date().toISOString();
      const record: LearningRecord = {
        id: learningId(),
        type: parsed.type,
        status: parsed.status,
        title: parsed.title,
        summary: parsed.summary,
        bugPattern: parsed.bugPattern,
        rootCause: parsed.rootCause,
        fix: parsed.fix,
        verification: parsed.verification,
        detection: parsed.detection,
        tags: parsed.tags,
        projectIds: parsed.projectId ? [parsed.projectId] : [],
        evidence: parsed.evidence,
        createdAt: now,
        updatedAt: now,
        seenCount: 1
      };
      const store = await appendOrMerge(ctx.feedbackRoot, record);
      return { ok: true, summary: `Recorded fix learning; store now has ${store.records.length} record(s).`, artifacts: [storePath(ctx.feedbackRoot)], structuredContent: { records: store.records, recordCount: store.records.length }, logs: store.records.slice(0, 5).map(recordLine), errors: [] };
    }
  },
  {
    definition: {
      name: "record_user_preference_learning",
      description: "Record a cross-project user preference or stable delivery preference with evidence so future agents can reuse it.",
      inputSchema: { type: "object", properties: { title: { type: "string" }, preference: { type: "string" }, scope: { type: "string" }, projectId: { type: "string" }, evidence: { type: "array" } }, required: ["title", "preference"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: recordUserPreferenceLearningInputSchema,
    handler: async (input, ctx) => {
      const parsed = recordUserPreferenceLearningInputSchema.parse(input);
      const now = new Date().toISOString();
      const record: LearningRecord = {
        id: learningId(),
        type: "user_preference",
        status: "verified",
        title: parsed.title,
        summary: parsed.preference,
        preference: parsed.preference,
        tags: ["preference", parsed.scope],
        projectIds: parsed.projectId ? [parsed.projectId] : [],
        evidence: parsed.evidence,
        createdAt: now,
        updatedAt: now,
        seenCount: 1
      };
      const store = await appendOrMerge(ctx.feedbackRoot, record);
      return { ok: true, summary: `Recorded user preference learning; store now has ${store.records.length} record(s).`, artifacts: [storePath(ctx.feedbackRoot)], structuredContent: { records: store.records, recordCount: store.records.length }, logs: store.records.slice(0, 5).map(recordLine), errors: [] };
    }
  },
  {
    definition: {
      name: "search_fix_learnings",
      description: "Search cross-project fix learnings, user preferences, and successful fix patterns by query, tag, type, status, or project id.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, type: { type: "string" }, status: { type: "string" }, tags: { type: "array", items: { type: "string" } }, projectId: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: searchFixLearningsInputSchema,
    handler: async (input, ctx) => {
      const parsed = searchFixLearningsInputSchema.parse(input);
      const store = await readStore(ctx.feedbackRoot);
      const queryTokens = tokenize(parsed.query);
      const rows = store.records
        .filter((record) => !parsed.type || record.type === parsed.type)
        .filter((record) => !parsed.status || record.status === parsed.status)
        .filter((record) => !parsed.projectId || record.projectIds.includes(parsed.projectId))
        .filter((record) => !parsed.tags.length || parsed.tags.every((tag) => record.tags.includes(tag)))
        .map((record) => ({ record, score: scoreRecord(record, queryTokens, parsed.tags) }))
        .filter((row) => row.score > 0)
        .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt))
        .slice(0, parsed.limit);
      return { ok: true, summary: `Found ${rows.length} matching fix learning(s).`, artifacts: [], structuredContent: { matches: rows, totalRecords: store.records.length }, logs: rows.map((row) => `${row.score} ${recordLine(row.record)}`), errors: [] };
    }
  },
  {
    definition: {
      name: "import_resolved_feedback_learnings",
      description: "Import resolved feedback issues with resolution notes into cross-project fix learning records.",
      inputSchema: { type: "object", properties: { toolName: { type: "string" }, limit: { type: "number" }, status: { type: "string" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: importResolvedFeedbackLearningsInputSchema,
    handler: async (input, ctx) => {
      const parsed = importResolvedFeedbackLearningsInputSchema.parse(input);
      const issues = await listIssues(ctx.feedbackRoot, { status: "resolved", toolName: parsed.toolName, limit: parsed.limit });
      const imported = issues.filter((issue) => issue.resolutionNote).map((issue) => {
        const now = new Date().toISOString();
        return {
          id: learningId(),
          type: "successful_fix" as const,
          status: parsed.status,
          title: issue.title,
          summary: issue.resolutionNote!,
          bugPattern: issue.detail,
          fix: issue.resolutionNote,
          tags: ["feedback", issue.category, issue.severity, ...(issue.toolName ? [issue.toolName] : [])],
          projectIds: [],
          evidence: [{ label: issue.id, issueId: issue.id, source: "resolved feedback", note: issue.detail }],
          createdAt: now,
          updatedAt: now,
          seenCount: 1
        } satisfies LearningRecord;
      });
      let store = await readStore(ctx.feedbackRoot);
      for (const record of imported) store = await appendOrMerge(ctx.feedbackRoot, record);
      return { ok: true, summary: `Imported ${imported.length} resolved feedback learning(s).`, artifacts: [storePath(ctx.feedbackRoot)], structuredContent: { importedCount: imported.length, recordCount: store.records.length, imported }, logs: imported.map(recordLine), errors: [] };
    }
  },
  {
    definition: {
      name: "detect_recurring_fix_pattern",
      description: "Compare a new bug or request against stored learnings and return likely recurring patterns with reuse recommendations.",
      inputSchema: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" }, tags: { type: "array", items: { type: "string" } }, threshold: { type: "number" }, limit: { type: "number" } }, required: ["title", "detail"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: detectRecurringFixPatternInputSchema,
    handler: async (input, ctx) => {
      const parsed = detectRecurringFixPatternInputSchema.parse(input);
      const store = await readStore(ctx.feedbackRoot);
      const queryTokens = tokenize(`${parsed.title}\n${parsed.detail}\n${parsed.tags.join(" ")}`);
      const matches = store.records
        .map((record) => ({ record, score: scoreRecord(record, queryTokens, parsed.tags) }))
        .filter((row) => row.score >= parsed.threshold)
        .sort((left, right) => right.score - left.score || right.record.seenCount - left.record.seenCount)
        .slice(0, parsed.limit);
      const recommendations = matches.map((row) => `Review ${row.record.id}: ${row.record.fix ?? row.record.summary}`);
      return { ok: true, summary: `Detected ${matches.length} recurring pattern candidate(s).`, artifacts: [], structuredContent: { matches, recommendations }, logs: recommendations, errors: [] };
    }
  },
  {
    definition: {
      name: "export_fix_learning_report",
      description: "Export a Markdown report of cross-project fix learnings, recurring bugs, user preferences, and successful fix patterns.",
      inputSchema: { type: "object", properties: { title: { type: "string" }, type: { type: "string" }, status: { type: "string" }, outputPath: { type: "string" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportFixLearningReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportFixLearningReportInputSchema.parse(input);
      const store = await readStore(ctx.feedbackRoot);
      const records = store.records
        .filter((record) => !parsed.type || record.type === parsed.type)
        .filter((record) => !parsed.status || record.status === parsed.status);
      const markdown = renderReport(parsed.title, records);
      const output = reportPath(ctx.feedbackRoot, parsed.outputPath);
      await mkdir(path.dirname(output), { recursive: true });
      await atomicWrite(output, markdown);
      return { ok: true, summary: `Exported fix learning report with ${records.length} record(s).`, artifacts: [output], structuredContent: { path: output, recordCount: records.length, markdown }, logs: [markdown], errors: [] };
    }
  }
];
