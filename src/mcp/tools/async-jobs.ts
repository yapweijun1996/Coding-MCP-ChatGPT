import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolContext, ToolModule, ToolResult } from "../types.js";
import { getJob, saveJob, updateJob } from "../../jobs/store.js";

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
  arguments: z.record(z.unknown()).default({})
});

const getJobStatusSchema = z.object({
  jobId: z.string().min(1).max(200)
});

// Runs the wrapped tool to completion in the background and folds its ToolResult into the job
// record. Dynamic import of the router avoids a module-init cycle (router -> registry ->
// tools/index -> this module).
async function runJob(jobId: string, name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<void> {
  try {
    // Re-check enablement at run time, not just at submit time: a tool may have been disabled
    // between submit and this deferred execution.
    const { isToolEffectivelyEnabled } = await import("../../tool-state.js");
    if (!isToolEffectivelyEnabled(name)) {
      updateJob(jobId, { status: "error", summary: `${name} was disabled before it ran.`, errors: [`Tool ${name} is disabled.`] });
      return;
    }
    const { callTool } = await import("../router.js");
    const result = await callTool(name, args, ctx);
    updateJob(jobId, {
      status: result.ok ? "success" : "error",
      summary: result.summary,
      logs: result.logs ?? [],
      artifacts: result.artifacts ?? [],
      errors: result.errors ?? []
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Async tool execution failed.";
    updateJob(jobId, { status: "error", summary: `${name} failed.`, errors: [message] });
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
          arguments: { type: "object", description: "The arguments object for that tool." }
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
        title: parsed.name,
        summary: `Running ${parsed.name} in the background...`,
        logs: [],
        artifacts: [],
        errors: [],
        createdAt: now,
        updatedAt: now
      });
      void runJob(jobId, parsed.name, parsed.arguments, ctx);
      const statusUrl = `${ctx.publicBaseUrl.replace(/\/$/, "")}/outcome/${jobId}`;
      return {
        ok: true,
        summary: `Started ${parsed.name} as background job ${jobId}. Poll get_job_status with this jobId until it is success or error.`,
        jobId,
        previewUrl: statusUrl,
        artifacts: [],
        structuredContent: { jobId, status: "running", statusUrl, tool: parsed.name },
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
    handler: (input: unknown): ToolResult => {
      const parsed = input as z.infer<typeof getJobStatusSchema>;
      const job = getJob(parsed.jobId);
      if (!job) {
        return { ok: false, summary: `No background job found for ${parsed.jobId}.`, artifacts: [], logs: [], errors: [`Unknown jobId: ${parsed.jobId}. It may have been pruned after the retention window, or the id is wrong. (Jobs persist across restarts; an interrupted job is marked "error", not lost.)`] };
      }
      const done = job.status === "success" || job.status === "error";
      return {
        ok: job.status !== "error",
        summary: done ? job.summary : `Job ${job.id} is still ${job.status}.`,
        jobId: job.id,
        artifacts: job.artifacts,
        structuredContent: { job, done },
        logs: job.logs,
        errors: job.errors
      };
    }
  }
];
