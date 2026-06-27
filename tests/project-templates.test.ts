import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, getProjectManifest } from "../src/projects/store.js";
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
    clientId: "project-template-test"
  };
}

test("project template marketplace lists, registers, recommends, creates, validates, and exports templates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-templates-"));
  try {
    const ctx = toolContext(root);
    const catalogProject = await createProject(ctx.projectRoot, { title: "Template catalog", createdByClientId: "coder" });

    const builtins = await callTool("list_project_templates", { category: "dashboard" }, ctx);
    assert.equal(builtins.ok, true);
    const builtinTemplates = (builtins.structuredContent as { templates: Array<{ id: string; category: string; source: string }> }).templates;
    assert.equal(builtinTemplates.some((template) => template.id === "metric-dashboard" && template.category === "dashboard" && template.source === "builtin"), true);

    const registered = await callTool("register_project_template", {
      projectId: catalogProject.id,
      template: {
        id: "erp-admin-custom",
        title: "ERP Admin Custom",
        category: "admin-panel",
        summary: "Reusable ERP admin shell with inventory, order, and role management sections.",
        tags: ["erp", "admin", "inventory"],
        features: ["Inventory table", "Role matrix", "Order queue"],
        recommendedFor: ["ERP demos", "internal operations"],
        complexity: "standard"
      }
    }, ctx);
    assert.equal(registered.ok, true);

    const queried = await callTool("list_project_templates", { projectId: catalogProject.id, query: "erp inventory" }, ctx);
    const customTemplates = (queried.structuredContent as { templates: Array<{ id: string; source: string }> }).templates;
    const custom = customTemplates.find((template) => template.id === "erp-admin-custom");
    assert.ok(custom);
    assert.equal(custom.source, "custom");

    const recommendations = await callTool("recommend_project_templates", {
      projectId: catalogProject.id,
      useCase: "Build an ERP inventory admin panel",
      desiredFeatures: ["inventory", "roles"],
      maxResults: 3
    }, ctx);
    const ranked = (recommendations.structuredContent as { recommendations: Array<{ template: { id: string }; score: number }> }).recommendations;
    const customRecommendation = ranked.find((item) => item.template.id === "erp-admin-custom");
    assert.ok(customRecommendation);
    assert.ok(customRecommendation.score > 0);

    const created = await callTool("create_project_from_template", {
      sourceProjectId: catalogProject.id,
      templateId: "erp-admin-custom",
      title: "ERP Admin Starter",
      brandName: "Domino ERP",
      primaryAction: "Review queue"
    }, ctx);
    assert.equal(created.ok, true);
    const createdPayload = created.structuredContent as { projectId: string; validation: { ok: boolean; errors: string[] }; files: Array<{ path: string }> };
    assert.equal(createdPayload.validation.ok, true);
    assert.deepEqual(createdPayload.files.map((file) => file.path), ["index.html", "styles.css", "app.js", "README.md"]);

    const manifest = await getProjectManifest(ctx.projectRoot, createdPayload.projectId);
    assert.equal(manifest.entryFile, "index.html");
    assert.equal(manifest.files.some((file) => file.path === "styles.css"), true);
    const html = await readFile(path.join(ctx.projectRoot, createdPayload.projectId, "files/index.html"), "utf8");
    assert.match(html, /ERP Admin Starter/);
    assert.match(html, /Domino ERP/);

    const exported = await callTool("export_project_template_catalog", { projectId: catalogProject.id }, ctx);
    assert.equal(exported.ok, true);
    assert.deepEqual(exported.artifacts, ["templates/project-template-marketplace.md"]);
    const markdown = await readFile(path.join(ctx.projectRoot, catalogProject.id, "files/templates/project-template-marketplace.md"), "utf8");
    assert.match(markdown, /# Project Template Marketplace/);
    assert.match(markdown, /metric-dashboard/);
    assert.match(markdown, /erp-admin-custom/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create_project_from_template rejects unknown templates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-templates-"));
  try {
    const ctx = toolContext(root);
    const result = await callTool("create_project_from_template", { templateId: "missing-template", title: "Missing starter" }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.summary, /Project template missing-template not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("product-landing-page creates a real landing page, not a template catalog", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-templates-"));
  try {
    const ctx = toolContext(root);
    const result = await callTool("create_project_from_template", {
      templateId: "product-landing-page",
      title: "GJH Singapore Corporate Hero Page",
      brandName: "GJH Singapore",
      primaryAction: "Explore Our Businesses"
    }, ctx);

    assert.equal(result.ok, true);
    const payload = result.structuredContent as { projectId: string; validation: { ok: boolean; landingPageIntent?: { ok: boolean } } };
    assert.equal(payload.validation.ok, true);
    assert.equal(payload.validation.landingPageIntent?.ok, true);

    const html = await readFile(path.join(ctx.projectRoot, payload.projectId, "files/index.html"), "utf8");
    assert.match(html, /<header class="site-header">/);
    assert.match(html, /<nav aria-label="Primary navigation">/);
    assert.match(html, /class="hero"/);
    assert.match(html, /GJH Singapore/);
    assert.match(html, /Explore Our Businesses/);
    assert.match(html, /class="proof"/);
    assert.match(html, /class="feature-grid"/);
    assert.match(html, /class="pricing"/);
    assert.match(html, /class="faq"/);
    assert.match(html, /class="final-cta"/);
    assert.doesNotMatch(html, /LANDING PAGE TEMPLATE|landing page template|Operational Snapshot|class="sidebar"/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project template tools are exposed through core, coding, debug, and project-templates skills", () => {
  const toolNames = ["register_project_template", "list_project_templates", "recommend_project_templates", "create_project_from_template", "export_project_template_catalog"];
  for (const skillId of ["core", "coding", "debug", "project-templates"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    for (const toolName of toolNames) {
      assert.ok(skill!.toolNames.includes(toolName), `${skillId} exposes ${toolName}`);
    }
  }
});
