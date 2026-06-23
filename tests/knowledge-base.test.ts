import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, readProjectFile, writeProjectFile } from "../src/projects/store.js";
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
    clientId: "knowledge-base-test"
  };
}

test("knowledge base tools ingest, chunk, index, search, cite, detect stale content, and update memory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-base-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Knowledge project", createdByClientId: "agent" });
    await writeProjectFile(ctx.projectRoot, project.id, "docs/runbook.md", [
      "# Deployment Runbook",
      "Use blue green deployment for production releases.",
      "Rollback requires checking health metrics and restoring the previous image.",
      "Customer support escalation should include incident summary and timeline."
    ].join("\n"));

    const ingest = getToolModule("ingest_knowledge_document");
    const chunk = getToolModule("chunk_knowledge_document");
    const build = getToolModule("build_project_knowledge_index");
    const search = getToolModule("search_knowledge_base");
    const cite = getToolModule("cite_knowledge_sources");
    const stale = getToolModule("detect_stale_knowledge");
    const memory = getToolModule("update_project_memory_note");
    for (const [name, tool] of Object.entries({ ingest, chunk, build, search, cite, stale, memory })) assert.ok(tool, `${name} registered`);

    const ingestResult = await ingest!.handler({
      projectId: project.id,
      title: "Deployment Runbook",
      sourcePath: "docs/runbook.md",
      documentId: "deployment-runbook",
      lastReviewedAt: "2025-01-01T00:00:00.000Z"
    }, ctx);
    assert.equal(ingestResult.ok, true);
    assert.ok(ingestResult.artifacts.includes("knowledge-base/document.json"));

    const chunkResult = await chunk!.handler({
      document: {
        id: "inline-policy",
        title: "Support Policy",
        content: "Support escalation includes severity, customer impact, owner, and next update time. ".repeat(20)
      },
      chunkSize: 300,
      overlap: 50
    }, ctx);
    const chunkPayload = chunkResult.structuredContent as { chunks: Array<{ id: string; tokens: string[] }> };
    assert.equal(chunkPayload.chunks.length > 1, true);
    assert.equal(chunkPayload.chunks[0].tokens.includes("support"), true);

    const buildResult = await build!.handler({
      projectId: project.id,
      documents: [
        { id: "deployment-runbook", title: "Deployment Runbook", sourcePath: "docs/runbook.md", lastReviewedAt: "2025-01-01T00:00:00.000Z" },
        { id: "support-policy", title: "Support Policy", content: "Support escalation includes severity, customer impact, owner, and next update time.", lastReviewedAt: "2026-06-01T00:00:00.000Z" }
      ],
      chunkSize: 300,
      overlap: 20
    }, ctx);
    assert.equal(buildResult.ok, true);
    assert.ok(buildResult.artifacts.includes("knowledge-base/index.json"));
    const buildPayload = buildResult.structuredContent as { chunkCount: number };
    assert.equal(buildPayload.chunkCount >= 2, true);

    const searchResult = await search!.handler({
      projectId: project.id,
      indexPath: "knowledge-base/index.json",
      query: "rollback production health metrics",
      topK: 2
    }, ctx);
    const searchPayload = searchResult.structuredContent as { results: Array<{ title: string; score: number; snippet: string; chunkId: string }> };
    assert.equal(searchPayload.results.length >= 1, true);
    assert.equal(searchPayload.results[0].title, "Deployment Runbook");
    assert.match(searchPayload.results[0].snippet, /Rollback/);

    const citeResult = await cite!.handler({
      answer: "Use rollback only after checking health metrics.",
      searchResults: searchPayload.results
    }, ctx);
    const citePayload = citeResult.structuredContent as { citedAnswer: string; sources: unknown[] };
    assert.match(citePayload.citedAnswer, /Sources:/);
    assert.equal(citePayload.sources.length, searchPayload.results.length);

    const staleResult = await stale!.handler({
      projectId: project.id,
      indexPath: "knowledge-base/index.json",
      maxAgeDays: 180,
      now: "2026-06-23T00:00:00.000Z"
    }, ctx);
    const stalePayload = staleResult.structuredContent as { stale: Array<{ id: string }> };
    assert.equal(stalePayload.stale.some((item) => item.id === "deployment-runbook"), true);
    assert.equal(stalePayload.stale.some((item) => item.id === "support-policy"), false);

    const memoryResult = await memory!.handler({
      projectId: project.id,
      title: "Deployment rollback memory",
      summary: "Rollback workflow depends on health metrics and previous image restore.",
      tags: ["deployment", "rollback"],
      sourceRefs: ["docs/runbook.md"]
    }, ctx);
    assert.equal(memoryResult.ok, true);
    const memoryText = await readProjectFile(ctx.projectRoot, project.id, "knowledge-base/project-memory.md");
    assert.match(memoryText, /Deployment rollback memory/);
    assert.match(memoryText, /docs\/runbook\.md/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge-base skill exposes RAG tools through dedicated, coding, and debug skills", () => {
  const toolNames = [
    "ingest_knowledge_document",
    "chunk_knowledge_document",
    "build_project_knowledge_index",
    "search_knowledge_base",
    "cite_knowledge_sources",
    "detect_stale_knowledge",
    "update_project_memory_note"
  ];
  const knowledge = skillRegistry.find((entry) => entry.id === "knowledge-base");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(knowledge);
  for (const toolName of toolNames) {
    assert.ok(knowledge!.toolNames.includes(toolName), `${toolName} exposed in knowledge-base`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
