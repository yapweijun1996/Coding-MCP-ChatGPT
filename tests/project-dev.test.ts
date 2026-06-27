import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { bindProjectWorkspace, createProject, getProjectManifest, getProjectWorkspaceDirectory, readProjectFile, writeProjectAsset } from "../src/projects/store.js";

const execFileAsync = promisify(execFile);

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: path.join(root, "default-workspace"),
    commandTimeoutMs: 10000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "test-client"
  };
}

async function createRepoInsideWorkspace(ctx: ToolContext, name: string): Promise<string> {
  await mkdir(ctx.workspaceRoot, { recursive: true });
  const repo = path.join(ctx.workspaceRoot, name);
  await execFileAsync("git", ["init", repo]);
  return repo;
}

function tinyWav(): Buffer {
  return Buffer.from("RIFF$\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00D\xac\x00\x00\x88X\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00", "binary");
}

test("project workspace binding lets git_status inspect a real bound repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-project-dev-"));
  try {
    const ctx = toolContext(root);
    const repo = await createRepoInsideWorkspace(ctx, "repo");
    const project = await createProject(ctx.projectRoot, {
      title: "Repo backed project",
      createdByClientId: "test-client"
    });

    const realRepo = await realpath(repo);
    await writeFile(path.join(repo, "README.md"), "# Demo\n", "utf8");

    const bindResult = await callTool("bind_project_workspace", {
      projectId: project.id,
      workspacePath: repo
    }, ctx);
    assert.equal(bindResult.ok, true);

    const manifest = await getProjectManifest(ctx.projectRoot, project.id);
    assert.equal(manifest.workspaceBinding?.path, realRepo);
    assert.equal(manifest.workspaceBinding?.gitRoot, realRepo);

    const statusResult = await callTool("git_status", { projectId: project.id }, ctx);
    assert.equal(statusResult.ok, true);
    assert.match(statusResult.logs.join("\n"), /\?\? README\.md/);
    assert.deepEqual(statusResult.structuredContent, { cwd: realRepo });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("list_project_files and search_in_project inspect the bound workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-project-dev-"));
  try {
    const ctx = toolContext(root);
    const repo = await createRepoInsideWorkspace(ctx, "repo");
    const project = await createProject(ctx.projectRoot, {
      title: "Searchable project",
      createdByClientId: "test-client"
    });

    await writeFile(path.join(repo, "package.json"), "{\"scripts\":{\"build\":\"vite build\"}}\n", "utf8");
    await writeFile(path.join(repo, "index.html"), "<h1>Bound workspace</h1>\n", "utf8");

    await callTool("bind_project_workspace", { projectId: project.id, workspacePath: repo }, ctx);

    const listResult = await callTool("list_project_files", { projectId: project.id, recursive: true }, ctx);
    assert.equal(listResult.ok, true);
    assert.ok(listResult.artifacts.includes("index.html"));
    assert.ok(listResult.artifacts.includes("package.json"));

    const searchResult = await callTool("search_in_project", { projectId: project.id, query: "Bound workspace" }, ctx);
    assert.equal(searchResult.ok, true);
    assert.match(searchResult.logs.join("\n"), /index\.html/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write_project_workspace_asset rejects a write through an intermediate symlink (sandbox escape)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-project-dev-"));
  try {
    const ctx = toolContext(root);
    const repo = await createRepoInsideWorkspace(ctx, "repo");
    const project = await createProject(ctx.projectRoot, { title: "Symlink guard", createdByClientId: "test-client" });
    await callTool("bind_project_workspace", { projectId: project.id, workspacePath: repo }, ctx);

    // Plant a symlink inside the workspace that points OUTSIDE it, then try to write through it.
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(repo, "evil"));
    const glb = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16)]);

    const result = await callTool("write_project_workspace_asset", {
      projectId: project.id,
      relativePath: "evil/model.glb",
      contentBase64: glb.toString("base64")
    }, ctx);
    assert.equal(result.ok, false, "the symlink-escaping write must be rejected");
    assert.match(`${result.summary} ${(result.errors ?? []).join(" ")}`, /outside the bound project workspace/);
    // And nothing escaped to the outside directory.
    await assert.rejects(() => stat(path.join(outside, "model.glb")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace asset tools can add model assets and publish them from dist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-project-dev-"));
  try {
    const ctx = toolContext(root);
    const repo = await createRepoInsideWorkspace(ctx, "repo");
    const project = await createProject(ctx.projectRoot, {
      title: "Asset backed project",
      createdByClientId: "test-client"
    });
    const glbBytes = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16)]);

    await callTool("bind_project_workspace", { projectId: project.id, workspacePath: repo }, ctx);

    const writeAssetResult = await callTool("write_project_workspace_asset", {
      projectId: project.id,
      relativePath: "src/assets/model.glb",
      contentBase64: glbBytes.toString("base64")
    }, ctx);
    assert.equal(writeAssetResult.ok, true);
    assert.ok(writeAssetResult.artifacts.includes("src/assets/model.glb"));

    await execFileAsync("mkdir", ["-p", path.join(repo, "dist/assets")]);
    await writeFile(path.join(repo, "dist/index.html"), "<!doctype html><html><body><script type=\"module\" src=\"./app.js\"></script></body></html>", "utf8");
    await writeFile(path.join(repo, "dist/app.js"), "fetch('./assets/model.glb');\n", "utf8");
    await writeFile(path.join(repo, "dist/assets/model.glb"), glbBytes);

    const publishResult = await callTool("publish_project_workspace", {
      projectId: project.id,
      outputDir: "dist",
      entryFile: "index.html"
    }, ctx);
    assert.equal(publishResult.ok, true);
    assert.ok(publishResult.artifacts.includes("assets/model.glb"));

    const manifest = await getProjectManifest(ctx.projectRoot, project.id);
    assert.ok(manifest.files.some((file) => file.path === "assets/model.glb"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish_project_dist only replaces files from its previous publish and preserves project media assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-app-publish-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, {
      title: "App publish preserves media",
      createdByClientId: "test-client"
    });
    const workspace = getProjectWorkspaceDirectory(ctx.projectRoot, project.id);
    const dist = path.join(workspace, "dist");

    await writeProjectAsset(ctx.projectRoot, project.id, "music/final.wav", tinyWav(), "audio/wav");
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, "index.html"), "<!doctype html><html><body><script src=\"./old.js\"></script></body></html>", "utf8");
    await writeFile(path.join(dist, "old.js"), "console.log('old');\n", "utf8");

    const firstPublish = await callTool("publish_project_dist", {
      projectId: project.id,
      outputDir: "dist",
      entryFile: "index.html"
    }, ctx);
    assert.equal(firstPublish.ok, true);

    await writeFile(path.join(dist, "index.html"), "<!doctype html><html><body><audio src=\"music/final.wav\" controls></audio><script src=\"./app.js\"></script></body></html>", "utf8");
    await writeFile(path.join(dist, "app.js"), "console.log('new');\n", "utf8");
    await rm(path.join(dist, "old.js"), { force: true });

    const secondPublish = await callTool("publish_project_dist", {
      projectId: project.id,
      outputDir: "dist",
      entryFile: "index.html"
    }, ctx);
    assert.equal(secondPublish.ok, true);
    const payload = secondPublish.structuredContent as { removedFiles: string[] };
    assert.ok(payload.removedFiles.includes("old.js"));

    const manifest = await getProjectManifest(ctx.projectRoot, project.id);
    assert.ok(manifest.files.some((file) => file.path === "index.html"));
    assert.ok(manifest.files.some((file) => file.path === "app.js"));
    assert.ok(manifest.files.some((file) => file.path === "music/final.wav"));
    assert.ok(!manifest.files.some((file) => file.path === "old.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish_project_dist failed replacement preserves previous published app files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-app-publish-fail-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, {
      title: "App publish rollback",
      createdByClientId: "test-client"
    });
    const workspace = getProjectWorkspaceDirectory(ctx.projectRoot, project.id);
    const dist = path.join(workspace, "dist");

    await writeProjectAsset(ctx.projectRoot, project.id, "music/final.wav", tinyWav(), "audio/wav");
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, "index.html"), "<!doctype html><html><body><script src=\"./old.js\"></script></body></html>", "utf8");
    await writeFile(path.join(dist, "old.js"), "console.log('old');\n", "utf8");

    const firstPublish = await callTool("publish_project_dist", {
      projectId: project.id,
      outputDir: "dist",
      entryFile: "index.html"
    }, ctx);
    assert.equal(firstPublish.ok, true);

    await writeFile(path.join(dist, "index.html"), "<!doctype html><html><body><script src=\"./missing.js\"></script></body></html>", "utf8");
    await writeFile(path.join(dist, "app.js"), "console.log('new should not publish');\n", "utf8");
    await rm(path.join(dist, "old.js"), { force: true });

    const failedPublish = await callTool("publish_project_dist", {
      projectId: project.id,
      outputDir: "dist",
      entryFile: "index.html"
    }, ctx);
    assert.equal(failedPublish.ok, false);
    assert.match(failedPublish.errors.join("\n"), /missing\.js/);

    const manifest = await getProjectManifest(ctx.projectRoot, project.id);
    assert.ok(manifest.files.some((file) => file.path === "index.html"));
    assert.ok(manifest.files.some((file) => file.path === "old.js"));
    assert.ok(manifest.files.some((file) => file.path === "music/final.wav"));
    assert.ok(!manifest.files.some((file) => file.path === "app.js"));
    assert.equal(await readProjectFile(ctx.projectRoot, project.id, "index.html"), "<!doctype html><html><body><script src=\"./old.js\"></script></body></html>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish_project_dist invalid asset failure leaves no partially written dist files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-app-publish-invalid-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, {
      title: "App publish invalid asset rollback",
      createdByClientId: "test-client"
    });
    const dist = path.join(getProjectWorkspaceDirectory(ctx.projectRoot, project.id), "dist");

    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, "index.html"), "<!doctype html><html><body><script src=\"./old.js\"></script></body></html>", "utf8");
    await writeFile(path.join(dist, "old.js"), "console.log('old');\n", "utf8");

    const firstPublish = await callTool("publish_project_dist", {
      projectId: project.id,
      outputDir: "dist",
      entryFile: "index.html"
    }, ctx);
    assert.equal(firstPublish.ok, true);

    await writeFile(path.join(dist, "index.html"), "<!doctype html><html><body><img src=\"./zbad.png\"><script src=\"./app.js\"></script></body></html>", "utf8");
    await writeFile(path.join(dist, "app.js"), "console.log('new should not publish');\n", "utf8");
    await writeFile(path.join(dist, "zbad.png"), "not-a-png", "utf8");

    const failedPublish = await callTool("publish_project_dist", {
      projectId: project.id,
      outputDir: "dist",
      entryFile: "index.html"
    }, ctx);
    assert.equal(failedPublish.ok, false);
    assert.match(failedPublish.errors.join("\n"), /PNG asset has invalid magic bytes/);

    const manifest = await getProjectManifest(ctx.projectRoot, project.id);
    assert.ok(manifest.files.some((file) => file.path === "index.html"));
    assert.ok(manifest.files.some((file) => file.path === "old.js"));
    assert.ok(!manifest.files.some((file) => file.path === "app.js"));
    assert.ok(!manifest.files.some((file) => file.path === "zbad.png"));
    assert.equal(await readProjectFile(ctx.projectRoot, project.id, "index.html"), "<!doctype html><html><body><script src=\"./old.js\"></script></body></html>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish_project_dist accepts audio assets bundled in dist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-app-audio-dist-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, {
      title: "App publish audio asset",
      createdByClientId: "test-client"
    });
    const dist = path.join(getProjectWorkspaceDirectory(ctx.projectRoot, project.id), "dist");

    await mkdir(path.join(dist, "audio"), { recursive: true });
    await writeFile(path.join(dist, "index.html"), "<!doctype html><html><body><audio src=\"./audio/track.wav\" controls></audio></body></html>", "utf8");
    await writeFile(path.join(dist, "audio/track.wav"), tinyWav());

    const publish = await callTool("publish_project_dist", {
      projectId: project.id,
      outputDir: "dist",
      entryFile: "index.html"
    }, ctx);
    assert.equal(publish.ok, true);

    const manifest = await getProjectManifest(ctx.projectRoot, project.id);
    assert.ok(manifest.files.some((file) => file.path === "audio/track.wav"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bind_project_workspace rejects repositories outside workspaceRoot and non-git directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-project-dev-"));
  try {
    const ctx = toolContext(root);
    await mkdir(ctx.workspaceRoot, { recursive: true });
    const project = await createProject(ctx.projectRoot, {
      title: "Boundaries",
      createdByClientId: "test-client"
    });

    const outsideRepo = path.join(root, "outside-repo");
    await execFileAsync("git", ["init", outsideRepo]);
    const outsideResult = await callTool("bind_project_workspace", { projectId: project.id, workspacePath: outsideRepo }, ctx);
    assert.equal(outsideResult.ok, false);
    assert.match(outsideResult.errors.join("\n"), /inside the configured workspace root/);

    const nonGit = path.join(ctx.workspaceRoot, "not-git");
    await mkdir(nonGit, { recursive: true });
    const nonGitResult = await callTool("bind_project_workspace", { projectId: project.id, workspacePath: nonGit, requireGit: false }, ctx);
    assert.equal(nonGitResult.ok, false);
    assert.match(nonGitResult.errors.join("\n"), /Git work tree/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace resolvers reject legacy bindings outside workspaceRoot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-project-dev-"));
  try {
    const ctx = toolContext(root);
    await mkdir(ctx.workspaceRoot, { recursive: true });
    const project = await createProject(ctx.projectRoot, {
      title: "Legacy outside binding",
      createdByClientId: "test-client"
    });
    const outsideRepo = path.join(root, "outside-repo");
    await execFileAsync("git", ["init", outsideRepo]);
    await bindProjectWorkspace(ctx.projectRoot, project.id, {
      path: outsideRepo,
      gitRoot: outsideRepo
    });

    const listResult = await callTool("list_project_files", { projectId: project.id }, ctx);
    assert.equal(listResult.ok, false);
    assert.match(listResult.errors.join("\n"), /inside the configured workspace root/);

    const gitResult = await callTool("git_status", { projectId: project.id }, ctx);
    assert.equal(gitResult.ok, false);
    assert.match(gitResult.errors.join("\n"), /inside the configured workspace root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace asset import only reads non-hidden files inside workspaceRoot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-project-dev-"));
  try {
    const ctx = toolContext(root);
    const repo = await createRepoInsideWorkspace(ctx, "repo");
    const project = await createProject(ctx.projectRoot, {
      title: "Asset import boundaries",
      createdByClientId: "test-client"
    });
    await callTool("bind_project_workspace", { projectId: project.id, workspacePath: repo }, ctx);

    await writeFile(path.join(ctx.workspaceRoot, "source.glb"), Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16)]));
    const imported = await callTool("import_project_workspace_asset_from_local_file", {
      projectId: project.id,
      relativePath: "src/assets/source.glb",
      sourcePath: "source.glb"
    }, ctx);
    assert.equal(imported.ok, true);
    assert.equal((imported.structuredContent as { sourcePath?: string }).sourcePath, "source.glb");

    const outsideSource = path.join(root, "secret.glb");
    await writeFile(outsideSource, Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16)]));
    const outside = await callTool("import_project_workspace_asset_from_local_file", {
      projectId: project.id,
      relativePath: "src/assets/secret.glb",
      sourcePath: outsideSource
    }, ctx);
    assert.equal(outside.ok, false);
    assert.match(outside.errors.join("\n"), /inside the configured workspace root/);

    await mkdir(path.join(ctx.workspaceRoot, ".private"), { recursive: true });
    await writeFile(path.join(ctx.workspaceRoot, ".private/hidden.glb"), Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16)]));
    const hidden = await callTool("import_project_workspace_asset_from_local_file", {
      projectId: project.id,
      relativePath: "src/assets/hidden.glb",
      sourcePath: ".private/hidden.glb"
    }, ctx);
    assert.equal(hidden.ok, false);
    assert.match(hidden.errors.join("\n"), /hidden path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run_project_npm_command returns stdout and stderr for failing scripts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-project-dev-"));
  try {
    const ctx = toolContext(root);
    const repo = await createRepoInsideWorkspace(ctx, "repo");
    const project = await createProject(ctx.projectRoot, {
      title: "Failing npm project",
      createdByClientId: "test-client"
    });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e \"console.log('before fail'); console.error('expected failure'); process.exit(7)\""
      }
    }), "utf8");
    await callTool("bind_project_workspace", { projectId: project.id, workspacePath: repo }, ctx);

    const result = await callTool("run_project_npm_command", { projectId: project.id, command: "npm test" }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.logs.join("\n"), /before fail/);
    assert.match(result.logs.join("\n"), /expected failure/);
    assert.equal((result.structuredContent as { exitCode?: number }).exitCode, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run_project_npm_command trims oversized failure messages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-project-dev-"));
  try {
    const ctx = toolContext(root);
    const repo = await createRepoInsideWorkspace(ctx, "repo");
    const project = await createProject(ctx.projectRoot, {
      title: "Noisy failing npm project",
      createdByClientId: "test-client"
    });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e \"process.stdout.write('o'.repeat(65000)); process.stderr.write('e'.repeat(65000)); process.exit(7)\""
      }
    }), "utf8");
    await callTool("bind_project_workspace", { projectId: project.id, workspacePath: repo }, ctx);

    const result = await callTool("run_project_npm_command", { projectId: project.id, command: "npm test" }, ctx);
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].length <= 4100);
    assert.match(result.errors[0], /\[truncated\]/);
    assert.match(result.logs.join("\n"), /o{100}/);
    assert.match(result.logs.join("\n"), /e{100}/);
    assert.equal((result.structuredContent as { exitCode?: number }).exitCode, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeRecordableProject(repo: string): Promise<void> {
  await writeFile(path.join(repo, "package.json"), JSON.stringify({
    scripts: { start: "node server.js" }
  }), "utf8");
  await writeFile(path.join(repo, "server.js"), `
const http = require("node:http");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || "3000");
const html = "<!doctype html><html><head><title>Record</title></head><body><main><h1>Recording</h1></main></body></html>";
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
}).listen(port, host);
`, "utf8");
}

test("record_project_workspace_video records a WebM artifact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-project-dev-"));
  try {
    const ctx = toolContext(root);
    const repo = await createRepoInsideWorkspace(ctx, "repo");
    const project = await createProject(ctx.projectRoot, {
      title: "Video project",
      createdByClientId: "test-client"
    });
    await writeRecordableProject(repo);
    await callTool("bind_project_workspace", { projectId: project.id, workspacePath: repo }, ctx);

    const result = await callTool("record_project_workspace_video", {
      projectId: project.id,
      script: "start",
      port: 43123,
      durationMs: 1000,
      waitAfterLoadMs: 0,
      format: "webm"
    }, ctx);
    assert.equal(result.ok, true);
    assert.match(result.artifacts[0], /\.webm$/);
    assert.match((result.structuredContent as { webmArtifactUrl?: string }).webmArtifactUrl ?? "", /\.webm$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("record_project_workspace_video returns WebM fallback when MP4 conversion fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-project-dev-"));
  const originalFfmpegPath = process.env.FFMPEG_PATH;
  try {
    const ctx = toolContext(root);
    const repo = await createRepoInsideWorkspace(ctx, "repo");
    const project = await createProject(ctx.projectRoot, {
      title: "Video fallback project",
      createdByClientId: "test-client"
    });
    await writeRecordableProject(repo);
    await callTool("bind_project_workspace", { projectId: project.id, workspacePath: repo }, ctx);

    process.env.FFMPEG_PATH = path.join(root, "missing-ffmpeg");

    const result = await callTool("record_project_workspace_video", {
      projectId: project.id,
      script: "start",
      port: 43124,
      durationMs: 1000,
      waitAfterLoadMs: 0,
      format: "mp4"
    }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.artifacts.join("\n"), /\.webm$/);
    assert.match(result.errors.join("\n"), /MP4 conversion failed/);
    assert.match((result.structuredContent as { webmArtifactUrl?: string }).webmArtifactUrl ?? "", /\.webm$/);
  } finally {
    if (originalFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = originalFfmpegPath;
    await rm(root, { recursive: true, force: true });
  }
});
