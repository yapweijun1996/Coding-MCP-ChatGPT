import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, readProjectFile } from "../src/projects/store.js";
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
    clientId: "mcp-platform-test"
  };
}

test("custom MCP tool blueprints cover broad agent domains", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-platform-blueprints-"));
  try {
    const list = getToolModule("list_custom_mcp_tool_blueprints");
    const get = getToolModule("get_custom_mcp_tool_blueprint");
    assert.ok(list, "list_custom_mcp_tool_blueprints registered");
    assert.ok(get, "get_custom_mcp_tool_blueprint registered");

    const listed = await list!.handler({}, toolContext(root));
    const payload = listed.structuredContent as { blueprints: Array<{ domain: string }>; domains: string[] };
    assert.equal(payload.domains.includes("task_management"), true);
    assert.equal(payload.domains.includes("visual_understanding"), true);
    assert.equal(payload.domains.includes("data_analysis"), true);
    assert.equal(payload.domains.includes("project_memory"), true);
    assert.equal(payload.blueprints.length > 0, true);
    const filtered = (await list!.handler({ query: "handoff" }, toolContext(root))).structuredContent as { blueprints: Array<{ domain: string }> };
    assert.equal(filtered.blueprints.some((item) => item.domain === "project_memory"), true);

    const blueprint = (await get!.handler({ domain: "three_d_game" }, toolContext(root))).structuredContent as { blueprint: { domain: string; verificationChecks: string[]; continuationState: string[] } };
    assert.equal(blueprint.blueprint.domain, "three_d_game");
    assert.equal(blueprint.blueprint.verificationChecks.some((item) => /canvas|asset|test/i.test(item)), true);
    assert.equal(blueprint.blueprint.continuationState.length > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom MCP tool spec generation writes reviewable project specs and validates them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-platform-spec-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "MCP platform spec", createdByClientId: "coder" });
    const generate = getToolModule("generate_custom_mcp_tool_spec");
    const validate = getToolModule("validate_custom_mcp_tool_spec");
    assert.ok(generate, "generate_custom_mcp_tool_spec registered");
    assert.ok(validate, "validate_custom_mcp_tool_spec registered");

    const generated = await generate!.handler({
      domain: "data_analysis",
      toolName: "profile_dataset_quality",
      objective: "Inspect a bounded dataset and return schema, quality findings, and next analysis steps.",
      projectId: project.id,
      writeToProject: true,
      inputs: ["csv artifact path"],
      outputs: ["quality score"],
      safetyBoundaries: ["Do not store secrets from source rows."],
      verificationChecks: ["Run schema inference tests."]
    }, ctx);
    assert.equal(generated.ok, true);
    const payload = generated.structuredContent as { spec: Record<string, unknown>; writtenPath: string; validation: { ok: boolean } };
    assert.equal(payload.validation.ok, true);
    assert.equal(payload.writtenPath, "mcp-tools/profile_dataset_quality.tool-spec.json");
    assert.equal(payload.spec.toolName, "profile_dataset_quality");
    assert.equal(payload.spec.domain, "data_analysis");

    const file = await readProjectFile(ctx.projectRoot, project.id, payload.writtenPath);
    const onDisk = JSON.parse(file);
    assert.equal(onDisk.toolName, "profile_dataset_quality");
    assert.equal(Array.isArray(onDisk.safetyBoundaries), true);

    const valid = await validate!.handler({ spec: payload.spec }, ctx);
    assert.equal(valid.ok, true);
    const invalid = await validate!.handler({ spec: { toolName: "Bad Name", domain: "unknown" } }, ctx);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.errors.length > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("core, coding, and debug skills expose custom MCP platform tools", () => {
  const core = skillRegistry.find((entry) => entry.id === "core");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(core);
  assert.ok(coding);
  assert.ok(debug);
  assert.ok(core!.toolNames.includes("list_custom_mcp_tool_blueprints"));
  assert.ok(core!.toolNames.includes("get_custom_mcp_tool_blueprint"));
  assert.ok(core!.toolNames.includes("validate_custom_mcp_tool_spec"));
  for (const skill of [coding!, debug!]) {
    assert.ok(skill.toolNames.includes("list_custom_mcp_tool_blueprints"));
    assert.ok(skill.toolNames.includes("get_custom_mcp_tool_blueprint"));
    assert.ok(skill.toolNames.includes("generate_custom_mcp_tool_spec"));
    assert.ok(skill.toolNames.includes("validate_custom_mcp_tool_spec"));
  }
});
