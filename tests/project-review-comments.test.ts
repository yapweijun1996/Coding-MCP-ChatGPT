import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, getProject } from "../src/projects/store.js";
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
    clientId: "reviewer-client"
  };
}

test("project review comments support file, screenshot, replies, resolution, and summary export", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-review-comments-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Reviewed project", createdByClientId: "coder" });

    const added = await callTool("add_project_review_comment", {
      projectId: project.id,
      comments: [
        {
          title: "Button copy is unclear",
          body: "The primary CTA needs clearer action text.",
          severity: "medium",
          targetType: "file",
          filePath: "index.html",
          lineStart: 12,
          lineEnd: 14,
          assignedTo: "coder"
        },
        {
          title: "Hero image crops badly",
          body: "The mobile screenshot shows the hero subject clipped.",
          severity: "high",
          targetType: "screenshot",
          screenshotPath: "screenshots/mobile.png",
          region: { x: 20, y: 40, width: 180, height: 120 }
        },
        {
          title: "Filter panel issue",
          body: "The filter drawer overlaps the table.",
          severity: "low",
          targetType: "ui-region",
          selector: ".filters"
        }
      ]
    }, ctx);
    assert.equal(added.ok, true);
    const comments = (added.structuredContent as { added: Array<{ id: string; reviewerClientId: string }> }).added;
    assert.deepEqual(comments.map((comment) => comment.id), ["comment_001", "comment_002", "comment_003"]);
    assert.equal(comments[0].reviewerClientId, "reviewer-client");

    const meta = await getProject(ctx.projectRoot, project.id);
    assert.equal(meta.reviewComments?.length, 3);
    const projectJson = JSON.parse(await readFile(path.join(ctx.projectRoot, project.id, "project.json"), "utf8")) as { reviewComments: unknown[] };
    assert.equal(projectJson.reviewComments.length, 3);

    const openFileComments = await callTool("list_project_review_comments", { projectId: project.id, status: "open", targetType: "file" }, ctx);
    assert.equal(openFileComments.ok, true);
    assert.equal((openFileComments.structuredContent as { comments: unknown[]; summary: { total: number } }).comments.length, 1);

    const reply = await callTool("reply_project_review_comment", { projectId: project.id, commentId: "comment_001", body: "Updated the CTA text and added a clearer label." }, ctx);
    assert.equal(reply.ok, true);
    assert.equal((reply.structuredContent as { comment: { replies: Array<{ id: string; body: string }> } }).comment.replies[0].id, "reply_001");

    const resolved = await callTool("resolve_project_review_comment", { projectId: project.id, commentId: "comment_001", status: "resolved", note: "CTA copy changed." }, ctx);
    assert.equal(resolved.ok, true);
    assert.equal((resolved.structuredContent as { comment: { status: string; resolutionNote: string } }).comment.status, "resolved");

    const open = await callTool("list_project_review_comments", { projectId: project.id, status: "open" }, ctx);
    assert.equal((open.structuredContent as { comments: unknown[]; summary: { byStatus: { open: number } } }).comments.length, 2);

    const summary = await callTool("export_project_review_summary", { projectId: project.id }, ctx);
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.artifacts, ["review/review-summary.md"]);
    const markdown = await readFile(path.join(ctx.projectRoot, project.id, "files/review/review-summary.md"), "utf8");
    assert.match(markdown, /# Project Review Summary/);
    assert.match(markdown, /Open comments: 2/);
    assert.match(markdown, /comment_002/);
    assert.match(markdown, /Button copy is unclear/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolve_project_review_comment rejects an unknown comment id", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-review-comments-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Reviewed project", createdByClientId: "coder" });
    const result = await callTool("resolve_project_review_comment", { projectId: project.id, commentId: "comment_999", status: "resolved" }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.summary, /No project review comment comment_999/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project review comment tools are exposed through coding and debug skills", () => {
  for (const skillId of ["coding", "debug"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    for (const toolName of ["add_project_review_comment", "list_project_review_comments", "reply_project_review_comment", "resolve_project_review_comment", "export_project_review_summary"]) {
      assert.ok(skill!.toolNames.includes(toolName), `${skillId} exposes ${toolName}`);
    }
  }
});
