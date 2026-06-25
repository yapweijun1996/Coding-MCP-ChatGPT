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
    clientId: "i18n-audit-test"
  };
}

test("audit_i18n_coverage reports missing keys, hardcoded copy, terminology, overflow, and persistence gaps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "i18n-audit-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Multilingual app", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "locales/en.json", JSON.stringify({
      nav: { home: "Home", checkout: "Checkout" },
      cta: "Pay now",
      status: "Invoice"
    }, null, 2));
    await writeProjectFile(ctx.projectRoot, project.id, "locales/zh.json", JSON.stringify({
      nav: { home: "首页" },
      cta: "立即付款并完成整个订单流程以继续查看下一步说明和确认所有账单资料",
      status: "发票"
    }, null, 2));
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", `<!doctype html>
<html lang="en"><body>
  <h1>Welcome dashboard</h1>
  <button data-i18n="cta"></button>
  <script src="app.js"></script>
</body></html>`);
    await writeProjectFile(ctx.projectRoot, project.id, "app.js", `const fallbackLocale = "en";
const label = "Save changes";
`);

    const result = await callTool("audit_i18n_coverage", {
      projectId: project.id,
      expectedLocales: ["en", "zh", "ms"],
      glossary: [{ term: "Invoice", translations: { zh: "发票", ms: "Invois" } }],
      overflowRatio: 1.4
    }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts.sort(), ["i18n/i18n-audit.json", "i18n/i18n-audit.md"].sort());

    const report = result.structuredContent as { findings: Array<{ id: string; category: string; path: string }>; coverage: { fallbackSignal: boolean; persistenceSignal: boolean; baseKeyCount: number } };
    assert.equal(report.coverage.fallbackSignal, true);
    assert.equal(report.coverage.persistenceSignal, false);
    assert.equal(report.coverage.baseKeyCount, 4);
    const ids = new Set(report.findings.map((finding) => finding.id));
    for (const id of ["missing-translation-key", "missing-locale-file", "translation-overflow-risk", "glossary-term-missing", "hardcoded-html-text", "hardcoded-js-string", "language-persistence-not-detected"]) {
      assert.ok(ids.has(id), `expected ${id}`);
    }

    const json = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "i18n/i18n-audit.json")) as { findings: unknown[] };
    assert.equal(json.findings.length, report.findings.length);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "i18n/i18n-audit.md");
    assert.match(markdown, /# i18n Coverage Audit/);
    assert.match(markdown, /missing-translation-key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audit_i18n_coverage detects language persistence and scoped source paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "i18n-audit-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Persisted language app", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "i18n/en.json", JSON.stringify({ hello: "Hello" }));
    await writeProjectFile(ctx.projectRoot, project.id, "i18n/ms.json", JSON.stringify({ hello: "Helo" }));
    await writeProjectFile(ctx.projectRoot, project.id, "app.js", "const locale = localStorage.getItem('locale') || 'en'; const fallbackLocale = 'en';\n");
    await writeProjectFile(ctx.projectRoot, project.id, "unused.js", "const title = 'Hardcoded unused';\n");

    const result = await callTool("audit_i18n_coverage", { projectId: project.id, sourcePaths: ["app.js"], expectedLocales: ["en", "ms"] }, ctx);
    assert.equal(result.ok, true);
    const report = result.structuredContent as { sourceFiles: string[]; coverage: { persistenceSignal: boolean }; findings: Array<{ evidence?: string }> };
    assert.deepEqual(report.sourceFiles, ["app.js"]);
    assert.equal(report.coverage.persistenceSignal, true);
    assert.equal(report.findings.some((finding) => finding.evidence === "Hardcoded unused"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("i18n audit is exposed through coding and debug skills", () => {
  for (const skillId of ["coding", "debug"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill!.toolNames.includes("audit_i18n_coverage"), `${skillId} exposes audit_i18n_coverage`);
  }
});
