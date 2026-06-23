import { z } from "zod";
import { writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const customToolDomains = [
  "task_management",
  "visual_understanding",
  "code_fix_loop",
  "data_analysis",
  "prediction_simulation",
  "image_workflow",
  "three_d_game",
  "math_verification",
  "project_memory"
] as const;

type CustomToolDomain = typeof customToolDomains[number];

interface CustomToolBlueprint {
  domain: CustomToolDomain;
  label: string;
  purpose: string;
  capabilities: string[];
  recommendedInputs: string[];
  recommendedOutputs: string[];
  safetyBoundaries: string[];
  verificationChecks: string[];
  continuationState: string[];
}

const blueprints: CustomToolBlueprint[] = [
  {
    domain: "task_management",
    label: "Task Management",
    purpose: "Plan, resume, prioritize, execute, and evidence-bind multi-step project work.",
    capabilities: ["task CRUD", "dependency graph", "board view", "next-task picking", "queue step execution", "evidence binding"],
    recommendedInputs: ["projectId", "taskId", "status", "priority", "dependsOn", "validation mode", "changed files"],
    recommendedOutputs: ["selected task", "lanes", "counts", "stop reason", "next actions", "bound evidence"],
    safetyBoundaries: ["Do not execute arbitrary commands inside queue tools.", "Reject dependency cycles.", "Preserve task evidence and history."],
    verificationChecks: ["unit tests for ready/blocked ordering", "validation failure stop test", "MCP registry check"],
    continuationState: ["resume task", "recent activity", "unfinished tasks", "next actions"]
  },
  {
    domain: "visual_understanding",
    label: "Visual Understanding",
    purpose: "Help agents see rendered pages, compare screenshots, inspect DOM regions, and identify visual regressions.",
    capabilities: ["screenshot capture", "DOM-at-point inspection", "visual issue extraction", "responsive viewport comparison", "network/console correlation"],
    recommendedInputs: ["url", "projectId", "viewport list", "selector or point", "baseline artifact"],
    recommendedOutputs: ["screenshots", "findings", "report URL", "affected selectors", "severity"],
    safetyBoundaries: ["Never fetch private-network URLs unless explicitly allowed by existing URL safety checks.", "Do not store full screenshots when a bounded artifact is enough."],
    verificationChecks: ["browser smoke test", "nonblank screenshot assertion", "schema regression test"],
    continuationState: ["last inspected URL", "viewport findings", "blocking visual issues"]
  },
  {
    domain: "code_fix_loop",
    label: "Code Fix Loop",
    purpose: "Patch project code, validate after each iteration, and stop on deterministic failure conditions.",
    capabilities: ["exact patch batches", "typecheck/test/build dispatch", "browser validation", "fix attempt reporting"],
    recommendedInputs: ["projectId", "file operations", "max iterations", "validation profile", "stop policy"],
    recommendedOutputs: ["attempt log", "patched files", "validation result", "stop reason", "next actions"],
    safetyBoundaries: ["Prefer exact replacements over broad rewrites.", "Do not run destructive git or shell operations.", "Cap iterations."],
    verificationChecks: ["failing validation test", "passing validation test", "changed-file evidence test"],
    continuationState: ["attempt index", "last failure", "patched files", "remaining fixes"]
  },
  {
    domain: "data_analysis",
    label: "Data Analysis",
    purpose: "Load, inspect, clean, analyze, visualize, forecast, and export bounded datasets.",
    capabilities: ["schema inspection", "data quality audit", "summary statistics", "chart spec generation", "forecast scaffolding", "report export"],
    recommendedInputs: ["dataset reference", "columns", "metric definitions", "filters", "time grain", "chart intent"],
    recommendedOutputs: ["schema", "quality findings", "tables", "chart data", "methodology", "report artifact"],
    safetyBoundaries: ["Bound rows and bytes.", "Avoid modifying source data.", "Report missing denominators and sampling limits."],
    verificationChecks: ["row-count check", "type inference test", "chart schema validation"],
    continuationState: ["loaded dataset ids", "metric definitions", "quality issues", "analysis decisions"]
  },
  {
    domain: "prediction_simulation",
    label: "Prediction and Simulation",
    purpose: "Run transparent scenario models and simulations with assumptions, uncertainty, and sensitivity outputs.",
    capabilities: ["scenario definition", "Monte Carlo-ready specs", "sensitivity grid", "forecast intervals", "assumption ledger"],
    recommendedInputs: ["baseline values", "drivers", "ranges", "time horizon", "scenario names"],
    recommendedOutputs: ["scenario table", "intervals", "driver sensitivity", "assumption manifest", "risk notes"],
    safetyBoundaries: ["Do not present speculative outputs as facts.", "Expose assumptions and uncertainty.", "Avoid high-stakes recommendations without caveats."],
    verificationChecks: ["deterministic seed test", "range validation", "sensitivity monotonicity checks"],
    continuationState: ["assumptions", "seed", "scenario versions", "last run summary"]
  },
  {
    domain: "image_workflow",
    label: "Image Workflow",
    purpose: "Manage image generation/editing briefs, assets, sprite sheets, style consistency, and visual QA.",
    capabilities: ["image brief manifest", "asset inventory", "sprite sheet spec", "style guide checks", "background/removal handoff"],
    recommendedInputs: ["prompt", "reference assets", "dimensions", "transparent background flag", "style tokens"],
    recommendedOutputs: ["asset manifest", "generated files", "QA findings", "reuse notes", "license/source notes"],
    safetyBoundaries: ["Keep prompts and references explicit.", "Do not overwrite source assets.", "Track provenance and edits."],
    verificationChecks: ["image dimension check", "alpha-channel check", "manifest validation"],
    continuationState: ["style guide", "asset ids", "revision notes", "accepted/rejected variants"]
  },
  {
    domain: "three_d_game",
    label: "3D and Game Building",
    purpose: "Validate 3D assets, scenes, game loops, controls, collisions, and performance budgets.",
    capabilities: ["GLB/GLTF manifest", "scene graph inspection", "collision checklist", "camera/control QA", "FPS budget report"],
    recommendedInputs: ["asset paths", "scene config", "camera profile", "collision rules", "performance target"],
    recommendedOutputs: ["asset report", "scene issues", "controls checklist", "performance summary", "next fixes"],
    safetyBoundaries: ["Do not assume a model renders without pixel/canvas checks.", "Keep generated assets bounded.", "Avoid unbounded animation loops in tests."],
    verificationChecks: ["nonblank canvas check", "asset parse test", "mobile/desktop viewport smoke test"],
    continuationState: ["scene manifest", "asset inventory", "QA failures", "performance baseline"]
  },
  {
    domain: "math_verification",
    label: "Math Verification",
    purpose: "Check formulas, numeric claims, units, equations, and derivations with reproducible evidence.",
    capabilities: ["formula validation", "unit checks", "symbolic/numeric cross-check", "tolerance-aware comparison"],
    recommendedInputs: ["claim", "formula", "variables", "units", "expected tolerance"],
    recommendedOutputs: ["verification status", "calculation steps", "counterexample", "unit mismatch notes"],
    safetyBoundaries: ["State assumptions.", "Use tolerances for floating-point results.", "Flag under-specified variables."],
    verificationChecks: ["known-answer tests", "unit conversion tests", "edge-case tests"],
    continuationState: ["assumptions", "variables", "last verified claim", "open contradictions"]
  },
  {
    domain: "project_memory",
    label: "Project Memory",
    purpose: "Persist durable project decisions, evidence, context, unresolved blockers, and handoff state.",
    capabilities: ["decision log", "evidence index", "resume state", "blocker tracking", "handoff summary"],
    recommendedInputs: ["projectId", "decision", "evidence links", "blockers", "next actions"],
    recommendedOutputs: ["memory item", "searchable summary", "evidence links", "resume packet"],
    safetyBoundaries: ["Do not store secrets.", "Separate durable facts from temporary notes.", "Keep provenance links."],
    verificationChecks: ["search retrieval test", "no-secret scan", "handoff completeness check"],
    continuationState: ["latest decision", "open blockers", "evidence index", "next task"]
  }
];

const listCustomToolBlueprintsInputSchema = z.object({
  domain: z.enum(customToolDomains).optional(),
  query: z.string().max(200).optional().default("")
});

const getCustomToolBlueprintInputSchema = z.object({
  domain: z.enum(customToolDomains)
});

const generateCustomToolSpecInputSchema = z.object({
  domain: z.enum(customToolDomains),
  toolName: z.string().regex(/^[a-z][a-z0-9_]{2,80}$/),
  objective: z.string().min(1).max(1000),
  projectId: z.string().min(8).max(80).optional(),
  writeToProject: z.boolean().optional().default(false),
  riskLevel: z.enum(["low", "medium", "high"]).optional().default("medium"),
  asyncEligible: z.boolean().optional().default(false),
  inputs: z.array(z.string().min(1).max(120)).max(30).optional().default([]),
  outputs: z.array(z.string().min(1).max(120)).max(30).optional().default([]),
  safetyBoundaries: z.array(z.string().min(1).max(240)).max(30).optional().default([]),
  verificationChecks: z.array(z.string().min(1).max(240)).max(30).optional().default([]),
  continuationState: z.array(z.string().min(1).max(160)).max(30).optional().default([])
});

const validateCustomToolSpecInputSchema = z.object({
  spec: z.record(z.string(), z.unknown())
});

function blueprintFor(domain: CustomToolDomain): CustomToolBlueprint {
  const blueprint = blueprints.find((item) => item.domain === domain);
  if (!blueprint) throw new Error(`Unknown custom tool domain: ${domain}`);
  return blueprint;
}

function mergeUnique(base: string[], extra: string[]): string[] {
  return [...new Set([...base, ...extra].map((item) => item.trim()).filter(Boolean))];
}

function customToolSpecPath(toolName: string): string {
  return `mcp-tools/${toolName}.tool-spec.json`;
}

function generateSpec(input: z.infer<typeof generateCustomToolSpecInputSchema>): Record<string, unknown> {
  const blueprint = blueprintFor(input.domain);
  return {
    schemaVersion: 1,
    status: "draft",
    toolName: input.toolName,
    domain: input.domain,
    label: blueprint.label,
    objective: input.objective,
    riskLevel: input.riskLevel,
    asyncEligible: input.asyncEligible,
    capabilities: blueprint.capabilities,
    inputContract: mergeUnique(blueprint.recommendedInputs, input.inputs),
    outputContract: mergeUnique(blueprint.recommendedOutputs, input.outputs),
    safetyBoundaries: mergeUnique(blueprint.safetyBoundaries, input.safetyBoundaries),
    verificationChecks: mergeUnique(blueprint.verificationChecks, input.verificationChecks),
    continuationState: mergeUnique(blueprint.continuationState, input.continuationState),
    implementationPlan: [
      "Add a ToolModule with definition, zod schema, handler, enabledByDefault flag, and focused tests.",
      "Register the module in src/mcp/tools/index.ts.",
      "Expose the tool through the smallest appropriate enabled skill in src/skills/registry.ts.",
      "Run npm run typecheck, targeted tests, npm test, and npm run check:mcp."
    ],
    evidenceModel: {
      artifacts: "Return bounded artifact paths/URLs in ToolResult.artifacts.",
      logs: "Return concise logs with structuredContent for machine-readable state.",
      continuation: "Return nextActions and durable state fields so another agent can resume."
    },
    createdAt: new Date().toISOString()
  };
}

function validateSpec(spec: Record<string, unknown>): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const toolName = typeof spec.toolName === "string" ? spec.toolName : "";
  if (!/^[a-z][a-z0-9_]{2,80}$/.test(toolName)) errors.push("toolName must be snake_case and 3-81 characters.");
  if (!customToolDomains.includes(spec.domain as CustomToolDomain)) errors.push("domain must be one of the supported custom tool domains.");
  if (typeof spec.objective !== "string" || !spec.objective.trim()) errors.push("objective is required.");
  for (const field of ["inputContract", "outputContract", "safetyBoundaries", "verificationChecks", "continuationState"]) {
    if (!Array.isArray(spec[field]) || (spec[field] as unknown[]).length === 0) errors.push(`${field} must be a non-empty array.`);
  }
  if (!Array.isArray(spec.safetyBoundaries) || !spec.safetyBoundaries.some((item) => typeof item === "string" && /secret|credential|destructive|arbitrary|bounded|safety/i.test(item))) {
    warnings.push("safetyBoundaries should explicitly address secrets, destructive actions, arbitrary execution, or bounded outputs.");
  }
  if (!Array.isArray(spec.verificationChecks) || !spec.verificationChecks.some((item) => typeof item === "string" && /test|check|validation|verify/i.test(item))) {
    warnings.push("verificationChecks should include concrete test/check/validation language.");
  }
  return { ok: errors.length === 0, errors, warnings };
}

export const mcpPlatformTools: ToolModule[] = [
  {
    definition: {
      name: "list_custom_mcp_tool_blueprints",
      description: "List safe custom MCP tool blueprints by domain so agents can design tools for seeing, testing, remembering, and continuing work.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", enum: customToolDomains },
          query: { type: "string" }
        },
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: listCustomToolBlueprintsInputSchema,
    handler: (input) => {
      const parsed = listCustomToolBlueprintsInputSchema.parse(input);
      const query = parsed.query.toLowerCase();
      const filtered = blueprints.filter((blueprint) => {
        if (parsed.domain && blueprint.domain !== parsed.domain) return false;
        if (!query) return true;
        return JSON.stringify(blueprint).toLowerCase().includes(query);
      });
      return {
        ok: true,
        summary: `Listed ${filtered.length} custom MCP tool blueprint(s).`,
        artifacts: filtered.map((item) => item.domain),
        structuredContent: { blueprints: filtered, total: filtered.length, domains: customToolDomains },
        logs: [JSON.stringify({ blueprints: filtered, total: filtered.length }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "get_custom_mcp_tool_blueprint",
      description: "Return one custom MCP tool blueprint with recommended inputs, outputs, safety boundaries, verification checks, and continuation state.",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string", enum: customToolDomains } },
        required: ["domain"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: getCustomToolBlueprintInputSchema,
    handler: (input) => {
      const parsed = getCustomToolBlueprintInputSchema.parse(input);
      const blueprint = blueprintFor(parsed.domain);
      return {
        ok: true,
        summary: `Loaded ${blueprint.label} custom MCP tool blueprint.`,
        artifacts: [blueprint.domain],
        structuredContent: { blueprint },
        logs: [JSON.stringify(blueprint, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "generate_custom_mcp_tool_spec",
      description: "Generate a reviewable custom MCP tool specification from a domain blueprint, optionally writing it into a project for implementation.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", enum: customToolDomains },
          toolName: { type: "string" },
          objective: { type: "string" },
          projectId: { type: "string" },
          writeToProject: { type: "boolean" },
          riskLevel: { type: "string", enum: ["low", "medium", "high"] },
          asyncEligible: { type: "boolean" },
          inputs: { type: "array", items: { type: "string" } },
          outputs: { type: "array", items: { type: "string" } },
          safetyBoundaries: { type: "array", items: { type: "string" } },
          verificationChecks: { type: "array", items: { type: "string" } },
          continuationState: { type: "array", items: { type: "string" } }
        },
        required: ["domain", "toolName", "objective"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: generateCustomToolSpecInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateCustomToolSpecInputSchema.parse(input);
      if (parsed.writeToProject && !parsed.projectId) throw new Error("projectId is required when writeToProject is true.");
      const spec = generateSpec(parsed);
      const validation = validateSpec(spec);
      const artifacts: string[] = [parsed.toolName];
      if (parsed.writeToProject && parsed.projectId) {
        const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, customToolSpecPath(parsed.toolName), JSON.stringify(spec, null, 2) + "\n");
        artifacts.push(file.path);
      }
      return {
        ok: validation.ok,
        summary: parsed.writeToProject && parsed.projectId
          ? `Generated custom MCP tool spec ${parsed.toolName} and wrote it to project ${parsed.projectId}.`
          : `Generated custom MCP tool spec ${parsed.toolName}.`,
        jobId: parsed.projectId,
        artifacts,
        structuredContent: { spec, validation, writtenPath: parsed.writeToProject ? customToolSpecPath(parsed.toolName) : undefined },
        logs: [JSON.stringify({ spec, validation }, null, 2)],
        errors: validation.errors
      };
    }
  },
  {
    definition: {
      name: "validate_custom_mcp_tool_spec",
      description: "Validate a custom MCP tool specification before implementing it in the static tool registry.",
      inputSchema: {
        type: "object",
        properties: { spec: { type: "object" } },
        required: ["spec"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: validateCustomToolSpecInputSchema,
    handler: (input) => {
      const parsed = validateCustomToolSpecInputSchema.parse(input);
      const validation = validateSpec(parsed.spec);
      return {
        ok: validation.ok,
        summary: validation.ok ? "Custom MCP tool spec is valid." : "Custom MCP tool spec is invalid.",
        artifacts: [],
        structuredContent: validation,
        logs: [JSON.stringify(validation, null, 2)],
        errors: validation.errors
      };
    }
  }
];
