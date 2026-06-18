import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import {
  createProject,
  getProjectManifest,
  getProjectStoredFilePath
} from "../src/projects/store.js";

async function withContext<T>(run: (ctx: ToolContext) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-presentations-"));
  try {
    const ctx: ToolContext = {
      publicBaseUrl: "https://example.test",
      workspaceRoot: root,
      commandTimeoutMs: 1000,
      shareRoot: path.join(root, "shares"),
      projectRoot: path.join(root, "projects"),
      clientId: "test-client"
    };
    return await run(ctx);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("create_html_deck creates and publishes a reveal.js project", async () => {
  await withContext(async (ctx) => {
    const result = await callTool("create_html_deck", {
      title: "Quarterly Review",
      summary: "Executive deck",
      theme: "executive",
      publish: true,
      slides: [
        { layout: "title", title: "Quarterly Review", body: "Q2 operating narrative" },
        { layout: "content", title: "Priorities", bullets: ["Revenue quality", "Operational focus"] }
      ]
    }, ctx);

    assert.equal(result.ok, true);
    assert.ok(result.jobId);
    assert.equal(result.shareUrl, `https://example.test/share/${result.jobId}/index.html`);

    const manifest = await getProjectManifest(ctx.projectRoot, result.jobId);
    assert.ok(manifest.files.some((file) => file.path === "index.html"));
    assert.ok(manifest.files.some((file) => file.path === "slides.css"));
    assert.ok(manifest.files.some((file) => file.path === "vendor/reveal/reveal.js"));

    const indexPath = await getProjectStoredFilePath(ctx.projectRoot, result.jobId, "index.html");
    const indexHtml = await readFile(indexPath, "utf8");
    assert.match(indexHtml, /vendor\/reveal\/reveal\.js/);

    const imageResult = await callTool("create_html_deck", {
      title: "Visual Deck",
      publish: false,
      slides: [
        { layout: "image", title: "Hero", imagePath: "assets/hero.png", notes: "Discuss the visual theme." }
      ]
    }, ctx);
    assert.equal(imageResult.ok, true);
    assert.ok(imageResult.jobId);
    const imageIndexPath = await getProjectStoredFilePath(ctx.projectRoot, imageResult.jobId, "index.html");
    const imageIndexHtml = await readFile(imageIndexPath, "utf8");
    assert.match(imageIndexHtml, /assets\/hero\.png/);
  });
});

test("create_pptx_deck creates a valid PPTX asset", async () => {
  await withContext(async (ctx) => {
    const result = await callTool("create_pptx_deck", {
      title: "Product Plan",
      outputPath: "deck.pptx",
      slides: [
        { layout: "title", title: "Product Plan", body: "Roadmap and risks" },
        { layout: "table", title: "Milestones", table: { headers: ["Phase", "Owner"], rows: [["Alpha", "Team A"], ["Beta", "Team B"]] } }
      ]
    }, ctx);

    assert.equal(result.ok, true);
    assert.ok(result.jobId);
    assert.deepEqual(result.artifacts, ["deck.pptx"]);

    const deckPath = await getProjectStoredFilePath(ctx.projectRoot, result.jobId, "deck.pptx");
    const deck = await readFile(deckPath);
    assert.equal(deck[0], 0x50);
    assert.equal(deck[1], 0x4b);
  });
});

test("create_pptx_deck rejects missing image assets", async () => {
  await withContext(async (ctx) => {
    const project = await createProject(ctx.projectRoot, {
      title: "PPTX image test",
      createdByClientId: "test-client"
    });
    const result = await callTool("create_pptx_deck", {
      projectId: project.id,
      title: "Image deck",
      slides: [
        { layout: "image", title: "Missing", imagePath: "assets/missing.png" }
      ]
    }, ctx);

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /ENOENT|no such file|missing/i);
  });
});

test("create_immersive_page creates a publishable HTML project with local Three.js when enabled", async () => {
  await withContext(async (ctx) => {
    const result = await callTool("create_immersive_page", {
      title: "Interactive Product Story",
      style: "product_demo",
      enableThreeJs: true,
      publish: true,
      sections: [
        { kind: "hero", title: "Interactive Product Story", body: "A visual walkthrough." },
        { kind: "callout", title: "Signal", body: "Fast, polished, and reusable." }
      ]
    }, ctx);

    assert.equal(result.ok, true);
    assert.ok(result.jobId);
    const manifest = await getProjectManifest(ctx.projectRoot, result.jobId);
    assert.ok(manifest.files.some((file) => file.path === "vendor/three/three.min.js"));
    assert.ok(manifest.files.some((file) => file.path === "page.js"));
    assert.equal(result.shareUrl, `https://example.test/share/${result.jobId}/index.html`);
  });
});

test("create_video_presentation stays private by default and publishes only when asked", async () => {
  await withContext(async (ctx) => {
    // Default: must NOT publish (privacy — videos can contain sensitive footage).
    const result = await callTool("create_video_presentation", {
      title: "Video pitch",
      aspectRatio: "16:9",
      fps: 30,
      scenes: [
        { title: "Open", body: "Intro", durationSeconds: 3, transition: "fade" }
      ]
    }, ctx);

    assert.equal(result.ok, true);
    assert.ok(result.jobId);
    assert.equal(result.shareUrl, undefined, "video must not be published by default");
    assert.equal(result.previewUrl, undefined);
    assert.doesNotMatch(result.summary, /published/i);
    assert.match(result.summary, /WebCodecs/);

    // Opt-in: publish=true returns a share URL.
    const publishedResult = await callTool("create_video_presentation", {
      title: "Public video",
      scenes: [{ title: "Open", body: "Intro", durationSeconds: 3, transition: "fade" }],
      publish: true
    }, ctx);
    assert.equal(publishedResult.shareUrl, `https://example.test/share/${publishedResult.jobId}/index.html`);
    assert.match(publishedResult.summary, /published/i);
    assert.doesNotMatch(`${result.summary}\n${result.errors.join("\n")}`, new RegExp(`Rem${"otion"}|VIDEO_RENDER_${"ENABLED"}`));

    const manifest = await getProjectManifest(ctx.projectRoot, result.jobId);
    assert.ok(manifest.files.some((file) => file.path === "index.html"));
    assert.ok(manifest.files.some((file) => file.path === "video.css"));
    assert.ok(manifest.files.some((file) => file.path === "video.js"));
    assert.ok(manifest.files.some((file) => file.path === "vendor/mp4-muxer/mp4-muxer.mjs"));

    const indexPath = await getProjectStoredFilePath(ctx.projectRoot, result.jobId, "index.html");
    const indexHtml = await readFile(indexPath, "utf8");
    assert.match(indexHtml, /Export MP4/);
    assert.match(indexHtml, /audio preview only/i);

    const scriptPath = await getProjectStoredFilePath(ctx.projectRoot, result.jobId, "video.js");
    const script = await readFile(scriptPath, "utf8");
    assert.match(script, /VideoEncoder/);
    assert.match(script, /mp4-muxer/);
  });
});
