import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject } from "../src/projects/store.js";

const execFileAsync = promisify(execFile);

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

async function setupProject(root: string): Promise<{ ctx: ToolContext; projectId: string }> {
  const ctx = toolContext(root);
  await mkdir(ctx.workspaceRoot, { recursive: true });
  const repo = path.join(ctx.workspaceRoot, "repo");
  await execFileAsync("git", ["init", repo]);
  const project = await createProject(ctx.projectRoot, { title: "Fallback search project", createdByClientId: "test-client" });

  await writeFile(path.join(repo, "index.html"), "<h1>Bound workspace</h1>\n<p>NEEDLE-ALPHA here</p>\n", "utf8");
  await writeFile(path.join(repo, "notes.txt"), "nothing interesting\nneedle-alpha lowercase\n", "utf8");
  await mkdir(path.join(repo, "nested"), { recursive: true });
  await writeFile(path.join(repo, "nested", "deep.txt"), "line one\nline two NEEDLE-ALPHA\n", "utf8");
  // A binary file must be skipped, not decoded into garbage matches.
  await writeFile(path.join(repo, "blob.bin"), Buffer.from([0x00, 0x01, 0x4e, 0x45, 0x45, 0x44, 0x4c, 0x45]));

  await callTool("bind_project_workspace", { projectId: project.id, workspacePath: repo }, ctx);
  return { ctx, projectId: project.id };
}

// Forces the `spawn rg ENOENT` branch by handing the child process a PATH with no ripgrep on
// it. This exercises the real catch block in the handler rather than calling the fallback
// helper directly — the bug being guarded against was that the branch returned ok:false, so
// the branch itself is what must be tested.
async function withoutRipgrepOnPath<T>(run: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  const emptyDir = await mkdtemp(path.join(tmpdir(), "no-rg-"));
  process.env.PATH = emptyDir;
  try {
    return await run();
  } finally {
    process.env.PATH = originalPath;
    await rm(emptyDir, { recursive: true, force: true });
  }
}

test("search_in_project falls back to an in-process scan when ripgrep is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-search-fallback-"));
  try {
    const { ctx, projectId } = await setupProject(root);

    const result = await withoutRipgrepOnPath(() =>
      callTool("search_in_project", { projectId, query: "NEEDLE-ALPHA" }, ctx)
    );

    // Before this change the same call returned ok:false — 125/125 in production.
    assert.equal(result.ok, true, `expected fallback success, got: ${JSON.stringify(result.errors)}`);
    const structured = result.structuredContent as { engine?: string; matches?: Array<{ path: string; line: number; text: string }>; filesSkipped?: number };
    assert.equal(structured.engine, "in-process", "should report which engine answered");

    const matches = structured.matches ?? [];
    const paths = matches.map((match) => match.path).sort();
    // Case-insensitive by default, so the lowercase hit in notes.txt counts too, and the
    // walk must recurse into nested/.
    assert.deepEqual(paths, ["index.html", "nested/deep.txt", "notes.txt"]);
    const nested = matches.find((match) => match.path === "nested/deep.txt");
    assert.equal(nested?.line, 2, "line numbers are 1-based");
    assert.match(nested?.text ?? "", /NEEDLE-ALPHA/);

    assert.ok(!paths.includes("blob.bin"), "binary files must be skipped, not matched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fallback honours caseSensitive and returns no matches rather than failing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-search-fallback-case-"));
  try {
    const { ctx, projectId } = await setupProject(root);

    const result = await withoutRipgrepOnPath(() =>
      callTool("search_in_project", { projectId, query: "needle-alpha", caseSensitive: true }, ctx)
    );

    assert.equal(result.ok, true);
    const structured = result.structuredContent as { matches?: Array<{ path: string }> };
    // Only notes.txt has the lowercase spelling; the two uppercase hits must not match.
    assert.deepEqual((structured.matches ?? []).map((match) => match.path), ["notes.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fallback reports an invalid regex instead of throwing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-search-fallback-regex-"));
  try {
    const { ctx, projectId } = await setupProject(root);

    const result = await withoutRipgrepOnPath(() =>
      callTool("search_in_project", { projectId, query: "NEEDLE(", useRegex: true }, ctx)
    );

    assert.equal(result.ok, false, "a malformed pattern is a caller error, not a silent empty result");
    assert.match(result.errors.join(" "), /Invalid regular expression/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ripgrep is still preferred when it is on PATH", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-search-rg-"));
  try {
    const { ctx, projectId } = await setupProject(root);
    const result = await callTool("search_in_project", { projectId, query: "NEEDLE-ALPHA" }, ctx);
    assert.equal(result.ok, true);
    // The rg path returns raw --json output in logs and sets no `engine`, so its absence is
    // what proves the fallback did not hijack the normal route.
    const structured = (result.structuredContent ?? {}) as { engine?: string };
    assert.notEqual(structured.engine, "in-process", "ripgrep should answer when available");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
