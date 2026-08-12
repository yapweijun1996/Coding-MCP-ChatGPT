import { LazyToolRuntime, type ToolGroupRuntimeState } from "./lazy-registry.js";
import { toolManifest } from "./tool-manifest.generated.js";
import { hotToolGroupIds, toolGroupLoaders, type ToolGroupId } from "./tools/index.js";
import type { ToolDefinition, ToolModule } from "./types.js";

const runtime = new LazyToolRuntime(toolManifest, toolGroupLoaders);

// Top-level await makes the selected common groups genuinely hot before any caller can use
// the synchronous registry API. Every other handler remains behind its dynamic import.
await runtime.warm(hotToolGroupIds);

export const toolRegistry: ToolModule[] = runtime.list();
export const toolDefinitions: ToolDefinition[] = toolManifest.map((entry) => entry.definition);

/** Returns a loaded module or a definition-preserving lazy proxy. */
export function getToolModule(name: string): ToolModule | undefined {
  return runtime.get(name);
}

/** Loads the owning handler group and returns its real zod schema and handler. */
export function loadToolModule(name: string): Promise<ToolModule | undefined> {
  return runtime.load(name);
}

export function hasToolModule(name: string): boolean {
  return runtime.has(name);
}

export function getToolGroupRuntimeStates(): Record<ToolGroupId, ToolGroupRuntimeState> {
  return runtime.states();
}
