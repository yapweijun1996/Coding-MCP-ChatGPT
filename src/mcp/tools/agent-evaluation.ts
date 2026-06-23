import { z } from "zod";
import { writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const criterionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  label: z.string().min(1).max(160),
  weight: z.number().min(0).max(100).optional().default(1),
  passingScore: z.number().min(0).max(100).optional().default(80),
  requiredSignals: z.array(z.string().min(1).max(160)).max(30).optional().default([]),
  negativeSignals: z.array(z.string().min(1).max(160)).max(30).optional().default([])
});

const requirementSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  text: z.string().min(1).max(1000),
  priority: z.enum(["must", "should", "could"]).optional().default("must"),
  evidenceRequired: z.boolean().optional().default(true)
});

const evaluationRubricInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160),
  criteria: z.array(criterionSchema).min(1).max(100),
  outputPath: z.string().min(1).max(240).optional().default("agent-evaluation/rubric.json")
});

const scoreAgentOutputInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  title: z.string().min(1).max(160).optional().default("Agent Output Evaluation"),
  finalOutput: z.string().min(1).max(120000),
  evidence: z.array(z.string().min(1).max(2000)).max(100).optional().default([]),
  criteria: z.array(criterionSchema).min(1).max(100),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("agent-evaluation/output-score.json")
});

const evaluateRequirementSatisfactionInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  requirements: z.array(requirementSchema).min(1).max(200),
  finalOutput: z.string().min(1).max(120000),
  evidence: z.array(z.string().min(1).max(2000)).max(100).optional().default([]),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("agent-evaluation/requirement-satisfaction.json")
});

const compareAgentOutputVersionsInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  baseline: z.object({
    label: z.string().min(1).max(120),
    score: z.number().min(0).max(100),
    summary: z.string().min(1).max(1000),
    findings: z.array(z.string().min(1).max(500)).max(100).optional().default([])
  }),
  candidate: z.object({
    label: z.string().min(1).max(120),
    score: z.number().min(0).max(100),
    summary: z.string().min(1).max(1000),
    findings: z.array(z.string().min(1).max(500)).max(100).optional().default([])
  }),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("agent-evaluation/version-comparison.json")
});

const detectAgentRegressionsInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  baselineChecks: z.array(z.object({
    id: z.string().min(1).max(120),
    status: z.enum(["pass", "fail", "unknown"]),
    detail: z.string().max(500).optional().default("")
  })).min(1).max(200),
  candidateChecks: z.array(z.object({
    id: z.string().min(1).max(120),
    status: z.enum(["pass", "fail", "unknown"]),
    detail: z.string().max(500).optional().default("")
  })).min(1).max(200),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("agent-evaluation/regressions.json")
});

const exportAgentEvaluationReportInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160),
  outputScore: z.record(z.string(), z.unknown()).optional().default({}),
  requirementSatisfaction: z.record(z.string(), z.unknown()).optional().default({}),
  versionComparison: z.record(z.string(), z.unknown()).optional().default({}),
  regressions: z.record(z.string(), z.unknown()).optional().default({}),
  recommendations: z.array(z.string().min(1).max(500)).max(100).optional().default([]),
  outputPath: z.string().min(1).max(240).optional().default("agent-evaluation/evaluation-report.md")
});

function normalizedText(parts: string[]) {
  return parts.join("\n").toLowerCase();
}

function signalPresent(haystack: string, signal: string) {
  return haystack.includes(signal.toLowerCase());
}

function scoreCriterion(criterion: z.infer<typeof criterionSchema>, finalOutput: string, evidence: string[]) {
  const text = normalizedText([finalOutput, ...evidence]);
  const required = criterion.requiredSignals;
  const negative = criterion.negativeSignals;
  const matchedRequired = required.filter((signal) => signalPresent(text, signal));
  const matchedNegative = negative.filter((signal) => signalPresent(text, signal));
  const base = required.length ? (matchedRequired.length / required.length) * 100 : 80;
  const penalty = matchedNegative.length * 15;
  const score = Math.max(0, Math.min(100, Math.round(base - penalty)));
  return {
    id: criterion.id,
    label: criterion.label,
    weight: criterion.weight,
    passingScore: criterion.passingScore,
    score,
    passed: score >= criterion.passingScore,
    matchedRequired,
    missingRequired: required.filter((signal) => !matchedRequired.includes(signal)),
    matchedNegative
  };
}

function weightedScore(items: Array<{ score: number; weight: number }>) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight === 0) return 0;
  return Math.round(items.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight);
}

function requirementSignals(requirement: string) {
  return requirement
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4)
    .slice(0, 12);
}

function evaluateRequirement(requirement: z.infer<typeof requirementSchema>, finalOutput: string, evidence: string[]) {
  const text = normalizedText([finalOutput, ...evidence]);
  const signals = requirementSignals(requirement.text);
  const matched = signals.filter((signal) => text.includes(signal));
  const textScore = signals.length ? Math.round((matched.length / signals.length) * 100) : 100;
  const evidenceScore = requirement.evidenceRequired ? (evidence.some((item) => item.toLowerCase().includes(requirement.id.toLowerCase()) || matched.some((signal) => item.toLowerCase().includes(signal))) ? 100 : 40) : 100;
  const score = Math.round(textScore * 0.7 + evidenceScore * 0.3);
  const satisfied = requirement.priority === "must" ? score >= 80 : requirement.priority === "should" ? score >= 70 : score >= 50;
  return { ...requirement, score, satisfied, matchedSignals: matched, missingSignals: signals.filter((signal) => !matched.includes(signal)) };
}

async function maybeWrite(projectRoot: string, projectId: string | undefined, write: boolean, outputPath: string, payload: unknown) {
  if (!projectId || !write) return undefined;
  return writeProjectFile(projectRoot, projectId, outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

export const agentEvaluationTools: ToolModule[] = [
  {
    definition: {
      name: "create_agent_evaluation_rubric",
      description: "Create a project-local rubric for scoring agent final output quality with weighted criteria and required/negative signals.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, criteria: { type: "array" }, outputPath: { type: "string" } }, required: ["projectId", "title", "criteria"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: evaluationRubricInputSchema,
    handler: async (input, ctx) => {
      const parsed = evaluationRubricInputSchema.parse(input);
      const rubric = { title: parsed.title, criteria: parsed.criteria, createdAt: new Date().toISOString() };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(rubric, null, 2)}\n`);
      return { ok: true, summary: `Created agent evaluation rubric with ${parsed.criteria.length} criterion/criteria.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: rubric, logs: [JSON.stringify(rubric, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "score_agent_output",
      description: "Score final agent output against a weighted rubric using required evidence signals and negative regression signals.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, finalOutput: { type: "string" }, evidence: { type: "array", items: { type: "string" } }, criteria: { type: "array" }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["finalOutput", "criteria"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: scoreAgentOutputInputSchema,
    handler: async (input, ctx) => {
      const parsed = scoreAgentOutputInputSchema.parse(input);
      const criteriaResults = parsed.criteria.map((criterion) => scoreCriterion(criterion, parsed.finalOutput, parsed.evidence));
      const overallScore = weightedScore(criteriaResults);
      const result = { title: parsed.title, overallScore, passed: criteriaResults.every((item) => item.passed), criteriaResults, evaluatedAt: new Date().toISOString() };
      const file = await maybeWrite(ctx.projectRoot, parsed.projectId, parsed.writeToProject, parsed.outputPath, result);
      return { ok: result.passed, summary: `Agent output score: ${overallScore}/100 (${result.passed ? "passed" : "failed"}).`, jobId: parsed.projectId, artifacts: file ? [file.path] : [], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: result.passed ? [] : criteriaResults.filter((item) => !item.passed).map((item) => `${item.id} scored ${item.score}, below ${item.passingScore}.`) };
    }
  },
  {
    definition: {
      name: "evaluate_requirement_satisfaction",
      description: "Measure whether user requirements are satisfied by final output and supporting evidence.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, requirements: { type: "array" }, finalOutput: { type: "string" }, evidence: { type: "array", items: { type: "string" } }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["requirements", "finalOutput"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: evaluateRequirementSatisfactionInputSchema,
    handler: async (input, ctx) => {
      const parsed = evaluateRequirementSatisfactionInputSchema.parse(input);
      const requirements = parsed.requirements.map((requirement) => evaluateRequirement(requirement, parsed.finalOutput, parsed.evidence));
      const mustFailures = requirements.filter((item) => item.priority === "must" && !item.satisfied);
      const result = { ok: mustFailures.length === 0, satisfiedCount: requirements.filter((item) => item.satisfied).length, totalCount: requirements.length, requirements, mustFailures };
      const file = await maybeWrite(ctx.projectRoot, parsed.projectId, parsed.writeToProject, parsed.outputPath, result);
      return { ok: result.ok, summary: `${result.satisfiedCount}/${result.totalCount} requirement(s) satisfied; ${mustFailures.length} must-failure(s).`, jobId: parsed.projectId, artifacts: file ? [file.path] : [], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: mustFailures.map((item) => `${item.id} not satisfied.`) };
    }
  },
  {
    definition: {
      name: "compare_agent_output_versions",
      description: "Compare baseline and candidate agent outputs using scores and findings, highlighting improvements and regressions.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, baseline: { type: "object" }, candidate: { type: "object" }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["baseline", "candidate"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: compareAgentOutputVersionsInputSchema,
    handler: async (input, ctx) => {
      const parsed = compareAgentOutputVersionsInputSchema.parse(input);
      const delta = Math.round(parsed.candidate.score - parsed.baseline.score);
      const baselineFindings = new Set(parsed.baseline.findings);
      const candidateFindings = new Set(parsed.candidate.findings);
      const resolvedFindings = parsed.baseline.findings.filter((finding) => !candidateFindings.has(finding));
      const newFindings = parsed.candidate.findings.filter((finding) => !baselineFindings.has(finding));
      const result = { baseline: parsed.baseline, candidate: parsed.candidate, delta, decision: delta > 0 && newFindings.length === 0 ? "candidate_better" : delta < 0 || newFindings.length > resolvedFindings.length ? "candidate_regressed" : "mixed_or_equivalent", resolvedFindings, newFindings };
      const file = await maybeWrite(ctx.projectRoot, parsed.projectId, parsed.writeToProject, parsed.outputPath, result);
      return { ok: result.decision !== "candidate_regressed", summary: `Version comparison: ${result.decision} (${delta >= 0 ? "+" : ""}${delta} points).`, jobId: parsed.projectId, artifacts: file ? [file.path] : [], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: result.decision === "candidate_regressed" ? newFindings : [] };
    }
  },
  {
    definition: {
      name: "detect_agent_regressions",
      description: "Detect regressions by comparing baseline and candidate check statuses.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, baselineChecks: { type: "array" }, candidateChecks: { type: "array" }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["baselineChecks", "candidateChecks"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: detectAgentRegressionsInputSchema,
    handler: async (input, ctx) => {
      const parsed = detectAgentRegressionsInputSchema.parse(input);
      const candidateById = new Map(parsed.candidateChecks.map((check) => [check.id, check]));
      type Check = (typeof parsed.baselineChecks)[number];
      const regressions: Array<{ id: string; type: "missing_check" | "pass_to_nonpass"; baseline: Check; candidate: Check | null }> = [];
      for (const baseline of parsed.baselineChecks) {
        const candidate = candidateById.get(baseline.id);
        if (!candidate) {
          regressions.push({ id: baseline.id, type: "missing_check", baseline, candidate: null });
        } else if (baseline.status === "pass" && candidate.status !== "pass") {
          regressions.push({ id: baseline.id, type: "pass_to_nonpass", baseline, candidate });
        }
      }
      const newPasses = parsed.candidateChecks.filter((candidate) => candidate.status === "pass" && parsed.baselineChecks.find((baseline) => baseline.id === candidate.id)?.status !== "pass");
      const result = { ok: regressions.length === 0, regressionCount: regressions.length, regressions, newPasses, checkedAt: new Date().toISOString() };
      const file = await maybeWrite(ctx.projectRoot, parsed.projectId, parsed.writeToProject, parsed.outputPath, result);
      return { ok: result.ok, summary: result.ok ? `No regressions detected across ${parsed.baselineChecks.length} baseline check(s).` : `Detected ${regressions.length} regression(s).`, jobId: parsed.projectId, artifacts: file ? [file.path] : [], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: regressions.map((item) => `${item.id}: ${item.type}`) };
    }
  },
  {
    definition: {
      name: "export_agent_evaluation_report",
      description: "Export a Markdown agent evaluation report with output score, requirement satisfaction, version comparison, regressions, and recommendations.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, outputScore: { type: "object" }, requirementSatisfaction: { type: "object" }, versionComparison: { type: "object" }, regressions: { type: "object" }, recommendations: { type: "array", items: { type: "string" } }, outputPath: { type: "string" } }, required: ["projectId", "title"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportAgentEvaluationReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportAgentEvaluationReportInputSchema.parse(input);
      const markdown = [`# ${parsed.title}`, "", "## Recommendations", ...(parsed.recommendations.length ? parsed.recommendations.map((item) => `- ${item}`) : ["- No recommendations recorded."]), "", "## Output Score", "```json", JSON.stringify(parsed.outputScore, null, 2), "```", "", "## Requirement Satisfaction", "```json", JSON.stringify(parsed.requirementSatisfaction, null, 2), "```", "", "## Version Comparison", "```json", JSON.stringify(parsed.versionComparison, null, 2), "```", "", "## Regressions", "```json", JSON.stringify(parsed.regressions, null, 2), "```", ""].join("\n");
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown);
      return { ok: true, summary: `Exported agent evaluation report to ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { report: markdown }, logs: [markdown], errors: [] };
    }
  }
];
