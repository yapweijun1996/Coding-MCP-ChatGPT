import { callTool as legacyCallTool, toolDefinitions as legacyToolDefinitions } from "../legacy-tools.js";
import type { ToolModule } from "../types.js";

// Every name ever requested through a delegate call, accumulated as the tool modules are
// evaluated at import time. A legacy tool definition exists ONLY to be delegated, so this
// set is the authoritative "live legacy surface" — the legacy-surface guard test asserts
// legacyToolDefinitions ⊆ this set, which fails loudly if a dead (never-delegated)
// definition is reintroduced.
const delegatedLegacyToolNames = new Set<string>();

export function getDelegatedLegacyToolNames(): ReadonlySet<string> {
  return delegatedLegacyToolNames;
}

export function legacyDelegatedTools(names: readonly string[]): ToolModule[] {
  const selectedNames = new Set(names);
  const existingNames = new Set(legacyToolDefinitions.map((definition) => definition.name));
  const missingNames = names.filter((name) => !existingNames.has(name));
  if (missingNames.length > 0) {
    throw new Error(`Missing legacy tool definition: ${missingNames.join(", ")}`);
  }
  for (const name of selectedNames) delegatedLegacyToolNames.add(name);

  return legacyToolDefinitions
    .filter((definition) => selectedNames.has(definition.name))
    .map((definition) => ({
      definition,
      enabledByDefault: true,
      handler: (input, ctx) => legacyCallTool(definition.name, input, ctx)
    }));
}
