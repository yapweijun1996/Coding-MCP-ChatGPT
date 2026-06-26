import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { createArtifact, makeArtifactUrl } from "../../artifacts/store.js";
import {
  appendProjectTaskHistory,
  createProject,
  getProjectStoredFilePath,
  importProjectAssetFromLocalFile,
  readProjectFile,
  writeProjectAsset,
  writeProjectFile
} from "../../projects/store.js";
import { childEnv } from "../child-env.js";
import type { ToolContext, ToolModule } from "../types.js";

const execFileAsync = promisify(execFile);
const maxFfmpegLogBytes = 1024 * 1024;
const videoAssetPattern = /^(?:assets|video-assets)\/[a-z0-9][a-z0-9/_-]*\.(?:mp4|webm|mov)$/i;
const sceneAssetPattern = /^video-scenes\/[a-z0-9][a-z0-9/_-]*\.(?:svg|html|js|json)$/i;
const timelinePathPattern = /^video\/[a-z0-9][a-z0-9/_-]*\.json$/i;

const createVideoProjectSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().max(2000).optional().default(""),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional().default("16:9"),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).optional().default(30),
  timelinePath: z.string().regex(timelinePathPattern).optional().default("video/timeline.json")
});

const importVideoAssetSchema = z.object({
  projectId: z.string().min(8).max(80),
  sourcePath: z.string().min(1).max(2000),
  relativePath: z.string().regex(videoAssetPattern),
  contentType: z.enum(["video/mp4", "video/webm", "video/quicktime"]).optional()
});

const probeVideoAssetSchema = z.object({
  projectId: z.string().min(8).max(80),
  assetPath: z.string().regex(videoAssetPattern)
});

const extractVideoFramesSchema = z.object({
  projectId: z.string().min(8).max(80),
  assetPath: z.string().regex(videoAssetPattern),
  timesSeconds: z.array(z.number().min(0)).min(1).max(12),
  width: z.number().int().min(160).max(1920).optional().default(640)
});

const videoSceneAssetSchema = z.object({
  projectId: z.string().min(8).max(80),
  kind: z.enum(["svg", "webgl_html", "webgl_js", "json"]),
  relativePath: z.string().regex(sceneAssetPattern),
  content: z.string().min(1).max(1024 * 1024)
});

const timelineClipSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  type: z.enum(["video", "audio", "caption", "overlay", "svg_scene", "webgl_scene"]),
  assetPath: z.string().min(1).max(240).optional(),
  startSeconds: z.number().min(0),
  durationSeconds: z.number().min(0.05).max(3600),
  sourceInSeconds: z.number().min(0).optional().default(0),
  muted: z.boolean().optional().default(false),
  text: z.string().max(1000).optional(),
  transform: z.object({
    x: z.number().optional(),
    y: z.number().optional(),
    scale: z.number().min(0.01).max(20).optional(),
    opacity: z.number().min(0).max(1).optional(),
    rotation: z.number().optional()
  }).optional(),
  effects: z.array(z.object({
    type: z.enum(["fade_in", "fade_out", "crop", "blur", "color", "volume", "subtitle"]),
    params: z.record(z.unknown()).optional().default({})
  })).max(20).optional().default([])
});

const videoTimelineSchema = z.object({
  version: z.literal(1).optional().default(1),
  title: z.string().min(1).max(160),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional().default("16:9"),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).optional().default(30),
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(320).max(3840).optional(),
  clips: z.array(timelineClipSchema).max(200)
});

const writeVideoTimelineSchema = z.object({
  projectId: z.string().min(8).max(80),
  timelinePath: z.string().regex(timelinePathPattern).optional().default("video/timeline.json"),
  timeline: videoTimelineSchema
});

const previewVideoTimelineSchema = z.object({
  projectId: z.string().min(8).max(80),
  timelinePath: z.string().regex(timelinePathPattern).optional().default("video/timeline.json"),
  outputHtmlPath: z.string().regex(/^video\/[a-z0-9][a-z0-9/_-]*\.html$/i).optional().default("video/preview.html")
});

const renderVideoTimelineSchema = z.object({
  projectId: z.string().min(8).max(80),
  timelinePath: z.string().regex(timelinePathPattern).optional().default("video/timeline.json"),
  format: z.enum(["mp4", "webm"]).optional().default("mp4"),
  includeAudio: z.literal(false).optional().default(false),
  timeoutMs: z.number().int().min(10000).max(900000).optional().default(300000)
});

type VideoTimeline = z.infer<typeof videoTimelineSchema>;
type TimelineClip = z.infer<typeof timelineClipSchema>;

function resolveLocalSourcePath(workspaceRoot: string, sourcePath: string): string {
  const resolved = path.isAbsolute(sourcePath) ? path.resolve(sourcePath) : path.resolve(workspaceRoot, sourcePath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Source path must be inside the workspace directory.");
  }
  return resolved;
}

function dimensionsForTimeline(timeline: Pick<VideoTimeline, "aspectRatio" | "width" | "height">): { width: number; height: number } {
  if (timeline.width && timeline.height) return { width: timeline.width, height: timeline.height };
  if (timeline.aspectRatio === "9:16") return { width: 1080, height: 1920 };
  if (timeline.aspectRatio === "1:1") return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

function timelineDuration(clips: TimelineClip[]): number {
  return clips.reduce((max, clip) => Math.max(max, clip.startSeconds + clip.durationSeconds), 0);
}

function validateTimelineForProject(timeline: VideoTimeline): string[] {
  const errors: string[] = [];
  for (const clip of timeline.clips) {
    if ((clip.type === "video" || clip.type === "audio") && (!clip.assetPath || !videoAssetPattern.test(clip.assetPath))) {
      errors.push(`Clip ${clip.id} must reference a video asset under assets/ or video-assets/.`);
    }
    if ((clip.type === "svg_scene" || clip.type === "webgl_scene") && (!clip.assetPath || !sceneAssetPattern.test(clip.assetPath))) {
      errors.push(`Clip ${clip.id} must reference a scene asset under video-scenes/.`);
    }
  }
  return errors;
}

function readTimelinePayload(content: string): VideoTimeline {
  return videoTimelineSchema.parse(JSON.parse(content));
}

function escapeHtml(value: string | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function renderPreviewHtml(timeline: VideoTimeline): string {
  const { width, height } = dimensionsForTimeline(timeline);
  const clips = timeline.clips.slice().sort((left, right) => left.startSeconds - right.startSeconds);
  const rows = clips.map((clip) => {
    const asset = clip.assetPath ? `<code>${escapeHtml(clip.assetPath)}</code>` : "";
    return `<tr><td>${escapeHtml(clip.id)}</td><td>${escapeHtml(clip.type)}</td><td>${clip.startSeconds.toFixed(2)}s</td><td>${clip.durationSeconds.toFixed(2)}s</td><td>${asset}</td></tr>`;
  }).join("\n");
  const firstVideo = clips.find((clip) => clip.type === "video" && clip.assetPath);
  const sceneClips = clips.filter((clip) => clip.type === "svg_scene" || clip.type === "webgl_scene");
  const sceneList = sceneClips.map((clip) => `<li><strong>${escapeHtml(clip.id)}</strong> ${escapeHtml(clip.type)} ${clip.assetPath ? `<a href="../${escapeHtml(clip.assetPath)}">${escapeHtml(clip.assetPath)}</a>` : ""}</li>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(timeline.title)} Preview</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#151716;color:#f5f2e8}
    body{margin:0;padding:24px;display:grid;gap:20px}
    main{max-width:1180px;margin:0 auto;width:100%;display:grid;gap:20px}
    .stage{aspect-ratio:${width}/${height};background:#050606;border:1px solid #3d453f;display:grid;place-items:center;overflow:hidden}
    video{width:100%;height:100%;object-fit:contain}
    table{width:100%;border-collapse:collapse;background:#20231f}
    th,td{border-bottom:1px solid #363d38;padding:10px;text-align:left;font-size:14px}
    code{color:#a6e3b5}
  </style>
</head>
<body>
<main>
  <header>
    <h1>${escapeHtml(timeline.title)}</h1>
    <p>${timelineDuration(clips).toFixed(2)}s, ${timeline.fps}fps, ${width}x${height}</p>
  </header>
  <section class="stage">${firstVideo?.assetPath ? `<video src="../${escapeHtml(firstVideo.assetPath)}" controls></video>` : `<p>No video clip on the primary preview track.</p>`}</section>
  ${sceneClips.length ? `<section><h2>Scene Assets</h2><ul>${sceneList}</ul></section>` : ""}
  <section>
    <h2>Timeline</h2>
    <table><thead><tr><th>Clip</th><th>Type</th><th>Start</th><th>Duration</th><th>Asset</th></tr></thead><tbody>${rows}</tbody></table>
  </section>
  <script type="application/json" id="timeline-data">${jsonForScript(timeline)}</script>
</main>
</body>
</html>
`;
}

function renderContract(timeline: VideoTimeline): Record<string, unknown> {
  const { width, height } = dimensionsForTimeline(timeline);
  const unsupportedForServerRender = timeline.clips
    .filter((clip) => clip.type !== "video")
    .map((clip) => ({ id: clip.id, type: clip.type }));
  return {
    renderer: "Code-MCP video-editor MVP",
    width,
    height,
    fps: timeline.fps,
    durationSeconds: timelineDuration(timeline.clips),
    serverRender: {
      supported: "sequential video clip trimming and concatenation through ffmpeg",
      noAudioInMvp: true,
      unsupportedClips: unsupportedForServerRender
    },
    browserPreview: {
      supportsVideoAssets: true,
      supportsSvgAndWebglSceneReferences: true
    }
  };
}

async function runFfprobe(filePath: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.env.FFPROBE_PATH || "ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath
  ], {
    timeout: 30000,
    maxBuffer: maxFfmpegLogBytes,
    env: childEnv()
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

function ffmpegExecutable(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

function renderExtension(format: "mp4" | "webm"): string {
  return format === "mp4" ? ".mp4" : ".webm";
}

function renderContentType(format: "mp4" | "webm"): string {
  return format === "mp4" ? "video/mp4" : "video/webm";
}

function renderOutputArgs(format: "mp4" | "webm", fps: number): string[] {
  if (format === "webm") return ["-map", "[outv]", "-r", String(fps), "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p"];
  return ["-map", "[outv]", "-r", String(fps), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "faststart"];
}

function buildVideoOnlyRenderArgs(inputPaths: string[], clips: TimelineClip[], timeline: VideoTimeline, outputPath: string, format: "mp4" | "webm"): string[] {
  const { width, height } = dimensionsForTimeline(timeline);
  const args = ["-y"];
  for (const inputPath of inputPaths) args.push("-i", inputPath);
  const filterParts = clips.map((clip, index) => {
    const sourceIn = clip.sourceInSeconds ?? 0;
    const fadeIn = clip.effects.some((effect) => effect.type === "fade_in") ? `,fade=t=in:st=0:d=${Math.min(0.5, clip.durationSeconds / 2)}` : "";
    const fadeOut = clip.effects.some((effect) => effect.type === "fade_out") ? `,fade=t=out:st=${Math.max(0, clip.durationSeconds - 0.5)}:d=${Math.min(0.5, clip.durationSeconds / 2)}` : "";
    return `[${index}:v]trim=start=${sourceIn}:duration=${clip.durationSeconds},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1${fadeIn}${fadeOut}[v${index}]`;
  });
  const concatInputs = clips.map((_, index) => `[v${index}]`).join("");
  args.push("-filter_complex", `${filterParts.join(";")};${concatInputs}concat=n=${clips.length}:v=1:a=0[outv]`);
  args.push(...renderOutputArgs(format, timeline.fps), outputPath);
  return args;
}

async function timelineFromProject(ctx: ToolContext, projectId: string, timelinePath: string): Promise<VideoTimeline> {
  return readTimelinePayload(await readProjectFile(ctx.projectRoot, projectId, timelinePath));
}

export const videoEditorTools: ToolModule[] = [
  {
    definition: {
      name: "create_video_project",
      description: "Create a project-local AI-operable video editor project with an initial timeline JSON and preview entry file.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, summary: { type: "string" }, aspectRatio: { type: "string" }, fps: { type: "number" }, timelinePath: { type: "string" } },
        required: ["title"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: createVideoProjectSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof createVideoProjectSchema>;
      const project = await createProject(ctx.projectRoot, {
        title: parsed.title,
        summary: parsed.summary,
        createdByClientId: ctx.clientId,
        entryFile: "video/preview.html"
      });
      const timeline: VideoTimeline = {
        version: 1,
        title: parsed.title,
        aspectRatio: parsed.aspectRatio,
        fps: parsed.fps,
        clips: []
      };
      await writeProjectFile(ctx.projectRoot, project.id, parsed.timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
      await writeProjectFile(ctx.projectRoot, project.id, "video/preview.html", renderPreviewHtml({ ...timeline, clips: [{ id: "empty", type: "caption", startSeconds: 0, durationSeconds: 1, text: "Add clips to this video project.", muted: false, sourceInSeconds: 0, effects: [] }] }));
      await appendProjectTaskHistory(ctx.projectRoot, project.id, {
        toolName: "create_video_project",
        ok: true,
        summary: `Created video project ${project.id}.`,
        details: { timelinePath: parsed.timelinePath, aspectRatio: parsed.aspectRatio, fps: parsed.fps }
      });
      return {
        ok: true,
        summary: `Created video project ${project.id}.`,
        jobId: project.id,
        artifacts: [parsed.timelinePath, "video/preview.html"],
        structuredContent: { projectId: project.id, timelinePath: parsed.timelinePath, previewPath: "video/preview.html", timeline },
        logs: [JSON.stringify({ projectId: project.id, timelinePath: parsed.timelinePath, timeline }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "import_video_asset_from_local_file",
      description: "Import an uploaded/generated local MP4, WebM, or MOV file into a video project asset path.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, sourcePath: { type: "string" }, relativePath: { type: "string" }, contentType: { type: "string" } },
        required: ["projectId", "sourcePath", "relativePath"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: importVideoAssetSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof importVideoAssetSchema>;
      const sourcePath = resolveLocalSourcePath(ctx.workspaceRoot, parsed.sourcePath);
      const file = await importProjectAssetFromLocalFile(ctx.projectRoot, parsed.projectId, parsed.relativePath, sourcePath, parsed.contentType);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, {
        toolName: "import_video_asset_from_local_file",
        ok: true,
        summary: `Imported video asset ${file.path}.`,
        details: { ...file, sourcePath }
      });
      return { ok: true, summary: `Imported video asset ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { ...file, sourcePath }, logs: [JSON.stringify({ ...file, sourcePath }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "probe_video_asset",
      description: "Inspect a project video asset with ffprobe and return streams, duration, codecs, resolution, and container metadata.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, assetPath: { type: "string" } }, required: ["projectId", "assetPath"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: probeVideoAssetSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof probeVideoAssetSchema>;
      const assetFile = await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, parsed.assetPath);
      const probe = await runFfprobe(assetFile);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "probe_video_asset", ok: true, summary: `Probed ${parsed.assetPath}.`, details: probe });
      return { ok: true, summary: `Probed ${parsed.assetPath}.`, jobId: parsed.projectId, artifacts: [parsed.assetPath], structuredContent: { assetPath: parsed.assetPath, probe }, logs: [JSON.stringify(probe, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "extract_video_frames",
      description: "Extract bounded PNG preview frames from a project video asset using ffmpeg and return artifact URLs for ChatGPT visual review.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, assetPath: { type: "string" }, timesSeconds: { type: "array", items: { type: "number" } }, width: { type: "number" } }, required: ["projectId", "assetPath", "timesSeconds"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: extractVideoFramesSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof extractVideoFramesSchema>;
      const assetFile = await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, parsed.assetPath);
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), `coding-mcp-video-frames-${parsed.projectId}-`));
      const artifacts: string[] = [];
      const frames: Array<{ timeSeconds: number; artifactUrl: string }> = [];
      try {
        for (const [index, timeSeconds] of parsed.timesSeconds.entries()) {
          const outputPath = path.join(tmpDir, `frame-${index + 1}.png`);
          await execFileAsync(ffmpegExecutable(), ["-y", "-ss", String(timeSeconds), "-i", assetFile, "-frames:v", "1", "-vf", `scale=${parsed.width}:-2`, outputPath], {
            timeout: 60000,
            maxBuffer: maxFfmpegLogBytes,
            env: childEnv()
          });
          const artifact = await createArtifact({ artifactRoot: ctx.artifactRoot, filename: `frame-${index + 1}.png`, contentType: "image/png", content: await readFile(outputPath) });
          const artifactUrl = makeArtifactUrl(ctx.contentBaseUrl ?? ctx.publicBaseUrl, artifact.id, artifact.filename);
          artifacts.push(artifactUrl);
          frames.push({ timeSeconds, artifactUrl });
        }
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "extract_video_frames", ok: true, summary: `Extracted ${frames.length} frame(s) from ${parsed.assetPath}.`, details: { frames } });
      return { ok: true, summary: `Extracted ${frames.length} frame(s).`, jobId: parsed.projectId, previewUrl: frames[0]?.artifactUrl, artifacts, structuredContent: { assetPath: parsed.assetPath, frames }, logs: [JSON.stringify({ frames }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "create_video_scene_asset",
      description: "Create a project-local SVG/WebGL scene asset that can be referenced by an AI-editable video timeline.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, kind: { type: "string" }, relativePath: { type: "string" }, content: { type: "string" } }, required: ["projectId", "kind", "relativePath", "content"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: videoSceneAssetSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof videoSceneAssetSchema>;
      const extension = path.extname(parsed.relativePath).toLowerCase();
      if (parsed.kind === "svg" && extension !== ".svg") throw new Error("SVG scene assets must use a .svg path.");
      if (parsed.kind !== "svg" && extension === ".svg") throw new Error("Non-SVG scene assets must not use a .svg path.");
      const file = extension === ".svg"
        ? await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.relativePath, Buffer.from(parsed.content, "utf8"), "image/svg+xml")
        : await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.relativePath, parsed.content);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "create_video_scene_asset", ok: true, summary: `Created ${parsed.kind} scene asset ${file.path}.`, details: { path: file.path, kind: parsed.kind } });
      return { ok: true, summary: `Created scene asset ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { ...file, kind: parsed.kind }, logs: [JSON.stringify({ ...file, kind: parsed.kind }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "write_video_timeline",
      description: "Create or replace the AI-editable timeline JSON for a video project. This is the primary CRUD surface for clips.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, timelinePath: { type: "string" }, timeline: { type: "object" } }, required: ["projectId", "timeline"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: writeVideoTimelineSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof writeVideoTimelineSchema>;
      const errors = validateTimelineForProject(parsed.timeline);
      if (errors.length) throw new Error(errors.join(" "));
      const contract = renderContract(parsed.timeline);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.timelinePath, `${JSON.stringify({ ...parsed.timeline, renderContract: contract }, null, 2)}\n`);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "write_video_timeline", ok: true, summary: `Wrote video timeline ${file.path}.`, details: { timelinePath: file.path, contract } });
      return { ok: true, summary: `Wrote video timeline ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { timelinePath: file.path, timeline: parsed.timeline, renderContract: contract }, logs: [JSON.stringify({ timeline: parsed.timeline, renderContract: contract }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "preview_video_timeline",
      description: "Generate an HTML preview page for a project video timeline, including video asset playback and SVG/WebGL scene references.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, timelinePath: { type: "string" }, outputHtmlPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: previewVideoTimelineSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof previewVideoTimelineSchema>;
      const timeline = await timelineFromProject(ctx, parsed.projectId, parsed.timelinePath);
      const html = renderPreviewHtml(timeline);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputHtmlPath, html);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "preview_video_timeline", ok: true, summary: `Generated video preview ${file.path}.`, details: { timelinePath: parsed.timelinePath, outputHtmlPath: file.path } });
      return { ok: true, summary: `Generated video preview ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { timelinePath: parsed.timelinePath, previewPath: file.path, timeline }, logs: [JSON.stringify({ previewPath: file.path, timeline }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "render_video_timeline",
      description: "Render a video timeline to an MP4/WebM artifact with ffmpeg. MVP supports video clips only and no audio mixing.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, timelinePath: { type: "string" }, format: { type: "string" }, includeAudio: { type: "boolean" }, timeoutMs: { type: "number" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: renderVideoTimelineSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof renderVideoTimelineSchema>;
      const timeline = await timelineFromProject(ctx, parsed.projectId, parsed.timelinePath);
      const videoClips = timeline.clips
        .filter((clip) => clip.type === "video")
        .sort((left, right) => left.startSeconds - right.startSeconds);
      if (videoClips.length === 0) throw new Error("render_video_timeline requires at least one video clip in the MVP renderer.");
      const unsupported = timeline.clips.filter((clip) => clip.type !== "video");
      if (unsupported.length > 0) throw new Error(`MVP ffmpeg renderer only supports video clips. Unsupported clips: ${unsupported.map((clip) => `${clip.id}:${clip.type}`).join(", ")}. Use preview_video_timeline for SVG/WebGL preview until browser-scene recording is added.`);
      const inputPaths = [];
      for (const clip of videoClips) {
        if (!clip.assetPath || !videoAssetPattern.test(clip.assetPath)) throw new Error(`Video clip ${clip.id} must reference a supported video asset.`);
        inputPaths.push(await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, clip.assetPath));
      }
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), `coding-mcp-video-render-${parsed.projectId}-`));
      try {
        const outputPath = path.join(tmpDir, `render${renderExtension(parsed.format)}`);
        const args = buildVideoOnlyRenderArgs(inputPaths, videoClips, timeline, outputPath, parsed.format);
        await writeFile(path.join(tmpDir, "ffmpeg-args.json"), `${JSON.stringify(args, null, 2)}\n`);
        const { stderr } = await execFileAsync(ffmpegExecutable(), args, { timeout: parsed.timeoutMs, maxBuffer: maxFfmpegLogBytes, env: childEnv() });
        const artifact = await createArtifact({ artifactRoot: ctx.artifactRoot, filename: `video-render${renderExtension(parsed.format)}`, contentType: renderContentType(parsed.format), content: await readFile(outputPath) });
        const artifactUrl = makeArtifactUrl(ctx.contentBaseUrl ?? ctx.publicBaseUrl, artifact.id, artifact.filename);
        const report = { projectId: parsed.projectId, timelinePath: parsed.timelinePath, format: parsed.format, artifactUrl, clipCount: videoClips.length, renderer: "ffmpeg", audioIncluded: false };
        await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "render_video_timeline", ok: true, summary: `Rendered video timeline to ${parsed.format}.`, details: report });
        return { ok: true, summary: `Rendered video timeline to ${parsed.format}.`, jobId: parsed.projectId, previewUrl: artifactUrl, artifacts: [artifactUrl], structuredContent: report, logs: [JSON.stringify(report, null, 2), stderr.trim()].filter(Boolean), errors: [] };
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    }
  }
];
