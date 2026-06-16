import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createProject,
  deleteProject,
  getProjectManifest,
  readProjectFile,
  writeProjectAsset
} from "../src/projects/store.js";
import { projectTools } from "../src/mcp/tools/project.js";
import type { ToolContext } from "../src/mcp/types.js";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const gifBytes = Buffer.from("GIF89a");
const webpBytes = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);

async function withProject<T>(run: (root: string, projectId: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-assets-"));
  try {
    const project = await createProject(root, {
      title: "Asset test",
      createdByClientId: "test-client"
    });
    return await run(root, project.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("writeProjectAsset writes image assets and records history", async () => {
  await withProject(async (root, projectId) => {
    const file = await writeProjectAsset(root, projectId, "assets/hero.png", pngBytes, "image/png");
    assert.equal(file.path, "assets/hero.png");
    assert.equal(file.size, pngBytes.length);

    await writeProjectAsset(root, projectId, "assets/photo.jpg", jpegBytes, "image/jpeg");
    await writeProjectAsset(root, projectId, "assets/loop.gif", gifBytes, "image/gif");
    await writeProjectAsset(root, projectId, "assets/card.webp", webpBytes, "image/webp");

    const manifest = await getProjectManifest(root, projectId);
    assert.deepEqual(manifest.files.map((item) => item.path), [
      "assets/card.webp",
      "assets/hero.png",
      "assets/loop.gif",
      "assets/photo.jpg"
    ]);
    assert.equal(manifest.taskHistory.at(-1)?.toolName, "write_project_asset");
  });
});

test("writeProjectAsset rejects unsafe paths, invalid magic bytes, and deleted projects", async () => {
  await withProject(async (root, projectId) => {
    await assert.rejects(writeProjectAsset(root, projectId, "../x.png", pngBytes, "image/png"), /Parent traversal/);
    await assert.rejects(writeProjectAsset(root, projectId, "/tmp/x.png", pngBytes, "image/png"), /Absolute/);
    await assert.rejects(writeProjectAsset(root, projectId, "assets/.secret.png", pngBytes, "image/png"), /hidden path/);
    await assert.rejects(writeProjectAsset(root, projectId, "assets/not-png.png", Buffer.from("nope"), "image/png"), /PNG asset has invalid magic bytes/);

    await deleteProject(root, projectId);
    await assert.rejects(writeProjectAsset(root, projectId, "assets/hero.png", pngBytes, "image/png"), /deleted project/);
  });
});

test("readProjectFile remains text-only for binary assets", async () => {
  await withProject(async (root, projectId) => {
    await writeProjectAsset(root, projectId, "assets/hero.png", pngBytes, "image/png");
    await assert.rejects(readProjectFile(root, projectId, "assets/hero.png"), /Unsupported project file extension/);
  });
});

test("write_project_asset tool accepts raw base64 and rejects data URLs", async () => {
  await withProject(async (root, projectId) => {
    const tool = projectTools.find((item) => item.definition.name === "write_project_asset");
    assert.ok(tool);
    const ctx: ToolContext = {
      publicBaseUrl: "https://example.test",
      workspaceRoot: root,
      commandTimeoutMs: 1000,
      shareRoot: path.join(root, "shares"),
      projectRoot: root,
      clientId: "test-client"
    };

    const result = await tool.handler({
      projectId,
      relativePath: "assets/tool.png",
      contentBase64: pngBytes.toString("base64"),
      contentType: "image/png"
    }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts, ["assets/tool.png"]);

    await assert.rejects(tool.handler({
      projectId,
      relativePath: "assets/data-url.png",
      contentBase64: `data:image/png;base64,${pngBytes.toString("base64")}`,
      contentType: "image/png"
    }, ctx), /without a data: URL prefix/);
  });
});

test("import_project_asset_from_url rejects private-network URLs before fetch", async () => {
  const tool = projectTools.find((item) => item.definition.name === "import_project_asset_from_url");
  assert.ok(tool);
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-assets-"));
  try {
    const ctx: ToolContext = {
      publicBaseUrl: "https://example.test",
      workspaceRoot: root,
      commandTimeoutMs: 1000,
      shareRoot: path.join(root, "shares"),
      projectRoot: root,
      clientId: "test-client"
    };
    await assert.rejects(tool.handler({
      projectId: "project_test",
      relativePath: "assets/blocked.png",
      url: "https://127.0.0.1/blocked.png"
    }, ctx), /Private or reserved IP/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
