import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, getProjectWorkspaceDirectory } from "../src/projects/store.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: path.join(root, "default-workspace"),
    commandTimeoutMs: 10000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "test-client"
  };
}

// Regression: a query starting with `-` must be passed to ripgrep as a search
// pattern, not parsed as a flag. Without the `--` end-of-options separator a query
// like `--pre=<cmd>` would be interpreted by rg as the (RCE-capable) --pre flag.
test("search_in_project treats a `-`-leading query as a literal pattern, not a ripgrep flag", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-rg-injection-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "rg target", createdByClientId: "test-client" });
    const workspace = getProjectWorkspaceDirectory(ctx.projectRoot, project.id);

    // A file whose CONTENT is the literal flag-looking string we will search for.
    await writeFile(path.join(workspace, "notes.txt"), "harmless\n--pre=pwned\nmore\n", "utf8");

    const sentinel = path.join(root, "SENTINEL_SHOULD_NOT_EXIST");
    const result = await callTool("search_in_project", {
      projectId: project.id,
      query: `--pre=touch ${sentinel}`,
      useRegex: false
    }, ctx);

    // The query is searched literally (no match for that exact string) and, crucially,
    // no preprocessor command ran.
    assert.equal(result.ok, true, "search completes without throwing on a flag-looking query");
    await assert.rejects(stat(sentinel), "the --pre preprocessor must NOT have executed");

    // And a literal match for a `--`-leading string is still found, proving the query
    // reaches rg as a pattern rather than being rejected as an unknown flag.
    const matchResult = await callTool("search_in_project", {
      projectId: project.id,
      query: "--pre=pwned",
      useRegex: false
    }, ctx);
    assert.equal(matchResult.ok, true);
    assert.match(matchResult.logs.join("\n"), /--pre=pwned/, "literal flag-looking content is matched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
