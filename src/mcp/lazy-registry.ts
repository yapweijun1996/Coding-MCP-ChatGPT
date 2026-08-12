import { errorResult } from "./result.js";
import type { ToolManifestEntryBase } from "./manifest-types.js";
import type { ToolModule } from "./types.js";

export type LazyToolGroupLoader = () => Promise<ToolModule[]>;
export type ToolGroupLoadStatus = "unloaded" | "loading" | "loaded" | "error";

export interface ToolGroupRuntimeState {
  status: ToolGroupLoadStatus;
  loadedAt?: string;
  loadDurationMs?: number;
  error?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runtime for a static tool manifest plus lazily imported handler groups.
 *
 * Manifest definitions are authoritative for discovery. A group is accepted only when its
 * runtime modules match the generated names, definitions and default states exactly; stale
 * generation therefore fails one tool call cleanly instead of silently exposing drift.
 */
export class LazyToolRuntime<GroupId extends string> {
  private readonly manifestByName = new Map<string, ToolManifestEntryBase<GroupId>>();
  private readonly entriesByGroup = new Map<GroupId, Array<ToolManifestEntryBase<GroupId>>>();
  private readonly loadedByName = new Map<string, ToolModule>();
  private readonly proxiesByName = new Map<string, ToolModule>();
  private readonly groupPromises = new Map<GroupId, Promise<void>>();
  private readonly groupStates = new Map<GroupId, ToolGroupRuntimeState>();

  constructor(
    readonly manifest: readonly ToolManifestEntryBase<GroupId>[],
    private readonly loaders: Readonly<Record<GroupId, LazyToolGroupLoader>>
  ) {
    for (const entry of manifest) {
      if (this.manifestByName.has(entry.definition.name)) {
        throw new Error(`Duplicate MCP tool manifest entry: ${entry.definition.name}`);
      }
      if (!loaders[entry.groupId]) {
        throw new Error(`Missing MCP tool group loader: ${entry.groupId}`);
      }
      this.manifestByName.set(entry.definition.name, entry);
      const group = this.entriesByGroup.get(entry.groupId) ?? [];
      group.push(entry);
      this.entriesByGroup.set(entry.groupId, group);
    }
    for (const groupId of Object.keys(loaders) as GroupId[]) {
      this.groupStates.set(groupId, { status: "unloaded" });
    }
  }

  has(name: string): boolean {
    return this.manifestByName.has(name);
  }

  get(name: string): ToolModule | undefined {
    const loaded = this.loadedByName.get(name);
    if (loaded) return loaded;
    const entry = this.manifestByName.get(name);
    if (!entry) return undefined;
    const existing = this.proxiesByName.get(name);
    if (existing) return existing;
    const proxy: ToolModule = {
      definition: entry.definition,
      enabledByDefault: entry.enabledByDefault,
      handler: async (input, ctx) => {
        try {
          const actual = await this.load(name);
          if (!actual) throw new Error(`Unknown tool: ${name}`);
          const parsed = actual.schema ? actual.schema.parse(input ?? {}) : input;
          return await actual.handler(parsed, ctx);
        } catch (error) {
          return errorResult(error);
        }
      }
    };
    this.proxiesByName.set(name, proxy);
    return proxy;
  }

  list(): ToolModule[] {
    return this.manifest.map((entry) => this.get(entry.definition.name)!);
  }

  async warm(groupIds: readonly GroupId[]): Promise<void> {
    await Promise.all(groupIds.map((groupId) => this.loadGroup(groupId)));
  }

  async load(name: string): Promise<ToolModule | undefined> {
    const loaded = this.loadedByName.get(name);
    if (loaded) return loaded;
    const entry = this.manifestByName.get(name);
    if (!entry) return undefined;
    await this.loadGroup(entry.groupId);
    return this.loadedByName.get(name);
  }

  states(): Record<GroupId, ToolGroupRuntimeState> {
    return Object.fromEntries(this.groupStates) as Record<GroupId, ToolGroupRuntimeState>;
  }

  private loadGroup(groupId: GroupId): Promise<void> {
    const existing = this.groupPromises.get(groupId);
    if (existing) return existing;
    const startedAt = performance.now();
    this.groupStates.set(groupId, { status: "loading" });
    const promise = (async () => {
      try {
        const modules = await this.loaders[groupId]();
        this.validateAndRegister(groupId, modules);
        this.groupStates.set(groupId, {
          status: "loaded",
          loadedAt: new Date().toISOString(),
          loadDurationMs: Math.round((performance.now() - startedAt) * 1000) / 1000
        });
      } catch (cause) {
        const error = new Error(`Failed to load MCP tool group ${groupId}: ${messageOf(cause)}`, { cause });
        this.groupStates.set(groupId, {
          status: "error",
          loadDurationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
          error: error.message
        });
        throw error;
      }
    })();
    this.groupPromises.set(groupId, promise);
    return promise;
  }

  private validateAndRegister(groupId: GroupId, modules: ToolModule[]): void {
    const expectedEntries = this.entriesByGroup.get(groupId) ?? [];
    const actualByName = new Map<string, ToolModule>();
    for (const module of modules) {
      const name = module.definition.name;
      if (actualByName.has(name)) throw new Error(`Duplicate runtime tool in group ${groupId}: ${name}`);
      actualByName.set(name, module);
    }
    const expectedNames = new Set(expectedEntries.map((entry) => entry.definition.name));
    const unexpected = [...actualByName.keys()].filter((name) => !expectedNames.has(name));
    const missing = expectedEntries.filter((entry) => !actualByName.has(entry.definition.name)).map((entry) => entry.definition.name);
    if (unexpected.length || missing.length) {
      throw new Error(`Tool manifest drift in ${groupId}; missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]. Regenerate the manifest.`);
    }
    const verifiedModules: ToolModule[] = [];
    for (const entry of expectedEntries) {
      const actual = actualByName.get(entry.definition.name)!;
      if (actual.enabledByDefault !== entry.enabledByDefault || JSON.stringify(actual.definition) !== JSON.stringify(entry.definition)) {
        throw new Error(`Tool manifest drift for ${entry.definition.name}. Regenerate the manifest.`);
      }
      verifiedModules.push(actual);
    }
    // Commit only after the whole group has passed validation. A stale group must never leave
    // a partially loaded handler set behind after reporting an error.
    for (const module of verifiedModules) {
      this.loadedByName.set(module.definition.name, module);
    }
  }
}
