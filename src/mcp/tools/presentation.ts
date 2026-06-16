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
  validateProject,
  writeProjectAsset,
  writeProjectFile
} from "../../projects/store.js";
import type { ProjectMetadata } from "../../projects/store.js";
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
    durationSeconds: z.number().min(0.5).max(30),
    transition: z.enum(["cut", "fade", "slide", "zoom"]).optional().default("fade")
  })).min(1).max(30),
  audioPath: z.string().min(1).max(240).optional(),
  outputPath: z.string().min(1).max(240).optional().default("video.mp4")
}).refine((value) => value.scenes.reduce((total, scene) => total + scene.durationSeconds, 0) <= 180, {
  message: "Video presentations are limited to 180 seconds."
});

type HtmlDeckInput = z.infer<typeof createHtmlDeckInputSchema>;
type PptxDeckInput = z.infer<typeof createPptxDeckInputSchema>;
type ImmersivePageInput = z.infer<typeof createImmersivePageInputSchema>;
type VideoPresentationInput = z.infer<typeof createVideoPresentationInputSchema>;

function escapeHtml(value: string | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cssString(value: string): string {
  return JSON.stringify(value);
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
  const metadata = await publishProject(ctx.projectRoot, projectId, ctx.publicBaseUrl, "index.html");
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

function immersiveCss(style: ImmersivePageInput["style"], enableThreeJs: boolean): string {
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

function renderImmersivePage(input: ImmersivePageInput): string {
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

async function writeOptionalThreeVendor(ctx: ToolContext, projectId: string, enabled: boolean): Promise<string[]> {
  if (!enabled) return [];
  const threeBuild = path.dirname(require.resolve("three"));
  const threePath = path.join(threeBuild, "three.module.js");
  const content = await readFile(threePath, "utf8");
  const file = await writeProjectFile(ctx.projectRoot, projectId, "vendor/three/three.min.js", content);
  return [file.path];
}

async function handleCreateImmersivePage(input: ImmersivePageInput, ctx: ToolContext): Promise<ToolResult> {
  const project = await createBaseProject(ctx, input.title, `Generated immersive ${input.style} page.`, "index.html");
  const files = [
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", renderImmersivePage(input)),
    await writeProjectFile(ctx.projectRoot, project.id, "page.css", immersiveCss(input.style, input.enableThreeJs)),
    await writeProjectFile(ctx.projectRoot, project.id, "page.js", immersiveScript(input.enableThreeJs))
  ];
  const vendor = await writeOptionalThreeVendor(ctx, project.id, input.enableThreeJs);
  const published = await maybePublish(ctx, project.id, input.publish);
  const manifest = await getProjectManifest(ctx.projectRoot, project.id);
  return {
    ok: true,
    summary: input.publish ? `Created and published immersive page ${project.id}.` : `Created immersive page ${project.id}.`,
    jobId: project.id,
    previewUrl: published.previewUrl,
    shareUrl: published.shareUrl,
    artifacts: [...files.map((file) => file.path), ...vendor],
    logs: [JSON.stringify({ projectId: project.id, files: manifest.files, publishedUrl: published.metadata?.publishedUrl }, null, 2)],
    errors: []
  };
}

function handleCreateVideoPresentation(input: VideoPresentationInput): ToolResult {
  const duration = input.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
  if (process.env.VIDEO_RENDER_ENABLED !== "true") {
    return {
      ok: false,
      summary: "Video rendering is disabled. Set VIDEO_RENDER_ENABLED=true after configuring the Remotion render pipeline.",
      artifacts: [],
      logs: [JSON.stringify({ title: input.title, aspectRatio: input.aspectRatio, fps: input.fps, durationSeconds: duration, outputPath: input.outputPath }, null, 2)],
      errors: ["VIDEO_RENDER_ENABLED is not true."]
    };
  }
  return {
    ok: false,
    summary: "Video rendering is not implemented in this build.",
    artifacts: [],
    logs: [JSON.stringify({ title: input.title, aspectRatio: input.aspectRatio, fps: input.fps, durationSeconds: duration, outputPath: input.outputPath }, null, 2)],
    errors: ["Remotion render execution is reserved for the next implementation phase."]
  };
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
          slides: { type: "array", items: { type: "object" } },
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
          slides: { type: "array", items: { type: "object" } },
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
      description: "Prepare a video presentation request. Rendering is feature-gated behind VIDEO_RENDER_ENABLED.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          aspectRatio: { type: "string", enum: ["16:9", "9:16", "1:1"] },
          fps: { type: "number", enum: [24, 30] },
          scenes: { type: "array", items: { type: "object" } },
          audioPath: { type: "string" },
          outputPath: { type: "string" }
        },
        required: ["title", "scenes"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: createVideoPresentationInputSchema,
    handler: (input) => handleCreateVideoPresentation(input as VideoPresentationInput)
  }
];
