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
    clientId: "compliance-review-test"
  };
}

test("compliance review tools scan licenses, attribution, privacy, checklists, and reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compliance-review-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Compliance project", createdByClientId: "compliance" });
    await writeProjectFile(ctx.projectRoot, project.id, "package.json", JSON.stringify({ name: "demo", license: "MIT" }, null, 2));
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<img src=\"assets/photo.svg\"><script>localStorage.setItem('email', 'x@example.test')</script>");
    await writeProjectFile(ctx.projectRoot, project.id, "assets/photo.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"><title>Photo</title></svg>");

    const scan = getToolModule("scan_project_compliance_sources");
    const attribution = getToolModule("create_asset_attribution_manifest");
    const license = getToolModule("evaluate_license_compliance");
    const privacy = getToolModule("audit_privacy_data_handling");
    const checklist = getToolModule("create_compliance_checklist");
    const report = getToolModule("export_compliance_report");
    for (const [name, tool] of Object.entries({ scan, attribution, license, privacy, checklist, report })) assert.ok(tool, `${name} registered`);

    const scanResult = await scan!.handler({ projectId: project.id }, ctx);
    assert.equal(scanResult.ok, false);
    const scanPayload = scanResult.structuredContent as { packageLicense?: string; assetFiles: string[]; dataSignals: string[]; warnings: string[] };
    assert.equal(scanPayload.packageLicense, "MIT");
    assert.deepEqual(scanPayload.assetFiles, ["assets/photo.svg"]);
    assert.equal(scanPayload.dataSignals.includes("email"), true);
    assert.equal(scanPayload.warnings.some((warning) => warning.includes("attribution")), true);

    const attributionResult = await attribution!.handler({
      projectId: project.id,
      assets: [
        { path: "assets/photo.svg", sourceUrl: "https://example.test/photo", author: "Example", license: "CC-BY-NC-4.0", attributionText: "Photo by Example", intendedUse: "commercial" },
        { path: "assets/icon.svg" }
      ]
    }, ctx);
    assert.equal(attributionResult.ok, false);
    const attributionPayload = attributionResult.structuredContent as { highestRisk: string; entries: Array<{ path: string; risk: string; warnings: string[] }> };
    assert.equal(attributionPayload.highestRisk, "high");
    assert.equal(attributionPayload.entries.some((entry) => entry.path === "assets/icon.svg" && entry.risk === "unknown"), true);

    const licenseResult = await license!.handler({
      projectId: project.id,
      intendedUse: "commercial",
      licenses: [
        { name: "safe-lib", license: "Apache-2.0" },
        { name: "asset-pack", license: "GPL-3.0" }
      ]
    }, ctx);
    assert.equal(licenseResult.ok, false);
    const licensePayload = licenseResult.structuredContent as { highRisk: Array<{ name: string }> };
    assert.equal(licensePayload.highRisk.some((entry) => entry.name === "asset-pack"), true);

    const privacyResult = await privacy!.handler({
      projectId: project.id,
      dataTypes: ["email"],
      thirdPartyServices: ["analytics.example"],
      storesPersonalData: true,
      collectsAnalytics: true
    }, ctx);
    assert.equal(privacyResult.ok, false);
    const privacyPayload = privacyResult.structuredContent as { warnings: string[] };
    assert.equal(privacyPayload.warnings.some((warning) => warning.includes("Privacy")), true);

    const checklistResult = await checklist!.handler({ projectId: project.id, preset: "commercial" }, ctx);
    assert.equal(checklistResult.ok, true);
    const checklistPayload = checklistResult.structuredContent as { checks: Array<{ text: string }> };
    assert.equal(checklistPayload.checks.some((item) => item.text.includes("Commercial-use")), true);

    const reportResult = await report!.handler({
      projectId: project.id,
      scan: scanPayload,
      attribution: attributionPayload,
      licenseEvaluation: licensePayload,
      privacyAudit: privacyPayload,
      checklist: checklistPayload
    }, ctx);
    assert.equal(reportResult.ok, true);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "compliance-review/compliance-report.md");
    assert.match(markdown, /Compliance and License Review/);
    assert.match(markdown, /asset-pack/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compliance-review skill exposes tools through coding and debug skills", () => {
  const toolNames = [
    "scan_project_compliance_sources",
    "create_asset_attribution_manifest",
    "evaluate_license_compliance",
    "audit_privacy_data_handling",
    "create_compliance_checklist",
    "export_compliance_report"
  ];
  const compliance = skillRegistry.find((entry) => entry.id === "compliance-review");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(compliance);
  for (const toolName of toolNames) {
    assert.ok(compliance!.toolNames.includes(toolName), `${toolName} exposed in compliance-review`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
