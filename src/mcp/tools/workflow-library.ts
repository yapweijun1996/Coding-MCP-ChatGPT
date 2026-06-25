import { z } from "zod";
import { readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const workflowLibraryPath = "workflows/workflow-library.json";

const workflowKindEnum = z.enum(["refactor", "qa", "publish", "data-report", "pwa-polish", "bug-fix-loop", "custom"]);
const riskEnum = z.enum(["low", "medium", "high"]);

const workflowStepSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().min(3).max(160),
  instruction: z.string().min(3).max(1000),
  toolNames: z.array(z.string().min(1).max(120)).max(20).default([]),
  expectedArtifact: z.string().min(1).max(240).optional()
});

const registerWorkflowTemplateSchema = z.object({
  projectId: z.string().min(8).max(80),
  template: z.object({
    id: z.string().min(3).max(80).regex(/^[a-zA-Z0-9_-]+$/),
    title: z.string().min(3).max(160),
    kind: workflowKindEnum,
    summary: z.string().min(3).max(500),
    promptTemplate: z.string().min(3).max(4000),
    tags: z.array(z.string().min(1).max(60)).max(30).default([]),
    steps: z.array(workflowStepSchema).min(1).max(30),
    acceptanceChecks: z.array(z.string().min(1).max(240)).min(1).max(30),
    recommendedTools: z.array(z.string().min(1).max(120)).max(40).default([]),
    riskLevel: riskEnum.default("medium")
  })
});

const listWorkflowTemplatesSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  kind: workflowKindEnum.optional(),
  query: z.string().min(1).max(160).optional(),
  includeCustom: z.boolean().default(true)
});

const recommendWorkflowTemplatesSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  job: z.string().min(3).max(500),
  kind: workflowKindEnum.optional(),
  desiredTools: z.array(z.string().min(1).max(120)).max(20).default([]),
  maxResults: z.number().int().min(1).max(20).default(5)
});

const createWorkflowRunbookSchema = z.object({
  projectId: z.string().min(8).max(80),
  templateId: z.string().min(3).max(80),
  title: z.string().min(3).max(180).optional(),
  variables: z.record(z.string(), z.string()).default({}),
  outputPath: z.string().min(1).max(240).default("workflows/workflow-runbook.md")
});

const exportWorkflowLibrarySchema = z.object({
  projectId: z.string().min(8).max(80),
  outputPath: z.string().min(1).max(240).default("workflows/workflow-library.md")
});

type WorkflowKind = z.infer<typeof workflowKindEnum>;
type RiskLevel = z.infer<typeof riskEnum>;

interface WorkflowTemplate {
  id: string;
  title: string;
  kind: WorkflowKind;
  summary: string;
  promptTemplate: string;
  tags: string[];
  steps: Array<z.infer<typeof workflowStepSchema>>;
  acceptanceChecks: string[];
  recommendedTools: string[];
  riskLevel: RiskLevel;
  source: "builtin" | "custom";
}

interface WorkflowLibrary {
  version: 1;
  templates: WorkflowTemplate[];
}

const builtinTemplates: WorkflowTemplate[] = [
  {
    id: "safe-refactor",
    title: "Safe Refactor Workflow",
    kind: "refactor",
    summary: "Inspect module boundaries, plan small edits, preserve behavior, and verify with focused and broad tests.",
    promptTemplate: "Refactor {{target}} while preserving behavior. First inspect current patterns, identify risks, make scoped edits, then run {{verification}}.",
    tags: ["refactor", "tests", "scope"],
    steps: [
      { id: "inspect", title: "Inspect boundaries", instruction: "Read affected files, tests, and local patterns before editing.", toolNames: ["repo_summary", "changed_files_context", "refactor_hints"] },
      { id: "plan", title: "Plan scoped edits", instruction: "List the smallest behavior-preserving changes and expected test coverage.", toolNames: [] },
      { id: "edit", title: "Apply refactor", instruction: "Keep public contracts stable unless the task explicitly changes them.", toolNames: [] },
      { id: "verify", title: "Verify behavior", instruction: "Run focused tests, typecheck, and broader tests when shared code changed.", toolNames: ["run_typecheck", "run_tests"] }
    ],
    acceptanceChecks: ["Behavior is preserved.", "Tests cover the changed surface.", "No unrelated refactor churn."],
    recommendedTools: ["refactor_hints", "run_typecheck", "run_tests", "git_diff"],
    riskLevel: "medium",
    source: "builtin"
  },
  {
    id: "browser-qa",
    title: "Browser QA Workflow",
    kind: "qa",
    summary: "Validate layout, console, network, accessibility, and key flows with browser evidence.",
    promptTemplate: "QA {{url_or_project}} across {{viewports}}. Collect console/network/layout/accessibility evidence and summarize blocking issues first.",
    tags: ["qa", "browser", "accessibility", "visual"],
    steps: [
      { id: "open", title: "Open target", instruction: "Resolve the preview URL or local project entry and load it in a browser QA tool.", toolNames: ["inspect_webpage", "inspect_local_project"] },
      { id: "observe", title: "Collect signals", instruction: "Capture DOM, console, network, storage, and screenshots for key viewports.", toolNames: ["browser_dom_snapshot", "browser_console_log", "browser_network_trace"] },
      { id: "flows", title: "Walk critical flows", instruction: "Run smoke interactions for primary buttons, forms, and navigation.", toolNames: ["inspect_interaction_flow", "run_smoke_flow"] },
      { id: "report", title: "Report findings", instruction: "Prioritize blocking regressions with file/selector evidence.", toolNames: [] }
    ],
    acceptanceChecks: ["No blocking console/page errors.", "Primary flows pass.", "Mobile and desktop layouts are usable."],
    recommendedTools: ["inspect_webpage", "audit_accessibility", "inspect_interaction_flow", "browser_console_log"],
    riskLevel: "low",
    source: "builtin"
  },
  {
    id: "publish-handoff",
    title: "Publish Handoff Workflow",
    kind: "publish",
    summary: "Validate, publish, inspect, document, and return stable delivery URLs with evidence.",
    promptTemplate: "Prepare {{projectId}} for publish. Validate first, publish only when valid, run browser checks, then produce a concise handoff.",
    tags: ["publish", "handoff", "validation"],
    steps: [
      { id: "validate", title: "Validate project", instruction: "Run static validation and fix blockers before publishing.", toolNames: ["validate_project"] },
      { id: "publish", title: "Publish project", instruction: "Publish only after validation passes.", toolNames: ["publish_and_report"] },
      { id: "inspect", title: "Inspect published URL", instruction: "Run browser and accessibility checks on the published URL.", toolNames: ["inspect_webpage", "audit_accessibility"] },
      { id: "handoff", title: "Prepare handoff", instruction: "Include URL, changed files, validation, known limitations, and next steps.", toolNames: ["generate_project_docs"] }
    ],
    acceptanceChecks: ["Validation passes before publish.", "Stable public URL is returned.", "Handoff includes verification evidence."],
    recommendedTools: ["validate_project", "publish_and_report", "inspect_webpage", "generate_project_docs"],
    riskLevel: "medium",
    source: "builtin"
  },
  {
    id: "data-report",
    title: "Data Report Workflow",
    kind: "data-report",
    summary: "Load data, profile quality, create analysis outputs, and export a reproducible report.",
    promptTemplate: "Analyze {{dataset}} for {{question}}. Validate schema/quality before conclusions, create useful visuals, and export a report.",
    tags: ["data", "report", "charts", "quality"],
    steps: [
      { id: "load", title: "Load preview", instruction: "Load bounded rows and inspect columns and types.", toolNames: ["load_dataset_preview"] },
      { id: "quality", title: "Profile quality", instruction: "Check missing values, duplicates, ranges, and anomalies.", toolNames: ["profile_dataset_quality"] },
      { id: "visualize", title: "Create chart spec", instruction: "Choose charts that answer the decision question.", toolNames: ["create_dataset_chart_spec"] },
      { id: "export", title: "Export report", instruction: "Document methods, assumptions, caveats, and findings.", toolNames: ["export_data_analysis_report"] }
    ],
    acceptanceChecks: ["Data quality caveats are stated.", "Metrics are reproducible.", "Report answers the user question."],
    recommendedTools: ["load_dataset_preview", "profile_dataset_quality", "create_dataset_chart_spec", "export_data_analysis_report"],
    riskLevel: "low",
    source: "builtin"
  },
  {
    id: "pwa-polish",
    title: "PWA Polish Workflow",
    kind: "pwa-polish",
    summary: "Audit manifest, service worker, offline state, icons, install UX, persistence, and mobile readiness.",
    promptTemplate: "Polish {{projectId}} as a PWA. Check manifest, offline behavior, install cues, persistence, accessibility, and mobile layout.",
    tags: ["pwa", "mobile", "offline", "install"],
    steps: [
      { id: "audit", title: "Audit PWA basics", instruction: "Check manifest, service worker, icons, offline fallbacks, and install/update UI.", toolNames: ["audit_project_pwa"] },
      { id: "persistence", title: "Test persistence", instruction: "Verify forms, settings, drafts, and storage survive reload.", toolNames: ["test_form_persistence"] },
      { id: "mobile", title: "Inspect mobile", instruction: "Run mobile browser QA for layout and touch ergonomics.", toolNames: ["inspect_webpage"] },
      { id: "quality", title: "Run quality gate", instruction: "Use PWA/mobile/accessibility gate presets before handoff.", toolNames: ["create_quality_gate_plan", "evaluate_quality_gate_results"] }
    ],
    acceptanceChecks: ["PWA audit blockers are resolved.", "Persistence survives reload.", "Mobile layout is usable."],
    recommendedTools: ["audit_project_pwa", "test_form_persistence", "inspect_webpage", "create_quality_gate_plan"],
    riskLevel: "medium",
    source: "builtin"
  },
  {
    id: "bug-fix-loop",
    title: "Bug Fix Loop",
    kind: "bug-fix-loop",
    summary: "Reproduce a bug, classify root cause, patch narrowly, verify, and record lessons for recurring failures.",
    promptTemplate: "Fix {{bug}} in {{projectId}}. Reproduce first, classify root cause, patch the smallest surface, re-run verification, and record evidence.",
    tags: ["bug", "debug", "regression", "learning"],
    steps: [
      { id: "reproduce", title: "Reproduce failure", instruction: "Collect exact error, failing test, browser evidence, or user steps.", toolNames: ["test_failure_digest", "inspect_interaction_flow"] },
      { id: "classify", title: "Classify root cause", instruction: "Group symptoms and identify affected files/selectors.", toolNames: ["classify_project_errors"] },
      { id: "patch", title: "Patch narrowly", instruction: "Apply the smallest fix that addresses the verified root cause.", toolNames: ["run_project_fix_loop"] },
      { id: "learn", title: "Record learning", instruction: "Capture recurring fix pattern when stable and verified.", toolNames: ["record_fix_learning"] }
    ],
    acceptanceChecks: ["Bug is reproduced or bounded.", "Fix is verified by the relevant test/check.", "No unrelated changes."],
    recommendedTools: ["classify_project_errors", "run_project_fix_loop", "run_tests", "record_fix_learning"],
    riskLevel: "medium",
    source: "builtin"
  }
];

function emptyLibrary(): WorkflowLibrary {
  return { version: 1, templates: [] };
}

async function readCustomLibrary(ctx: ToolContext, projectId?: string): Promise<WorkflowLibrary> {
  if (!projectId) return emptyLibrary();
  try {
    const raw = await readProjectFile(ctx.projectRoot, projectId, workflowLibraryPath);
    const parsed = JSON.parse(raw) as WorkflowLibrary;
    return { version: 1, templates: Array.isArray(parsed.templates) ? parsed.templates : [] };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return emptyLibrary();
    throw error;
  }
}

async function writeCustomLibrary(ctx: ToolContext, projectId: string, library: WorkflowLibrary) {
  return writeProjectFile(ctx.projectRoot, projectId, workflowLibraryPath, `${JSON.stringify(library, null, 2)}\n`);
}

async function allTemplates(ctx: ToolContext, projectId?: string, includeCustom = true): Promise<WorkflowTemplate[]> {
  const custom = includeCustom ? (await readCustomLibrary(ctx, projectId)).templates : [];
  return [...builtinTemplates, ...custom.map((template) => ({ ...template, source: "custom" as const }))];
}

function matchesQuery(template: WorkflowTemplate, query?: string): boolean {
  if (!query) return true;
  const haystack = [template.id, template.title, template.kind, template.summary, template.promptTemplate, ...template.tags, ...template.acceptanceChecks, ...template.recommendedTools].join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).every((token) => haystack.includes(token));
}

function scoreTemplate(template: WorkflowTemplate, job: string, desiredTools: string[]): number {
  const text = [template.id, template.title, template.kind, template.summary, template.promptTemplate, ...template.tags, ...template.acceptanceChecks, ...template.recommendedTools].join(" ").toLowerCase();
  const jobScore = job.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).reduce((score, token) => score + (text.includes(token) ? 2 : 0), 0);
  const toolScore = desiredTools.reduce((score, tool) => score + (template.recommendedTools.includes(tool) ? 6 : text.includes(tool.toLowerCase()) ? 3 : 0), 0);
  return jobScore + toolScore + (template.source === "custom" ? 1 : 0);
}

function applyVariables(value: string, variables: Record<string, string>): string {
  return value.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_, key: string) => variables[key] ?? `{{${key}}}`);
}

function templateLine(template: WorkflowTemplate): string {
  return `${template.id} (${template.kind}/${template.riskLevel}/${template.source}): ${template.title}`;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").trim();
}

function renderRunbook(projectId: string, template: WorkflowTemplate, title: string, variables: Record<string, string>): string {
  return `# ${title}

- Project: \`${projectId}\`
- Template: \`${template.id}\`
- Kind: ${template.kind}
- Risk: ${template.riskLevel}

## Prompt

${applyVariables(template.promptTemplate, variables)}

## Steps

${template.steps.map((step, index) => `${index + 1}. **${step.title}**\n   - ${applyVariables(step.instruction, variables)}\n   - Tools: ${step.toolNames.length ? step.toolNames.map((tool) => `\`${tool}\``).join(", ") : "none"}${step.expectedArtifact ? `\n   - Expected artifact: ${step.expectedArtifact}` : ""}`).join("\n")}

## Acceptance Checks

${template.acceptanceChecks.map((check) => `- ${applyVariables(check, variables)}`).join("\n")}
`;
}

function renderLibrary(projectId: string, templates: WorkflowTemplate[]): string {
  const rows = templates.map((template) => `| ${template.id} | ${escapeMarkdown(template.title)} | ${template.kind} | ${template.riskLevel} | ${template.source} | ${template.recommendedTools.slice(0, 6).map((tool) => `\`${tool}\``).join(", ")} |`).join("\n");
  return `# Workflow Library

- Project: \`${projectId}\`
- Templates: ${templates.length}

| ID | Title | Kind | Risk | Source | Recommended Tools |
| --- | --- | --- | --- | --- | --- |
${rows || "| - | - | - | - | - | - |"}
`;
}

export const workflowLibraryTools: ToolModule[] = [
  {
    definition: {
      name: "register_workflow_template",
      description: "Register a reusable project-local prompt/workflow template with steps, tools, and acceptance checks.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, template: { type: "object" } }, required: ["projectId", "template"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: registerWorkflowTemplateSchema,
    handler: async (input, ctx) => {
      const parsed = registerWorkflowTemplateSchema.parse(input);
      const library = await readCustomLibrary(ctx, parsed.projectId);
      const template: WorkflowTemplate = { ...parsed.template, source: "custom" };
      library.templates = [...library.templates.filter((item) => item.id !== template.id), template];
      const file = await writeCustomLibrary(ctx, parsed.projectId, library);
      return { ok: true, summary: `Registered workflow template ${template.id}.`, jobId: parsed.projectId, artifacts: [file.path, template.id], structuredContent: { projectId: parsed.projectId, template }, logs: [templateLine(template)], errors: [] };
    }
  },
  {
    definition: {
      name: "list_workflow_templates",
      description: "List built-in and project-local reusable workflow/prompt templates for refactor, QA, publish, data report, PWA polish, and bug fix loops.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, kind: { type: "string", enum: ["refactor", "qa", "publish", "data-report", "pwa-polish", "bug-fix-loop", "custom"] }, query: { type: "string" }, includeCustom: { type: "boolean" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listWorkflowTemplatesSchema,
    handler: async (input, ctx) => {
      const parsed = listWorkflowTemplatesSchema.parse(input);
      const templates = (await allTemplates(ctx, parsed.projectId, parsed.includeCustom))
        .filter((template) => !parsed.kind || template.kind === parsed.kind)
        .filter((template) => matchesQuery(template, parsed.query));
      return { ok: true, summary: `${templates.length} workflow template(s) returned.`, jobId: parsed.projectId, artifacts: [], structuredContent: { projectId: parsed.projectId, templates }, logs: templates.map(templateLine), errors: [] };
    }
  },
  {
    definition: {
      name: "recommend_workflow_templates",
      description: "Rank reusable workflow templates for a job using text signals and desired MCP tools.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, job: { type: "string" }, kind: { type: "string", enum: ["refactor", "qa", "publish", "data-report", "pwa-polish", "bug-fix-loop", "custom"] }, desiredTools: { type: "array", items: { type: "string" } }, maxResults: { type: "number" } }, required: ["job"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: recommendWorkflowTemplatesSchema,
    handler: async (input, ctx) => {
      const parsed = recommendWorkflowTemplatesSchema.parse(input);
      const recommendations = (await allTemplates(ctx, parsed.projectId, true))
        .filter((template) => !parsed.kind || template.kind === parsed.kind)
        .map((template) => ({ template, score: scoreTemplate(template, parsed.job, parsed.desiredTools) }))
        .sort((left, right) => right.score - left.score || left.template.title.localeCompare(right.template.title))
        .slice(0, parsed.maxResults);
      return { ok: true, summary: `Recommended ${recommendations.length} workflow template(s).`, jobId: parsed.projectId, artifacts: recommendations.map((item) => item.template.id), structuredContent: { projectId: parsed.projectId, recommendations }, logs: recommendations.map((item) => `${item.score}: ${templateLine(item.template)}`), errors: [] };
    }
  },
  {
    definition: {
      name: "create_workflow_runbook_from_template",
      description: "Instantiate a reusable workflow template into a project-local Markdown runbook with variables applied.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, templateId: { type: "string" }, title: { type: "string" }, variables: { type: "object" }, outputPath: { type: "string" } }, required: ["projectId", "templateId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createWorkflowRunbookSchema,
    handler: async (input, ctx) => {
      const parsed = createWorkflowRunbookSchema.parse(input);
      const template = (await allTemplates(ctx, parsed.projectId, true)).find((item) => item.id === parsed.templateId);
      if (!template) throw new Error(`Workflow template ${parsed.templateId} not found.`);
      const title = parsed.title ?? `${template.title} Runbook`;
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, renderRunbook(parsed.projectId, template, title, parsed.variables));
      return { ok: true, summary: `Created workflow runbook from ${template.id}.`, jobId: parsed.projectId, artifacts: [file.path, template.id], structuredContent: { projectId: parsed.projectId, template, outputPath: file.path }, logs: [file.path], errors: [] };
    }
  },
  {
    definition: {
      name: "export_workflow_library_report",
      description: "Export built-in and project-local reusable workflow templates as a Markdown library report.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportWorkflowLibrarySchema,
    handler: async (input, ctx) => {
      const parsed = exportWorkflowLibrarySchema.parse(input);
      const templates = await allTemplates(ctx, parsed.projectId, true);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, renderLibrary(parsed.projectId, templates));
      return { ok: true, summary: `Exported workflow library with ${templates.length} template(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, outputPath: file.path, templateCount: templates.length }, logs: [file.path], errors: [] };
    }
  }
];
