import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createProject,
  deleteProject,
  forkProject,
  getProjectFileContentType,
  getProjectManifest,
  importProjectAssetFromLocalFile,
  patchProjectFile,
  publishProject,
  readProjectFile,
  readProjectFilePartial,
  writeProjectAsset,
  writeProjectFile
} from "../src/projects/store.js";
import { buildProjectPublishOptions, publishBaseUrlForShareAccess } from "../src/projects/publish-policy.js";
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

test("writeProjectFile accepts web app manifests", async () => {
  await withProject(async (root, projectId) => {
    const file = await writeProjectFile(root, projectId, "site.webmanifest", JSON.stringify({ name: "Demo", start_url: "/" }));
    assert.equal(file.path, "site.webmanifest");
    assert.equal(await readProjectFile(root, projectId, "site.webmanifest"), "{\"name\":\"Demo\",\"start_url\":\"/\"}");
    assert.equal(getProjectFileContentType("site.webmanifest"), "application/manifest+json");
  });
});

test("writeProjectFile and patchProjectFile reject unsafe SVG text content", async () => {
  await withProject(async (root, projectId) => {
    await assert.rejects(
      writeProjectFile(root, projectId, "icons/bad.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"),
      /SVG assets must not contain script tags/
    );

    const original = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\"/></svg>";
    await writeProjectFile(root, projectId, "icons/good.svg", original);
    await assert.rejects(
      patchProjectFile(root, projectId, "icons/good.svg", [{ find: "</svg>", replace: "<script>alert(1)</script></svg>" }]),
      /SVG assets must not contain script tags/
    );
    assert.equal(await readProjectFile(root, projectId, "icons/good.svg"), original);
  });
});

test("readProjectFilePartial truncates oversized files instead of throwing", async () => {
  await withProject(async (root, projectId) => {
    const body = "A".repeat(10000);
    await writeProjectFile(root, projectId, "big.txt", body);

    const full = await readProjectFilePartial(root, projectId, "big.txt");
    assert.equal(full.truncated, false);
    assert.equal(full.size, 10000);
    assert.equal(full.content.length, 10000);

    const partial = await readProjectFilePartial(root, projectId, "big.txt", 3000);
    assert.equal(partial.truncated, true);
    assert.equal(partial.size, 10000);
    assert.equal(Buffer.byteLength(partial.content, "utf8"), 3000);
  });
});

test("read_project_file tool returns truncated content instead of failing", async () => {
  await withProject(async (root, projectId) => {
    await writeProjectFile(root, projectId, "big.txt", "B".repeat(10000));
    const tool = projectTools.find((item) => item.definition.name === "read_project_file");
    assert.ok(tool);
    const ctx: ToolContext = {
      publicBaseUrl: "https://example.test",
      workspaceRoot: root,
      commandTimeoutMs: 1000,
      shareRoot: path.join(root, "shares"),
      artifactRoot: path.join(root, "artifacts"),
      feedbackRoot: path.join(root, "feedback"),
      projectRoot: root,
      userId: "test-user"
    } as ToolContext;
    const result = await tool.handler({ projectId, relativePath: "big.txt", maxBytes: 3000 }, ctx);
    assert.equal(result.ok, true);
    assert.match(result.summary, /truncated/);
    assert.equal((result.structuredContent as { truncated: boolean }).truncated, true);
    assert.equal((result.logs?.[0] ?? "").length, 3000);
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
      artifactRoot: path.join(root, "artifacts"),
      feedbackRoot: path.join(root, "feedback"),
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
      artifactRoot: path.join(root, "artifacts"),
      feedbackRoot: path.join(root, "feedback"),
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

test("importProjectAssetFromLocalFile copies a generated local file into project assets", async () => {
  await withProject(async (root, projectId) => {
    const sourcePath = path.join(root, "runtime-character.png");
    await writeFile(sourcePath, pngBytes);

    const file = await importProjectAssetFromLocalFile(root, projectId, "assets/character.png", sourcePath, "image/png");
    assert.equal(file.path, "assets/character.png");

    const manifest = await getProjectManifest(root, projectId);
    assert.equal(manifest.files.some((item) => item.path === "assets/character.png"), true);
    assert.equal(manifest.taskHistory.at(-1)?.toolName, "write_project_asset");
  });
});

test("import_project_asset_from_local_file tool resolves workspace-relative sources", async () => {
  const tool = projectTools.find((item) => item.definition.name === "import_project_asset_from_local_file");
  assert.ok(tool);
  await withProject(async (root, projectId) => {
    await writeFile(path.join(root, "character.png"), pngBytes);
    const ctx: ToolContext = {
      publicBaseUrl: "https://example.test",
      workspaceRoot: root,
      commandTimeoutMs: 1000,
      shareRoot: path.join(root, "shares"),
      artifactRoot: path.join(root, "artifacts"),
      feedbackRoot: path.join(root, "feedback"),
      projectRoot: root,
      clientId: "test-client"
    };

    const result = await tool.handler({
      projectId,
      relativePath: "assets/character.png",
      sourcePath: "character.png",
      contentType: "image/png"
    }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts, ["assets/character.png"]);
  });
});

test("patchProjectFile applies exact replacements without rewriting the whole project", async () => {
  await withProject(async (root, projectId) => {
    await writeProjectFile(root, projectId, "index.html", "<h1>Hello</h1><p>Hello</p>");

    const file = await patchProjectFile(root, projectId, "index.html", [
      { find: "Hello", replace: "Hi" },
      { find: "</p>", replace: "</p><script src=\"app.js\"></script>" }
    ]);

    assert.equal(file.path, "index.html");
    assert.equal(await readProjectFile(root, projectId, "index.html"), "<h1>Hi</h1><p>Hello</p><script src=\"app.js\"></script>");
    const manifest = await getProjectManifest(root, projectId);
    assert.equal(manifest.taskHistory.at(-1)?.toolName, "patch_project_file");
    await assert.rejects(patchProjectFile(root, projectId, "index.html", [{ find: "Missing", replace: "x" }]), /not found/);
  });
});

test("forkProject creates a draft copy with the same files and no published URL", async () => {
  await withProject(async (root, projectId) => {
    await writeProjectFile(root, projectId, "index.html", "<!doctype html><html><body>V1</body></html>");
    await publishProject(root, projectId, "https://example.test");

    const fork = await forkProject(root, projectId, {
      title: "Asset test V2",
      createdByClientId: "test-client"
    });

    assert.notEqual(fork.id, projectId);
    assert.equal(fork.status, "draft");
    assert.equal(fork.publishedUrl, undefined);
    assert.equal(await readProjectFile(root, fork.id, "index.html"), "<!doctype html><html><body>V1</body></html>");
  });
});

test("publishProject keeps stable preview URLs", async () => {
  await withProject(async (root, projectId) => {
    await writeProjectFile(root, projectId, "index.html", "<!doctype html><html><body>Cache safe</body></html>");

    const published = await publishProject(root, projectId, "https://example.test");

    assert.equal(published.publishedUrl, `https://example.test/share/${projectId}/index.html`);
    assert.equal(published.shareAccess, "anyone_with_link");
  });
});

test("new projects are link-shared by default and remain link-shared when explicitly requested", async () => {
  await withProject(async (root, projectId) => {
    const manifest = await getProjectManifest(root, projectId);
    assert.equal(manifest.metadata.shareAccess, "anyone_with_link");

    await writeProjectFile(root, projectId, "index.html", "<!doctype html><html><body>Shareable</body></html>");
    const published = await publishProject(root, projectId, "https://example.test", "index.html", {
      shareAccess: "anyone_with_link"
    });

    assert.equal(published.publishedUrl, `https://example.test/share/${projectId}/index.html`);
    assert.equal(published.shareAccess, "anyone_with_link");
  });
});

test("publishProject can be explicitly private", async () => {
  await withProject(async (root, projectId) => {
    await writeProjectFile(root, projectId, "index.html", "<!doctype html><html><body>Private</body></html>");

    const published = await publishProject(root, projectId, "https://content.example.test", "index.html", {
      privateBaseUrl: "https://example.test",
      shareAccess: "private"
    });

    assert.equal(published.publishedUrl, `https://example.test/share/${projectId}/index.html`);
    assert.equal(published.shareAccess, "private");
  });
});

test("publishProject can use a username share base path", async () => {
  await withProject(async (root, projectId) => {
    await writeProjectFile(root, projectId, "index.html", "<!doctype html><html><body>Named</body></html>");

    const published = await publishProject(root, projectId, "https://example.test", "index.html", { shareBasePath: "/@demo_user/share" });

    assert.equal(published.publishedUrl, `https://example.test/@demo_user/share/${projectId}/index.html`);
  });
});

test("publish policy centralizes public and private base URL selection", () => {
  const context = {
    publicBaseUrl: "https://app.example.test",
    contentBaseUrl: "https://content.example.test",
    publicShareBasePath: "/@demo_user/share"
  };

  assert.equal(publishBaseUrlForShareAccess(context, "anyone_with_link"), "https://content.example.test");
  assert.equal(publishBaseUrlForShareAccess(context, "private"), "https://app.example.test");
  assert.equal(publishBaseUrlForShareAccess(context, undefined), "https://app.example.test");

  const policy = buildProjectPublishOptions(context);
  assert.equal(policy.publicBaseUrl, "https://content.example.test");
  assert.deepEqual(policy.options, {
    privateBaseUrl: "https://app.example.test",
    shareBasePath: "/@demo_user/share",
    shareAccess: "anyone_with_link"
  });
});
