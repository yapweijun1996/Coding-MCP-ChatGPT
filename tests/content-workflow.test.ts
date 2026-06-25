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
    clientId: "content-workflow-test"
  };
}

test("content workflow manages briefs, versions, reviews, approval, filtering, and reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "content-workflow-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Content workflow project", createdByClientId: "coder" });

    const briefResult = await callTool("create_content_brief", {
      projectId: project.id,
      title: "Launch Email",
      contentType: "email",
      audience: "Existing beta users",
      goal: "Announce the analytics dashboard launch",
      tone: "concise and practical",
      channels: ["email"],
      constraints: ["No unsupported performance claims"],
      reviewChecklist: ["CTA is clear", "Claims are supported"]
    }, ctx);
    assert.equal(briefResult.ok, true);
    const briefId = (briefResult.structuredContent as { brief: { id: string } }).brief.id;
    assert.equal(briefId, "brief_001");

    const versionOne = await callTool("create_content_version", {
      projectId: project.id,
      briefId,
      title: "Launch Email v1",
      body: "Subject: Analytics dashboard is ready\n\nOpen the dashboard to review your launch metrics.",
      sourcePrompt: "Draft a concise launch email.",
      status: "draft"
    }, ctx);
    assert.equal(versionOne.ok, true);

    const versionTwo = await callTool("create_content_version", {
      projectId: project.id,
      briefId,
      title: "Launch Email v2",
      body: "Subject: Your analytics dashboard is live\n\nReview launch metrics and share feedback with the team.",
      summary: "Tighter CTA and clearer user benefit.",
      status: "in_review"
    }, ctx);
    const versionId = (versionTwo.structuredContent as { version: { id: string } }).version.id;
    assert.equal(versionId, "version_002");

    const review = await callTool("review_content_version", {
      projectId: project.id,
      briefId,
      versionId,
      reviewer: "pm",
      decision: "approve",
      comments: ["CTA is clear.", "No unsupported claims."],
      checklistResults: [
        { check: "CTA is clear", passed: true },
        { check: "Claims are supported", passed: true }
      ]
    }, ctx);
    assert.equal(review.ok, true);
    assert.equal((review.structuredContent as { review: { id: string; decision: string } }).review.decision, "approve");

    const approved = await callTool("approve_content_version", {
      projectId: project.id,
      briefId,
      versionId,
      approvalNote: "Approved for launch handoff."
    }, ctx);
    assert.equal(approved.ok, true);
    assert.equal((approved.structuredContent as { version: { status: string; approvalNote: string } }).version.status, "approved");

    const listed = await callTool("list_content_versions", { projectId: project.id, status: "approved" }, ctx);
    const listPayload = listed.structuredContent as { briefs: Array<{ versions: Array<{ id: string; status: string }> }>; summary: { versions: number; byStatus: Record<string, number> } };
    assert.equal(listPayload.briefs.length, 1);
    assert.equal(listPayload.briefs[0].versions[0].id, versionId);
    assert.equal(listPayload.summary.byStatus.approved, 1);

    const report = await callTool("export_content_workflow_report", { projectId: project.id, briefId }, ctx);
    assert.equal(report.ok, true);
    assert.deepEqual(report.artifacts, ["content/content-workflow-report.md"]);
    const markdown = await readFile(path.join(ctx.projectRoot, project.id, "files/content/content-workflow-report.md"), "utf8");
    assert.match(markdown, /# Content Workflow Report/);
    assert.match(markdown, /Launch Email v2/);
    assert.match(markdown, /Approved for launch handoff|approve by pm/);

    const store = JSON.parse(await readFile(path.join(ctx.projectRoot, project.id, "files/content/content-workflow.json"), "utf8")) as { briefs: Array<{ versions: unknown[] }> };
    assert.equal(store.briefs.length, 1);
    assert.equal(store.briefs[0].versions.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review_content_version rejects unknown versions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "content-workflow-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Content workflow project", createdByClientId: "coder" });
    const brief = await callTool("create_content_brief", { projectId: project.id, title: "Post", contentType: "social-post", audience: "Users", goal: "Share update" }, ctx);
    const briefId = (brief.structuredContent as { brief: { id: string } }).brief.id;
    const result = await callTool("review_content_version", { projectId: project.id, briefId, versionId: "version_999", decision: "reject" }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.summary, /Content version version_999 not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("content workflow tools are exposed through core, coding, debug, and content-workflow skills", () => {
  const toolNames = ["create_content_brief", "create_content_version", "review_content_version", "list_content_versions", "approve_content_version", "export_content_workflow_report"];
  for (const skillId of ["core", "coding", "debug", "content-workflow"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    for (const toolName of toolNames) {
      assert.ok(skill!.toolNames.includes(toolName), `${skillId} exposes ${toolName}`);
    }
  }
});
