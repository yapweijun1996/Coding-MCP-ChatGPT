import { callTool as legacyCallTool, toolDefinitions as legacyToolDefinitions } from "../legacy-tools.js";
import type { ToolModule } from "../types.js";

export function legacyDelegatedTools(names: readonly string[]): ToolModule[] {
  const selectedNames = new Set(names);
  const existingNames = new Set(legacyToolDefinitions.map((definition) => definition.name));
  const missingNames = names.filter((name) => !existingNames.has(name));
  if (missingNames.length > 0) {
    throw new Error(`Missing legacy tool definition: ${missingNames.join(", ")}`);
  }

  return legacyToolDefinitions
    .filter((definition) => selectedNames.has(definition.name))
    .map((definition) => ({
      definition,
      enabledByDefault: true,
      handler: (input, ctx) => legacyCallTool(definition.name, input, ctx)
    }));
}
