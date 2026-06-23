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
    clientId: "image-workflow-test"
  };
}

test("image workflow tools create briefs, specs, QA reports, and placeholder SVG assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "image-workflow-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Image project", createdByClientId: "designer" });
    await writeProjectFile(ctx.projectRoot, project.id, "assets/logo.svg", [
      "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"128\" height=\"64\" viewBox=\"0 0 128 64\">",
      "<title>Logo</title>",
      "<rect width=\"128\" height=\"64\" fill=\"#0f172a\"/>",
      "</svg>"
    ].join("\n"));

    const brief = getToolModule("create_image_workflow_brief");
    const inspect = getToolModule("inspect_project_image_assets");
    const sprite = getToolModule("create_sprite_sheet_spec");
    const icons = getToolModule("create_icon_manifest");
    const style = getToolModule("check_image_style_consistency");
    const placeholder = getToolModule("create_placeholder_svg_asset");
    for (const [name, tool] of Object.entries({ brief, inspect, sprite, icons, style, placeholder })) assert.ok(tool, `${name} registered`);

    const briefResult = await brief!.handler({
      projectId: project.id,
      title: "Launch visuals",
      purpose: "Prepare hero, icon, sprite, and background-removal handoff assets.",
      style: "Crisp product UI with high contrast.",
      targetAssets: [
        { name: "Hero", kind: "hero", operation: "generate", width: 1440, height: 900, prompt: "Abstract dashboard scene" },
        { name: "Logo cutout", kind: "logo", operation: "remove_background", referencePaths: ["assets/logo.svg"] }
      ]
    }, ctx);
    assert.equal(briefResult.ok, true);
    assert.ok(briefResult.artifacts.includes("image-workflow/brief.json"));
    const briefFile = await readProjectFile(ctx.projectRoot, project.id, "image-workflow/brief.json");
    assert.match(briefFile, /remove_background/);

    const placeholderResult = await placeholder!.handler({
      projectId: project.id,
      outputPath: "assets/app-icon.svg",
      label: "AI",
      width: 192,
      height: 192,
      foreground: "#2563eb",
      background: "#ffffff",
      shape: "circle"
    }, ctx);
    assert.equal(placeholderResult.ok, true);
    const svg = await readProjectFile(ctx.projectRoot, project.id, "assets/app-icon.svg");
    assert.match(svg, /<svg/);
    assert.match(svg, /AI/);

    const inspected = await inspect!.handler({ projectId: project.id, paths: ["assets/logo.svg", "assets/app-icon.svg", "assets/missing.png"] }, ctx);
    const inspectedPayload = inspected.structuredContent as { imageCount: number; missing: string[]; assets: Array<{ path: string; dimensions: { width?: number; height?: number } }> };
    assert.equal(inspectedPayload.imageCount, 2);
    assert.deepEqual(inspectedPayload.missing, ["assets/missing.png"]);
    assert.equal(inspectedPayload.assets.some((asset) => asset.path === "assets/logo.svg" && asset.dimensions.width === 128 && asset.dimensions.height === 64), true);

    const spriteResult = await sprite!.handler({
      projectId: project.id,
      padding: 2,
      frames: [
        { name: "idle", sourcePath: "assets/app-icon.svg", width: 32, height: 32 },
        { name: "active", sourcePath: "assets/logo.svg", width: 32, height: 32 }
      ]
    }, ctx);
    const spritePayload = spriteResult.structuredContent as { width: number; height: number; frames: Array<{ x: number; y: number }> };
    assert.equal(spritePayload.width, 66);
    assert.equal(spritePayload.height, 32);
    assert.equal(spritePayload.frames[1].x, 34);
    assert.ok(spriteResult.artifacts.includes("image-workflow/sprite-sheet.json"));

    const iconResult = await icons!.handler({
      projectId: project.id,
      appName: "Image Demo",
      icons: [{ path: "assets/app-icon.svg", size: 192, purpose: "app" }]
    }, ctx);
    const iconPayload = iconResult.structuredContent as { recommendations: string[] };
    assert.equal(iconPayload.recommendations.some((item) => item.includes("512x512")), true);
    assert.equal(iconPayload.recommendations.some((item) => item.includes("maskable")), true);

    const styleResult = await style!.handler({
      projectId: project.id,
      assetPaths: ["assets/logo.svg", "assets/app-icon.svg"],
      styleTokens: { palette: ["#0f172a", "#2563eb"], stroke: "solid" },
      writeToProject: true
    }, ctx);
    assert.equal(styleResult.ok, true);
    assert.ok(styleResult.artifacts.includes("image-workflow/style-consistency-report.json"));
    const report = await readProjectFile(ctx.projectRoot, project.id, "image-workflow/style-consistency-report.json");
    assert.match(report, /palette/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image-workflow skill exposes image tools through dedicated, coding, and debug skills", () => {
  const toolNames = [
    "create_image_workflow_brief",
    "inspect_project_image_assets",
    "create_sprite_sheet_spec",
    "create_icon_manifest",
    "check_image_style_consistency",
    "create_placeholder_svg_asset"
  ];
  const imageWorkflow = skillRegistry.find((entry) => entry.id === "image-workflow");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(imageWorkflow);
  for (const toolName of toolNames) {
    assert.ok(imageWorkflow!.toolNames.includes(toolName), `${toolName} exposed in image-workflow`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
