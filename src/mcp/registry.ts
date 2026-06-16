import { allToolModules } from "./tools/index.js";
import type { ToolDefinition, ToolModule } from "./types.js";

export const toolRegistry: ToolModule[] = allToolModules;

const toolByName = new Map<string, ToolModule>();
for (const tool of toolRegistry) {
  if (toolByName.has(tool.definition.name)) {
    throw new Error(`Duplicate MCP tool registration: ${tool.definition.name}`);
  }
  toolByName.set(tool.definition.name, tool);
}

export const toolDefinitions: ToolDefinition[] = toolRegistry.map((tool) => tool.definition);

export function getToolModule(name: string): ToolModule | undefined {
  return toolByName.get(name);
}

export function hasToolModule(name: string): boolean {
  return toolByName.has(name);
}
