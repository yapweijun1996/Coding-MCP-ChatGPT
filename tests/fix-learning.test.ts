import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reportIssue, updateIssueStatus } from "../src/feedback/store.js";
import { getToolModule } from "../src/mcp/registry.js";
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
    clientId: "fix-learning-test"
  };
}

test("fix learning tools record, search, import, detect recurring patterns, and export reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fix-learning-"));
  try {
    const ctx = toolContext(root);
    const record = getToolModule("record_fix_learning");
    const preference = getToolModule("record_user_preference_learning");
    const search = getToolModule("search_fix_learnings");
    const importFeedback = getToolModule("import_resolved_feedback_learnings");
    const detect = getToolModule("detect_recurring_fix_pattern");
    const report = getToolModule("export_fix_learning_report");
    for (const [name, tool] of Object.entries({ record, preference, search, importFeedback, detect, report })) assert.ok(tool, `${name} registered`);

    const first = await record!.handler({
      title: "Mobile text overlap after responsive layout changes",
      summary: "Repeated mobile overlap was fixed by checking real narrow viewports and replacing fixed-width panels with fluid constraints.",
      bugPattern: "Text overlaps on mobile after a layout edit.",
      rootCause: "Fixed width panels and unbounded labels exceeded viewport width.",
      fix: "Use responsive grid constraints and wrap long labels.",
      verification: "Run mobile screenshot checks and typecheck.",
      detection: "Look for overflow, clipped labels, or viewport screenshots with overlapping text.",
      tags: ["mobile", "layout", "visual"],
      projectId: "project_alpha",
      evidence: [{ label: "mobile QA", source: "test", projectId: "project_alpha" }]
    }, ctx);
    assert.equal(first.ok, true);

    const duplicate = await record!.handler({
      title: "Mobile text overlap after responsive layout changes",
      summary: "Use mobile screenshots before final handoff.",
      tags: ["mobile"],
      projectId: "project_beta"
    }, ctx);
    assert.equal(duplicate.ok, true);
    const duplicatePayload = duplicate.structuredContent as { records: Array<{ title: string; seenCount: number; projectIds: string[] }> };
    const merged = duplicatePayload.records.find((item) => item.title === "Mobile text overlap after responsive layout changes");
    assert.equal(merged?.seenCount, 2);
    assert.deepEqual(merged?.projectIds.sort(), ["project_alpha", "project_beta"]);

    const preferenceResult = await preference!.handler({
      title: "Reply language preference",
      preference: "Reply to this repository in Mandarin Chinese unless explicitly asked otherwise.",
      scope: "workflow",
      evidence: [{ label: "AGENTS.md", source: "repo instructions" }]
    }, ctx);
    assert.equal(preferenceResult.ok, true);

    const searchResult = await search!.handler({ query: "mobile overlap labels", tags: ["mobile"] }, ctx);
    assert.equal(searchResult.ok, true);
    const searchPayload = searchResult.structuredContent as { matches: Array<{ record: { title: string }; score: number }> };
    assert.equal(searchPayload.matches[0].record.title, "Mobile text overlap after responsive layout changes");
    assert.ok(searchPayload.matches[0].score > 0);

    const recurringResult = await detect!.handler({
      title: "Responsive panel clips labels",
      detail: "On iPhone width, the label text overlaps the next control and the panel overflows.",
      tags: ["mobile", "layout"]
    }, ctx);
    assert.equal(recurringResult.ok, true);
    const recurringPayload = recurringResult.structuredContent as { matches: Array<{ record: { title: string } }>; recommendations: string[] };
    assert.equal(recurringPayload.matches.some((match) => match.record.title.includes("Mobile text overlap")), true);
    assert.equal(recurringPayload.recommendations.some((item) => item.includes("responsive grid")), true);

    const issue = await reportIssue(ctx.feedbackRoot, {
      title: "Need successful fix memory",
      detail: "Agents repeat the same fix mistakes.",
      severity: "high",
      category: "tool_missing",
      toolName: "mcp_platform"
    });
    await updateIssueStatus(ctx.feedbackRoot, {
      id: issue.id,
      status: "resolved",
      resolutionNote: "Added cross-project fix learning records and recurring pattern detection."
    });
    const importResult = await importFeedback!.handler({ toolName: "mcp_platform" }, ctx);
    assert.equal(importResult.ok, true);
    const importPayload = importResult.structuredContent as { importedCount: number };
    assert.equal(importPayload.importedCount, 1);

    const importedSearch = await search!.handler({ query: "recurring pattern detection", type: "successful_fix" }, ctx);
    const importedPayload = importedSearch.structuredContent as { matches: Array<{ record: { title: string } }> };
    assert.equal(importedPayload.matches.some((match) => match.record.title === "Need successful fix memory"), true);

    const reportResult = await report!.handler({ title: "Learning Report", status: "verified" }, ctx);
    assert.equal(reportResult.ok, true);
    const reportMarkdown = await readFile(path.join(ctx.feedbackRoot, "fix-learning-report.md"), "utf8");
    assert.match(reportMarkdown, /Learning Report/);
    assert.match(reportMarkdown, /Mobile text overlap/);
    assert.match(reportMarkdown, /Reply language preference/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fix-learning skill exposes tools through core, coding, and debug skills", () => {
  const toolNames = [
    "record_fix_learning",
    "record_user_preference_learning",
    "search_fix_learnings",
    "import_resolved_feedback_learnings",
    "detect_recurring_fix_pattern",
    "export_fix_learning_report"
  ];
  const fixLearning = skillRegistry.find((entry) => entry.id === "fix-learning");
  const core = skillRegistry.find((entry) => entry.id === "core");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(fixLearning);
  for (const toolName of toolNames) {
    assert.ok(fixLearning!.toolNames.includes(toolName), `${toolName} exposed in fix-learning`);
    assert.ok(core?.toolNames.includes(toolName), `${toolName} exposed in core`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
