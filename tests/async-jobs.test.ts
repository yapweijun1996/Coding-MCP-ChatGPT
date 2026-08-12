import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { musicRenderProgress } from "../src/mcp/tools/async-jobs.js";
import { saveJob, getJob, type JobRecord } from "../src/jobs/store.js";
import { createProject, upsertProjectTask } from "../src/projects/store.js";
import { skillRegistry } from "../src/skills/registry.js";
import type { ToolContext } from "../src/mcp/types.js";

function toolContext(root = "/tmp/async-test"): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: path.join(root, "workspace"),
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    telemetryRoot: "",
    projectRoot: path.join(root, "projects"),
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
  assert.ok(getToolModule("diagnose_code_mcp_status"), "diagnose_code_mcp_status registered");
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
  for (const name of ["render_midi_with_soundfont", "render_production_music", "create_music_production"]) {
    const musicRender = tool!.schema!.safeParse({ name, arguments: {} });
    assert.equal(musicRender.success, true, `${name} is eligible for async execution`);
  }
});

test("async music rendering exposes queued progress and workload metadata", async () => {
  const tool = getToolModule("run_tool_async");
  assert.ok(tool);
  const result = await tool!.handler({
    name: "render_midi_with_soundfont",
    arguments: { projectId: "project_fixture", targetDurationSeconds: 300 }
  }, toolContext());
  assert.equal(result.ok, true);
  const structured = result.structuredContent as {
    status: string;
    progressPercent: number;
    stage: string;
    estimatedWorkload: { kind: string; complexity: string; targetDurationSeconds: number };
  };
  assert.equal(structured.status, "created");
  assert.equal(structured.progressPercent, 0);
  assert.equal(structured.stage, "queued");
  assert.deepEqual(structured.estimatedWorkload, {
    kind: "music_render",
    complexity: "standard",
    targetDurationSeconds: 300
  });
});

test("music render progress maps every coarse lifecycle stage", () => {
  assert.deepEqual(musicRenderProgress("queued"), { progressPercent: 0, stage: "queued" });
  assert.deepEqual(musicRenderProgress("running"), { progressPercent: 10, stage: "running" });
  assert.deepEqual(musicRenderProgress("completed", 70), { progressPercent: 100, stage: "completed" });
  for (const stage of ["error", "timeout", "cancelled"] as const) {
    assert.deepEqual(musicRenderProgress(stage, 40), { progressPercent: 40, stage });
  }
});

test("run_tool_async returns a queued job immediately (non-blocking)", async () => {
  const tool = getToolModule("run_tool_async");
  assert.ok(tool);
  const result = await tool!.handler({ name: "run_project_build", arguments: {} }, toolContext());
  assert.equal(result.ok, true);
  assert.ok(result.jobId, "a jobId is returned synchronously");
  const structured = result.structuredContent as { status: string; statusUrl: string };
  assert.equal(structured.status, "created");
  assert.match(structured.statusUrl, /\/outcome\/job_/);
  // The job exists in the store right away, before the background work finishes.
  const job = getJob(result.jobId!);
  assert.ok(job, "job persisted to the store");
  assert.ok(["created", "running"].includes(job!.status), "local fallback may claim the job immediately; durable workers leave it queued until claimed");
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

test("music render status/list include progress fields and cancellation requests underlying abort", async () => {
  const musicJobId = `job_music_progress_${Date.now()}`;
  saveJob({
    ...job(musicJobId, "running"),
    title: "render_production_music",
    sourceToolName: "render_production_music",
    progressPercent: 10,
    stage: "running",
    estimatedWorkload: { kind: "music_render", complexity: "standard", targetDurationSeconds: 300 }
  });

  const status = getToolModule("get_job_status")!;
  const list = getToolModule("list_background_jobs")!;
  const cancel = getToolModule("cancel_background_job")!;

  const statusResult = await status.handler({ jobId: musicJobId }, toolContext());
  const statusJob = (statusResult.structuredContent as { job: JobRecord }).job;
  assert.equal(statusJob.progressPercent, 10);
  assert.equal(statusJob.stage, "running");
  assert.equal(statusJob.estimatedWorkload?.targetDurationSeconds, 300);

  const listResult = await list.handler({ sourceToolName: "render_production_music", limit: 20 }, toolContext());
  const listedJob = (listResult.structuredContent as { jobs: JobRecord[] }).jobs.find((item) => item.id === musicJobId);
  assert.equal(listedJob?.progressPercent, 10);
  assert.equal(listedJob?.stage, "running");
  assert.equal(listedJob?.estimatedWorkload?.kind, "music_render");

  const cancelResult = await cancel.handler({ jobId: musicJobId, reason: "user requested cancellation" }, toolContext());
  assert.equal(cancelResult.ok, true);
  assert.match(cancelResult.summary, /abort supported underlying work/);
  assert.equal(getJob(musicJobId)?.status, "cancelled");
  assert.equal(getJob(musicJobId)?.stage, "cancelled");
  assert.equal(getJob(musicJobId)?.progressPercent, 10);
});

test("failed async music render preserves coarse progress and reaches the error stage", async () => {
  const tool = getToolModule("run_tool_async")!;
  const result = await tool.handler({ name: "render_production_music", arguments: {} }, toolContext());
  assert.ok(result.jobId);

  let renderedJob = getJob(result.jobId!);
  for (let attempt = 0; attempt < 50 && renderedJob && !["success", "error", "cancelled", "timeout"].includes(renderedJob.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    renderedJob = getJob(result.jobId!);
  }

  assert.equal(renderedJob?.status, "error");
  assert.equal(renderedJob?.stage, "error");
  assert.equal(renderedJob?.progressPercent, 10);
  assert.equal(renderedJob?.estimatedWorkload?.kind, "music_render");
});

function tenantContext(userId: string): ToolContext {
  return { ...toolContext(), userId };
}

test("background jobs are tenant-isolated: a non-owner cannot read, cancel, or re-execute another tenant's job", async () => {
  // Alice owns a terminal, retry-eligible job (has sourceToolName + sourceArgs).
  const aliceJobId = "job_tenant_alice_secret";
  saveJob({ ...job(aliceJobId, "error"), ownerUserId: "alice" });

  const alice = tenantContext("alice");
  const bob = tenantContext("bob");

  const get = getToolModule("get_job_status")!;
  const list = getToolModule("list_background_jobs")!;
  const cancel = getToolModule("cancel_background_job")!;
  const retry = getToolModule("retry_background_job")!;
  const recover = getToolModule("recover_job_partial_result")!;

  // Bob (a different tenant) is denied on every id-addressed tool, with a generic not-found
  // that does not distinguish "exists but not yours" from "missing" (no enumeration).
  for (const [name, tool] of [["get", get], ["cancel", cancel], ["recover", recover], ["retry", retry]] as const) {
    const res = await tool.handler({ jobId: aliceJobId }, bob);
    assert.equal(res.ok, false, `${name} must deny a non-owner`);
    assert.match(res.errors[0] ?? "", /Unknown jobId/, `${name} returns a generic not-found`);
    assert.equal(res.jobId, undefined, `${name} must not return the job to a non-owner`);
  }

  // The blocker, directly: Bob's retry must NOT re-execute Alice's stored sourceArgs. A
  // not-found with no new jobId proves the auth check short-circuits before saveJob/runJob.
  const bobRetry = await retry.handler({ jobId: aliceJobId }, bob);
  assert.equal(bobRetry.ok, false);
  assert.equal(bobRetry.jobId, undefined, "Bob's retry must not spawn a job from Alice's args");

  // Bob's cancel did not mutate Alice's job.
  assert.equal(getJob(aliceJobId)?.status, "error", "a non-owner's cancel must not change the job");

  // Bob's listing never includes Alice's job.
  const bobList = await list.handler({ limit: 500 }, bob);
  const bobJobs = (bobList.structuredContent as { jobs: JobRecord[] }).jobs;
  assert.equal(bobJobs.some((j) => j.id === aliceJobId), false, "Bob must not see Alice's job in a listing");

  // Alice still has full access to her own job.
  const aliceGet = await get.handler({ jobId: aliceJobId }, alice);
  assert.equal(aliceGet.ok, false); // status "error" -> ok:false, but it's FOUND (not a not-found)
  assert.equal(aliceGet.jobId, aliceJobId, "the owner resolves her own job");
  const aliceList = await list.handler({ limit: 500 }, alice);
  const aliceJobs = (aliceList.structuredContent as { jobs: JobRecord[] }).jobs;
  assert.equal(aliceJobs.some((j) => j.id === aliceJobId), true, "the owner sees her own job in a listing");
  const aliceRecover = await recover.handler({ jobId: aliceJobId }, alice);
  assert.equal(aliceRecover.ok, true, "the owner recovers her own partial result");
});

test("diagnose_code_mcp_status reports idle with no jobs or projects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "async-diagnose-idle-"));
  try {
    const diagnose = getToolModule("diagnose_code_mcp_status");
    assert.ok(diagnose);
    const ctx = { ...toolContext(root), userId: `idle-user-${Date.now()}` };
    const result = await diagnose!.handler({ latestUserIntent: "build a demo" }, ctx);
    assert.equal(result.ok, true);
    const payload = result.structuredContent as { state: string; canContinue: boolean; createdProject?: unknown; nextActions: string[] };
    assert.equal(payload.state, "idle_no_project");
    assert.equal(payload.canContinue, false);
    assert.equal(payload.createdProject, undefined);
    assert.ok(payload.nextActions.some((action) => action.includes("create_app_project")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnose_code_mcp_status returns structured diagnostics for an unknown projectId", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "async-diagnose-missing-project-"));
  try {
    const diagnose = getToolModule("diagnose_code_mcp_status");
    assert.ok(diagnose);
    const ctx = { ...toolContext(root), userId: `missing-project-user-${Date.now()}` };
    const result = await diagnose!.handler({ projectId: "project_missing_123" }, ctx);
    assert.equal(result.ok, true);
    const payload = result.structuredContent as {
      state: string;
      canContinue: boolean;
      projectLookupError: { projectId: string; message: string };
      nextActions: string[];
    };
    assert.equal(payload.state, "project_not_found");
    assert.equal(payload.canContinue, false);
    assert.equal(payload.projectLookupError.projectId, "project_missing_123");
    assert.match(payload.projectLookupError.message, /does not exist/);
    assert.ok(payload.nextActions.some((action) => action.includes("projectId")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnose_code_mcp_status summarizes running, failed, and successful jobs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "async-diagnose-jobs-"));
  try {
    const userId = `diag-jobs-${Date.now()}`;
    saveJob({ ...job(`job_${userId}_running`, "running"), ownerUserId: userId, updatedAt: "2026-06-23T02:13:00.000Z" });
    saveJob({ ...job(`job_${userId}_error`, "error"), ownerUserId: userId, updatedAt: "2026-06-23T02:12:00.000Z" });
    saveJob({ ...job(`job_${userId}_success`, "success"), ownerUserId: userId, updatedAt: "2026-06-23T02:11:00.000Z" });
    const diagnose = getToolModule("diagnose_code_mcp_status")!;
    const result = await diagnose.handler({}, { ...toolContext(root), userId });
    assert.equal(result.ok, true);
    const payload = result.structuredContent as {
      state: string;
      jobs: {
        running: Array<{ id: string }>;
        failed: Array<{ id: string }>;
        succeeded: Array<{ id: string }>;
      };
      nextActions: string[];
    };
    assert.equal(payload.state, "job_running");
    assert.equal(payload.jobs.running.some((item) => item.id === `job_${userId}_running`), true);
    assert.equal(payload.jobs.failed.some((item) => item.id === `job_${userId}_error`), true);
    assert.equal(payload.jobs.succeeded.some((item) => item.id === `job_${userId}_success`), true);
    assert.ok(payload.nextActions.some((action) => action.includes("get_job_status")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnose_code_mcp_status returns resume action for unfinished project tasks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "async-diagnose-project-"));
  try {
    const ctx = { ...toolContext(root), userId: `diag-project-${Date.now()}` };
    const project = await createProject(ctx.projectRoot, { title: "Resume project", createdByClientId: "test-client" });
    const task = await upsertProjectTask(ctx.projectRoot, project.id, {
      title: "Finish implementation",
      status: "doing",
      priority: "high",
      notes: "Continue from generated work.",
      progress: 50
    });
    const diagnose = getToolModule("diagnose_code_mcp_status")!;
    const result = await diagnose.handler({ projectId: project.id }, ctx);
    assert.equal(result.ok, true);
    const payload = result.structuredContent as { state: string; project: { resumeTask: { id: string } }; nextActions: string[] };
    assert.equal(payload.state, "project_resume_available");
    assert.equal(payload.project.resumeTask.id, task.id);
    assert.ok(payload.nextActions.some((action) => action.includes(task.id)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnose_code_mcp_status auto-starts a project when idle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "async-diagnose-autostart-"));
  try {
    const ctx = { ...toolContext(root), userId: `diag-autostart-${Date.now()}` };
    const diagnose = getToolModule("diagnose_code_mcp_status")!;
    const result = await diagnose.handler({ latestUserIntent: "build inventory app", autoStartWhenIdle: true }, ctx);
    assert.equal(result.ok, true);
    const payload = result.structuredContent as { state: string; createdProject: { projectId: string }; createdTask: { id: string }; project: { id: string; resumeTask: { id: string } } };
    assert.equal(payload.state, "new_project_started");
    assert.match(payload.createdProject.projectId, /^project_/);
    assert.equal(payload.project.id, payload.createdProject.projectId);
    assert.equal(payload.project.resumeTask.id, payload.createdTask.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("job-queue skill exposes queue tools through core, coding, and debug skills", () => {
  const toolNames = [
    "run_tool_async",
    "get_job_status",
    "list_background_jobs",
    "diagnose_code_mcp_status",
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
