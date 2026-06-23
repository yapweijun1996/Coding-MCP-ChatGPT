import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, validateProject, writeProjectFile } from "../src/projects/store.js";
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
    clientId: "permission-scope-test"
  };
}

test("permission scope tools check tool access, boundaries, publish readiness, and risk approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "permission-scope-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Permission project", createdByClientId: "scope" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><body><h1>Ready</h1></body></html>");

    const toolPermission = getToolModule("check_tool_action_permission");
    const workspaceScope = getToolModule("check_workspace_path_scope");
    const projectScope = getToolModule("check_project_scope");
    const publishPermission = getToolModule("check_publish_permission");
    const riskChecklist = getToolModule("create_risk_approval_checklist");
    const summarize = getToolModule("summarize_permission_scope");
    for (const [name, tool] of Object.entries({ toolPermission, workspaceScope, projectScope, publishPermission, riskChecklist, summarize })) assert.ok(tool, `${name} registered`);

    const allowedTool = await toolPermission!.handler({ toolName: "read_file", intendedOperation: "read" }, ctx);
    assert.equal(allowedTool.ok, true);
    assert.equal((allowedTool.structuredContent as { decision: string }).decision, "allowed");

    const highRiskTool = await toolPermission!.handler({ toolName: "delete_file", intendedOperation: "delete" }, ctx);
    assert.equal(highRiskTool.ok, false);
    assert.equal((highRiskTool.structuredContent as { decision: string; approvalRequired: boolean }).decision, "blocked");
    assert.equal((highRiskTool.structuredContent as { approvalRequired: boolean }).approvalRequired, true);

    const workspaceBlocked = await workspaceScope!.handler({ paths: ["src/index.ts", "../outside.txt"], operation: "write" }, ctx);
    assert.equal(workspaceBlocked.ok, false);
    assert.equal(workspaceBlocked.errors.some((error) => error.includes("outside")), true);

    const projectBlocked = await projectScope!.handler({ projectId: project.id, paths: ["index.html", "../escape.html"], operation: "write" }, ctx);
    assert.equal(projectBlocked.ok, false);
    assert.equal(projectBlocked.errors.some((error) => error.includes("Parent traversal")), true);

    const publishBlocked = await publishPermission!.handler({ projectId: project.id }, ctx);
    assert.equal(publishBlocked.ok, false);
    assert.equal(publishBlocked.errors.includes("Publish requires a passing lastValidation for the selected entry file."), true);

    await validateProject(ctx.projectRoot, project.id);
    const publishAllowed = await publishPermission!.handler({ projectId: project.id }, ctx);
    assert.equal(publishAllowed.ok, true);
    assert.equal((publishAllowed.structuredContent as { entryFile: string }).entryFile, "index.html");

    const risk = await riskChecklist!.handler({
      action: "Publish and delete old artifact",
      operation: "publish",
      tools: ["publish_project", "delete_file"],
      touchedPaths: ["dist/index.html"],
      publishesExternally: true,
      destructive: true
    }, ctx);
    assert.equal(risk.ok, false);
    const riskPayload = risk.structuredContent as { approvalRequired: boolean; riskLevel: string; reasons: string[] };
    assert.equal(riskPayload.approvalRequired, true);
    assert.equal(riskPayload.riskLevel, "high");
    assert.equal(riskPayload.reasons.includes("destructive operation"), true);

    const summary = await summarize!.handler({ checks: [allowedTool.structuredContent, publishAllowed.structuredContent, risk.structuredContent] }, ctx);
    assert.equal(summary.ok, false);
    assert.equal((summary.structuredContent as { decision: string }).decision, "approval_required");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permission-scope skill exposes tools through core, coding, and debug skills", () => {
  const toolNames = [
    "check_tool_action_permission",
    "check_workspace_path_scope",
    "check_project_scope",
    "check_publish_permission",
    "create_risk_approval_checklist",
    "summarize_permission_scope"
  ];
  const permissionScope = skillRegistry.find((entry) => entry.id === "permission-scope");
  const core = skillRegistry.find((entry) => entry.id === "core");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(permissionScope);
  for (const toolName of toolNames) {
    assert.ok(permissionScope!.toolNames.includes(toolName), `${toolName} exposed in permission-scope`);
    assert.ok(core?.toolNames.includes(toolName), `${toolName} exposed in core`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
