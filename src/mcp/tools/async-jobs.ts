import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolContext, ToolModule, ToolResult } from "../types.js";
import { cancelJob, getJob, listJobsForOwner, saveJob, updateJob, type JobRecord } from "../../jobs/store.js";

// Tools that can blow past a proxy's request timeout (Cloudflare cuts proxied HTTP requests
// at ~100s -> 524). Only these may be run via run_tool_async. Fast tools have no reason to go
// async and should not, so the surface stays small and predictable.
const asyncEligibleTools = [
  "run_project_build",
  "run_project_npm_command",
  "record_project_workspace_video",
  "capture_webpage",
  "publish_project_workspace",
  "inspect_project_workspace"
] as const;
const asyncEligibleSet = new Set<string>(asyncEligibleTools);

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

function terminal(status: JobRecord["status"]): boolean {
  return status === "success" || status === "error" || status === "cancelled" || status === "timeout";
}

// A job is visible only to the tenant that created it. ctx.userId is the OAuth-bound tenant;
// it is undefined only for the shared legacy/dev-token domain (which also shares the global
// roots), so an exact `===` match is the correct boundary — two real tenants can never both
// be undefined. Returns the resolved job when the caller owns it, otherwise undefined.
function authorizeJob(jobId: string, ctx: ToolContext): JobRecord | undefined {
  const job = getJob(jobId);
  return job && job.ownerUserId === ctx.userId ? job : undefined;
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T | { timeout: true }> {
  if (!timeoutMs) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// Runs the wrapped tool to completion in the background and folds its ToolResult into the job
// record. Dynamic import of the router avoids a module-init cycle (router -> registry ->
// tools/index -> this module).
async function runJob(jobId: string, name: string, args: Record<string, unknown>, ctx: ToolContext, timeoutMs?: number): Promise<void> {
  try {
    const current = getJob(jobId);
    if (!current || terminal(current.status)) return;
    updateJob(jobId, { status: "running", summary: `Running ${name} in the background...` });
    // Re-check enablement at run time, not just at submit time: a tool may have been disabled
    // between submit and this deferred execution.
    const { isToolEffectivelyEnabled } = await import("../../tool-state.js");
    if (!isToolEffectivelyEnabled(name)) {
      safeUpdateRunningJob(jobId, { status: "error", summary: `${name} was disabled before it ran.`, errors: [`Tool ${name} is disabled.`] });
      return;
    }
    const { callTool } = await import("../router.js");
    const result = await withTimeout(callTool(name, args, ctx), timeoutMs);
    if (typeof result === "object" && result && "timeout" in result) {
      safeUpdateRunningJob(jobId, { status: "timeout", summary: `${name} timed out after ${timeoutMs}ms.`, errors: [`Timeout after ${timeoutMs}ms.`] });
      return;
    }
    safeUpdateRunningJob(jobId, {
      status: result.ok ? "success" : "error",
      summary: result.summary,
      logs: result.logs ?? [],
      artifacts: result.artifacts ?? [],
      errors: result.errors ?? []
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Async tool execution failed.";
    safeUpdateRunningJob(jobId, { status: "error", summary: `${name} failed.`, errors: [message] });
  }
}

export const asyncJobTools: ToolModule[] = [
  {
    definition: {
      name: "run_tool_async",
      description:
        "Run a long-running tool in the background and return a jobId immediately, instead of blocking the request. Use this for tools that may exceed ~100 seconds (build, npm install, video recording, webpage capture) to avoid proxy/gateway timeouts (e.g. Cloudflare 524). Poll get_job_status with the returned jobId until status is success or error. Only long-running tools are eligible.",
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
    handler: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = input as z.infer<typeof runToolAsyncSchema>;
      if (!asyncEligibleSet.has(parsed.name)) {
        throw new Error(`Tool ${parsed.name} is not eligible for async execution. Eligible: ${asyncEligibleTools.join(", ")}.`);
      }
      // Respect the same enable/skill gating the synchronous path enforces, so async cannot be
      // used to run a tool the operator has disabled. Dynamic import keeps the init cycle out.
      const { isToolEffectivelyEnabled } = await import("../../tool-state.js");
      if (!isToolEffectivelyEnabled(parsed.name)) {
        throw new Error(`Tool ${parsed.name} is disabled and cannot be run asynchronously.`);
      }
      const jobId = `job_${randomUUID()}`;
      const now = new Date().toISOString();
      saveJob({
        id: jobId,
        status: "running",
        ownerUserId: ctx.userId,
        title: parsed.name,
        summary: `Running ${parsed.name} in the background...`,
        logs: [],
        artifacts: [],
        errors: [],
        sourceToolName: parsed.name,
        sourceArgs: parsed.arguments,
        attempt: 1,
        maxAttempts: parsed.maxAttempts,
        timeoutMs: parsed.timeoutMs,
        createdAt: now,
        updatedAt: now
      });
      void runJob(jobId, parsed.name, parsed.arguments, ctx, parsed.timeoutMs);
      const statusUrl = `${ctx.publicBaseUrl.replace(/\/$/, "")}/outcome/${jobId}`;
      return {
        ok: true,
        summary: `Started ${parsed.name} as background job ${jobId}. Poll get_job_status with this jobId until it is success or error.`,
        jobId,
        previewUrl: statusUrl,
        artifacts: [],
        structuredContent: { jobId, status: "running", statusUrl, tool: parsed.name, timeoutMs: parsed.timeoutMs, maxAttempts: parsed.maxAttempts },
        logs: [`Background job ${jobId} started for ${parsed.name}.`],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "get_job_status",
      description:
        "Get the current status and result of a background job started with run_tool_async. Returns status (running | success | error) plus the wrapped tool's logs, artifacts, and errors once finished. Poll until status is no longer running.",
      inputSchema: {
        type: "object",
        properties: { jobId: { type: "string", description: "The jobId returned by run_tool_async." } },
        required: ["jobId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: getJobStatusSchema,
    handler: (input: unknown, ctx: ToolContext): ToolResult => {
      const parsed = input as z.infer<typeof getJobStatusSchema>;
      const job = authorizeJob(parsed.jobId, ctx);
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
    handler: (input: unknown, ctx: ToolContext): ToolResult => {
      const parsed = listBackgroundJobsSchema.parse(input);
      const jobs = listJobsForOwner(ctx.userId, parsed);
      return { ok: true, summary: `Found ${jobs.length} background job(s).`, artifacts: [], structuredContent: { jobs, count: jobs.length }, logs: jobs.map((job) => `${job.id} ${job.status} ${job.title}: ${job.summary}`), errors: [] };
    }
  },
  {
    definition: {
      name: "cancel_background_job",
      description: "Mark a non-terminal background job as cancelled so late results cannot overwrite the cancelled state.",
      inputSchema: { type: "object", properties: { jobId: { type: "string" }, reason: { type: "string" } }, required: ["jobId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: cancelBackgroundJobSchema,
    handler: (input: unknown, ctx: ToolContext): ToolResult => {
      const parsed = cancelBackgroundJobSchema.parse(input);
      // Authorize ownership BEFORE mutating: a non-owner must not be able to cancel.
      if (!authorizeJob(parsed.jobId, ctx)) return jobNotFound(parsed.jobId);
      const job = cancelJob(parsed.jobId, parsed.reason);
      if (!job) return jobNotFound(parsed.jobId);
      const changed = job.status === "cancelled";
      return { ok: changed, summary: changed ? `Cancelled ${parsed.jobId}.` : `Job ${parsed.jobId} is already terminal (${job.status}).`, jobId: job.id, artifacts: job.artifacts, structuredContent: { job, done: terminal(job.status) }, logs: job.logs, errors: changed ? [] : [`Job is already ${job.status}.`] };
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
      const previous = authorizeJob(parsed.jobId, ctx);
      if (!previous) return jobNotFound(parsed.jobId);
      if (!previous.sourceToolName || !previous.sourceArgs) return { ok: false, summary: `Job ${parsed.jobId} has no retry source metadata.`, artifacts: [], logs: [], errors: ["Missing sourceToolName/sourceArgs."] };
      if (!asyncEligibleSet.has(previous.sourceToolName as (typeof asyncEligibleTools)[number])) return { ok: false, summary: `${previous.sourceToolName} is not eligible for async retry.`, artifacts: [], logs: [], errors: [`Ineligible tool: ${previous.sourceToolName}.`] };
      const nextAttempt = (previous.attempt ?? 1) + 1;
      if (previous.maxAttempts && nextAttempt > previous.maxAttempts) return { ok: false, summary: `Retry budget exhausted for ${parsed.jobId}.`, artifacts: previous.artifacts, logs: previous.logs, errors: [`maxAttempts ${previous.maxAttempts} reached.`] };
      const now = new Date().toISOString();
      const jobId = `job_${randomUUID()}`;
      const timeoutMs = parsed.timeoutMs ?? previous.timeoutMs;
      saveJob({
        id: jobId,
        status: "running",
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
        createdAt: now,
        updatedAt: now
      });
      void runJob(jobId, previous.sourceToolName, previous.sourceArgs, ctx, timeoutMs);
      return { ok: true, summary: `Retry started as ${jobId}.`, jobId, artifacts: [], structuredContent: { jobId, parentJobId: previous.id, attempt: nextAttempt, status: "running" }, logs: [`Retry ${jobId} started from ${previous.id}.`], errors: [] };
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
    handler: (input: unknown, ctx: ToolContext): ToolResult => {
      const parsed = recoverJobPartialResultSchema.parse(input);
      const job = authorizeJob(parsed.jobId, ctx);
      if (!job) return jobNotFound(parsed.jobId);
      const partial = { logs: job.logs, artifacts: job.artifacts, errors: job.errors, summary: job.summary };
      const canRetry = Boolean(job.sourceToolName && job.sourceArgs && (!job.maxAttempts || (job.attempt ?? 1) < job.maxAttempts));
      const result = {
        job,
        partial,
        canRetry,
        nextActions: [
          ...(job.status === "running" ? ["Poll get_job_status again before retrying."] : []),
          ...(canRetry ? ["Call retry_background_job if the partial result is insufficient."] : []),
          ...(job.artifacts.length ? ["Inspect recovered artifacts before repeating expensive work."] : []),
          ...(job.errors.length ? ["Use errors/logs to narrow the next attempt."] : [])
        ]
      };
      return { ok: true, summary: `Recovered partial result for ${job.id}.`, jobId: job.id, artifacts: job.artifacts, structuredContent: result, logs: job.logs, errors: [] };
    }
  }
];
