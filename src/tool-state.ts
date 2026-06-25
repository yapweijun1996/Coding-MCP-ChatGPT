import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { hasToolModule, toolRegistry } from "./mcp/registry.js";
import { getEnabledSkillIdsForTool, getSkillIdsForTool, isToolEnabledByAnySkill } from "./skills/state.js";
import { atomicWriteSync } from "./shared/atomic-write.js";

export interface ToolStateFile {
  version: 1;
  tools: Record<string, boolean>;
  updatedAt: string;
}

let statePath = path.join(process.cwd(), ".state", "tool-state.json");
let loaded = false;
const enabledTools = new Set<string>();

function defaultEnabledToolNames(): string[] {
  return toolRegistry.filter((tool) => tool.enabledByDefault).map((tool) => tool.definition.name);
}

function loadState(): void {
  if (loaded) return;
  enabledTools.clear();
  for (const name of defaultEnabledToolNames()) enabledTools.add(name);
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<ToolStateFile>;
    if (parsed && typeof parsed === "object" && parsed.tools && typeof parsed.tools === "object") {
      for (const tool of toolRegistry) {
        const value = parsed.tools[tool.definition.name];
        if (typeof value === "boolean") {
          if (value) enabledTools.add(tool.definition.name);
          else enabledTools.delete(tool.definition.name);
        }
      }
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") throw error;
  }
  loaded = true;
}

function persistState(): void {
  const tools = Object.fromEntries(toolRegistry.map((tool) => [tool.definition.name, enabledTools.has(tool.definition.name)]));
  const payload: ToolStateFile = {
    version: 1,
    tools,
    updatedAt: new Date().toISOString()
  };
  mkdirSync(path.dirname(statePath), { recursive: true });
  atomicWriteSync(statePath, `${JSON.stringify(payload, null, 2)}\n`);
}

export function initializeToolState(pathname: string): void {
  statePath = pathname;
  loaded = false;
  loadState();
}

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
  loadState();
  return enabledTools.has(name);
}

export function resetToolStatesForTests(pathname?: string): void {
  if (pathname) statePath = pathname;
  loaded = true;
  enabledTools.clear();
  for (const tool of toolRegistry) {
    if (tool.enabledByDefault) enabledTools.add(tool.definition.name);
  }
}

export function setToolEnabled(name: string, enabled: boolean): void {
  loadState();
  if (!hasToolModule(name)) throw new Error(`Unknown tool: ${name}`);
  if (enabled) enabledTools.add(name);
  else enabledTools.delete(name);
  persistState();
}

export function listToolStates(): Array<{ name: string; description: string; enabled: boolean }> {
  loadState();
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
  loadState();
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
