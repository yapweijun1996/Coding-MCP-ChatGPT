import { hasToolModule, toolRegistry } from "./mcp/registry.js";

const enabledTools = new Set(toolRegistry.filter((tool) => tool.enabledByDefault).map((tool) => tool.definition.name));

export function isToolEnabled(name: string): boolean {
  return enabledTools.has(name);
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
