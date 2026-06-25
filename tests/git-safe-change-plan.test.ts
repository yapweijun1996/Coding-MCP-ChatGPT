import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { getToolModule } from "../src/mcp/registry.js";
import type { ToolContext } from "../src/mcp/types.js";
import { skillRegistry } from "../src/skills/registry.js";

const execFileAsync = promisify(execFile);

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "git-safe-change-plan-test"
  };
}

async function git(root: string, args: string[]) {
  return execFileAsync("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
}

test("git_safe_change_plan summarizes diffs and creates checkpoint branches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "git-safe-change-plan-"));
  try {
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "agent@example.test"]);
    await git(root, ["config", "user.name", "Agent"]);
    await writeFile(path.join(root, "app.ts"), "export const value = 1;\n", "utf8");
    await git(root, ["add", "app.ts"]);
    await git(root, ["commit", "-m", "initial"]);
    await writeFile(path.join(root, "app.ts"), "export const value = 2;\n", "utf8");
    await writeFile(path.join(root, "notes.md"), "# Notes\n", "utf8");

    const ctx = toolContext(root);
    const plan = getToolModule("git_safe_change_plan");
    assert.ok(plan, "git_safe_change_plan registered");

    const previewResult = await plan!.handler({ selectedPaths: ["app.ts"], includePatch: true }, ctx);
    assert.equal(previewResult.ok, true);
    const preview = previewResult.structuredContent as {
      currentBranch: string;
      head: string;
      createdCheckpoint: boolean;
      changedFiles: Array<{ path: string; status: string; staged: boolean; unstaged: boolean }>;
      selectedPaths: string[];
      patchPreview: string;
      suggestedCommands: { stageSelected: string[]; revertSelected: string[]; finalReview: string[] };
      warnings: string[];
    };
    assert.equal(preview.currentBranch, "master");
    assert.match(preview.head, /^[a-f0-9]+$/);
    assert.equal(preview.createdCheckpoint, false);
    assert.ok(preview.changedFiles.some((file) => file.path === "app.ts" && file.unstaged));
    assert.ok(preview.changedFiles.some((file) => file.path === "notes.md" && file.status === "??"));
    assert.deepEqual(preview.selectedPaths, ["app.ts"]);
    assert.match(preview.patchPreview, /value = 2/);
    assert.deepEqual(preview.suggestedCommands.stageSelected, ["git add -- app.ts"]);
    assert.deepEqual(preview.suggestedCommands.revertSelected, ["git restore -- app.ts"]);
    assert.ok(preview.suggestedCommands.finalReview.includes("git diff --cached"));
    assert.ok(preview.warnings.some((warning) => warning.includes("Untracked files")));

    const checkpointResult = await plan!.handler({ checkpointLabel: "SSOT module refactor", createCheckpoint: true }, ctx);
    assert.equal(checkpointResult.ok, true);
    const checkpoint = checkpointResult.structuredContent as { createdCheckpoint: boolean; checkpointBranch: string };
    assert.equal(checkpoint.createdCheckpoint, true);
    assert.match(checkpoint.checkpointBranch, /^checkpoint\/ssot-module-refactor-/);
    const branches = (await git(root, ["branch", "--list", checkpoint.checkpointBranch])).stdout;
    assert.match(branches, new RegExp(checkpoint.checkpointBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git_safe_change_plan is exposed through core, coding, debug, and code intelligence skills", () => {
  const toolName = "git_safe_change_plan";
  for (const id of ["core", "coding", "debug", "agent-code-intelligence"]) {
    const skill = skillRegistry.find((entry) => entry.id === id);
    assert.ok(skill, `${id} skill exists`);
    assert.ok(skill!.toolNames.includes(toolName), `${toolName} exposed in ${id}`);
  }
});
