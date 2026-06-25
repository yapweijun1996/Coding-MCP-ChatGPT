import path from "node:path";
import { z } from "zod";
import { createArtifact, makeArtifactUrl } from "../../artifacts/store.js";
import { createShareArtifact } from "../../share/store.js";
import { assertSafePublicUrl } from "../../security/url.js";
import {
  appendProjectTaskHistory,
  createProject,
  deleteProject,
  deleteProjectFile,
  deleteProjectTask,
  forkProject,
  getProjectActivity,
  getProjectManifest,
  getProjectTask,
  getProjectTaskGraph,
  getProjectWithFiles,
  importProjectAssetFromLocalFile,
  isProjectTextFilePath,
  listProjectTasks,
  listProjects,
  patchProjectFile,
  publishProjectAndReport,
  publishProject,
  readProjectFile,
  recordProjectBrowserInspection,
  recordProjectTaskEvidence,
  searchProjectTasks,
  unpublishProject,
  upsertProjectTask,
  validateProject,
  writeProjectAsset,
  writeProjectFile
} from "../../projects/store.js";
import type { ProjectManifest, ProjectStatus, ProjectSummary, ProjectTaskEvidenceLink, ProjectTaskGraphNode, ProjectTaskHistoryItem, ProjectTaskItem, ProjectTaskPriority, ProjectTaskStatus, ReviewFinding } from "../../projects/store.js";
import { makeShareUrl } from "../result.js";
import type { ToolModule } from "../types.js";
import { inspectWebpageUrl, renderWebpageInspectionReport, summarizeBrowserInspection } from "./web-inspect.js";

const maxBase64AssetChars = 40 * 1024 * 1024;
const maxImportedImageBytes = 10 * 1024 * 1024;
const maxImportedPresentationBytes = 25 * 1024 * 1024;
const maxUrlRedirects = 5;

const createProjectInputSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().max(2000).optional().default(""),
  entryFile: z.string().min(1).max(240).optional().default("index.html")
});

const listProjectsInputSchema = z.object({
  includeDeleted: z.boolean().optional().default(false)
});

const searchProjectsGlobalInputSchema = z.object({
  query: z.string().max(500).optional().default(""),
  includeDeleted: z.boolean().optional().default(false),
  statuses: z.array(z.enum(["draft", "private", "published", "deleted"])).min(1).max(4).optional(),
  title: z.string().max(160).optional(),
  updatedSince: z.string().datetime().optional(),
  searchFiles: z.boolean().optional().default(true),
  searchHistory: z.boolean().optional().default(true),
  searchFeedback: z.boolean().optional().default(true),
  extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/i)).min(1).max(20).optional(),
  maxProjects: z.number().int().min(1).max(200).optional().default(50),
  maxResults: z.number().int().min(1).max(200).optional().default(50),
  maxFilesPerProject: z.number().int().min(1).max(50).optional().default(10),
  maxSnippetChars: z.number().int().min(80).max(2000).optional().default(500)
});

const projectIdInputSchema = z.object({
  projectId: z.string().min(8).max(80)
});

const writeProjectFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  content: z.string().max(1024 * 1024)
});

const writeProjectAssetInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  contentBase64: z.string().min(1).max(maxBase64AssetChars),
  contentType: z.string().min(1).max(120).optional()
});

const importProjectAssetFromLocalFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  sourcePath: z.string().min(1).max(2000),
  contentType: z.string().min(1).max(120).optional()
});

const importProjectAssetFromUrlInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  url: z.string().url()
});

const patchProjectFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  operations: z.array(z.object({
    find: z.string().min(1).max(20000),
    replace: z.string().max(20000),
    all: z.boolean().optional().default(false)
  })).min(1).max(40)
});

const forkProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160).optional(),
  summary: z.string().max(2000).optional()
});

const readProjectFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  maxBytes: z.number().int().min(1).max(1024 * 1024).optional().default(65536)
});

const deleteProjectFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  confirm: z.boolean().refine((value) => value === true, { message: "Deletion requires confirm=true." })
});

const publishProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  entryFile: z.string().min(1).max(240).optional()
});

const validateProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  entryFile: z.string().min(1).max(240).optional(),
  profile: z.literal("static_html").optional().default("static_html")
});

const auditProjectPwaInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  entryFile: z.string().min(1).max(240).optional()
});

const generateProjectTestPlanInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  entryFile: z.string().min(1).max(240).optional(),
  includePwaChecks: z.boolean().optional().default(true),
  includeArtifacts: z.boolean().optional().default(true),
  maxCases: z.number().int().min(5).max(80).optional().default(30)
});

const getProjectActivityInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  limit: z.number().int().min(1).max(100).optional().default(50)
});

const projectTaskStatusSchema = z.enum(["todo", "doing", "blocked", "done"]);
const projectTaskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

const listProjectTasksInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  status: projectTaskStatusSchema.optional(),
  priority: projectTaskPrioritySchema.optional(),
  sortBy: z.enum(["rank", "status", "updated"]).optional().default("rank")
});

const rankProjectTasksInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  includeDone: z.boolean().optional().default(false),
  maxResults: z.number().int().min(1).max(200).optional().default(50)
});

const projectTaskIdInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  taskId: z.string().regex(/^task_\d{3,}$/)
});

const searchProjectTasksInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  query: z.string().max(500).optional().default(""),
  status: projectTaskStatusSchema.optional(),
  priority: projectTaskPrioritySchema.optional(),
  maxResults: z.number().int().min(1).max(100).optional().default(50)
});

const getProjectTaskDependencyViewInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  includeDone: z.boolean().optional().default(true)
});

const getProjectTaskBoardInputSchema = z.object({
  projectId: z.string().min(8).max(80)
});

const pickNextProjectTaskInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  mode: z.enum(["resume_or_ready", "ready_only", "blocked_if_none"]).optional().default("resume_or_ready"),
  includeBlockedFallback: z.boolean().optional().default(true)
});

const executeProjectTaskQueueStepInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  taskId: z.string().regex(/^task_\d{3,}$/).optional(),
  action: z.enum(["claim_next", "complete_task"]).optional().default("claim_next"),
  validation: z.enum(["none", "static_project"]).optional().default("none"),
  entryFile: z.string().min(1).max(240).optional(),
  stopOnValidationFailure: z.boolean().optional().default(true),
  bindEvidence: z.boolean().optional().default(true),
  changedFiles: z.array(z.string().min(1).max(300)).max(100).optional().default([]),
  completionNote: z.string().max(1000).optional().default(""),
  completionSummary: z.string().max(2000).optional()
});

const summarizeProjectTaskCompletionInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  taskId: z.string().regex(/^task_\d{3,}$/),
  completionSummary: z.string().max(2000).optional(),
  changedFiles: z.array(z.string().min(1).max(300)).max(100).optional().default([]),
  includeLatestValidation: z.boolean().optional().default(true)
});

const getProjectResumeStateInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  historyLimit: z.number().int().min(1).max(50).optional().default(10)
});

const upsertProjectTaskInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  taskId: z.string().regex(/^task_\d{3,}$/).optional(),
  title: z.string().min(1).max(240),
  status: projectTaskStatusSchema.optional().default("todo"),
  priority: projectTaskPrioritySchema.optional().default("medium"),
  notes: z.string().max(4000).optional().default(""),
  progress: z.number().int().min(0).max(100).optional().default(0),
  blockedReason: z.string().max(1000).optional(),
  unblockRequirement: z.string().max(1000).optional(),
  completionSummary: z.string().max(2000).optional(),
  completedFiles: z.array(z.string().min(1).max(300)).max(100).optional(),
  dependsOn: z.array(z.string().regex(/^task_\d{3,}$/)).max(100).optional().default([]),
  evidence: z.array(z.object({
    label: z.string().min(1).max(160),
    kind: z.enum(["validation", "inspect_report", "screenshot", "published_url", "changed_file", "artifact", "note"]).optional(),
    url: z.string().url().optional(),
    artifact: z.string().min(1).max(300).optional(),
    filePath: z.string().min(1).max(300).optional(),
    note: z.string().max(1000).optional()
  })).max(50).optional().default([])
});

const setProjectTaskBlockerInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  taskId: z.string().regex(/^task_\d{3,}$/),
  blockedReason: z.string().max(1000).optional(),
  unblockRequirement: z.string().max(1000).optional(),
  clear: z.boolean().optional().default(false),
  statusWhenCleared: z.enum(["todo", "doing"]).optional().default("todo")
}).refine((value) => value.clear || Boolean(value.blockedReason?.trim() || value.unblockRequirement?.trim()), {
  message: "blockedReason or unblockRequirement is required unless clear=true.",
  path: ["blockedReason"]
});

const projectTaskEvidenceSchema = z.object({
  label: z.string().min(1).max(160),
  kind: z.enum(["validation", "inspect_report", "screenshot", "published_url", "changed_file", "artifact", "note"]).optional().default("artifact"),
  url: z.string().url().optional(),
  artifact: z.string().min(1).max(300).optional(),
  filePath: z.string().min(1).max(300).optional(),
  note: z.string().max(1000).optional()
}).refine((item) => Boolean(item.url || item.artifact || item.filePath || item.note), {
  message: "Evidence must include at least one of url, artifact, filePath, or note."
});

const recordProjectTaskEvidenceInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  taskId: z.string().regex(/^task_\d{3,}$/),
  evidence: z.array(projectTaskEvidenceSchema).min(1).max(50)
});

const bindProjectTaskEvidenceInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  taskId: z.string().regex(/^task_\d{3,}$/),
  includeLatestValidation: z.boolean().optional().default(true),
  includeBrowserReport: z.boolean().optional().default(true),
  includeScreenshots: z.boolean().optional().default(true),
  includePublishedUrl: z.boolean().optional().default(true),
  includeRecentHistory: z.boolean().optional().default(true),
  historyLimit: z.number().int().min(1).max(50).optional().default(20),
  changedFiles: z.array(z.string().min(1).max(300)).max(100).optional().default([]),
  reports: z.array(z.object({
    label: z.string().min(1).max(160),
    url: z.string().url()
  })).max(20).optional().default([]),
  screenshots: z.array(z.object({
    label: z.string().min(1).max(160),
    url: z.string().url()
  })).max(20).optional().default([]),
  artifacts: z.array(z.object({
    label: z.string().min(1).max(160),
    artifact: z.string().min(1).max(300),
    kind: z.enum(["validation", "inspect_report", "screenshot", "published_url", "changed_file", "artifact", "note"]).optional().default("artifact")
  })).max(20).optional().default([])
});

const screenshotProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  entryFile: z.string().min(1).max(240).optional(),
  viewports: z.array(z.enum(["desktop", "tablet", "mobile"])).min(1).max(3).optional().default(["desktop", "tablet", "mobile"]),
  fullPage: z.boolean().optional().default(false),
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000)
});

const runProjectFixLoopInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  entryFile: z.string().min(1).max(240).optional(),
  maxIterations: z.number().int().min(1).max(5).optional().default(3),
  browserValidation: z.boolean().optional().default(true),
  stopOnFirstPassing: z.boolean().optional().default(true),
  fixes: z.array(z.object({
    relativePath: z.string().min(1).max(240),
    operations: z.array(z.object({
      find: z.string().min(1).max(20000),
      replace: z.string().max(20000),
      all: z.boolean().optional().default(false)
    })).min(1).max(40)
  })).max(5).optional().default([])
});

const deliverStaticProjectInputSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().max(2000).optional().default(""),
  entryFile: z.string().min(1).max(240).optional().default("index.html"),
  profile: z.literal("static_html").optional().default("static_html"),
  browserValidation: z.boolean().optional().default(true),
  files: z.array(z.object({
    path: z.string().min(1).max(240),
    content: z.string().max(1024 * 1024)
  })).min(1).max(40)
});

const deleteProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  confirm: z.boolean().refine((value) => value === true, { message: "Deletion requires confirm=true." })
});

function decodePureBase64(value: string): Buffer {
  if (/^data:/i.test(value.trim())) {
    throw new Error("contentBase64 must be raw base64 without a data: URL prefix.");
  }
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error("contentBase64 is not valid base64.");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) throw new Error("contentBase64 decoded to an empty asset.");
  const canonical = buffer.toString("base64").replace(/=+$/, "");
  const supplied = normalized.replace(/=+$/, "");
  if (canonical !== supplied) throw new Error("contentBase64 is not valid base64.");
  return buffer;
}

function maxBytesForAssetPath(relativePath: string): number {
  return path.extname(relativePath).toLowerCase() === ".pptx" ? maxImportedPresentationBytes : maxImportedImageBytes;
}

type GlobalProjectSearchOptions = z.infer<typeof searchProjectsGlobalInputSchema>;

type GlobalProjectSearchMatch = {
  projectId: string;
  projectTitle: string;
  projectStatus: ProjectStatus;
  projectUpdatedAt: string;
  publishedUrl?: string;
  source: "metadata" | "file" | "history" | "feedback";
  path?: string;
  historyId?: string;
  findingId?: string;
  title?: string;
  snippet: string;
  reuse?: Record<string, unknown>;
};

function normalizeSearchText(value: string): string {
  return value.toLowerCase();
}

function tokenizeSearchQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function matchesQuery(value: string, query: string, tokens: string[]): boolean {
  if (!query.trim()) return true;
  const normalized = normalizeSearchText(value);
  const exact = normalizeSearchText(query.trim());
  return normalized.includes(exact) || tokens.every((token) => normalized.includes(token));
}

function makeSnippet(value: string, query: string, tokens: string[], maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  const normalized = normalizeSearchText(compact);
  const candidates = [query.trim().toLowerCase(), ...tokens].filter(Boolean);
  const index = candidates.reduce((best, candidate) => {
    const found = normalized.indexOf(candidate);
    if (found === -1) return best;
    return best === -1 ? found : Math.min(best, found);
  }, -1);
  const start = index === -1 ? 0 : Math.max(0, index - Math.floor(maxChars / 3));
  const end = Math.min(compact.length, start + maxChars);
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}

function projectMatchesFilters(project: ProjectSummary, options: GlobalProjectSearchOptions): boolean {
  if (options.statuses && !options.statuses.includes(project.status)) return false;
  if (options.title && !project.title.toLowerCase().includes(options.title.toLowerCase())) return false;
  if (options.updatedSince && project.updatedAt < options.updatedSince) return false;
  return true;
}

function metadataSearchText(project: ProjectSummary): string {
  return [
    project.id,
    project.title,
    project.summary,
    project.status,
    project.entryFile,
    project.publishedUrl,
    project.createdAt,
    project.updatedAt,
    project.createdByClientId
  ].filter(Boolean).join("\n");
}

function historySearchText(item: ProjectTaskHistoryItem): string {
  return JSON.stringify({
    id: item.id,
    time: item.time,
    toolName: item.toolName,
    ok: item.ok,
    summary: item.summary,
    details: item.details
  });
}

function feedbackSearchText(finding: ReviewFinding): string {
  return JSON.stringify(finding);
}

function taskPriorityWeight(priority: ProjectTaskPriority): number {
  return { urgent: 0, high: 1, medium: 2, low: 3 }[priority];
}

function taskDependencyState(task: ProjectTaskGraphNode): "doing" | "ready" | "blocked" | "done" {
  if (task.status === "done") return "done";
  if (task.blocked) return "blocked";
  if (task.status === "doing") return "doing";
  return "ready";
}

function taskDependencyWeight(task: ProjectTaskGraphNode): number {
  return { doing: 0, ready: 1, blocked: 2, done: 3 }[taskDependencyState(task)];
}

function taskRiskScore(task: ProjectTaskGraphNode): number {
  const text = `${task.title}\n${task.notes}`.toLowerCase();
  const riskTerms = [
    "security", "auth", "permission", "payment", "billing", "data", "migration", "deploy",
    "release", "production", "rollback", "regression", "error", "failure", "blocked", "risk",
    "breaking", "critical", "outage", "privacy", "compliance"
  ];
  const keywordScore = riskTerms.reduce((score, term) => score + (text.includes(term) ? 8 : 0), 0);
  const dependencyImpact = Math.min(task.dependents.length * 6, 30);
  const blockedRisk = task.blocked ? 12 : 0;
  const staleProgressRisk = task.status === "doing" && task.progress < 50 ? 6 : 0;
  const missingEvidenceRisk = task.status !== "done" && task.evidence.length === 0 ? 4 : 0;
  return Math.min(100, keywordScore + dependencyImpact + blockedRisk + staleProgressRisk + missingEvidenceRisk);
}

function rankedTaskSummary(task: ProjectTaskGraphNode, rank: number, byId: Map<string, ProjectTaskGraphNode>) {
  const dependencyState = taskDependencyState(task);
  const priorityWeight = taskPriorityWeight(task.priority);
  const riskScore = taskRiskScore(task);
  return {
    rank,
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    progress: task.progress,
    dependencyState,
    priorityWeight,
    riskScore,
    blockedBy: task.blockedBy.map((id) => taskLabel(byId.get(id) ?? { id, title: "unknown" })),
    blockedReason: task.blockedReason,
    unblockRequirement: task.unblockRequirement,
    blockedAt: task.blockedAt,
    blockedReasons: task.blockedReasons,
    completionSummary: task.completionSummary,
    completedFiles: task.completedFiles ?? [],
    completionValidation: task.completionValidation,
    completedAt: task.completedAt,
    dependents: task.dependents,
    evidenceCount: task.evidence.length,
    updatedAt: task.updatedAt,
    sortReasons: [
      `dependency=${dependencyState}`,
      `priority=${task.priority}`,
      `risk=${riskScore}`,
      task.dependents.length ? `unblocks=${task.dependents.length}` : "unblocks=0"
    ]
  };
}

function sortRankedProjectTasks<T extends ProjectTaskGraphNode>(tasks: T[]): T[] {
  return tasks.slice().sort((left, right) => {
    return taskDependencyWeight(left) - taskDependencyWeight(right)
      || taskPriorityWeight(left.priority) - taskPriorityWeight(right.priority)
      || taskRiskScore(right) - taskRiskScore(left)
      || right.dependents.length - left.dependents.length
      || left.progress - right.progress
      || right.updatedAt.localeCompare(left.updatedAt);
  });
}

function validationSnapshot(validation: Awaited<ReturnType<typeof validateProject>> | undefined): ProjectTaskItem["completionValidation"] | undefined {
  if (!validation) return undefined;
  return {
    ok: validation.ok,
    status: validation.status,
    checkedAt: validation.checkedAt,
    entryFile: validation.entryFile,
    errors: validation.errors,
    warnings: validation.warnings
  };
}

function buildCompletionSummary(input: {
  task: { title: string; notes: string };
  completionSummary?: string;
  completionNote?: string;
  changedFiles: string[];
  validation?: Awaited<ReturnType<typeof validateProject>>;
}): string {
  if (input.completionSummary?.trim()) return input.completionSummary.trim();
  const parts = [`Completed ${input.task.title}.`];
  const completionNote = input.completionNote?.trim();
  if (completionNote) parts.push(completionNote);
  if (input.changedFiles.length) parts.push(`Changed files: ${input.changedFiles.join(", ")}.`);
  if (input.validation) {
    parts.push(`Validation ${input.validation.ok ? "passed" : "failed"} (${input.validation.status}) for ${input.validation.entryFile}: ${input.validation.errors.length} error(s), ${input.validation.warnings.length} warning(s).`);
  }
  return parts.join(" ");
}

function sortResumeCandidates<T extends { priority: ProjectTaskPriority; updatedAt: string; progress: number }>(tasks: T[]): T[] {
  return tasks.slice().sort((left, right) => {
    return taskPriorityWeight(left.priority) - taskPriorityWeight(right.priority)
      || right.updatedAt.localeCompare(left.updatedAt)
      || right.progress - left.progress;
  });
}

function sortBlockedFallback<T extends { status: ProjectTaskStatus; priority: ProjectTaskPriority; updatedAt: string; progress: number }>(tasks: T[]): T[] {
  return tasks.slice().sort((left, right) => {
    const leftExplicit = left.status === "blocked" ? 0 : 1;
    const rightExplicit = right.status === "blocked" ? 0 : 1;
    return leftExplicit - rightExplicit
      || taskPriorityWeight(left.priority) - taskPriorityWeight(right.priority)
      || right.updatedAt.localeCompare(left.updatedAt)
      || right.progress - left.progress;
  });
}

function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 100);
}

function averageProgress(tasks: Array<{ progress: number }>): number {
  if (tasks.length === 0) return 0;
  return Math.round(tasks.reduce((sum, task) => sum + task.progress, 0) / tasks.length);
}

function taskPickerScore(task: { status: ProjectTaskStatus; priority: ProjectTaskPriority; progress: number; updatedAt: string }, nowMs: number): number {
  const statusScore = task.status === "doing" ? 0 : task.status === "todo" ? 100 : task.status === "blocked" ? 200 : 300;
  const priorityScore = taskPriorityWeight(task.priority) * 10;
  const progressScore = Math.max(0, 100 - task.progress) / 100;
  const ageHours = Math.max(0, Math.floor((nowMs - Date.parse(task.updatedAt)) / 3600000));
  return Math.round((statusScore + priorityScore + progressScore - Math.min(ageHours, 24) / 100) * 100) / 100;
}

function taskLabel(task: { id: string; title: string }): string {
  return `${task.id}: ${task.title}`;
}

function renderTaskMermaid(graph: Awaited<ReturnType<typeof getProjectTaskGraph>>): string {
  const lines = ["graph TD"];
  for (const node of graph.nodes) {
    const safeTitle = node.title.replace(/["<>]/g, "");
    lines.push(`  ${node.id}["${node.id}<br/>${safeTitle}"]`);
  }
  for (const edge of graph.edges) lines.push(`  ${edge.from} --> ${edge.to}`);
  if (lines.length === 1) lines.push("  empty[\"No tasks\"]");
  return lines.join("\n");
}

function dependencyChainFor(taskId: string, byId: Map<string, { id: string; title: string; dependsOn: string[] }>, seen = new Set<string>()): string[] {
  if (seen.has(taskId)) return [taskId];
  seen.add(taskId);
  const task = byId.get(taskId);
  if (!task || task.dependsOn.length === 0) return [taskId];
  const longest = task.dependsOn
    .map((dependency) => dependencyChainFor(dependency, byId, new Set(seen)))
    .sort((left, right) => right.length - left.length)[0] ?? [];
  return [...longest, taskId];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function collectUrlsFromDetails(value: unknown, keys: Set<string>, urls: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectUrlsFromDetails(item, keys, urls);
    return urls;
  }
  if (!isRecord(value)) return urls;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === "string" && /^https?:\/\//i.test(child)) urls.push(child);
    else collectUrlsFromDetails(child, keys, urls);
  }
  return urls;
}

function dedupeTaskEvidence(evidence: ProjectTaskEvidenceLink[]): ProjectTaskEvidenceLink[] {
  const seen = new Set<string>();
  const deduped: ProjectTaskEvidenceLink[] = [];
  for (const item of evidence) {
    const key = [item.kind ?? "artifact", item.label, item.url ?? "", item.artifact ?? "", item.filePath ?? "", item.note ?? ""].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

async function searchProjectsGlobal(ctxProjectRoot: string, options: GlobalProjectSearchOptions): Promise<{
  projectsScanned: number;
  matches: GlobalProjectSearchMatch[];
  truncated: boolean;
}> {
  const query = options.query.trim();
  const tokens = tokenizeSearchQuery(query);
  const extensionFilter = options.extensions ? new Set(options.extensions.map((extension) => extension.toLowerCase())) : undefined;
  const projects = (await listProjects(ctxProjectRoot, options.includeDeleted))
    .filter((project) => projectMatchesFilters(project, options))
    .slice(0, options.maxProjects);
  const matches: GlobalProjectSearchMatch[] = [];
  let truncated = false;

  const pushMatch = (match: GlobalProjectSearchMatch): boolean => {
    if (matches.length >= options.maxResults) {
      truncated = true;
      return false;
    }
    matches.push(match);
    return true;
  };

  for (const project of projects) {
    if (matches.length >= options.maxResults) {
      truncated = true;
      break;
    }

    const metadataText = metadataSearchText(project);
    if (matchesQuery(metadataText, query, tokens)) {
      if (!pushMatch({
        projectId: project.id,
        projectTitle: project.title,
        projectStatus: project.status,
        projectUpdatedAt: project.updatedAt,
        publishedUrl: project.publishedUrl,
        source: "metadata",
        title: project.title,
        snippet: makeSnippet(metadataText, query, tokens, options.maxSnippetChars),
        reuse: {
          tool: "get_project_manifest",
          arguments: { projectId: project.id }
        }
      })) break;
    }

    let manifest: ProjectManifest | undefined;
    if (options.searchFiles || options.searchHistory || options.searchFeedback) {
      manifest = await getProjectManifest(ctxProjectRoot, project.id);
    }

    if (manifest && options.searchFiles) {
      let filesRead = 0;
      for (const file of manifest.files) {
        if (filesRead >= options.maxFilesPerProject) break;
        if (!isProjectTextFilePath(file.path)) continue;
        if (extensionFilter && !extensionFilter.has(path.extname(file.path).toLowerCase())) continue;
        filesRead += 1;
        let content: string;
        try {
          content = await readProjectFile(ctxProjectRoot, project.id, file.path, 256 * 1024);
        } catch {
          continue;
        }
        const haystack = `${file.path}\n${content}`;
        if (!matchesQuery(haystack, query, tokens)) continue;
        if (!pushMatch({
          projectId: project.id,
          projectTitle: project.title,
          projectStatus: project.status,
          projectUpdatedAt: project.updatedAt,
          publishedUrl: project.publishedUrl,
          source: "file",
          path: file.path,
          snippet: makeSnippet(haystack, query, tokens, options.maxSnippetChars),
          reuse: {
            tool: "read_project_file",
            arguments: { projectId: project.id, relativePath: file.path, maxBytes: Math.min(file.size, 65536) }
          }
        })) break;
      }
    }

    if (manifest && options.searchHistory) {
      for (const item of manifest.taskHistory.slice().reverse()) {
        const haystack = historySearchText(item);
        if (!matchesQuery(haystack, query, tokens)) continue;
        if (!pushMatch({
          projectId: project.id,
          projectTitle: project.title,
          projectStatus: project.status,
          projectUpdatedAt: project.updatedAt,
          publishedUrl: project.publishedUrl,
          source: "history",
          historyId: item.id,
          title: item.toolName,
          snippet: makeSnippet(haystack, query, tokens, options.maxSnippetChars),
          reuse: {
            tool: "get_project_activity",
            arguments: { projectId: project.id, limit: 100 }
          }
        })) break;
      }
    }

    if (manifest && options.searchFeedback) {
      for (const finding of (manifest.metadata.reviewFeedback ?? []).slice().reverse()) {
        const haystack = feedbackSearchText(finding);
        if (!matchesQuery(haystack, query, tokens)) continue;
        if (!pushMatch({
          projectId: project.id,
          projectTitle: project.title,
          projectStatus: project.status,
          projectUpdatedAt: project.updatedAt,
          publishedUrl: project.publishedUrl,
          source: "feedback",
          findingId: finding.id,
          title: finding.title,
          snippet: makeSnippet(haystack, query, tokens, options.maxSnippetChars),
          reuse: {
            tool: "get_review_feedback",
            arguments: { projectId: project.id }
          }
        })) break;
      }
    }
  }

  return { projectsScanned: projects.length, matches, truncated };
}

function resolveLocalSourcePath(workspaceRoot: string, sourcePath: string): string {
  const resolved = path.isAbsolute(sourcePath) ? path.resolve(sourcePath) : path.resolve(workspaceRoot, sourcePath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Source path must be inside the workspace directory.");
  }
  return resolved;
}

async function fetchProjectAsset(url: string, relativePath: string): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
  let currentUrl = new URL(url);
  const maxBytes = maxBytesForAssetPath(relativePath);

  for (let redirectCount = 0; redirectCount <= maxUrlRedirects; redirectCount += 1) {
    await assertSafePublicUrl(currentUrl);
    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: { "User-Agent": "Coding-MCP-AssetImport/0.1" }
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Asset import redirect is missing a Location header.");
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok) throw new Error(`Asset import failed with ${response.status} ${response.statusText}.`);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!contentType) throw new Error("Asset import response is missing a content-type header.");
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) throw new Error("Asset import response exceeds the size limit.");

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error("Asset import response exceeds the size limit.");
    return { buffer, contentType, finalUrl: currentUrl.toString() };
  }

  throw new Error("Asset import exceeded the redirect limit.");
}

function withoutScreenshots(results: Awaited<ReturnType<typeof inspectWebpageUrl>>) {
  return results.map(({ screenshotDataUrl, ...result }) => result);
}

function bufferFromDataUrl(dataUrl: string): { contentType: string; buffer: Buffer } {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) throw new Error("Screenshot data URL is not valid base64.");
  return { contentType: match[1], buffer: Buffer.from(match[2], "base64") };
}

type PwaAuditSeverity = "pass" | "warn" | "error";

type PwaAuditFinding = {
  id: string;
  severity: PwaAuditSeverity;
  category: "manifest" | "service_worker" | "offline" | "icons" | "ios" | "android" | "safe_area" | "installability" | "ui";
  message: string;
  evidence?: string;
  suggestion?: string;
};

function htmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([a-zA-Z0-9:_-]+)\s*=\s*["']([^"']*)["']/g)) {
    attrs[match[1].toLowerCase()] = match[2];
  }
  return attrs;
}

function findLinkTags(html: string, rel: string): Array<Record<string, string>> {
  return [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((match) => htmlAttributes(match[0]))
    .filter((attrs) => (attrs.rel ?? "").toLowerCase().split(/\s+/).includes(rel.toLowerCase()));
}

function findMeta(html: string, key: "name" | "property", value: string): Record<string, string> | undefined {
  return [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map((match) => htmlAttributes(match[0]))
    .find((attrs) => (attrs[key] ?? "").toLowerCase() === value.toLowerCase());
}

function normalizeProjectReference(reference: string | undefined): string | undefined {
  if (!reference || /^https?:\/\//i.test(reference) || reference.startsWith("data:")) return reference;
  return reference.replace(/^\.\//, "").replace(/^\//, "");
}

function hasProjectFile(files: Array<{ path: string }>, candidate: string | undefined): boolean {
  const normalized = normalizeProjectReference(candidate);
  if (!normalized || /^https?:\/\//i.test(normalized) || normalized.startsWith("data:")) return false;
  return files.some((file) => file.path === normalized);
}

function addFinding(findings: PwaAuditFinding[], finding: PwaAuditFinding): void {
  findings.push(finding);
}

async function auditProjectPwa(ctx: Parameters<ToolModule["handler"]>[1], projectId: string, entryFile?: string): Promise<Record<string, unknown> & { ok: boolean; errors: string[] }> {
  const project = await getProjectWithFiles(ctx.projectRoot, projectId);
  const selectedEntry = entryFile ?? project.metadata.entryFile;
  const html = await readProjectFile(ctx.projectRoot, projectId, selectedEntry, 1024 * 1024);
  const files = project.files;
  const findings: PwaAuditFinding[] = [];

  const manifestLink = findLinkTags(html, "manifest")[0];
  const manifestPath = normalizeProjectReference(manifestLink?.href);
  let manifest: Record<string, unknown> | undefined;
  if (!manifestPath) {
    addFinding(findings, { id: "manifest-link", severity: "error", category: "manifest", message: "Entry file does not link to a web app manifest.", suggestion: "Add <link rel=\"manifest\" href=\"manifest.json\">." });
  } else if (!hasProjectFile(files, manifestPath)) {
    addFinding(findings, { id: "manifest-file", severity: "error", category: "manifest", message: `Manifest file ${manifestPath} is not present in the project.`, suggestion: "Write the referenced manifest file into the project." });
  } else {
    try {
      manifest = JSON.parse(await readProjectFile(ctx.projectRoot, projectId, manifestPath, 1024 * 1024)) as Record<string, unknown>;
      addFinding(findings, { id: "manifest-file", severity: "pass", category: "manifest", message: `Manifest file ${manifestPath} is present and valid JSON.` });
    } catch (error) {
      addFinding(findings, { id: "manifest-json", severity: "error", category: "manifest", message: `Manifest file ${manifestPath} is not valid JSON.`, evidence: error instanceof Error ? error.message : undefined });
    }
  }

  if (manifest) {
    for (const field of ["name", "short_name", "start_url", "display", "theme_color"] as const) {
      addFinding(findings, {
        id: `manifest-${field}`,
        severity: typeof manifest[field] === "string" && String(manifest[field]).trim() ? "pass" : field === "short_name" ? "warn" : "error",
        category: field === "theme_color" || field === "display" ? "installability" : "manifest",
        message: typeof manifest[field] === "string" && String(manifest[field]).trim() ? `Manifest defines ${field}.` : `Manifest is missing ${field}.`,
        suggestion: typeof manifest[field] === "string" && String(manifest[field]).trim() ? undefined : `Add ${field} to the manifest.`
      });
    }
    const display = String(manifest.display ?? "");
    if (display && !["standalone", "fullscreen", "minimal-ui"].includes(display)) {
      addFinding(findings, { id: "manifest-display-installable", severity: "warn", category: "installability", message: `Manifest display is ${display}, which may not produce an app-like installed experience.`, suggestion: "Use standalone, fullscreen, or minimal-ui for installable app demos." });
    }
    const icons = Array.isArray(manifest.icons) ? manifest.icons as Array<Record<string, unknown>> : [];
    if (icons.length === 0) {
      addFinding(findings, { id: "manifest-icons", severity: "error", category: "icons", message: "Manifest does not define icons.", suggestion: "Add 192x192 and 512x512 PNG/WebP/SVG icons." });
    } else {
      const iconRows = icons.map((icon) => ({ src: String(icon.src ?? ""), sizes: String(icon.sizes ?? ""), type: String(icon.type ?? "") }));
      const missing = iconRows.filter((icon) => !hasProjectFile(files, icon.src) && !/^https?:\/\//i.test(icon.src) && !icon.src.startsWith("data:"));
      addFinding(findings, { id: "manifest-icons", severity: "pass", category: "icons", message: `Manifest defines ${icons.length} icon(s).`, evidence: JSON.stringify(iconRows.slice(0, 8)) });
      if (missing.length > 0) addFinding(findings, { id: "manifest-icon-files", severity: "error", category: "icons", message: `${missing.length} manifest icon file(s) are missing from the project.`, evidence: missing.map((icon) => icon.src).join(", ") });
      const sizes = iconRows.map((icon) => icon.sizes);
      if (!sizes.some((size) => /\b192x192\b/.test(size))) addFinding(findings, { id: "icon-192", severity: "warn", category: "icons", message: "Manifest does not advertise a 192x192 icon.", suggestion: "Add a 192x192 icon for Android install surfaces." });
      if (!sizes.some((size) => /\b512x512\b/.test(size))) addFinding(findings, { id: "icon-512", severity: "warn", category: "icons", message: "Manifest does not advertise a 512x512 icon.", suggestion: "Add a 512x512 icon for store-quality install surfaces." });
    }
  }

  const viewport = findMeta(html, "name", "viewport")?.content ?? "";
  addFinding(findings, {
    id: "viewport-meta",
    severity: /width\s*=\s*device-width/i.test(viewport) ? "pass" : "error",
    category: "safe_area",
    message: /width\s*=\s*device-width/i.test(viewport) ? "Viewport meta uses device-width." : "Viewport meta is missing width=device-width.",
    evidence: viewport || undefined
  });
  addFinding(findings, {
    id: "viewport-fit-cover",
    severity: /viewport-fit\s*=\s*cover/i.test(viewport) ? "pass" : "warn",
    category: "safe_area",
    message: /viewport-fit\s*=\s*cover/i.test(viewport) ? "Viewport meta includes viewport-fit=cover for iOS safe areas." : "Viewport meta does not include viewport-fit=cover.",
    suggestion: "Add viewport-fit=cover when using full-screen/mobile PWA layouts."
  });

  const projectText = [html];
  for (const file of files.filter((item) => /\.(css|js|mjs|html)$/i.test(item.path)).slice(0, 80)) {
    if (file.path === selectedEntry) continue;
    try {
      projectText.push(await readProjectFile(ctx.projectRoot, projectId, file.path, 1024 * 1024));
    } catch {
      // Binary or oversized files are irrelevant to the textual PWA checks.
    }
  }
  const allText = projectText.join("\n");
  addFinding(findings, {
    id: "safe-area-css",
    severity: /safe-area-inset-|env\(\s*safe-area-inset-/i.test(allText) ? "pass" : "warn",
    category: "safe_area",
    message: /safe-area-inset-|env\(\s*safe-area-inset-/i.test(allText) ? "Project references safe-area inset CSS." : "No safe-area inset CSS was found.",
    suggestion: "Use env(safe-area-inset-*) for fixed headers/footers and full-screen mobile layouts."
  });

  const appleCapable = findMeta(html, "name", "apple-mobile-web-app-capable")?.content;
  addFinding(findings, {
    id: "ios-web-app-capable",
    severity: appleCapable?.toLowerCase() === "yes" ? "pass" : "warn",
    category: "ios",
    message: appleCapable?.toLowerCase() === "yes" ? "iOS web app capable meta is present." : "iOS web app capable meta is missing.",
    suggestion: "Add <meta name=\"apple-mobile-web-app-capable\" content=\"yes\"> for iOS PWA demos."
  });
  addFinding(findings, {
    id: "ios-status-bar",
    severity: findMeta(html, "name", "apple-mobile-web-app-status-bar-style") ? "pass" : "warn",
    category: "ios",
    message: findMeta(html, "name", "apple-mobile-web-app-status-bar-style") ? "iOS status bar style meta is present." : "iOS status bar style meta is missing."
  });
  const appleIcon = findLinkTags(html, "apple-touch-icon")[0];
  addFinding(findings, {
    id: "ios-touch-icon",
    severity: appleIcon && hasProjectFile(files, appleIcon.href) ? "pass" : "warn",
    category: "ios",
    message: appleIcon ? `Apple touch icon ${appleIcon.href} ${hasProjectFile(files, appleIcon.href) ? "exists" : "is not present locally"}.` : "Apple touch icon link is missing.",
    suggestion: "Add <link rel=\"apple-touch-icon\" href=\"icons/icon-192.png\">."
  });

  const swMatch = /navigator\.serviceWorker\.register\s*\(\s*["'`]([^"'`]+)["'`]/.exec(allText);
  const swPath = normalizeProjectReference(swMatch?.[1]);
  if (!swPath) {
    addFinding(findings, { id: "service-worker-register", severity: "error", category: "service_worker", message: "No navigator.serviceWorker.register(...) call was found.", suggestion: "Register a project-local service worker from the entry script." });
  } else if (!hasProjectFile(files, swPath)) {
    addFinding(findings, { id: "service-worker-file", severity: "error", category: "service_worker", message: `Registered service worker ${swPath} is not present in the project.` });
  } else {
    const sw = await readProjectFile(ctx.projectRoot, projectId, swPath, 1024 * 1024);
    addFinding(findings, { id: "service-worker-file", severity: "pass", category: "service_worker", message: `Service worker ${swPath} is registered and present.` });
    addFinding(findings, {
      id: "service-worker-cache",
      severity: /caches\.(open|match|keys)|cache\.addAll|fetch\s*\(/i.test(sw) ? "pass" : "warn",
      category: "service_worker",
      message: /caches\.(open|match|keys)|cache\.addAll|fetch\s*\(/i.test(sw) ? "Service worker includes cache/fetch logic." : "Service worker does not appear to implement cache/fetch handling."
    });
    addFinding(findings, {
      id: "service-worker-update",
      severity: /skipWaiting|clients\.claim|updatefound|controllerchange/i.test(`${sw}\n${allText}`) ? "pass" : "warn",
      category: "service_worker",
      message: /skipWaiting|clients\.claim|updatefound|controllerchange/i.test(`${sw}\n${allText}`) ? "Project includes service worker update activation signals." : "No service worker update activation signal was found.",
      suggestion: "Use skipWaiting/clients.claim or UI around updatefound/controllerchange for update handling."
    });
  }

  const hasOfflineFile = files.some((file) => /(^|\/)offline\.html$/i.test(file.path));
  addFinding(findings, {
    id: "offline-page",
    severity: hasOfflineFile ? "pass" : "warn",
    category: "offline",
    message: hasOfflineFile ? "Project includes offline.html." : "Project does not include offline.html.",
    suggestion: "Add an offline.html fallback page and cache it in the service worker."
  });
  addFinding(findings, {
    id: "offline-ui",
    severity: /\boffline\b|connection lost|reconnect|no network/i.test(allText) ? "pass" : "warn",
    category: "ui",
    message: /\boffline\b|connection lost|reconnect|no network/i.test(allText) ? "Project includes offline/reconnect UI copy or code." : "No offline/reconnect UI signal was found."
  });
  addFinding(findings, {
    id: "install-update-ui",
    severity: /beforeinstallprompt|appinstalled|install app|update available|new version/i.test(allText) ? "pass" : "warn",
    category: "ui",
    message: /beforeinstallprompt|appinstalled|install app|update available|new version/i.test(allText) ? "Project includes install/update UI signals." : "No install/update UI signal was found."
  });

  const errors = findings.filter((finding) => finding.severity === "error").map((finding) => `${finding.id}: ${finding.message}`);
  const warnings = findings.filter((finding) => finding.severity === "warn").map((finding) => `${finding.id}: ${finding.message}`);
  return {
    ok: errors.length === 0,
    projectId,
    entryFile: selectedEntry,
    checkedAt: new Date().toISOString(),
    summary: {
      passed: findings.filter((finding) => finding.severity === "pass").length,
      warnings: warnings.length,
      errors: errors.length
    },
    errors,
    warnings,
    findings
  };
}

type GeneratedTestCase = {
  id: string;
  kind: "smoke" | "interaction" | "responsive" | "accessibility" | "regression" | "pwa" | "content";
  title: string;
  target: string;
  selector?: string;
  tool: string;
  arguments: Record<string, unknown>;
  expected: string;
  source?: string;
};

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function selectorFromTag(tag: string, fallback: string): string {
  const attrs = htmlAttributes(tag);
  if (attrs.id) return `${fallback}#${attrs.id}`;
  if (attrs.name) return `${fallback}[name="${attrs.name}"]`;
  if (attrs["aria-label"]) return `${fallback}[aria-label="${attrs["aria-label"]}"]`;
  const className = attrs.class?.trim().split(/\s+/)[0];
  if (className) return `${fallback}.${className}`;
  return fallback;
}

function renderTestPlanMarkdown(plan: Record<string, unknown>): string {
  const cases = plan.testCases as GeneratedTestCase[];
  const staticChecks = plan.staticChecks as Record<string, unknown>;
  const lines = [
    `# Project Test Plan`,
    "",
    `Project: ${String(plan.projectId)}`,
    `Entry file: ${String(plan.entryFile)}`,
    `Generated at: ${String(plan.generatedAt)}`,
    "",
    "## Static Checks",
    "",
    `- validation: ${JSON.stringify(staticChecks.validation)}`,
    `- pwa: ${JSON.stringify(staticChecks.pwa)}`,
    "",
    "## Test Cases",
    ""
  ];
  for (const testCase of cases) {
    lines.push(`### ${testCase.id}: ${testCase.title}`);
    lines.push("");
    lines.push(`- kind: ${testCase.kind}`);
    lines.push(`- target: ${testCase.target}`);
    if (testCase.selector) lines.push(`- selector: \`${testCase.selector}\``);
    lines.push(`- tool: \`${testCase.tool}\``);
    lines.push(`- expected: ${testCase.expected}`);
    lines.push(`- arguments:`);
    lines.push("```json");
    lines.push(JSON.stringify(testCase.arguments, null, 2));
    lines.push("```");
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function generateProjectTestPlan(ctx: Parameters<ToolModule["handler"]>[1], input: z.infer<typeof generateProjectTestPlanInputSchema>): Promise<Record<string, unknown>> {
  const project = await getProjectWithFiles(ctx.projectRoot, input.projectId);
  const entryFile = input.entryFile ?? project.metadata.entryFile;
  const html = await readProjectFile(ctx.projectRoot, input.projectId, entryFile, 1024 * 1024);
  const publishedUrl = project.metadata.publishedUrl ?? `[publish ${entryFile} first]`;
  const cases: GeneratedTestCase[] = [];
  const pushCase = (testCase: GeneratedTestCase) => {
    if (cases.length < input.maxCases && !cases.some((existing) => existing.id === testCase.id)) cases.push(testCase);
  };

  pushCase({
    id: "static-validate",
    kind: "smoke",
    title: "Validate static project structure and references",
    target: entryFile,
    tool: "validate_project",
    arguments: { projectId: input.projectId, entryFile },
    expected: "Project validation returns ok=true with no blocking errors.",
    source: "project"
  });
  pushCase({
    id: "responsive-browser-smoke",
    kind: "responsive",
    title: "Inspect desktop, tablet, and mobile layouts",
    target: publishedUrl,
    tool: "inspect_webpage_plus",
    arguments: { url: publishedUrl, viewports: ["desktop", "tablet", "mobile"], screenshot: true, captureNetwork: true },
    expected: "No console errors, page errors, failed critical assets, or horizontal overflow.",
    source: "browser"
  });
  pushCase({
    id: "accessibility-audit",
    kind: "accessibility",
    title: "Run axe accessibility audit",
    target: publishedUrl,
    tool: "audit_accessibility",
    arguments: { url: publishedUrl, viewports: ["desktop", "mobile"] },
    expected: "No serious or critical accessibility violations remain.",
    source: "browser"
  });
  pushCase({
    id: "visual-regression-screenshots",
    kind: "regression",
    title: "Capture regression screenshots for visual comparison",
    target: publishedUrl,
    tool: "screenshot_project",
    arguments: { projectId: input.projectId, entryFile, viewports: ["desktop", "tablet", "mobile"], fullPage: false },
    expected: "Screenshots are captured and reviewed for unexpected layout or visual changes.",
    source: "project"
  });

  const heading = stripTags(html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i)?.[0] ?? "");
  if (heading) {
    pushCase({
      id: "content-primary-heading",
      kind: "content",
      title: "Verify primary heading renders",
      target: publishedUrl,
      tool: "inspect_interaction_flow",
      arguments: { url: publishedUrl, steps: [{ action: "assertText", text: heading }] },
      expected: `Page contains primary heading text: ${heading}.`,
      source: entryFile
    });
  }

  const links = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi)].slice(0, 6);
  links.forEach((match, index) => {
    const text = stripTags(match[0]) || `Link ${index + 1}`;
    const selector = selectorFromTag(match[0], "a");
    pushCase({
      id: `link-${index + 1}`,
      kind: "interaction",
      title: `Click link: ${text.slice(0, 80)}`,
      target: publishedUrl,
      selector,
      tool: "inspect_interaction_flow",
      arguments: { url: publishedUrl, steps: [{ action: "click", selector }, { action: "screenshot", name: `link-${index + 1}` }] },
      expected: "Click succeeds without runtime errors and lands on the expected state or URL.",
      source: entryFile
    });
  });

  const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gi)].slice(0, 6);
  buttons.forEach((match, index) => {
    const text = stripTags(match[0]) || `Button ${index + 1}`;
    const selector = selectorFromTag(match[0], "button");
    pushCase({
      id: `button-${index + 1}`,
      kind: "interaction",
      title: `Exercise button: ${text.slice(0, 80)}`,
      target: publishedUrl,
      selector,
      tool: "inspect_interaction_flow",
      arguments: { url: publishedUrl, steps: [{ action: "click", selector }, { action: "screenshot", name: `button-${index + 1}` }] },
      expected: "Button interaction completes without console/page errors and produces the intended UI state.",
      source: entryFile
    });
  });

  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].slice(0, 4);
  forms.forEach((match, index) => {
    const formHtml = match[0];
    const formSelector = selectorFromTag(formHtml, "form");
    const firstInput = /<(input|textarea)\b[^>]*(?:name|id)\s*=\s*["']([^"']+)["'][^>]*>/i.exec(formHtml);
    const fieldSelector = firstInput ? `${firstInput[1].toLowerCase()}[${formHtml.includes(`name="${firstInput[2]}"`) ? "name" : "id"}="${firstInput[2]}"]` : "input,textarea";
    pushCase({
      id: `form-${index + 1}`,
      kind: "interaction",
      title: `Fill and submit form ${index + 1}`,
      target: publishedUrl,
      selector: formSelector,
      tool: "inspect_interaction_flow",
      arguments: {
        url: publishedUrl,
        steps: [
          { action: "fill", selector: fieldSelector, value: "test@example.com" },
          { action: "screenshot", name: `form-${index + 1}` }
        ]
      },
      expected: "Form accepts input, preserves accessible labels, and shows the expected validation/submission state.",
      source: entryFile
    });
  });

  const hasManifestOrSw = /rel\s*=\s*["'][^"']*manifest/i.test(html) || /serviceWorker\.register/i.test(html) || project.files.some((file) => /(^|\/)(manifest\.json|site\.webmanifest|sw\.js|service-worker\.js)$/i.test(file.path));
  if (input.includePwaChecks || hasManifestOrSw) {
    pushCase({
      id: "pwa-readiness",
      kind: "pwa",
      title: "Audit PWA, iOS, and Android readiness",
      target: entryFile,
      tool: "audit_project_pwa",
      arguments: { projectId: input.projectId, entryFile },
      expected: "No PWA readiness errors; warnings are reviewed or accepted.",
      source: "project"
    });
  }

  const validation = await validateProject(ctx.projectRoot, input.projectId, entryFile, "static_html");
  let pwa: Record<string, unknown> | undefined;
  if (input.includePwaChecks || hasManifestOrSw) {
    pwa = await auditProjectPwa(ctx, input.projectId, entryFile);
  }
  const plan = {
    projectId: input.projectId,
    entryFile,
    generatedAt: new Date().toISOString(),
    sourceSignals: {
      fileCount: project.files.length,
      linkCount: links.length,
      buttonCount: buttons.length,
      formCount: forms.length,
      hasManifestOrServiceWorker: hasManifestOrSw
    },
    staticChecks: {
      validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings },
      pwa: pwa ? { ok: pwa.ok, errors: pwa.errors, warnings: pwa.warnings } : undefined
    },
    testCases: cases
  };

  if (input.includeArtifacts) {
    await writeProjectFile(ctx.projectRoot, input.projectId, "tests/project-test-plan.json", JSON.stringify(plan, null, 2));
    await writeProjectFile(ctx.projectRoot, input.projectId, "tests/project-test-plan.md", renderTestPlanMarkdown(plan));
  }
  return plan;
}

export const projectTools: ToolModule[] = [
  {
    definition: {
      name: "create_project",
      description:
        "Create a persistent coding project and return its projectId. Pass that projectId (NOT the jobId field) plus a relativePath to write_project_file to add files.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Project title." },
          summary: { type: "string", description: "Short project summary." },
          entryFile: { type: "string", description: "Entry file, default index.html." }
        },
        required: ["title"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: createProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof createProjectInputSchema>;
      const project = await createProject(ctx.projectRoot, {
        title: parsed.title,
        summary: parsed.summary,
        entryFile: parsed.entryFile,
        createdByClientId: ctx.clientId
      });
      // Name projectId explicitly and show the exact next call. The shared jobId/artifacts fields
      // led an agent to retry write_project_file with jobId/path instead of projectId/relativePath.
      const nextStep = {
        tool: "write_project_file",
        arguments: { projectId: project.id, relativePath: project.entryFile, content: "<!doctype html>…" }
      };
      return {
        ok: true,
        summary: `Created project ${project.id}. Use projectId "${project.id}" with write_project_file (arguments: projectId + relativePath).`,
        jobId: project.id,
        artifacts: [project.id],
        structuredContent: { projectId: project.id, entryFile: project.entryFile, nextStep },
        logs: [JSON.stringify({ project, nextStep }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "list_projects",
      description: "List persistent coding projects created through this MCP.",
      inputSchema: { type: "object", properties: { includeDeleted: { type: "boolean", description: "Include soft-deleted projects." } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listProjectsInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof listProjectsInputSchema>;
      const projects = await listProjects(ctx.projectRoot, parsed.includeDeleted);
      return { ok: true, summary: `Found ${projects.length} project(s).`, artifacts: projects.map((project) => project.id), logs: [JSON.stringify(projects, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "search_projects_global",
      description: "Search across all persistent projects for metadata, published URLs, text files, task history, review feedback, and reusable snippets.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search. Empty query lists matching project metadata by recency." },
          includeDeleted: { type: "boolean" },
          statuses: { type: "array", items: { type: "string", enum: ["draft", "private", "published", "deleted"] } },
          title: { type: "string", description: "Optional project-title filter." },
          updatedSince: { type: "string", description: "ISO datetime lower bound for project updatedAt." },
          searchFiles: { type: "boolean" },
          searchHistory: { type: "boolean" },
          searchFeedback: { type: "boolean" },
          extensions: { type: "array", items: { type: "string", description: "Text extension such as .html, .css, .js, .md." } },
          maxProjects: { type: "number", minimum: 1, maximum: 200 },
          maxResults: { type: "number", minimum: 1, maximum: 200 },
          maxFilesPerProject: { type: "number", minimum: 1, maximum: 50 },
          maxSnippetChars: { type: "number", minimum: 80, maximum: 2000 }
        },
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: searchProjectsGlobalInputSchema,
    handler: async (input, ctx) => {
      const parsed = searchProjectsGlobalInputSchema.parse(input);
      const result = await searchProjectsGlobal(ctx.projectRoot, parsed);
      const payload = {
        query: parsed.query,
        filters: {
          includeDeleted: parsed.includeDeleted,
          statuses: parsed.statuses,
          title: parsed.title,
          updatedSince: parsed.updatedSince,
          searchFiles: parsed.searchFiles,
          searchHistory: parsed.searchHistory,
          searchFeedback: parsed.searchFeedback,
          extensions: parsed.extensions
        },
        projectsScanned: result.projectsScanned,
        matchCount: result.matches.length,
        truncated: result.truncated,
        matches: result.matches
      };
      return {
        ok: true,
        summary: result.matches.length > 0
          ? `Found ${result.matches.length} cross-project match(es) across ${result.projectsScanned} project(s).`
          : `No cross-project matches found across ${result.projectsScanned} project(s).`,
        artifacts: [...new Set(result.matches.map((match) => match.projectId))],
        structuredContent: payload,
        logs: [JSON.stringify(payload, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "get_project",
      description: "Get project metadata, file list, and published URL if available.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: projectIdInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof projectIdInputSchema>;
      const project = await getProjectWithFiles(ctx.projectRoot, parsed.projectId);
      return { ok: true, summary: `Loaded project ${parsed.projectId}.`, jobId: parsed.projectId, shareUrl: project.metadata.publishedUrl, previewUrl: project.metadata.publishedUrl, artifacts: project.files.map((file) => file.path), logs: [JSON.stringify(project, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "get_project_manifest",
      description: "Get the agent-readable project manifest: metadata, files, entry file, published URL, last validation, and task history.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: projectIdInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof projectIdInputSchema>;
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      return {
        ok: true,
        summary: `Loaded agent manifest for project ${parsed.projectId}.`,
        jobId: parsed.projectId,
        previewUrl: manifest.publishedUrl,
        shareUrl: manifest.publishedUrl,
        artifacts: manifest.files.map((file) => file.path),
        structuredContent: manifest as unknown as Record<string, unknown>,
        logs: [JSON.stringify(manifest, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "get_project_activity",
      description: "Get project task history, latest validation, publish status, and creator connector.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 100 }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: getProjectActivityInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof getProjectActivityInputSchema>;
      const activity = await getProjectActivity(ctx.projectRoot, parsed.projectId, parsed.limit);
      return {
        ok: true,
        summary: `Loaded activity for project ${parsed.projectId}.`,
        jobId: parsed.projectId,
        previewUrl: activity.publishedUrl,
        shareUrl: activity.publishedUrl,
        artifacts: [],
        structuredContent: activity as unknown as Record<string, unknown>,
        logs: [JSON.stringify(activity, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "upsert_project_task",
      description: "Create or update one persistent project task with status, priority, notes, progress, and evidence links.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          taskId: { type: "string", description: "Existing task id such as task_001. Omit to create a new task." },
          title: { type: "string" },
          status: { type: "string", enum: ["todo", "doing", "blocked", "done"] },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
          notes: { type: "string" },
          progress: { type: "number", minimum: 0, maximum: 100 },
          blockedReason: { type: "string", description: "Why this task is explicitly blocked. Used when status=blocked." },
          unblockRequirement: { type: "string", description: "What must happen to unblock this task. Used when status=blocked." },
          completionSummary: { type: "string", description: "Short completion summary. Used when status=done." },
          completedFiles: { type: "array", items: { type: "string" }, description: "Files changed while completing this task." },
          dependsOn: { type: "array", items: { type: "string" }, description: "Task ids that must be done before this task can start." },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                kind: { type: "string", enum: ["validation", "inspect_report", "screenshot", "published_url", "changed_file", "artifact", "note"] },
                url: { type: "string" },
                artifact: { type: "string" },
                filePath: { type: "string" },
                note: { type: "string" }
              },
              required: ["label"],
              additionalProperties: false
            }
          }
        },
        required: ["projectId", "title"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: upsertProjectTaskInputSchema,
    handler: async (input, ctx) => {
      const parsed = upsertProjectTaskInputSchema.parse(input);
      const task = await upsertProjectTask(ctx.projectRoot, parsed.projectId, parsed);
      return {
        ok: true,
        summary: `${parsed.taskId ? "Updated" : "Created"} project task ${task.id}.`,
        jobId: parsed.projectId,
        artifacts: [task.id, ...task.evidence.flatMap((item) => [item.url, item.artifact].filter((value): value is string => Boolean(value)))],
        structuredContent: { task },
        logs: [JSON.stringify(task, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "summarize_project_task_completion",
      description: "Complete a project task with a durable completion summary, changed files, latest validation snapshot, and evidence links.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          taskId: { type: "string", description: "Existing task id such as task_001." },
          completionSummary: { type: "string" },
          changedFiles: { type: "array", items: { type: "string" } },
          includeLatestValidation: { type: "boolean" }
        },
        required: ["projectId", "taskId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: summarizeProjectTaskCompletionInputSchema,
    handler: async (input, ctx) => {
      const parsed = summarizeProjectTaskCompletionInputSchema.parse(input);
      const [existing, manifest] = await Promise.all([
        getProjectTask(ctx.projectRoot, parsed.projectId, parsed.taskId),
        getProjectManifest(ctx.projectRoot, parsed.projectId)
      ]);
      const validation = parsed.includeLatestValidation ? manifest.lastValidation : undefined;
      const completionSummary = buildCompletionSummary({
        task: existing,
        completionSummary: parsed.completionSummary,
        completionNote: "",
        changedFiles: parsed.changedFiles,
        validation
      });
      const evidence: ProjectTaskEvidenceLink[] = parsed.changedFiles.map((filePath) => ({ label: `Completed file: ${filePath}`, kind: "changed_file", filePath }));
      if (validation) {
        evidence.push({
          label: `Completion validation: ${validation.status}`,
          kind: "validation",
          note: `${validation.ok ? "Passed" : "Failed"} at ${validation.checkedAt}; ${validation.errors.length} error(s), ${validation.warnings.length} warning(s).`,
          recordedAt: validation.checkedAt
        });
      }
      const task = await upsertProjectTask(ctx.projectRoot, parsed.projectId, {
        taskId: existing.id,
        title: existing.title,
        status: "done",
        priority: existing.priority,
        notes: existing.notes,
        progress: 100,
        dependsOn: existing.dependsOn,
        evidence: existing.evidence,
        completionSummary,
        completedFiles: parsed.changedFiles,
        completionValidation: validationSnapshot(validation)
      });
      if (evidence.length) await recordProjectTaskEvidence(ctx.projectRoot, parsed.projectId, task.id, evidence);
      const refreshed = await getProjectTask(ctx.projectRoot, parsed.projectId, task.id);
      const summary = {
        taskId: refreshed.id,
        title: refreshed.title,
        completionSummary: refreshed.completionSummary,
        completedFiles: refreshed.completedFiles ?? [],
        completionValidation: refreshed.completionValidation,
        completedAt: refreshed.completedAt,
        evidenceAdded: evidence
      };
      return {
        ok: true,
        summary: `Completed project task ${refreshed.id}: ${refreshed.title}.`,
        jobId: parsed.projectId,
        artifacts: [refreshed.id, ...parsed.changedFiles],
        structuredContent: { task: refreshed, completion: summary },
        logs: [JSON.stringify(summary, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "set_project_task_blocker",
      description: "Set or clear the explicit blocked reason and unblock requirement for one project task.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          taskId: { type: "string", description: "Existing task id such as task_001." },
          blockedReason: { type: "string" },
          unblockRequirement: { type: "string" },
          clear: { type: "boolean" },
          statusWhenCleared: { type: "string", enum: ["todo", "doing"] }
        },
        required: ["projectId", "taskId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: setProjectTaskBlockerInputSchema,
    handler: async (input, ctx) => {
      const parsed = setProjectTaskBlockerInputSchema.parse(input);
      const existing = await getProjectTask(ctx.projectRoot, parsed.projectId, parsed.taskId);
      const task = await upsertProjectTask(ctx.projectRoot, parsed.projectId, {
        taskId: existing.id,
        title: existing.title,
        status: parsed.clear ? parsed.statusWhenCleared : "blocked",
        priority: existing.priority,
        notes: existing.notes,
        progress: existing.progress,
        dependsOn: existing.dependsOn,
        evidence: existing.evidence,
        blockedReason: parsed.clear ? "" : parsed.blockedReason,
        unblockRequirement: parsed.clear ? "" : parsed.unblockRequirement
      });
      return {
        ok: true,
        summary: parsed.clear ? `Cleared blocker for project task ${task.id}.` : `Set blocker for project task ${task.id}.`,
        jobId: parsed.projectId,
        artifacts: [task.id],
        structuredContent: { task, blocker: { blockedReason: task.blockedReason, unblockRequirement: task.unblockRequirement, blockedAt: task.blockedAt } },
        logs: [JSON.stringify({ task, clear: parsed.clear }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "get_project_task",
      description: "Read one persistent project task by id.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          taskId: { type: "string", description: "Existing task id such as task_001." }
        },
        required: ["projectId", "taskId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: projectTaskIdInputSchema,
    handler: async (input, ctx) => {
      const parsed = projectTaskIdInputSchema.parse(input);
      const task = await getProjectTask(ctx.projectRoot, parsed.projectId, parsed.taskId);
      return {
        ok: true,
        summary: `Loaded project task ${task.id}.`,
        jobId: parsed.projectId,
        artifacts: [task.id],
        structuredContent: { task },
        logs: [JSON.stringify(task, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "delete_project_task",
      description: "Delete one persistent project task. The delete is rejected if other tasks still depend on it.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          taskId: { type: "string", description: "Existing task id such as task_001." }
        },
        required: ["projectId", "taskId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: projectTaskIdInputSchema,
    handler: async (input, ctx) => {
      const parsed = projectTaskIdInputSchema.parse(input);
      const deletedTask = await deleteProjectTask(ctx.projectRoot, parsed.projectId, parsed.taskId);
      return {
        ok: true,
        summary: `Deleted project task ${deletedTask.id}.`,
        jobId: parsed.projectId,
        artifacts: [deletedTask.id],
        structuredContent: { deletedTask },
        logs: [JSON.stringify(deletedTask, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "search_project_tasks",
      description: "Search persistent project tasks by title, notes, ids, dependencies, status, priority, or evidence links.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          query: { type: "string" },
          status: { type: "string", enum: ["todo", "doing", "blocked", "done"] },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
          maxResults: { type: "number", minimum: 1, maximum: 100 }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: searchProjectTasksInputSchema,
    handler: async (input, ctx) => {
      const parsed = searchProjectTasksInputSchema.parse(input);
      const tasks = await searchProjectTasks(ctx.projectRoot, parsed.projectId, parsed.query, {
        status: parsed.status,
        priority: parsed.priority,
        maxResults: parsed.maxResults
      });
      return {
        ok: true,
        summary: `Found ${tasks.length} matching project task(s).`,
        jobId: parsed.projectId,
        artifacts: tasks.map((task) => task.id),
        structuredContent: { tasks, total: tasks.length },
        logs: [JSON.stringify({ tasks, total: tasks.length }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "record_project_task_evidence",
      description: "Append validation results, inspect reports, screenshots, published URLs, changed files, or notes as evidence links on an existing project task.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          taskId: { type: "string", description: "Existing task id such as task_001." },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                kind: { type: "string", enum: ["validation", "inspect_report", "screenshot", "published_url", "changed_file", "artifact", "note"] },
                url: { type: "string" },
                artifact: { type: "string" },
                filePath: { type: "string" },
                note: { type: "string" }
              },
              required: ["label"],
              additionalProperties: false
            }
          }
        },
        required: ["projectId", "taskId", "evidence"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: recordProjectTaskEvidenceInputSchema,
    handler: async (input, ctx) => {
      const parsed = recordProjectTaskEvidenceInputSchema.parse(input);
      const task = await recordProjectTaskEvidence(ctx.projectRoot, parsed.projectId, parsed.taskId, parsed.evidence);
      const artifacts = task.evidence.flatMap((item) => [item.url, item.artifact, item.filePath].filter((value): value is string => Boolean(value)));
      return {
        ok: true,
        summary: `Recorded ${parsed.evidence.length} evidence link(s) for project task ${task.id}.`,
        jobId: parsed.projectId,
        artifacts: [task.id, ...artifacts],
        structuredContent: { task, addedEvidence: parsed.evidence },
        logs: [JSON.stringify({ taskId: task.id, addedEvidence: parsed.evidence, evidence: task.evidence }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "bind_project_task_evidence",
      description: "Bind project validation reports, browser inspection reports, screenshots, published URLs, changed files, and explicit artifacts to an existing task as evidence.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          taskId: { type: "string", description: "Existing task id such as task_001." },
          includeLatestValidation: { type: "boolean" },
          includeBrowserReport: { type: "boolean" },
          includeScreenshots: { type: "boolean" },
          includePublishedUrl: { type: "boolean" },
          includeRecentHistory: { type: "boolean" },
          historyLimit: { type: "number", minimum: 1, maximum: 50 },
          changedFiles: { type: "array", items: { type: "string" } },
          reports: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, url: { type: "string" } },
              required: ["label", "url"],
              additionalProperties: false
            }
          },
          screenshots: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, url: { type: "string" } },
              required: ["label", "url"],
              additionalProperties: false
            }
          },
          artifacts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                artifact: { type: "string" },
                kind: { type: "string", enum: ["validation", "inspect_report", "screenshot", "published_url", "changed_file", "artifact", "note"] }
              },
              required: ["label", "artifact"],
              additionalProperties: false
            }
          }
        },
        required: ["projectId", "taskId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: bindProjectTaskEvidenceInputSchema,
    handler: async (input, ctx) => {
      const parsed = bindProjectTaskEvidenceInputSchema.parse(input);
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const evidence: ProjectTaskEvidenceLink[] = [];
      const validation = manifest.lastValidation;
      if (parsed.includeLatestValidation && validation) {
        evidence.push({
          label: `Latest validation: ${validation.status}`,
          kind: "validation",
          note: `${validation.ok ? "Passed" : "Failed"} at ${validation.checkedAt}; ${validation.filesChecked} file(s), ${validation.errors.length} error(s), ${validation.warnings.length} warning(s).`,
          recordedAt: validation.checkedAt
        });
      }
      const browserInspection = validation?.browserInspection;
      if (parsed.includeBrowserReport && browserInspection?.reportUrl) {
        evidence.push({
          label: "Latest browser inspection report",
          kind: "inspect_report",
          url: browserInspection.reportUrl,
          note: `${browserInspection.ok ? "Passed" : "Failed"} at ${browserInspection.inspectedAt}.`,
          recordedAt: browserInspection.inspectedAt
        });
      }
      const browserRecord = browserInspection as unknown;
      const screenshotUrls = isRecord(browserRecord) && Array.isArray(browserRecord.screenshotUrls)
        ? browserRecord.screenshotUrls.filter((value): value is string => typeof value === "string" && /^https?:\/\//i.test(value))
        : [];
      if (parsed.includeScreenshots) {
        screenshotUrls.forEach((url, index) => evidence.push({
          label: `Screenshot ${index + 1}`,
          kind: "screenshot",
          url,
          recordedAt: browserInspection?.inspectedAt
        }));
      }
      if (parsed.includePublishedUrl && manifest.publishedUrl) {
        evidence.push({
          label: "Published project URL",
          kind: "published_url",
          url: manifest.publishedUrl,
          note: `Entry file: ${manifest.entryFile}.`
        });
      }
      for (const filePath of parsed.changedFiles) {
        evidence.push({ label: `Changed file: ${filePath}`, kind: "changed_file", filePath });
      }
      for (const report of parsed.reports) evidence.push({ label: report.label, kind: "inspect_report", url: report.url });
      for (const screenshot of parsed.screenshots) evidence.push({ label: screenshot.label, kind: "screenshot", url: screenshot.url });
      for (const artifact of parsed.artifacts) evidence.push({ label: artifact.label, kind: artifact.kind, artifact: artifact.artifact });

      if (parsed.includeRecentHistory) {
        const recent = manifest.taskHistory.slice(-parsed.historyLimit);
        for (const item of recent) {
          for (const url of collectUrlsFromDetails(item.details, new Set(["publishedUrl", "reportUrl"]))) {
            evidence.push({
              label: item.toolName.includes("publish") ? "Published URL from recent history" : "Report URL from recent history",
              kind: item.toolName.includes("publish") ? "published_url" : "inspect_report",
              url,
              note: item.summary,
              recordedAt: item.time
            });
          }
          for (const url of collectUrlsFromDetails(item.details, new Set(["screenshotUrl", "screenshotUrls"]))) {
            evidence.push({
              label: "Screenshot URL from recent history",
              kind: "screenshot",
              url,
              note: item.summary,
              recordedAt: item.time
            });
          }
        }
      }

      const bound = dedupeTaskEvidence(evidence).slice(0, 50);
      if (bound.length === 0) {
        return {
          ok: false,
          summary: "No project evidence was available to bind.",
          jobId: parsed.projectId,
          artifacts: [parsed.taskId],
          structuredContent: { taskId: parsed.taskId, evidence: [] },
          logs: ["No validation, browser report, screenshots, published URL, changed files, reports, or artifacts were found."],
          errors: ["No evidence found to bind."]
        };
      }
      const task = await recordProjectTaskEvidence(ctx.projectRoot, parsed.projectId, parsed.taskId, bound);
      const artifacts = bound.flatMap((item) => [item.url, item.artifact, item.filePath].filter((value): value is string => Boolean(value)));
      return {
        ok: true,
        summary: `Bound ${bound.length} evidence item(s) to project task ${task.id}.`,
        jobId: parsed.projectId,
        artifacts: [task.id, ...artifacts],
        structuredContent: { task, boundEvidence: bound },
        logs: [JSON.stringify({ taskId: task.id, boundEvidence: bound }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "get_project_task_graph",
      description: "Return a project task dependency graph with nodes, edges, ready tasks, and blocked tasks.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: projectIdInputSchema,
    handler: async (input, ctx) => {
      const parsed = projectIdInputSchema.parse(input);
      const graph = await getProjectTaskGraph(ctx.projectRoot, parsed.projectId);
      return {
        ok: graph.cycles.length === 0,
        summary: `Task graph has ${graph.nodes.length} node(s), ${graph.edges.length} edge(s), ${graph.readyTasks.length} ready task(s), and ${graph.blockedTasks.length} blocked task(s).`,
        jobId: parsed.projectId,
        artifacts: graph.nodes.map((task) => task.id),
        structuredContent: graph as unknown as Record<string, unknown>,
        logs: [JSON.stringify(graph, null, 2)],
        errors: graph.cycles.map((cycle) => `Cycle: ${cycle.join(" -> ")}`)
      };
    }
  },
  {
    definition: {
      name: "get_project_task_dependency_view",
      description: "Return an agent-readable dependency view with ready/blocked/done lanes, dependency chains, Mermaid graph text, and suggested next actions.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, includeDone: { type: "boolean" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: getProjectTaskDependencyViewInputSchema,
    handler: async (input, ctx) => {
      const parsed = getProjectTaskDependencyViewInputSchema.parse(input);
      const graph = await getProjectTaskGraph(ctx.projectRoot, parsed.projectId);
      const nodes = parsed.includeDone ? graph.nodes : graph.nodes.filter((task) => task.status !== "done");
      const byId = new Map(graph.nodes.map((task) => [task.id, task]));
      const blocked = nodes.filter((task) => task.blocked && task.status !== "done");
      const ready = nodes.filter((task) => !task.blocked && task.status !== "done").sort((left, right) => taskPriorityWeight(left.priority) - taskPriorityWeight(right.priority));
      const done = nodes.filter((task) => task.status === "done");
      const chains = nodes.map((task) => ({
        taskId: task.id,
        chain: dependencyChainFor(task.id, byId).map((id) => {
          const item = byId.get(id);
          return item ? taskLabel(item) : id;
        })
      }));
      const view = {
        projectId: parsed.projectId,
        lanes: {
          ready: ready.map((task) => ({ id: task.id, title: task.title, priority: task.priority, progress: task.progress })),
          blocked: blocked.map((task) => ({ id: task.id, title: task.title, priority: task.priority, blockedReason: task.blockedReason, unblockRequirement: task.unblockRequirement, blockedReasons: task.blockedReasons, blockedBy: task.blockedBy.map((id) => taskLabel(byId.get(id) ?? { id, title: "unknown" })) })),
          done: done.map((task) => ({ id: task.id, title: task.title, completionSummary: task.completionSummary, completedFiles: task.completedFiles ?? [], completionValidation: task.completionValidation, completedAt: task.completedAt }))
        },
        chains,
        mermaid: renderTaskMermaid(graph),
        nextActions: ready.length > 0
          ? ready.slice(0, 3).map((task) => `Start ${taskLabel(task)}.`)
          : blocked.length > 0
            ? blocked.slice(0, 3).map((task) => `Unblock ${taskLabel(task)} by completing ${task.blockedBy.map((id) => taskLabel(byId.get(id) ?? { id, title: "unknown" })).join(", ")}.`)
            : ["No active unblocked tasks remain."],
        counts: { ready: ready.length, blocked: blocked.length, done: done.length, total: nodes.length }
      };
      return {
        ok: graph.cycles.length === 0,
        summary: `Task dependency view: ${ready.length} ready, ${blocked.length} blocked, ${done.length} done.`,
        jobId: parsed.projectId,
        artifacts: nodes.map((task) => task.id),
        structuredContent: view,
        logs: [JSON.stringify(view, null, 2)],
        errors: graph.cycles.map((cycle) => `Cycle: ${cycle.join(" -> ")}`)
      };
    }
  },
  {
    definition: {
      name: "get_project_task_board",
      description: "Return a task board view with pending, doing, blocked, and done lanes plus counts and progress percentages.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: getProjectTaskBoardInputSchema,
    handler: async (input, ctx) => {
      const parsed = getProjectTaskBoardInputSchema.parse(input);
      const graph = await getProjectTaskGraph(ctx.projectRoot, parsed.projectId);
      const byId = new Map(graph.nodes.map((task) => [task.id, task]));
      const blockedIds = new Set(graph.blockedTasks.map((task) => task.id));
      const toBoardTask = (task: (typeof graph.nodes)[number]) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        progress: task.progress,
        blockedReason: task.blockedReason,
        unblockRequirement: task.unblockRequirement,
        blockedAt: task.blockedAt,
        blockedReasons: task.blockedReasons,
        completionSummary: task.completionSummary,
        completedFiles: task.completedFiles ?? [],
        completionValidation: task.completionValidation,
        completedAt: task.completedAt,
        blockedBy: task.blockedBy.map((id) => taskLabel(byId.get(id) ?? { id, title: "unknown" })),
        dependents: task.dependents,
        evidenceCount: task.evidence.length,
        updatedAt: task.updatedAt
      });
      const pending = sortResumeCandidates(graph.nodes.filter((task) => task.status === "todo" && !blockedIds.has(task.id)));
      const doing = sortResumeCandidates(graph.nodes.filter((task) => task.status === "doing" && !blockedIds.has(task.id)));
      const blocked = sortResumeCandidates(graph.blockedTasks.filter((task) => task.status !== "done"));
      const done = sortResumeCandidates(graph.nodes.filter((task) => task.status === "done"));
      const lanes = {
        pending: pending.map(toBoardTask),
        doing: doing.map(toBoardTask),
        blocked: blocked.map(toBoardTask),
        done: done.map(toBoardTask)
      };
      const total = graph.nodes.length;
      const counts = {
        pending: lanes.pending.length,
        doing: lanes.doing.length,
        blocked: lanes.blocked.length,
        done: lanes.done.length,
        total
      };
      const progress = {
        completionPercent: percent(counts.done, total),
        averageProgress: averageProgress(graph.nodes),
        byLane: {
          pending: averageProgress(pending),
          doing: averageProgress(doing),
          blocked: averageProgress(blocked),
          done: averageProgress(done)
        }
      };
      const board = {
        projectId: parsed.projectId,
        lanes,
        counts,
        progress,
        nextActions: lanes.doing.length > 0
          ? [`Continue ${lanes.doing[0].id}: ${lanes.doing[0].title}.`]
          : lanes.pending.length > 0
            ? [`Start ${lanes.pending[0].id}: ${lanes.pending[0].title}.`]
            : lanes.blocked.length > 0
              ? [`Unblock ${lanes.blocked[0].id}: ${lanes.blocked[0].title}.`]
              : ["No active tasks remain."]
      };
      return {
        ok: graph.cycles.length === 0,
        summary: `Task board: ${counts.pending} pending, ${counts.doing} doing, ${counts.blocked} blocked, ${counts.done} done (${progress.completionPercent}% complete).`,
        jobId: parsed.projectId,
        artifacts: graph.nodes.map((task) => task.id),
        structuredContent: board,
        logs: [JSON.stringify(board, null, 2)],
        errors: graph.cycles.map((cycle) => `Cycle: ${cycle.join(" -> ")}`)
      };
    }
  },
  {
    definition: {
      name: "pick_next_project_task",
      description: "Pick the next project task an agent should work on, using dependency readiness, in-progress work, priority, progress, and recency.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          mode: { type: "string", enum: ["resume_or_ready", "ready_only", "blocked_if_none"] },
          includeBlockedFallback: { type: "boolean" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: pickNextProjectTaskInputSchema,
    handler: async (input, ctx) => {
      const parsed = pickNextProjectTaskInputSchema.parse(input);
      const graph = await getProjectTaskGraph(ctx.projectRoot, parsed.projectId);
      const nowMs = Date.now();
      const byId = new Map(graph.nodes.map((task) => [task.id, task]));
      const blockedIds = new Set(graph.blockedTasks.map((task) => task.id));
      const doing = graph.nodes.filter((task) => task.status === "doing" && !blockedIds.has(task.id));
      const ready = graph.readyTasks.filter((task) => task.status === "todo");
      const blocked = graph.blockedTasks.filter((task) => task.status !== "done");
      const candidateSource = parsed.mode === "ready_only" ? ready : [...doing, ...ready];
      const scored = candidateSource
        .map((task) => ({
          task,
          score: taskPickerScore(task, nowMs),
          reason: task.status === "doing" ? "resume_in_progress" : "ready_dependency_unblocked"
        }))
        .sort((left, right) => left.score - right.score || right.task.updatedAt.localeCompare(left.task.updatedAt));
      const fallback = (parsed.includeBlockedFallback || parsed.mode === "blocked_if_none") && scored.length === 0
        ? sortBlockedFallback(blocked)[0]
        : undefined;
      const selected = scored[0]?.task ?? fallback;
      const selectedReason = scored[0]?.reason ?? (fallback ? "blocked_fallback" : "none_available");
      const toTaskSummary = (task: (typeof graph.nodes)[number]) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        progress: task.progress,
        blockedReason: task.blockedReason,
        unblockRequirement: task.unblockRequirement,
        blockedAt: task.blockedAt,
        blockedReasons: task.blockedReasons,
        blockedBy: task.blockedBy.map((id) => taskLabel(byId.get(id) ?? { id, title: "unknown" })),
        dependsOn: task.dependsOn,
        evidenceCount: task.evidence.length,
        updatedAt: task.updatedAt
      });
      const result = {
        projectId: parsed.projectId,
        mode: parsed.mode,
        selected: selected ? toTaskSummary(selected) : undefined,
        reason: selectedReason,
        candidates: scored.map((item) => ({ ...toTaskSummary(item.task), score: item.score, reason: item.reason })),
        skipped: {
          blocked: blocked.map(toTaskSummary),
          done: graph.nodes.filter((task) => task.status === "done").map(toTaskSummary)
        },
        nextActions: selected
          ? selectedReason === "blocked_fallback"
            ? [`Unblock ${taskLabel(selected)} by completing ${selected.blockedBy.map((id) => taskLabel(byId.get(id) ?? { id, title: "unknown" })).join(", ")}.`]
            : [`Work on ${taskLabel(selected)}.`, `Set ${selected.id} to doing and record evidence as validation completes.`]
          : ["No unfinished project tasks are ready or blocked."]
      };
      return {
        ok: graph.cycles.length === 0,
        summary: selected ? `Picked ${selected.id}: ${selected.title}.` : "No next project task available.",
        jobId: parsed.projectId,
        artifacts: selected ? [selected.id] : [],
        structuredContent: result,
        logs: [JSON.stringify(result, null, 2)],
        errors: graph.cycles.map((cycle) => `Cycle: ${cycle.join(" -> ")}`)
      };
    }
  },
  {
    definition: {
      name: "execute_project_task_queue_step",
      description: "Advance a project task queue by one safe step: claim the next ready task or complete a task with optional validation, evidence binding, status updates, and stop conditions.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          taskId: { type: "string", description: "Optional task id. Defaults to the selected next task." },
          action: { type: "string", enum: ["claim_next", "complete_task"] },
          validation: { type: "string", enum: ["none", "static_project"] },
          entryFile: { type: "string" },
          stopOnValidationFailure: { type: "boolean" },
          bindEvidence: { type: "boolean" },
          changedFiles: { type: "array", items: { type: "string" } },
          completionNote: { type: "string" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: executeProjectTaskQueueStepInputSchema,
    handler: async (input, ctx) => {
      const parsed = executeProjectTaskQueueStepInputSchema.parse(input);
      const graph = await getProjectTaskGraph(ctx.projectRoot, parsed.projectId);
      const byId = new Map(graph.nodes.map((task) => [task.id, task]));
      const explicitTask = parsed.taskId ? byId.get(parsed.taskId) : undefined;
      if (parsed.taskId && !explicitTask) throw new Error(`Task ${parsed.taskId} not found.`);
      const blockedIds = new Set(graph.blockedTasks.map((task) => task.id));
      const doing = graph.nodes.filter((task) => task.status === "doing" && !blockedIds.has(task.id));
      const ready = graph.readyTasks.filter((task) => task.status === "todo");
      const candidates = sortResumeCandidates([...doing, ...ready]);
      const selected = explicitTask ?? candidates[0];
      if (!selected) {
        const result = {
          projectId: parsed.projectId,
          action: parsed.action,
          selected: undefined,
          stopReason: graph.blockedTasks.length > 0 ? "blocked_tasks_only" : "no_unfinished_tasks",
          nextActions: graph.blockedTasks.length > 0
            ? ["Unblock a blocked task before continuing the queue."]
            : ["Create a new task before continuing the queue."]
        };
        return {
          ok: graph.cycles.length === 0,
          summary: "No task is available for queue execution.",
          jobId: parsed.projectId,
          artifacts: [],
          structuredContent: result,
          logs: [JSON.stringify(result, null, 2)],
          errors: graph.cycles.map((cycle) => `Cycle: ${cycle.join(" -> ")}`)
        };
      }
      if (blockedIds.has(selected.id) && parsed.action === "claim_next") {
        const result = {
          projectId: parsed.projectId,
          action: parsed.action,
          selected: { id: selected.id, title: selected.title, status: selected.status, blockedReason: selected.blockedReason, unblockRequirement: selected.unblockRequirement, blockedReasons: selected.blockedReasons, blockedBy: selected.blockedBy },
          stopReason: "selected_task_blocked",
          nextActions: [`Unblock ${taskLabel(selected)} by completing ${selected.blockedBy.map((id) => taskLabel(byId.get(id) ?? { id, title: "unknown" })).join(", ")}.`]
        };
        return {
          ok: false,
          summary: `Selected task ${selected.id} is blocked.`,
          jobId: parsed.projectId,
          artifacts: [selected.id],
          structuredContent: result,
          logs: [JSON.stringify(result, null, 2)],
          errors: result.nextActions
        };
      }

      let validationResult: Awaited<ReturnType<typeof validateProject>> | undefined;
      const evidence: ProjectTaskEvidenceLink[] = [];
      for (const filePath of parsed.changedFiles) evidence.push({ label: `Changed file: ${filePath}`, kind: "changed_file", filePath });

      if (parsed.action === "claim_next") {
        const claimed = await upsertProjectTask(ctx.projectRoot, parsed.projectId, {
          taskId: selected.id,
          title: selected.title,
          status: "doing",
          priority: selected.priority,
          notes: selected.notes,
          progress: Math.max(selected.progress, 1),
          dependsOn: selected.dependsOn,
          evidence: selected.evidence
        });
        if (parsed.bindEvidence && evidence.length > 0) await recordProjectTaskEvidence(ctx.projectRoot, parsed.projectId, claimed.id, evidence);
        const refreshed = await getProjectTaskGraph(ctx.projectRoot, parsed.projectId);
        const next = sortResumeCandidates(refreshed.readyTasks.filter((task) => task.status === "todo"))[0];
        const result = {
          projectId: parsed.projectId,
          action: "claim_next",
          task: claimed,
          stopReason: "step_claimed",
          validation: undefined,
          nextTask: next ? { id: next.id, title: next.title, priority: next.priority, progress: next.progress } : undefined,
          nextActions: [`Work on ${taskLabel(claimed)}.`, `Call execute_project_task_queue_step with action=complete_task for ${claimed.id} after validation work is done.`]
        };
        return {
          ok: true,
          summary: `Claimed task ${claimed.id}: ${claimed.title}.`,
          jobId: parsed.projectId,
          artifacts: [claimed.id, ...evidence.flatMap((item) => [item.filePath, item.url, item.artifact].filter((value): value is string => Boolean(value)))],
          structuredContent: result,
          logs: [JSON.stringify(result, null, 2)],
          errors: []
        };
      }

      if (parsed.validation === "static_project") {
        validationResult = await validateProject(ctx.projectRoot, parsed.projectId, parsed.entryFile, "static_html");
        evidence.push({
          label: `Queue step validation: ${validationResult.status}`,
          kind: "validation",
          note: `${validationResult.ok ? "Passed" : "Failed"} at ${validationResult.checkedAt}; ${validationResult.errors.length} error(s), ${validationResult.warnings.length} warning(s).`,
          recordedAt: validationResult.checkedAt
        });
      }

      if (validationResult && !validationResult.ok && parsed.stopOnValidationFailure) {
        const blocked = await upsertProjectTask(ctx.projectRoot, parsed.projectId, {
          taskId: selected.id,
          title: selected.title,
          status: "blocked",
          priority: selected.priority,
          notes: [selected.notes, parsed.completionNote, `Validation failed: ${validationResult.errors.join("; ")}`].filter(Boolean).join("\n"),
          progress: selected.progress,
          dependsOn: selected.dependsOn,
          evidence: selected.evidence,
          blockedReason: `Static project validation failed: ${validationResult.errors.join("; ")}`,
          unblockRequirement: "Fix validation errors, rerun validation, then clear this blocker."
        });
        if (parsed.bindEvidence && evidence.length > 0) await recordProjectTaskEvidence(ctx.projectRoot, parsed.projectId, blocked.id, evidence);
        const result = {
          projectId: parsed.projectId,
          action: "complete_task",
          task: blocked,
          validation: validationResult,
          stopReason: "validation_failed",
          nextTask: undefined,
          nextActions: [`Fix validation errors before continuing ${taskLabel(blocked)}.`]
        };
        return {
          ok: false,
          summary: `Queue stopped: validation failed for task ${blocked.id}.`,
          jobId: parsed.projectId,
          artifacts: [blocked.id, ...evidence.flatMap((item) => [item.filePath, item.url, item.artifact].filter((value): value is string => Boolean(value)))],
          structuredContent: result,
          logs: [JSON.stringify(result, null, 2)],
          errors: validationResult.errors
        };
      }

      const completed = await upsertProjectTask(ctx.projectRoot, parsed.projectId, {
        taskId: selected.id,
        title: selected.title,
        status: "done",
        priority: selected.priority,
        notes: [selected.notes, parsed.completionNote].filter(Boolean).join("\n"),
        progress: 100,
        dependsOn: selected.dependsOn,
        evidence: selected.evidence,
        completionSummary: buildCompletionSummary({
          task: selected,
          completionSummary: parsed.completionSummary,
          completionNote: parsed.completionNote,
          changedFiles: parsed.changedFiles,
          validation: validationResult
        }),
        completedFiles: parsed.changedFiles,
        completionValidation: validationSnapshot(validationResult)
      });
      if (parsed.bindEvidence && evidence.length > 0) await recordProjectTaskEvidence(ctx.projectRoot, parsed.projectId, completed.id, evidence);
      const refreshed = await getProjectTaskGraph(ctx.projectRoot, parsed.projectId);
      const next = sortResumeCandidates(refreshed.readyTasks.filter((task) => task.status === "todo"))[0];
      const result = {
        projectId: parsed.projectId,
        action: "complete_task",
        task: completed,
        validation: validationResult,
        stopReason: next ? "step_completed_next_ready" : "step_completed_queue_empty",
        nextTask: next ? { id: next.id, title: next.title, priority: next.priority, progress: next.progress } : undefined,
        nextActions: next ? [`Continue with ${taskLabel(next)}.`] : ["No ready tasks remain."]
      };
      return {
        ok: true,
        summary: `Completed task ${completed.id}: ${completed.title}.`,
        jobId: parsed.projectId,
        artifacts: [completed.id, ...evidence.flatMap((item) => [item.filePath, item.url, item.artifact].filter((value): value is string => Boolean(value)))],
        structuredContent: result,
        logs: [JSON.stringify(result, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "get_project_resume_state",
      description: "Return the last unfinished project task and recent workflow state so an agent can resume after interruption.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          historyLimit: { type: "number", minimum: 1, maximum: 50, description: "Recent task history events to include." }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: getProjectResumeStateInputSchema,
    handler: async (input, ctx) => {
      const parsed = getProjectResumeStateInputSchema.parse(input);
      const [activity, graph] = await Promise.all([
        getProjectActivity(ctx.projectRoot, parsed.projectId, parsed.historyLimit),
        getProjectTaskGraph(ctx.projectRoot, parsed.projectId)
      ]);
      const activeDoing = sortResumeCandidates(graph.nodes.filter((task) => task.status === "doing" && !task.blocked));
      const ready = sortResumeCandidates(graph.readyTasks.filter((task) => task.status !== "doing"));
      const blocked = sortResumeCandidates(graph.blockedTasks);
      const resumeTask = activeDoing[0] ?? ready[0] ?? blocked[0];
      const reason = activeDoing[0]
        ? "resume_in_progress"
        : ready[0]
          ? "start_next_ready"
          : blocked[0]
            ? "unblock_required"
            : "no_unfinished_tasks";
      const byId = new Map(graph.nodes.map((task) => [task.id, task]));
      const unfinished = graph.nodes
        .filter((task) => task.status !== "done")
        .map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          progress: task.progress,
          updatedAt: task.updatedAt,
          blocked: task.blocked,
          blockedReason: task.blockedReason,
          unblockRequirement: task.unblockRequirement,
          blockedAt: task.blockedAt,
          blockedReasons: task.blockedReasons,
          blockedBy: task.blockedBy.map((id) => taskLabel(byId.get(id) ?? { id, title: "unknown" }))
        }));
      const recentActivity = activity.taskHistory.slice(-parsed.historyLimit).reverse();
      const nextActions = resumeTask
        ? reason === "unblock_required"
          ? [`Unblock ${taskLabel(resumeTask)} by completing ${resumeTask.blockedBy.map((id) => taskLabel(byId.get(id) ?? { id, title: "unknown" })).join(", ")}.`]
          : [`Continue ${taskLabel(resumeTask)}.`, `Update ${resumeTask.id} progress/evidence when the next validation step finishes.`]
        : ["No unfinished tasks remain. Create a new project task before resuming work."];
      const resumeState = {
        projectId: parsed.projectId,
        resumeTask: resumeTask ? {
          id: resumeTask.id,
          title: resumeTask.title,
          status: resumeTask.status,
          priority: resumeTask.priority,
          progress: resumeTask.progress,
          notes: resumeTask.notes,
          dependsOn: resumeTask.dependsOn,
          blockedBy: resumeTask.blockedBy,
          blockedReason: resumeTask.blockedReason,
          unblockRequirement: resumeTask.unblockRequirement,
          blockedAt: resumeTask.blockedAt,
          blockedReasons: resumeTask.blockedReasons,
          evidence: resumeTask.evidence,
          updatedAt: resumeTask.updatedAt
        } : undefined,
        reason,
        unfinished,
        recentActivity,
        counts: {
          doing: graph.nodes.filter((task) => task.status === "doing").length,
          ready: graph.readyTasks.length,
          blocked: graph.blockedTasks.length,
          done: graph.nodes.filter((task) => task.status === "done").length,
          total: graph.nodes.length
        },
        nextActions
      };
      return {
        ok: graph.cycles.length === 0,
        summary: resumeTask ? `Resume ${resumeTask.id}: ${resumeTask.title}.` : "No unfinished project task to resume.",
        jobId: parsed.projectId,
        artifacts: resumeTask ? [resumeTask.id] : [],
        structuredContent: resumeState,
        logs: [JSON.stringify(resumeState, null, 2)],
        errors: graph.cycles.map((cycle) => `Cycle: ${cycle.join(" -> ")}`)
      };
    }
  },
  {
    definition: {
      name: "rank_project_tasks",
      description: "Auto-rank project tasks by dependency readiness, priority, inferred risk, dependency impact, progress, and recency.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          includeDone: { type: "boolean" },
          maxResults: { type: "number" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: rankProjectTasksInputSchema,
    handler: async (input, ctx) => {
      const parsed = rankProjectTasksInputSchema.parse(input);
      const graph = await getProjectTaskGraph(ctx.projectRoot, parsed.projectId);
      const byId = new Map(graph.nodes.map((task) => [task.id, task]));
      const ranked = sortRankedProjectTasks(graph.nodes.filter((task) => parsed.includeDone || task.status !== "done"))
        .slice(0, parsed.maxResults)
        .map((task, index) => rankedTaskSummary(task, index + 1, byId));
      const top = ranked[0];
      const result = {
        projectId: parsed.projectId,
        ranked,
        counts: {
          ready: ranked.filter((task) => task.dependencyState === "ready" || task.dependencyState === "doing").length,
          blocked: ranked.filter((task) => task.dependencyState === "blocked").length,
          done: ranked.filter((task) => task.dependencyState === "done").length,
          total: ranked.length
        },
        sorting: ["dependency readiness", "priority", "inferred risk", "dependency impact", "progress", "updatedAt"],
        nextActions: top
          ? top.dependencyState === "blocked"
            ? [`Unblock ${top.id}: ${top.title}.`]
            : [`Work on ${top.id}: ${top.title}.`]
          : ["No tasks available to rank."]
      };
      return {
        ok: graph.cycles.length === 0,
        summary: top ? `Top ranked task is ${top.id}: ${top.title}.` : "No project tasks to rank.",
        jobId: parsed.projectId,
        artifacts: ranked.map((task) => task.id),
        structuredContent: result,
        logs: [JSON.stringify(result, null, 2)],
        errors: graph.cycles.map((cycle) => `Cycle: ${cycle.join(" -> ")}`)
      };
    }
  },
  {
    definition: {
      name: "list_project_tasks",
      description: "List persistent project tasks, default-ranked by dependency readiness, priority, inferred risk, dependency impact, and update time.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          status: { type: "string", enum: ["todo", "doing", "blocked", "done"] },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
          sortBy: { type: "string", enum: ["rank", "status", "updated"] }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: listProjectTasksInputSchema,
    handler: async (input, ctx) => {
      const parsed = listProjectTasksInputSchema.parse(input);
      const graph = await getProjectTaskGraph(ctx.projectRoot, parsed.projectId);
      const byId = new Map(graph.nodes.map((task) => [task.id, task]));
      const filtered = graph.nodes.filter((task) => {
        return (!parsed.status || task.status === parsed.status)
          && (!parsed.priority || task.priority === parsed.priority);
      });
      const tasks = parsed.sortBy === "rank"
        ? sortRankedProjectTasks(filtered)
        : parsed.sortBy === "updated"
          ? filtered.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          : filtered.slice().sort((left, right) => {
            const statusRank: Record<ProjectTaskStatus, number> = { doing: 0, blocked: 1, todo: 2, done: 3 };
            return statusRank[left.status] - statusRank[right.status]
              || taskPriorityWeight(left.priority) - taskPriorityWeight(right.priority)
              || right.updatedAt.localeCompare(left.updatedAt);
          });
      const ranked = tasks.map((task, index) => rankedTaskSummary(task, index + 1, byId));
      const counts = tasks.reduce((acc, task) => {
        acc[task.status] = (acc[task.status] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      return {
        ok: true,
        summary: `Listed ${tasks.length} project task(s).`,
        jobId: parsed.projectId,
        artifacts: tasks.map((task) => task.id),
        structuredContent: { tasks, ranked, counts, total: tasks.length, sortBy: parsed.sortBy },
        logs: [JSON.stringify({ tasks, ranked, counts, sortBy: parsed.sortBy }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "write_project_file",
      description: "Write a UTF-8 file inside a persistent project.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, relativePath: { type: "string", description: "Project-relative path. No absolute paths, dotfiles, or parent traversal." }, content: { type: "string", description: "UTF-8 text content. Max 1 MiB." } }, required: ["projectId", "relativePath", "content"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: writeProjectFileInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof writeProjectFileInputSchema>;
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.relativePath, parsed.content);
      return { ok: true, summary: `Wrote ${file.path} in project ${parsed.projectId}.`, jobId: parsed.projectId, artifacts: [file.path], logs: [JSON.stringify(file, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "write_project_asset",
      description: "Write a binary image or PPTX asset inside a persistent project from raw base64 content.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          relativePath: { type: "string", description: "Project-relative asset path, e.g. assets/hero.png. No absolute paths, dotfiles, or parent traversal." },
          contentBase64: { type: "string", description: "Raw base64 asset bytes without a data: URL prefix." },
          contentType: { type: "string", description: "Optional MIME type, e.g. image/png." }
        },
        required: ["projectId", "relativePath", "contentBase64"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: writeProjectAssetInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof writeProjectAssetInputSchema>;
      const buffer = decodePureBase64(parsed.contentBase64);
      const file = await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.relativePath, buffer, parsed.contentType);
      return { ok: true, summary: `Wrote asset ${file.path} in project ${parsed.projectId}.`, jobId: parsed.projectId, artifacts: [file.path], logs: [JSON.stringify(file, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "import_project_asset_from_local_file",
      description: "Import a local uploaded/generated image or PPTX file into a persistent project, e.g. copy /mnt/data/character.png to assets/character.png.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          relativePath: { type: "string", description: "Project-relative asset path, e.g. assets/character.png." },
          sourcePath: { type: "string", description: "Absolute local runtime path, or workspace-relative path, to an uploaded/generated asset." },
          contentType: { type: "string", description: "Optional MIME type, e.g. image/png." }
        },
        required: ["projectId", "relativePath", "sourcePath"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: importProjectAssetFromLocalFileInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof importProjectAssetFromLocalFileInputSchema>;
      const sourcePath = resolveLocalSourcePath(ctx.workspaceRoot, parsed.sourcePath);
      const file = await importProjectAssetFromLocalFile(ctx.projectRoot, parsed.projectId, parsed.relativePath, sourcePath, parsed.contentType);
      return {
        ok: true,
        summary: `Imported local asset ${file.path} in project ${parsed.projectId}.`,
        jobId: parsed.projectId,
        artifacts: [file.path],
        structuredContent: { ...file, sourcePath },
        logs: [JSON.stringify({ ...file, sourcePath }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "import_project_asset_from_url",
      description: "Import an HTTPS image or PPTX asset into a persistent project after private-network and MIME validation.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          relativePath: { type: "string", description: "Project-relative asset path, e.g. assets/hero.png." },
          url: { type: "string", description: "HTTPS URL to import." }
        },
        required: ["projectId", "relativePath", "url"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: importProjectAssetFromUrlInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof importProjectAssetFromUrlInputSchema>;
      const imported = await fetchProjectAsset(parsed.url, parsed.relativePath);
      const file = await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.relativePath, imported.buffer, imported.contentType);
      return {
        ok: true,
        summary: `Imported asset ${file.path} in project ${parsed.projectId}.`,
        jobId: parsed.projectId,
        artifacts: [file.path],
        logs: [JSON.stringify({ ...file, sourceUrl: parsed.url, finalUrl: imported.finalUrl, contentType: imported.contentType }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "patch_project_file",
      description: "Patch a UTF-8 project file with exact find/replace operations without rewriting the whole file.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          relativePath: { type: "string", description: "Project-relative text file path." },
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                find: { type: "string", description: "Exact text to find." },
                replace: { type: "string", description: "Replacement text." },
                all: { type: "boolean", description: "Replace all occurrences instead of only the first." }
              },
              required: ["find", "replace"],
              additionalProperties: false
            }
          }
        },
        required: ["projectId", "relativePath", "operations"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: patchProjectFileInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof patchProjectFileInputSchema>;
      const file = await patchProjectFile(ctx.projectRoot, parsed.projectId, parsed.relativePath, parsed.operations);
      return { ok: true, summary: `Patched ${file.path} in project ${parsed.projectId}.`, jobId: parsed.projectId, artifacts: [file.path], logs: [JSON.stringify(file, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "fork_project",
      description: "Create a draft V2-style copy of an existing project, preserving files but not publish status.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Source project id." },
          title: { type: "string", description: "Optional title for the fork." },
          summary: { type: "string", description: "Optional summary for the fork." }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: forkProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof forkProjectInputSchema>;
      const project = await forkProject(ctx.projectRoot, parsed.projectId, {
        title: parsed.title,
        summary: parsed.summary,
        createdByClientId: ctx.clientId
      });
      return { ok: true, summary: `Forked ${parsed.projectId} into ${project.id}.`, jobId: project.id, artifacts: [project.id], structuredContent: project as unknown as Record<string, unknown>, logs: [JSON.stringify(project, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "deliver_static_project",
      description: "Create a static project from multiple text files, validate it, publish it, browser-inspect it, and return a final delivery report.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Project title." },
          summary: { type: "string", description: "Short project summary." },
          entryFile: { type: "string", description: "Entry file, default index.html." },
          profile: { type: "string", enum: ["static_html"], description: "Validation profile. Only static_html is supported in v1." },
          browserValidation: { type: "boolean", description: "Run browser validation after publish. Defaults to true." },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" }
              },
              required: ["path", "content"],
              additionalProperties: false
            },
            description: "Text project files to write."
          }
        },
        required: ["title", "files"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: deliverStaticProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof deliverStaticProjectInputSchema>;
      const project = await createProject(ctx.projectRoot, {
        title: parsed.title,
        summary: parsed.summary,
        entryFile: parsed.entryFile,
        createdByClientId: ctx.clientId
      });
      const files = [];
      for (const fileInput of parsed.files) {
        files.push(await writeProjectFile(ctx.projectRoot, project.id, fileInput.path, fileInput.content));
      }

      const validation = await validateProject(ctx.projectRoot, project.id, parsed.entryFile, parsed.profile);
      if (!validation.ok) {
        const report = {
          ok: false,
          projectId: project.id,
          entryFile: validation.entryFile,
          files,
          validation,
          nextActions: ["Fix static validation errors, then call publish_and_report or deliver_static_project again."]
        };
        await appendProjectTaskHistory(ctx.projectRoot, project.id, {
          toolName: "deliver_static_project",
          ok: false,
          summary: `Static validation blocked delivery for ${project.id}.`,
          details: report
        });
        return {
          ok: false,
          summary: `Static validation blocked delivery for ${project.id}.`,
          jobId: project.id,
          artifacts: files.map((file) => file.path),
          structuredContent: report,
          logs: [JSON.stringify(report, null, 2)],
          errors: validation.errors
        };
      }

      const published = await publishProject(ctx.projectRoot, project.id, ctx.publicBaseUrl, validation.entryFile, { shareBasePath: ctx.publicShareBasePath });
      let browserInspection: Record<string, unknown> | undefined;
      let inspectionReportUrl: string | undefined;
      if (parsed.browserValidation) {
        const browserResults = await inspectWebpageUrl(published.publishedUrl!, {
          viewports: ["desktop", "tablet", "mobile"],
          waitUntil: "networkidle",
          screenshot: true,
          fullPage: false,
          maxIssues: 12
        });
        const inspectionReport = renderWebpageInspectionReport(published.publishedUrl!, browserResults);
        const inspectionShare = await createShareArtifact({
          shareRoot: ctx.shareRoot,
          title: "Delivery Browser Inspection Report",
          summary: `Browser validation for ${project.id}.`,
          filename: `delivery-inspection-${project.id}.html`,
          html: inspectionReport
        });
        inspectionReportUrl = makeShareUrl(ctx.publicBaseUrl, inspectionShare.id, inspectionShare.filename);
        const inspectionWithoutScreenshots = withoutScreenshots(browserResults);
        const inspectionSummary = {
          ...summarizeBrowserInspection(inspectionWithoutScreenshots),
          reportUrl: inspectionReportUrl,
          inspectedAt: new Date().toISOString()
        };
        browserInspection = inspectionSummary as unknown as Record<string, unknown>;
        await recordProjectBrowserInspection(ctx.projectRoot, project.id, inspectionSummary, "deliver_static_project_browser_validation");
        if (!inspectionSummary.ok) {
          await unpublishProject(ctx.projectRoot, project.id, `Browser validation blocked delivery for ${project.id}.`);
          const report = {
            ok: false,
            projectId: project.id,
            entryFile: validation.entryFile,
            files,
            validation: { ...validation, browserInspection: inspectionSummary },
            browserInspection: inspectionSummary,
            inspectionReportUrl,
            nextActions: ["Fix browser validation errors, then run deliver_static_project again."]
          };
          await appendProjectTaskHistory(ctx.projectRoot, project.id, {
            toolName: "deliver_static_project",
            ok: false,
            summary: `Browser validation blocked delivery for ${project.id}.`,
            details: report
          });
          return {
            ok: false,
            summary: `Browser validation blocked delivery for ${project.id}.`,
            jobId: project.id,
            artifacts: [inspectionReportUrl, ...files.map((file) => file.path)],
            structuredContent: report,
            logs: [JSON.stringify(report, null, 2)],
            errors: inspectionSummary.blockingErrors
          };
        }
      }

      const report = {
        ok: true,
        projectId: project.id,
        publishedUrl: published.publishedUrl,
        entryFile: published.entryFile,
        files,
        validation,
        browserInspection,
        inspectionReportUrl,
        nextActions: [
          `Return this public URL to the user: ${published.publishedUrl}`,
          `If the user wants this to be the site homepage at the root URL, call set_homepage with projectId "${project.id}" (admin only).`
        ]
      };
      await appendProjectTaskHistory(ctx.projectRoot, project.id, {
        toolName: "deliver_static_project",
        ok: true,
        summary: `Delivered static project ${project.id}.`,
        details: report
      });
      return {
        ok: true,
        summary: `Delivered static project ${project.id}.`,
        jobId: project.id,
        previewUrl: published.publishedUrl,
        shareUrl: published.publishedUrl,
        artifacts: [published.publishedUrl!, ...(inspectionReportUrl ? [inspectionReportUrl] : []), ...files.map((file) => file.path)],
        structuredContent: report,
        logs: [JSON.stringify(report, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "screenshot_project",
      description: "Publish or reuse a project preview and capture desktop/tablet/mobile screenshots as image artifacts for visual QA.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          entryFile: { type: "string", description: "Entry file to inspect. Defaults to project entryFile." },
          viewports: { type: "array", items: { type: "string", enum: ["desktop", "tablet", "mobile"] } },
          fullPage: { type: "boolean", description: "Capture full-page screenshots." },
          timeoutMs: { type: "number", minimum: 1000, maximum: 120000 }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: screenshotProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof screenshotProjectInputSchema>;
      const published = await publishProject(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, parsed.entryFile, { shareBasePath: ctx.publicShareBasePath });
      const results = await inspectWebpageUrl(published.publishedUrl!, {
        viewports: parsed.viewports,
        waitUntil: "networkidle",
        screenshot: true,
        fullPage: parsed.fullPage,
        timeoutMs: parsed.timeoutMs,
        maxIssues: 12
      });
      const screenshotUrls: string[] = [];
      for (const result of results) {
        if (!result.screenshotDataUrl) continue;
        const screenshot = bufferFromDataUrl(result.screenshotDataUrl);
        const artifact = await createArtifact({
          artifactRoot: ctx.artifactRoot,
          filename: `${parsed.projectId}-${result.viewport}-screenshot.jpg`,
          contentType: screenshot.contentType,
          content: screenshot.buffer
        });
        const screenshotUrl = makeArtifactUrl(ctx.publicBaseUrl, artifact.id, artifact.filename);
        result.screenshotUrl = screenshotUrl;
        screenshotUrls.push(screenshotUrl);
      }
      const reportHtml = renderWebpageInspectionReport(published.publishedUrl!, results);
      const reportShare = await createShareArtifact({
        shareRoot: ctx.shareRoot,
        title: "Project Screenshot Inspection",
        summary: `Screenshot inspection for ${parsed.projectId}.`,
        filename: `project-screenshots-${parsed.projectId}.html`,
        html: reportHtml
      });
      const reportUrl = makeShareUrl(ctx.publicBaseUrl, reportShare.id, reportShare.filename);
      const resultForLogs = withoutScreenshots(results);
      const inspection = { ...summarizeBrowserInspection(resultForLogs), reportUrl, screenshotUrls, inspectedAt: new Date().toISOString() };
      await recordProjectBrowserInspection(ctx.projectRoot, parsed.projectId, inspection, "screenshot_project");
      return {
        ok: inspection.ok,
        summary: inspection.ok
          ? `Captured ${screenshotUrls.length} screenshot(s) for project ${parsed.projectId}.`
          : `Captured screenshots for project ${parsed.projectId}; visual/runtime issues were found.`,
        jobId: parsed.projectId,
        previewUrl: reportUrl,
        shareUrl: reportUrl,
        artifacts: [reportUrl, ...screenshotUrls],
        structuredContent: inspection as unknown as Record<string, unknown>,
        logs: [JSON.stringify(inspection, null, 2)],
        errors: inspection.blockingErrors
      };
    }
  },
  {
    definition: {
      name: "run_project_fix_loop",
      description: "Apply up to five exact project file patch batches, validating and optionally browser-inspecting after each iteration, then return a repair loop report with pass/fail stop reason.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          entryFile: { type: "string", description: "Entry file to validate/publish. Defaults to project entryFile." },
          maxIterations: { type: "number", minimum: 1, maximum: 5 },
          browserValidation: { type: "boolean", description: "Publish and inspect with Chromium after validation passes. Defaults to true." },
          stopOnFirstPassing: { type: "boolean", description: "Stop once validation/browser inspection passes. Defaults to true." },
          fixes: {
            type: "array",
            description: "Ordered patch batches. Iteration N applies fixes[N-1], then validates and inspects.",
            items: {
              type: "object",
              properties: {
                relativePath: { type: "string" },
                operations: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      find: { type: "string" },
                      replace: { type: "string" },
                      all: { type: "boolean" }
                    },
                    required: ["find", "replace"],
                    additionalProperties: false
                  }
                }
              },
              required: ["relativePath", "operations"],
              additionalProperties: false
            }
          }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: runProjectFixLoopInputSchema,
    handler: async (input, ctx) => {
      const parsed = runProjectFixLoopInputSchema.parse(input);
      const attempts: Array<Record<string, unknown>> = [];
      let passed = false;
      let stopReason = "max_iterations_reached";
      const iterations = Math.min(parsed.maxIterations, Math.max(1, parsed.fixes.length || 1));

      for (let index = 0; index < iterations; index += 1) {
        const fix = parsed.fixes[index];
        const attempt: Record<string, unknown> = {
          iteration: index + 1,
          startedAt: new Date().toISOString(),
          appliedPatch: false
        };
        if (fix) {
          const file = await patchProjectFile(ctx.projectRoot, parsed.projectId, fix.relativePath, fix.operations);
          attempt.appliedPatch = true;
          attempt.patchedFile = file.path;
          attempt.operationCount = fix.operations.length;
        }

        const validation = await validateProject(ctx.projectRoot, parsed.projectId, parsed.entryFile, "static_html");
        attempt.validation = validation;
        if (!validation.ok) {
          attempt.ok = false;
          attempt.stopReason = "validation_failed";
          attempts.push(attempt);
          if (!parsed.fixes[index + 1]) {
            stopReason = "validation_failed";
            break;
          }
          continue;
        }

        if (parsed.browserValidation) {
          const published = await publishProject(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, validation.entryFile, { shareBasePath: ctx.publicShareBasePath });
          attempt.publishedUrl = published.publishedUrl;
          const browserResults = await inspectWebpageUrl(published.publishedUrl!, {
            viewports: ["desktop", "tablet", "mobile"],
            waitUntil: "networkidle",
            screenshot: true,
            fullPage: false,
            maxIssues: 12
          });
          const inspectionWithoutScreenshots = withoutScreenshots(browserResults);
          const inspection = {
            ...summarizeBrowserInspection(inspectionWithoutScreenshots),
            inspectedAt: new Date().toISOString()
          };
          await recordProjectBrowserInspection(ctx.projectRoot, parsed.projectId, inspection, "run_project_fix_loop");
          attempt.browserInspection = inspection;
          attempt.ok = inspection.ok;
          if (!inspection.ok) {
            attempts.push(attempt);
            if (!parsed.fixes[index + 1]) {
              stopReason = "browser_validation_failed";
              break;
            }
            continue;
          }
        } else {
          attempt.ok = true;
        }

        attempts.push(attempt);
        passed = true;
        stopReason = "passed";
        if (parsed.stopOnFirstPassing) break;
      }

      if (!passed && parsed.fixes.length === 0) stopReason = "no_fixes_supplied";
      const report = {
        ok: passed,
        projectId: parsed.projectId,
        entryFile: parsed.entryFile,
        maxIterations: parsed.maxIterations,
        browserValidation: parsed.browserValidation,
        stopReason,
        attempts,
        nextActions: passed
          ? ["Return the project URL/report to the user, or continue with screenshot/visual review if requested."]
          : ["Review the latest validation/browser findings, provide another exact patch batch, then run run_project_fix_loop again."]
      };
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, {
        toolName: "run_project_fix_loop",
        ok: passed,
        summary: passed ? `Project fix loop passed for ${parsed.projectId}.` : `Project fix loop stopped for ${parsed.projectId}: ${stopReason}.`,
        details: report
      });
      return {
        ok: passed,
        summary: passed ? `Project fix loop passed for ${parsed.projectId}.` : `Project fix loop stopped: ${stopReason}.`,
        jobId: parsed.projectId,
        artifacts: [],
        structuredContent: report,
        logs: [JSON.stringify(report, null, 2)],
        errors: passed ? [] : [stopReason]
      };
    }
  },
  {
    definition: {
      name: "read_project_file",
      description: "Read a UTF-8 file from a persistent project.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, relativePath: { type: "string" }, maxBytes: { type: "number", minimum: 1, maximum: 1048576 } }, required: ["projectId", "relativePath"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: readProjectFileInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof readProjectFileInputSchema>;
      const content = await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.relativePath, parsed.maxBytes);
      return { ok: true, summary: `Read ${parsed.relativePath} from project ${parsed.projectId}.`, jobId: parsed.projectId, artifacts: [parsed.relativePath], logs: [content], errors: [] };
    }
  },
  {
    definition: {
      name: "delete_project_file",
      description: "Delete one file from a persistent project.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, relativePath: { type: "string" }, confirm: { type: "boolean", description: "Set true to confirm delete." } }, required: ["projectId", "relativePath", "confirm"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: deleteProjectFileInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof deleteProjectFileInputSchema>;
      await deleteProjectFile(ctx.projectRoot, parsed.projectId, parsed.relativePath);
      return { ok: true, summary: `Deleted ${parsed.relativePath} from project ${parsed.projectId}.`, jobId: parsed.projectId, artifacts: [parsed.relativePath], logs: [], errors: [] };
    }
  },
  {
    definition: {
      name: "validate_project",
      description: "Validate a project before delivery. Checks entry file, safe paths, file sizes, basic HTML structure, and whether a public URL can be generated.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          entryFile: { type: "string", description: "Entry file to validate. Defaults to project entryFile." },
          profile: { type: "string", enum: ["static_html"], description: "Validation profile. Only static_html is supported in v1." }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: validateProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof validateProjectInputSchema>;
      const validation = await validateProject(ctx.projectRoot, parsed.projectId, parsed.entryFile, parsed.profile);
      return {
        ok: validation.ok,
        summary: validation.ok
          ? `Project ${parsed.projectId} validation passed.`
          : `Project ${parsed.projectId} validation failed.`,
        jobId: parsed.projectId,
        artifacts: [validation.entryFile],
        structuredContent: validation as unknown as Record<string, unknown>,
        logs: [JSON.stringify(validation, null, 2)],
        errors: validation.errors
      };
    }
  },
  {
    definition: {
      name: "audit_project_pwa",
      description: "Audit a static project for PWA, iOS, and Android readiness: manifest, service worker, offline page, installability, icons, theme color, safe-area CSS, viewport meta, and offline/update UI signals.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          entryFile: { type: "string", description: "Entry HTML file to inspect. Defaults to the project entryFile." }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: auditProjectPwaInputSchema,
    handler: async (input, ctx) => {
      const parsed = auditProjectPwaInputSchema.parse(input);
      const report = await auditProjectPwa(ctx, parsed.projectId, parsed.entryFile);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, {
        toolName: "audit_project_pwa",
        ok: report.ok,
        summary: report.ok ? `PWA audit passed for ${parsed.projectId}.` : `PWA audit found ${report.errors.length} error(s) for ${parsed.projectId}.`,
        details: report
      });
      return {
        ok: report.ok,
        summary: report.ok ? `PWA audit passed for ${parsed.projectId}.` : `PWA audit found ${report.errors.length} error(s) and ${(report.summary as { warnings: number }).warnings} warning(s).`,
        jobId: parsed.projectId,
        artifacts: [],
        structuredContent: report,
        logs: [JSON.stringify(report, null, 2)],
        errors: report.errors
      };
    }
  },
  {
    definition: {
      name: "generate_project_test_plan",
      description: "Generate reusable smoke, interaction, responsive, accessibility, regression, and PWA test cases from a Project's files; optionally writes tests/project-test-plan.json and .md artifacts into the project.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          entryFile: { type: "string", description: "Entry HTML file to analyze. Defaults to project entryFile." },
          includePwaChecks: { type: "boolean", description: "Include audit_project_pwa checks. Defaults to true." },
          includeArtifacts: { type: "boolean", description: "Write tests/project-test-plan.json and tests/project-test-plan.md into the project. Defaults to true." },
          maxCases: { type: "number", minimum: 5, maximum: 80 }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: generateProjectTestPlanInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateProjectTestPlanInputSchema.parse(input);
      const plan = await generateProjectTestPlan(ctx, parsed);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, {
        toolName: "generate_project_test_plan",
        ok: true,
        summary: `Generated ${(plan.testCases as unknown[]).length} project test case(s) for ${parsed.projectId}.`,
        details: { testCaseCount: (plan.testCases as unknown[]).length, artifacts: parsed.includeArtifacts ? ["tests/project-test-plan.json", "tests/project-test-plan.md"] : [] }
      });
      return {
        ok: true,
        summary: `Generated ${(plan.testCases as unknown[]).length} project test case(s).`,
        jobId: parsed.projectId,
        artifacts: parsed.includeArtifacts ? ["tests/project-test-plan.json", "tests/project-test-plan.md"] : [],
        structuredContent: plan,
        logs: [JSON.stringify(plan, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "publish_project",
      description: "Publish a project entry file and return a public share URL.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, entryFile: { type: "string", description: "Entry file to publish. Defaults to project entryFile." } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: publishProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof publishProjectInputSchema>;
      const project = await publishProject(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, parsed.entryFile, { shareBasePath: ctx.publicShareBasePath });
      return { ok: true, summary: `Published project ${parsed.projectId}.`, jobId: parsed.projectId, previewUrl: project.publishedUrl, shareUrl: project.publishedUrl, artifacts: [project.entryFile], logs: [JSON.stringify(project, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "publish_and_report",
      description: "Recommended ChatGPT project delivery tool. Validate the project, publish it if valid, and return a stable public URL plus structured delivery report.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          entryFile: { type: "string", description: "Entry file to publish. Defaults to project entryFile." }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: validateProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof validateProjectInputSchema>;
      const report = await publishProjectAndReport(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, parsed.entryFile, { shareBasePath: ctx.publicShareBasePath });
      return {
        ok: report.ok,
        summary: report.summary,
        jobId: report.projectId,
        previewUrl: report.publishedUrl,
        shareUrl: report.publishedUrl,
        artifacts: report.files.map((file) => file.path),
        structuredContent: report as unknown as Record<string, unknown>,
        logs: [JSON.stringify(report, null, 2)],
        errors: report.validation.errors
      };
    }
  },
  {
    definition: {
      name: "delete_project",
      description: "Soft-delete a persistent project. Disabled by default in admin tool access.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, confirm: { type: "boolean", description: "Set true to confirm delete." } }, required: ["projectId", "confirm"], additionalProperties: false }
    },
    enabledByDefault: false,
    schema: deleteProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof deleteProjectInputSchema>;
      const project = await deleteProject(ctx.projectRoot, parsed.projectId);
      return { ok: true, summary: `Soft-deleted project ${parsed.projectId}.`, jobId: parsed.projectId, artifacts: [], logs: [JSON.stringify(project, null, 2)], errors: [] };
    }
  }
];
