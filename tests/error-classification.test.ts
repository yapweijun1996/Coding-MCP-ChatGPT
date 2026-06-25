import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { appendProjectTaskHistory, createProject, readProjectFile } from "../src/projects/store.js";
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
    clientId: "error-classification-test"
  };
}

test("classify_project_errors groups root causes, files, selectors, fixes, and next tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "error-classification-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Failure project", createdByClientId: "coder" });
    await appendProjectTaskHistory(ctx.projectRoot, project.id, {
      toolName: "inspect_webpage_plus",
      ok: false,
      summary: "Console error: TypeError Cannot read properties of undefined in src/App.tsx:42:9 selector=.checkout-button",
      details: { pageError: "TypeError Cannot read properties of undefined" }
    });

    const result = await callTool("classify_project_errors", {
      projectId: project.id,
      failures: [
        {
          source: "build",
          toolName: "run_project_build",
          errors: ["SyntaxError: Unexpected token in src/main.ts:12:4"]
        },
        {
          source: "build-repeat",
          toolName: "run_project_build",
          logs: ["SyntaxError: Unexpected token in src/main.ts:22:8"]
        },
        {
          source: "network",
          toolName: "inspect_network_conditions",
          summary: "Failed to fetch https://api.example.test/users because CORS blocked the request and HTTP 500 was returned."
        },
        {
          source: "layout",
          toolName: "inspect_webpage_plus",
          summary: "Detected horizontal overflow and element=.sticky-footer covered by footer on mobile viewport in styles.css."
        },
        {
          source: "schema",
          toolName: "write_project_file",
          errors: ["Invalid arguments — content: String must contain at most 1048576 character(s)"]
        }
      ]
    }, ctx);

    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts.sort(), ["diagnostics/error-classification.json", "diagnostics/error-classification.md"].sort());
    const report = result.structuredContent as {
      totalFailures: number;
      summary: Record<string, number>;
      groups: Array<{ rootCause: string; occurrences: number; affectedFiles: string[]; affectedSelectors: string[]; suggestedFixes: string[]; recommendedNextTool: string }>;
    };
    assert.equal(report.totalFailures, 6);
    assert.equal(report.summary.syntax, 2);
    assert.equal(report.summary.network, 1);
    assert.equal(report.summary["css-layout"], 1);
    assert.equal(report.summary.schema, 1);
    assert.equal(report.summary["runtime-logic"], 1);

    const syntax = report.groups.find((group) => group.rootCause === "syntax");
    assert.equal(syntax?.occurrences, 2);
    assert.deepEqual(syntax?.affectedFiles, ["src/main.ts"]);
    assert.equal(syntax?.recommendedNextTool, "read_project_file");

    const layout = report.groups.find((group) => group.rootCause === "css-layout");
    assert.ok(layout?.affectedSelectors.includes(".sticky-footer"));
    assert.equal(layout?.recommendedNextTool, "inspect_dom_at_point");

    const runtime = report.groups.find((group) => group.rootCause === "runtime-logic");
    assert.ok(runtime?.affectedFiles.includes("src/App.tsx"));
    assert.ok(runtime?.affectedSelectors.includes(".checkout-button"));
    assert.ok(runtime?.suggestedFixes.length);

    const markdown = await readProjectFile(ctx.projectRoot, project.id, "diagnostics/error-classification.md");
    assert.match(markdown, /# Error Classification Report/);
    assert.match(markdown, /runtime-logic/);
    assert.match(markdown, /inspect_webpage_plus/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classify_project_errors supports raw text without a project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "error-classification-"));
  try {
    const result = await callTool("classify_project_errors", {
      rawText: "ENOENT: no such file or directory, open 'public/logo.svg'"
    }, toolContext(root));
    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts, []);
    const report = result.structuredContent as { groups: Array<{ rootCause: string; affectedFiles: string[]; recommendedNextTool: string }> };
    assert.equal(report.groups[0]?.rootCause, "missing-file");
    assert.deepEqual(report.groups[0]?.affectedFiles, ["public/logo.svg"]);
    assert.equal(report.groups[0]?.recommendedNextTool, "get_project_manifest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classify_project_errors explains vague pre-MCP safety blocks with safe retry guidance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "error-classification-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Safety block project", createdByClientId: "coder" });
    const result = await callTool("classify_project_errors", {
      projectId: project.id,
      failures: [
        {
          source: "tool-preflight",
          toolName: "write_project_file",
          summary: "Tool call was blocked by safety checks before MCP execution. Double check the input. The payload includes a large inline base64 data URI."
        }
      ]
    }, ctx);
    assert.equal(result.ok, true);
    const report = result.structuredContent as {
      groups: Array<{ rootCause: string; reasonCategory?: string; safeRetrySuggestion?: string; suggestedFixes: string[] }>;
    };
    const safety = report.groups.find((group) => group.rootCause === "safety-block");
    assert.equal(safety?.reasonCategory, "client-preflight-content-guard");
    assert.match(safety?.safeRetrySuggestion ?? "", /smaller bounded payload/);
    assert.match(safety?.safeRetrySuggestion ?? "", /file path\/artifact reference|artifact reference/);

    const markdown = await readProjectFile(ctx.projectRoot, project.id, "diagnostics/error-classification.md");
    assert.match(markdown, /Reason category: client-preflight-content-guard/);
    assert.match(markdown, /Safe retry:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("error classification is exposed through coding and debug skills", () => {
  for (const skillId of ["coding", "debug"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill!.toolNames.includes("classify_project_errors"), `${skillId} exposes classify_project_errors`);
  }
});
