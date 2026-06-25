import { z } from "zod";
import { readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const componentRegistryPath = "components/component-registry.json";

const componentKindEnum = z.enum(["component", "icon", "layout", "game-object", "chart", "interaction-pattern"]);
const maturityEnum = z.enum(["draft", "usable", "stable", "deprecated"]);

const componentFileSchema = z.object({
  path: z.string().min(1).max(240),
  role: z.enum(["source", "style", "test", "asset", "docs", "demo"]).default("source"),
  exportName: z.string().min(1).max(120).optional()
});

const propSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.string().min(1).max(160),
  required: z.boolean().default(false),
  description: z.string().max(500).optional()
});

const registerReusableComponentSchema = z.object({
  projectId: z.string().min(8).max(80),
  component: z.object({
    id: z.string().min(3).max(100).regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().min(3).max(160),
    kind: componentKindEnum,
    summary: z.string().min(3).max(500),
    tags: z.array(z.string().min(1).max(60)).max(30).default([]),
    files: z.array(componentFileSchema).min(1).max(40),
    props: z.array(propSchema).max(40).default([]),
    variants: z.array(z.string().min(1).max(120)).max(30).default([]),
    dependencies: z.array(z.string().min(1).max(160)).max(30).default([]),
    usageNotes: z.array(z.string().min(1).max(300)).max(30).default([]),
    accessibilityNotes: z.array(z.string().min(1).max(300)).max(20).default([]),
    maturity: maturityEnum.default("usable")
  })
});

const listReusableComponentsSchema = z.object({
  projectId: z.string().min(8).max(80),
  kind: componentKindEnum.optional(),
  tag: z.string().min(1).max(60).optional(),
  maturity: maturityEnum.optional(),
  query: z.string().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(500).default(100)
});

const recommendReusableComponentsSchema = z.object({
  projectId: z.string().min(8).max(80),
  need: z.string().min(3).max(500),
  kind: componentKindEnum.optional(),
  desiredTags: z.array(z.string().min(1).max(60)).max(20).default([]),
  maxResults: z.number().int().min(1).max(50).default(10)
});

const createComponentReusePlanSchema = z.object({
  projectId: z.string().min(8).max(80),
  componentIds: z.array(z.string().min(3).max(100)).min(1).max(40),
  targetProjectId: z.string().min(8).max(80).optional(),
  outputPath: z.string().min(1).max(240).default("components/component-reuse-plan.md")
});

const exportComponentRegistrySchema = z.object({
  projectId: z.string().min(8).max(80),
  outputPath: z.string().min(1).max(240).default("components/component-registry.md")
});

type ComponentKind = z.infer<typeof componentKindEnum>;
type ComponentMaturity = z.infer<typeof maturityEnum>;

interface ReusableComponent {
  id: string;
  name: string;
  kind: ComponentKind;
  summary: string;
  tags: string[];
  files: Array<z.infer<typeof componentFileSchema>>;
  props: Array<z.infer<typeof propSchema>>;
  variants: string[];
  dependencies: string[];
  usageNotes: string[];
  accessibilityNotes: string[];
  maturity: ComponentMaturity;
  createdAt: string;
  updatedAt: string;
}

interface ComponentRegistry {
  version: 1;
  components: ReusableComponent[];
}

function emptyRegistry(): ComponentRegistry {
  return { version: 1, components: [] };
}

async function readRegistry(ctx: ToolContext, projectId: string): Promise<ComponentRegistry> {
  try {
    const raw = await readProjectFile(ctx.projectRoot, projectId, componentRegistryPath);
    const parsed = JSON.parse(raw) as ComponentRegistry;
    return { version: 1, components: Array.isArray(parsed.components) ? parsed.components : [] };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return emptyRegistry();
    throw error;
  }
}

async function writeRegistry(ctx: ToolContext, projectId: string, registry: ComponentRegistry) {
  return writeProjectFile(ctx.projectRoot, projectId, componentRegistryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

function componentLine(component: ReusableComponent): string {
  return `${component.id} (${component.kind}/${component.maturity}): ${component.name}`;
}

function haystack(component: ReusableComponent): string {
  return [
    component.id,
    component.name,
    component.kind,
    component.summary,
    component.maturity,
    ...component.tags,
    ...component.variants,
    ...component.dependencies,
    ...component.usageNotes,
    ...component.accessibilityNotes,
    ...component.files.map((file) => `${file.path} ${file.role} ${file.exportName ?? ""}`),
    ...component.props.map((prop) => `${prop.name} ${prop.type} ${prop.description ?? ""}`)
  ].join(" ").toLowerCase();
}

function matchesQuery(component: ReusableComponent, query?: string): boolean {
  if (!query) return true;
  const text = haystack(component);
  return query.toLowerCase().split(/\s+/).every((token) => text.includes(token));
}

function scoreComponent(component: ReusableComponent, need: string, desiredTags: string[]): number {
  const text = haystack(component);
  const needScore = need.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).reduce((score, token) => score + (text.includes(token) ? 2 : 0), 0);
  const tagScore = desiredTags.reduce((score, tag) => score + (component.tags.includes(tag) ? 6 : text.includes(tag.toLowerCase()) ? 3 : 0), 0);
  const maturityScore = component.maturity === "stable" ? 4 : component.maturity === "usable" ? 2 : component.maturity === "deprecated" ? -10 : 0;
  return needScore + tagScore + maturityScore;
}

function summarize(components: ReusableComponent[]) {
  return components.reduce((acc, component) => {
    acc.total += 1;
    acc.byKind[component.kind] = (acc.byKind[component.kind] ?? 0) + 1;
    acc.byMaturity[component.maturity] = (acc.byMaturity[component.maturity] ?? 0) + 1;
    for (const tag of component.tags) acc.byTag[tag] = (acc.byTag[tag] ?? 0) + 1;
    return acc;
  }, { total: 0, byKind: {} as Record<string, number>, byMaturity: {} as Record<string, number>, byTag: {} as Record<string, number> });
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").trim();
}

function renderRegistryMarkdown(projectId: string, components: ReusableComponent[]): string {
  const summary = summarize(components);
  const rows = components.map((component) => `| ${component.id} | ${escapeMarkdown(component.name)} | ${component.kind} | ${component.maturity} | ${component.files.map((file) => `\`${file.path}\``).join(", ")} | ${component.tags.join(", ")} |`).join("\n");
  return `# Component Registry

- Project: \`${projectId}\`
- Components: ${summary.total}
- Kinds: ${Object.entries(summary.byKind).map(([kind, count]) => `${kind}=${count}`).join(", ") || "none"}

| ID | Name | Kind | Maturity | Files | Tags |
| --- | --- | --- | --- | --- | --- |
${rows || "| - | - | - | - | - | - |"}
`;
}

function renderReusePlan(projectId: string, targetProjectId: string | undefined, components: ReusableComponent[]): string {
  return `# Component Reuse Plan

- Source project: \`${projectId}\`
- Target project: ${targetProjectId ? `\`${targetProjectId}\`` : "not specified"}
- Components: ${components.length}

${components.map((component) => `## ${component.name}

- ID: \`${component.id}\`
- Kind: ${component.kind}
- Maturity: ${component.maturity}
- Files: ${component.files.map((file) => `\`${file.path}\` (${file.role}${file.exportName ? `, ${file.exportName}` : ""})`).join(", ")}
- Dependencies: ${component.dependencies.length ? component.dependencies.map((dependency) => `\`${dependency}\``).join(", ") : "none"}
- Variants: ${component.variants.join(", ") || "none"}

### Props

${component.props.length ? component.props.map((prop) => `- \`${prop.name}\` (${prop.type}${prop.required ? ", required" : ""}): ${prop.description ?? ""}`).join("\n") : "- No props documented."}

### Usage Notes

${component.usageNotes.length ? component.usageNotes.map((note) => `- ${note}`).join("\n") : "- No usage notes documented."}

### Accessibility

${component.accessibilityNotes.length ? component.accessibilityNotes.map((note) => `- ${note}`).join("\n") : "- No accessibility notes documented."}
`).join("\n")}
`;
}

export const componentRegistryTools: ToolModule[] = [
  {
    definition: {
      name: "register_reusable_component",
      description: "Register or update a reusable component, icon, layout, game object, chart, or interaction pattern with files, props, variants, dependencies, and notes.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, component: { type: "object" } }, required: ["projectId", "component"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: registerReusableComponentSchema,
    handler: async (input, ctx) => {
      const parsed = registerReusableComponentSchema.parse(input);
      const registry = await readRegistry(ctx, parsed.projectId);
      const now = new Date().toISOString();
      const existing = registry.components.find((component) => component.id === parsed.component.id);
      const component: ReusableComponent = { ...parsed.component, createdAt: existing?.createdAt ?? now, updatedAt: now };
      registry.components = [...registry.components.filter((item) => item.id !== component.id), component];
      const file = await writeRegistry(ctx, parsed.projectId, registry);
      return { ok: true, summary: `Registered reusable component ${component.id}.`, jobId: parsed.projectId, artifacts: [file.path, component.id, ...component.files.map((item) => item.path)], structuredContent: { projectId: parsed.projectId, component, summary: summarize(registry.components) }, logs: [componentLine(component)], errors: [] };
    }
  },
  {
    definition: {
      name: "list_reusable_components",
      description: "List reusable registry entries with filters for kind, tag, maturity, text query, and limit.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, kind: { type: "string", enum: ["component", "icon", "layout", "game-object", "chart", "interaction-pattern"] }, tag: { type: "string" }, maturity: { type: "string", enum: ["draft", "usable", "stable", "deprecated"] }, query: { type: "string" }, limit: { type: "number" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listReusableComponentsSchema,
    handler: async (input, ctx) => {
      const parsed = listReusableComponentsSchema.parse(input);
      const registry = await readRegistry(ctx, parsed.projectId);
      const components = registry.components
        .filter((component) => !parsed.kind || component.kind === parsed.kind)
        .filter((component) => !parsed.tag || component.tags.includes(parsed.tag))
        .filter((component) => !parsed.maturity || component.maturity === parsed.maturity)
        .filter((component) => matchesQuery(component, parsed.query))
        .slice(0, parsed.limit);
      return { ok: true, summary: `${components.length} reusable component(s) returned.`, jobId: parsed.projectId, artifacts: [], structuredContent: { projectId: parsed.projectId, components, summary: summarize(components) }, logs: components.map(componentLine), errors: [] };
    }
  },
  {
    definition: {
      name: "recommend_reusable_components",
      description: "Rank reusable registry entries for a target need using text, tags, kind, and maturity.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, need: { type: "string" }, kind: { type: "string", enum: ["component", "icon", "layout", "game-object", "chart", "interaction-pattern"] }, desiredTags: { type: "array", items: { type: "string" } }, maxResults: { type: "number" } }, required: ["projectId", "need"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: recommendReusableComponentsSchema,
    handler: async (input, ctx) => {
      const parsed = recommendReusableComponentsSchema.parse(input);
      const registry = await readRegistry(ctx, parsed.projectId);
      const recommendations = registry.components
        .filter((component) => !parsed.kind || component.kind === parsed.kind)
        .map((component) => ({ component, score: scoreComponent(component, parsed.need, parsed.desiredTags) }))
        .sort((left, right) => right.score - left.score || left.component.name.localeCompare(right.component.name))
        .slice(0, parsed.maxResults);
      return { ok: true, summary: `Recommended ${recommendations.length} reusable component(s).`, jobId: parsed.projectId, artifacts: recommendations.map((item) => item.component.id), structuredContent: { projectId: parsed.projectId, recommendations }, logs: recommendations.map((item) => `${item.score}: ${componentLine(item.component)}`), errors: [] };
    }
  },
  {
    definition: {
      name: "create_component_reuse_plan",
      description: "Create a Markdown reuse plan for selected registry components, including files, props, dependencies, usage notes, and accessibility notes.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, componentIds: { type: "array", items: { type: "string" } }, targetProjectId: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "componentIds"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createComponentReusePlanSchema,
    handler: async (input, ctx) => {
      const parsed = createComponentReusePlanSchema.parse(input);
      const registry = await readRegistry(ctx, parsed.projectId);
      const components = parsed.componentIds.map((id) => {
        const component = registry.components.find((item) => item.id === id);
        if (!component) throw new Error(`Reusable component ${id} not found.`);
        return component;
      });
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, renderReusePlan(parsed.projectId, parsed.targetProjectId, components));
      return { ok: true, summary: `Created component reuse plan for ${components.length} component(s).`, jobId: parsed.projectId, artifacts: [file.path, ...components.map((component) => component.id)], structuredContent: { projectId: parsed.projectId, targetProjectId: parsed.targetProjectId, outputPath: file.path, components }, logs: [file.path], errors: [] };
    }
  },
  {
    definition: {
      name: "export_component_registry_report",
      description: "Export the reusable component registry as a Markdown report for handoff and reuse planning.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportComponentRegistrySchema,
    handler: async (input, ctx) => {
      const parsed = exportComponentRegistrySchema.parse(input);
      const registry = await readRegistry(ctx, parsed.projectId);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, renderRegistryMarkdown(parsed.projectId, registry.components));
      return { ok: true, summary: `Exported component registry with ${registry.components.length} component(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, outputPath: file.path, summary: summarize(registry.components) }, logs: [file.path], errors: [] };
    }
  }
];
