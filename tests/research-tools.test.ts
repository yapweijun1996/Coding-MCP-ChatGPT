import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { researchTools } from "../src/mcp/tools/research.js";
import type { ToolContext } from "../src/mcp/types.js";
import {
  addResearchSource,
  createResearchProject,
  getResearchManifest,
  publishResearchReport,
  recordResearchEvidence,
  validateResearchManifest,
  writeResearchReport,
  type ResearchConfidence
} from "../src/research/store.js";

async function withResearch<T>(run: (root: string, projectId: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-research-"));
  try {
    const manifest = await createResearchProject(root, {
      title: "Research test",
      summary: "A test research project.",
      createdByClientId: "test-client"
    });
    return await run(root, manifest.project.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    projectRoot: root,
    clientId: "test-client"
  };
}

test("createResearchProject creates standard research files", async () => {
  await withResearch(async (root, projectId) => {
    const manifest = await getResearchManifest(root, projectId);
    assert.equal(manifest.research.projectId, projectId);
    assert.deepEqual(manifest.notes.map((note) => [note.type, note.exists]), [
      ["findings", true],
      ["contradictions", true],
      ["open-questions", true],
      ["methodology", true]
    ]);
    assert.equal(manifest.evidence.length, 0);
    assert.equal(manifest.report.htmlExists, false);
  });
});

test("addResearchSource increments source ids and rejects invalid input", async () => {
  await withResearch(async (root, projectId) => {
    const first = await addResearchSource(root, projectId, {
      title: "First source",
      url: "https://example.com/first",
      claim: "First claim",
      summary: "First summary",
      confidence: "medium",
      tags: ["market"],
      usedInReport: true
    });
    const second = await addResearchSource(root, projectId, {
      title: "Second source",
      url: "https://example.com/second",
      claim: "Second claim",
      summary: "Second summary",
      confidence: "high",
      tags: [],
      usedInReport: false
    });

    assert.equal(first.id, "source_001");
    assert.equal(second.id, "source_002");
    await assert.rejects(addResearchSource(root, projectId, {
      title: "Bad source",
      url: "ftp://example.com/file",
      claim: "Bad claim",
      summary: "Bad summary",
      confidence: "medium",
      tags: [],
      usedInReport: true
    }), /http:\/\/ or https:\/\//);
    await assert.rejects(addResearchSource(root, projectId, {
      title: "Bad confidence",
      url: "https://example.com/bad",
      claim: "Bad claim",
      summary: "Bad summary",
      confidence: "certain" as ResearchConfidence,
      tags: [],
      usedInReport: true
    }), /confidence/);
  });
});

test("writeResearchReport and validateResearchManifest enforce research structure", async () => {
  await withResearch(async (root, projectId) => {
    let validation = await validateResearchManifest(root, projectId);
    assert.equal(validation.ok, false);
    assert.match(validation.errors.join("\n"), /At least one research source/);
    assert.match(validation.errors.join("\n"), /report.md/);

    const source = await addResearchSource(root, projectId, {
      title: "Primary source",
      url: "https://example.com/source",
      claim: "A sourced claim",
      summary: "A source summary",
      confidence: "high",
      tags: [],
      usedInReport: true
    });
    await writeResearchReport(root, projectId, {
      markdown: `# Report\n\nUses ${source.id}.`,
      html: "<!doctype html><html><body><h1>Report</h1><p>No cited source yet.</p></body></html>"
    });
    validation = await validateResearchManifest(root, projectId);
    assert.equal(validation.ok, false);
    assert.match(validation.errors.join("\n"), /must reference at least one source/);

    await writeResearchReport(root, projectId, {
      markdown: `# Report\n\nUses ${source.id}.`,
      html: `<!doctype html><html><body><h1>Report</h1><p>Source: ${source.id} ${source.url}</p></body></html>`
    });
    validation = await validateResearchManifest(root, projectId);
    assert.equal(validation.ok, true);
    assert.equal(validation.sourceCount, 1);
    assert.equal(validation.usedSourceCount, 1);
  });
});

test("recordResearchEvidence and publishResearchReport produce a published URL", async () => {
  await withResearch(async (root, projectId) => {
    const source = await addResearchSource(root, projectId, {
      title: "Evidence source",
      url: "https://example.com/evidence",
      claim: "Evidence claim",
      summary: "Evidence summary",
      confidence: "medium",
      tags: [],
      usedInReport: true
    });
    const evidence = await recordResearchEvidence(root, projectId, {
      sourceId: source.id,
      kind: "inspect_webpage",
      url: source.url,
      reportUrl: "https://example.test/share/inspection/report.html",
      summary: "Inspection completed."
    });
    assert.equal(evidence.id, "evidence_001");

    await writeResearchReport(root, projectId, {
      markdown: `# Report\n\nSource: ${source.id}`,
      html: `<!doctype html><html><body><h1>Report</h1><p>${source.id}</p></body></html>`
    });
    const published = await publishResearchReport(root, projectId, "https://example.test");
    assert.equal(published.ok, true);
    assert.equal(published.publishedUrl, `https://example.test/share/${projectId}/report.html`);
  });
});

test("research MCP tools create, add, list, record, and publish", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-research-tools-"));
  try {
    const ctx = toolContext(root);
    const createTool = researchTools.find((tool) => tool.definition.name === "create_research_project");
    const addTool = researchTools.find((tool) => tool.definition.name === "add_research_source");
    const listTool = researchTools.find((tool) => tool.definition.name === "list_research_sources");
    const evidenceTool = researchTools.find((tool) => tool.definition.name === "record_research_evidence");
    const writeTool = researchTools.find((tool) => tool.definition.name === "write_research_report");
    const publishTool = researchTools.find((tool) => tool.definition.name === "publish_research_report");
    assert.ok(createTool);
    assert.ok(addTool);
    assert.ok(listTool);
    assert.ok(evidenceTool);
    assert.ok(writeTool);
    assert.ok(publishTool);

    const created = await createTool.handler({ title: "Tool research" }, ctx);
    assert.equal(created.ok, true);
    assert.ok(created.jobId);
    const projectId = created.jobId;

    const invalidPublish = await publishTool.handler({ projectId }, ctx);
    assert.equal(invalidPublish.ok, false);
    assert.match(invalidPublish.errors.join("\n"), /At least one research source/);

    const added = await addTool.handler({
      projectId,
      title: "Tool source",
      url: "https://example.com/tool-source",
      claim: "Tool claim",
      summary: "Tool summary",
      confidence: "high"
    }, ctx);
    assert.equal(added.ok, true);

    const listed = await listTool.handler({ projectId }, ctx);
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.artifacts, ["source_001"]);

    const recorded = await evidenceTool.handler({
      projectId,
      sourceId: "source_001",
      kind: "inspect_webpage",
      reportUrl: "https://example.test/share/evidence/report.html",
      summary: "Evidence summary"
    }, ctx);
    assert.equal(recorded.ok, true);

    await writeTool.handler({
      projectId,
      markdown: "# Tool report\n\nsource_001",
      html: "<!doctype html><html><body><h1>Tool report</h1><p>source_001</p></body></html>"
    }, ctx);
    const published = await publishTool.handler({ projectId }, ctx);
    assert.equal(published.ok, true);
    assert.equal(published.shareUrl, `https://example.test/share/${projectId}/report.html`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
