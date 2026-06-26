import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";

const execFileAsync = promisify(execFile);

// These tests exercise the highest-blast-radius legacy primitives — arbitrary file
// writes (write_file/replace_in_file), shell execution (run_command), and git config
// mutation (git_config) — through the real router dispatch path. The focus is the
// sandbox/path-traversal/allowlist guards: a silent regression here is the most costly
// failure mode in the server, and before this file only `modernize_legacy_project` was
// covered.

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 5000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "legacy-workspace-test"
  };
}

// The legacy callTool catch block puts a generic "Tool X failed." in `summary` but keeps
// the real cause in `errors[0]`, so guard assertions must read the errors array.
function errorText(result: { errors: string[] }): string {
  return result.errors.join(" ");
}

async function withWorkspace(fn: (root: string, ctx: ToolContext) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-workspace-"));
  try {
    await fn(root, toolContext(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("write_file writes inside the workspace and reports byte count", async () => {
  await withWorkspace(async (root, ctx) => {
    const result = await callTool("write_file", { relativePath: "src/note.txt", content: "hello" }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts, ["src/note.txt"]);
    assert.ok(result.logs.some((line) => line.includes("5 bytes")));
    assert.equal(await readFile(path.join(root, "src/note.txt"), "utf8"), "hello");
  });
});

test("write_file rejects absolute paths", async () => {
  await withWorkspace(async (_root, ctx) => {
    const result = await callTool("write_file", { relativePath: "/etc/evil", content: "x" }, ctx);
    assert.equal(result.ok, false);
    assert.match(errorText(result), /Absolute paths are not allowed/);
  });
});

test("write_file rejects parent traversal", async () => {
  await withWorkspace(async (root, ctx) => {
    const result = await callTool("write_file", { relativePath: "../escape.txt", content: "x" }, ctx);
    assert.equal(result.ok, false);
    assert.match(errorText(result), /Parent traversal and hidden path segments/);
    // The escape target must not have been created next to the workspace.
    await assert.rejects(readFile(path.join(root, "..", "escape.txt"), "utf8"));
  });
});

test("write_file rejects hidden path segments", async () => {
  await withWorkspace(async (_root, ctx) => {
    const result = await callTool("write_file", { relativePath: ".ssh/authorized_keys", content: "x" }, ctx);
    assert.equal(result.ok, false);
    assert.match(errorText(result), /Parent traversal and hidden path segments/);
  });
});

test("write_file refuses protected basenames", async () => {
  await withWorkspace(async (_root, ctx) => {
    for (const name of ["package.json", "deep/dir/.npmrc", "pnpm-lock.yaml"]) {
      const result = await callTool("write_file", { relativePath: name, content: "{}" }, ctx);
      assert.equal(result.ok, false, `expected ${name} to be refused`);
      assert.match(errorText(result), /protected file/);
    }
  });
});

test("write_file refuses to escape the workspace through an in-workspace symlink", async () => {
  await withWorkspace(async (root, ctx) => {
    const outside = await mkdtemp(path.join(tmpdir(), "legacy-outside-"));
    try {
      // A symlink with no ".." in its path passes the lexical guard; the symlink-escape
      // guard must still catch that the resolved real path leaves the workspace.
      await symlink(outside, path.join(root, "link"), "dir");
      const result = await callTool("write_file", { relativePath: "link/pwned.txt", content: "x" }, ctx);
      assert.equal(result.ok, false);
      assert.match(errorText(result), /symlink/i);
      await assert.rejects(readFile(path.join(outside, "pwned.txt"), "utf8"));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("read_file round-trips content and rejects traversal", async () => {
  await withWorkspace(async (root, ctx) => {
    await writeFile(path.join(root, "data.txt"), "payload", "utf8");
    const ok = await callTool("read_file", { relativePath: "data.txt" }, ctx);
    assert.equal(ok.ok, true);
    assert.ok(ok.logs.includes("payload"));

    const bad = await callTool("read_file", { relativePath: "../../etc/hosts" }, ctx);
    assert.equal(bad.ok, false);
    assert.match(errorText(bad), /Parent traversal/);
  });
});

test("replace_in_file edits an existing file in place", async () => {
  await withWorkspace(async (root, ctx) => {
    await writeFile(path.join(root, "page.txt"), "alpha beta alpha", "utf8");
    const result = await callTool("replace_in_file", { relativePath: "page.txt", find: "alpha", replace: "X", all: true }, ctx);
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(root, "page.txt"), "utf8"), "X beta X");
  });
});

test("replace_in_file is bound to the workspace", async () => {
  await withWorkspace(async (_root, ctx) => {
    const result = await callTool("replace_in_file", { relativePath: "../outside.txt", find: "a", replace: "b" }, ctx);
    assert.equal(result.ok, false);
    assert.match(errorText(result), /Parent traversal/);
  });
});

test("run_command only accepts the npm allowlist", async () => {
  await withWorkspace(async (_root, ctx) => {
    // The schema is a strict enum of three npm scripts; anything else is rejected before
    // any process is spawned. ok===false is the load-bearing signal here.
    for (const command of ["rm -rf /", "node -e \"1\"", "npm install", "echo hi"]) {
      const result = await callTool("run_command", { command }, ctx);
      assert.equal(result.ok, false, `expected ${command} to be rejected`);
      assert.equal(result.artifacts.length, 0);
    }
  });
});

test("git_status reports a clean initialized repository", async () => {
  await withWorkspace(async (root, ctx) => {
    await execFileAsync("git", ["init"], { cwd: root });
    const result = await callTool("git_status", {}, ctx);
    assert.equal(result.ok, true);
    assert.match(result.summary, /git status/i);
  });
});

test("git_config enforces the local-scope, allowlisted-key contract", async () => {
  await withWorkspace(async (root, ctx) => {
    await execFileAsync("git", ["init"], { cwd: root });

    // Allowlisted key + implicit local scope succeeds and persists.
    const allowed = await callTool("git_config", { action: "set", key: "user.email", value: "dev@example.test" }, ctx);
    assert.equal(allowed.ok, true);
    const { stdout } = await execFileAsync("git", ["config", "--local", "--get", "user.email"], { cwd: root });
    assert.equal(stdout.trim(), "dev@example.test");

    // core.pager can be coerced into command execution on the next git run — must be refused.
    const blockedKey = await callTool("git_config", { action: "set", key: "core.pager", value: "touch /tmp/pwned" }, ctx);
    assert.equal(blockedKey.ok, false);
    assert.match(errorText(blockedKey), /not permitted/);

    // Global/system scope is rejected outright.
    const blockedScope = await callTool("git_config", { action: "set", key: "user.email", value: "x@y.z", scope: "global" }, ctx);
    assert.equal(blockedScope.ok, false);
    assert.match(errorText(blockedScope), /repository-local/);
  });
});
