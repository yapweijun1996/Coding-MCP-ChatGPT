import { test } from "node:test";
import assert from "node:assert/strict";
import { getToolModule } from "../src/mcp/registry.js";
import { saveJob, getJob, updateJob, type JobRecord } from "../src/jobs/store.js";
import { skillRegistry } from "../src/skills/registry.js";
import type { ToolContext } from "../src/mcp/types.js";

function toolContext(): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: "/tmp/async-test",
    commandTimeoutMs: 1000,
    shareRoot: "/tmp/async-test/shares",
    artifactRoot: "/tmp/async-test/artifacts",
    feedbackRoot: "/tmp/async-test/feedback",
    telemetryRoot: "",
    projectRoot: "/tmp/async-test/projects",
    clientId: "test-client"
  };
}

test("run_tool_async and get_job_status are registered and skill-exposed", () => {
  assert.ok(getToolModule("run_tool_async"), "run_tool_async registered");
  assert.ok(getToolModule("get_job_status"), "get_job_status registered");
  assert.ok(getToolModule("list_background_jobs"), "list_background_jobs registered");
  assert.ok(getToolModule("cancel_background_job"), "cancel_background_job registered");
  assert.ok(getToolModule("retry_background_job"), "retry_background_job registered");
  assert.ok(getToolModule("recover_job_partial_result"), "recover_job_partial_result registered");
});

test("get_job_status returns ok:false for an unknown job", async () => {
  const tool = getToolModule("get_job_status");
  assert.ok(tool);
  const result = await tool!.handler({ jobId: "does-not-exist" }, toolContext());
  assert.equal(result.ok, false);
  assert.match(result.errors[0] ?? "", /Unknown jobId/);
});

test("run_tool_async rejects an ineligible tool name at the schema", () => {
  const tool = getToolModule("run_tool_async");
  assert.ok(tool?.schema);
  const ineligible = tool!.schema!.safeParse({ name: "delete_project", arguments: {} });
  assert.equal(ineligible.success, false);
  const eligible = tool!.schema!.safeParse({ name: "run_project_build", arguments: {} });
  assert.equal(eligible.success, true);
});

test("run_tool_async returns a running job immediately (non-blocking)", async () => {
  const tool = getToolModule("run_tool_async");
  assert.ok(tool);
  const result = await tool!.handler({ name: "run_project_build", arguments: {} }, toolContext());
  assert.equal(result.ok, true);
  assert.ok(result.jobId, "a jobId is returned synchronously");
  const structured = result.structuredContent as { status: string; statusUrl: string };
  assert.equal(structured.status, "running");
  assert.match(structured.statusUrl, /\/outcome\/job_/);
  // The job exists in the store right away, before the background work finishes.
  const job = getJob(result.jobId!);
  assert.ok(job, "job persisted to the store");
  assert.equal(job!.title, "run_project_build");
  assert.equal(job!.sourceToolName, "run_project_build");
});

function job(id: string, status: JobRecord["status"]): JobRecord {
  const now = "2026-06-23T02:10:00.000Z";
  return {
    id,
    status,
    title: "run_project_build",
    summary: "fixture",
    logs: ["partial log"],
    artifacts: ["artifact.txt"],
    errors: status === "error" ? ["failed"] : [],
    sourceToolName: "run_project_build",
    sourceArgs: {},
    attempt: 1,
    maxAttempts: 2,
    createdAt: now,
    updatedAt: now
  };
}

test("background job queue tools list, cancel, retry, and recover partial results", async () => {
  saveJob(job("job_queue_running", "running"));
  saveJob(job("job_queue_error", "error"));

  const list = getToolModule("list_background_jobs");
  const cancel = getToolModule("cancel_background_job");
  const retry = getToolModule("retry_background_job");
  const recover = getToolModule("recover_job_partial_result");
  assert.ok(list && cancel && retry && recover);

  const listed = await list!.handler({ status: "running", sourceToolName: "run_project_build", limit: 20 }, toolContext());
  assert.equal(listed.ok, true);
  const listedPayload = listed.structuredContent as { jobs: JobRecord[] };
  assert.equal(listedPayload.jobs.some((item) => item.id === "job_queue_running"), true);

  const cancelled = await cancel!.handler({ jobId: "job_queue_running", reason: "superseded" }, toolContext());
  assert.equal(cancelled.ok, true);
  assert.equal(getJob("job_queue_running")?.status, "cancelled");

  const recovered = await recover!.handler({ jobId: "job_queue_error" }, toolContext());
  assert.equal(recovered.ok, true);
  const recoveredPayload = recovered.structuredContent as { partial: { logs: string[]; artifacts: string[]; errors: string[] }; canRetry: boolean };
  assert.deepEqual(recoveredPayload.partial.logs, ["partial log"]);
  assert.deepEqual(recoveredPayload.partial.artifacts, ["artifact.txt"]);
  assert.equal(recoveredPayload.canRetry, true);

  const retried = await retry!.handler({ jobId: "job_queue_error", timeoutMs: 1000 }, toolContext());
  assert.equal(retried.ok, true);
  assert.ok(retried.jobId);
  const retryJob = getJob(retried.jobId!);
  assert.equal(retryJob?.parentJobId, "job_queue_error");
  assert.equal(retryJob?.attempt, 2);
});

test("job-queue skill exposes queue tools through core, coding, and debug skills", () => {
  const toolNames = [
    "run_tool_async",
    "get_job_status",
    "list_background_jobs",
    "cancel_background_job",
    "retry_background_job",
    "recover_job_partial_result"
  ];
  const jobQueue = skillRegistry.find((entry) => entry.id === "job-queue");
  const core = skillRegistry.find((entry) => entry.id === "core");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(jobQueue);
  for (const toolName of toolNames) {
    assert.ok(jobQueue!.toolNames.includes(toolName), `${toolName} exposed in job-queue`);
    assert.ok(core?.toolNames.includes(toolName), `${toolName} exposed in core`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
