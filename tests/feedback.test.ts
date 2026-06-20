import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import type { ToolContext } from "../src/mcp/types.js";
import { listIssues, reportIssue, updateIssueStatus } from "../src/feedback/store.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "test-client",
    userId: "user-1"
  };
}

test("report_issue persists an issue and assigns a monotonic id", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "feedback-"));
  try {
    const ctx = toolContext(root);
    const tool = getToolModule("report_issue");
    assert.ok(tool, "report_issue tool is registered");

    const result = await tool!.handler(
      { title: "browser_click times out", detail: "It hangs for 30s then errors.", severity: "high", category: "tool_error", toolName: "browser_click" },
      ctx
    );
    assert.equal(result.ok, true);
    const issue = (result.structuredContent as { issue: { id: string; status: string; reportedByClientId?: string } }).issue;
    assert.equal(issue.id, "issue_0001");
    assert.equal(issue.status, "open");
    assert.equal(issue.reportedByClientId, "test-client");

    const second = await reportIssue(ctx.feedbackRoot, { title: "another problem here", detail: "x", severity: "low", category: "other" });
    assert.equal(second.id, "issue_0002");

    const onDisk = JSON.parse(await readFile(path.join(ctx.feedbackRoot, "issues.json"), "utf8"));
    assert.equal(onDisk.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("list_reported_issues filters and update_issue_status flips state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "feedback-"));
  try {
    const ctx = toolContext(root);
    await reportIssue(ctx.feedbackRoot, { title: "open issue one", detail: "a", severity: "high", category: "tool_error" });
    const target = await reportIssue(ctx.feedbackRoot, { title: "missing capability x", detail: "b", severity: "medium", category: "tool_missing" });

    const listTool = getToolModule("list_reported_issues");
    assert.ok(listTool);
    const onlyMissing = await listTool!.handler({ category: "tool_missing", limit: 50 }, ctx);
    const issues = (onlyMissing.structuredContent as { issues: Array<{ id: string }> }).issues;
    assert.equal(issues.length, 1);
    assert.equal(issues[0].id, target.id);

    const updated = await updateIssueStatus(ctx.feedbackRoot, { id: target.id, status: "resolved", resolutionNote: "shipped feature x" });
    assert.equal(updated.status, "resolved");
    assert.equal(updated.resolutionNote, "shipped feature x");

    const stillOpen = await listIssues(ctx.feedbackRoot, { status: "open" });
    assert.equal(stillOpen.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update_issue_status rejects an unknown id", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "feedback-"));
  try {
    const ctx = toolContext(root);
    await assert.rejects(() => updateIssueStatus(ctx.feedbackRoot, { id: "issue_9999", status: "resolved" }), /No reported issue/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reportIssue serializes concurrent writes without id collisions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "feedback-"));
  try {
    const ctx = toolContext(root);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        reportIssue(ctx.feedbackRoot, { title: `concurrent issue ${i}`, detail: "d", severity: "low", category: "other" })
      )
    );
    const all = await listIssues(ctx.feedbackRoot);
    const ids = new Set(all.map((issue) => issue.id));
    assert.equal(all.length, 10);
    assert.equal(ids.size, 10, "all ids are unique");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
