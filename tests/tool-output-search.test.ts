import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reportIssue, updateIssueStatus } from "../src/feedback/store.js";
import { getToolModule } from "../src/mcp/registry.js";
import { appendProjectTaskHistory, createProject, writeProjectFile } from "../src/projects/store.js";
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
    clientId: "tool-output-search-test"
  };
}

test("tool output search indexes project outputs, issues, fix learnings, and manual records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tool-output-search-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Search project", createdByClientId: "search" });
    await appendProjectTaskHistory(ctx.projectRoot, project.id, {
      toolName: "run_tests",
      ok: false,
      summary: "Playwright smoke failed because login button was hidden on mobile viewport.",
      details: { error: "Timeout waiting for login button", screenshot: "screenshots/mobile-login.png" }
    });
    await writeProjectFile(ctx.projectRoot, project.id, "reports/mobile-report.md", "Mobile report: login button is hidden behind the sticky footer. Screenshot: mobile-login.png");

    const issue = await reportIssue(ctx.feedbackRoot, {
      title: "Need mobile login fix",
      detail: "Login button hidden on mobile smoke flow.",
      severity: "high",
      category: "tool_error",
      toolName: "run_smoke_flow"
    });
    await updateIssueStatus(ctx.feedbackRoot, {
      id: issue.id,
      status: "resolved",
      resolutionNote: "Adjusted sticky footer spacing so the login button remains visible."
    });

    const fixLearning = getToolModule("record_fix_learning");
    await fixLearning!.handler({
      title: "Hidden mobile CTA",
      summary: "When a sticky footer hides a CTA, add safe bottom padding and verify narrow viewport screenshots.",
      fix: "Add bottom padding matching sticky footer height.",
      tags: ["mobile", "cta"]
    }, ctx);

    const build = getToolModule("build_tool_output_search_index");
    const ingest = getToolModule("ingest_tool_output_record");
    const search = getToolModule("search_tool_outputs");
    const similar = getToolModule("find_similar_tool_errors");
    const summarize = getToolModule("summarize_tool_output_search_sources");
    const report = getToolModule("export_tool_output_search_report");
    for (const [name, tool] of Object.entries({ build, ingest, search, similar, summarize, report })) assert.ok(tool, `${name} registered`);

    const buildResult = await build!.handler({ projectId: project.id }, ctx);
    assert.equal(buildResult.ok, true);
    const buildPayload = buildResult.structuredContent as { recordCount: number; byKind: Record<string, number> };
    assert.ok(buildPayload.recordCount >= 4);
    assert.ok(buildPayload.byKind.tool_error >= 1);
    assert.ok(buildPayload.byKind.report >= 1);
    assert.ok(buildPayload.byKind.issue >= 1);
    assert.ok(buildPayload.byKind.fix_learning >= 1);

    const searchResult = await search!.handler({ query: "mobile login button hidden sticky footer", limit: 5 }, ctx);
    assert.equal(searchResult.ok, true);
    const searchPayload = searchResult.structuredContent as { matches: Array<{ record: { title: string; kind: string }; score: number }> };
    assert.equal(searchPayload.matches.some((match) => match.record.title.includes("mobile-report")), true);
    assert.equal(searchPayload.matches.some((match) => match.record.kind === "fix_learning"), true);

    const similarResult = await similar!.handler({ errorText: "Timeout waiting for login button on mobile", limit: 3 }, ctx);
    assert.equal(similarResult.ok, true);
    const similarPayload = similarResult.structuredContent as { matches: Array<{ record: { title: string } }> };
    assert.equal(similarPayload.matches.some((match) => match.record.title.includes("Playwright smoke failed")), true);

    const ingestResult = await ingest!.handler({
      record: {
        id: "manual:screenshot-note",
        kind: "screenshot",
        title: "Mobile screenshot note",
        text: "Screenshot shows login button covered by footer overlay.",
        projectId: project.id,
        sourcePath: "screenshots/mobile-login.png"
      }
    }, ctx);
    assert.equal(ingestResult.ok, true);

    const screenshotSearch = await search!.handler({ query: "footer overlay screenshot login", kind: "screenshot" }, ctx);
    const screenshotPayload = screenshotSearch.structuredContent as { matches: Array<{ record: { id: string } }> };
    assert.equal(screenshotPayload.matches[0].record.id, "manual:screenshot-note");

    const summaryResult = await summarize!.handler({}, ctx);
    assert.equal(summaryResult.ok, true);
    const summaryPayload = summaryResult.structuredContent as { totalRecords: number; byProject: Record<string, number> };
    assert.ok(summaryPayload.totalRecords >= buildPayload.recordCount);
    assert.ok(summaryPayload.byProject[project.id] >= 1);

    const reportResult = await report!.handler({ query: "login button hidden", limit: 5 }, ctx);
    assert.equal(reportResult.ok, true);
    const markdown = await readFile(path.join(ctx.feedbackRoot, "tool-output-search-report.md"), "utf8");
    assert.match(markdown, /Tool Output Search Report/);
    assert.match(markdown, /login button/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#0179 build and ingest create nested index directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tool-output-search-nested-"));
  try {
    const ctx = toolContext(root);
    const build = getToolModule("build_tool_output_search_index");
    const ingest = getToolModule("ingest_tool_output_record");
    assert.ok(build);
    assert.ok(ingest);

    const buildPath = "reports/search/index.json";
    const buildResult = await build.handler({
      includeFeedbackIssues: false,
      includeFixLearnings: false,
      outputPath: buildPath
    }, ctx);
    assert.equal(buildResult.ok, true);
    const builtIndex = JSON.parse(await readFile(path.join(ctx.feedbackRoot, buildPath), "utf8")) as { records: unknown[] };
    assert.deepEqual(builtIndex.records, []);

    const ingestPath = "ingested/tool-output/index.json";
    const ingestResult = await ingest.handler({
      indexPath: ingestPath,
      record: {
        id: "manual:nested-index",
        kind: "tool_log",
        title: "Nested index regression",
        text: "The shared writeIndex path creates every missing parent directory."
      }
    }, ctx);
    assert.equal(ingestResult.ok, true);
    const ingestedIndex = JSON.parse(await readFile(path.join(ctx.feedbackRoot, ingestPath), "utf8")) as { records: Array<{ id: string }> };
    assert.deepEqual(ingestedIndex.records.map((record) => record.id), ["manual:nested-index"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool output search paths cannot escape feedbackRoot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tool-output-search-traversal-"));
  try {
    const ctx = toolContext(root);
    const build = getToolModule("build_tool_output_search_index");
    const ingest = getToolModule("ingest_tool_output_record");
    assert.ok(build);
    assert.ok(ingest);

    await assert.rejects(
      build.handler({
        includeFeedbackIssues: false,
        includeFixLearnings: false,
        outputPath: "../escaped-build-index.json"
      }, ctx),
      /must stay inside feedbackRoot/
    );
    await assert.rejects(
      ingest.handler({
        indexPath: "../escaped-ingest-index.json",
        record: {
          id: "manual:escaped-index",
          kind: "tool_log",
          title: "Escaped index",
          text: "This record must not be written outside feedbackRoot."
        }
      }, ctx),
      /must stay inside feedbackRoot/
    );
    await assert.rejects(readFile(path.join(root, "escaped-build-index.json")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(root, "escaped-ingest-index.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool-output-search skill exposes tools through core, coding, and debug skills", () => {
  const toolNames = [
    "build_tool_output_search_index",
    "ingest_tool_output_record",
    "search_tool_outputs",
    "find_similar_tool_errors",
    "summarize_tool_output_search_sources",
    "export_tool_output_search_report"
  ];
  const toolOutputSearch = skillRegistry.find((entry) => entry.id === "tool-output-search");
  const core = skillRegistry.find((entry) => entry.id === "core");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(toolOutputSearch);
  for (const toolName of toolNames) {
    assert.ok(toolOutputSearch!.toolNames.includes(toolName), `${toolName} exposed in tool-output-search`);
    assert.ok(core?.toolNames.includes(toolName), `${toolName} exposed in core`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
