import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, getProjectStoredFilePath, readProjectFile, writeProjectAsset, writeProjectFile } from "../src/projects/store.js";
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
    clientId: "asset-optimization-test"
  };
}

function chunk(type: string, data: Buffer): Buffer {
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  output.write(type, 4, 4, "ascii");
  data.copy(output, 8);
  output.writeUInt32BE(0, 8 + data.length);
  return output;
}

function pngWithTextChunk(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
    chunk("tEXt", Buffer.from("Comment\0".concat("x".repeat(2000)), "utf8")),
    chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01])),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

test("optimize_project_assets strips PNG metadata, minifies SVG, reports embedded assets, and writes outputs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "asset-optimization-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Asset demo", createdByClientId: "coder" });
    await writeProjectAsset(ctx.projectRoot, project.id, "assets/hero.png", pngWithTextChunk(), "image/png");
    await writeProjectAsset(ctx.projectRoot, project.id, "icons/logo.svg", Buffer.from(`<svg viewBox="0 0 10 10">
  <!-- generated comment -->
  <title>Logo</title>
  <rect   width="10"   height="10" />
</svg>
`, "utf8"), "image/svg+xml");
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", `<img src="data:image/png;base64,${Buffer.alloc(12 * 1024).toString("base64")}">`);

    const result = await callTool("optimize_project_assets", {
      projectId: project.id,
      applyOptimizations: true,
      largeAssetBytes: 1024
    }, ctx);
    assert.equal(result.ok, true);
    assert.ok(result.artifacts.includes("asset-optimization/asset-optimization-report.json"));
    assert.ok(result.artifacts.includes("asset-optimization/asset-optimization-report.md"));
    assert.ok(result.artifacts.includes("optimized-assets/assets/hero.optimized.png"));
    assert.ok(result.artifacts.includes("optimized-assets/icons/logo.optimized.svg"));

    const report = result.structuredContent as {
      totalReductionBytes: number;
      assets: Array<{ path: string; beforeBytes: number; afterBytes: number; optimizedPath?: string; applied: boolean; findings: Array<{ id: string }> }>;
      findings: Array<{ id: string; path: string }>;
    };
    assert.equal(report.assets.length, 2);
    assert.equal(report.totalReductionBytes > 0, true);
    const png = report.assets.find((asset) => asset.path === "assets/hero.png");
    assert.equal(png?.applied, true);
    assert.equal((png?.afterBytes ?? 0) < (png?.beforeBytes ?? 0), true);
    assert.ok(png?.findings.some((finding) => finding.id === "png-metadata-removable"));
    const svg = report.assets.find((asset) => asset.path === "icons/logo.svg");
    assert.equal(svg?.applied, true);
    assert.ok(svg?.findings.some((finding) => finding.id === "svg-minify-available"));
    assert.ok(report.findings.some((finding) => finding.id === "large-embedded-data-uri" && finding.path === "index.html"));

    const optimizedPngPath = await getProjectStoredFilePath(ctx.projectRoot, project.id, "optimized-assets/assets/hero.optimized.png");
    const optimizedPng = await readFile(optimizedPngPath);
    assert.equal(optimizedPng.includes(Buffer.from("Comment", "utf8")), false);
    const markdown = await readProjectFile(ctx.projectRoot, project.id, "asset-optimization/asset-optimization-report.md");
    assert.match(markdown, /# Asset Optimization Report/);
    assert.match(markdown, /png-metadata-removable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optimize_project_assets supports scoped audit without applying changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "asset-optimization-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Scoped assets", createdByClientId: "coder" });
    await writeProjectAsset(ctx.projectRoot, project.id, "assets/photo.jpg", Buffer.from([0xff, 0xd8, 0xff, ...new Array(2048).fill(0), 0xff, 0xd9]), "image/jpeg");
    await writeProjectAsset(ctx.projectRoot, project.id, "assets/skip.png", pngWithTextChunk(), "image/png");

    const result = await callTool("optimize_project_assets", {
      projectId: project.id,
      paths: ["assets/photo.jpg"],
      applyOptimizations: false,
      largeAssetBytes: 1024
    }, ctx);
    assert.equal(result.ok, true);
    const report = result.structuredContent as { assets: Array<{ path: string; optimizedPath?: string; applied: boolean; suggestions: string[] }>; findings: Array<{ id: string }> };
    assert.deepEqual(report.assets.map((asset) => asset.path), ["assets/photo.jpg"]);
    assert.equal(report.assets[0]?.applied, false);
    assert.equal(report.assets[0]?.optimizedPath, undefined);
    assert.ok(report.assets[0]?.suggestions.some((suggestion) => suggestion.includes("WebP/AVIF")));
    assert.ok(report.findings.some((finding) => finding.id === "jpeg-modern-format-candidate"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("asset optimization is exposed through coding and debug skills", () => {
  for (const skillId of ["coding", "debug"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill!.toolNames.includes("optimize_project_assets"), `${skillId} exposes optimize_project_assets`);
  }
});
