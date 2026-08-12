import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolContext, ToolModule, ToolResult } from "../types.js";
import {
  cancelJobForOwnerFresh,
  flushJobPersistence,
  getJob,
  getJobForOwnerFresh,
  listJobsForOwnerFresh,
  saveJob,
  updateJob,
  type JobEstimatedWorkload,
  type JobExecutionClass,
  type JobRecord
} from "../../jobs/store.js";
import { isJobDatabaseEnabled } from "../../jobs/database.js";
import { createProject, getProjectActivity, getProjectTaskGraph, listProjects, upsertProjectTask, type ProjectTaskGraphNode } from "../../projects/store.js";

// Tools that can blow past a proxy's request timeout (Cloudflare cuts proxied HTTP requests
// at ~100s -> 524). Only these may be run via run_tool_async. Fast tools have no reason to go
// async and should not, so the surface stays small and predictable.
export const asyncEligibleTools = [
  "run_project_build",
  "run_project_npm_command",
  "record_project_workspace_video",
  "capture_webpage",
  "publish_project_workspace",
  "inspect_project_workspace",
  "screenshot_project",
  "deliver_static_project",
  "publish_project_dist",
  "analyze_webpage_visual",
  "render_midi_with_soundfont",
  "render_production_music",
  "create_music_production"
] as const;
const asyncEligibleSet = new Set<string>(asyncEligibleTools);
const asyncMusicRenderTools = new Set<string>(["render_midi_with_soundfont", "render_production_music", "create_music_production"]);
const activeByClass = new Map<"browser" | "build" | "audio", number>();
const activeByUser = new Map<string, number>();
const activeJobControllers = new Map<string, AbortController>();
const pendingJobs: Array<{ jobId: string; name: string; args: Record<string, unknown>; ctx: ToolContext; timeoutMs?: number }> = [];
const concurrencyByClass = { browser: 2, build: 2, audio: 1 } as const;
const maxConcurrentJobsPerUser = 2;

const runToolAsyncSchema = z.object({
  name: z.enum(asyncEligibleTools),
  arguments: z.record(z.unknown()).default({}),
  timeoutMs: z.number().int().min(1000).max(30 * 60 * 1000).optional(),
  maxAttempts: z.number().int().min(1).max(5).optional().default(1)
});

const getJobStatusSchema = z.object({
  jobId: z.string().min(1).max(200)
});

const listBackgroundJobsSchema = z.object({
  status: z.enum(["created", "running", "success", "error", "cancelled", "timeout"]).optional(),
  sourceToolName: z.string().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(500).optional().default(100)
});

const cancelBackgroundJobSchema = z.object({
  jobId: z.string().min(1).max(200),
  reason: z.string().min(1).max(500).optional().default("Cancelled by request.")
});

const retryBackgroundJobSchema = z.object({
  jobId: z.string().min(1).max(200),
  timeoutMs: z.number().int().min(1000).max(30 * 60 * 1000).optional()
});

const recoverJobPartialResultSchema = z.object({
  jobId: z.string().min(1).max(200)
});

const diagnoseCodeMcpStatusSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  latestUserIntent: z.string().min(1).max(500).optional(),
  autoStartWhenIdle: z.boolean().optional().default(false)
});

function terminal(status: JobRecord["status"]): boolean {
  return status === "success" || status === "error" || status === "cancelled" || status === "timeout";
}

function isMusicRenderJob(name: string): boolean {
  return asyncMusicRenderTools.has(name);
}

export function isAsyncEligibleTool(name: string): name is (typeof asyncEligibleTools)[number] {
  return asyncEligibleSet.has(name);
}

export function executionClass(name: string): JobExecutionClass {
  if (isMusicRenderJob(name)) return "audio";
  if (["record_project_workspace_video", "capture_webpage", "inspect_project_workspace", "screenshot_project", "analyze_webpage_visual", "deliver_static_project"].includes(name)) return "browser";
  return "build";
}

function canStart(entry: (typeof pendingJobs)[number]): boolean {
  const kind = executionClass(entry.name);
  const userKey = entry.ctx.userId ?? "legacy";
  return (activeByClass.get(kind) ?? 0) < concurrencyByClass[kind]
    && (activeByUser.get(userKey) ?? 0) < maxConcurrentJobsPerUser;
}

function drainPendingJobs(): void {
  for (let index = 0; index < pendingJobs.length;) {
    const entry = pendingJobs[index]!;
    if (!canStart(entry)) {
      index += 1;
      continue;
    }
    pendingJobs.splice(index, 1);
    const kind = executionClass(entry.name);
    const userKey = entry.ctx.userId ?? "legacy";
    activeByClass.set(kind, (activeByClass.get(kind) ?? 0) + 1);
    activeByUser.set(userKey, (activeByUser.get(userKey) ?? 0) + 1);
    void runQueuedJob(entry.jobId, entry.name, entry.args, entry.ctx, entry.timeoutMs).finally(() => {
      activeByClass.set(kind, Math.max(0, (activeByClass.get(kind) ?? 1) - 1));
      activeByUser.set(userKey, Math.max(0, (activeByUser.get(userKey) ?? 1) - 1));
      drainPendingJobs();
    });
  }
}

function finitePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function estimateMusicRenderWorkload(args: Record<string, unknown>): JobEstimatedWorkload {
  const targetDurationSeconds = finitePositiveNumber(args.targetDurationSeconds)
    ?? finitePositiveNumber(args.targetDurationSec)
    ?? finitePositiveNumber(args.durationSeconds);
  const complexity = targetDurationSeconds === undefined
    ? "unknown"
    : targetDurationSeconds >= 10 * 60
      ? "long"
      : targetDurationSeconds >= 2 * 60
        ? "standard"
        : "short";
  return {
    kind: "music_render",
    complexity,
    ...(targetDurationSeconds === undefined ? {} : { targetDurationSeconds })
  };
}

type MusicRenderStage = "queued" | "running" | "completed" | "error" | "timeout" | "cancelled";

export function musicRenderProgress(stage: MusicRenderStage, currentProgress = 0): Pick<JobRecord, "progressPercent" | "stage"> {
  if (stage === "queued") return { progressPercent: 0, stage };
  if (stage === "running") return { progressPercent: Math.max(currentProgress, 10), stage };
  if (stage === "completed") return { progressPercent: 100, stage };
  return { progressPercent: currentProgress, stage };
}

function musicProgressForJob(jobId: string, name: string, stage: MusicRenderStage): Pick<JobRecord, "progressPercent" | "stage"> {
  if (!isMusicRenderJob(name)) return {};
  return musicRenderProgress(stage, getJob(jobId)?.progressPercent ?? 0);
}

async function authorizeJobFresh(jobId: string, ctx: ToolContext): Promise<JobRecord | undefined> {
  return getJobForOwnerFresh(jobId, ctx.userId);
}

// Not-found and not-owned are reported identically so the job-id space cannot be enumerated
// across tenants (a different error for "exists but not yours" would leak existence).
function jobNotFound(jobId: string): ToolResult {
  return {
    ok: false,
    summary: `No background job found for ${jobId}.`,
    artifacts: [],
    logs: [],
    errors: [`Unknown jobId: ${jobId}. It may have been pruned after the retention window, or the id is wrong.`]
  };
}

function safeUpdateRunningJob(jobId: string, update: Partial<Omit<JobRecord, "id" | "createdAt">>): void {
  const current = getJob(jobId);
  if (!current || terminal(current.status)) return;
  updateJob(jobId, update);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Background job was cancelled.");
}

// Runs the wrapped tool to completion in the background and folds its ToolResult into the job
// record. Dynamic import of the router avoids a module-init cycle (router -> registry ->
// tools/index -> this module).
export async function runQueuedJob(
  jobId: string,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  timeoutMs?: number,
  parentSignal: AbortSignal | undefined = ctx.abortSignal
): Promise<void> {
  const controller = new AbortController();
  activeJobControllers.set(jobId, controller);
  const onParentAbort = () => controller.abort(abortReason(parentSignal!));
  if (parentSignal?.aborted) controller.abort(abortReason(parentSignal));
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  let timedOut = false;
  const timeout = timeoutMs ? setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Timeout after ${timeoutMs}ms.`));
  }, timeoutMs) : undefined;
  try {
    const current = getJob(jobId);
    if (!current || terminal(current.status)) return;
    updateJob(jobId, {
      status: "running",
      summary: `Running ${name} in the background...`,
      startedAt: new Date().toISOString(),
      ...musicProgressForJob(jobId, name, "running")
    });
    await flushJobPersistence(jobId);
    if (controller.signal.aborted) throw abortReason(controller.signal);
    // Re-check enablement at run time, not just at submit time: a tool may have been disabled
    // between submit and this deferred execution.
    const { isToolEffectivelyEnabled } = await import("../../tool-state.js");
    if (!isToolEffectivelyEnabled(name)) {
      safeUpdateRunningJob(jobId, {
        status: "error",
        summary: `${name} was disabled before it ran.`,
        errors: [`Tool ${name} is disabled.`],
        completedAt: new Date().toISOString(),
        ...musicProgressForJob(jobId, name, "error")
      });
      return;
    }
    const { callTool } = await import("../router.js");
    const result = await callTool(name, args, { ...ctx, abortSignal: controller.signal });
    if (controller.signal.aborted) throw abortReason(controller.signal);
    safeUpdateRunningJob(jobId, {
      status: result.ok ? "success" : "error",
      summary: result.summary,
      logs: result.logs ?? [],
      artifacts: result.artifacts ?? [],
      errors: result.errors ?? [],
      completedAt: new Date().toISOString(),
      ...musicProgressForJob(jobId, name, result.ok ? "completed" : "error")
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Async tool execution failed.";
    const cancelled = controller.signal.aborted && !timedOut;
    safeUpdateRunningJob(jobId, {
      status: timedOut ? "timeout" : cancelled ? "cancelled" : "error",
      summary: timedOut ? `${name} timed out after ${timeoutMs}ms.` : cancelled ? `${name} was cancelled.` : `${name} failed.`,
      errors: [message],
      completedAt: new Date().toISOString(),
      ...(cancelled ? { cancelledAt: new Date().toISOString() } : {}),
      ...musicProgressForJob(jobId, name, timedOut ? "timeout" : cancelled ? "cancelled" : "error")
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
    if (activeJobControllers.get(jobId) === controller) activeJobControllers.delete(jobId);
  }
}

function startJob(jobId: string, name: string, args: Record<string, unknown>, ctx: ToolContext, timeoutMs?: number): void {
  // Queueing protects the event loop and expensive external runtimes. The job remains in
  // `created` until a slot is available, which also makes congestion observable to clients.
  if (isJobDatabaseEnabled()) return;
  pendingJobs.push({ jobId, name, args, ctx, timeoutMs });
  drainPendingJobs();
}

export async function enqueueToolAsync(
  input: { name: string; arguments?: unknown; timeoutMs?: number; maxAttempts?: number },
  ctx: ToolContext
): Promise<ToolResult> {
  if (!isAsyncEligibleTool(input.name)) {
    throw new Error(`Tool ${input.name} is not eligible for async execution. Eligible: ${asyncEligibleTools.join(", ")}.`);
  }
  const parsed = runToolAsyncSchema.parse({
    name: input.name,
    arguments: input.arguments ?? {},
    timeoutMs: input.timeoutMs,
    maxAttempts: input.maxAttempts
  });
  const { isToolEffectivelyEnabled } = await import("../../tool-state.js");
  if (!isToolEffectivelyEnabled(parsed.name)) {
    throw new Error(`Tool ${parsed.name} is disabled and cannot be run asynchronously.`);
  }
  const jobId = `job_${randomUUID()}`;
  const now = new Date().toISOString();
  const musicRender = isMusicRenderJob(parsed.name);
  const initialProgress = musicRender ? musicRenderProgress("queued") : { progressPercent: 0, stage: "queued" };
  saveJob({
    id: jobId,
    status: "created",
    ownerUserId: ctx.userId,
    title: parsed.name,
    summary: `Queued ${parsed.name} for background execution.`,
    logs: [], artifacts: [], errors: [],
    sourceToolName: parsed.name,
    sourceArgs: parsed.arguments,
    attempt: 1,
    maxAttempts: parsed.maxAttempts,
    timeoutMs: parsed.timeoutMs,
    executionClass: executionClass(parsed.name),
    ...initialProgress,
    ...(musicRender ? { estimatedWorkload: estimateMusicRenderWorkload(parsed.arguments) } : {}),
    createdAt: now,
    updatedAt: now
  });
  await flushJobPersistence(jobId);
  startJob(jobId, parsed.name, parsed.arguments, ctx, parsed.timeoutMs);
  const statusUrl = `${ctx.publicBaseUrl.replace(/\/$/, "")}/outcome/${jobId}`;
  return {
    ok: true,
    summary: `Queued ${parsed.name} as background job ${jobId}. Poll get_job_status until it reaches a terminal status.`,
    jobId,
    previewUrl: statusUrl,
    artifacts: [],
    structuredContent: { jobId, status: "created", statusUrl, tool: parsed.name, timeoutMs: parsed.timeoutMs, maxAttempts: parsed.maxAttempts, queue: { class: executionClass(parsed.name), maxConcurrentPerUser: maxConcurrentJobsPerUser }, ...initialProgress, ...(musicRender ? { estimatedWorkload: estimateMusicRenderWorkload(parsed.arguments) } : {}) },
    logs: [`Background job ${jobId} queued for ${parsed.name}.`],
    errors: []
  };
}

function summarizeJobs(jobs: JobRecord[]) {
  const running = jobs.filter((job) => job.status === "created" || job.status === "running");
  const failed = jobs.filter((job) => job.status === "error" || job.status === "cancelled" || job.status === "timeout");
  const succeeded = jobs.filter((job) => job.status === "success");
  return {
    count: jobs.length,
    running: running.map(jobSummary),
    failed: failed.map(jobSummary),
    succeeded: succeeded.map(jobSummary),
    latest: jobs[0] ? jobSummary(jobs[0]) : undefined
  };
}

function jobSummary(job: JobRecord) {
  return {
    id: job.id,
    status: job.status,
    title: job.title,
    summary: job.summary,
    sourceToolName: job.sourceToolName,
    progressPercent: job.progressPercent,
    stage: job.stage,
    estimatedWorkload: job.estimatedWorkload,
    updatedAt: job.updatedAt,
    canRetry: Boolean(job.sourceToolName && job.sourceArgs && terminal(job.status) && (!job.maxAttempts || (job.attempt ?? 1) < job.maxAttempts))
  };
}

function taskSummary(task: ProjectTaskGraphNode | undefined) {
  return task ? {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    progress: task.progress,
    blocked: task.blocked,
    blockedReasons: task.blockedReasons,
    updatedAt: task.updatedAt
  } : undefined;
}

function initialTaskTitle(intent: string | undefined): string {
  if (!intent?.trim()) return "Define project goal and first implementation step";
  const normalized = intent.trim().replace(/\s+/g, " ");
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

export const asyncJobTools: ToolModule[] = [
  {
    definition: {
      name: "run_tool_async",
      description:
        "Run a long-running tool in the background and return a jobId immediately, instead of blocking the request. Use this for tools that may exceed ~100 seconds (build, npm install, video recording, webpage capture, or music rendering) to avoid proxy/gateway timeouts (e.g. Cloudflare 524). Poll get_job_status with the returned jobId until it reaches a terminal status. Only long-running tools are eligible.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", enum: [...asyncEligibleTools], description: "The long-running tool to execute." },
          arguments: { type: "object", description: "The arguments object for that tool." },
          timeoutMs: { type: "number", description: "Optional background timeout in milliseconds." },
          maxAttempts: { type: "number", description: "Retry budget metadata for agents. Defaults to 1." }
        },
        required: ["name"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: runToolAsyncSchema,
    handler: (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = input as z.infer<typeof runToolAsyncSchema>;
      return enqueueToolAsync(parsed, ctx);
    }
  },
  {
    definition: {
      name: "get_job_status",
      description:
        "Get the current status and result of a background job started with run_tool_async. Returns the full job record, including coarse progress/stage metadata when available, plus logs, artifacts, and errors. Poll until the status is terminal.",
      inputSchema: {
        type: "object",
        properties: { jobId: { type: "string", description: "The jobId returned by run_tool_async." } },
        required: ["jobId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: getJobStatusSchema,
    handler: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = input as z.infer<typeof getJobStatusSchema>;
      const job = await authorizeJobFresh(parsed.jobId, ctx);
      if (!job) {
        return jobNotFound(parsed.jobId);
      }
      const done = terminal(job.status);
      return {
        ok: job.status !== "error" && job.status !== "cancelled" && job.status !== "timeout",
        summary: done ? job.summary : `Job ${job.id} is still ${job.status}.`,
        jobId: job.id,
        artifacts: job.artifacts,
        structuredContent: { job, done },
        logs: job.logs,
        errors: job.errors
      };
    }
  },
  {
    definition: {
      name: "list_background_jobs",
      description: "List background jobs, optionally filtered by status or source tool, newest first.",
      inputSchema: { type: "object", properties: { status: { type: "string" }, sourceToolName: { type: "string" }, limit: { type: "number" } }, required: [], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listBackgroundJobsSchema,
    handler: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = listBackgroundJobsSchema.parse(input);
      const jobs = await listJobsForOwnerFresh(ctx.userId, parsed);
      return { ok: true, summary: `Found ${jobs.length} background job(s).`, artifacts: [], structuredContent: { jobs, count: jobs.length }, logs: jobs.map((job) => `${job.id} ${job.status} ${job.title}: ${job.summary}`), errors: [] };
    }
  },
  {
    definition: {
      name: "diagnose_code_mcp_status",
      description:
        "Diagnose current Code-MCP work status across background jobs and app project tasks. Use this when the user asks what is happening, why work stopped, whether it can continue, or what tool to call next. Optionally starts a new project/task only when autoStartWhenIdle=true and there is nothing resumable.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Optional project id to inspect." },
          latestUserIntent: { type: "string", description: "Optional latest user goal, used for recommendations or auto-start task seeding." },
          autoStartWhenIdle: { type: "boolean", description: "When true, create a new project and initial task if there is no running job or resumable project task. Defaults to false." }
        },
        required: [],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: diagnoseCodeMcpStatusSchema,
    handler: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = diagnoseCodeMcpStatusSchema.parse(input);
      const jobs = await listJobsForOwnerFresh(ctx.userId, { limit: 20 });
      const jobState = summarizeJobs(jobs);
      const projects = await listProjects(ctx.projectRoot, false);
      const selectedProjectId = parsed.projectId ?? projects[0]?.id;
      let project: {
        id: string;
        title: string;
        status: string;
        publishedUrl?: string;
        lastValidation?: unknown;
        taskCounts: Record<string, number>;
        resumeTask?: ReturnType<typeof taskSummary>;
      } | undefined;
      let resumeTask: ProjectTaskGraphNode | undefined;
      let projectLookupError: { projectId: string; message: string } | undefined;

      if (selectedProjectId) {
        try {
          const activity = await getProjectActivity(ctx.projectRoot, selectedProjectId);
          const graph = await getProjectTaskGraph(ctx.projectRoot, selectedProjectId);
          resumeTask = graph.nodes.find((task) => task.status === "doing" && !task.blocked)
            ?? graph.readyTasks.find((task) => task.status === "todo")
            ?? graph.blockedTasks[0];
          const counts = graph.nodes.reduce<Record<string, number>>((accumulator, task) => {
            accumulator[task.status] = (accumulator[task.status] ?? 0) + 1;
            return accumulator;
          }, {});
          const projectSummary = projects.find((item) => item.id === selectedProjectId);
          project = {
            id: selectedProjectId,
            title: projectSummary?.title ?? selectedProjectId,
            status: activity.status,
            publishedUrl: activity.publishedUrl,
            lastValidation: activity.lastValidation,
            taskCounts: counts,
            resumeTask: taskSummary(resumeTask)
          };
        } catch (error) {
          projectLookupError = {
            projectId: selectedProjectId,
            message: error instanceof Error ? error.message : String(error)
          };
        }
      }

      let state = "idle_no_project";
      let canContinue = false;
      let whyStopped = "No running background job or resumable project task was found.";
      let nextActions: string[] = ["Call create_app_project or provide projectId/latestUserIntent to start work."];
      let createdProject: { projectId: string; title: string } | undefined;
      let createdTask: ReturnType<typeof taskSummary> | undefined;

      if (jobState.running.length > 0) {
        state = "job_running";
        canContinue = true;
        whyStopped = "A background job is still running.";
        nextActions = [`Call get_job_status with jobId=${jobState.running[0].id}.`];
      } else if (resumeTask) {
        state = "project_resume_available";
        canContinue = true;
        whyStopped = resumeTask.blocked ? "The selected project has a blocked unfinished task." : "The selected project has an unfinished task that can be resumed.";
        nextActions = resumeTask.blocked
          ? [`Resolve blocker for task ${resumeTask.id}, then call upsert_project_task or the relevant project tool.`]
          : [`Continue task ${resumeTask.id} with the relevant project tool, then update it via upsert_project_task.`];
      } else if (jobState.failed.length > 0) {
        state = "job_failed";
        canContinue = true;
        whyStopped = `The latest terminal job needing attention is ${jobState.failed[0].status}.`;
        nextActions = [
          `Call recover_job_partial_result with jobId=${jobState.failed[0].id}.`,
          ...(jobState.failed[0].canRetry ? [`Call retry_background_job with jobId=${jobState.failed[0].id} if the partial result is insufficient.`] : [])
        ];
      } else if (projectLookupError) {
        state = "project_not_found";
        whyStopped = `Project ${projectLookupError.projectId} could not be inspected.`;
        nextActions = ["Check the projectId, call list_projects/search_projects_global, or create a new project for the latest user intent."];
      } else if (project) {
        state = "idle_project_complete_or_empty";
        whyStopped = "A project exists, but it has no unfinished resumable task.";
        nextActions = ["Call upsert_project_task to seed the next task, or run the next project workflow tool directly."];
      }

      if (!canContinue && !projectLookupError && parsed.autoStartWhenIdle && !resumeTask && jobState.running.length === 0) {
        const title = parsed.latestUserIntent ? initialTaskTitle(parsed.latestUserIntent) : "Code MCP Work Session";
        const newProject = await createProject(ctx.projectRoot, {
          title,
          summary: parsed.latestUserIntent ?? "Auto-started from diagnose_code_mcp_status.",
          createdByClientId: ctx.clientId,
          entryFile: "index.html"
        });
        const task = await upsertProjectTask(ctx.projectRoot, newProject.id, {
          title: initialTaskTitle(parsed.latestUserIntent),
          status: "todo",
          priority: "medium",
          notes: parsed.latestUserIntent ?? "Initial task seeded by diagnose_code_mcp_status.",
          progress: 0
        });
        state = "new_project_started";
        canContinue = true;
        whyStopped = "No resumable work existed, so a new project and initial task were created because autoStartWhenIdle=true.";
        nextActions = [`Continue task ${task.id} in project ${newProject.id}.`];
        createdProject = { projectId: newProject.id, title: newProject.title };
        createdTask = taskSummary({ ...task, blockedBy: [], blocked: false, dependents: [], blockedReasons: [] });
        project = {
          id: newProject.id,
          title: newProject.title,
          status: newProject.status,
          publishedUrl: newProject.publishedUrl,
          taskCounts: { todo: 1 },
          resumeTask: createdTask
        };
      }

      const result = { state, canContinue, whyStopped, jobs: jobState, project, projectLookupError, createdProject, createdTask, nextActions };
      return {
        ok: true,
        summary: `Code-MCP status: ${state}. ${whyStopped}`,
        artifacts: [createdProject?.projectId, project?.id].filter((value): value is string => Boolean(value)),
        structuredContent: result,
        logs: [JSON.stringify(result, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "cancel_background_job",
      description: "Cancel a queued or running background job. Running tools receive an AbortSignal so supported browser, network, and child-process work stops promptly.",
      inputSchema: { type: "object", properties: { jobId: { type: "string" }, reason: { type: "string" } }, required: ["jobId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: cancelBackgroundJobSchema,
    handler: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = cancelBackgroundJobSchema.parse(input);
      const job = await cancelJobForOwnerFresh(parsed.jobId, ctx.userId, parsed.reason);
      if (!job) return jobNotFound(parsed.jobId);
      activeJobControllers.get(parsed.jobId)?.abort(new Error(parsed.reason));
      const changed = job.status === "cancelled";
      return { ok: changed, summary: changed ? `Cancelled ${parsed.jobId}; the worker will abort supported underlying work.` : `Job ${parsed.jobId} is already terminal (${job.status}).`, jobId: job.id, artifacts: job.artifacts, structuredContent: { job, done: terminal(job.status) }, logs: job.logs, errors: changed ? [] : [`Job is already ${job.status}.`] };
    }
  },
  {
    definition: {
      name: "retry_background_job",
      description: "Retry a background job using its stored source tool and arguments, returning a new jobId linked to the original.",
      inputSchema: { type: "object", properties: { jobId: { type: "string" }, timeoutMs: { type: "number" } }, required: ["jobId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: retryBackgroundJobSchema,
    handler: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = retryBackgroundJobSchema.parse(input);
      // Ownership FIRST — this is the check that closes cross-tenant code execution: without it
      // a tenant could re-run another tenant's stored sourceArgs in their own workspace ctx.
      const previous = await authorizeJobFresh(parsed.jobId, ctx);
      if (!previous) return jobNotFound(parsed.jobId);
      if (!previous.sourceToolName || !previous.sourceArgs) return { ok: false, summary: `Job ${parsed.jobId} has no retry source metadata.`, artifacts: [], logs: [], errors: ["Missing sourceToolName/sourceArgs."] };
      if (!asyncEligibleSet.has(previous.sourceToolName as (typeof asyncEligibleTools)[number])) return { ok: false, summary: `${previous.sourceToolName} is not eligible for async retry.`, artifacts: [], logs: [], errors: [`Ineligible tool: ${previous.sourceToolName}.`] };
      const nextAttempt = (previous.attempt ?? 1) + 1;
      if (previous.maxAttempts && nextAttempt > previous.maxAttempts) return { ok: false, summary: `Retry budget exhausted for ${parsed.jobId}.`, artifacts: previous.artifacts, logs: previous.logs, errors: [`maxAttempts ${previous.maxAttempts} reached.`] };
      const now = new Date().toISOString();
      const jobId = `job_${randomUUID()}`;
      const timeoutMs = parsed.timeoutMs ?? previous.timeoutMs;
      const musicRender = isMusicRenderJob(previous.sourceToolName);
      const initialProgress = musicRender ? musicRenderProgress("queued") : { progressPercent: 0, stage: "queued" };
      const initialStatus = "created";
      saveJob({
        id: jobId,
        status: initialStatus,
        ownerUserId: ctx.userId,
        title: previous.sourceToolName,
        summary: `Retrying ${previous.sourceToolName} from ${parsed.jobId}...`,
        logs: [],
        artifacts: [],
        errors: [],
        sourceToolName: previous.sourceToolName,
        sourceArgs: previous.sourceArgs,
        parentJobId: previous.id,
        attempt: nextAttempt,
        maxAttempts: previous.maxAttempts,
        timeoutMs,
        executionClass: executionClass(previous.sourceToolName),
        ...initialProgress,
        ...(musicRender ? { estimatedWorkload: previous.estimatedWorkload ?? estimateMusicRenderWorkload(previous.sourceArgs) } : {}),
        createdAt: now,
        updatedAt: now
      });
      await flushJobPersistence(jobId);
      startJob(jobId, previous.sourceToolName, previous.sourceArgs, ctx, timeoutMs);
      return { ok: true, summary: `Retry started as ${jobId}.`, jobId, artifacts: [], structuredContent: { jobId, parentJobId: previous.id, attempt: nextAttempt, status: initialStatus, ...initialProgress }, logs: [`Retry ${jobId} started from ${previous.id}.`], errors: [] };
    }
  },
  {
    definition: {
      name: "recover_job_partial_result",
      description: "Recover partial result data from any background job, including logs, artifacts, errors, retry metadata, and suggested next actions.",
      inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: recoverJobPartialResultSchema,
    handler: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = recoverJobPartialResultSchema.parse(input);
      const job = await authorizeJobFresh(parsed.jobId, ctx);
      if (!job) return jobNotFound(parsed.jobId);
      const partial = { logs: job.logs, artifacts: job.artifacts, errors: job.errors, summary: job.summary };
      const canRetry = Boolean(job.sourceToolName && job.sourceArgs && (!job.maxAttempts || (job.attempt ?? 1) < job.maxAttempts));
      const result = {
        job,
        partial,
        canRetry,
        nextActions: [
          ...(job.status === "created" || job.status === "running" ? ["Poll get_job_status again before retrying."] : []),
          ...(canRetry ? ["Call retry_background_job if the partial result is insufficient."] : []),
          ...(job.artifacts.length ? ["Inspect recovered artifacts before repeating expensive work."] : []),
          ...(job.errors.length ? ["Use errors/logs to narrow the next attempt."] : [])
        ]
      };
      return { ok: true, summary: `Recovered partial result for ${job.id}.`, jobId: job.id, artifacts: job.artifacts, structuredContent: result, logs: job.logs, errors: [] };
    }
  }
];
