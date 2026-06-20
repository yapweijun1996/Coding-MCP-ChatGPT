import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, getProject } from "../src/projects/store.js";
import type { ToolContext } from "../src/mcp/types.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    telemetryRoot: "",
    jobsRoot: path.join(root, "jobs"),
    projectRoot: path.join(root, "projects"),
    clientId: "chatgpt-reviewer"
  };
}

test("review feedback round-trip: submit -> get -> resolve, stored on metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "review-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Landing page", createdByClientId: "coder" });

    const submit = getToolModule("submit_review_feedback");
    const get = getToolModule("get_review_feedback");
    const resolve = getToolModule("resolve_review_feedback");
    assert.ok(submit && get && resolve, "review tools registered");

    const submitted = await submit!.handler({
      projectId: project.id,
      findings: [
        { title: "CTA button overflows on mobile", detail: "At 390px the button clips.", severity: "high", category: "visual", area: ".cta", suggestion: "Add max-width" },
        { title: "Form has no label", detail: "Email input missing label.", severity: "medium", category: "accessibility" }
      ]
    }, ctx);
    assert.equal(submitted.ok, true);
    const added = (submitted.structuredContent as { added: Array<{ id: string }> }).added;
    assert.equal(added.length, 2);
    assert.equal(added[0].id, "finding_001");
    assert.equal(added[1].id, "finding_002");

    // Persisted on project metadata (project.json), NOT in the published files/ directory.
    const meta = await getProject(ctx.projectRoot, project.id);
    assert.equal(meta.reviewFeedback?.length, 2);
    const projectJson = JSON.parse(await readFile(path.join(ctx.projectRoot, project.id, "project.json"), "utf8"));
    assert.equal(projectJson.reviewFeedback.length, 2);

    // Coding agent reads open findings.
    const open = await get!.handler({ projectId: project.id, status: "open" }, ctx);
    assert.equal((open.structuredContent as { findings: unknown[] }).findings.length, 2);
    assert.equal((open.structuredContent as { openCount: number }).openCount, 2);

    // Resolve one.
    const resolved = await resolve!.handler({ projectId: project.id, findingId: "finding_001", status: "addressed", note: "added max-width" }, ctx);
    assert.equal(resolved.ok, true);
    assert.equal((resolved.structuredContent as { finding: { status: string } }).finding.status, "addressed");

    const stillOpen = await get!.handler({ projectId: project.id, status: "open" }, ctx);
    assert.equal((stillOpen.structuredContent as { findings: unknown[] }).findings.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolve_review_feedback rejects an unknown finding id", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "review-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "x", createdByClientId: "coder" });
    const resolve = getToolModule("resolve_review_feedback");
    await assert.rejects(
      () => Promise.resolve(resolve!.handler({ projectId: project.id, findingId: "finding_999", status: "addressed" }, ctx)),
      /No review finding/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
