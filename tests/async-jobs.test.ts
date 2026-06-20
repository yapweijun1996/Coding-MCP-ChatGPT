import { test } from "node:test";
import assert from "node:assert/strict";
import { getToolModule } from "../src/mcp/registry.js";
import { getJob } from "../src/jobs/store.js";
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
});
