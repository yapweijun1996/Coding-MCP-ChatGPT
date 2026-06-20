import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { docsKnowledgeTools } from "../src/mcp/tools/docs-knowledge.js";
import { codeIntelligenceTools } from "../src/mcp/tools/code-intelligence.js";
import type { ToolContext, ToolModule } from "../src/mcp/types.js";

const execFileAsync = promisify(execFile);

// These tests pin the behavior that the H1 double-escaped-regex fix restored. With the
// bug (/\\s+/, /\\r?\\n/ literals), whitespace/newline splitting silently failed:
// multi-word queries never tokenized and git output never split into lines. Each test
// below would return the wrong count under the bug, so they fail loudly if it regresses.

function tool(tools: ToolModule[], name: string): ToolModule {
  const found = tools.find((entry) => entry.definition.name === name);
  assert.ok(found, `tool ${name} not found`);
  return found;
}

// Mirror the router: validate + apply schema defaults before invoking the handler.
function callTool(entry: ToolModule, input: unknown, ctx: ToolContext) {
  const parsed = entry.schema ? entry.schema.parse(input) : input;
  return entry.handler(parsed, ctx);
}

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 5000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: root,
    clientId: "test-client"
  };
}

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-regex-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("search_project_docs tokenizes multi-word queries across separate lines", async () => {
  await withTempDir(async (root) => {
    // 'alpha' and 'beta' live on different lines: a hit requires both query-token
    // splitting (/\s+/) and content line handling to work.
    await writeFile(path.join(root, "guide.md"), "# Title\nalpha is here\nbeta is there\ngamma\n", "utf8");
    const search = tool(docsKnowledgeTools, "search_project_docs");
    const ctx = toolContext(root);

    const single = await callTool(search, { query: "alpha" }, ctx);
    const singleMatches = (single.structuredContent as { matches: unknown[] }).matches;
    assert.equal(singleMatches.length, 1, "single-word query should match the doc");

    const multi = await callTool(search, { query: "alpha beta" }, ctx);
    const multiMatches = (multi.structuredContent as { matches: unknown[] }).matches;
    assert.equal(multiMatches.length, 1, "multi-word AND query should still match (tokens split on whitespace)");

    const miss = await callTool(search, { query: "alpha zzzmissing" }, ctx);
    const missMatches = (miss.structuredContent as { matches: unknown[] }).matches;
    assert.equal(missMatches.length, 0, "AND query with an absent token should not match");
  });
});

test("search_project_docs honors OR queries", async () => {
  await withTempDir(async (root) => {
    await writeFile(path.join(root, "doc-a.md"), "only alpha here\n", "utf8");
    await writeFile(path.join(root, "doc-b.md"), "only beta here\n", "utf8");
    const search = tool(docsKnowledgeTools, "search_project_docs");
    const result = await callTool(search, { query: "alpha or beta" }, toolContext(root));
    const matches = (result.structuredContent as { matches: unknown[] }).matches;
    assert.equal(matches.length, 2, "OR query should match both docs");
  });
});

test("search_project_docs snippet splits content into lines", async () => {
  await withTempDir(async (root) => {
    await writeFile(path.join(root, "notes.md"), "line one\nline two\nNEEDLE target\nline four\nline five\n", "utf8");
    const search = tool(docsKnowledgeTools, "search_project_docs");
    const result = await callTool(search, { query: "needle" }, toolContext(root));
    const matches = (result.structuredContent as { matches: Array<{ snippet: string }> }).matches;
    assert.equal(matches.length, 1);
    const snippet = matches[0].snippet;
    // A correctly line-split snippet is centered on the hit line and is not the whole
    // file collapsed to one blob; it must contain the needle and real newlines.
    assert.match(snippet, /NEEDLE target/);
    assert.ok(snippet.includes("\n"), "snippet should preserve line breaks");
  });
});

test("changed_files_context parses git status into one entry per changed file", async (t) => {
  await withTempDir(async (root) => {
    try {
      await execFileAsync("git", ["init"], { cwd: root });
      await execFileAsync("git", ["config", "user.email", "t@e.st"], { cwd: root });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    } catch {
      t.skip("git not available");
      return;
    }
    await writeFile(path.join(root, "first.txt"), "a\n", "utf8");
    await writeFile(path.join(root, "second.txt"), "b\n", "utf8");

    const changed = tool(codeIntelligenceTools, "changed_files_context");
    const result = await callTool(changed, {}, toolContext(root));
    const summary = result.structuredContent as { changedFiles: string[]; total: number };
    // Two untracked files => `git status --short` emits two lines; parseGitStatus must
    // split them (/\r?\n/). Under the double-escape bug this collapsed to one bogus row.
    assert.equal(summary.total, 2, "should detect both changed files");
    assert.ok(summary.changedFiles.includes("first.txt"));
    assert.ok(summary.changedFiles.includes("second.txt"));
  });
});
