import { hasToolModule, toolRegistry } from "./mcp/registry.js";
import { getEnabledSkillIdsForTool, getSkillIdsForTool, isToolEnabledByAnySkill } from "./skills/state.js";

const enabledTools = new Set(toolRegistry.filter((tool) => tool.enabledByDefault).map((tool) => tool.definition.name));

export interface EffectiveToolState {
  name: string;
  description: string;
  toolEnabled: boolean;
  skillEnabled: boolean;
  enabled: boolean;
  enabledBySkills: string[];
  availableInSkills: string[];
  access: "enabled" | "blocked_by_tool" | "blocked_by_skill";
}

export function isToolEnabled(name: string): boolean {
  return enabledTools.has(name);
}

export function resetToolStatesForTests(): void {
  enabledTools.clear();
  for (const tool of toolRegistry) {
    if (tool.enabledByDefault) enabledTools.add(tool.definition.name);
  }
}

export function setToolEnabled(name: string, enabled: boolean): void {
  if (!hasToolModule(name)) throw new Error(`Unknown tool: ${name}`);
  if (enabled) enabledTools.add(name);
  else enabledTools.delete(name);
}

export function listToolStates(): Array<{ name: string; description: string; enabled: boolean }> {
  return toolRegistry.map((tool) => ({
    name: tool.definition.name,
    description: tool.definition.description,
    enabled: enabledTools.has(tool.definition.name)
  }));
}

export function isToolEffectivelyEnabled(name: string): boolean {
  return isToolEnabled(name) && isToolEnabledByAnySkill(name);
}

export function getToolAccess(name: string): EffectiveToolState {
  const tool = toolRegistry.find((candidate) => candidate.definition.name === name);
  const toolEnabled = isToolEnabled(name);
  const enabledBySkills = getEnabledSkillIdsForTool(name);
  const availableInSkills = getSkillIdsForTool(name);
  const skillEnabled = enabledBySkills.length > 0;
  return {
    name,
    description: tool?.definition.description ?? "",
    toolEnabled,
    skillEnabled,
    enabled: toolEnabled && skillEnabled,
    enabledBySkills,
    availableInSkills,
    access: !toolEnabled ? "blocked_by_tool" : skillEnabled ? "enabled" : "blocked_by_skill"
  };
}

export function listEffectiveToolStates(): EffectiveToolState[] {
  return toolRegistry.map((tool) => getToolAccess(tool.definition.name));
}
