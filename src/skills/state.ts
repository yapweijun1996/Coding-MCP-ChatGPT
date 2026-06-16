import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getSkillDefinition, skillRegistry, type SkillDefinition } from "./registry.js";

export interface SkillState {
  id: string;
  enabled: boolean;
  enabledByDefault: boolean;
  label: string;
  category: string;
  description: string;
  status: SkillDefinition["status"];
  riskLevel: SkillDefinition["riskLevel"];
  toolCount: number;
  protocolMarkdown: string;
}

export interface SkillStateFile {
  version: 1;
  skills: Record<string, boolean>;
  updatedAt: string;
}

let statePath = path.join(process.cwd(), ".state", "skill-state.json");
let loaded = false;
let enabledSkills = new Set<string>();

function defaultEnabledSkillIds(): string[] {
  return skillRegistry.filter((skill) => skill.enabledByDefault).map((skill) => skill.id);
}

function loadState(): void {
  if (loaded) return;
  enabledSkills = new Set(defaultEnabledSkillIds());
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SkillStateFile>;
    if (parsed && typeof parsed === "object" && parsed.skills && typeof parsed.skills === "object") {
      for (const skill of skillRegistry) {
        const value = parsed.skills[skill.id];
        if (typeof value === "boolean") {
          if (value) enabledSkills.add(skill.id);
          else enabledSkills.delete(skill.id);
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
  const skills = Object.fromEntries(skillRegistry.map((skill) => [skill.id, enabledSkills.has(skill.id)]));
  const payload: SkillStateFile = {
    version: 1,
    skills,
    updatedAt: new Date().toISOString()
  };
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function initializeSkillState(pathname: string): void {
  statePath = pathname;
  loaded = false;
  enabledSkills = new Set();
  loadState();
}

export function resetSkillStateForTests(pathname?: string): void {
  if (pathname) statePath = pathname;
  loaded = true;
  enabledSkills = new Set(defaultEnabledSkillIds());
}

export function isSkillEnabled(id: string): boolean {
  loadState();
  return enabledSkills.has(id);
}

export function setSkillEnabled(id: string, enabled: boolean): void {
  loadState();
  const skill = getSkillDefinition(id);
  if (!skill) throw new Error(`Unknown skill: ${id}`);
  if (skill.status === "disabled" && enabled) throw new Error(`Skill cannot be enabled: ${id}`);
  if (enabled) enabledSkills.add(id);
  else enabledSkills.delete(id);
  persistState();
}

export function listSkillStates(): SkillState[] {
  loadState();
  return skillRegistry.map((skill) => ({
    id: skill.id,
    enabled: enabledSkills.has(skill.id),
    enabledByDefault: skill.enabledByDefault,
    label: skill.label,
    category: skill.category,
    description: skill.description,
    status: skill.status,
    riskLevel: skill.riskLevel,
    toolCount: skill.toolNames.length,
    protocolMarkdown: skill.protocolMarkdown
  }));
}

export function getSkillState(id: string): SkillState | undefined {
  return listSkillStates().find((skill) => skill.id === id);
}

export function getEnabledSkillIdsForTool(toolName: string): string[] {
  loadState();
  return skillRegistry
    .filter((skill) => enabledSkills.has(skill.id) && skill.toolNames.includes(toolName))
    .map((skill) => skill.id);
}

export function getSkillIdsForTool(toolName: string): string[] {
  return skillRegistry
    .filter((skill) => skill.toolNames.includes(toolName))
    .map((skill) => skill.id);
}

export function isToolEnabledByAnySkill(toolName: string): boolean {
  return getEnabledSkillIdsForTool(toolName).length > 0;
}
