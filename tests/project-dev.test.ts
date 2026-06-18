import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject, getProjectManifest } from "../src/projects/store.js";

const execFileAsync = promisify(execFile);

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: path.join(root, "default-workspace"),
    commandTimeoutMs: 10000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    projectRoot: path.join(root, "projects"),
    clientId: "test-client"
  };
}

test("project workspace binding lets git_status inspect a real bound repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-project-dev-"));
  try {
    const ctx = toolContext(root);
    const repo = path.join(root, "repo");
    const project = await createProject(ctx.projectRoot, {
      title: "Repo backed project",
      createdByClientId: "test-client"
    });

    await execFileAsync("git", ["init", repo]);
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
    const repo = path.join(root, "repo");
    const project = await createProject(ctx.projectRoot, {
      title: "Searchable project",
      createdByClientId: "test-client"
    });

    await execFileAsync("git", ["init", repo]);
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

test("workspace asset tools can add model assets and publish them from dist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-project-dev-"));
  try {
    const ctx = toolContext(root);
    const repo = path.join(root, "repo");
    const project = await createProject(ctx.projectRoot, {
      title: "Asset backed project",
      createdByClientId: "test-client"
    });
    const glbBytes = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16)]);

    await execFileAsync("git", ["init", repo]);
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
