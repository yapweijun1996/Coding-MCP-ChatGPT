import { z } from "zod";
import { readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const manifestPathDefault = "requirements-tracking/requirements.json";

const requirementIdSchema = z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/);
const requirementStatusSchema = z.enum(["open", "in_progress", "satisfied", "blocked", "wontfix"]);
const requirementPrioritySchema = z.enum(["must", "should", "could"]);
const criterionStatusSchema = z.enum(["pending", "passed", "failed", "not_applicable"]);

const acceptanceCriterionSchema = z.object({
  id: z.string().min(1).max(80),
  text: z.string().min(1).max(1000),
  status: criterionStatusSchema.optional().default("pending")
});

const completedWorkSchema = z.object({
  label: z.string().min(1).max(300),
  taskId: z.string().max(120).optional(),
  filePath: z.string().max(300).optional(),
  note: z.string().max(1000).optional(),
  completedAt: z.string().datetime().optional()
});

const requirementEvidenceSchema = z.object({
  label: z.string().min(1).max(300),
  kind: z.enum(["validation", "inspect_report", "screenshot", "published_url", "changed_file", "artifact", "note", "test", "release", "audit"]).optional().default("note"),
  url: z.string().max(1000).optional(),
  artifact: z.string().max(300).optional(),
  filePath: z.string().max(300).optional(),
  taskId: z.string().max(120).optional(),
  note: z.string().max(1000).optional(),
  recordedAt: z.string().datetime().optional()
});

const requirementRecordSchema = z.object({
  id: requirementIdSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(3000).optional().default(""),
  priority: requirementPrioritySchema.optional().default("must"),
  status: requirementStatusSchema.optional().default("open"),
  source: z.string().max(500).optional(),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).max(100).optional().default([]),
  constraints: z.array(z.string().min(1).max(1000)).max(100).optional().default([]),
  completedWork: z.array(completedWorkSchema).max(300).optional().default([]),
  evidence: z.array(requirementEvidenceSchema).max(300).optional().default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

const upsertProjectRequirementInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  requirementId: requirementIdSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(3000).optional().default(""),
  priority: requirementPrioritySchema.optional().default("must"),
  status: requirementStatusSchema.optional().default("open"),
  source: z.string().max(500).optional(),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).max(100).optional().default([]),
  constraints: z.array(z.string().min(1).max(1000)).max(100).optional().default([]),
  manifestPath: z.string().min(1).max(240).optional().default(manifestPathDefault)
});

const listProjectRequirementsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  manifestPath: z.string().min(1).max(240).optional().default(manifestPathDefault),
  status: requirementStatusSchema.optional(),
  priority: requirementPrioritySchema.optional(),
  includeEvidence: z.boolean().optional().default(true)
});

const mapRequirementEvidenceInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  requirementId: requirementIdSchema,
  status: requirementStatusSchema.optional(),
  completedWork: z.array(completedWorkSchema).max(100).optional().default([]),
  evidence: z.array(requirementEvidenceSchema).max(100).optional().default([]),
  acceptanceCriteriaUpdates: z.array(z.object({
    id: z.string().min(1).max(80),
    status: criterionStatusSchema,
    text: z.string().min(1).max(1000).optional()
  })).max(100).optional().default([]),
  manifestPath: z.string().min(1).max(240).optional().default(manifestPathDefault)
});

const createRequirementsTraceabilityMatrixInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  manifestPath: z.string().min(1).max(240).optional().default(manifestPathDefault),
  outputPath: z.string().min(1).max(240).optional().default("requirements-tracking/traceability-matrix.json")
});

const summarizeRequirementsStatusInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  manifestPath: z.string().min(1).max(240).optional().default(manifestPathDefault)
});

const exportRequirementsReportInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  manifestPath: z.string().min(1).max(240).optional().default(manifestPathDefault),
  outputPath: z.string().min(1).max(240).optional().default("requirements-tracking/requirements-report.md")
});

type RequirementRecord = z.infer<typeof requirementRecordSchema>;

interface RequirementsManifest {
  version: 1;
  projectId: string;
  updatedAt: string;
  requirements: RequirementRecord[];
}

async function readRequirementsManifest(projectRoot: string, projectId: string, manifestPath: string): Promise<RequirementsManifest> {
  try {
    const raw = await readProjectFile(projectRoot, projectId, manifestPath, 1024 * 1024);
    const parsed = JSON.parse(raw) as Partial<RequirementsManifest>;
    if (parsed.version === 1 && Array.isArray(parsed.requirements)) {
      return {
        version: 1,
        projectId,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        requirements: parsed.requirements.map((requirement) => requirementRecordSchema.parse(requirement))
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/not found|ENOENT|no such file/i.test(message)) throw error;
  }
  return { version: 1, projectId, updatedAt: new Date().toISOString(), requirements: [] };
}

async function writeRequirementsManifest(projectRoot: string, projectId: string, manifestPath: string, requirements: RequirementRecord[]) {
  const payload: RequirementsManifest = {
    version: 1,
    projectId,
    updatedAt: new Date().toISOString(),
    requirements: requirements.sort((left, right) => left.id.localeCompare(right.id))
  };
  const file = await writeProjectFile(projectRoot, projectId, manifestPath, `${JSON.stringify(payload, null, 2)}\n`);
  return { payload, file };
}

function buildTraceabilityRows(requirements: RequirementRecord[]) {
  return requirements.map((requirement) => {
    const criteriaTotal = requirement.acceptanceCriteria.length;
    const criteriaPassed = requirement.acceptanceCriteria.filter((criterion) => criterion.status === "passed" || criterion.status === "not_applicable").length;
    const criteriaFailed = requirement.acceptanceCriteria.filter((criterion) => criterion.status === "failed").length;
    const criteriaPending = requirement.acceptanceCriteria.filter((criterion) => criterion.status === "pending").length;
    return {
      requirementId: requirement.id,
      title: requirement.title,
      priority: requirement.priority,
      status: requirement.status,
      acceptanceCriteriaTotal: criteriaTotal,
      acceptanceCriteriaPassed: criteriaPassed,
      acceptanceCriteriaFailed: criteriaFailed,
      acceptanceCriteriaPending: criteriaPending,
      allCriteriaResolved: criteriaTotal === 0 ? false : criteriaPending === 0 && criteriaFailed === 0,
      completedWorkCount: requirement.completedWork.length,
      evidenceCount: requirement.evidence.length,
      missingEvidence: requirement.evidence.length === 0,
      constraintsCount: requirement.constraints.length
    };
  });
}

function summarizeRequirements(requirements: RequirementRecord[]) {
  const byStatus = requirements.reduce<Record<string, number>>((acc, requirement) => {
    acc[requirement.status] = (acc[requirement.status] ?? 0) + 1;
    return acc;
  }, {});
  const byPriority = requirements.reduce<Record<string, number>>((acc, requirement) => {
    acc[requirement.priority] = (acc[requirement.priority] ?? 0) + 1;
    return acc;
  }, {});
  const missingEvidence = requirements.filter((requirement) => requirement.evidence.length === 0).map((requirement) => requirement.id);
  const unmetCriteria = requirements.flatMap((requirement) =>
    requirement.acceptanceCriteria
      .filter((criterion) => criterion.status === "pending" || criterion.status === "failed")
      .map((criterion) => ({ requirementId: requirement.id, criterionId: criterion.id, status: criterion.status, text: criterion.text }))
  );
  return {
    totalRequirements: requirements.length,
    byStatus,
    byPriority,
    missingEvidence,
    unmetCriteria,
    readyRequirementIds: requirements.filter((requirement) => requirement.status === "satisfied" && requirement.evidence.length > 0).map((requirement) => requirement.id)
  };
}

function renderRequirementsReport(requirements: RequirementRecord[]) {
  const summary = summarizeRequirements(requirements);
  const lines = [
    "# Requirements Traceability Report",
    "",
    `Total requirements: ${summary.totalRequirements}`,
    `Missing evidence: ${summary.missingEvidence.length}`,
    `Unmet criteria: ${summary.unmetCriteria.length}`,
    "",
    "## Requirements"
  ];
  for (const requirement of requirements) {
    lines.push(
      "",
      `### ${requirement.id}: ${requirement.title}`,
      "",
      `- Priority: ${requirement.priority}`,
      `- Status: ${requirement.status}`,
      `- Source: ${requirement.source ?? "not recorded"}`,
      `- Description: ${requirement.description || "not recorded"}`,
      "",
      "Acceptance criteria:",
      ...(requirement.acceptanceCriteria.length ? requirement.acceptanceCriteria.map((criterion) => `- [${criterion.status}] ${criterion.id}: ${criterion.text}`) : ["- not recorded"]),
      "",
      "Constraints:",
      ...(requirement.constraints.length ? requirement.constraints.map((constraint) => `- ${constraint}`) : ["- not recorded"]),
      "",
      "Completed work:",
      ...(requirement.completedWork.length ? requirement.completedWork.map((work) => `- ${work.label}${work.taskId ? ` (task: ${work.taskId})` : ""}${work.filePath ? ` [${work.filePath}]` : ""}`) : ["- not recorded"]),
      "",
      "Evidence:",
      ...(requirement.evidence.length ? requirement.evidence.map((evidence) => `- ${evidence.label} (${evidence.kind})${evidence.filePath ? ` [${evidence.filePath}]` : ""}${evidence.url ? ` ${evidence.url}` : ""}`) : ["- not recorded"])
    );
  }
  lines.push("");
  return lines.join("\n");
}

export const requirementsTrackingTools: ToolModule[] = [
  {
    definition: {
      name: "upsert_project_requirement",
      description: "Create or update a project-local requirement with user requirement text, acceptance criteria, constraints, priority, source, and status.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, requirementId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, priority: { type: "string" }, status: { type: "string" }, source: { type: "string" }, acceptanceCriteria: { type: "array" }, constraints: { type: "array", items: { type: "string" } }, manifestPath: { type: "string" } }, required: ["projectId", "requirementId", "title"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: upsertProjectRequirementInputSchema,
    handler: async (input, ctx) => {
      const parsed = upsertProjectRequirementInputSchema.parse(input);
      const manifest = await readRequirementsManifest(ctx.projectRoot, parsed.projectId, parsed.manifestPath);
      const existing = manifest.requirements.find((requirement) => requirement.id === parsed.requirementId);
      const now = new Date().toISOString();
      const requirement: RequirementRecord = {
        id: parsed.requirementId,
        title: parsed.title,
        description: parsed.description,
        priority: parsed.priority,
        status: parsed.status,
        source: parsed.source,
        acceptanceCriteria: parsed.acceptanceCriteria,
        constraints: parsed.constraints,
        completedWork: existing?.completedWork ?? [],
        evidence: existing?.evidence ?? [],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      const others = manifest.requirements.filter((item) => item.id !== parsed.requirementId);
      const { payload, file } = await writeRequirementsManifest(ctx.projectRoot, parsed.projectId, parsed.manifestPath, [requirement, ...others]);
      return { ok: true, summary: `${existing ? "Updated" : "Created"} requirement ${parsed.requirementId}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { requirement, requirementCount: payload.requirements.length }, logs: [JSON.stringify(requirement, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "list_project_requirements",
      description: "List project requirements with optional status/priority filters and optional evidence details.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, manifestPath: { type: "string" }, status: { type: "string" }, priority: { type: "string" }, includeEvidence: { type: "boolean" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listProjectRequirementsInputSchema,
    handler: async (input, ctx) => {
      const parsed = listProjectRequirementsInputSchema.parse(input);
      const manifest = await readRequirementsManifest(ctx.projectRoot, parsed.projectId, parsed.manifestPath);
      const requirements = manifest.requirements
        .filter((requirement) => !parsed.status || requirement.status === parsed.status)
        .filter((requirement) => !parsed.priority || requirement.priority === parsed.priority)
        .map((requirement) => parsed.includeEvidence ? requirement : { ...requirement, evidence: [], completedWork: [] });
      return { ok: true, summary: `Found ${requirements.length} requirement(s).`, jobId: parsed.projectId, artifacts: [], structuredContent: { requirements, totalCount: manifest.requirements.length }, logs: requirements.map((requirement) => `${requirement.id} ${requirement.status}: ${requirement.title}`), errors: [] };
    }
  },
  {
    definition: {
      name: "map_requirement_evidence",
      description: "Map completed work, files, tests, artifacts, URLs, notes, and acceptance-criteria status updates to a stored requirement.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, requirementId: { type: "string" }, status: { type: "string" }, completedWork: { type: "array" }, evidence: { type: "array" }, acceptanceCriteriaUpdates: { type: "array" }, manifestPath: { type: "string" } }, required: ["projectId", "requirementId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: mapRequirementEvidenceInputSchema,
    handler: async (input, ctx) => {
      const parsed = mapRequirementEvidenceInputSchema.parse(input);
      const manifest = await readRequirementsManifest(ctx.projectRoot, parsed.projectId, parsed.manifestPath);
      const existing = manifest.requirements.find((requirement) => requirement.id === parsed.requirementId);
      if (!existing) {
        return { ok: false, summary: `Requirement ${parsed.requirementId} was not found.`, jobId: parsed.projectId, artifacts: [], logs: [], errors: [`Requirement ${parsed.requirementId} does not exist.`] };
      }
      const now = new Date().toISOString();
      const updateById = new Map(parsed.acceptanceCriteriaUpdates.map((criterion) => [criterion.id, criterion]));
      const acceptanceCriteria = existing.acceptanceCriteria.map((criterion) => {
        const update = updateById.get(criterion.id);
        return update ? { ...criterion, text: update.text ?? criterion.text, status: update.status } : criterion;
      });
      for (const update of parsed.acceptanceCriteriaUpdates) {
        if (!acceptanceCriteria.some((criterion) => criterion.id === update.id)) {
          acceptanceCriteria.push({ id: update.id, text: update.text ?? update.id, status: update.status });
        }
      }
      const requirement: RequirementRecord = {
        ...existing,
        status: parsed.status ?? existing.status,
        acceptanceCriteria,
        completedWork: [...existing.completedWork, ...parsed.completedWork.map((work) => ({ ...work, completedAt: work.completedAt ?? now }))],
        evidence: [...existing.evidence, ...parsed.evidence.map((evidence) => ({ ...evidence, recordedAt: evidence.recordedAt ?? now }))],
        updatedAt: now
      };
      const others = manifest.requirements.filter((item) => item.id !== parsed.requirementId);
      const { file } = await writeRequirementsManifest(ctx.projectRoot, parsed.projectId, parsed.manifestPath, [requirement, ...others]);
      return { ok: true, summary: `Mapped ${parsed.completedWork.length} work item(s) and ${parsed.evidence.length} evidence link(s) to ${parsed.requirementId}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { requirement }, logs: [JSON.stringify(requirement, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "create_requirements_traceability_matrix",
      description: "Create a JSON traceability matrix mapping each requirement to acceptance-criteria coverage, completed work count, evidence count, and unresolved gaps.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, manifestPath: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createRequirementsTraceabilityMatrixInputSchema,
    handler: async (input, ctx) => {
      const parsed = createRequirementsTraceabilityMatrixInputSchema.parse(input);
      const manifest = await readRequirementsManifest(ctx.projectRoot, parsed.projectId, parsed.manifestPath);
      const matrix = { projectId: parsed.projectId, createdAt: new Date().toISOString(), rows: buildTraceabilityRows(manifest.requirements), summary: summarizeRequirements(manifest.requirements) };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(matrix, null, 2)}\n`);
      return { ok: true, summary: `Created traceability matrix for ${manifest.requirements.length} requirement(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: matrix, logs: [JSON.stringify(matrix, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "summarize_requirements_status",
      description: "Summarize requirement counts by status/priority and identify missing evidence or unmet acceptance criteria.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, manifestPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: summarizeRequirementsStatusInputSchema,
    handler: async (input, ctx) => {
      const parsed = summarizeRequirementsStatusInputSchema.parse(input);
      const manifest = await readRequirementsManifest(ctx.projectRoot, parsed.projectId, parsed.manifestPath);
      const summary = summarizeRequirements(manifest.requirements);
      return { ok: true, summary: `Summarized ${summary.totalRequirements} requirement(s).`, jobId: parsed.projectId, artifacts: [], structuredContent: summary, logs: [JSON.stringify(summary, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "export_requirements_report",
      description: "Export a Markdown requirements traceability report with requirements, acceptance criteria, constraints, completed work, and evidence.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, manifestPath: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportRequirementsReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportRequirementsReportInputSchema.parse(input);
      const manifest = await readRequirementsManifest(ctx.projectRoot, parsed.projectId, parsed.manifestPath);
      const markdown = renderRequirementsReport(manifest.requirements);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown);
      return { ok: true, summary: `Exported requirements report for ${manifest.requirements.length} requirement(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { path: file.path, markdown }, logs: [markdown], errors: [] };
    }
  }
];
