import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { listIssues } from "../../feedback/store.js";
import { getProjectManifest, listProjectFiles, listProjects, readProjectFile } from "../../projects/store.js";
import { atomicWrite } from "../../shared/atomic-write.js";
import type { ToolModule } from "../types.js";

const sourceKindSchema = z.enum(["tool_log", "tool_error", "report", "screenshot", "issue", "project_note", "artifact", "fix_learning"]);

const indexRecordSchema = z.object({
  id: z.string().min(1).max(180),
  kind: sourceKindSchema,
  title: z.string().min(1).max(240),
  text: z.string().min(1).max(20000),
  projectId: z.string().min(1).max(120).optional(),
  toolName: z.string().min(1).max(160).optional(),
  sourcePath: z.string().min(1).max(500).optional(),
  url: z.string().min(1).max(1000).optional(),
  createdAt: z.string().min(1).max(80).optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({})
});

const buildToolOutputSearchIndexInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  includeAllProjects: z.boolean().optional().default(false),
  includeProjectFiles: z.boolean().optional().default(true),
  includeFeedbackIssues: z.boolean().optional().default(true),
  includeFixLearnings: z.boolean().optional().default(true),
  maxProjectFiles: z.number().int().min(1).max(1000).optional().default(200),
  outputPath: z.string().min(1).max(240).optional().default("tool-output-search-index.json")
});

const ingestToolOutputRecordInputSchema = z.object({
  record: indexRecordSchema,
  indexPath: z.string().min(1).max(240).optional().default("tool-output-search-index.json")
});

const searchToolOutputsInputSchema = z.object({
  query: z.string().min(1).max(500),
  indexPath: z.string().min(1).max(240).optional().default("tool-output-search-index.json"),
  kind: sourceKindSchema.optional(),
  projectId: z.string().min(1).max(120).optional(),
  toolName: z.string().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(100).optional().default(10)
});

const findSimilarToolErrorsInputSchema = z.object({
  errorText: z.string().min(1).max(8000),
  indexPath: z.string().min(1).max(240).optional().default("tool-output-search-index.json"),
  limit: z.number().int().min(1).max(50).optional().default(5)
});

const summarizeToolOutputSearchSourcesInputSchema = z.object({
  indexPath: z.string().min(1).max(240).optional().default("tool-output-search-index.json")
});

const exportToolOutputSearchReportInputSchema = z.object({
  query: z.string().min(1).max(500),
  indexPath: z.string().min(1).max(240).optional().default("tool-output-search-index.json"),
  outputPath: z.string().min(1).max(240).optional().default("tool-output-search-report.md"),
  limit: z.number().int().min(1).max(100).optional().default(10)
});

type SourceKind = z.infer<typeof sourceKindSchema>;
type IndexRecord = z.infer<typeof indexRecordSchema>;

interface SearchIndex {
  version: 1;
  updatedAt: string;
  records: IndexRecord[];
}

function storagePath(feedbackRoot: string, relativePath: string): string {
  return path.join(feedbackRoot, relativePath);
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "record";
}

function tokenize(text: string): string[] {
  const base = text.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length >= 2).slice(0, 30000);
  const bigrams: string[] = [];
  for (let index = 0; index < Math.min(base.length - 1, 3000); index += 1) bigrams.push(`${base[index]}_${base[index + 1]}`);
  return [...base, ...bigrams];
}

function weights(tokens: string[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const token of tokens) output[token] = (output[token] ?? 0) + 1;
  return output;
}

function cosine(left: Record<string, number>, right: Record<string, number>): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const value of Object.values(left)) leftNorm += value * value;
  for (const value of Object.values(right)) rightNorm += value * value;
  for (const [token, value] of Object.entries(left)) dot += value * (right[token] ?? 0);
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function recordText(record: IndexRecord): string {
  return [record.title, record.kind, record.toolName, record.sourcePath, record.text].filter(Boolean).join("\n");
}

function score(record: IndexRecord, query: string): number {
  const value = cosine(weights(tokenize(query)), weights(tokenize(recordText(record))));
  return Math.round(value * 10000) / 10000;
}

async function readIndex(feedbackRoot: string, indexPath: string): Promise<SearchIndex> {
  try {
    const raw = await readFile(storagePath(feedbackRoot, indexPath), "utf8");
    const parsed = JSON.parse(raw) as Partial<SearchIndex>;
    if (parsed.version === 1 && Array.isArray(parsed.records)) {
      return { version: 1, updatedAt: parsed.updatedAt ?? new Date().toISOString(), records: parsed.records.map((record) => indexRecordSchema.parse(record)) };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { version: 1, updatedAt: new Date().toISOString(), records: [] };
}

async function writeIndex(feedbackRoot: string, indexPath: string, records: IndexRecord[]): Promise<SearchIndex> {
  await mkdir(feedbackRoot, { recursive: true });
  const payload: SearchIndex = {
    version: 1,
    updatedAt: new Date().toISOString(),
    records: [...new Map(records.map((record) => [record.id, record])).values()].sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
  };
  await atomicWrite(storagePath(feedbackRoot, indexPath), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function searchableFile(filePath: string): boolean {
  return /\.(md|txt|json|html|css|js|ts|tsx|log)$/i.test(filePath) && !/\.(png|jpe?g|webp|gif|mp4|webm|pdf|pptx|zip)$/i.test(filePath);
}

function fileKind(filePath: string): SourceKind {
  if (/screenshot|capture/i.test(filePath)) return "screenshot";
  if (/report|audit|evaluation|matrix|summary/i.test(filePath)) return "report";
  if (/note|memory|readme|docs/i.test(filePath)) return "project_note";
  return "artifact";
}

async function collectProjectRecords(projectRoot: string, projectId: string, includeFiles: boolean, maxFiles: number): Promise<IndexRecord[]> {
  const manifest = await getProjectManifest(projectRoot, projectId);
  const historyRecords = manifest.taskHistory.flatMap((item, index) => {
    const base = {
      projectId,
      toolName: item.toolName,
      createdAt: item.time,
      metadata: { ok: item.ok, details: item.details }
    };
    const records: IndexRecord[] = [{
      id: `project:${projectId}:history:${index}:summary`,
      kind: item.ok ? "tool_log" : "tool_error",
      title: item.summary,
      text: [item.summary, JSON.stringify(item.details ?? {})].join("\n"),
      ...base
    }];
    return records;
  });
  if (!includeFiles) return historyRecords;
  const files = (await listProjectFiles(projectRoot, projectId)).filter((file) => searchableFile(file.path)).slice(0, maxFiles);
  const fileRecords: IndexRecord[] = [];
  for (const file of files) {
    const text = await readProjectFile(projectRoot, projectId, file.path, 200000).catch(() => "");
    if (!text.trim()) continue;
    fileRecords.push({
      id: `project:${projectId}:file:${slug(file.path)}`,
      kind: fileKind(file.path),
      title: file.path,
      text: text.slice(0, 20000),
      projectId,
      sourcePath: file.path,
      createdAt: file.modifiedAt,
      metadata: { size: file.size }
    });
  }
  return [...historyRecords, ...fileRecords];
}

async function collectFeedbackRecords(feedbackRoot: string): Promise<IndexRecord[]> {
  const issues = await listIssues(feedbackRoot, { limit: 500 });
  return issues.map((issue) => ({
    id: `issue:${issue.id}`,
    kind: "issue",
    title: issue.title,
    text: [issue.detail, issue.reproSteps, issue.resolutionNote, JSON.stringify(issue.context ?? {})].filter(Boolean).join("\n"),
    toolName: issue.toolName,
    sourcePath: "issues.json",
    createdAt: issue.createdAt,
    metadata: { status: issue.status, severity: issue.severity, category: issue.category }
  }));
}

async function collectFixLearningRecords(feedbackRoot: string): Promise<IndexRecord[]> {
  const raw = await readFile(storagePath(feedbackRoot, "fix-learning.json"), "utf8").catch(() => "");
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw) as { records?: Array<Record<string, unknown>> };
  const records: IndexRecord[] = (parsed.records ?? []).map((record, index) => ({
    id: `fix-learning:${String(record.id ?? index)}`,
    kind: "fix_learning",
    title: String(record.title ?? "Fix learning"),
    text: [record.summary, record.bugPattern, record.rootCause, record.fix, record.verification, record.detection, record.preference].filter(Boolean).join("\n"),
    sourcePath: "fix-learning.json",
    createdAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
    metadata: record
  }));
  return records.filter((record) => record.text.trim());
}

function searchRecords(records: IndexRecord[], input: z.infer<typeof searchToolOutputsInputSchema>) {
  return records
    .filter((record) => !input.kind || record.kind === input.kind)
    .filter((record) => !input.projectId || record.projectId === input.projectId)
    .filter((record) => !input.toolName || record.toolName === input.toolName)
    .map((record) => ({ record, score: score(record, input.query), snippet: record.text.length > 500 ? `${record.text.slice(0, 497)}...` : record.text }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || (right.record.createdAt ?? "").localeCompare(left.record.createdAt ?? ""))
    .slice(0, input.limit);
}

export const toolOutputSearchTools: ToolModule[] = [
  {
    definition: {
      name: "build_tool_output_search_index",
      description: "Build a cross-source lexical semantic index over prior tool outputs, project reports, errors, screenshots metadata, issues, project notes, and fix learnings.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, includeAllProjects: { type: "boolean" }, includeProjectFiles: { type: "boolean" }, includeFeedbackIssues: { type: "boolean" }, includeFixLearnings: { type: "boolean" }, maxProjectFiles: { type: "number" }, outputPath: { type: "string" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: buildToolOutputSearchIndexInputSchema,
    handler: async (input, ctx) => {
      const parsed = buildToolOutputSearchIndexInputSchema.parse(input);
      const projectIds = parsed.projectId
        ? [parsed.projectId]
        : parsed.includeAllProjects
          ? (await listProjects(ctx.projectRoot)).map((project) => project.id)
          : [];
      const projectRecords = (await Promise.all(projectIds.map((projectId) => collectProjectRecords(ctx.projectRoot, projectId, parsed.includeProjectFiles, parsed.maxProjectFiles)))).flat();
      const feedbackRecords = parsed.includeFeedbackIssues ? await collectFeedbackRecords(ctx.feedbackRoot) : [];
      const learningRecords = parsed.includeFixLearnings ? await collectFixLearningRecords(ctx.feedbackRoot) : [];
      const index = await writeIndex(ctx.feedbackRoot, parsed.outputPath, [...projectRecords, ...feedbackRecords, ...learningRecords]);
      return { ok: true, summary: `Built tool output search index with ${index.records.length} record(s).`, artifacts: [storagePath(ctx.feedbackRoot, parsed.outputPath)], structuredContent: { recordCount: index.records.length, projectCount: projectIds.length, byKind: summarizeKinds(index.records) }, logs: [JSON.stringify({ recordCount: index.records.length, projectIds }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "ingest_tool_output_record",
      description: "Append a single tool output, error, report, screenshot metadata, issue note, or project note to the shared tool output search index.",
      inputSchema: { type: "object", properties: { record: { type: "object" }, indexPath: { type: "string" } }, required: ["record"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: ingestToolOutputRecordInputSchema,
    handler: async (input, ctx) => {
      const parsed = ingestToolOutputRecordInputSchema.parse(input);
      const index = await readIndex(ctx.feedbackRoot, parsed.indexPath);
      const record = { ...parsed.record, createdAt: parsed.record.createdAt ?? new Date().toISOString() };
      const next = await writeIndex(ctx.feedbackRoot, parsed.indexPath, [record, ...index.records]);
      return { ok: true, summary: `Ingested tool output record ${record.id}.`, artifacts: [storagePath(ctx.feedbackRoot, parsed.indexPath)], structuredContent: { record, recordCount: next.records.length }, logs: [record.title], errors: [] };
    }
  },
  {
    definition: {
      name: "search_tool_outputs",
      description: "Search indexed prior tool outputs, reports, errors, screenshot metadata, issues, project notes, artifacts, and fix learnings.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, indexPath: { type: "string" }, kind: { type: "string" }, projectId: { type: "string" }, toolName: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: searchToolOutputsInputSchema,
    handler: async (input, ctx) => {
      const parsed = searchToolOutputsInputSchema.parse(input);
      const index = await readIndex(ctx.feedbackRoot, parsed.indexPath);
      const matches = searchRecords(index.records, parsed);
      return { ok: true, summary: `Found ${matches.length} matching tool output record(s).`, artifacts: [], structuredContent: { matches, totalRecords: index.records.length }, logs: matches.map((row) => `${row.score} ${row.record.kind}: ${row.record.title}`), errors: [] };
    }
  },
  {
    definition: {
      name: "find_similar_tool_errors",
      description: "Find prior tool errors or failed tool outputs similar to a new error message.",
      inputSchema: { type: "object", properties: { errorText: { type: "string" }, indexPath: { type: "string" }, limit: { type: "number" } }, required: ["errorText"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: findSimilarToolErrorsInputSchema,
    handler: async (input, ctx) => {
      const parsed = findSimilarToolErrorsInputSchema.parse(input);
      const index = await readIndex(ctx.feedbackRoot, parsed.indexPath);
      const matches = searchRecords(index.records.filter((record) => record.kind === "tool_error" || /fail|error|exception|timeout/i.test(record.text)), { query: parsed.errorText, limit: parsed.limit, indexPath: parsed.indexPath });
      return { ok: true, summary: `Found ${matches.length} similar error record(s).`, artifacts: [], structuredContent: { matches }, logs: matches.map((row) => `${row.score} ${row.record.title}`), errors: [] };
    }
  },
  {
    definition: {
      name: "summarize_tool_output_search_sources",
      description: "Summarize an existing tool output search index by source kind, project, tool name, and recency.",
      inputSchema: { type: "object", properties: { indexPath: { type: "string" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: summarizeToolOutputSearchSourcesInputSchema,
    handler: async (input, ctx) => {
      const parsed = summarizeToolOutputSearchSourcesInputSchema.parse(input);
      const index = await readIndex(ctx.feedbackRoot, parsed.indexPath);
      const summary = { totalRecords: index.records.length, byKind: summarizeKinds(index.records), byProject: summarizeField(index.records, "projectId"), byTool: summarizeField(index.records, "toolName"), updatedAt: index.updatedAt };
      return { ok: true, summary: `Tool output search index has ${summary.totalRecords} record(s).`, artifacts: [], structuredContent: summary, logs: [JSON.stringify(summary, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "export_tool_output_search_report",
      description: "Export a Markdown report for a tool output search query with scored matches and source metadata.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, indexPath: { type: "string" }, outputPath: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportToolOutputSearchReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportToolOutputSearchReportInputSchema.parse(input);
      const index = await readIndex(ctx.feedbackRoot, parsed.indexPath);
      const matches = searchRecords(index.records, { query: parsed.query, limit: parsed.limit, indexPath: parsed.indexPath });
      const markdown = [`# Tool Output Search Report`, "", `Query: ${parsed.query}`, "", "## Matches", ...(matches.length ? matches.map((row) => `- ${row.score} ${row.record.kind}: ${row.record.title}${row.record.sourcePath ? ` (${row.record.sourcePath})` : ""}\n  - ${row.snippet.replace(/\s+/g, " ").slice(0, 300)}`) : ["- No matches."]), ""].join("\n");
      const output = storagePath(ctx.feedbackRoot, parsed.outputPath);
      await mkdir(path.dirname(output), { recursive: true });
      await atomicWrite(output, markdown);
      return { ok: true, summary: `Exported tool output search report with ${matches.length} match(es).`, artifacts: [output], structuredContent: { path: output, matches, markdown }, logs: [markdown], errors: [] };
    }
  }
];

function summarizeKinds(records: IndexRecord[]): Record<string, number> {
  return summarizeField(records, "kind");
}

function summarizeField(records: IndexRecord[], field: "kind" | "projectId" | "toolName"): Record<string, number> {
  const output: Record<string, number> = {};
  for (const record of records) {
    const key = String(record[field] ?? "none");
    output[key] = (output[key] ?? 0) + 1;
  }
  return output;
}
