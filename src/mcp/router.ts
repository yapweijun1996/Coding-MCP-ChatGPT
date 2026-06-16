import { errorResult } from "./result.js";
import { getToolModule } from "./registry.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function callTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = getToolModule(name);
  if (!tool) return errorResult(new Error(`Unknown tool: ${name}`));

  try {
    const parsedInput = tool.schema ? tool.schema.parse(rawInput ?? {}) : rawInput;
    return await tool.handler(parsedInput, ctx);
  } catch (error) {
    return errorResult(error);
  }
}
