import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  createProject,
  getProjectFileContentType,
  getProjectManifest,
  getProjectStoredFilePath,
  publishProject,
  readProjectFile,
  validateLandingPageIntent,
  validateProject,
  writeProjectAsset,
  writeProjectFile
} from "../../projects/store.js";
import type { ProjectMetadata } from "../../projects/store.js";
import { buildProjectPublishOptions } from "../../projects/publish-policy.js";
import type { ToolModule, ToolResult, ToolContext } from "../types.js";

const require = createRequire(import.meta.url);

type PptxTextRun = {
  text: string;
  options?: Record<string, unknown>;
};

type PptxSlide = {
  background?: { color: string };
  addText(text: string | PptxTextRun[], options?: Record<string, unknown>): void;
  addNotes(notes: string): void;
  addImage(options: Record<string, unknown>): void;
  addTable(rows: string[][], options?: Record<string, unknown>): void;
  addChart(type: "bar" | "line" | "pie", data: Array<{ name: string; labels: string[]; values: number[] }>, options?: Record<string, unknown>): void;
};

type PptxPresentation = {
  layout: string;
  author: string;
  subject: string;
  title: string;
  company: string;
  lang: string;
  theme: Record<string, unknown>;
  addSlide(): PptxSlide;
  write(props: { outputType: "nodebuffer" }): Promise<string | ArrayBuffer | Blob | Uint8Array>;
};

type PptxConstructor = new () => PptxPresentation;

const PptxGenConstructor = require("pptxgenjs") as PptxConstructor;

const htmlDeckLayoutSchema = z.enum(["title", "section", "content", "two_column", "image", "quote", "code", "comparison"]);
const pptxDeckLayoutSchema = z.enum(["title", "section", "content", "two_column", "image", "quote", "chart", "table"]);
const immersiveStyleSchema = z.enum(["editorial", "product_demo", "data_story", "portfolio", "interactive_explainer"]);
const immersiveSectionKindSchema = z.enum(["hero", "image_story", "interactive_panel", "timeline", "gallery", "comparison", "callout"]);

const createHtmlDeckInputSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().max(2000).optional().default(""),
  theme: z.enum(["executive", "product", "technical", "visual"]).optional().default("executive"),
  slides: z.array(z.object({
    title: z.string().min(1).max(180),
    body: z.string().max(4000).optional(),
    notes: z.string().max(4000).optional(),
    layout: htmlDeckLayoutSchema.optional().default("content"),
    imagePath: z.string().min(1).max(240).optional(),
    bullets: z.array(z.string().min(1).max(600)).max(12).optional(),
    code: z.object({
      language: z.string().min(1).max(40),
      content: z.string().min(1).max(6000)
    }).optional()
  })).min(1).max(80),
  publish: z.boolean().optional().default(false)
});

const createPptxDeckInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  title: z.string().min(1).max(160),
  slides: z.array(z.object({
    title: z.string().min(1).max(180),
    body: z.string().max(4000).optional(),
    notes: z.string().max(4000).optional(),
    layout: pptxDeckLayoutSchema.optional().default("content"),
    imagePath: z.string().min(1).max(240).optional(),
    bullets: z.array(z.string().min(1).max(600)).max(12).optional(),
    table: z.object({
      headers: z.array(z.string().min(1).max(120)).min(1).max(8),
      rows: z.array(z.array(z.string().max(240)).min(1).max(8)).max(30)
    }).optional(),
    chart: z.object({
      type: z.enum(["bar", "line", "pie"]),
      labels: z.array(z.string().min(1).max(80)).min(1).max(20),
      values: z.array(z.number()).min(1).max(20)
    }).optional()
  })).min(1).max(80),
  outputPath: z.string().min(1).max(240).optional().default("deck.pptx")
});

const createImmersivePageInputSchema = z.object({
  title: z.string().min(1).max(160),
  style: immersiveStyleSchema.optional().default("editorial"),
  sections: z.array(z.object({
    kind: immersiveSectionKindSchema,
    title: z.string().max(180).optional(),
    body: z.string().max(4000).optional(),
    imagePath: z.string().min(1).max(240).optional(),
    data: z.unknown().optional()
  })).min(1).max(40),
  brandName: z.string().min(1).max(120).optional(),
  primaryAction: z.string().min(1).max(120).optional(),
  secondaryAction: z.string().min(1).max(120).optional(),
  enableThreeJs: z.boolean().optional().default(false),
  publish: z.boolean().optional().default(false)
});

const createVideoPresentationInputSchema = z.object({
  title: z.string().min(1).max(160),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional().default("16:9"),
  fps: z.union([z.literal(24), z.literal(30)]).optional().default(30),
  scenes: z.array(z.object({
    title: z.string().max(180).optional(),
    body: z.string().max(2000).optional(),
    imagePath: z.string().min(1).max(240).optional(),
    layout: z.enum(["text", "title_card", "code", "dryrun", "typewriter", "ken_burns"]).optional().default("text"),
    code: z.string().max(4000).optional(),
    steps: z.array(z.object({
      label: z.string().max(200).optional(),
      array: z.array(z.union([z.string(), z.number(), z.null()])).max(30),
      pointers: z.array(z.object({
        label: z.string().max(20),
        index: z.number().int()
      })).max(6).optional()
    })).max(20).optional(),
    hold: z.number().min(0).max(10).optional().default(0),
    ease: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).optional().default("linear"),
    durationSeconds: z.number().min(0.5).max(30),
    transition: z.enum(["cut", "fade", "slide", "zoom"]).optional().default("fade")
  })).min(1).max(30),
  audioPath: z.string().min(1).max(240).optional(),
  outputPath: z.string().min(1).max(240).optional().default("video.mp4"),
  publish: z.boolean().optional().default(false)
}).refine((value) => value.scenes.reduce((total, scene) => total + scene.durationSeconds, 0) <= 180, {
  message: "Video presentations are limited to 180 seconds."
});

const mediaSceneSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().max(180).optional(),
  body: z.string().max(2000).optional(),
  sourcePath: z.string().min(1).max(240).optional(),
  data: z.unknown().optional(),
  durationSeconds: z.number().min(0.25).max(120),
  transition: z.enum(["cut", "fade", "slide", "zoom", "none"]).optional().default("cut")
});

const createMediaSceneTimelineInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional().default("16:9"),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).optional().default(30),
  scenes: z.array(mediaSceneSchema).min(1).max(120),
  outputPath: z.string().min(1).max(240).optional().default("media/timeline.json")
});

const captionCueSchema = z.object({
  text: z.string().min(1).max(600),
  startSeconds: z.number().min(0),
  endSeconds: z.number().min(0),
  sceneId: z.string().min(1).max(80).optional()
}).refine((value) => value.endSeconds > value.startSeconds, { message: "caption endSeconds must be greater than startSeconds" });

const addMediaCaptionsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  timelinePath: z.string().min(1).max(240),
  captions: z.array(captionCueSchema).max(400).optional(),
  transcript: z.string().max(20000).optional(),
  outputPath: z.string().min(1).max(240).optional().default("media/captions.txt"),
  outputManifestPath: z.string().min(1).max(240).optional().default("media/captions.json")
});

const attachMediaVoiceAudioInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  timelinePath: z.string().min(1).max(240),
  audioPath: z.string().min(1).max(240),
  voiceSegments: z.array(z.object({
    sceneId: z.string().min(1).max(80).optional(),
    startSeconds: z.number().min(0),
    endSeconds: z.number().min(0),
    transcript: z.string().max(1000).optional()
  }).refine((value) => value.endSeconds > value.startSeconds, { message: "voice segment endSeconds must be greater than startSeconds" })).max(400).optional(),
  duckBackgroundAudio: z.boolean().optional().default(true),
  outputPath: z.string().min(1).max(240).optional().default("media/audio-alignment.json")
});

const previewMediaFramesInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  timelinePath: z.string().min(1).max(240),
  frameTimes: z.array(z.number().min(0)).max(120).optional(),
  count: z.number().int().min(1).max(60).optional().default(6),
  outputHtmlPath: z.string().min(1).max(240).optional().default("media/frame-preview.html"),
  outputManifestPath: z.string().min(1).max(240).optional().default("media/frame-preview.json")
});

const exportMediaProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  timelinePath: z.string().min(1).max(240),
  captionsPath: z.string().min(1).max(240).optional(),
  audioManifestPath: z.string().min(1).max(240).optional(),
  framePreviewPath: z.string().min(1).max(240).optional(),
  formats: z.array(z.enum(["mp4", "webm", "gif", "png_sequence", "html_preview"])).min(1).max(8).optional().default(["mp4", "webm", "html_preview"]),
  outputPath: z.string().min(1).max(240).optional().default("media/export-manifest.json")
});

type HtmlDeckInput = z.infer<typeof createHtmlDeckInputSchema>;
type PptxDeckInput = z.infer<typeof createPptxDeckInputSchema>;
type ImmersivePageInput = z.infer<typeof createImmersivePageInputSchema>;
type VideoPresentationInput = z.infer<typeof createVideoPresentationInputSchema>;
type MediaTimeline = {
  title: string;
  aspectRatio: "16:9" | "9:16" | "1:1";
  fps: 24 | 25 | 30 | 60;
  durationSeconds: number;
  totalFrames: number;
  scenes: Array<{
    id: string;
    title?: string;
    body?: string;
    sourcePath?: string;
    data?: unknown;
    durationSeconds: number;
    transition: string;
    startSeconds: number;
    endSeconds: number;
    startFrame: number;
    endFrame: number;
  }>;
  renderContract: {
    renderer: string;
    timing: string;
    exportSafety: string;
    openRendererPolicy: {
      commerciallyUsable: boolean;
      paidVideoEngineDependency: boolean;
      softwareDependencies: Array<{ name: string; role: string; license: string; commercialUse: boolean }>;
      forbiddenDependencyPolicy: string[];
    };
  };
};

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

async function copyRevealVendor(ctx: ToolContext, projectId: string): Promise<string[]> {
  const revealDist = path.dirname(require.resolve("reveal.js"));
  const assets = [
    { from: path.join(revealDist, "reveal.css"), to: "vendor/reveal/reveal.css" },
    { from: path.join(revealDist, "reveal.js"), to: "vendor/reveal/reveal.js" },
    { from: path.join(revealDist, "theme/simple.css"), to: "vendor/reveal/theme.css" },
    { from: path.join(revealDist, "plugin/notes.js"), to: "vendor/reveal/notes.js" }
  ];
  const written: string[] = [];
  for (const asset of assets) {
    const content = await readFile(asset.from, "utf8");
    const file = await writeProjectFile(ctx.projectRoot, projectId, asset.to, content);
    written.push(file.path);
  }
  return written;
}

function renderSlide(slide: HtmlDeckInput["slides"][number]): string {
  const title = `<h2>${escapeHtml(slide.title)}</h2>`;
  const body = slide.body ? `<p>${escapeHtml(slide.body)}</p>` : "";
  const bullets = slide.bullets?.length ? `<ul>${slide.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
  const image = slide.imagePath ? `<img class="slide-image" src="${escapeHtml(slide.imagePath)}" alt="${escapeHtml(slide.title)}">` : "";
  const code = slide.code ? `<pre><code class="language-${escapeHtml(slide.code.language)}">${escapeHtml(slide.code.content)}</code></pre>` : "";
  const notes = slide.notes ? `<aside class="notes">${escapeHtml(slide.notes)}</aside>` : "";

  if (slide.layout === "title") return `<section class="slide-title"><h1>${escapeHtml(slide.title)}</h1>${body}${notes}</section>`;
  if (slide.layout === "section") return `<section class="slide-section"><h1>${escapeHtml(slide.title)}</h1>${body}${notes}</section>`;
  if (slide.layout === "image") return `<section class="slide-image-only">${title}${image}${body}${notes}</section>`;
  if (slide.layout === "quote") return `<section class="slide-quote"><blockquote>${escapeHtml(slide.body ?? slide.title)}</blockquote>${notes}</section>`;
  if (slide.layout === "code") return `<section class="slide-code">${title}${code}${notes}</section>`;
  if (slide.layout === "two_column" || slide.layout === "comparison") {
    return `<section class="slide-two-column">${title}<div class="columns"><div>${body}${bullets}</div><div>${image || code}</div></div>${notes}</section>`;
  }
  return `<section>${title}${body}${bullets}${image}${code}${notes}</section>`;
}

function htmlDeckCss(theme: HtmlDeckInput["theme"]): string {
  const palettes = {
    executive: { bg: "#f7f8f4", ink: "#17211b", accent: "#12645d", panel: "#ffffff" },
    product: { bg: "#f3f7fb", ink: "#152238", accent: "#197278", panel: "#ffffff" },
    technical: { bg: "#f5f6f7", ink: "#172026", accent: "#315f72", panel: "#ffffff" },
    visual: { bg: "#f6f1ea", ink: "#241b16", accent: "#9b3d2e", panel: "#fffdf9" }
  } satisfies Record<HtmlDeckInput["theme"], Record<string, string>>;
  const color = palettes[theme];
  return `
:root { --deck-bg:${color.bg}; --deck-ink:${color.ink}; --deck-accent:${color.accent}; --deck-panel:${color.panel}; }
.reveal { color: var(--deck-ink); font-family: Georgia, "Times New Roman", serif; background: var(--deck-bg); }
.reveal h1, .reveal h2 { color: var(--deck-ink); letter-spacing: 0; text-transform: none; font-family: Georgia, "Times New Roman", serif; }
.reveal h1 { font-size: 2.25em; }
.reveal h2 { font-size: 1.45em; }
.reveal p, .reveal li { font-size: 0.72em; line-height: 1.35; }
.reveal section { text-align: left; }
.slide-title, .slide-section { text-align: center !important; }
.slide-section h1 { color: var(--deck-accent); }
.slide-image { max-height: 46vh; object-fit: contain; border-radius: 8px; box-shadow: 0 18px 50px rgba(0,0,0,.16); }
.columns { display: grid; grid-template-columns: 1fr 1fr; gap: 36px; align-items: center; }
.slide-quote blockquote { color: var(--deck-accent); font-size: 1.4em; line-height: 1.2; border-left: 8px solid var(--deck-accent); padding-left: 28px; box-shadow: none; background: transparent; }
pre code { border-radius: 8px; font-size: .7em; }
@media (max-width: 760px) { .columns { grid-template-columns: 1fr; } .reveal h1 { font-size: 1.55em; } .reveal h2 { font-size: 1.1em; } }
`;
}

function renderHtmlDeck(input: HtmlDeckInput): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <link rel="stylesheet" href="./vendor/reveal/reveal.css">
  <link rel="stylesheet" href="./vendor/reveal/theme.css">
  <link rel="stylesheet" href="./slides.css">
</head>
<body>
  <div class="reveal">
    <div class="slides">
      ${input.slides.map(renderSlide).join("\n      ")}
    </div>
  </div>
  <script src="./vendor/reveal/reveal.js"></script>
  <script src="./vendor/reveal/notes.js"></script>
  <script src="./slides.js"></script>
</body>
</html>`;
}

function deckScript(): string {
  return `Reveal.initialize({ hash: true, slideNumber: true, transition: "slide", plugins: [ RevealNotes ] });\n`;
}

async function createBaseProject(ctx: ToolContext, title: string, summary: string, entryFile = "index.html"): Promise<ProjectMetadata> {
  return createProject(ctx.projectRoot, {
    title,
    summary,
    entryFile,
    createdByClientId: ctx.clientId
  });
}

async function maybePublish(ctx: ToolContext, projectId: string, publish: boolean): Promise<{ metadata?: ProjectMetadata; previewUrl?: string; shareUrl?: string }> {
  if (!publish) return {};
  const validation = await validateProject(ctx.projectRoot, projectId, "index.html");
  if (!validation.ok) throw new Error(`Generated project did not validate: ${validation.errors.join("; ")}`);
  const publishPolicy = buildProjectPublishOptions(ctx);
  const metadata = await publishProject(ctx.projectRoot, projectId, publishPolicy.publicBaseUrl, "index.html", publishPolicy.options);
  return { metadata, previewUrl: metadata.publishedUrl, shareUrl: metadata.publishedUrl };
}

async function handleCreateHtmlDeck(input: HtmlDeckInput, ctx: ToolContext): Promise<ToolResult> {
  const project = await createBaseProject(ctx, input.title, input.summary, "index.html");
  const written = await copyRevealVendor(ctx, project.id);
  const files = [
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", renderHtmlDeck(input)),
    await writeProjectFile(ctx.projectRoot, project.id, "slides.css", htmlDeckCss(input.theme)),
    await writeProjectFile(ctx.projectRoot, project.id, "slides.js", deckScript())
  ];
  const published = await maybePublish(ctx, project.id, input.publish);
  const manifest = await getProjectManifest(ctx.projectRoot, project.id);
  return {
    ok: true,
    summary: input.publish ? `Created and published HTML deck ${project.id}.` : `Created HTML deck ${project.id}.`,
    jobId: project.id,
    previewUrl: published.previewUrl,
    shareUrl: published.shareUrl,
    artifacts: [...files.map((file) => file.path), ...written],
    logs: [JSON.stringify({ projectId: project.id, files: manifest.files, publishedUrl: published.metadata?.publishedUrl }, null, 2)],
    errors: []
  };
}

async function ensureProject(ctx: ToolContext, projectId: string | undefined, title: string): Promise<ProjectMetadata> {
  if (projectId) {
    const manifest = await getProjectManifest(ctx.projectRoot, projectId);
    return manifest.metadata;
  }
  return createBaseProject(ctx, title, "Generated PowerPoint deck.", "index.html");
}

function chartType(type: "bar" | "line" | "pie"): "bar" | "line" | "pie" {
  return type;
}

async function addPptxImage(slide: PptxSlide, ctx: ToolContext, projectId: string, imagePath: string, x: number, y: number, w: number, h: number): Promise<void> {
  const absolutePath = await getProjectStoredFilePath(ctx.projectRoot, projectId, imagePath);
  const contentType = getProjectFileContentType(imagePath);
  if (!contentType.startsWith("image/")) throw new Error(`PPTX imagePath is not an image asset: ${imagePath}`);
  slide.addImage({ path: absolutePath, x, y, w, h, sizing: { type: "contain", x, y, w, h } });
}

async function handleCreatePptxDeck(input: PptxDeckInput, ctx: ToolContext): Promise<ToolResult> {
  const project = await ensureProject(ctx, input.projectId, input.title);
  const pptx = new PptxGenConstructor();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Coding MCP ChatGPT";
  pptx.subject = input.title;
  pptx.title = input.title;
  pptx.company = "Coding MCP";
  pptx.lang = "en-US";
  pptx.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
    lang: "en-US"
  };

  for (const item of input.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: item.layout === "section" ? "F3F7FB" : "FFFFFF" };
    slide.addText(item.title, { x: 0.55, y: 0.35, w: 12.2, h: 0.55, fontFace: "Aptos Display", fontSize: item.layout === "title" ? 32 : 24, bold: true, color: "17211B", margin: 0.02 });
    if (item.notes) slide.addNotes(item.notes);

    if (item.layout === "title") {
      if (item.body) slide.addText(item.body, { x: 1.2, y: 2.55, w: 11, h: 1.1, fontSize: 22, color: "425047", align: "center", valign: "mid" });
      continue;
    }

    if (item.imagePath) {
      await addPptxImage(slide, ctx, project.id, item.imagePath, item.layout === "image" ? 1.05 : 7.1, item.layout === "image" ? 1.25 : 1.45, item.layout === "image" ? 11.2 : 5.4, item.layout === "image" ? 5.25 : 4.85);
    }

    if (item.table) {
      slide.addTable([item.table.headers, ...item.table.rows], { x: 0.75, y: 1.35, w: 11.7, h: 4.8, fontSize: 12, border: { color: "D5DBD2", pt: 1 }, fill: { color: "F8FAF7" } });
    } else if (item.chart) {
      if (item.chart.labels.length !== item.chart.values.length) throw new Error(`Chart labels and values must have the same length on slide "${item.title}".`);
      slide.addChart(chartType(item.chart.type), [{ name: item.title, labels: item.chart.labels, values: item.chart.values }], { x: 0.85, y: 1.35, w: 11.3, h: 4.9, showLegend: item.chart.type !== "pie", showTitle: false });
    } else {
      const textBlocks: PptxTextRun[] = [];
      if (item.body) textBlocks.push({ text: item.body, options: { breakLine: true } });
      for (const bullet of item.bullets ?? []) {
        textBlocks.push({ text: bullet, options: { bullet: { type: "ul" }, breakLine: true } });
      }
      if (textBlocks.length) {
        slide.addText(textBlocks, { x: 0.85, y: 1.35, w: item.imagePath ? 5.8 : 11.4, h: 4.8, fontSize: 17, color: "27352F", fit: "shrink", breakLine: false, margin: 0.08 });
      }
    }

    if (item.layout === "quote" && item.body) {
      slide.addText(`"${item.body}"`, { x: 1.2, y: 2.0, w: 10.8, h: 2.2, fontSize: 26, italic: true, color: "12645D", align: "center", fit: "shrink" });
    }
  }

  const output = await pptx.write({ outputType: "nodebuffer" });
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output as Uint8Array);
  const file = await writeProjectAsset(ctx.projectRoot, project.id, input.outputPath, buffer, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  return {
    ok: true,
    summary: `Created PPTX deck ${file.path} in project ${project.id}.`,
    jobId: project.id,
    artifacts: [file.path],
    logs: [JSON.stringify({ projectId: project.id, file }, null, 2)],
    errors: []
  };
}

function renderData(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return escapeHtml(String(value));
  try {
    return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  } catch {
    return "";
  }
}

function isProductDemoHeroPage(input: ImmersivePageInput): boolean {
  return input.style === "product_demo" && input.sections.some((section) => section.kind === "hero");
}

function productDemoBrand(input: ImmersivePageInput): string {
  return input.brandName ?? input.title;
}

function productDemoPrimaryAction(input: ImmersivePageInput): string {
  return input.primaryAction ?? "Start the conversation";
}

function productDemoSecondaryAction(input: ImmersivePageInput): string {
  return input.secondaryAction ?? "Explore the proof";
}

function productDemoHeroCss(): string {
  return `
:root { --bg:#f4f1e8; --ink:#12231f; --muted:#627068; --line:#d8d0c2; --accent:#0f766e; --accent-2:#f2b66d; --panel:#fffaf0; }
* { box-sizing: border-box; }
html { scroll-behavior:smooth; }
body { margin:0; background:radial-gradient(circle at 78% 0%, #dff8f2 0, var(--bg) 34%, #fbfaf6 100%); color:var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
a { color:inherit; }
.site-header { position:sticky; top:0; z-index:20; display:flex; align-items:center; justify-content:space-between; gap:24px; padding:18px clamp(20px,5vw,72px); background:rgba(244,241,232,.88); border-bottom:1px solid rgba(18,35,31,.08); backdrop-filter:blur(16px); }
.brand { font-weight:900; text-decoration:none; letter-spacing:-.03em; }
.site-header nav { display:flex; gap:18px; flex-wrap:wrap; }
.site-header nav a { color:var(--muted); font-weight:700; text-decoration:none; }
.nav-cta, .cta { display:inline-flex; align-items:center; justify-content:center; border-radius:999px; font-weight:900; text-decoration:none; }
.nav-cta { background:var(--ink); color:white; padding:10px 16px; }
main { overflow:hidden; }
.hero { min-height:88vh; display:grid; grid-template-columns:minmax(0,1.05fr) minmax(320px,.95fr); gap:clamp(28px,6vw,86px); align-items:center; padding:clamp(54px,8vw,104px) clamp(20px,5vw,72px); }
.eyebrow { margin:0 0 14px; color:var(--accent); font-size:12px; font-weight:950; letter-spacing:.16em; text-transform:uppercase; }
h1, h2, p { margin-top:0; }
h1 { max-width:920px; margin-bottom:24px; font-size:clamp(44px,7vw,88px); line-height:.95; letter-spacing:-.065em; }
h2 { font-size:clamp(30px,4vw,54px); line-height:1; letter-spacing:-.045em; }
.hero-lede, .section-card p, .hero-visual p, .closing p { color:var(--muted); font-size:clamp(18px,2vw,22px); line-height:1.6; }
.hero-actions { display:flex; gap:14px; flex-wrap:wrap; margin-top:30px; }
.cta { padding:14px 20px; }
.cta.primary { background:var(--accent); color:white; box-shadow:0 18px 38px rgba(15,118,110,.24); }
.cta.secondary { background:rgba(255,255,255,.68); border:1px solid var(--line); color:var(--ink); }
.hero-visual { min-height:360px; display:grid; align-content:center; gap:20px; padding:30px; border:1px solid rgba(18,35,31,.1); border-radius:34px; background:linear-gradient(145deg,#fffaf0,#ddf7f1); box-shadow:0 32px 90px rgba(18,35,31,.18); }
.visual-kicker { display:flex; gap:8px; }
.visual-kicker span { width:12px; height:12px; border-radius:50%; background:var(--accent); }
.hero-visual strong { font-size:clamp(28px,4vw,44px); line-height:1; letter-spacing:-.04em; }
.signal-bars { display:grid; gap:10px; }
.signal-bars span { display:block; height:12px; border-radius:999px; background:linear-gradient(90deg,var(--accent),var(--accent-2)); }
.signal-bars span:nth-child(2) { width:72%; opacity:.78; }
.signal-bars span:nth-child(3) { width:52%; opacity:.58; }
.proof-strip { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; padding:0 clamp(20px,5vw,72px) clamp(42px,7vw,88px); }
.proof-card, .section-card { background:rgba(255,250,240,.84); border:1px solid var(--line); border-radius:24px; padding:24px; }
.proof-card strong { display:block; font-size:38px; }
.proof-card span { color:var(--muted); }
.content-sections { display:grid; gap:18px; padding:clamp(42px,7vw,88px) clamp(20px,5vw,72px); background:var(--ink); color:white; }
.content-sections .eyebrow, .content-sections h2 { color:white; }
.section-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:16px; }
.section-card { background:rgba(255,255,255,.08); border-color:rgba(255,255,255,.16); }
.section-card p { color:#ccdad5; }
.closing { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:clamp(42px,7vw,88px) clamp(20px,5vw,72px); }
@media (max-width: 820px) { .site-header { position:static; align-items:flex-start; flex-direction:column; } .hero { grid-template-columns:1fr; min-height:auto; } .proof-strip { grid-template-columns:1fr; } .closing { align-items:flex-start; flex-direction:column; } }
`;
}

function immersiveCss(input: ImmersivePageInput): string {
  if (isProductDemoHeroPage(input)) return productDemoHeroCss();
  const { style, enableThreeJs } = input;
  const accent = style === "product_demo" ? "#197278" : style === "data_story" ? "#315f72" : style === "portfolio" ? "#8f4d2f" : style === "interactive_explainer" ? "#4b6f44" : "#12645d";
  return `
:root { --bg:#f7f8f4; --ink:#17211b; --muted:#627067; --line:#d5dbd2; --accent:${accent}; --panel:#fff; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-family: Georgia, "Times New Roman", serif; }
main { overflow:hidden; }
section { min-height: 72vh; display:grid; align-items:center; padding: clamp(32px, 7vw, 96px); border-bottom:1px solid var(--line); }
h1, h2 { margin:0 0 18px; letter-spacing:0; line-height:1.02; }
h1 { font-size: clamp(42px, 7vw, 92px); max-width: 980px; }
h2 { font-size: clamp(28px, 4vw, 58px); max-width: 860px; }
p { font-size: clamp(18px, 2vw, 26px); line-height:1.45; color:var(--muted); max-width: 760px; }
img { max-width: min(680px, 100%); max-height: 58vh; object-fit: contain; border-radius:8px; box-shadow:0 22px 70px rgba(0,0,0,.16); }
.section-inner { display:grid; grid-template-columns:minmax(0,1fr) minmax(280px, 42vw); gap: clamp(24px, 6vw, 82px); align-items:center; width:min(1280px, 100%); margin:0 auto; }
.hero { min-height:92vh; background:linear-gradient(135deg, #f7f8f4 0%, #edf3ef 100%); }
.hero .section-inner { grid-template-columns:1fr; }
.callout { background:var(--accent); color:white; }
.callout p, .callout h2 { color:white; }
.timeline-item { padding:18px 0; border-top:1px solid var(--line); }
.data-block pre { background:#fff; border:1px solid var(--line); border-radius:8px; padding:18px; overflow:auto; }
#three-scene { width:100%; height:46vh; min-height:320px; border-radius:8px; overflow:hidden; background:#0d1612; display:${enableThreeJs ? "block" : "none"}; }
@media (max-width: 820px) { section { min-height:auto; } .section-inner { grid-template-columns:1fr; } }
`;
}

function immersiveScript(enableThreeJs: boolean): string {
  if (!enableThreeJs) return `document.documentElement.classList.add("ready");\n`;
  return `
import * as THREE from "./vendor/three/three.min.js";
document.documentElement.classList.add("ready");
const scene = document.getElementById("three-scene");
if (scene) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(scene.clientWidth, scene.clientHeight);
  scene.appendChild(renderer.domElement);
  const stage = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, scene.clientWidth / scene.clientHeight, 0.1, 100);
  camera.position.z = 4;
  const geometry = new THREE.IcosahedronGeometry(1.2, 1);
  const material = new THREE.MeshNormalMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  stage.add(mesh);
  function tick() {
    mesh.rotation.x += 0.008;
    mesh.rotation.y += 0.012;
    renderer.render(stage, camera);
    requestAnimationFrame(tick);
  }
  tick();
}
`;
}

function productDemoHeroScript(): string {
  return `document.documentElement.classList.add("ready");
document.querySelectorAll(".cta").forEach((link) => {
  link.addEventListener("click", () => {
    document.documentElement.dataset.lastCta = link.textContent?.trim() || "cta";
  });
});
`;
}

function immersiveScriptForInput(input: ImmersivePageInput): string {
  return isProductDemoHeroPage(input) ? productDemoHeroScript() : immersiveScript(input.enableThreeJs);
}

function renderImmersivePage(input: ImmersivePageInput): string {
  if (isProductDemoHeroPage(input)) return renderProductDemoHeroPage(input);
  const sections = input.sections.map((section, index) => {
    const image = section.imagePath ? `<img src="${escapeHtml(section.imagePath)}" alt="${escapeHtml(section.title ?? input.title)}">` : "";
    const data = section.data !== undefined ? `<div class="data-block">${renderData(section.data)}</div>` : "";
    const three = input.enableThreeJs && index === 0 ? `<div id="three-scene" aria-label="Interactive 3D scene"></div>` : "";
    return `<section class="${escapeHtml(section.kind)}">
      <div class="section-inner">
        <div>
          ${index === 0 ? `<h1>${escapeHtml(section.title ?? input.title)}</h1>` : `<h2>${escapeHtml(section.title ?? "")}</h2>`}
          ${section.body ? `<p>${escapeHtml(section.body)}</p>` : ""}
          ${data}
        </div>
        <div>${three || image}</div>
      </div>
    </section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <link rel="stylesheet" href="./page.css">
</head>
<body>
  <main>${sections}</main>
  ${input.enableThreeJs ? `<script src="./vendor/three/three.min.js"></script>` : ""}
  <script ${input.enableThreeJs ? "type=\"module\" " : ""}src="./page.js"></script>
</body>
</html>`;
}

function renderProductDemoHeroPage(input: ImmersivePageInput): string {
  const hero = input.sections.find((section) => section.kind === "hero") ?? input.sections[0];
  const supportingSections = input.sections.filter((section) => section !== hero).slice(0, 6);
  const sectionCards = (supportingSections.length ? supportingSections : [
    { kind: "comparison" as const, title: "Clear product signal", body: "Visitors understand who this is for, what it does, and why the next action matters." },
    { kind: "interactive_panel" as const, title: "Proof before detail", body: "Key metrics and trust points appear before deeper feature explanations." },
    { kind: "callout" as const, title: "Ready for review", body: "The page structure supports desktop, tablet, and mobile screenshot QA." }
  ]).map((section) => `<article class="section-card">
        <p class="eyebrow">${escapeHtml(section.kind.replaceAll("_", " "))}</p>
        <h3>${escapeHtml(section.title ?? "Page section")}</h3>
        ${section.body ? `<p>${escapeHtml(section.body)}</p>` : ""}
        ${section.data !== undefined ? `<div class="data-block">${renderData(section.data)}</div>` : ""}
      </article>`).join("\n");
  const brand = productDemoBrand(input);
  const primaryAction = productDemoPrimaryAction(input);
  const secondaryAction = productDemoSecondaryAction(input);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <link rel="stylesheet" href="./page.css">
</head>
<body data-page-intent="hero">
  <header class="site-header">
    <a class="brand" href="#hero">${escapeHtml(brand)}</a>
    <nav aria-label="Primary navigation">
      <a href="#proof">Proof</a>
      <a href="#sections">Sections</a>
      <a href="#contact">Contact</a>
    </nav>
    <a class="nav-cta" href="#contact">${escapeHtml(primaryAction)}</a>
  </header>
  <main>
    <section class="hero" id="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="eyebrow">Product story</p>
        <h1 id="hero-title">${escapeHtml(hero?.title ?? input.title)}</h1>
        <p class="hero-lede">${escapeHtml(hero?.body ?? "A focused first-viewport hero page with clear positioning, proof, and conversion paths.")}</p>
        <div class="hero-actions">
          <a class="cta primary" href="#contact">${escapeHtml(primaryAction)}</a>
          <a class="cta secondary" href="#sections">${escapeHtml(secondaryAction)}</a>
        </div>
      </div>
      <aside class="hero-visual" aria-label="Hero product preview">
        <div class="visual-kicker"><span></span><span></span><span></span></div>
        <strong>${escapeHtml(brand)} introduction page</strong>
        <p>Built around a visible header, strong headline, explicit CTA, proof points, and reviewable content sections.</p>
        <div class="signal-bars" aria-hidden="true"><span></span><span></span><span></span></div>
      </aside>
    </section>
    <section class="proof-strip" id="proof" aria-label="Proof points">
      <div class="proof-card"><strong>01</strong><span>Clear brand and page purpose above the fold</span></div>
      <div class="proof-card"><strong>02</strong><span>CTA path visible without scrolling</span></div>
      <div class="proof-card"><strong>03</strong><span>Supporting sections ready for screenshot QA</span></div>
    </section>
    <section class="content-sections" id="sections" aria-labelledby="sections-title">
      <p class="eyebrow">Page structure</p>
      <h2 id="sections-title">Designed as a deliverable landing page, not a catalog shell</h2>
      <div class="section-grid">${sectionCards}</div>
    </section>
    <section class="closing" id="contact" aria-label="Final call to action">
      <div>
        <p class="eyebrow">Next step</p>
        <h2>Make the first impression specific and actionable.</h2>
        <p>Replace the copy and proof points with production content, then run browser and visual QA before handoff.</p>
      </div>
      <a class="cta primary" href="mailto:hello@example.com">${escapeHtml(primaryAction)}</a>
    </section>
  </main>
  <script src="./page.js"></script>
</body>
</html>`;
}

async function writeOptionalThreeVendor(ctx: ToolContext, projectId: string, enabled: boolean): Promise<string[]> {
  if (!enabled) return [];
  const threeBuild = path.dirname(require.resolve("three"));
  const threePath = path.join(threeBuild, "three.module.js");
  const content = await readFile(threePath, "utf8");
  const file = await writeProjectFile(ctx.projectRoot, projectId, "vendor/three/three.min.js", content);
  return [file.path];
}

async function copyMp4MuxerVendor(ctx: ToolContext, projectId: string): Promise<string[]> {
  const muxerCjsPath = require.resolve("mp4-muxer");
  const muxerPath = path.join(path.dirname(muxerCjsPath), "mp4-muxer.mjs");
  const content = await readFile(muxerPath, "utf8");
  const file = await writeProjectFile(ctx.projectRoot, projectId, "vendor/mp4-muxer/mp4-muxer.mjs", content);
  return [file.path];
}

async function handleCreateImmersivePage(input: ImmersivePageInput, ctx: ToolContext): Promise<ToolResult> {
  const project = await createBaseProject(ctx, input.title, `Generated immersive ${input.style} page.`, "index.html");
  const html = renderImmersivePage(input);
  const files = [
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", html),
    await writeProjectFile(ctx.projectRoot, project.id, "page.css", immersiveCss(input)),
    await writeProjectFile(ctx.projectRoot, project.id, "page.js", immersiveScriptForInput(input))
  ];
  const vendor = await writeOptionalThreeVendor(ctx, project.id, input.enableThreeJs);
  const landingPageIntent = isProductDemoHeroPage(input) ? validateLandingPageIntent(html) : undefined;
  if (input.publish && landingPageIntent && !landingPageIntent.ok) {
    const manifest = await getProjectManifest(ctx.projectRoot, project.id);
    return {
      ok: false,
      summary: `Created immersive page ${project.id}, but publish was blocked by landing intent gate.`,
      jobId: project.id,
      artifacts: [...files.map((file) => file.path), ...vendor],
      structuredContent: { projectId: project.id, files: manifest.files, landingPageIntent },
      logs: [JSON.stringify({ projectId: project.id, files: manifest.files, landingPageIntent }, null, 2)],
      errors: landingPageIntent.errors
    };
  }
  const published = await maybePublish(ctx, project.id, input.publish);
  const manifest = await getProjectManifest(ctx.projectRoot, project.id);
  return {
    ok: true,
    summary: input.publish ? `Created and published immersive page ${project.id}.` : `Created immersive page ${project.id}.`,
    jobId: project.id,
    previewUrl: published.previewUrl,
    shareUrl: published.shareUrl,
    artifacts: [...files.map((file) => file.path), ...vendor],
    structuredContent: { projectId: project.id, landingPageIntent },
    logs: [JSON.stringify({ projectId: project.id, files: manifest.files, publishedUrl: published.metadata?.publishedUrl }, null, 2)],
    errors: []
  };
}

function videoDimensions(aspectRatio: VideoPresentationInput["aspectRatio"]): { width: number; height: number } {
  if (aspectRatio === "9:16") return { width: 1080, height: 1920 };
  if (aspectRatio === "1:1") return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

function createMediaTimeline(input: z.infer<typeof createMediaSceneTimelineInputSchema>): MediaTimeline {
  let cursor = 0;
  const scenes = input.scenes.map((scene) => {
    const startSeconds = Number(cursor.toFixed(3));
    const endSeconds = Number((cursor + scene.durationSeconds).toFixed(3));
    const startFrame = Math.round(startSeconds * input.fps);
    const endFrame = Math.max(startFrame + 1, Math.round(endSeconds * input.fps) - 1);
    cursor = endSeconds;
    return { ...scene, startSeconds, endSeconds, startFrame, endFrame };
  });
  const durationSeconds = Number(cursor.toFixed(3));
  return {
    title: input.title,
    aspectRatio: input.aspectRatio,
    fps: input.fps,
    durationSeconds,
    totalFrames: Math.ceil(durationSeconds * input.fps),
    scenes,
    renderContract: {
      renderer: "Code-MCP scripted media renderer",
      timing: "Scene timing is deterministic from seconds and fps.",
      exportSafety: "This manifest is encoder-agnostic; actual byte export must be performed by a verified browser/WebCodecs or CLI encoder step.",
      openRendererPolicy: openMediaRendererPolicy()
    }
  };
}

function openMediaRendererPolicy() {
  return {
    commerciallyUsable: true,
    paidVideoEngineDependency: false,
    softwareDependencies: [
      { name: "Code-MCP scripted media renderer", role: "timeline and manifest generation", license: "project-native", commercialUse: true },
      { name: "Browser WebCodecs API", role: "optional browser-side video encoding", license: "web-standard", commercialUse: true },
      { name: "mp4-muxer", role: "optional browser-side MP4 muxing for video presentation pages", license: "MIT", commercialUse: true }
    ],
    forbiddenDependencyPolicy: ["Do not require proprietary or paid video engines for scripted media timeline, captions, audio alignment, frame preview, or export planning.", "If an external CLI encoder is used later, record its license and commercial-use status before final delivery."]
  };
}

function timecode(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.round((seconds - Math.floor(seconds)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function captionsFromTimeline(timeline: MediaTimeline, transcript?: string) {
  if (transcript?.trim()) {
    const chunks = transcript.split(/\n{2,}|(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
    const segment = timeline.durationSeconds / Math.max(1, chunks.length);
    return chunks.map((text, index) => ({ text, startSeconds: Number((index * segment).toFixed(3)), endSeconds: Number(Math.min(timeline.durationSeconds, (index + 1) * segment).toFixed(3)) }));
  }
  return timeline.scenes.map((scene) => ({ sceneId: scene.id, text: scene.body || scene.title || scene.id, startSeconds: scene.startSeconds, endSeconds: scene.endSeconds }));
}

function renderVtt(captions: Array<{ text: string; startSeconds: number; endSeconds: number; sceneId?: string }>) {
  return `WEBVTT\n\n${captions.map((caption, index) => `${index + 1}\n${timecode(caption.startSeconds)} --> ${timecode(caption.endSeconds)}${caption.sceneId ? `\nNOTE scene:${caption.sceneId}` : ""}\n${caption.text}`).join("\n\n")}\n`;
}

function defaultFrameTimes(timeline: MediaTimeline, count: number) {
  if (timeline.durationSeconds <= 0) return [0];
  if (count === 1) return [0];
  return Array.from({ length: count }, (_value, index) => Number(((timeline.durationSeconds * index) / (count - 1)).toFixed(3)));
}

function sceneAt(timeline: MediaTimeline, seconds: number) {
  return timeline.scenes.find((scene) => seconds >= scene.startSeconds && seconds < scene.endSeconds) ?? timeline.scenes[timeline.scenes.length - 1];
}

function framePreviewHtml(timeline: MediaTimeline, frames: Array<{ timeSeconds: number; frame: number; sceneId: string; title?: string; sourcePath?: string }>) {
  const cards = frames.map((frame) => `<article><div class="thumb">${frame.sourcePath ? `<img src="../${escapeHtml(frame.sourcePath)}" alt="${escapeHtml(frame.title ?? frame.sceneId)}">` : `<strong>${escapeHtml(frame.title ?? frame.sceneId)}</strong>`}</div><p>${timecode(frame.timeSeconds)} / frame ${frame.frame}</p><span>${escapeHtml(frame.sceneId)}</span></article>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(timeline.title)} Frame Preview</title><style>body{margin:0;font-family:Inter,Arial,sans-serif;background:#f8fafc;color:#0f172a}main{max-width:1180px;margin:0 auto;padding:28px}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}article{background:#fff;border:1px solid #d8dee9;border-radius:8px;padding:12px}.thumb{aspect-ratio:16/9;display:grid;place-items:center;background:#111827;color:#fff;border-radius:6px;overflow:hidden}.thumb img{width:100%;height:100%;object-fit:cover}p{margin:10px 0 4px;color:#475569}span{font-size:12px;color:#64748b}</style></head><body><main><h1>${escapeHtml(timeline.title)} Frame Preview</h1><p>${timeline.durationSeconds}s at ${timeline.fps}fps, ${timeline.totalFrames} frames.</p><section>${cards}</section></main></body></html>\n`;
}

function mediaExportPlans(timeline: MediaTimeline, formats: Array<"mp4" | "webm" | "gif" | "png_sequence" | "html_preview">) {
  const dimensions = videoDimensions(timeline.aspectRatio);
  return formats.map((format) => {
    if (format === "html_preview") return { format, outputPath: "media/preview.html", status: "ready_from_project_files", encoder: "browser", dimensions };
    if (format === "png_sequence") return { format, outputPath: "media/frames/frame-%05d.png", status: "planned", encoder: "browser canvas or verified CLI", frames: timeline.totalFrames, dimensions };
    if (format === "gif") return { format, outputPath: "media/export.gif", status: "planned", encoder: "verified GIF encoder required", dimensions, note: "Use short clips only; prefer MP4/WebM for demos." };
    return { format, outputPath: `media/export.${format}`, status: "planned", encoder: format === "mp4" ? "WebCodecs H.264 where available or verified CLI encoder" : "WebM VP8/VP9 encoder", dimensions, fps: timeline.fps, durationSeconds: timeline.durationSeconds };
  });
}

function renderVideoPresentationPage(input: VideoPresentationInput): string {
  const dimensions = videoDimensions(input.aspectRatio);
  const duration = input.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
  const payload = {
    title: input.title,
    aspectRatio: input.aspectRatio,
    fps: input.fps,
    width: dimensions.width,
    height: dimensions.height,
    durationSeconds: duration,
    outputPath: input.outputPath,
    audioPath: input.audioPath,
    scenes: input.scenes
  };
  const audio = input.audioPath
    ? `<audio id="preview-audio" src="${escapeHtml(input.audioPath)}" preload="metadata"></audio><p class="audio-note">Storyboard preview — no audio mix, subtitles, or final encoding. MP4 export is video-only (browser-side WebCodecs).</p>`
    : `<p class="audio-note">Storyboard preview — no audio mix, subtitles, or final encoding. MP4 export is video-only (browser-side WebCodecs).</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <link rel="stylesheet" href="./video.css">
</head>
<body>
  <main class="app-shell">
    <section class="stage-panel">
      <canvas id="video-canvas" width="${dimensions.width}" height="${dimensions.height}" aria-label="${escapeHtml(input.title)} preview canvas"></canvas>
    </section>
    <section class="controls-panel" aria-label="Video presentation controls">
      <div>
        <p class="eyebrow">Storyboard preview</p>
        <h1>${escapeHtml(input.title)}</h1>
      </div>
      <div class="status-grid">
        <span><strong id="scene-label">Scene 1</strong></span>
        <span><strong>${escapeHtml(input.aspectRatio)}</strong> aspect</span>
        <span><strong>${escapeHtml(String(input.fps))}</strong> fps</span>
        <span><strong>${escapeHtml(duration.toFixed(1))}s</strong> total</span>
      </div>
      <input id="timeline" type="range" min="0" max="${escapeHtml(String(duration))}" step="0.01" value="0" aria-label="Timeline">
      <div class="button-row">
        <button id="play-button" type="button">Play</button>
        <button id="export-button" type="button">Export video-only MP4 preview</button>
      </div>
      <p id="status" role="status">Ready.</p>
      ${audio}
    </section>
  </main>
  <script id="video-data" type="application/json">${jsonForScript(payload)}</script>
  <script type="module" src="./video.js"></script>
</body>
</html>`;
}

function videoPresentationCss(): string {
  return `
:root { --bg:#f5f7f5; --ink:#17211b; --muted:#66746b; --line:#d6ddd7; --panel:#fff; --accent:#136f63; }
* { box-sizing:border-box; }
body { margin:0; min-height:100vh; background:var(--bg); color:var(--ink); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.app-shell { min-height:100vh; display:grid; grid-template-columns:minmax(0,1fr) 380px; }
.stage-panel { display:grid; place-items:center; padding:clamp(16px, 4vw, 48px); background:#101613; }
canvas { width:min(100%, 1280px); max-height:calc(100vh - 48px); aspect-ratio:var(--canvas-aspect, 16 / 9); background:#0c1110; border:1px solid rgba(255,255,255,.12); box-shadow:0 20px 80px rgba(0,0,0,.35); }
.controls-panel { border-left:1px solid var(--line); background:var(--panel); padding:28px; display:flex; flex-direction:column; gap:22px; }
.eyebrow { margin:0 0 8px; color:var(--accent); font-size:12px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
h1 { margin:0; font-size:28px; line-height:1.08; letter-spacing:0; }
.status-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; color:var(--muted); font-size:13px; }
.status-grid span { border:1px solid var(--line); border-radius:8px; padding:10px; }
.status-grid strong { display:block; color:var(--ink); font-size:15px; }
input[type="range"] { width:100%; accent-color:var(--accent); }
.button-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
button { appearance:none; border:1px solid var(--accent); border-radius:8px; min-height:42px; padding:0 14px; background:var(--accent); color:white; font-weight:800; cursor:pointer; }
button + button { background:white; color:var(--accent); }
button:disabled { opacity:.55; cursor:not-allowed; }
#status, .audio-note { margin:0; color:var(--muted); font-size:13px; line-height:1.45; }
audio { width:100%; }
@media (max-width: 900px) {
  .app-shell { grid-template-columns:1fr; }
  .controls-panel { border-left:0; border-top:1px solid var(--line); }
  canvas { max-height:65vh; }
}
`;
}

function videoPresentationScript(): string {
  return `
import { Muxer, ArrayBufferTarget } from "./vendor/mp4-muxer/mp4-muxer.mjs";

const data = JSON.parse(document.getElementById("video-data").textContent);
const canvas = document.getElementById("video-canvas");
const ctx = canvas.getContext("2d");
const playButton = document.getElementById("play-button");
const exportButton = document.getElementById("export-button");
const timeline = document.getElementById("timeline");
const statusEl = document.getElementById("status");
const sceneLabel = document.getElementById("scene-label");
const audio = document.getElementById("preview-audio");
const sceneImages = new Map();
let playing = false;
let startedAt = 0;
let pausedAt = 0;
let rafId = 0;

document.documentElement.style.setProperty("--canvas-aspect", \`\${data.width} / \${data.height}\`);

function setStatus(message) {
  statusEl.textContent = message;
}

function sceneAt(timeSeconds) {
  let cursor = 0;
  for (let index = 0; index < data.scenes.length; index++) {
    const scene = data.scenes[index];
    const next = cursor + scene.durationSeconds;
    if (timeSeconds <= next || index === data.scenes.length - 1) {
      return { scene, index, local: Math.max(0, timeSeconds - cursor), duration: scene.durationSeconds };
    }
    cursor = next;
  }
  return { scene: data.scenes[0], index: 0, local: 0, duration: data.scenes[0].durationSeconds };
}

function loadImage(src) {
  if (!src) return Promise.resolve(null);
  if (sceneImages.has(src)) return sceneImages.get(src);
  const promise = new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
  sceneImages.set(src, promise);
  return promise;
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function wrapText(context, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = String(text || "").split(/\\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? \`\${line} \${word}\` : word;
    if (context.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  for (let i = 0; i < lines.length; i++) context.fillText(lines[i], x, y + i * lineHeight);
}

function applyEase(t, ease) {
  if (ease === "ease-in") return t * t;
  if (ease === "ease-out") return 1 - (1 - t) * (1 - t);
  if (ease === "ease-in-out") return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return t;
}

function transitionAlpha(kind, local, duration) {
  if (kind === "cut") return 1;
  const ramp = Math.min(1, local / Math.min(0.6, duration / 3));
  return Math.max(0.08, ramp);
}

async function renderAt(timeSeconds) {
  const { scene, index, local, duration } = sceneAt(timeSeconds);
  const holdSecs = scene.hold || 0;
  const animDuration = Math.max(0.1, duration - holdSecs);
  const rawProgress = duration > 0 ? Math.min(1, local / animDuration) : 0;
  const progress = applyEase(rawProgress, scene.ease || "linear");
  sceneLabel.textContent = \`Scene \${index + 1} of \${data.scenes.length}\`;
  timeline.value = String(Math.min(timeSeconds, data.durationSeconds));

  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#0f1f1d");
  gradient.addColorStop(0.48, "#18302b");
  gradient.addColorStop(1, "#f2f4ea");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.globalAlpha = transitionAlpha(scene.transition, local, duration);
  const image = await loadImage(scene.imagePath);
  if (image && scene.layout !== "ken_burns") {
    const scale = Math.max(canvas.width / image.width, canvas.height / image.height) * (1 + progress * 0.035);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.globalAlpha *= 0.34;
    ctx.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    ctx.globalAlpha = transitionAlpha(scene.transition, local, duration);
  }

  const pad = Math.round(canvas.width * 0.07);
  const panelW = Math.min(canvas.width - pad * 2, Math.round(canvas.width * 0.68));
  const panelH = Math.round(canvas.height * 0.5);
  const panelY = Math.round((canvas.height - panelH) / 2);
  const layout = scene.layout || "text";
  if (layout === "title_card") {
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    roundedRect(ctx, pad, panelY - 20, canvas.width - pad * 2, panelH + 40, 12);
    ctx.fill();
    const titleSize = Math.max(72, canvas.width * 0.072);
    ctx.fillStyle = "#ffffff";
    ctx.font = \`800 \${titleSize}px Georgia, serif\`;
    ctx.textAlign = "center";
    wrapText(ctx, scene.title || data.title, canvas.width / 2, canvas.height / 2 - titleSize * 0.4, canvas.width - pad * 2, titleSize * 1.15, 3);
    if (scene.body) {
      ctx.font = \`400 \${Math.max(30, canvas.width * 0.026)}px system-ui, sans-serif\`;
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      wrapText(ctx, scene.body, canvas.width / 2, canvas.height / 2 + titleSize * 1.3, canvas.width - pad * 2.5, Math.max(38, canvas.width * 0.032), 2);
    }
    ctx.textAlign = "left";
  } else if (layout === "code") {
    const codePanel = { x: pad, y: panelY - 20, w: canvas.width - pad * 2, h: panelH + 40 };
    ctx.fillStyle = "rgba(12,20,18,0.93)";
    roundedRect(ctx, codePanel.x, codePanel.y, codePanel.w, codePanel.h, 16);
    ctx.fill();
    ctx.fillStyle = "#74c7b8";
    ctx.font = \`600 \${Math.max(18, canvas.width * 0.015)}px system-ui, monospace\`;
    ctx.fillText(scene.title || "Code", codePanel.x + 26, codePanel.y + 36);
    const codeLines = (scene.code || "").split("\\n");
    const revealed = Math.max(1, Math.round(progress * codeLines.length + 0.5));
    const lineH = Math.max(28, canvas.width * 0.022);
    const fontSize = Math.max(18, canvas.width * 0.017);
    ctx.font = \`400 \${fontSize}px "Courier New", monospace\`;
    const codeStartY = codePanel.y + 62;
    const maxVisible = Math.floor((codePanel.h - 72) / lineH);
    const startLine = Math.max(0, revealed - maxVisible);
    for (let li = startLine; li < Math.min(revealed, codeLines.length); li++) {
      const lineY = codeStartY + (li - startLine) * lineH;
      if (li === revealed - 1) {
        ctx.fillStyle = "rgba(19,111,99,0.32)";
        ctx.fillRect(codePanel.x + 6, lineY - lineH * 0.8, codePanel.w - 12, lineH);
      }
      ctx.fillStyle = "rgba(116,199,184,0.5)";
      ctx.font = \`400 \${fontSize}px "Courier New", monospace\`;
      ctx.fillText(String(li + 1).padStart(3, " "), codePanel.x + 12, lineY);
      ctx.fillStyle = "#cce8e3";
      ctx.fillText(codeLines[li].replace(/\\t/g, "    "), codePanel.x + 58, lineY);
    }
  } else if (layout === "dryrun") {
    ctx.fillStyle = "rgba(255,255,255,0.91)";
    roundedRect(ctx, pad, panelY, panelW, panelH, 24);
    ctx.fill();
    ctx.fillStyle = "#136f63";
    ctx.font = \`700 \${Math.max(20, canvas.width * 0.016)}px system-ui, sans-serif\`;
    ctx.fillText(\`SCENE \${index + 1}\`, pad + 46, panelY + 56);
    ctx.fillStyle = "#17211b";
    ctx.font = \`700 \${Math.max(32, canvas.width * 0.03)}px system-ui, sans-serif\`;
    ctx.fillText(scene.title || "Dry Run", pad + 46, panelY + 106);
    const steps = scene.steps || [];
    if (steps.length > 0) {
      const stepIndex = Math.min(steps.length - 1, Math.floor(progress * steps.length));
      const step = steps[stepIndex];
      ctx.fillStyle = "#66746b";
      ctx.font = \`500 \${Math.max(16, canvas.width * 0.014)}px system-ui, sans-serif\`;
      ctx.fillText(\`Step \${stepIndex + 1} / \${steps.length}\${step.label ? ": " + step.label : ""}\`, pad + 46, panelY + 148);
      const arr = step.array || [];
      const pointers = step.pointers || [];
      const cellSize = Math.max(40, Math.min(Math.floor((panelW - 92) / Math.max(1, arr.length)), Math.round(canvas.width * 0.062)));
      const cellH = Math.round(cellSize * 0.84);
      const arrStartX = pad + 46;
      const arrY = panelY + 186;
      const cellFontSize = Math.max(14, Math.floor(cellSize * 0.36));
      for (let ci = 0; ci < arr.length; ci++) {
        const cx = arrStartX + ci * (cellSize + 4);
        const isPointed = pointers.some((p) => p.index === ci);
        ctx.fillStyle = isPointed ? "#136f63" : "#e4eeea";
        roundedRect(ctx, cx, arrY, cellSize, cellH, 6);
        ctx.fill();
        ctx.strokeStyle = isPointed ? "#0d4f47" : "#adbdb5";
        ctx.lineWidth = 2;
        roundedRect(ctx, cx, arrY, cellSize, cellH, 6);
        ctx.stroke();
        ctx.fillStyle = isPointed ? "#ffffff" : "#17211b";
        ctx.font = \`700 \${cellFontSize}px system-ui, monospace\`;
        ctx.textAlign = "center";
        ctx.fillText(String(arr[ci] ?? ""), cx + cellSize / 2, arrY + cellH * 0.66);
        ctx.textAlign = "left";
      }
      const ptrFontSize = Math.max(13, Math.floor(cellSize * 0.28));
      for (const ptr of pointers) {
        if (ptr.index >= 0 && ptr.index < arr.length) {
          const px = arrStartX + ptr.index * (cellSize + 4) + cellSize / 2;
          ctx.fillStyle = "#136f63";
          ctx.font = \`700 \${ptrFontSize}px system-ui, sans-serif\`;
          ctx.textAlign = "center";
          ctx.fillText("▲", px, arrY + cellH + 24);
          ctx.fillText(ptr.label, px, arrY + cellH + 44);
          ctx.textAlign = "left";
        }
      }
    }
  } else if (layout === "typewriter") {
    ctx.fillStyle = "rgba(255,255,255,0.91)";
    roundedRect(ctx, pad, panelY, panelW, panelH, 24);
    ctx.fill();
    ctx.fillStyle = "#136f63";
    ctx.font = \`700 \${Math.max(20, canvas.width * 0.016)}px system-ui, sans-serif\`;
    ctx.fillText(\`SCENE \${index + 1}\`, pad + 46, panelY + 56);
    ctx.fillStyle = "#17211b";
    ctx.font = \`800 \${Math.max(38, canvas.width * 0.036)}px Georgia, serif\`;
    wrapText(ctx, scene.title || data.title, pad + 46, panelY + 106, panelW - 92, Math.max(44, canvas.width * 0.04), 2);
    const twBody = scene.body || "";
    const twChars = Math.round(progress * twBody.length);
    const twCursor = progress < 0.98 && Math.floor(local * 2) % 2 === 0 ? "|" : "";
    ctx.fillStyle = "#3d4a43";
    ctx.font = \`400 \${Math.max(24, canvas.width * 0.021)}px system-ui, sans-serif\`;
    wrapText(ctx, twBody.slice(0, twChars) + twCursor, pad + 48, panelY + 168, panelW - 96, Math.max(34, canvas.width * 0.028), 6);
  } else if (layout === "ken_burns") {
    const kbImage = await loadImage(scene.imagePath);
    if (kbImage) {
      const kbBaseScale = Math.max(canvas.width / kbImage.width, canvas.height / kbImage.height);
      const kbScale = kbBaseScale * (1 + progress * 0.18);
      const kbW = kbImage.width * kbScale;
      const kbH = kbImage.height * kbScale;
      ctx.drawImage(kbImage, -(kbW - canvas.width) * progress, -(kbH - canvas.height) * progress, kbW, kbH);
      const scrimH = Math.round(canvas.height * 0.38);
      const scrim = ctx.createLinearGradient(0, canvas.height - scrimH, 0, canvas.height);
      scrim.addColorStop(0, "rgba(0,0,0,0)");
      scrim.addColorStop(1, "rgba(0,0,0,0.72)");
      ctx.fillStyle = scrim;
      ctx.fillRect(0, canvas.height - scrimH, canvas.width, scrimH);
      if (scene.title) {
        ctx.fillStyle = "#ffffff";
        ctx.font = \`700 \${Math.max(40, canvas.width * 0.038)}px Georgia, serif\`;
        wrapText(ctx, scene.title, pad, canvas.height - Math.round(scrimH * 0.56), canvas.width - pad * 2, Math.max(48, canvas.width * 0.042), 2);
      }
      if (scene.body) {
        ctx.fillStyle = "rgba(255,255,255,0.80)";
        ctx.font = \`400 \${Math.max(22, canvas.width * 0.02)}px system-ui, sans-serif\`;
        wrapText(ctx, scene.body, pad, canvas.height - Math.round(scrimH * 0.22), canvas.width - pad * 2, Math.max(30, canvas.width * 0.025), 2);
      }
    }
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    roundedRect(ctx, pad, panelY, panelW, panelH, 28);
    ctx.fill();
    ctx.fillStyle = "#136f63";
    ctx.font = \`700 \${Math.max(24, canvas.width * 0.018)}px system-ui, sans-serif\`;
    ctx.fillText(\`SCENE \${index + 1}\`, pad + 54, panelY + 72);
    ctx.fillStyle = "#17211b";
    ctx.font = \`800 \${Math.max(58, canvas.width * 0.055)}px Georgia, serif\`;
    wrapText(ctx, scene.title || data.title, pad + 54, panelY + 165, panelW - 108, Math.max(64, canvas.width * 0.064), 3);
    ctx.fillStyle = "#3d4a43";
    ctx.font = \`400 \${Math.max(28, canvas.width * 0.024)}px system-ui, sans-serif\`;
    wrapText(ctx, scene.body || "", pad + 56, panelY + panelH - 150, panelW - 112, Math.max(38, canvas.width * 0.031), 4);
  }

  const barW = canvas.width - pad * 2;
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(255,255,255,0.32)";
  roundedRect(ctx, pad, canvas.height - pad, barW, 12, 6);
  ctx.fill();
  ctx.fillStyle = "#74c7b8";
  roundedRect(ctx, pad, canvas.height - pad, barW * Math.min(1, timeSeconds / data.durationSeconds), 12, 6);
  ctx.fill();
  ctx.restore();
}

function tick() {
  if (!playing) return;
  const now = performance.now();
  const elapsed = (now - startedAt) / 1000;
  const time = Math.min(data.durationSeconds, elapsed);
  renderAt(time);
  if (time >= data.durationSeconds) {
    playing = false;
    playButton.textContent = "Play";
    if (audio) audio.pause();
    pausedAt = 0;
    return;
  }
  rafId = requestAnimationFrame(tick);
}

playButton.addEventListener("click", () => {
  playing = !playing;
  playButton.textContent = playing ? "Pause" : "Play";
  if (playing) {
    startedAt = performance.now() - pausedAt * 1000;
    if (audio) {
      audio.currentTime = pausedAt;
      audio.play().catch(() => {});
    }
    tick();
  } else {
    cancelAnimationFrame(rafId);
    pausedAt = Number(timeline.value);
    if (audio) audio.pause();
  }
});

timeline.addEventListener("input", () => {
  pausedAt = Number(timeline.value);
  if (playing) startedAt = performance.now() - pausedAt * 1000;
  if (audio) audio.currentTime = pausedAt;
  renderAt(pausedAt);
});

async function ensureWebCodecs() {
  if (!("VideoEncoder" in globalThis) || !("VideoFrame" in globalThis)) {
    throw new Error("This browser does not support WebCodecs VideoEncoder.");
  }
  const config = {
    codec: "avc1.420028",
    width: data.width,
    height: data.height,
    bitrate: Math.max(2_500_000, data.width * data.height * 1.2),
    framerate: data.fps,
    hardwareAcceleration: "prefer-hardware"
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error("This browser cannot encode H.264 MP4 with WebCodecs.");
  return support.config;
}

async function exportMp4() {
  exportButton.disabled = true;
  playButton.disabled = true;
  try {
    const encoderConfig = await ensureWebCodecs();
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: "avc", width: data.width, height: data.height, frameRate: data.fps },
      fastStart: "in-memory"
    });
    let encodeError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (error) => { encodeError = error; }
    });
    encoder.configure(encoderConfig);
    const totalFrames = Math.ceil(data.durationSeconds * data.fps);
    for (let frame = 0; frame < totalFrames; frame++) {
      const seconds = frame / data.fps;
      await renderAt(seconds);
      const videoFrame = new VideoFrame(canvas, { timestamp: Math.round(seconds * 1_000_000) });
      encoder.encode(videoFrame, { keyFrame: frame % (data.fps * 2) === 0 });
      videoFrame.close();
      if (frame % 10 === 0) {
        setStatus(\`Encoding frame \${frame + 1} of \${totalFrames}...\`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    encoder.close();
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = data.outputPath || "video.mp4";
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(\`Exported \${(blob.size / 1024 / 1024).toFixed(2)} MB MP4. Audio is preview-only in this version.\`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "MP4 export failed.");
  } finally {
    exportButton.disabled = false;
    playButton.disabled = false;
  }
}

exportButton.addEventListener("click", exportMp4);
renderAt(0);
`;
}

async function handleCreateVideoPresentation(input: VideoPresentationInput, ctx: ToolContext): Promise<ToolResult> {
  const duration = input.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
  const project = await createBaseProject(ctx, input.title, "Generated storyboard/video-preview (not a finished explainer video).", "index.html");
  const files = [
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", renderVideoPresentationPage(input)),
    await writeProjectFile(ctx.projectRoot, project.id, "video.css", videoPresentationCss()),
    await writeProjectFile(ctx.projectRoot, project.id, "video.js", videoPresentationScript())
  ];
  const vendor = await copyMp4MuxerVendor(ctx, project.id);
  const published = await maybePublish(ctx, project.id, input.publish);
  const manifest = await getProjectManifest(ctx.projectRoot, project.id);
  return {
    ok: true,
    summary: input.publish
      ? `Created and published browser-rendered storyboard/video-preview ${project.id} (not a finished explainer video). MP4 export is video-only and runs in-browser via WebCodecs.`
      : `Created browser-rendered storyboard/video-preview ${project.id} (not a finished explainer video). MP4 export is video-only and runs in-browser via WebCodecs.`,
    jobId: project.id,
    previewUrl: published.previewUrl,
    shareUrl: published.shareUrl,
    artifacts: [...files.map((file) => file.path), ...vendor],
    structuredContent: {
      qualityTier: "storyboard_preview",
      productionReady: false,
      limitations: [
        "No audio mixing or voice-over in exported MP4",
        "No subtitle/caption burn-in",
        "No professional motion templates or server-side final render",
        "Browser-side WebCodecs encoder only — quality and compatibility varies by browser"
      ],
      recommendedNextTools: [
        "create_media_scene_timeline",
        "add_media_captions",
        "attach_media_voice_audio",
        "preview_media_frames",
        "export_media_project"
      ]
    },
    logs: [JSON.stringify({ projectId: project.id, files: manifest.files, publishedUrl: published.metadata?.publishedUrl, durationSeconds: duration, fps: input.fps, aspectRatio: input.aspectRatio, exportMode: "browser_webcodecs" }, null, 2)],
    errors: []
  };
}

async function handleCreateMediaSceneTimeline(input: z.infer<typeof createMediaSceneTimelineInputSchema>, ctx: ToolContext): Promise<ToolResult> {
  const parsed = createMediaSceneTimelineInputSchema.parse(input);
  const timeline = createMediaTimeline(parsed);
  const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(timeline, null, 2)}\n`);
  return {
    ok: true,
    summary: `Created media timeline with ${timeline.scenes.length} scene(s), ${timeline.durationSeconds}s, ${timeline.totalFrames} frame(s).`,
    jobId: parsed.projectId,
    artifacts: [file.path],
    structuredContent: { timelinePath: file.path, ...timeline },
    logs: [JSON.stringify(timeline, null, 2)],
    errors: []
  };
}

async function handleAddMediaCaptions(input: z.infer<typeof addMediaCaptionsInputSchema>, ctx: ToolContext): Promise<ToolResult> {
  const parsed = addMediaCaptionsInputSchema.parse(input);
  const timeline = JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.timelinePath)) as MediaTimeline;
  const captions = parsed.captions ?? captionsFromTimeline(timeline, parsed.transcript);
  const vtt = renderVtt(captions);
  const manifest = {
    timelinePath: parsed.timelinePath,
    captionsPath: parsed.outputPath,
    cueCount: captions.length,
    durationSeconds: timeline.durationSeconds,
    checks: ["webvtt_generated", "cue_times_monotonic", "captions_reference_timeline"]
  };
  const vttFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, vtt);
  const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify({ ...manifest, captions }, null, 2)}\n`);
  return { ok: true, summary: `Added ${captions.length} caption cue(s) to media timeline.`, jobId: parsed.projectId, artifacts: [vttFile.path, manifestFile.path], structuredContent: { ...manifest, manifestPath: manifestFile.path }, logs: [JSON.stringify(manifest, null, 2)], errors: [] };
}

async function handleAttachMediaVoiceAudio(input: z.infer<typeof attachMediaVoiceAudioInputSchema>, ctx: ToolContext): Promise<ToolResult> {
  const parsed = attachMediaVoiceAudioInputSchema.parse(input);
  const timeline = JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.timelinePath)) as MediaTimeline;
  const voiceSegments = parsed.voiceSegments ?? timeline.scenes.map((scene) => ({ sceneId: scene.id, startSeconds: scene.startSeconds, endSeconds: scene.endSeconds, transcript: scene.body || scene.title || scene.id }));
  const warnings = [];
  const voiceDuration = voiceSegments.reduce((max, segment) => Math.max(max, segment.endSeconds), 0);
  if (voiceDuration > timeline.durationSeconds + 0.25) warnings.push("Voice segments exceed timeline duration; trim audio or extend scenes.");
  const manifest = {
    timelinePath: parsed.timelinePath,
    audioPath: parsed.audioPath,
    voiceSegments,
    duckBackgroundAudio: parsed.duckBackgroundAudio,
    alignment: voiceSegments.map((segment, index) => ({ ...segment, id: `voice_${index + 1}`, startFrame: Math.round(segment.startSeconds * timeline.fps), endFrame: Math.round(segment.endSeconds * timeline.fps) })),
    warnings,
    checks: ["audio_reference_attached", "scene_voice_alignment", "frame_alignment_calculated"]
  };
  const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: warnings.length === 0, summary: `Attached voice audio reference with ${voiceSegments.length} segment(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { ...manifest, audioManifestPath: file.path }, logs: [JSON.stringify(manifest, null, 2)], errors: warnings };
}

async function handlePreviewMediaFrames(input: z.infer<typeof previewMediaFramesInputSchema>, ctx: ToolContext): Promise<ToolResult> {
  const parsed = previewMediaFramesInputSchema.parse(input);
  const timeline = JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.timelinePath)) as MediaTimeline;
  const times = parsed.frameTimes ?? defaultFrameTimes(timeline, parsed.count);
  const frames = times.map((timeSeconds) => {
    const scene = sceneAt(timeline, Math.min(timeSeconds, Math.max(0, timeline.durationSeconds - 0.001)));
    return { timeSeconds, frame: Math.round(timeSeconds * timeline.fps), sceneId: scene.id, title: scene.title, sourcePath: scene.sourcePath };
  });
  const manifest = { timelinePath: parsed.timelinePath, framePreviewHtmlPath: parsed.outputHtmlPath, frameCount: frames.length, frames, checks: ["frame_times_resolved", "scene_lookup_complete", "html_contact_sheet_generated"] };
  const htmlFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputHtmlPath, framePreviewHtml(timeline, frames));
  const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: true, summary: `Created media frame preview with ${frames.length} frame marker(s).`, jobId: parsed.projectId, artifacts: [htmlFile.path, manifestFile.path], structuredContent: { ...manifest, manifestPath: manifestFile.path }, logs: [JSON.stringify(manifest, null, 2)], errors: [] };
}

async function handleExportMediaProject(input: z.infer<typeof exportMediaProjectInputSchema>, ctx: ToolContext): Promise<ToolResult> {
  const parsed = exportMediaProjectInputSchema.parse(input);
  const timeline = JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.timelinePath)) as MediaTimeline;
  const manifest = {
    timelinePath: parsed.timelinePath,
    captionsPath: parsed.captionsPath,
    audioManifestPath: parsed.audioManifestPath,
    framePreviewPath: parsed.framePreviewPath,
    durationSeconds: timeline.durationSeconds,
    fps: timeline.fps,
    totalFrames: timeline.totalFrames,
    exportPlans: mediaExportPlans(timeline, parsed.formats),
    commonFormats: parsed.formats,
    renderer: "Code-MCP scripted media renderer",
    licenseReport: {
      commerciallyUsableWorkflow: true,
      paidVideoEngineDependency: false,
      allowedDependencyLicenses: ["MIT", "Apache-2.0", "BSD", "ISC", "CC0", "web-standard", "project-native"],
      softwareDependencies: openMediaRendererPolicy().softwareDependencies,
      externalEncoderRequirement: "Any optional external byte encoder must be separately verified for commercial-use licensing before delivery."
    },
    notes: [
      "This manifest records a deterministic media export plan from project files and data.",
      "HTML preview is ready from project files; MP4/WebM/GIF/PNG byte export requires a verified browser/WebCodecs or CLI encoder step.",
      "Audio references and captions are tracked as handoff artifacts; muxing must be verified during final encoding."
    ],
    checks: ["timeline_loaded", "formats_planned", "caption_audio_references_recorded", "encoder_step_explicit"]
  };
  const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: true, summary: `Created media export manifest for ${parsed.formats.length} format(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { ...manifest, exportManifestPath: file.path }, logs: [JSON.stringify(manifest, null, 2)], errors: [] };
}

export const presentationTools: ToolModule[] = [
  {
    definition: {
      name: "create_html_deck",
      description: "Create a browser-native reveal.js slide deck project, optionally publish it, and return generated files.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          theme: { type: "string", enum: ["executive", "product", "technical", "visual"] },
          slides: { type: "array", items: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, notes: { type: "string" }, layout: { type: "string", enum: ["title", "section", "content", "two_column", "image", "quote", "code", "comparison"], description: "Slide layout. Defaults to content." }, imagePath: { type: "string" }, bullets: { type: "array", items: { type: "string" } }, code: { type: "object", properties: { language: { type: "string" }, content: { type: "string" } } } }, required: ["title"] } },
          publish: { type: "boolean" }
        },
        required: ["title", "slides"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: createHtmlDeckInputSchema,
    handler: async (input, ctx) => handleCreateHtmlDeck(input as HtmlDeckInput, ctx)
  },
  {
    definition: {
      name: "create_pptx_deck",
      description: "Create a real PowerPoint .pptx deck with text, images, tables, and simple charts.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          title: { type: "string" },
          slides: { type: "array", items: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, notes: { type: "string" }, layout: { type: "string", enum: ["title", "section", "content", "two_column", "image", "quote", "chart", "table"], description: "Slide layout. Defaults to content." }, imagePath: { type: "string" }, bullets: { type: "array", items: { type: "string" } }, table: { type: "object", properties: { headers: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "array", items: { type: "string" } } } } }, chart: { type: "object", properties: { type: { type: "string", enum: ["bar", "line", "pie"] }, labels: { type: "array", items: { type: "string" } }, values: { type: "array", items: { type: "number" } } } } }, required: ["title"] } },
          outputPath: { type: "string" }
        },
        required: ["title", "slides"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: createPptxDeckInputSchema,
    handler: async (input, ctx) => handleCreatePptxDeck(input as PptxDeckInput, ctx)
  },
  {
    definition: {
      name: "create_immersive_page",
      description: "Create a polished interactive HTML/CSS/JS webpage project, optionally publish it.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          style: { type: "string", enum: ["editorial", "product_demo", "data_story", "portfolio", "interactive_explainer"] },
          sections: { type: "array", items: { type: "object" } },
          brandName: { type: "string" },
          primaryAction: { type: "string" },
          secondaryAction: { type: "string" },
          enableThreeJs: { type: "boolean" },
          publish: { type: "boolean" }
        },
        required: ["title", "sections"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: createImmersivePageInputSchema,
    handler: async (input, ctx) => handleCreateImmersivePage(input as ImmersivePageInput, ctx)
  },
  {
    definition: {
      name: "create_video_presentation",
      description: "Create a browser-rendered storyboard/video-preview from scenes. Output is a preview page with a video-only MP4 export button (browser WebCodecs, no audio mix or subtitle burn-in). Not a finished explainer video — for production-ready video use the scripted media workflow. Stays private unless publish=true.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          aspectRatio: { type: "string", enum: ["16:9", "9:16", "1:1"] },
          fps: { type: "number", enum: [24, 30] },
          scenes: { type: "array", items: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, imagePath: { type: "string" }, layout: { type: "string", enum: ["text", "title_card", "code", "dryrun", "typewriter", "ken_burns"] }, code: { type: "string" }, steps: { type: "array", items: { type: "object" } }, hold: { type: "number" }, ease: { type: "string" }, durationSeconds: { type: "number" }, transition: { type: "string" } } } },
          audioPath: { type: "string" },
          outputPath: { type: "string" },
          publish: { type: "boolean" }
        },
        required: ["title", "scenes"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: createVideoPresentationInputSchema,
    handler: async (input, ctx) => handleCreateVideoPresentation(input as VideoPresentationInput, ctx)
  },
  {
    definition: {
      name: "create_media_scene_timeline",
      description: "Create a deterministic scripted media scene timeline from project files or data with scene timing, frame ranges, transitions, and render contract.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, title: { type: "string" }, aspectRatio: { type: "string" }, fps: { type: "number" }, scenes: { type: "array", items: { type: "object" } }, outputPath: { type: "string" } },
        required: ["projectId", "title", "scenes"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: createMediaSceneTimelineInputSchema,
    handler: async (input, ctx) => handleCreateMediaSceneTimeline(input as z.infer<typeof createMediaSceneTimelineInputSchema>, ctx)
  },
  {
    definition: {
      name: "add_media_captions",
      description: "Add WebVTT captions to a scripted media timeline from explicit cues, transcript text, or scene text.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, timelinePath: { type: "string" }, captions: { type: "array", items: { type: "object" } }, transcript: { type: "string" }, outputPath: { type: "string" }, outputManifestPath: { type: "string" } },
        required: ["projectId", "timelinePath"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: addMediaCaptionsInputSchema,
    handler: async (input, ctx) => handleAddMediaCaptions(input as z.infer<typeof addMediaCaptionsInputSchema>, ctx)
  },
  {
    definition: {
      name: "attach_media_voice_audio",
      description: "Attach a voice audio reference to a media timeline and calculate scene/frame-aligned voice segments.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, timelinePath: { type: "string" }, audioPath: { type: "string" }, voiceSegments: { type: "array", items: { type: "object" } }, duckBackgroundAudio: { type: "boolean" }, outputPath: { type: "string" } },
        required: ["projectId", "timelinePath", "audioPath"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: attachMediaVoiceAudioInputSchema,
    handler: async (input, ctx) => handleAttachMediaVoiceAudio(input as z.infer<typeof attachMediaVoiceAudioInputSchema>, ctx)
  },
  {
    definition: {
      name: "preview_media_frames",
      description: "Generate a contact-sheet HTML preview and frame manifest for selected times in a scripted media timeline.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, timelinePath: { type: "string" }, frameTimes: { type: "array", items: { type: "number" } }, count: { type: "number" }, outputHtmlPath: { type: "string" }, outputManifestPath: { type: "string" } },
        required: ["projectId", "timelinePath"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: previewMediaFramesInputSchema,
    handler: async (input, ctx) => handlePreviewMediaFrames(input as z.infer<typeof previewMediaFramesInputSchema>, ctx)
  },
  {
    definition: {
      name: "export_media_project",
      description: "Create an export manifest for scripted media formats such as MP4, WebM, GIF, PNG sequence, and HTML preview with explicit encoder requirements.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, timelinePath: { type: "string" }, captionsPath: { type: "string" }, audioManifestPath: { type: "string" }, framePreviewPath: { type: "string" }, formats: { type: "array", items: { type: "string" } }, outputPath: { type: "string" } },
        required: ["projectId", "timelinePath"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: exportMediaProjectInputSchema,
    handler: async (input, ctx) => handleExportMediaProject(input as z.infer<typeof exportMediaProjectInputSchema>, ctx)
  }
];
