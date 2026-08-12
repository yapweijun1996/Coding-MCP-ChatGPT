import { readFileSync } from "node:fs";
import { getToolGroupRuntimeStates, toolRegistry, toolDefinitions } from "../dist/mcp/registry.js";
import { heavyToolGroupIds, hotToolGroupIds } from "../dist/mcp/tools/index.js";
import { skillRegistry } from "../dist/skills/registry.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageScripts = packageJson.scripts ?? {};
const names = toolDefinitions.map((tool) => tool.name);
const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
const moduleNames = toolRegistry.map((tool) => tool.definition.name);
const runtimeStates = getToolGroupRuntimeStates();
const criticalTools = [
  "ping",
  "list_agent_skills",
  "get_agent_skill",
  "create_project",
  "write_project_file",
  "read_project_file",
  "get_project_manifest",
  "get_project_activity",
  "validate_project",
  "publish_project",
  "publish_and_report",
  "deliver_static_project",
  "run_command",
  "run_typecheck",
  "run_tests",
  "run_build",
  "inspect_webpage",
  "inspect_webpage_plus",
  "audit_accessibility",
  "audit_lighthouse",
  "inspect_interaction_flow",
  "inspect_local_project",
  "capture_webpage",
  "analyze_webpage_capture",
  "generate_improved_static_page",
  "create_research_project",
  "add_research_source",
  "list_research_sources",
  "add_research_note",
  "record_research_evidence",
  "get_research_manifest",
  "write_research_report",
  "publish_research_report"
];
const defaultEnabledTools = [
  "create_research_project",
  "add_research_source",
  "list_research_sources",
  "add_research_note",
  "record_research_evidence",
  "get_research_manifest",
  "write_research_report",
  "publish_research_report"
];
const defaultDisabledTools = [
  "delete_project",
  "purge_project",
  "create_share",
  "check_url",
  "open_local_server",
  "stop_local_server",
  "open_local_server_and_check",
  "run_lint",
  "run_format_check",
  "run_format_write",
  "diagnostic_bundle",
  "diagnostic_bundle_full"
];
const enabledToolRequiredScripts = new Map([
  ["run_typecheck", "typecheck"],
  ["run_tests", "test"],
  ["run_build", "build"],
  ["run_lint", "lint"],
  ["run_format_check", "format"],
  ["run_format_write", "format"],
  ["diagnostic_bundle", "lint"],
  ["diagnostic_bundle_full", "lint"]
]);
const errors = [];

if (duplicateNames.length > 0) {
  errors.push(`Duplicate tool names: ${[...new Set(duplicateNames)].join(", ")}`);
}

if (moduleNames.length !== names.length) {
  errors.push(`Registry/module count mismatch: modules=${moduleNames.length}, definitions=${names.length}`);
}

for (const groupId of hotToolGroupIds) {
  if (runtimeStates[groupId]?.status !== "loaded") {
    errors.push(`Expected hot tool group ${groupId} to be loaded, got ${runtimeStates[groupId]?.status ?? "missing"}`);
  }
}

for (const groupId of heavyToolGroupIds) {
  if (runtimeStates[groupId]?.status !== "unloaded") {
    errors.push(`Heavy tool group ${groupId} loaded during registry discovery (${runtimeStates[groupId]?.status ?? "missing"})`);
  }
}

for (const toolName of criticalTools) {
  if (!names.includes(toolName)) errors.push(`Missing critical tool: ${toolName}`);
}

for (const toolName of defaultDisabledTools) {
  const tool = toolRegistry.find((candidate) => candidate.definition.name === toolName);
  if (!tool) {
    errors.push(`Missing expected default-disabled tool: ${toolName}`);
  } else if (tool.enabledByDefault) {
    errors.push(`Tool must be disabled by default: ${toolName}`);
  }
}

for (const toolName of defaultEnabledTools) {
  const tool = toolRegistry.find((candidate) => candidate.definition.name === toolName);
  if (!tool) {
    errors.push(`Missing expected default-enabled tool: ${toolName}`);
  } else if (!tool.enabledByDefault) {
    errors.push(`Tool must be enabled by default: ${toolName}`);
  }
}

for (const [toolName, scriptName] of enabledToolRequiredScripts.entries()) {
  const tool = toolRegistry.find((candidate) => candidate.definition.name === toolName);
  if (tool?.enabledByDefault && typeof packageScripts[scriptName] !== "string") {
    errors.push(`Default-enabled tool ${toolName} requires missing package script: ${scriptName}`);
  }
}

const skillIds = skillRegistry.map((skill) => skill.id);
const duplicateSkillIds = skillIds.filter((id, index) => skillIds.indexOf(id) !== index);
if (duplicateSkillIds.length > 0) {
  errors.push(`Duplicate skill ids: ${[...new Set(duplicateSkillIds)].join(", ")}`);
}

for (const skill of skillRegistry) {
  for (const toolName of skill.toolNames) {
    if (!names.includes(toolName)) {
      errors.push(`Skill ${skill.id} references unknown tool: ${toolName}`);
    }
  }
}

// Reachability guard. A tool's visibility in tools/list requires BOTH the tool to be enabled
// AND at least one skill that lists it to be enabled (access: blocked_by_skill otherwise).
// Gating a tool behind an opt-in skill (e.g. high-risk, disabled by default) is intentional.
// The real trap is a tool that is in NO skill catalog at all: it can NEVER be exposed, no
// matter which skills are toggled, and reconnecting the client does not help. That is almost
// always "added a tool, forgot to register it in src/skills/registry.ts". Turn it into a
// build-time failure. The browser_* tools used to be exempt here because they reached
// tools/list through the visible-browser toggle rather than the skill catalog; they now go
// through the same two gates as everything else, so the guard covers them too.
const toolsInAnySkill = new Set();
for (const skill of skillRegistry) {
  for (const toolName of skill.toolNames) toolsInAnySkill.add(toolName);
}
const orphanedEnabledTools = toolRegistry
  .filter((tool) => tool.enabledByDefault)
  .map((tool) => tool.definition.name)
  .filter((name) => !toolsInAnySkill.has(name));
for (const toolName of orphanedEnabledTools) {
  errors.push(`Tool "${toolName}" is enabledByDefault but is listed in NO skill catalog, so tools/list can never expose it (blocked_by_skill, unfixable by any toggle). Add it to a skill's toolNames in src/skills/registry.ts.`);
}

const highRiskSkill = skillRegistry.find((skill) => skill.id === "high-risk");
if (!highRiskSkill) {
  errors.push("Missing high-risk skill.");
} else if (highRiskSkill.enabledByDefault) {
  errors.push("high-risk skill must be disabled by default.");
}

const coreSkill = skillRegistry.find((skill) => skill.id === "core");
for (const protocolToolName of ["list_agent_skills", "get_agent_skill"]) {
  if (!coreSkill?.toolNames.includes(protocolToolName)) {
    errors.push(`core skill must expose protocol tool: ${protocolToolName}`);
  }
}

const summary = {
  toolCount: names.length,
  skillCount: skillRegistry.length,
  duplicateCount: duplicateNames.length,
  hotGroupCount: hotToolGroupIds.length,
  verifiedColdGroups: heavyToolGroupIds,
  defaultEnabledTools,
  defaultDisabledTools,
  criticalTools
};

if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors, summary }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, summary }, null, 2));
