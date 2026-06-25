import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, getProjectManifest, readProjectFile, writeProjectFile } from "../src/projects/store.js";
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
    clientId: "component-library-test"
  };
}

test("generate_component_library creates a validated reusable UI project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "component-library-"));
  try {
    const ctx = toolContext(root);
    const result = await callTool("generate_component_library", {
      title: "Ops UI Kit",
      summary: "Reusable operations console components.",
      components: ["button", "card", "data table", "modal", "toast", "tabs", "form field", "icon"],
      tokens: {
        primary: "#0f766e",
        accent: "#ca8a04",
        background: "#f8fafc",
        text: "#17211d",
        radius: 6,
        density: "compact"
      }
    }, ctx);

    assert.equal(result.ok, true);
    const projectId = result.jobId!;
    const manifest = await getProjectManifest(ctx.projectRoot, projectId);
    assert.equal(manifest.entryFile, "component-library/style-guide.html");
    assert.ok(manifest.lastValidation?.ok);
    assert.deepEqual(manifest.files.map((file) => file.path).sort(), [
      "component-library/USAGE.md",
      "component-library/component-library.json",
      "component-library/icons.svg",
      "component-library/style-guide.html",
      "component-library/ui.css",
      "component-library/ui.js"
    ].sort());

    const css = await readProjectFile(ctx.projectRoot, projectId, "component-library/ui.css");
    assert.match(css, /--ui-color-primary: #0f766e/);
    assert.match(css, /\.ui-btn-primary/);
    assert.match(css, /\.ui-modal-backdrop/);

    const styleGuide = await readProjectFile(ctx.projectRoot, projectId, "component-library/style-guide.html");
    assert.match(styleGuide, /Ops UI Kit/);
    assert.match(styleGuide, /role="tablist"/);
    assert.match(styleGuide, /data-ui-action="open-modal"/);

    const library = JSON.parse(await readProjectFile(ctx.projectRoot, projectId, "component-library/component-library.json")) as {
      components: string[];
      accessibilityDefaults: string[];
      tokens: { density: string };
    };
    assert.ok(library.components.includes("data-table"));
    assert.ok(library.components.includes("form-field"));
    assert.ok(library.accessibilityDefaults.includes("visible focus"));
    assert.equal(library.tokens.density, "compact");

    const usage = await readProjectFile(ctx.projectRoot, projectId, "component-library/USAGE.md");
    assert.match(usage, /Accessibility Defaults/);
    assert.ok(usage.includes("component-library/ui.css"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generate_component_library can write into an existing project without a style guide", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "component-library-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Existing App", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><body><h1>Existing App</h1></body></html>");

    const result = await callTool("generate_component_library", {
      projectId: project.id,
      outputDir: "shared/ui",
      components: ["button", "empty state"],
      includeStyleGuide: false,
      validate: true
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal(result.jobId, project.id);
    assert.deepEqual(result.artifacts.sort(), [
      "shared/ui/component-library.json",
      "shared/ui/icons.svg",
      "shared/ui/ui.css",
      "shared/ui/ui.js",
      "shared/ui/USAGE.md"
    ].sort());
    const manifest = await getProjectManifest(ctx.projectRoot, project.id);
    assert.ok(manifest.taskHistory.some((item) => item.toolName === "generate_component_library"));
    const library = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "shared/ui/component-library.json")) as { components: string[] };
    assert.deepEqual(library.components, ["button", "empty-state"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("component library generator is exposed through coding and debug skills", () => {
  for (const skillId of ["coding", "debug"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill!.toolNames.includes("generate_component_library"), `${skillId} exposes generate_component_library`);
  }
});
