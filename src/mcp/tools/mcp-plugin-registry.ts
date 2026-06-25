import { z } from "zod";
import type { ToolContext, ToolModule } from "../types.js";
import { readProjectFile, writeProjectFile } from "../../projects/store.js";
import { isSkillEnabled, setSkillEnabled } from "../../skills/state.js";
import { skillRegistry } from "../../skills/registry.js";

const pluginRegistryPath = "mcp-plugins/plugin-registry.json";

const pluginStatusEnum = z.enum(["available", "enabled", "disabled", "deprecated", "error"]);
const pluginSourceEnum = z.enum(["built_in_skill", "project_registry", "external_manifest"]);

const discoverPluginsSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  query: z.string().max(200).optional().default(""),
  category: z.string().min(1).max(80).optional(),
  status: pluginStatusEnum.optional(),
  includeTools: z.boolean().default(true),
  includeDisabled: z.boolean().default(true)
});

const registerPluginSchema = z.object({
  projectId: z.string().min(8).max(80),
  pluginId: z.string().min(2).max(120).regex(/^[a-zA-Z0-9_.:-]+$/),
  name: z.string().min(2).max(180),
  version: z.string().min(1).max(80).default("0.1.0"),
  description: z.string().min(1).max(1000),
  category: z.string().min(1).max(80).default("custom"),
  status: pluginStatusEnum.default("available"),
  capabilities: z.array(z.string().min(1).max(160)).max(80).default([]),
  toolNames: z.array(z.string().min(1).max(160)).max(200).default([]),
  skillIds: z.array(z.string().min(1).max(120)).max(80).default([]),
  manifestPath: z.string().min(1).max(240).optional(),
  docsUrl: z.string().url().max(1000).optional(),
  notes: z.string().max(2000).optional()
});

const setPluginEnabledSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  pluginId: z.string().min(2).max(120),
  enabled: z.boolean(),
  applyToLinkedSkills: z.boolean().default(false),
  reason: z.string().max(500).optional()
});

const testPluginSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  pluginId: z.string().min(2).max(120),
  sampleToolNames: z.array(z.string().min(1).max(160)).max(50).default([]),
  includeSchemaCheck: z.boolean().default(true)
});

const versionReportSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  pluginId: z.string().min(2).max(120).optional()
});

const exportDocsSchema = z.object({
  projectId: z.string().min(8).max(80),
  pluginId: z.string().min(2).max(120).optional(),
  outputPath: z.string().min(1).max(240).default("mcp-plugins/plugin-registry-report.md")
});

interface PluginRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  source: z.infer<typeof pluginSourceEnum>;
  status: z.infer<typeof pluginStatusEnum>;
  capabilities: string[];
  toolNames: string[];
  skillIds: string[];
  manifestPath?: string;
  docsUrl?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

interface PluginRegistryStore {
  version: 1;
  plugins: PluginRecord[];
}

function emptyStore(): PluginRegistryStore {
  return { version: 1, plugins: [] };
}

async function readStore(ctx: ToolContext, projectId?: string): Promise<PluginRegistryStore> {
  if (!projectId) return emptyStore();
  try {
    const raw = await readProjectFile(ctx.projectRoot, projectId, pluginRegistryPath);
    const parsed = JSON.parse(raw) as PluginRegistryStore;
    return { version: 1, plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [] };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(ctx: ToolContext, projectId: string, store: PluginRegistryStore) {
  return writeProjectFile(ctx.projectRoot, projectId, pluginRegistryPath, `${JSON.stringify(store, null, 2)}\n`);
}

function builtInPlugins(): PluginRecord[] {
  const now = new Date(0).toISOString();
  return skillRegistry.map((skill) => ({
    id: `skill:${skill.id}`,
    name: skill.label,
    version: "built-in",
    description: skill.description,
    category: skill.category,
    source: "built_in_skill" as const,
    status: isSkillEnabled(skill.id) ? "enabled" as const : "disabled" as const,
    capabilities: skill.toolNames.slice(0, 24),
    toolNames: [...skill.toolNames],
    skillIds: [skill.id],
    notes: `${skill.status} skill, ${skill.riskLevel} risk.`,
    createdAt: now,
    updatedAt: now
  }));
}

function mergePlugins(store: PluginRegistryStore): PluginRecord[] {
  const byId = new Map<string, PluginRecord>();
  for (const plugin of builtInPlugins()) byId.set(plugin.id, plugin);
  for (const plugin of store.plugins) byId.set(plugin.id, plugin);
  return [...byId.values()];
}

function findPlugin(plugins: PluginRecord[], pluginId: string): PluginRecord | undefined {
  return plugins.find((plugin) => plugin.id === pluginId || plugin.id === `skill:${pluginId}`);
}

function filterPlugins(plugins: PluginRecord[], input: z.infer<typeof discoverPluginsSchema>): PluginRecord[] {
  const query = input.query.toLowerCase();
  return plugins
    .filter((plugin) => input.includeDisabled || plugin.status !== "disabled")
    .filter((plugin) => !input.status || plugin.status === input.status)
    .filter((plugin) => !input.category || plugin.category === input.category)
    .filter((plugin) => {
      if (!query) return true;
      return [plugin.id, plugin.name, plugin.description, plugin.category, plugin.capabilities.join(" "), plugin.toolNames.join(" ")].join(" ").toLowerCase().includes(query);
    })
    .map((plugin) => input.includeTools ? plugin : { ...plugin, toolNames: [], capabilities: plugin.capabilities.slice(0, 8) });
}

async function getToolDefinitions() {
  const { toolDefinitions } = await import("../registry.js");
  return toolDefinitions;
}

async function validateProjectPlugin(plugin: PluginRecord): Promise<{ ok: boolean; errors: string[]; warnings: string[]; checks: Array<{ name: string; ok: boolean; detail: string }> }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const toolDefinitions = await getToolDefinitions();
  const toolSet = new Set(toolDefinitions.map((tool) => tool.name));
  const skillSet = new Set(skillRegistry.map((skill) => skill.id));
  const missingTools = plugin.toolNames.filter((tool) => !toolSet.has(tool));
  const missingSkills = plugin.skillIds.filter((skill) => !skillSet.has(skill));
  checks.push({ name: "metadata", ok: Boolean(plugin.id && plugin.name && plugin.version && plugin.description), detail: "Plugin id, name, version, and description are required." });
  checks.push({ name: "tools_registered", ok: missingTools.length === 0, detail: missingTools.length ? `Unknown tools: ${missingTools.join(", ")}` : `${plugin.toolNames.length} tool(s) known.` });
  checks.push({ name: "skills_registered", ok: missingSkills.length === 0, detail: missingSkills.length ? `Unknown skills: ${missingSkills.join(", ")}` : `${plugin.skillIds.length} skill(s) known.` });
  if (missingTools.length) errors.push(`Unknown tool(s): ${missingTools.join(", ")}`);
  if (missingSkills.length) errors.push(`Unknown skill(s): ${missingSkills.join(", ")}`);
  if (!plugin.manifestPath && !plugin.docsUrl && plugin.source !== "built_in_skill") warnings.push("Project plugins should include manifestPath or docsUrl for provenance.");
  if (plugin.toolNames.length === 0 && plugin.capabilities.length === 0) warnings.push("Plugin has no toolNames or capabilities documented.");
  return { ok: errors.length === 0, errors, warnings, checks };
}

function versionSummary(plugins: PluginRecord[]) {
  return plugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    source: plugin.source,
    status: plugin.status,
    category: plugin.category,
    toolCount: plugin.toolNames.length,
    skillIds: plugin.skillIds,
    updatedAt: plugin.updatedAt
  }));
}

function markdown(projectId: string, plugins: PluginRecord[]): string {
  const rows = plugins.map((plugin) => `| ${plugin.id} | ${plugin.version} | ${plugin.source} | ${plugin.status} | ${plugin.category} | ${plugin.toolNames.length} | ${plugin.description.replaceAll("|", "\\|")} |`).join("\n");
  return `# MCP Plugin Registry

- Project: \`${projectId}\`
- Plugins: ${plugins.length}
- Enabled: ${plugins.filter((plugin) => plugin.status === "enabled").length}
- Disabled: ${plugins.filter((plugin) => plugin.status === "disabled").length}
- Project plugins: ${plugins.filter((plugin) => plugin.source === "project_registry").length}

## Plugins

| Plugin | Version | Source | Status | Category | Tools | Description |
| --- | --- | --- | --- | --- | --- | --- |
${rows || "| - | - | - | - | - | - | No plugins |"}

## Capabilities

${plugins.map((plugin) => `### ${plugin.name}\n\n- ID: \`${plugin.id}\`\n- Skills: ${plugin.skillIds.join(", ") || "none"}\n- Tools: ${plugin.toolNames.slice(0, 30).join(", ") || "none"}${plugin.toolNames.length > 30 ? `\n- Additional tools: ${plugin.toolNames.length - 30}` : ""}\n- Notes: ${plugin.notes ?? "n/a"}`).join("\n\n")}
`;
}

export const mcpPluginRegistryTools: ToolModule[] = [
  {
    definition: {
      name: "discover_mcp_plugins",
      description: "Discover built-in skill-backed MCP plugins and project-registered plugin manifests with capabilities, status, tools, and versions.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, query: { type: "string" }, category: { type: "string" }, status: { type: "string" }, includeTools: { type: "boolean" }, includeDisabled: { type: "boolean" } }, required: [], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: discoverPluginsSchema,
    handler: async (input, ctx) => {
      const parsed = discoverPluginsSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const plugins = filterPlugins(mergePlugins(store), parsed);
      return { ok: true, summary: `Discovered ${plugins.length} MCP plugin(s).`, jobId: parsed.projectId, artifacts: parsed.projectId ? [pluginRegistryPath] : [], structuredContent: { plugins, total: plugins.length }, logs: plugins.map((plugin) => `${plugin.id} ${plugin.status} ${plugin.version}: ${plugin.name}`), errors: [] };
    }
  },
  {
    definition: {
      name: "register_mcp_plugin",
      description: "Register or update a project-local MCP plugin manifest with version, capabilities, linked tools, linked skills, and docs metadata.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, pluginId: { type: "string" }, name: { type: "string" }, version: { type: "string" }, description: { type: "string" }, category: { type: "string" }, status: { type: "string" }, capabilities: { type: "array", items: { type: "string" } }, toolNames: { type: "array", items: { type: "string" } }, skillIds: { type: "array", items: { type: "string" } }, manifestPath: { type: "string" }, docsUrl: { type: "string" }, notes: { type: "string" } }, required: ["projectId", "pluginId", "name", "description"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: registerPluginSchema,
    handler: async (input, ctx) => {
      const parsed = registerPluginSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const now = new Date().toISOString();
      const index = store.plugins.findIndex((plugin) => plugin.id === parsed.pluginId);
      const plugin: PluginRecord = {
        id: parsed.pluginId,
        name: parsed.name,
        version: parsed.version,
        description: parsed.description,
        category: parsed.category,
        source: "project_registry",
        status: parsed.status,
        capabilities: parsed.capabilities,
        toolNames: parsed.toolNames,
        skillIds: parsed.skillIds,
        manifestPath: parsed.manifestPath,
        docsUrl: parsed.docsUrl,
        notes: parsed.notes,
        createdAt: index >= 0 ? store.plugins[index]!.createdAt : now,
        updatedAt: now
      };
      const validation = await validateProjectPlugin(plugin);
      if (index >= 0) store.plugins[index] = plugin;
      else store.plugins.push(plugin);
      const file = await writeStore(ctx, parsed.projectId, store);
      return { ok: validation.ok, summary: `${index >= 0 ? "Updated" : "Registered"} MCP plugin ${plugin.id} (${plugin.version}).`, jobId: parsed.projectId, artifacts: [file.path, plugin.id], structuredContent: { projectId: parsed.projectId, plugin, validation }, logs: [JSON.stringify({ plugin, validation }, null, 2)], errors: validation.errors };
    }
  },
  {
    definition: {
      name: "set_mcp_plugin_enabled",
      description: "Enable or disable a project-registered MCP plugin, optionally applying the same state to linked built-in skills.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, pluginId: { type: "string" }, enabled: { type: "boolean" }, applyToLinkedSkills: { type: "boolean" }, reason: { type: "string" } }, required: ["pluginId", "enabled"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: setPluginEnabledSchema,
    handler: async (input, ctx) => {
      const parsed = setPluginEnabledSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const now = new Date().toISOString();
      const plugins = mergePlugins(store);
      const plugin = findPlugin(plugins, parsed.pluginId);
      if (!plugin) throw new Error(`Unknown MCP plugin: ${parsed.pluginId}`);
      const nextStatus: PluginRecord["status"] = parsed.enabled ? "enabled" : "disabled";
      const changedSkills: string[] = [];
      if (plugin.source === "built_in_skill") {
        if (!parsed.applyToLinkedSkills) throw new Error("Built-in skill plugins require applyToLinkedSkills=true to change skill state.");
        for (const skillId of plugin.skillIds) {
          setSkillEnabled(skillId, parsed.enabled);
          changedSkills.push(skillId);
        }
      } else {
        if (!parsed.projectId) throw new Error("projectId is required to update a project-registered plugin.");
        const index = store.plugins.findIndex((item) => item.id === plugin.id);
        if (index < 0) throw new Error(`Project plugin ${plugin.id} was not found in ${pluginRegistryPath}.`);
        store.plugins[index] = { ...store.plugins[index]!, status: nextStatus, notes: parsed.reason ?? store.plugins[index]!.notes, updatedAt: now };
        if (parsed.applyToLinkedSkills) {
          for (const skillId of plugin.skillIds) {
            setSkillEnabled(skillId, parsed.enabled);
            changedSkills.push(skillId);
          }
        }
        await writeStore(ctx, parsed.projectId, store);
      }
      return { ok: true, summary: `${parsed.enabled ? "Enabled" : "Disabled"} MCP plugin ${plugin.id}.`, jobId: parsed.projectId, artifacts: parsed.projectId ? [pluginRegistryPath] : [], structuredContent: { pluginId: plugin.id, enabled: parsed.enabled, changedSkills }, logs: [`${plugin.id}: ${nextStatus}`, changedSkills.length ? `Updated skills: ${changedSkills.join(", ")}` : "No linked skill state changes."], errors: [] };
    }
  },
  {
    definition: {
      name: "test_mcp_plugin_capabilities",
      description: "Test an MCP plugin registry entry by validating metadata, linked tools, linked skills, schema presence, and effective tool access.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, pluginId: { type: "string" }, sampleToolNames: { type: "array", items: { type: "string" } }, includeSchemaCheck: { type: "boolean" } }, required: ["pluginId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: testPluginSchema,
    handler: async (input, ctx) => {
      const parsed = testPluginSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const plugin = findPlugin(mergePlugins(store), parsed.pluginId);
      if (!plugin) throw new Error(`Unknown MCP plugin: ${parsed.pluginId}`);
      const validation = await validateProjectPlugin(plugin);
      const toolNames = parsed.sampleToolNames.length ? parsed.sampleToolNames : plugin.toolNames.slice(0, 20);
      const toolDefinitions = await getToolDefinitions();
      const toolSet = new Set(toolDefinitions.map((tool) => tool.name));
      const { getToolAccess } = await import("../../tool-state.js");
      const toolChecks = toolNames.map((toolName) => {
        const definition = toolDefinitions.find((tool) => tool.name === toolName);
        const access = toolSet.has(toolName) ? getToolAccess(toolName) : undefined;
        return {
          toolName,
          registered: Boolean(definition),
          schemaOk: parsed.includeSchemaCheck ? Boolean(definition?.inputSchema && typeof definition.inputSchema === "object") : true,
          access: access?.access ?? "unknown",
          enabled: access?.enabled ?? false,
          enabledBySkills: access?.enabledBySkills ?? []
        };
      });
      const errors = [...validation.errors, ...toolChecks.filter((check) => !check.registered || !check.schemaOk).map((check) => `${check.toolName} failed capability check.`)];
      const ok = errors.length === 0;
      return { ok, summary: ok ? `MCP plugin ${plugin.id} capability checks passed.` : `MCP plugin ${plugin.id} capability checks found issues.`, jobId: parsed.projectId, artifacts: [], structuredContent: { plugin, validation, toolChecks }, logs: [JSON.stringify({ validation, toolChecks }, null, 2)], errors };
    }
  },
  {
    definition: {
      name: "mcp_plugin_version_report",
      description: "Return version and status metadata for built-in and project-registered MCP plugins.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, pluginId: { type: "string" } }, required: [], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: versionReportSchema,
    handler: async (input, ctx) => {
      const parsed = versionReportSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      let plugins = mergePlugins(store);
      if (parsed.pluginId) {
        const plugin = findPlugin(plugins, parsed.pluginId);
        plugins = plugin ? [plugin] : [];
      }
      return { ok: true, summary: `Reported versions for ${plugins.length} MCP plugin(s).`, jobId: parsed.projectId, artifacts: [], structuredContent: { plugins: versionSummary(plugins) }, logs: versionSummary(plugins).map((plugin) => `${plugin.id} ${plugin.version} ${plugin.status}`), errors: parsed.pluginId && plugins.length === 0 ? [`Unknown MCP plugin: ${parsed.pluginId}`] : [] };
    }
  },
  {
    definition: {
      name: "export_mcp_plugin_docs",
      description: "Export Markdown documentation for MCP plugin registry entries, capabilities, linked tools, versions, and status.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, pluginId: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportDocsSchema,
    handler: async (input, ctx) => {
      const parsed = exportDocsSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      let plugins = mergePlugins(store);
      if (parsed.pluginId) {
        const plugin = findPlugin(plugins, parsed.pluginId);
        plugins = plugin ? [plugin] : [];
      }
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown(parsed.projectId, plugins));
      return { ok: plugins.length > 0, summary: `Exported MCP plugin docs to ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, outputPath: file.path, plugins: versionSummary(plugins) }, logs: [file.path], errors: parsed.pluginId && plugins.length === 0 ? [`Unknown MCP plugin: ${parsed.pluginId}`] : [] };
    }
  }
];
