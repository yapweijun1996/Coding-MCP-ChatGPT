import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { getProjectManifest, getProjectStoredFilePath } from "../src/projects/store.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: path.join(root, "workspace"),
    commandTimeoutMs: 10000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "test-client"
  };
}

test("video editor project supports uploaded video, SVG scene assets, timeline CRUD, and preview", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-video-editor-"));
  try {
    const ctx = toolContext(root);
    await mkdir(ctx.workspaceRoot, { recursive: true });
    await writeFile(path.join(ctx.workspaceRoot, "clip.mov"), Buffer.from("not-a-real-mov-but-valid-project-media-asset"));

    const projectResult = await callTool("create_video_project", {
      title: "AI Video Edit",
      aspectRatio: "9:16",
      fps: 30
    }, ctx);
    assert.equal(projectResult.ok, true);
    assert.ok(projectResult.jobId);

    const importResult = await callTool("import_video_asset_from_local_file", {
      projectId: projectResult.jobId,
      sourcePath: "clip.mov",
      relativePath: "video-assets/source.mov",
      contentType: "video/quicktime"
    }, ctx);
    assert.equal(importResult.ok, true);
    assert.deepEqual(importResult.artifacts, ["video-assets/source.mov"]);

    const sceneResult = await callTool("create_video_scene_asset", {
      projectId: projectResult.jobId,
      kind: "svg",
      relativePath: "video-scenes/title.svg",
      content: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1080 1920\"><title>Title</title><rect width=\"1080\" height=\"1920\" fill=\"#111\"/><text x=\"80\" y=\"200\" fill=\"#fff\">Launch</text></svg>"
    }, ctx);
    assert.equal(sceneResult.ok, true);

    const timelineResult = await callTool("write_video_timeline", {
      projectId: projectResult.jobId,
      timeline: {
        title: "AI Video Edit",
        aspectRatio: "9:16",
        fps: 30,
        clips: [
          { id: "clip_1", type: "video", assetPath: "video-assets/source.mov", startSeconds: 0, sourceInSeconds: 1, durationSeconds: 4, effects: [{ type: "fade_in" }] },
          { id: "title_1", type: "svg_scene", assetPath: "video-scenes/title.svg", startSeconds: 0, durationSeconds: 2 }
        ]
      }
    }, ctx);
    assert.equal(timelineResult.ok, true);
    const contract = timelineResult.structuredContent?.renderContract as { serverRender?: { unsupportedClips?: Array<{ id: string }> } };
    assert.equal(contract.serverRender?.unsupportedClips?.[0]?.id, "title_1");

    const previewResult = await callTool("preview_video_timeline", {
      projectId: projectResult.jobId
    }, ctx);
    assert.equal(previewResult.ok, true);
    assert.deepEqual(previewResult.artifacts, ["video/preview.html"]);
    const previewPath = await getProjectStoredFilePath(ctx.projectRoot, projectResult.jobId, "video/preview.html");
    const previewHtml = await readFile(previewPath, "utf8");
    assert.match(previewHtml, /video-assets\/source\.mov/);
    assert.match(previewHtml, /video-scenes\/title\.svg/);

    const renderResult = await callTool("render_video_timeline", {
      projectId: projectResult.jobId
    }, ctx);
    assert.equal(renderResult.ok, false);
    assert.match(renderResult.errors.join("\n"), /Unsupported clips: title_1:svg_scene/);

    const manifest = await getProjectManifest(ctx.projectRoot, projectResult.jobId);
    assert.ok(manifest.files.some((file) => file.path === "video-assets/source.mov"));
    assert.ok(manifest.files.some((file) => file.path === "video-scenes/title.svg"));
    assert.ok(manifest.taskHistory.some((item) => item.toolName === "write_video_timeline"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("video timeline validation rejects unsafe asset locations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-video-editor-"));
  try {
    const ctx = toolContext(root);
    const projectResult = await callTool("create_video_project", { title: "Unsafe timeline" }, ctx);
    assert.equal(projectResult.ok, true);

    const result = await callTool("write_video_timeline", {
      projectId: projectResult.jobId,
      timeline: {
        title: "Unsafe timeline",
        clips: [
          { id: "bad", type: "video", assetPath: "../secret.mp4", startSeconds: 0, durationSeconds: 1 }
        ]
      }
    }, ctx);

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /Clip bad must reference a video asset/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
