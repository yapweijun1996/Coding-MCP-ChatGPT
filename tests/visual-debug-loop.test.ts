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
    clientId: "visual-debug-test"
  };
}

test("visual debug tools are registered and validate agent-friendly schemas", () => {
  const visual = getToolModule("analyze_webpage_visual");
  const threeDVisual = getToolModule("inspect_3d_scene_visuals");
  const point = getToolModule("inspect_dom_at_point");
  assert.ok(visual, "analyze_webpage_visual registered");
  assert.ok(threeDVisual, "inspect_3d_scene_visuals registered");
  assert.ok(point, "inspect_dom_at_point registered");

  const visualInput = visual!.schema!.parse({ url: "https://93.184.216.34/" }) as { viewports: string[]; maxFindings: number };
  assert.deepEqual(visualInput.viewports, ["desktop", "mobile"]);
  assert.equal(visualInput.maxFindings, 30);

  const threeDInput = threeDVisual!.schema!.parse({ url: "https://93.184.216.34/", canvasSelector: "#scene", expectedFacing: "front" }) as {
    canvasSelector: string;
    expectedFacing: string;
    viewPresets: string[];
    settleMs: number;
    maxFindings: number;
  };
  assert.equal(threeDInput.canvasSelector, "#scene");
  assert.equal(threeDInput.expectedFacing, "front");
  assert.deepEqual(threeDInput.viewPresets, ["front", "back", "left", "right", "isometric", "mobile_portrait"]);
  assert.equal(threeDInput.settleMs, 750);
  assert.equal(threeDInput.maxFindings, 40);
  assert.throws(() => threeDVisual!.schema!.parse({ url: "https://93.184.216.34/", viewPresets: ["diagonal"] }), /Invalid enum value/);

  const pointInput = point!.schema!.parse({ url: "https://93.184.216.34/", x: 12, y: 34 }) as { viewport: string; includeScreenshot: boolean };
  assert.equal(pointInput.viewport, "desktop");
  assert.equal(pointInput.includeScreenshot, true);
  assert.throws(() => point!.schema!.parse({ url: "https://93.184.216.34/", x: -1, y: 0 }), /Number must be greater than or equal to 0/);
});

test("Browser QA skill exposes visual and 3D visual inspection tools", () => {
  const browserQa = skillRegistry.find((skill) => skill.id === "browser-qa");
  const debug = skillRegistry.find((skill) => skill.id === "debug");
  assert.ok(browserQa, "browser-qa skill registered");
  assert.ok(browserQa!.toolNames.includes("analyze_webpage_visual"));
  assert.ok(browserQa!.toolNames.includes("inspect_3d_scene_visuals"));
  assert.ok(browserQa!.toolNames.includes("inspect_dom_at_point"));
  assert.ok(debug?.toolNames.includes("inspect_3d_scene_visuals"));
});

test("run_project_fix_loop applies a patch and validates without browser inspection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fix-loop-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Fix loop page", createdByClientId: "coder" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><html><head><title>Loop</title></head><body><main><h1>Broken copy</h1></main></body></html>");

    const loop = getToolModule("run_project_fix_loop");
    assert.ok(loop, "run_project_fix_loop registered");
    const result = await loop!.handler({
      projectId: project.id,
      browserValidation: false,
      fixes: [{
        relativePath: "index.html",
        operations: [{ find: "Broken copy", replace: "Fixed copy" }]
      }]
    }, ctx);

    assert.equal(result.ok, true);
    assert.equal((result.structuredContent as { stopReason: string }).stopReason, "passed");
    assert.match(await readProjectFile(ctx.projectRoot, project.id, "index.html"), /Fixed copy/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
