import { errorResult } from "./result.js";
import { loadToolModule } from "./registry.js";
import type { ToolContext, ToolResult } from "./types.js";

export async function callTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
  try {
    const tool = await loadToolModule(name);
    if (!tool) return errorResult(new Error(`Unknown tool: ${name}`));
    const parsedInput = tool.schema ? tool.schema.parse(rawInput ?? {}) : rawInput;
    return await tool.handler(parsedInput, ctx);
  } catch (error) {
    return errorResult(error);
  }
}
