import { z } from "zod";
import { writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const qualityGatePresetSchema = z.enum(["demo", "production", "pwa", "mobile", "accessibility", "data_app", "game"]);
const gateStatusSchema = z.enum(["passed", "failed", "warning", "skipped", "not_run"]);

const gateCheckSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  category: z.enum(["build", "test", "browser", "accessibility", "performance", "security", "content", "data", "mobile", "pwa", "game"]),
  required: z.boolean(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  recommendedTools: z.array(z.string().min(1).max(120)).max(20),
  evidenceTypes: z.array(z.enum(["command", "artifact", "screenshot", "url", "report", "manual_note"])).max(10),
  expectedEvidence: z.string().min(1).max(500)
});

const gateResultSchema = z.object({
  checkId: z.string().min(1).max(100),
  status: gateStatusSchema,
  evidence: z.array(z.string().min(1).max(500)).max(50).optional().default([]),
  note: z.string().max(1000).optional()
});

const listQualityGatePresetsInputSchema = z.object({
  preset: qualityGatePresetSchema.optional()
});

const createQualityGatePlanInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  preset: qualityGatePresetSchema,
  strictness: z.enum(["quick", "standard", "strict"]).optional().default("standard"),
  extraChecks: z.array(gateCheckSchema).max(50).optional().default([]),
  outputPath: z.string().min(1).max(240).optional().default("quality-gates/quality-gate-plan.json")
});

const evaluateQualityGateInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  preset: qualityGatePresetSchema,
  results: z.array(gateResultSchema).max(300).optional().default([]),
  strictness: z.enum(["quick", "standard", "strict"]).optional().default("standard"),
  outputPath: z.string().min(1).max(240).optional().default("quality-gates/quality-gate-evaluation.json")
});

const createQualityGateRunbookInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  preset: qualityGatePresetSchema,
  outputPath: z.string().min(1).max(240).optional().default("quality-gates/quality-gate-runbook.md")
});

const compareQualityGatePresetsInputSchema = z.object({
  presets: z.array(qualityGatePresetSchema).min(2).max(7)
});

const exportQualityGateReportInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(200).optional().default("Quality Gate Report"),
  preset: qualityGatePresetSchema,
  evaluation: z.record(z.string(), z.unknown()).optional().default({}),
  outputPath: z.string().min(1).max(240).optional().default("quality-gates/quality-gate-report.md")
});

type QualityGatePreset = z.infer<typeof qualityGatePresetSchema>;
type GateCheck = z.infer<typeof gateCheckSchema>;
type GateResult = z.infer<typeof gateResultSchema>;

const sharedChecks: GateCheck[] = [
  {
    id: "static-validation",
    title: "Static project validation passes",
    category: "build",
    required: true,
    severity: "critical",
    recommendedTools: ["validate_project", "run_build"],
    evidenceTypes: ["command", "report"],
    expectedEvidence: "Passing static validation or build output with no blocking errors."
  },
  {
    id: "browser-smoke",
    title: "Primary browser smoke flow is usable",
    category: "browser",
    required: true,
    severity: "high",
    recommendedTools: ["inspect_webpage", "run_smoke_flow"],
    evidenceTypes: ["screenshot", "report", "url"],
    expectedEvidence: "Browser smoke report or screenshot showing the primary user flow renders and works."
  },
  {
    id: "console-clean",
    title: "No blocking console or network errors",
    category: "browser",
    required: true,
    severity: "high",
    recommendedTools: ["browser_console_log", "browser_network_trace", "inspect_webpage_plus"],
    evidenceTypes: ["report"],
    expectedEvidence: "Console/network inspection with no blocking errors."
  }
];

const presetChecks: Record<QualityGatePreset, GateCheck[]> = {
  demo: [
    ...sharedChecks,
    {
      id: "demo-content-ready",
      title: "Demo content is coherent and polished",
      category: "content",
      required: true,
      severity: "medium",
      recommendedTools: ["analyze_webpage_visual", "inspect_webpage"],
      evidenceTypes: ["screenshot", "manual_note"],
      expectedEvidence: "Visual/content review confirming no placeholder copy, broken layout, or obvious unfinished state."
    }
  ],
  production: [
    ...sharedChecks,
    {
      id: "release-readiness",
      title: "Release record and rollback path are ready",
      category: "security",
      required: true,
      severity: "critical",
      recommendedTools: ["compare_before_release", "create_rollback_point", "create_release_record"],
      evidenceTypes: ["artifact", "report"],
      expectedEvidence: "Release comparison, release record, and rollback point artifacts."
    },
    {
      id: "audit-trace",
      title: "Delivery audit and requirement evidence are recorded",
      category: "security",
      required: true,
      severity: "high",
      recommendedTools: ["record_delivery_audit", "create_requirements_traceability_matrix"],
      evidenceTypes: ["artifact", "report"],
      expectedEvidence: "Audit event and requirements traceability report linked to completed work."
    }
  ],
  pwa: [
    ...sharedChecks,
    {
      id: "pwa-audit",
      title: "PWA installability and offline readiness pass",
      category: "pwa",
      required: true,
      severity: "critical",
      recommendedTools: ["audit_project_pwa"],
      evidenceTypes: ["report"],
      expectedEvidence: "PWA audit with manifest, service worker, icons, theme color, and offline readiness passing."
    }
  ],
  mobile: [
    ...sharedChecks,
    {
      id: "mobile-viewports",
      title: "Mobile and tablet viewports render without overlap",
      category: "mobile",
      required: true,
      severity: "critical",
      recommendedTools: ["inspect_webpage_multibrowser", "capture_webpage", "analyze_webpage_visual"],
      evidenceTypes: ["screenshot", "report"],
      expectedEvidence: "Mobile/tablet screenshots or reports showing stable layout, readable text, and touchable controls."
    }
  ],
  accessibility: [
    ...sharedChecks,
    {
      id: "a11y-audit",
      title: "Accessibility audit has no critical violations",
      category: "accessibility",
      required: true,
      severity: "critical",
      recommendedTools: ["audit_accessibility", "run_a11y_audit_detailed"],
      evidenceTypes: ["report"],
      expectedEvidence: "Accessibility report with no critical violations and reviewed warnings."
    }
  ],
  data_app: [
    ...sharedChecks,
    {
      id: "data-quality",
      title: "Data quality and metric assumptions are profiled",
      category: "data",
      required: true,
      severity: "critical",
      recommendedTools: ["profile_dataset_quality", "export_data_analysis_report"],
      evidenceTypes: ["artifact", "report"],
      expectedEvidence: "Data quality profile, metric assumptions, and limitations recorded."
    },
    {
      id: "data-visuals",
      title: "Charts or tables match the intended analytical question",
      category: "data",
      required: true,
      severity: "high",
      recommendedTools: ["create_dataset_chart_spec", "export_data_analysis_report"],
      evidenceTypes: ["artifact", "manual_note"],
      expectedEvidence: "Chart/table spec with dimensions, measures, and interpretation aligned to the question."
    }
  ],
  game: [
    ...sharedChecks,
    {
      id: "game-loop",
      title: "Core game loop and controls are verified",
      category: "game",
      required: true,
      severity: "critical",
      recommendedTools: ["create_game_loop_qa_plan", "run_smoke_flow"],
      evidenceTypes: ["report", "screenshot"],
      expectedEvidence: "QA plan or smoke evidence for start, play, scoring/progress, failure/restart, and controls."
    },
    {
      id: "game-performance",
      title: "Game performance budget is reviewed",
      category: "performance",
      required: true,
      severity: "high",
      recommendedTools: ["profile_game_performance_budget"],
      evidenceTypes: ["artifact", "report"],
      expectedEvidence: "Performance budget profile with frame/rendering risks and limits."
    }
  ]
};

function checksForPreset(preset: QualityGatePreset, strictness: "quick" | "standard" | "strict", extraChecks: GateCheck[] = []) {
  const checks = presetChecks[preset];
  const selected = strictness === "quick"
    ? checks.filter((check) => check.required && (check.severity === "critical" || check.id === "browser-smoke"))
    : checks;
  const strictAdditions: GateCheck[] = strictness === "strict"
    ? [{
      id: "evidence-complete",
      title: "Every required check has reviewable evidence",
      category: "security",
      required: true,
      severity: "high",
      recommendedTools: ["record_project_task_evidence", "record_delivery_audit"],
      evidenceTypes: ["artifact", "report", "manual_note"],
      expectedEvidence: "Each required quality gate check has attached command output, report, screenshot, artifact, URL, or reviewer note."
    }]
    : [];
  const byId = new Map<string, GateCheck>();
  for (const check of [...selected, ...strictAdditions, ...extraChecks]) byId.set(check.id, check);
  return [...byId.values()];
}

function evaluateChecks(checks: GateCheck[], results: GateResult[]) {
  const resultById = new Map(results.map((result) => [result.checkId, result]));
  const rows = checks.map((check) => {
    const result = resultById.get(check.id);
    const status = result?.status ?? "not_run";
    const hasEvidence = Boolean(result?.evidence.length);
    const blocksRelease = check.required && (status === "failed" || status === "not_run" || (status === "skipped" && check.severity !== "low"));
    return {
      check,
      status,
      evidence: result?.evidence ?? [],
      note: result?.note,
      hasEvidence,
      blocksRelease
    };
  });
  const blocking = rows.filter((row) => row.blocksRelease);
  const warnings = rows.filter((row) => row.status === "warning" || (row.check.required && !row.hasEvidence));
  return {
    ok: blocking.length === 0,
    status: blocking.length ? "blocked" : warnings.length ? "passed_with_warnings" : "passed",
    totalChecks: checks.length,
    requiredChecks: checks.filter((check) => check.required).length,
    passedChecks: rows.filter((row) => row.status === "passed").length,
    blockingCheckIds: blocking.map((row) => row.check.id),
    warningCheckIds: warnings.map((row) => row.check.id),
    rows,
    nextActions: blocking.length
      ? blocking.map((row) => `Resolve ${row.check.id}: ${row.check.expectedEvidence}`)
      : warnings.length
        ? warnings.map((row) => `Add or review evidence for ${row.check.id}.`)
        : ["Proceed with delivery or release handoff."]
  };
}

function renderRunbook(preset: QualityGatePreset, checks: GateCheck[]) {
  return [
    `# ${preset} Quality Gate Runbook`,
    "",
    "## Checks",
    ...checks.flatMap((check, index) => [
      "",
      `### ${index + 1}. ${check.title}`,
      "",
      `- ID: ${check.id}`,
      `- Required: ${check.required ? "yes" : "no"}`,
      `- Severity: ${check.severity}`,
      `- Recommended tools: ${check.recommendedTools.join(", ")}`,
      `- Expected evidence: ${check.expectedEvidence}`
    ]),
    ""
  ].join("\n");
}

function renderReport(title: string, preset: QualityGatePreset, evaluation: Record<string, unknown>) {
  return [
    `# ${title}`,
    "",
    `Preset: ${preset}`,
    "",
    "## Evaluation",
    "```json",
    JSON.stringify(evaluation, null, 2),
    "```",
    ""
  ].join("\n");
}

export const qualityGateTools: ToolModule[] = [
  {
    definition: {
      name: "list_quality_gate_presets",
      description: "List reusable quality gate presets for demo, production, PWA, mobile, accessibility, data app, and game projects.",
      inputSchema: { type: "object", properties: { preset: { type: "string" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listQualityGatePresetsInputSchema,
    handler: (input) => {
      const parsed = listQualityGatePresetsInputSchema.parse(input);
      const presets = (parsed.preset ? [parsed.preset] : Object.keys(presetChecks) as QualityGatePreset[]).map((preset) => ({ preset, checks: presetChecks[preset] }));
      return { ok: true, summary: `Found ${presets.length} quality gate preset(s).`, artifacts: [], structuredContent: { presets }, logs: [JSON.stringify(presets, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "create_quality_gate_plan",
      description: "Create a project-local quality gate plan from a preset with required checks, recommended tools, evidence expectations, and optional extra checks.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, preset: { type: "string" }, strictness: { type: "string" }, extraChecks: { type: "array" }, outputPath: { type: "string" } }, required: ["projectId", "preset"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createQualityGatePlanInputSchema,
    handler: async (input, ctx) => {
      const parsed = createQualityGatePlanInputSchema.parse(input);
      const checks = checksForPreset(parsed.preset, parsed.strictness, parsed.extraChecks);
      const plan = { preset: parsed.preset, strictness: parsed.strictness, createdAt: new Date().toISOString(), checks };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(plan, null, 2)}\n`);
      return { ok: true, summary: `Created ${parsed.preset} quality gate plan with ${checks.length} check(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: plan, logs: [JSON.stringify(plan, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "evaluate_quality_gate_results",
      description: "Evaluate collected quality gate results against a preset and identify blocking checks, warning checks, missing evidence, and next actions.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, preset: { type: "string" }, results: { type: "array" }, strictness: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "preset"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: evaluateQualityGateInputSchema,
    handler: async (input, ctx) => {
      const parsed = evaluateQualityGateInputSchema.parse(input);
      const checks = checksForPreset(parsed.preset, parsed.strictness);
      const evaluation = { preset: parsed.preset, strictness: parsed.strictness, evaluatedAt: new Date().toISOString(), ...evaluateChecks(checks, parsed.results) };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(evaluation, null, 2)}\n`);
      return { ok: evaluation.ok, summary: `Quality gate ${evaluation.status}: ${evaluation.blockingCheckIds.length} blocking check(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: evaluation, logs: [JSON.stringify(evaluation, null, 2)], errors: evaluation.blockingCheckIds };
    }
  },
  {
    definition: {
      name: "create_quality_gate_runbook",
      description: "Create a Markdown runbook for executing a quality gate preset, including check order, recommended tools, and expected evidence.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, preset: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "preset"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createQualityGateRunbookInputSchema,
    handler: async (input, ctx) => {
      const parsed = createQualityGateRunbookInputSchema.parse(input);
      const markdown = renderRunbook(parsed.preset, checksForPreset(parsed.preset, "standard"));
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown);
      return { ok: true, summary: `Created ${parsed.preset} quality gate runbook.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { path: file.path, markdown }, logs: [markdown], errors: [] };
    }
  },
  {
    definition: {
      name: "compare_quality_gate_presets",
      description: "Compare quality gate presets by check count, required checks, categories, severity mix, and recommended tools.",
      inputSchema: { type: "object", properties: { presets: { type: "array", items: { type: "string" } } }, required: ["presets"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: compareQualityGatePresetsInputSchema,
    handler: (input) => {
      const parsed = compareQualityGatePresetsInputSchema.parse(input);
      const comparison = parsed.presets.map((preset) => {
        const checks = checksForPreset(preset, "standard");
        return {
          preset,
          checkCount: checks.length,
          requiredCount: checks.filter((check) => check.required).length,
          categories: [...new Set(checks.map((check) => check.category))].sort(),
          criticalChecks: checks.filter((check) => check.severity === "critical").map((check) => check.id),
          recommendedTools: [...new Set(checks.flatMap((check) => check.recommendedTools))].sort()
        };
      });
      return { ok: true, summary: `Compared ${comparison.length} quality gate preset(s).`, artifacts: [], structuredContent: { comparison }, logs: [JSON.stringify(comparison, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "export_quality_gate_report",
      description: "Export a Markdown quality gate report from an evaluation payload for review or release handoff.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, preset: { type: "string" }, evaluation: { type: "object" }, outputPath: { type: "string" } }, required: ["projectId", "preset"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportQualityGateReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportQualityGateReportInputSchema.parse(input);
      const markdown = renderReport(parsed.title, parsed.preset, parsed.evaluation);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown);
      return { ok: true, summary: `Exported ${parsed.preset} quality gate report.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { path: file.path, markdown }, logs: [markdown], errors: [] };
    }
  }
];
