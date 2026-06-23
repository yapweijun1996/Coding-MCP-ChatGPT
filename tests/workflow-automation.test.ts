import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, readProjectFile } from "../src/projects/store.js";
import { skillRegistry } from "../src/skills/registry.js";
import type { ToolContext } from "../src/mcp/types.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "workflow-automation-test"
  };
}

const spec = {
  name: "Release Workflow",
  triggers: [{ type: "manual", name: "release button" }],
  failurePolicy: "compensate",
  steps: [
    { id: "build", name: "Build", action: "run build", retry: { maxAttempts: 2, backoff: "fixed", delaySeconds: 30 }, recovery: "restore previous build artifact" },
    { id: "approve", name: "Approve", action: "wait for release approval", dependsOn: ["build"], approval: { required: true, approvers: ["release-manager"] }, recovery: "cancel release" },
    { id: "deploy", name: "Deploy", action: "publish release", dependsOn: ["approve"], retry: { maxAttempts: 3, backoff: "exponential", delaySeconds: 60 }, recovery: "roll back to previous version" }
  ],
  notifications: [{ channel: "log", on: ["failure", "success"] }],
  logs: { retainDays: 30, includeOutputs: true }
};

test("workflow automation tools create specs, validate, simulate, schedule, recover, and report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-automation-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Workflow project", createdByClientId: "ops" });
    const create = getToolModule("create_workflow_automation_spec");
    const validate = getToolModule("validate_workflow_automation_spec");
    const simulate = getToolModule("simulate_workflow_execution");
    const schedule = getToolModule("create_workflow_schedule_plan");
    const recovery = getToolModule("create_workflow_recovery_plan");
    const report = getToolModule("export_workflow_automation_report");
    for (const [name, tool] of Object.entries({ create, validate, simulate, schedule, recovery, report })) assert.ok(tool, `${name} registered`);

    const created = await create!.handler({ projectId: project.id, ...spec }, ctx);
    assert.equal(created.ok, true);
    assert.ok(created.artifacts.includes("workflow-automation/workflow-spec.json"));

    const valid = await validate!.handler({ spec }, ctx);
    assert.equal(valid.ok, true);
    const validation = valid.structuredContent as { warnings: string[]; stepCount: number };
    assert.equal(validation.stepCount, 3);
    assert.deepEqual(validation.warnings, []);

    const blocked = await simulate!.handler({ spec }, ctx);
    assert.equal(blocked.ok, false);
    const blockedPayload = blocked.structuredContent as { finalStatus: string; blocked: string[] };
    assert.equal(blockedPayload.finalStatus, "blocked");
    assert.deepEqual(blockedPayload.blocked, ["approve"]);

    const failed = await simulate!.handler({ spec, approvedStepIds: ["approve"], failStepIds: ["deploy"] }, ctx);
    assert.equal(failed.ok, false);
    const failedPayload = failed.structuredContent as { events: Array<{ event: string; stepId: string; recovery?: string }> };
    assert.equal(failedPayload.events.some((event) => event.stepId === "deploy" && event.event === "recovery_required" && event.recovery === "roll back to previous version"), true);

    const success = await simulate!.handler({ spec, approvedStepIds: ["approve"] }, ctx);
    assert.equal(success.ok, true);
    const successPayload = success.structuredContent as { finalStatus: string; completed: string[] };
    assert.equal(successPayload.finalStatus, "success");
    assert.deepEqual(successPayload.completed, ["build", "approve", "deploy"]);

    const scheduleResult = await schedule!.handler({
      projectId: project.id,
      workflowName: "Release Workflow",
      schedules: [{ name: "weekday", cron: "0 9 * * 1-5", timezone: "UTC" }]
    }, ctx);
    assert.equal(scheduleResult.ok, true);
    assert.ok(scheduleResult.artifacts.includes("workflow-automation/schedule-plan.json"));

    const recoveryResult = await recovery!.handler({
      projectId: project.id,
      workflowName: "Release Workflow",
      failureModes: [{ stepId: "deploy", failure: "publish failed", detection: "deploy returned non-zero", recovery: "roll back", notify: ["release-manager"] }]
    }, ctx);
    assert.equal(recoveryResult.ok, true);
    assert.ok(recoveryResult.artifacts.includes("workflow-automation/recovery-plan.json"));

    const reportResult = await report!.handler({
      projectId: project.id,
      title: "Workflow Automation Report",
      spec,
      validation,
      simulation: successPayload,
      findings: ["Approval blocks release until manager approves."]
    }, ctx);
    assert.equal(reportResult.ok, true);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "workflow-automation/workflow-report.md");
    assert.match(markdown, /# Workflow Automation Report/);
    assert.match(markdown, /Approval blocks release/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow-automation skill exposes tools through dedicated, coding, and debug skills", () => {
  const toolNames = [
    "create_workflow_automation_spec",
    "validate_workflow_automation_spec",
    "simulate_workflow_execution",
    "create_workflow_schedule_plan",
    "create_workflow_recovery_plan",
    "export_workflow_automation_report"
  ];
  const workflow = skillRegistry.find((entry) => entry.id === "workflow-automation");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(workflow);
  for (const toolName of toolNames) {
    assert.ok(workflow!.toolNames.includes(toolName), `${toolName} exposed in workflow-automation`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
