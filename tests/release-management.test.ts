import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, publishProject, readProjectFile, validateProject, writeProjectFile } from "../src/projects/store.js";
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
    clientId: "release-management-test"
  };
}

test("release management tools create records, notes, changelog, compare checks, rollback points, and list releases", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "release-management-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Release project", createdByClientId: "release" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><body><h1>Release</h1></body></html>");
    await validateProject(ctx.projectRoot, project.id);
    await publishProject(ctx.projectRoot, project.id, ctx.publicBaseUrl);

    const record = getToolModule("create_release_record");
    const notes = getToolModule("create_release_notes");
    const changelog = getToolModule("update_project_changelog");
    const compare = getToolModule("compare_before_release");
    const rollback = getToolModule("create_rollback_point");
    const list = getToolModule("list_project_releases");
    for (const [name, tool] of Object.entries({ record, notes, changelog, compare, rollback, list })) assert.ok(tool, `${name} registered`);

    const recordResult = await record!.handler({
      projectId: project.id,
      version: "v1.2.0",
      title: "Release 1.2.0",
      status: "published",
      changes: ["Added release management tools."],
      checks: ["project validation", "browser smoke"],
      rollbackVersion: "v1.1.0"
    }, ctx);
    assert.equal(recordResult.ok, true);
    const recordPayload = recordResult.structuredContent as { release: { version: string; status: string; rollbackPoint?: { version: string } } };
    assert.equal(recordPayload.release.version, "v1.2.0");
    assert.equal(recordPayload.release.status, "published");
    assert.equal(recordPayload.release.rollbackPoint?.version, "v1.1.0");

    const notesResult = await notes!.handler({
      projectId: project.id,
      version: "v1.2.0",
      title: "Release 1.2.0",
      summary: "Adds project-local release management.",
      changes: ["Version tags", "Release notes"],
      fixes: ["Rollback metadata"],
      validation: ["npm test passed"]
    }, ctx);
    assert.equal(notesResult.ok, true);
    const notesMarkdown = await readProjectFile(ctx.projectRoot, project.id, "release-management/release-notes-v1.2.0.md");
    assert.match(notesMarkdown, /Adds project-local release management/);

    const changelogResult = await changelog!.handler({
      projectId: project.id,
      version: "v1.2.0",
      entries: [
        { type: "added", text: "Release manifest support." },
        { type: "fixed", text: "Rollback checklist coverage." }
      ]
    }, ctx);
    assert.equal(changelogResult.ok, true);
    const changelogMarkdown = await readProjectFile(ctx.projectRoot, project.id, "CHANGELOG.md");
    assert.match(changelogMarkdown, /## v1\.2\.0/);
    assert.match(changelogMarkdown, /Release manifest support/);

    const compareResult = await compare!.handler({
      projectId: project.id,
      version: "v1.2.0",
      baseline: { version: "v1.1.0", files: ["index.html"], validationOk: true },
      requiredChecks: ["project validation", "browser smoke"],
      completedChecks: ["project validation", "browser smoke"]
    }, ctx);
    assert.equal(compareResult.ok, true);
    const comparePayload = compareResult.structuredContent as { addedFiles: string[]; removedFiles: string[]; warnings: string[] };
    assert.deepEqual(comparePayload.addedFiles.sort(), ["CHANGELOG.md", "release-management/release-notes-v1.2.0.md", "release-management/releases.json"].sort());
    assert.deepEqual(comparePayload.removedFiles, []);
    assert.deepEqual(comparePayload.warnings, []);

    const rollbackResult = await rollback!.handler({
      projectId: project.id,
      version: "v1.2.0",
      rollbackToVersion: "v1.1.0",
      reason: "Safety fallback for release smoke failures."
    }, ctx);
    assert.equal(rollbackResult.ok, true);
    const rollbackPayload = rollbackResult.structuredContent as { rollbackToVersion: string; steps: string[] };
    assert.equal(rollbackPayload.rollbackToVersion, "v1.1.0");
    assert.equal(rollbackPayload.steps.some((step) => step.includes("validation")), true);

    const listResult = await list!.handler({ projectId: project.id, status: "published" }, ctx);
    assert.equal(listResult.ok, true);
    const listPayload = listResult.structuredContent as { releases: Array<{ version: string }> };
    assert.deepEqual(listPayload.releases.map((release) => release.version), ["v1.2.0"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release-management skill exposes tools through coding and debug skills", () => {
  const toolNames = [
    "create_release_record",
    "create_release_notes",
    "update_project_changelog",
    "compare_before_release",
    "create_rollback_point",
    "list_project_releases"
  ];
  const release = skillRegistry.find((entry) => entry.id === "release-management");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(release);
  for (const toolName of toolNames) {
    assert.ok(release!.toolNames.includes(toolName), `${toolName} exposed in release-management`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
