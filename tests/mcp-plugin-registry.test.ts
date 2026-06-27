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
    clientId: "mcp-plugin-registry-test"
  };
}

test("MCP plugin registry discovers, registers, toggles, tests, versions, and documents plugins", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-plugin-registry-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "MCP plugin registry project", createdByClientId: "coder" });

    const discovered = await callTool("discover_mcp_plugins", { projectId: project.id, query: "plugin registry" }, ctx);
    assert.equal(discovered.ok, true);
    const discoveryPayload = discovered.structuredContent as { plugins: Array<{ id: string; source: string; toolNames: string[] }> };
    assert.equal(discoveryPayload.plugins.some((plugin) => plugin.id === "skill:mcp-plugin-registry" && plugin.source === "built_in_skill"), true);

    const statusDiscovery = await callTool("discover_mcp_plugins", { projectId: project.id, query: "status" }, ctx);
    assert.equal(statusDiscovery.ok, true);
    const statusPayload = statusDiscovery.structuredContent as { plugins: Array<{ id: string; toolNames: string[] }> };
    const statusCoding = statusPayload.plugins.find((plugin) => plugin.id === "skill:coding");
    assert.ok(statusCoding, "status-oriented discovery should still expose coding delivery tools for next actions");
    assert.ok(statusCoding.toolNames.includes("deliver_static_project"));
    assert.ok(statusCoding.toolNames.includes("create_html_deck"));

    const pptDiscovery = await callTool("discover_mcp_plugins", { projectId: project.id, query: "make ppt today news" }, ctx);
    assert.equal(pptDiscovery.ok, true);
    const pptPayload = pptDiscovery.structuredContent as { plugins: Array<{ id: string; toolNames: string[] }> };
    const pptCoding = pptPayload.plugins.find((plugin) => plugin.id === "skill:coding");
    assert.ok(pptCoding, "PPT intent should discover project creation and publishing tools");
    assert.ok(pptCoding.toolNames.includes("create_html_deck"));
    assert.ok(pptCoding.toolNames.includes("publish_project"));

    const registered = await callTool("register_mcp_plugin", {
      projectId: project.id,
      pluginId: "project:handoff",
      name: "Project Handoff Plugin",
      version: "1.2.3",
      description: "Bundles project export and notification capabilities for stakeholder handoff.",
      category: "operations",
      status: "enabled",
      capabilities: ["export packages", "notify reviewers"],
      toolNames: ["create_export_package_manifest", "send_project_notification"],
      skillIds: ["export-package", "notifications"],
      manifestPath: "mcp-plugins/handoff.plugin.json",
      notes: "Project-local registry entry."
    }, ctx);
    assert.equal(registered.ok, true);
    assert.deepEqual(registered.artifacts, ["mcp-plugins/plugin-registry.json", "project:handoff"]);

    const disabled = await callTool("set_mcp_plugin_enabled", {
      projectId: project.id,
      pluginId: "project:handoff",
      enabled: false,
      reason: "Temporarily disabled for review."
    }, ctx);
    assert.equal(disabled.ok, true);
    assert.match(disabled.summary, /Disabled MCP plugin project:handoff/);

    const listedDisabled = await callTool("discover_mcp_plugins", { projectId: project.id, status: "disabled", query: "handoff" }, ctx);
    const disabledPayload = listedDisabled.structuredContent as { plugins: Array<{ id: string; status: string }> };
    assert.deepEqual(disabledPayload.plugins.map((plugin) => [plugin.id, plugin.status]), [["project:handoff", "disabled"]]);

    const tested = await callTool("test_mcp_plugin_capabilities", { projectId: project.id, pluginId: "project:handoff" }, ctx);
    assert.equal(tested.ok, true);
    const testedPayload = tested.structuredContent as { toolChecks: Array<{ toolName: string; registered: boolean; schemaOk: boolean }> };
    assert.equal(testedPayload.toolChecks.every((check) => check.registered && check.schemaOk), true);

    const versions = await callTool("mcp_plugin_version_report", { projectId: project.id, pluginId: "project:handoff" }, ctx);
    assert.equal(versions.ok, true);
    const versionPayload = versions.structuredContent as { plugins: Array<{ id: string; version: string; status: string; source: string; toolCount: number }> };
    assert.equal(versionPayload.plugins.length, 1);
    assert.equal(versionPayload.plugins[0].id, "project:handoff");
    assert.equal(versionPayload.plugins[0].version, "1.2.3");
    assert.equal(versionPayload.plugins[0].status, "disabled");
    assert.equal(versionPayload.plugins[0].source, "project_registry");
    assert.equal(versionPayload.plugins[0].toolCount, 2);

    const docs = await callTool("export_mcp_plugin_docs", { projectId: project.id, pluginId: "project:handoff" }, ctx);
    assert.equal(docs.ok, true);
    assert.deepEqual(docs.artifacts, ["mcp-plugins/plugin-registry-report.md"]);
    const markdown = await readFile(path.join(ctx.projectRoot, project.id, "files/mcp-plugins/plugin-registry-report.md"), "utf8");
    assert.match(markdown, /# MCP Plugin Registry/);
    assert.match(markdown, /project:handoff/);
    assert.match(markdown, /create_export_package_manifest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP plugin registry tools are exposed through core, coding, debug, and mcp-plugin-registry skills", () => {
  const toolNames = ["discover_mcp_plugins", "register_mcp_plugin", "set_mcp_plugin_enabled", "test_mcp_plugin_capabilities", "mcp_plugin_version_report", "export_mcp_plugin_docs"];
  for (const skillId of ["core", "coding", "debug", "mcp-plugin-registry"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    for (const toolName of toolNames) {
      assert.ok(skill!.toolNames.includes(toolName), `${skillId} exposes ${toolName}`);
    }
  }
});
