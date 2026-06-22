import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, writeProjectFile } from "../src/projects/store.js";
import { runProjectGitCommand } from "../src/mcp/tools/project-dev.js";
import type { ToolContext } from "../src/mcp/types.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: path.join(root, "tenant-workspace"),
    commandTimeoutMs: 30000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    telemetryRoot: "",
    jobsRoot: path.join(root, "jobs"),
    projectRoot: path.join(root, "projects"),
    clientId: "chatgpt"
  };
}

test("init_project_git creates a real bound git repo so git tools work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "initgit-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Landing", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><body>hi</body></html>\n");
    await writeProjectFile(ctx.projectRoot, project.id, "styles.css", "body{color:#333}\n");

    const tool = getToolModule("init_project_git");
    assert.ok(tool, "init_project_git registered");
    const result = await tool!.handler({ projectId: project.id }, ctx);
    assert.equal(result.ok, true);
    const sc = result.structuredContent as { workspace: string; initialized: boolean; importedFiles: number; committed: boolean };
    assert.equal(sc.initialized, true);
    assert.equal(sc.importedFiles, 2, "both project files imported into the repo");
    assert.equal(sc.committed, true);

    // The workspace is a real git work tree with the imported files.
    await stat(path.join(sc.workspace, ".git"));
    await stat(path.join(sc.workspace, "index.html"));

    // Project-scoped git now resolves (no "not bound" error) and shows a clean tree with history.
    const status = await runProjectGitCommand(ctx, project.id, ["status", "--porcelain"]);
    assert.equal(status.stdout.trim(), "", "tree is clean right after the import commit");
    const log = await runProjectGitCommand(ctx, project.id, ["log", "--oneline"]);
    assert.match(log.stdout, /Import 2 file\(s\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init_project_git creates a nested repo and does NOT commit to an ancestor repo", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const run = promisify(execFile);
  const root = await mkdtemp(path.join(tmpdir(), "initgit-"));
  try {
    const ctx = toolContext(root);
    // Make the tenant workspace root itself a git repo (simulates the host-mounted /data/workspace).
    await mkdir(ctx.workspaceRoot, { recursive: true });
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    await run("git", ["init", "-b", "main"], { cwd: ctx.workspaceRoot, env });
    await run("git", ["config", "user.email", "host@test"], { cwd: ctx.workspaceRoot, env });
    await run("git", ["config", "user.name", "Host"], { cwd: ctx.workspaceRoot, env });
    await writeFile(path.join(ctx.workspaceRoot, "host.txt"), "host\n");
    await run("git", ["add", "-A"], { cwd: ctx.workspaceRoot, env });
    await run("git", ["commit", "-m", "host initial"], { cwd: ctx.workspaceRoot, env });
    const before = (await run("git", ["rev-list", "--count", "HEAD"], { cwd: ctx.workspaceRoot, env })).stdout.trim();

    const project = await createProject(ctx.projectRoot, { title: "Nested", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<html></html>\n");
    const result = await getToolModule("init_project_git")!.handler({ projectId: project.id }, ctx);
    assert.equal(result.ok, true);
    const sc = result.structuredContent as { workspace: string; gitRoot: string };

    // A fresh nested repo was created AT the workspace subdir, not the ancestor.
    assert.notEqual(sc.gitRoot, ctx.workspaceRoot);
    await stat(path.join(sc.workspace, ".git"));
    // The ancestor (host) repo must be untouched — same commit count, no new staged commit.
    const after = (await run("git", ["rev-list", "--count", "HEAD"], { cwd: ctx.workspaceRoot, env })).stdout.trim();
    assert.equal(after, before, "the ancestor/host repo must not receive a commit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init_project_git is idempotent (re-run rebinds without error)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "initgit-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "x", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<html></html>\n");
    const tool = getToolModule("init_project_git");
    const first = await tool!.handler({ projectId: project.id }, ctx);
    const second = await tool!.handler({ projectId: project.id }, ctx);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal((second.structuredContent as { initialized: boolean }).initialized, false, "second run reuses the existing repo");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
