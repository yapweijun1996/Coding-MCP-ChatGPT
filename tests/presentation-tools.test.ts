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
    const html = await readFile(path.join(ctx.projectRoot, result.jobId, "files/index.html"), "utf8");
    assert.match(html, /<header class="site-header">/);
    assert.match(html, /<nav aria-label="Primary navigation">/);
    assert.match(html, /class="hero"/);
    assert.match(html, /class="cta primary"/);
    assert.doesNotMatch(html, /landing page template|class="sidebar"|Operational Snapshot/i);
  });
});

test("create_immersive_page blocks publishing when landing intent gate fails", async () => {
  await withContext(async (ctx) => {
    const result = await callTool("create_immersive_page", {
      title: "Landing Page Template",
      style: "product_demo",
      brandName: "Template Catalog",
      primaryAction: "Open workspace",
      publish: true,
      sections: [
        { kind: "hero", title: "Landing Page Template", body: "A template checklist shell." },
        { kind: "callout", title: "Operational Snapshot", body: "This should be blocked before publish." }
      ]
    }, ctx);

    assert.equal(result.ok, false);
    assert.ok(result.jobId);
    assert.equal(result.shareUrl, undefined);
    assert.match(result.summary, /publish was blocked by landing intent gate/i);
    assert.match(result.errors.join("\n"), /template catalog|checklist|sidebar/i);
    const manifest = await getProjectManifest(ctx.projectRoot, result.jobId);
    assert.equal(manifest.metadata.status, "draft");
    assert.equal(manifest.publishedUrl, undefined);
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
    assert.match(indexHtml, /Export video-only MP4 preview/);
    assert.match(indexHtml, /Storyboard preview/i);
    assert.match(indexHtml, /no audio mix/i);

    const sc = result.structuredContent as { qualityTier: string; productionReady: boolean };
    assert.equal(sc.qualityTier, "storyboard_preview");
    assert.equal(sc.productionReady, false);

    const scriptPath = await getProjectStoredFilePath(ctx.projectRoot, result.jobId, "video.js");
    const script = await readFile(scriptPath, "utf8");
    assert.match(script, /VideoEncoder/);
    assert.match(script, /mp4-muxer/);
  });
});

test("create_video_presentation supports code and dryrun layouts", async () => {
  await withContext(async (ctx) => {
    const result = await callTool("create_video_presentation", {
      title: "Algorithm walk-through",
      scenes: [
        {
          layout: "title_card",
          title: "Bubble Sort",
          body: "Step-by-step animation",
          durationSeconds: 3
        },
        {
          layout: "code",
          title: "bubbleSort",
          code: "function bubbleSort(arr) {\n  for (let i = 0; i < arr.length; i++) {\n    for (let j = 0; j < arr.length - i - 1; j++) {\n      if (arr[j] > arr[j + 1]) {\n        [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]];\n      }\n    }\n  }\n  return arr;\n}",
          durationSeconds: 6
        },
        {
          layout: "dryrun",
          title: "Pass 1",
          steps: [
            { label: "compare 5,3", array: [5, 3, 8, 1], pointers: [{ label: "j", index: 0 }] },
            { label: "swap → 3,5", array: [3, 5, 8, 1], pointers: [{ label: "j", index: 1 }] },
            { label: "compare 5,8", array: [3, 5, 8, 1], pointers: [{ label: "j", index: 1 }] },
            { label: "compare 8,1", array: [3, 5, 1, 8], pointers: [{ label: "j", index: 2 }] }
          ],
          durationSeconds: 8
        }
      ]
    }, ctx);

    assert.equal(result.ok, true);
    assert.ok(result.jobId);

    const indexPath = await getProjectStoredFilePath(ctx.projectRoot, result.jobId, "index.html");
    const indexHtml = await readFile(indexPath, "utf8");
    assert.match(indexHtml, /video-data/);
    assert.match(indexHtml, /title_card/);
    assert.match(indexHtml, /"layout":"code"/);
    assert.match(indexHtml, /bubbleSort/);
    assert.match(indexHtml, /"layout":"dryrun"/);
    assert.match(indexHtml, /compare 5,3/);

    const scriptPath = await getProjectStoredFilePath(ctx.projectRoot, result.jobId, "video.js");
    const script = await readFile(scriptPath, "utf8");
    assert.match(script, /layout === "code"/);
    assert.match(script, /layout === "dryrun"/);
    assert.match(script, /layout === "title_card"/);
    assert.match(script, /codeLines/);
    assert.match(script, /stepIndex/);
  });
});

test("create_video_presentation supports typewriter and ken_burns layouts", async () => {
  await withContext(async (ctx) => {
    const result = await callTool("create_video_presentation", {
      title: "Motion layouts",
      scenes: [
        {
          layout: "typewriter",
          title: "Quick summary",
          body: "The algorithm runs in O(n²) time. Each pass moves the largest unsorted element to its final position.",
          durationSeconds: 5
        },
        {
          layout: "ken_burns",
          title: "Hero shot",
          body: "Full-bleed image with pan and zoom",
          imagePath: "assets/hero.jpg",
          durationSeconds: 4
        }
      ]
    }, ctx);

    assert.equal(result.ok, true);
    assert.ok(result.jobId);

    const scriptPath = await getProjectStoredFilePath(ctx.projectRoot, result.jobId, "video.js");
    const script = await readFile(scriptPath, "utf8");
    assert.match(script, /layout === "typewriter"/);
    assert.match(script, /layout === "ken_burns"/);
    assert.match(script, /twChars/);
    assert.match(script, /kbScale/);
    assert.doesNotMatch(script, /ken_burns.*if \(image\)/s);

    const indexPath = await getProjectStoredFilePath(ctx.projectRoot, result.jobId, "index.html");
    const indexHtml = await readFile(indexPath, "utf8");
    assert.match(indexHtml, /"layout":"typewriter"/);
    assert.match(indexHtml, /"layout":"ken_burns"/);
    assert.match(indexHtml, /algorithm runs in O/);
  });
});

test("create_video_presentation respects hold and ease timing fields", async () => {
  await withContext(async (ctx) => {
    const result = await callTool("create_video_presentation", {
      title: "Timing control",
      scenes: [
        { layout: "text", title: "Ease in", body: "Slow start", hold: 1, ease: "ease-in", durationSeconds: 4 },
        { layout: "text", title: "Hold end", body: "Hold at end", hold: 2, ease: "ease-out", durationSeconds: 5 }
      ]
    }, ctx);

    assert.equal(result.ok, true);

    const scriptPath = await getProjectStoredFilePath(ctx.projectRoot, result.jobId, "video.js");
    const script = await readFile(scriptPath, "utf8");
    assert.match(script, /applyEase/);
    assert.match(script, /holdSecs/);
    assert.match(script, /animDuration/);

    const indexPath = await getProjectStoredFilePath(ctx.projectRoot, result.jobId, "index.html");
    const indexHtml = await readFile(indexPath, "utf8");
    assert.match(indexHtml, /"hold":1/);
    assert.match(indexHtml, /"ease":"ease-in"/);
  });
});

test("scripted media export workflow creates timeline, captions, audio alignment, frame previews, and export manifest", async () => {
  await withContext(async (ctx) => {
    const project = await createProject(ctx.projectRoot, {
      title: "Media workflow",
      createdByClientId: "test-client"
    });

    const timelineResult = await callTool("create_media_scene_timeline", {
      projectId: project.id,
      title: "Product walkthrough",
      aspectRatio: "16:9",
      fps: 30,
      scenes: [
        { id: "intro", title: "Intro", body: "Open with the product promise.", durationSeconds: 2, transition: "fade" },
        { id: "demo", title: "Demo", body: "Show the workflow from project data.", sourcePath: "assets/demo.png", durationSeconds: 3, transition: "slide" }
      ]
    }, ctx);
    assert.equal(timelineResult.ok, true);
    assert.ok(timelineResult.artifacts.includes("media/timeline.json"));
    const timelinePayload = timelineResult.structuredContent as {
      timelinePath: string;
      totalFrames: number;
      scenes: Array<{ id: string; startFrame: number; endFrame: number }>;
      renderContract: {
        renderer: string;
        openRendererPolicy: {
          commerciallyUsable: boolean;
          paidVideoEngineDependency: boolean;
          softwareDependencies: Array<{ name: string; license: string; commercialUse: boolean }>;
          forbiddenDependencyPolicy: string[];
        };
      };
    };
    assert.equal(timelinePayload.timelinePath, "media/timeline.json");
    assert.equal(timelinePayload.totalFrames, 150);
    assert.equal(timelinePayload.scenes[1].startFrame, 60);
    assert.match(timelinePayload.renderContract.renderer, /Code-MCP/);
    assert.equal(timelinePayload.renderContract.openRendererPolicy.commerciallyUsable, true);
    assert.equal(timelinePayload.renderContract.openRendererPolicy.paidVideoEngineDependency, false);
    assert.ok(timelinePayload.renderContract.openRendererPolicy.softwareDependencies.some((dependency) => dependency.name === "mp4-muxer" && dependency.license === "MIT" && dependency.commercialUse));
    assert.ok(timelinePayload.renderContract.openRendererPolicy.forbiddenDependencyPolicy.some((policy) => /paid video engines/.test(policy)));

    const captionsResult = await callTool("add_media_captions", {
      projectId: project.id,
      timelinePath: timelinePayload.timelinePath,
      transcript: "Open with the product promise. Show the workflow from project data."
    }, ctx);
    assert.equal(captionsResult.ok, true);
    assert.ok(captionsResult.artifacts.includes("media/captions.txt"));
    const captionsPayload = captionsResult.structuredContent as { captionsPath: string; cueCount: number; manifestPath: string };
    assert.equal(captionsPayload.captionsPath, "media/captions.txt");
    assert.equal(captionsPayload.cueCount, 2);
    const vttPath = await getProjectStoredFilePath(ctx.projectRoot, project.id, captionsPayload.captionsPath);
    assert.match(await readFile(vttPath, "utf8"), /WEBVTT/);

    const audioResult = await callTool("attach_media_voice_audio", {
      projectId: project.id,
      timelinePath: timelinePayload.timelinePath,
      audioPath: "assets/voice.wav"
    }, ctx);
    assert.equal(audioResult.ok, true);
    const audioPayload = audioResult.structuredContent as { audioManifestPath: string; alignment: Array<{ startFrame: number; endFrame: number }>; checks: string[] };
    assert.equal(audioPayload.audioManifestPath, "media/audio-alignment.json");
    assert.equal(audioPayload.alignment.length, 2);
    assert.ok(audioPayload.checks.includes("frame_alignment_calculated"));

    const previewResult = await callTool("preview_media_frames", {
      projectId: project.id,
      timelinePath: timelinePayload.timelinePath,
      count: 4
    }, ctx);
    assert.equal(previewResult.ok, true);
    const previewPayload = previewResult.structuredContent as { framePreviewHtmlPath: string; frameCount: number; frames: Array<{ sceneId: string }> };
    assert.equal(previewPayload.framePreviewHtmlPath, "media/frame-preview.html");
    assert.equal(previewPayload.frameCount, 4);
    assert.ok(previewPayload.frames.some((frame) => frame.sceneId === "demo"));
    const previewPath = await getProjectStoredFilePath(ctx.projectRoot, project.id, previewPayload.framePreviewHtmlPath);
    assert.match(await readFile(previewPath, "utf8"), /Frame Preview/);

    const exportResult = await callTool("export_media_project", {
      projectId: project.id,
      timelinePath: timelinePayload.timelinePath,
      captionsPath: captionsPayload.captionsPath,
      audioManifestPath: audioPayload.audioManifestPath,
      framePreviewPath: previewPayload.framePreviewHtmlPath,
      formats: ["mp4", "webm", "gif", "png_sequence", "html_preview"]
    }, ctx);
    assert.equal(exportResult.ok, true);
    const exportPayload = exportResult.structuredContent as {
      exportManifestPath: string;
      exportPlans: Array<{ format: string; status: string; encoder: string }>;
      checks: string[];
      licenseReport: {
        commerciallyUsableWorkflow: boolean;
        paidVideoEngineDependency: boolean;
        allowedDependencyLicenses: string[];
        softwareDependencies: Array<{ name: string; license: string; commercialUse: boolean }>;
      };
    };
    assert.equal(exportPayload.exportManifestPath, "media/export-manifest.json");
    assert.ok(exportPayload.exportPlans.some((plan) => plan.format === "mp4" && /WebCodecs/.test(plan.encoder)));
    assert.ok(exportPayload.exportPlans.some((plan) => plan.format === "html_preview" && plan.status === "ready_from_project_files"));
    assert.ok(exportPayload.checks.includes("encoder_step_explicit"));
    assert.equal(exportPayload.licenseReport.commerciallyUsableWorkflow, true);
    assert.equal(exportPayload.licenseReport.paidVideoEngineDependency, false);
    assert.ok(exportPayload.licenseReport.allowedDependencyLicenses.includes("MIT"));
    assert.ok(exportPayload.licenseReport.softwareDependencies.every((dependency) => dependency.commercialUse));
    assert.doesNotMatch(JSON.stringify(exportPayload), /paid video engine dependency required/i);
  });
});
