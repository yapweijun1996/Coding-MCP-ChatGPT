import { z } from "zod";
import { writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const testKindSchema = z.enum(["unit", "smoke", "browser", "api", "regression", "coverage"]);

const testTargetSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  kind: testKindSchema,
  title: z.string().min(1).max(160),
  subject: z.string().min(1).max(240),
  risk: z.enum(["low", "medium", "high"]).optional().default("medium"),
  expectedBehavior: z.string().min(1).max(500),
  selectors: z.array(z.string().min(1).max(160)).max(30).optional().default([]),
  apiEndpoint: z.string().min(1).max(300).optional()
});

const testCaseSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  kind: testKindSchema,
  title: z.string().min(1).max(160),
  setup: z.array(z.string().min(1).max(300)).max(30).optional().default([]),
  steps: z.array(z.string().min(1).max(300)).min(1).max(60),
  assertions: z.array(z.string().min(1).max(300)).min(1).max(60),
  data: z.record(z.string(), z.unknown()).optional().default({})
});

const createTestAutomationPlanInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160),
  framework: z.enum(["node-test", "vitest", "jest", "playwright", "cypress", "mixed", "unknown"]).optional().default("unknown"),
  targets: z.array(testTargetSchema).min(1).max(200),
  coverageThreshold: z.number().min(0).max(100).optional().default(80),
  outputPath: z.string().min(1).max(240).optional().default("test-automation/test-plan.json")
});

const generateTestCaseSpecInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  target: testTargetSchema,
  framework: z.enum(["node-test", "vitest", "jest", "playwright", "cypress", "api-contract"]).optional().default("node-test"),
  outputPath: z.string().min(1).max(240).optional()
});

const createTestRunMatrixInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  suites: z.array(z.object({
    name: z.string().min(1).max(120),
    kind: testKindSchema,
    command: z.string().min(1).max(240).optional(),
    mcpTool: z.enum(["run_tests", "run_project_npm_command", "run_smoke_flow", "run_visual_regression_snapshot", "api_contract_test", "audit_accessibility"]).optional(),
    required: z.boolean().optional().default(true),
    timeoutMs: z.number().int().min(1000).max(600000).optional().default(120000)
  })).min(1).max(80),
  stopOnFailure: z.boolean().optional().default(true),
  outputPath: z.string().min(1).max(240).optional().default("test-automation/run-matrix.json")
});

const explainTestResultsInputSchema = z.object({
  title: z.string().min(1).max(160).optional().default("Test Results"),
  logs: z.string().min(1).max(120000),
  expectedSuites: z.array(z.string().min(1).max(120)).max(100).optional().default([])
});

const createCoverageReportInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  summary: z.object({
    statements: z.number().min(0).max(100).optional(),
    branches: z.number().min(0).max(100).optional(),
    functions: z.number().min(0).max(100).optional(),
    lines: z.number().min(0).max(100).optional()
  }),
  thresholds: z.object({
    statements: z.number().min(0).max(100).optional(),
    branches: z.number().min(0).max(100).optional(),
    functions: z.number().min(0).max(100).optional(),
    lines: z.number().min(0).max(100).optional()
  }).optional().default({}),
  files: z.array(z.object({
    path: z.string().min(1).max(300),
    lines: z.number().min(0).max(100),
    uncoveredLines: z.array(z.number().int().min(1)).max(500).optional().default([])
  })).max(200).optional().default([]),
  outputPath: z.string().min(1).max(240).optional().default("test-automation/coverage-report.json")
});

const exportTestAutomationReportInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160),
  plan: z.record(z.string(), z.unknown()).optional().default({}),
  runMatrix: z.record(z.string(), z.unknown()).optional().default({}),
  resultExplanation: z.record(z.string(), z.unknown()).optional().default({}),
  coverage: z.record(z.string(), z.unknown()).optional().default({}),
  recommendations: z.array(z.string().min(1).max(500)).max(100).optional().default([]),
  outputPath: z.string().min(1).max(240).optional().default("test-automation/test-automation-report.md")
});

function recommendTool(kind: z.infer<typeof testKindSchema>) {
  if (kind === "browser" || kind === "smoke") return "run_smoke_flow";
  if (kind === "regression") return "run_visual_regression_snapshot";
  if (kind === "api") return "api_contract_test";
  if (kind === "coverage") return "run_tests";
  return "run_tests";
}

function createCase(target: z.infer<typeof testTargetSchema>, framework: string): z.infer<typeof testCaseSchema> {
  const setup = [`Use ${framework} for ${target.kind} coverage.`, `Prepare subject: ${target.subject}.`];
  const steps = target.kind === "api"
    ? [`Call ${target.apiEndpoint ?? target.subject}.`, "Capture status, headers, and response body."]
    : target.kind === "browser" || target.kind === "smoke"
      ? [`Open the relevant page for ${target.subject}.`, ...target.selectors.map((selector) => `Interact with or inspect ${selector}.`)]
      : [`Exercise ${target.subject}.`];
  const assertions = target.kind === "coverage"
    ? [`Coverage for ${target.subject} meets the project threshold.`]
    : [target.expectedBehavior, "No unexpected errors are reported."];
  return {
    id: `${target.id}_${target.kind}`,
    kind: target.kind,
    title: target.title,
    setup,
    steps: steps.length ? steps : [`Exercise ${target.subject}.`],
    assertions,
    data: { risk: target.risk, recommendedMcpTool: recommendTool(target.kind) }
  };
}

function explainLogs(logs: string, expectedSuites: string[]) {
  const lines = logs.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const failedLines = lines.filter((line) => /\b(fail|failed|error|exception|timeout|not ok)\b/i.test(line)).slice(0, 50);
  const passedSignals = lines.filter((line) => /\b(pass|passed|ok|success|✓)\b/i.test(line)).slice(0, 50);
  const missingSuites = expectedSuites.filter((suite) => !logs.toLowerCase().includes(suite.toLowerCase()));
  const status = failedLines.length ? "failed" : missingSuites.length ? "incomplete" : "passed_or_no_failures_detected";
  const recommendations = [
    ...(failedLines.length ? ["Start with the first failing assertion or stack trace before broad refactors."] : []),
    ...(missingSuites.length ? [`Missing expected suite output: ${missingSuites.join(", ")}.`] : []),
    "Record the exact command and relevant log excerpt with the task evidence."
  ];
  return { status, failedLines, passedSignals, missingSuites, lineCount: lines.length, recommendations };
}

function coverageFindings(input: z.infer<typeof createCoverageReportInputSchema>) {
  const metrics = ["statements", "branches", "functions", "lines"] as const;
  const failures = metrics.flatMap((metric) => {
    const value = input.summary[metric];
    const threshold = input.thresholds[metric] ?? 80;
    return value !== undefined && value < threshold ? [`${metric} coverage ${value}% is below ${threshold}%.`] : [];
  });
  const weakestFiles = [...input.files].sort((a, b) => a.lines - b.lines).slice(0, 10);
  return { ok: failures.length === 0, failures, weakestFiles, summary: input.summary, thresholds: input.thresholds };
}

export const testAutomationTools: ToolModule[] = [
  {
    definition: {
      name: "create_test_automation_plan",
      description: "Create a project-local test automation plan covering unit, smoke, browser, API, regression, and coverage targets.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, framework: { type: "string" }, targets: { type: "array" }, coverageThreshold: { type: "number" }, outputPath: { type: "string" } }, required: ["projectId", "title", "targets"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createTestAutomationPlanInputSchema,
    handler: async (input, ctx) => {
      const parsed = createTestAutomationPlanInputSchema.parse(input);
      const cases = parsed.targets.map((target) => createCase(target, parsed.framework));
      const plan = { title: parsed.title, framework: parsed.framework, coverageThreshold: parsed.coverageThreshold, targets: parsed.targets, testCases: cases, runOrder: cases.map((testCase) => testCase.id), createdAt: new Date().toISOString() };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(plan, null, 2)}\n`);
      return { ok: true, summary: `Created test automation plan with ${cases.length} case(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: plan, logs: [JSON.stringify(plan, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "generate_test_case_spec",
      description: "Generate a reviewable test case spec for one unit, smoke, browser, API, regression, or coverage target.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, target: { type: "object" }, framework: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "target"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: generateTestCaseSpecInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateTestCaseSpecInputSchema.parse(input);
      const testCase = createCase(parsed.target, parsed.framework);
      const outputPath = parsed.outputPath ?? `test-automation/cases/${testCase.id}.json`;
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, outputPath, `${JSON.stringify(testCase, null, 2)}\n`);
      return { ok: true, summary: `Generated ${testCase.kind} test case spec ${testCase.id}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { testCase }, logs: [JSON.stringify(testCase, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "create_test_run_matrix",
      description: "Create a bounded test run matrix that maps suites to safe MCP tools or explicit commands for agent execution.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, suites: { type: "array" }, stopOnFailure: { type: "boolean" }, outputPath: { type: "string" } }, required: ["projectId", "suites"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createTestRunMatrixInputSchema,
    handler: async (input, ctx) => {
      const parsed = createTestRunMatrixInputSchema.parse(input);
      const matrix = {
        stopOnFailure: parsed.stopOnFailure,
        suites: parsed.suites.map((suite, index) => ({ ...suite, order: index + 1, mcpTool: suite.mcpTool ?? recommendTool(suite.kind) })),
        createdAt: new Date().toISOString()
      };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(matrix, null, 2)}\n`);
      return { ok: true, summary: `Created test run matrix with ${parsed.suites.length} suite(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: matrix, logs: [JSON.stringify(matrix, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "explain_test_results",
      description: "Explain test command output by extracting likely failures, missing suites, pass signals, and next debugging actions.",
      inputSchema: { type: "object", properties: { title: { type: "string" }, logs: { type: "string" }, expectedSuites: { type: "array", items: { type: "string" } } }, required: ["logs"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: explainTestResultsInputSchema,
    handler: (input) => {
      const parsed = explainTestResultsInputSchema.parse(input);
      const explanation = { title: parsed.title, ...explainLogs(parsed.logs, parsed.expectedSuites) };
      return { ok: explanation.status !== "failed", summary: `Test result explanation status: ${explanation.status}.`, artifacts: [], structuredContent: explanation, logs: [JSON.stringify(explanation, null, 2)], errors: explanation.failedLines };
    }
  },
  {
    definition: {
      name: "create_coverage_report",
      description: "Create a project-local coverage report with threshold checks, weakest files, uncovered lines, and recommendations.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, summary: { type: "object" }, thresholds: { type: "object" }, files: { type: "array" }, outputPath: { type: "string" } }, required: ["projectId", "summary"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createCoverageReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = createCoverageReportInputSchema.parse(input);
      const report = { ...coverageFindings(parsed), files: parsed.files, createdAt: new Date().toISOString() };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(report, null, 2)}\n`);
      return { ok: report.ok, summary: report.ok ? "Coverage thresholds passed." : `Coverage report has ${report.failures.length} threshold failure(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: report.failures };
    }
  },
  {
    definition: {
      name: "export_test_automation_report",
      description: "Export a Markdown test automation report with plan, run matrix, result explanation, coverage, and recommendations.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, plan: { type: "object" }, runMatrix: { type: "object" }, resultExplanation: { type: "object" }, coverage: { type: "object" }, recommendations: { type: "array", items: { type: "string" } }, outputPath: { type: "string" } }, required: ["projectId", "title"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportTestAutomationReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportTestAutomationReportInputSchema.parse(input);
      const markdown = [`# ${parsed.title}`, "", "## Recommendations", ...(parsed.recommendations.length ? parsed.recommendations.map((item) => `- ${item}`) : ["- No recommendations recorded."]), "", "## Plan", "```json", JSON.stringify(parsed.plan, null, 2), "```", "", "## Run Matrix", "```json", JSON.stringify(parsed.runMatrix, null, 2), "```", "", "## Result Explanation", "```json", JSON.stringify(parsed.resultExplanation, null, 2), "```", "", "## Coverage", "```json", JSON.stringify(parsed.coverage, null, 2), "```", ""].join("\n");
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown);
      return { ok: true, summary: `Exported test automation report to ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { report: markdown }, logs: [markdown], errors: [] };
    }
  }
];
