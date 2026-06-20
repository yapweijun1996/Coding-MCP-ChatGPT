import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { toolDefinitions } from "../src/mcp/registry.js";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { skillRegistry } from "../src/skills/registry.js";
import { initializeSkillState, isSkillEnabled, resetSkillStateForTests, setSkillEnabled } from "../src/skills/state.js";
import { getToolAccess, isToolEffectivelyEnabled, resetToolStatesForTests, setToolEnabled } from "../src/tool-state.js";

async function withIsolatedSkillState<T>(run: (statePath: string) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-skills-"));
  const statePath = path.join(root, "skill-state.json");
  try {
    initializeSkillState(statePath);
    resetSkillStateForTests(statePath);
    resetToolStatesForTests();
    return await run(statePath);
  } finally {
    resetSkillStateForTests();
    resetToolStatesForTests();
    await rm(root, { recursive: true, force: true });
  }
}

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "test-client"
  };
}

test("skill registry has unique ids and only references registered tools", () => {
  const skillIds = skillRegistry.map((skill) => skill.id);
  assert.equal(new Set(skillIds).size, skillIds.length);

  const toolNames = new Set(toolDefinitions.map((tool) => tool.name));
  for (const skill of skillRegistry) {
    for (const toolName of skill.toolNames) {
      assert.ok(toolNames.has(toolName), `${skill.id} references unknown tool ${toolName}`);
    }
  }

  const highRisk = skillRegistry.find((skill) => skill.id === "high-risk");
  assert.ok(highRisk);
  assert.equal(highRisk.enabledByDefault, false);

  const core = skillRegistry.find((skill) => skill.id === "core");
  assert.ok(core);
  assert.ok(core.toolNames.includes("list_agent_skills"));
  assert.ok(core.toolNames.includes("get_agent_skill"));
});

test("skill state persists admin toggles", async () => {
  await withIsolatedSkillState(async (statePath) => {
    assert.equal(isSkillEnabled("coding"), true);
    setSkillEnabled("coding", false);
    assert.equal(isSkillEnabled("coding"), false);

    initializeSkillState(statePath);
    assert.equal(isSkillEnabled("coding"), false);
  });
});

test("disabling coding skill blocks coding-only tools", async () => {
  await withIsolatedSkillState(() => {
    assert.equal(isToolEffectivelyEnabled("deliver_static_project"), true);
    setSkillEnabled("coding", false);

    const access = getToolAccess("deliver_static_project");
    assert.equal(access.toolEnabled, true);
    assert.equal(access.skillEnabled, false);
    assert.equal(access.access, "blocked_by_skill");
    assert.equal(isToolEffectivelyEnabled("deliver_static_project"), false);
  });
});

test("raw tool override can still disable a tool inside an enabled skill", async () => {
  await withIsolatedSkillState(() => {
    assert.equal(isToolEffectivelyEnabled("deliver_static_project"), true);
    setToolEnabled("deliver_static_project", false);

    const access = getToolAccess("deliver_static_project");
    assert.equal(access.toolEnabled, false);
    assert.equal(access.skillEnabled, true);
    assert.equal(access.access, "blocked_by_tool");
    assert.equal(isToolEffectivelyEnabled("deliver_static_project"), false);
  });
});

test("shared tools remain enabled when at least one exposing skill is enabled", async () => {
  await withIsolatedSkillState(() => {
    assert.deepEqual(getToolAccess("list_projects").enabledBySkills.sort(), ["coding", "core"].sort());
    setSkillEnabled("core", false);

    const access = getToolAccess("list_projects");
    assert.equal(access.enabled, true);
    assert.deepEqual(access.enabledBySkills, ["coding"]);
  });
});

test("agent skill protocol tools expose skill metadata and SOP content", async () => {
  await withIsolatedSkillState(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-skill-tool-"));
    try {
      const listResult = await callTool("list_agent_skills", {}, toolContext(root));
      assert.equal(listResult.ok, true);
      assert.ok(Array.isArray(listResult.structuredContent?.skills));

      const getResult = await callTool("get_agent_skill", { skillId: "coding" }, toolContext(root));
      assert.equal(getResult.ok, true);
      assert.match(getResult.logs.join("\n"), /Coding Delivery/);
      assert.equal((getResult.structuredContent?.skill as { id?: string }).id, "coding");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
