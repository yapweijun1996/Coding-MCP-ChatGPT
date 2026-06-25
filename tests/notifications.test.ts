import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject } from "../src/projects/store.js";
import { skillRegistry } from "../src/skills/registry.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "notifications-test"
  };
}

test("notification tools configure channels, send, schedule, process, list, and report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "notifications-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Notification project", createdByClientId: "coder" });
    const taskResult = await callTool("upsert_project_task", {
      projectId: project.id,
      title: "Review checkout polish",
      status: "blocked",
      priority: "high",
      blockedReason: "Waiting for stakeholder review",
      unblockRequirement: "Approve final copy"
    }, ctx);
    const taskId = (taskResult.structuredContent as { task: { id: string } }).task.id;

    const channel = await callTool("configure_notification_channel", {
      projectId: project.id,
      channelId: "review_team",
      name: "Review Team",
      type: "email",
      targetLabel: "review-team@example.test",
      notes: "Address label only; no SMTP secret stored."
    }, ctx);
    assert.equal(channel.ok, true);
    assert.deepEqual(channel.artifacts, ["notifications/project-notifications.json", "review_team"]);

    const sent = await callTool("send_project_notification", {
      projectId: project.id,
      title: "Task blocked",
      message: "Review checkout polish is blocked and needs approval.",
      eventType: "blocked_task",
      priority: "high",
      channelIds: ["in_app", "review_team"],
      taskId,
      changeSummary: "Stakeholder review required."
    }, ctx);
    assert.equal(sent.ok, true);
    assert.match(sent.summary, /Sent project notification notification_001/);

    const scheduled = await callTool("schedule_project_notification", {
      projectId: project.id,
      title: "Follow up on review",
      message: "Check whether the review team approved the checkout copy.",
      eventType: "review_needed",
      priority: "normal",
      channelIds: ["review_team"],
      taskId,
      scheduledFor: "2026-06-25T01:00:00.000Z",
      reminderKey: "checkout-review"
    }, ctx);
    assert.equal(scheduled.ok, true);
    assert.match(scheduled.summary, /Scheduled project notification notification_002/);

    const due = await callTool("process_due_project_notifications", {
      projectId: project.id,
      now: "2026-06-25T01:05:00.000Z"
    }, ctx);
    assert.equal(due.ok, true);
    assert.match(due.summary, /Processed 1 due notification/);

    const listed = await callTool("list_project_notifications", { projectId: project.id, status: "sent", taskId }, ctx);
    assert.equal(listed.ok, true);
    const payload = listed.structuredContent as { channels: Array<{ id: string }>; notifications: Array<{ id: string; status: string; eventType: string }>; summary: { total: number } };
    assert.equal(payload.channels.some((item) => item.id === "review_team"), true);
    assert.equal(payload.notifications.length, 2);
    assert.equal(payload.notifications.every((item) => item.status === "sent"), true);
    assert.equal(payload.summary.total, 2);

    const report = await callTool("export_notification_report", { projectId: project.id }, ctx);
    assert.equal(report.ok, true);
    assert.deepEqual(report.artifacts, ["notifications/notification-report.md"]);
    const markdown = await readFile(path.join(ctx.projectRoot, project.id, "files/notifications/notification-report.md"), "utf8");
    assert.match(markdown, /# Notification Report/);
    assert.match(markdown, /review_team/);
    assert.match(markdown, /blocked_task/);

    const store = JSON.parse(await readFile(path.join(ctx.projectRoot, project.id, "files/notifications/project-notifications.json"), "utf8")) as { notifications: Array<{ status: string }> };
    assert.equal(store.notifications.length, 2);
    assert.equal(store.notifications.every((item) => item.status === "sent"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notification tools are exposed through core, coding, debug, and notifications skills", () => {
  const toolNames = ["configure_notification_channel", "send_project_notification", "schedule_project_notification", "list_project_notifications", "process_due_project_notifications", "export_notification_report"];
  for (const skillId of ["core", "coding", "debug", "notifications"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    for (const toolName of toolNames) {
      assert.ok(skill!.toolNames.includes(toolName), `${skillId} exposes ${toolName}`);
    }
  }
});
