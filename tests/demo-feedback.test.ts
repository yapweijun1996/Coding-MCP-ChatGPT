import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, getProjectTask } from "../src/projects/store.js";
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
    clientId: "demo-feedback-test"
  };
}

test("demo feedback tools create forms, capture screenshot notes, link tasks, filter, and export reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "demo-feedback-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Demo feedback project", createdByClientId: "coder" });
    const task = await callTool("upsert_project_task", {
      projectId: project.id,
      title: "Fix demo onboarding copy",
      status: "todo",
      priority: "high",
      notes: "Created from user feedback."
    }, ctx);
    const taskId = (task.structuredContent as { task: { id: string } }).task.id;

    const form = await callTool("create_demo_feedback_form", {
      projectId: project.id,
      title: "Preview feedback",
      description: "Collect demo reactions.",
      ratingScale: { min: 1, max: 5, label: "Demo usefulness" },
      screenshotEnabled: true,
      taskLinkingEnabled: true,
      fields: [
        { id: "summary", label: "Summary", type: "text", required: true },
        { id: "details", label: "Details", type: "textarea" }
      ]
    }, ctx);
    assert.equal(form.ok, true);
    const formId = (form.structuredContent as { form: { id: string } }).form.id;
    assert.equal(formId, "form_001");

    const submitted = await callTool("submit_demo_feedback", {
      projectId: project.id,
      formId,
      rating: 2,
      sentiment: "negative",
      summary: "Onboarding copy is confusing",
      detail: "The second step does not explain what to click next.",
      pageUrl: "https://example.test/demo",
      screenshotUrl: "https://example.test/screenshots/onboarding.png",
      screenshotNote: "The highlighted empty state has no next action.",
      selector: "#onboarding-step-2",
      taskId,
      tags: ["onboarding", "copy"],
      metadata: { browser: "Chrome" }
    }, ctx);
    assert.equal(submitted.ok, true);
    const feedback = (submitted.structuredContent as { feedback: { id: string; status: string; taskId: string } }).feedback;
    assert.equal(feedback.id, "feedback_001");
    assert.equal(feedback.status, "linked");
    assert.equal(feedback.taskId, taskId);

    const persistedTask = await getProjectTask(ctx.projectRoot, project.id, taskId);
    assert.equal(persistedTask.evidence.some((item) => item.kind === "screenshot" && item.label.includes("feedback_001") && item.note?.includes("empty state")), true);

    const filtered = await callTool("list_demo_feedback", { projectId: project.id, taskId, tag: "copy" }, ctx);
    assert.equal(filtered.ok, true);
    const filteredPayload = filtered.structuredContent as { feedback: unknown[]; summary: { total: number; averageRating: number; linkedToTasks: number; bySentiment: Record<string, number> } };
    assert.equal(filteredPayload.feedback.length, 1);
    assert.equal(filteredPayload.summary.total, 1);
    assert.equal(filteredPayload.summary.averageRating, 2);
    assert.equal(filteredPayload.summary.linkedToTasks, 1);
    assert.equal(filteredPayload.summary.bySentiment.negative, 1);

    const second = await callTool("submit_demo_feedback", {
      projectId: project.id,
      rating: 5,
      sentiment: "positive",
      summary: "Landing page is clear",
      tags: ["landing"]
    }, ctx);
    assert.equal(second.ok, true);

    const secondId = (second.structuredContent as { feedback: { id: string } }).feedback.id;
    const linked = await callTool("link_demo_feedback_to_task", {
      projectId: project.id,
      feedbackId: secondId,
      taskId,
      note: "Bundle into the onboarding copy follow-up."
    }, ctx);
    assert.equal(linked.ok, true);
    assert.equal((linked.structuredContent as { feedback: { status: string; taskId: string } }).feedback.status, "linked");

    const report = await callTool("export_demo_feedback_report", { projectId: project.id }, ctx);
    assert.equal(report.ok, true);
    assert.deepEqual(report.artifacts, ["feedback/demo-feedback-report.md"]);
    const markdown = await readFile(path.join(ctx.projectRoot, project.id, "files/feedback/demo-feedback-report.md"), "utf8");
    assert.match(markdown, /# Demo Feedback Report/);
    assert.match(markdown, /Average rating: 3\.5/);
    assert.match(markdown, /Onboarding copy is confusing/);
    assert.match(markdown, /highlighted empty state/);

    const store = JSON.parse(await readFile(path.join(ctx.projectRoot, project.id, "files/feedback/demo-feedback.json"), "utf8")) as { forms: unknown[]; feedback: unknown[] };
    assert.equal(store.forms.length, 1);
    assert.equal(store.feedback.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("submit_demo_feedback rejects unknown forms before persisting feedback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "demo-feedback-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Demo feedback project", createdByClientId: "coder" });
    const result = await callTool("submit_demo_feedback", { projectId: project.id, formId: "form_404", summary: "Missing form" }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.summary, /Feedback form form_404 not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("demo feedback tools are exposed through core, coding, debug, and demo-feedback skills", () => {
  const toolNames = ["create_demo_feedback_form", "submit_demo_feedback", "list_demo_feedback", "link_demo_feedback_to_task", "export_demo_feedback_report"];
  for (const skillId of ["core", "coding", "debug", "demo-feedback"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    for (const toolName of toolNames) {
      assert.ok(skill!.toolNames.includes(toolName), `${skillId} exposes ${toolName}`);
    }
  }
});
