import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getToolModule } from "../src/mcp/registry.js";
import type { ToolContext } from "../src/mcp/types.js";
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
    clientId: "sandbox-execution-test"
  };
}

test("sandbox execution tools run bounded scripts, collect artifacts, report, and clean up", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-execution-"));
  try {
    const ctx = toolContext(root);
    const createProfile = getToolModule("create_sandbox_profile");
    const prepare = getToolModule("prepare_sandbox_workspace");
    const run = getToolModule("run_sandboxed_command");
    const list = getToolModule("list_sandbox_runs");
    const report = getToolModule("export_sandbox_report");
    const cleanup = getToolModule("cleanup_sandbox");
    for (const [name, tool] of Object.entries({ createProfile, prepare, run, list, report, cleanup })) assert.ok(tool, `${name} registered`);

    const profileResult = await createProfile!.handler({
      kind: "code_script",
      title: "Node script sandbox",
      allowedCommands: ["node"],
      cleanupPolicy: "keep"
    }, ctx);
    assert.equal(profileResult.ok, true);
    const profile = (profileResult.structuredContent as { profile: unknown }).profile;

    const prepared = await prepare!.handler({
      profile,
      files: [{
        path: "script.js",
        content: "const fs = require('node:fs');\nfs.writeFileSync('result.txt', 'sandbox ok');\nconsole.log('hello sandbox');\n"
      }]
    }, ctx);
    assert.equal(prepared.ok, true);
    const sandboxId = (prepared.structuredContent as { sandboxId: string }).sandboxId;

    const runResult = await run!.handler({ sandboxId, command: "node", args: ["script.js"], collectArtifacts: ["result.txt"] }, ctx);
    assert.equal(runResult.ok, true);
    assert.match(runResult.logs.join("\n"), /hello sandbox/);
    const runPayload = runResult.structuredContent as { run: { artifacts: Array<{ path: string }>; ok: boolean } };
    assert.equal(runPayload.run.ok, true);
    assert.deepEqual(runPayload.run.artifacts.map((artifact) => artifact.path), ["result.txt"]);

    const manifestPath = path.join(ctx.artifactRoot, "sandboxes", sandboxId, "sandbox-manifest.json");
    assert.match(await readFile(manifestPath, "utf8"), /hello sandbox/);

    const listed = await list!.handler({ limit: 10 }, ctx);
    assert.equal(listed.ok, true);
    const listPayload = listed.structuredContent as { sandboxes: Array<{ sandboxId: string; runCount: number }> };
    assert.ok(listPayload.sandboxes.some((sandbox) => sandbox.sandboxId === sandboxId && sandbox.runCount === 1));

    const reportResult = await report!.handler({ sandboxId }, ctx);
    assert.equal(reportResult.ok, true);
    const reportPath = (reportResult.structuredContent as { path: string }).path;
    const markdown = await readFile(reportPath, "utf8");
    assert.match(markdown, new RegExp(sandboxId));
    assert.match(markdown, /node script.js/);

    await cleanup!.handler({ sandboxId }, ctx);
    await assert.rejects(access(path.join(ctx.artifactRoot, "sandboxes", sandboxId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox execution rejects commands outside the profile allowlist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-execution-deny-"));
  try {
    const ctx = toolContext(root);
    const prepare = getToolModule("prepare_sandbox_workspace");
    const run = getToolModule("run_sandboxed_command");
    assert.ok(prepare);
    assert.ok(run);

    const prepared = await prepare!.handler({
      profile: {
        kind: "code_script",
        title: "Allow node only",
        allowedCommands: ["node"],
        cleanupPolicy: "keep"
      },
      files: [{ path: "script.js", content: "console.log('ok');\n" }]
    }, ctx);
    const sandboxId = (prepared.structuredContent as { sandboxId: string }).sandboxId;

    await assert.rejects(
      run!.handler({ sandboxId, command: "python3", args: ["script.py"] }, ctx),
      /not allowed by sandbox profile/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup-on-success returns artifact bytes inline instead of paths into the deleted workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-execution-cleanup-"));
  try {
    const ctx = toolContext(root);
    const createProfile = getToolModule("create_sandbox_profile");
    const prepare = getToolModule("prepare_sandbox_workspace");
    const run = getToolModule("run_sandboxed_command");
    assert.ok(createProfile);
    assert.ok(prepare);
    assert.ok(run);

    // cleanupPolicy is omitted so this also pins that cleanup_on_success is the default.
    const profileResult = await createProfile!.handler({ kind: "code_script", title: "Default cleanup policy", allowedCommands: ["node"] }, ctx);
    const profile = (profileResult.structuredContent as { profile: { cleanupPolicy: string } }).profile;
    assert.equal(profile.cleanupPolicy, "cleanup_on_success");

    const prepared = await prepare!.handler({
      profile,
      files: [{ path: "script.js", content: "const fs = require('node:fs');\nfs.writeFileSync('result.txt', 'sandbox ok');\n" }]
    }, ctx);
    const sandboxId = (prepared.structuredContent as { sandboxId: string }).sandboxId;

    const runResult = await run!.handler({ sandboxId, command: "node", args: ["script.js"], collectArtifacts: ["result.txt"] }, ctx);
    assert.equal(runResult.ok, true);

    // The workspace really is gone, and every returned path still resolves.
    const sandboxDir = path.join(ctx.artifactRoot, "sandboxes", sandboxId);
    await assert.rejects(access(sandboxDir));
    for (const artifactPath of runResult.artifacts) {
      await access(artifactPath);
      assert.ok(!artifactPath.startsWith(`${sandboxDir}${path.sep}`), `${artifactPath} must not point into the deleted workspace`);
    }

    // The collected artifact is still recoverable by the caller.
    const payload = runResult.structuredContent as {
      workspaceRemoved: boolean;
      run: { artifacts: Array<{ path: string }> };
      collectedArtifacts: Array<{ path: string; size: number; encoding: string; content: string; truncated: boolean; omittedBytes: number }>;
    };
    assert.equal(payload.workspaceRemoved, true);
    assert.deepEqual(payload.run.artifacts.map((artifact) => artifact.path), ["result.txt"]);
    assert.deepEqual(payload.collectedArtifacts, [{
      path: "result.txt",
      size: 10,
      encoding: "utf8",
      content: "sandbox ok",
      truncated: false,
      omittedBytes: 0
    }]);

    // Run history survives the cleanup: archived manifest, list, and report all still work.
    const archived = path.join(ctx.artifactRoot, "sandboxes", `${sandboxId}.manifest.json`);
    assert.equal((runResult.structuredContent as { archivedManifest: string }).archivedManifest, archived);
    const archivedManifest = JSON.parse(await readFile(archived, "utf8")) as { sandboxId: string; removedAt?: string; runs: Array<{ artifacts: Array<{ path: string }> }> };
    assert.equal(archivedManifest.sandboxId, sandboxId);
    assert.ok(archivedManifest.removedAt, "archived manifest records when the workspace was removed");
    assert.deepEqual(archivedManifest.runs[0]!.artifacts.map((artifact) => artifact.path), ["result.txt"]);

    const list = getToolModule("list_sandbox_runs");
    const listed = await list!.handler({ limit: 10 }, ctx);
    const listPayload = listed.structuredContent as { sandboxes: Array<{ sandboxId: string; runCount: number }> };
    assert.ok(listPayload.sandboxes.some((sandbox) => sandbox.sandboxId === sandboxId && sandbox.runCount === 1), "removed sandbox still listed");

    const report = getToolModule("export_sandbox_report");
    const reportResult = await report!.handler({ sandboxId }, ctx);
    assert.equal(reportResult.ok, true);
    const reportPath = (reportResult.structuredContent as { path: string }).path;
    // The report goes to a sibling directory, never back inside the deleted workspace.
    assert.ok(!reportPath.startsWith(`${sandboxDir}${path.sep}`), "report must not resurrect the workspace");
    assert.match(await readFile(reportPath, "utf8"), /Workspace: removed at /);

    // An explicit cleanup purges the archive too, so the sandbox can actually be forgotten.
    const cleanup = getToolModule("cleanup_sandbox");
    await cleanup!.handler({ sandboxId }, ctx);
    await assert.rejects(access(archived));
    const afterCleanup = await list!.handler({ limit: 10 }, ctx);
    const afterPayload = afterCleanup.structuredContent as { sandboxes: Array<{ sandboxId: string }> };
    assert.ok(!afterPayload.sandboxes.some((sandbox) => sandbox.sandboxId === sandboxId), "purged sandbox no longer listed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inline artifacts are bounded by maxOutputBytes and report what was omitted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-execution-budget-"));
  try {
    const ctx = toolContext(root);
    const prepare = getToolModule("prepare_sandbox_workspace");
    const run = getToolModule("run_sandboxed_command");
    assert.ok(prepare);
    assert.ok(run);

    const prepared = await prepare!.handler({
      profile: { kind: "code_script", title: "Oversized artifact", allowedCommands: ["node"], cleanupPolicy: "cleanup_on_success" },
      files: [{
        path: "script.js",
        content: "const fs = require('node:fs');\nfs.writeFileSync('big.txt', 'a'.repeat(3000));\nfs.writeFileSync('second.txt', 'b'.repeat(10));\n"
      }]
    }, ctx);
    const sandboxId = (prepared.structuredContent as { sandboxId: string }).sandboxId;

    const runResult = await run!.handler({
      sandboxId,
      command: "node",
      args: ["script.js"],
      maxOutputBytes: 1000,
      collectArtifacts: ["big.txt", "second.txt"]
    }, ctx);
    assert.equal(runResult.ok, true);

    const collected = (runResult.structuredContent as {
      collectedArtifacts: Array<{ path: string; size: number; content: string; truncated: boolean; omittedBytes: number }>;
    }).collectedArtifacts;
    assert.deepEqual(collected.map((artifact) => artifact.path), ["big.txt", "second.txt"]);

    // First artifact eats the whole 1000-byte budget and reports the rest as omitted.
    assert.equal(collected[0]!.size, 3000);
    assert.equal(collected[0]!.content.length, 1000);
    assert.equal(collected[0]!.truncated, true);
    assert.equal(collected[0]!.omittedBytes, 2000);

    // Budget exhausted: the second artifact is still listed, not silently dropped.
    assert.equal(collected[1]!.size, 10);
    assert.equal(collected[1]!.content, "");
    assert.equal(collected[1]!.truncated, true);
    assert.equal(collected[1]!.omittedBytes, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archiving prunes the oldest manifests past the 200 cap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-execution-prune-"));
  try {
    const ctx = toolContext(root);
    const prepare = getToolModule("prepare_sandbox_workspace");
    const run = getToolModule("run_sandboxed_command");
    const list = getToolModule("list_sandbox_runs");
    assert.ok(prepare);
    assert.ok(run);

    // Seed 201 archived manifests with explicit, strictly increasing mtimes so the prune
    // order is deterministic. Oldest is stale_000, newest is stale_200.
    const archiveDir = path.join(ctx.artifactRoot, "sandboxes");
    await mkdir(archiveDir, { recursive: true });
    const seeded: string[] = [];
    for (let index = 0; index < 201; index += 1) {
      const id = `sandbox_stale_${String(index).padStart(3, "0")}`;
      const file = path.join(archiveDir, `${id}.manifest.json`);
      await writeFile(file, JSON.stringify({
        version: 1,
        sandboxId: id,
        profile: { kind: "code_script", title: id, timeoutMs: 1000, maxOutputBytes: 1000, maxArtifactBytes: 1000, cleanupPolicy: "cleanup_on_success", allowedCommands: ["node"] },
        root: path.join(archiveDir, id),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        removedAt: "2026-01-01T00:00:00.000Z",
        runs: []
      }), "utf8");
      const stamp = new Date(Date.UTC(2026, 0, 1) + index * 60000);
      await utimes(file, stamp, stamp);
      seeded.push(file);
    }

    const prepared = await prepare!.handler({
      profile: { kind: "code_script", title: "Prune trigger", allowedCommands: ["node"], cleanupPolicy: "cleanup_on_success" },
      files: [{ path: "script.js", content: "console.log('ok');\n" }]
    }, ctx);
    const sandboxId = (prepared.structuredContent as { sandboxId: string }).sandboxId;

    const runResult = await run!.handler({ sandboxId, command: "node", args: ["script.js"] }, ctx);
    assert.equal(runResult.ok, true);

    // 201 seeded + 1 new = 202; the two oldest go, leaving exactly the cap.
    const payload = runResult.structuredContent as { archivedManifest: string; prunedArchives: string[] };
    assert.deepEqual(payload.prunedArchives.sort(), [seeded[0]!, seeded[1]!].sort());
    assert.match(runResult.summary, /Pruned 2 archived manifest\(s\) past the 200 cap\./);
    await assert.rejects(access(seeded[0]!));
    await assert.rejects(access(seeded[1]!));
    await access(seeded[2]!);
    // The manifest just archived is never a prune candidate, even against older mtimes.
    await access(payload.archivedManifest);

    const remaining = (await readdir(archiveDir)).filter((name) => name.endsWith(".manifest.json"));
    assert.equal(remaining.length, 200);

    const listed = await list!.handler({ limit: 200 }, ctx);
    const listPayload = listed.structuredContent as { sandboxes: Array<{ sandboxId: string }> };
    assert.equal(listPayload.sandboxes.length, 200);
    assert.ok(listPayload.sandboxes.some((sandbox) => sandbox.sandboxId === sandboxId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup_always removes the workspace even when the run throws after the manifest is read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-execution-always-"));
  try {
    const ctx = toolContext(root);
    const prepare = getToolModule("prepare_sandbox_workspace");
    const run = getToolModule("run_sandboxed_command");
    assert.ok(prepare);
    assert.ok(run);

    const prepared = await prepare!.handler({
      profile: { kind: "code_script", title: "Always clean up", allowedCommands: ["node"], cleanupPolicy: "cleanup_always" },
      files: [{ path: "script.js", content: "console.log('ok');\n" }]
    }, ctx);
    const sandboxId = (prepared.structuredContent as { sandboxId: string }).sandboxId;

    await assert.rejects(
      run!.handler({ sandboxId, command: "python3", args: ["script.py"] }, ctx),
      /not allowed by sandbox profile/
    );
    await assert.rejects(access(path.join(ctx.artifactRoot, "sandboxes", sandboxId)));
    // A sandbox that never completed a run must not leave an archived manifest behind.
    await assert.rejects(access(path.join(ctx.artifactRoot, "sandboxes", `${sandboxId}.manifest.json`)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox-execution skill exposes tools through core, coding, and debug skills", () => {
  const toolNames = [
    "create_sandbox_profile",
    "prepare_sandbox_workspace",
    "run_sandboxed_command",
    "list_sandbox_runs",
    "cleanup_sandbox",
    "export_sandbox_report"
  ];
  const sandbox = skillRegistry.find((entry) => entry.id === "sandbox-execution");
  const core = skillRegistry.find((entry) => entry.id === "core");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(sandbox);
  for (const toolName of toolNames) {
    assert.ok(sandbox!.toolNames.includes(toolName), `${toolName} exposed in sandbox-execution`);
    assert.ok(core?.toolNames.includes(toolName), `${toolName} exposed in core`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
