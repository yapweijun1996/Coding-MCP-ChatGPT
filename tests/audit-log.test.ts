import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, publishProject, readProjectFile, validateProject, writeProjectFile } from "../src/projects/store.js";
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
    clientId: "audit-log-test"
  };
}

test("audit log tools record, import, list, summarize, deliver, and report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "audit-log-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Audit project", createdByClientId: "auditor" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><body><h1>Audit</h1></body></html>");
    await validateProject(ctx.projectRoot, project.id);
    const published = await publishProject(ctx.projectRoot, project.id, ctx.publicBaseUrl);

    const record = getToolModule("record_audit_event");
    const list = getToolModule("list_audit_events");
    const imported = getToolModule("import_project_activity_audit");
    const summarize = getToolModule("summarize_audit_log");
    const delivery = getToolModule("record_delivery_audit");
    const report = getToolModule("export_audit_log_report");
    for (const [name, tool] of Object.entries({ record, list, imported, summarize, delivery, report })) assert.ok(tool, `${name} registered`);

    const approval = await record!.handler({
      projectId: project.id,
      type: "approval",
      status: "approved",
      title: "Publish approved",
      detail: "Reviewer approved public publish.",
      toolName: "check_publish_permission",
      approvedBy: "reviewer",
      occurredAt: "2026-06-23T01:00:00.000Z"
    }, ctx);
    assert.equal(approval.ok, true);
    assert.ok(approval.artifacts.includes("audit-log/audit-log.json"));

    const failure = await record!.handler({
      projectId: project.id,
      type: "failure",
      status: "failed",
      title: "Smoke test failed",
      detail: "First smoke run timed out.",
      toolName: "run_smoke_flow",
      relatedId: "smoke_1",
      occurredAt: "2026-06-23T01:05:00.000Z"
    }, ctx);
    assert.equal(failure.ok, true);

    const importResult = await imported!.handler({ projectId: project.id }, ctx);
    assert.equal(importResult.ok, true);
    const importPayload = importResult.structuredContent as { imported: Array<{ type: string; toolName: string }> };
    assert.equal(importPayload.imported.some((event) => event.type === "publish" && event.toolName === "publish_project"), true);

    const failures = await list!.handler({ projectId: project.id, type: "failure" }, ctx);
    assert.equal(failures.ok, true);
    const failurePayload = failures.structuredContent as { events: Array<{ title: string }> };
    assert.deepEqual(failurePayload.events.map((event) => event.title), ["Smoke test failed"]);

    const deliveryResult = await delivery!.handler({
      projectId: project.id,
      title: "Final delivery",
      deliveredFiles: ["index.html"],
      validation: ["npm test passed", "MCP registry passed"],
      publishedUrl: published.publishedUrl,
      notes: "Delivered validated static page."
    }, ctx);
    assert.equal(deliveryResult.ok, true);

    const summaryResult = await summarize!.handler({ projectId: project.id }, ctx);
    assert.equal(summaryResult.ok, true);
    const summary = summaryResult.structuredContent as { totalEvents: number; failureCount: number; approvalCount: number; publishCount: number; deliveryCount: number };
    assert.equal(summary.failureCount, 1);
    assert.equal(summary.approvalCount, 1);
    assert.equal(summary.publishCount >= 1, true);
    assert.equal(summary.deliveryCount, 1);
    assert.equal(summary.totalEvents >= 5, true);

    const reportResult = await report!.handler({ projectId: project.id, title: "Audit Report" }, ctx);
    assert.equal(reportResult.ok, true);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "audit-log/audit-report.md");
    assert.match(markdown, /# Audit Report/);
    assert.match(markdown, /Final delivery/);
    assert.match(markdown, /Smoke test failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audit-log skill exposes tools through core, coding, and debug skills", () => {
  const toolNames = [
    "record_audit_event",
    "list_audit_events",
    "import_project_activity_audit",
    "summarize_audit_log",
    "record_delivery_audit",
    "export_audit_log_report"
  ];
  const audit = skillRegistry.find((entry) => entry.id === "audit-log");
  const core = skillRegistry.find((entry) => entry.id === "core");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(audit);
  for (const toolName of toolNames) {
    assert.ok(audit!.toolNames.includes(toolName), `${toolName} exposed in audit-log`);
    assert.ok(core?.toolNames.includes(toolName), `${toolName} exposed in core`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
