import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, readProjectFile } from "../src/projects/store.js";
import { skillRegistry } from "../src/skills/registry.js";
import type { ToolContext } from "../src/mcp/types.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "requirements-tracking-test"
  };
}

test("requirements tracking tools store requirements and map work evidence to traceability outputs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "requirements-tracking-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Requirements project", createdByClientId: "requirements" });

    const upsert = getToolModule("upsert_project_requirement");
    const list = getToolModule("list_project_requirements");
    const mapEvidence = getToolModule("map_requirement_evidence");
    const matrix = getToolModule("create_requirements_traceability_matrix");
    const summary = getToolModule("summarize_requirements_status");
    const report = getToolModule("export_requirements_report");
    for (const [name, tool] of Object.entries({ upsert, list, mapEvidence, matrix, summary, report })) assert.ok(tool, `${name} registered`);

    const upsertResult = await upsert!.handler({
      projectId: project.id,
      requirementId: "REQ-001",
      title: "Track user requirements",
      description: "Persist requirements, acceptance criteria, constraints, work, and evidence.",
      priority: "must",
      source: "user feedback issue_0072",
      acceptanceCriteria: [
        { id: "AC-1", text: "Requirement is stored durably." },
        { id: "AC-2", text: "Evidence is mapped back to the requirement." }
      ],
      constraints: ["Records must stay project-local."]
    }, ctx);
    assert.equal(upsertResult.ok, true);
    const upsertPayload = upsertResult.structuredContent as { requirement: { id: string; acceptanceCriteria: Array<{ status: string }> } };
    assert.equal(upsertPayload.requirement.id, "REQ-001");
    assert.deepEqual(upsertPayload.requirement.acceptanceCriteria.map((criterion) => criterion.status), ["pending", "pending"]);

    const mapResult = await mapEvidence!.handler({
      projectId: project.id,
      requirementId: "REQ-001",
      status: "satisfied",
      completedWork: [
        { label: "Implemented requirements-tracking tool module.", filePath: "src/mcp/tools/requirements-tracking.ts" }
      ],
      evidence: [
        { label: "Requirements tracking test passed.", kind: "test", filePath: "tests/requirements-tracking.test.ts" }
      ],
      acceptanceCriteriaUpdates: [
        { id: "AC-1", status: "passed" },
        { id: "AC-2", status: "passed" }
      ]
    }, ctx);
    assert.equal(mapResult.ok, true);
    const mapped = mapResult.structuredContent as { requirement: { status: string; completedWork: unknown[]; evidence: unknown[]; acceptanceCriteria: Array<{ status: string }> } };
    assert.equal(mapped.requirement.status, "satisfied");
    assert.equal(mapped.requirement.completedWork.length, 1);
    assert.equal(mapped.requirement.evidence.length, 1);
    assert.deepEqual(mapped.requirement.acceptanceCriteria.map((criterion) => criterion.status), ["passed", "passed"]);

    const listResult = await list!.handler({ projectId: project.id, status: "satisfied" }, ctx);
    assert.equal(listResult.ok, true);
    const listed = listResult.structuredContent as { requirements: Array<{ id: string }> };
    assert.deepEqual(listed.requirements.map((requirement) => requirement.id), ["REQ-001"]);

    const matrixResult = await matrix!.handler({ projectId: project.id }, ctx);
    assert.equal(matrixResult.ok, true);
    const matrixPayload = matrixResult.structuredContent as { rows: Array<{ requirementId: string; allCriteriaResolved: boolean; evidenceCount: number }> };
    assert.deepEqual(matrixPayload.rows, [
      {
        requirementId: "REQ-001",
        title: "Track user requirements",
        priority: "must",
        status: "satisfied",
        acceptanceCriteriaTotal: 2,
        acceptanceCriteriaPassed: 2,
        acceptanceCriteriaFailed: 0,
        acceptanceCriteriaPending: 0,
        allCriteriaResolved: true,
        completedWorkCount: 1,
        evidenceCount: 1,
        missingEvidence: false,
        constraintsCount: 1
      }
    ]);

    const summaryResult = await summary!.handler({ projectId: project.id }, ctx);
    assert.equal(summaryResult.ok, true);
    const summaryPayload = summaryResult.structuredContent as { byStatus: Record<string, number>; missingEvidence: string[]; unmetCriteria: unknown[]; readyRequirementIds: string[] };
    assert.deepEqual(summaryPayload.byStatus, { satisfied: 1 });
    assert.deepEqual(summaryPayload.missingEvidence, []);
    assert.deepEqual(summaryPayload.unmetCriteria, []);
    assert.deepEqual(summaryPayload.readyRequirementIds, ["REQ-001"]);

    const reportResult = await report!.handler({ projectId: project.id }, ctx);
    assert.equal(reportResult.ok, true);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "requirements-tracking/requirements-report.md");
    assert.match(markdown, /REQ-001: Track user requirements/);
    assert.match(markdown, /Requirements tracking test passed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requirements-tracking skill exposes tools through coding and debug skills", () => {
  const toolNames = [
    "upsert_project_requirement",
    "list_project_requirements",
    "map_requirement_evidence",
    "create_requirements_traceability_matrix",
    "summarize_requirements_status",
    "export_requirements_report"
  ];
  const requirements = skillRegistry.find((entry) => entry.id === "requirements-tracking");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(requirements);
  for (const toolName of toolNames) {
    assert.ok(requirements!.toolNames.includes(toolName), `${toolName} exposed in requirements-tracking`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
