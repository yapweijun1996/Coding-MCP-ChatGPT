import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { appendProjectTaskHistory, createProject, publishProject, writeProjectFile } from "../src/projects/store.js";
import type { ToolContext } from "../src/mcp/types.js";
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
    clientId: "global-search-test"
  };
}

test("search_projects_global finds reusable files, history, and published URLs across projects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "global-project-search-"));
  try {
    const ctx = toolContext(root);
    const reusable = await createProject(ctx.projectRoot, {
      title: "Reusable Admin Shell",
      summary: "Contains a reusable sidebar and toast pattern.",
      createdByClientId: "coder"
    });
    await writeProjectFile(ctx.projectRoot, reusable.id, "index.html", "<!doctype html><html><body><aside class=\"sidebar\">Reusable navigation</aside></body></html>");
    await writeProjectFile(ctx.projectRoot, reusable.id, "components.js", "export function ToastQueue(){ return 'retry toast reusable pattern'; }\n");
    await appendProjectTaskHistory(ctx.projectRoot, reusable.id, {
      toolName: "run_project_fix_loop",
      ok: true,
      summary: "Fixed previous retry toast issue with ToastQueue component."
    });
    await publishProject(ctx.projectRoot, reusable.id, ctx.publicBaseUrl, "index.html");

    const other = await createProject(ctx.projectRoot, {
      title: "Marketing Page",
      summary: "Unrelated launch copy.",
      createdByClientId: "coder"
    });
    await writeProjectFile(ctx.projectRoot, other.id, "index.html", "<!doctype html><html><body>Launch</body></html>");

    const search = getToolModule("search_projects_global");
    assert.ok(search, "search_projects_global registered");
    const result = await search!.handler({ query: "retry toast", maxResults: 10 }, ctx);

    assert.equal(result.ok, true);
    const payload = result.structuredContent as {
      matchCount: number;
      matches: Array<{ projectId: string; source: string; path?: string; publishedUrl?: string; reuse?: { tool?: string; arguments?: Record<string, unknown> } }>;
    };
    assert.ok(payload.matchCount >= 2, JSON.stringify(payload, null, 2));
    assert.ok(payload.matches.some((match) => match.projectId === reusable.id && match.source === "file" && match.path === "components.js"));
    assert.ok(payload.matches.some((match) => match.projectId === reusable.id && match.source === "history"));
    assert.ok(payload.matches.some((match) => match.publishedUrl?.includes(`/share/${reusable.id}/index.html`)));
    assert.ok(payload.matches.some((match) => match.reuse?.tool === "read_project_file" && match.reuse.arguments?.relativePath === "components.js"));
    assert.equal(payload.matches.some((match) => match.projectId === other.id), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("core and coding skills expose cross-project search", () => {
  for (const id of ["core", "coding"]) {
    const skill = skillRegistry.find((entry) => entry.id === id);
    assert.ok(skill, `${id} skill registered`);
    assert.ok(skill!.toolNames.includes("search_projects_global"));
  }
});
