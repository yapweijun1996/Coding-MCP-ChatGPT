import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getToolModule } from "../src/mcp/registry.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, deleteProjectFile, readProjectFile, writeProjectFile } from "../src/projects/store.js";
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
    clientId: "backup-recovery-test"
  };
}

test("backup recovery tools create, verify, recover files, restore projects, and export archives", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "backup-recovery-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Recovery project", createdByClientId: "backup" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><body><h1>Version 1</h1></body></html>");
    await writeProjectFile(ctx.projectRoot, project.id, "notes/readme.md", "# Notes\n\nRecover me.\n");

    const backup = getToolModule("create_project_backup");
    const list = getToolModule("list_project_backups");
    const verify = getToolModule("verify_recovery_point");
    const recover = getToolModule("recover_deleted_project_file");
    const restore = getToolModule("restore_project_backup");
    const restoreLatest = getToolModule("restore_latest_project_backup");
    const archive = getToolModule("export_project_backup_archive");
    for (const [name, tool] of Object.entries({ backup, list, verify, recover, restore, restoreLatest, archive })) assert.ok(tool, `${name} registered`);

    const backupResult = await backup!.handler({ projectId: project.id, label: "Before risky edit", reason: "Regression safety." }, ctx);
    assert.equal(backupResult.ok, true);
    const backupId = (backupResult.structuredContent as { backup: { backupId: string; fileCount: number } }).backup.backupId;
    assert.equal((backupResult.structuredContent as { backup: { fileCount: number } }).backup.fileCount, 2);

    const verifyResult = await verify!.handler({ backupId }, ctx);
    assert.equal(verifyResult.ok, true);
    const verifyPayload = verifyResult.structuredContent as { verification: { ok: boolean; findings: string[] } };
    assert.equal(verifyPayload.verification.ok, true);
    assert.deepEqual(verifyPayload.verification.findings, []);

    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><body><h1>Version 2</h1></body></html>");
    await writeProjectFile(ctx.projectRoot, project.id, "extra.txt", "temporary file\n");
    await deleteProjectFile(ctx.projectRoot, project.id, "notes/readme.md");

    const latestPreview = await restoreLatest!.handler({ projectId: project.id }, ctx);
    assert.equal(latestPreview.ok, true);
    const latestPreviewPayload = latestPreview.structuredContent as { backupId: string; dryRun: boolean; files: string[]; restored: string[]; verification: { ok: boolean } };
    assert.equal(latestPreviewPayload.backupId, backupId);
    assert.equal(latestPreviewPayload.dryRun, true);
    assert.equal(latestPreviewPayload.verification.ok, true);
    assert.deepEqual(latestPreviewPayload.restored, []);
    assert.ok(latestPreviewPayload.files.includes("index.html"));
    assert.match(await readProjectFile(ctx.projectRoot, project.id, "index.html"), /Version 2/);

    const recoverResult = await recover!.handler({ backupId, projectId: project.id, relativePath: "notes/readme.md", confirm: true }, ctx);
    assert.equal(recoverResult.ok, true);
    assert.match(await readProjectFile(ctx.projectRoot, project.id, "notes/readme.md"), /Recover me/);

    const restoreResult = await restore!.handler({ backupId, projectId: project.id, mode: "overwrite_all", confirm: true }, ctx);
    assert.equal(restoreResult.ok, true);
    assert.match(await readProjectFile(ctx.projectRoot, project.id, "index.html"), /Version 1/);
    await assert.rejects(readProjectFile(ctx.projectRoot, project.id, "extra.txt"), /no such file|ENOENT/i);

    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><body><h1>Version 3</h1></body></html>");
    const latestRestore = await restoreLatest!.handler({ projectId: project.id, mode: "overwrite_all", confirm: true }, ctx);
    assert.equal(latestRestore.ok, true);
    const latestRestorePayload = latestRestore.structuredContent as { backupId: string; dryRun: boolean; restored: string[] };
    assert.equal(latestRestorePayload.backupId, backupId);
    assert.equal(latestRestorePayload.dryRun, false);
    assert.ok(latestRestorePayload.restored.includes("index.html"));
    assert.match(await readProjectFile(ctx.projectRoot, project.id, "index.html"), /Version 1/);

    const archiveResult = await archive!.handler({ backupId }, ctx);
    assert.equal(archiveResult.ok, true);
    const archivePath = (archiveResult.structuredContent as { path: string }).path;
    const archiveJson = JSON.parse(await readFile(archivePath, "utf8")) as { manifest: { backupId: string }; files: Array<{ path: string; contentBase64: string }> };
    assert.equal(archiveJson.manifest.backupId, backupId);
    assert.equal(archiveJson.files.some((file) => file.path === "index.html" && file.contentBase64.length > 0), true);

    const listResult = await list!.handler({ projectId: project.id }, ctx);
    assert.equal(listResult.ok, true);
    const listPayload = listResult.structuredContent as { backups: Array<{ backupId: string }> };
    assert.deepEqual(listPayload.backups.map((item) => item.backupId), [backupId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup-recovery skill exposes tools through core, coding, and debug skills", () => {
  const toolNames = [
    "create_project_backup",
    "list_project_backups",
    "verify_recovery_point",
    "restore_project_backup",
    "restore_latest_project_backup",
    "recover_deleted_project_file",
    "export_project_backup_archive"
  ];
  const backup = skillRegistry.find((entry) => entry.id === "backup-recovery");
  const core = skillRegistry.find((entry) => entry.id === "core");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(backup);
  for (const toolName of toolNames) {
    assert.ok(backup!.toolNames.includes(toolName), `${toolName} exposed in backup-recovery`);
    assert.ok(core?.toolNames.includes(toolName), `${toolName} exposed in core`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
