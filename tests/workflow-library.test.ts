import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject } from "../src/projects/store.js";
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
    clientId: "workflow-library-test"
  };
}

test("workflow library lists, registers, recommends, instantiates, and exports reusable workflows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-library-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Workflow library project", createdByClientId: "coder" });

    const builtins = await callTool("list_workflow_templates", { kind: "publish" }, ctx);
    assert.equal(builtins.ok, true);
    const builtinTemplates = (builtins.structuredContent as { templates: Array<{ id: string; kind: string; source: string }> }).templates;
    assert.equal(builtinTemplates.some((template) => template.id === "publish-handoff" && template.kind === "publish" && template.source === "builtin"), true);

    const registered = await callTool("register_workflow_template", {
      projectId: project.id,
      template: {
        id: "erp-qa-loop",
        title: "ERP QA Loop",
        kind: "qa",
        summary: "Reusable ERP QA workflow for roles, inventory, order flows, and browser evidence.",
        promptTemplate: "QA {{projectId}} for {{module}} with role matrix and inventory/order smoke flows.",
        tags: ["erp", "qa", "roles", "inventory"],
        steps: [
          { id: "roles", title: "Check role matrix", instruction: "Verify admin, manager, and viewer paths.", toolNames: ["inspect_interaction_flow"] },
          { id: "inventory", title: "Check inventory flow", instruction: "Exercise filters, edits, and empty states.", toolNames: ["run_smoke_flow"] }
        ],
        acceptanceChecks: ["Role paths pass.", "Inventory flow has no console errors."],
        recommendedTools: ["inspect_interaction_flow", "browser_console_log", "run_smoke_flow"],
        riskLevel: "medium"
      }
    }, ctx);
    assert.equal(registered.ok, true);

    const queried = await callTool("list_workflow_templates", { projectId: project.id, query: "erp inventory" }, ctx);
    const custom = (queried.structuredContent as { templates: Array<{ id: string; source: string }> }).templates.find((template) => template.id === "erp-qa-loop");
    assert.ok(custom);
    assert.equal(custom.source, "custom");

    const recommendations = await callTool("recommend_workflow_templates", {
      projectId: project.id,
      job: "QA the ERP inventory module with browser flow evidence",
      kind: "qa",
      desiredTools: ["inspect_interaction_flow"],
      maxResults: 4
    }, ctx);
    const recommended = (recommendations.structuredContent as { recommendations: Array<{ template: { id: string }; score: number }> }).recommendations;
    const customRecommendation = recommended.find((item) => item.template.id === "erp-qa-loop");
    assert.ok(customRecommendation);
    assert.ok(customRecommendation.score > 0);

    const runbook = await callTool("create_workflow_runbook_from_template", {
      projectId: project.id,
      templateId: "erp-qa-loop",
      title: "ERP Inventory QA Runbook",
      variables: { projectId: project.id, module: "inventory" }
    }, ctx);
    assert.equal(runbook.ok, true);
    assert.deepEqual(runbook.artifacts, ["workflows/workflow-runbook.md", "erp-qa-loop"]);
    const runbookMarkdown = await readFile(path.join(ctx.projectRoot, project.id, "files/workflows/workflow-runbook.md"), "utf8");
    assert.match(runbookMarkdown, /# ERP Inventory QA Runbook/);
    assert.match(runbookMarkdown, new RegExp(`QA ${project.id} for inventory`));
    assert.match(runbookMarkdown, /inspect_interaction_flow/);

    const exported = await callTool("export_workflow_library_report", { projectId: project.id }, ctx);
    assert.equal(exported.ok, true);
    assert.deepEqual(exported.artifacts, ["workflows/workflow-library.md"]);
    const libraryMarkdown = await readFile(path.join(ctx.projectRoot, project.id, "files/workflows/workflow-library.md"), "utf8");
    assert.match(libraryMarkdown, /# Workflow Library/);
    assert.match(libraryMarkdown, /safe-refactor/);
    assert.match(libraryMarkdown, /erp-qa-loop/);

    const store = JSON.parse(await readFile(path.join(ctx.projectRoot, project.id, "files/workflows/workflow-library.json"), "utf8")) as { templates: unknown[] };
    assert.equal(store.templates.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create_workflow_runbook_from_template rejects unknown templates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-library-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Workflow library project", createdByClientId: "coder" });
    const result = await callTool("create_workflow_runbook_from_template", { projectId: project.id, templateId: "missing-workflow" }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.summary, /Workflow template missing-workflow not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow library tools are exposed through core, coding, debug, and workflow-library skills", () => {
  const toolNames = ["register_workflow_template", "list_workflow_templates", "recommend_workflow_templates", "create_workflow_runbook_from_template", "export_workflow_library_report"];
  for (const skillId of ["core", "coding", "debug", "workflow-library"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    for (const toolName of toolNames) {
      assert.ok(skill!.toolNames.includes(toolName), `${skillId} exposes ${toolName}`);
    }
  }
});
