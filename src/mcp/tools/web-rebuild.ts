import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createShareArtifact } from "../../share/store.js";
import {
  appendProjectTaskHistory,
  createProject,
  publishProject,
  recordProjectBrowserInspection,
  unpublishProject,
  validateProject,
  writeProjectFile
} from "../../projects/store.js";
import {
  captureWebpage,
  getCaptureRoot,
  readWebpageCapture,
  saveWebpageCapture,
  type CapturedPage,
  type WebpageCapture
} from "../../web-capture/capture.js";
import { renderAnalysisReport, renderCaptureReport, type WebpageAnalysis } from "../../web-capture/report.js";
import { makeShareUrl } from "../result.js";
import type { ToolModule } from "../types.js";
import { inspectWebpageUrl, renderWebpageInspectionReport, summarizeBrowserInspection } from "./web-inspect.js";

const focusValues = ["ux", "accessibility", "performance", "seo", "implementation"] as const;

const captureWebpageSchema = z.object({
  url: z.string().url(),
  mode: z.enum(["single_page", "same_origin_depth_1"]).optional().default("single_page"),
  viewports: z.array(z.enum(["desktop", "tablet", "mobile"])).min(1).max(3).optional().default(["desktop", "mobile"]),
  maxPages: z.number().int().min(1).max(5).optional().default(1),
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000),
  respectRobotsTxt: z.boolean().optional().default(true),
  includeScreenshots: z.boolean().optional().default(true),
  includeNetwork: z.boolean().optional().default(true)
});

const analyzeWebpageCaptureSchema = z.object({
  captureId: z.string().uuid(),
  focus: z.array(z.enum(focusValues)).min(1).max(5).optional().default(["ux", "accessibility", "performance", "seo", "implementation"])
});

const generateImprovedStaticPageSchema = z.object({
  captureId: z.string().uuid(),
  analysisId: z.string().uuid(),
  title: z.string().min(1).max(160),
  preserveContent: z.boolean().optional().default(true),
  styleDirection: z.string().min(1).max(200).optional().default("clean operational web app"),
  browserValidation: z.boolean().optional().default(true)
});

const designSurfaceSchema = z.enum(["admin_panel", "landing_page", "dashboard", "game_ui", "mobile_app", "component_library", "generic_web"]);

const convertDesignToStaticProjectSchema = z.object({
  title: z.string().min(1).max(160),
  designBrief: z.string().min(1).max(6000),
  surface: designSurfaceSchema.optional().default("generic_web"),
  referenceImages: z.array(z.string().min(1).max(2000)).max(12).optional().default([]),
  wireframe: z.array(z.object({
    id: z.string().min(1).max(80),
    role: z.string().min(1).max(80),
    text: z.string().max(500).optional(),
    priority: z.enum(["primary", "secondary", "tertiary"]).optional().default("secondary")
  })).max(30).optional().default([]),
  components: z.array(z.string().min(1).max(80)).max(40).optional().default([]),
  styleTokens: z.object({
    primary: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    accent: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    background: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    text: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    radius: z.number().int().min(0).max(24).optional(),
    density: z.enum(["compact", "comfortable", "spacious"]).optional()
  }).optional().default({}),
  responsiveVariants: z.array(z.enum(["desktop", "tablet", "mobile"])).min(1).max(3).optional().default(["desktop", "mobile"]),
  browserValidation: z.boolean().optional().default(true),
  publish: z.boolean().optional().default(true)
});

function analysisPath(captureRoot: string, analysisId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(analysisId)) throw new Error("Invalid analysisId.");
  return path.join(captureRoot, `${analysisId}.analysis.json`);
}

async function saveAnalysis(captureRoot: string, analysis: WebpageAnalysis): Promise<void> {
  await mkdir(captureRoot, { recursive: true });
  await writeFile(analysisPath(captureRoot, analysis.analysisId), `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
}

async function readAnalysis(captureRoot: string, analysisId: string): Promise<WebpageAnalysis> {
  try {
    return JSON.parse(await readFile(analysisPath(captureRoot, analysisId), "utf8")) as WebpageAnalysis;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Analysis not found: ${analysisId}`);
    }
    throw error;
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function safeHref(href: string): string {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? href : "#";
  } catch {
    return /^javascript:/i.test(href.trim()) ? "#" : href;
  }
}

function firstUsefulPage(capture: WebpageCapture): CapturedPage {
  const page = capture.pages.find((candidate) => candidate.viewport === "desktop") ?? capture.pages[0];
  if (!page) throw new Error(`Capture has no pages: ${capture.captureId}`);
  return page;
}

function analyzeCapture(capture: WebpageCapture, focus: string[]): WebpageAnalysis {
  const page = firstUsefulPage(capture);
  const findings: WebpageAnalysis["findings"] = [];
  const recommendations: string[] = [];
  const resources = capture.resources;

  if (focus.includes("seo")) {
    if (!page.title.trim()) findings.push({ category: "seo", severity: "error", message: "The captured page has no document title." });
    if (!page.metaDescription?.trim()) findings.push({ category: "seo", severity: "warning", message: "The captured page has no meta description." });
    if (!page.headings.some((heading) => heading.level === 1)) findings.push({ category: "seo", severity: "warning", message: "The page has no H1 heading." });
    recommendations.push("Keep one clear H1, a concise title, and a meta description that describes the page offer or workflow.");
  }

  if (focus.includes("accessibility")) {
    const missingAlt = page.images.filter((image) => !image.alt.trim()).length;
    if (missingAlt > 0) findings.push({ category: "accessibility", severity: "warning", message: `${missingAlt} image(s) are missing alt text.` });
    const unlabeledFields = capture.forms.flatMap((form) => form.fields).filter((field) => !field.name && !field.placeholder).length;
    if (unlabeledFields > 0) findings.push({ category: "accessibility", severity: "warning", message: `${unlabeledFields} form field(s) lack a name or placeholder signal.` });
    recommendations.push("Use semantic sections, visible labels for form fields, and descriptive alt text for informative images.");
  }

  if (focus.includes("performance")) {
    const failed = resources.filter((resource) => resource.failed || (resource.status && resource.status >= 400));
    const slow = resources.filter((resource) => (resource.durationMs ?? 0) > 2000);
    if (resources.length >= 100) findings.push({ category: "performance", severity: "warning", message: "The page has a large resource footprint in the captured network sample." });
    if (failed.length > 0) findings.push({ category: "performance", severity: "error", message: `${failed.length} resource request(s) failed or returned an error status.` });
    if (slow.length > 0) findings.push({ category: "performance", severity: "warning", message: `${slow.length} resource request(s) took more than 2 seconds.` });
    recommendations.push("Reduce nonessential scripts, keep critical content in first-party HTML/CSS, and lazy-load heavy media.");
  }

  if (focus.includes("ux")) {
    if (page.visibleText.length < 300) findings.push({ category: "ux", severity: "info", message: "The captured visible text is very short; the improved page should clarify the offer and next action." });
    if (capture.interactions.length === 0) findings.push({ category: "ux", severity: "warning", message: "No obvious interactive controls or links were captured." });
    recommendations.push("Preserve the main content, then make the primary action visible early and group secondary information into scannable sections.");
  }

  if (focus.includes("implementation")) {
    const consoleErrors = capture.pages.flatMap((item) => item.consoleErrors);
    const pageErrors = capture.pages.flatMap((item) => item.pageErrors);
    if (consoleErrors.length > 0) findings.push({ category: "implementation", severity: "error", message: `${consoleErrors.length} console error(s) were captured.` });
    if (pageErrors.length > 0) findings.push({ category: "implementation", severity: "error", message: `${pageErrors.length} runtime page error(s) were captured.` });
    recommendations.push("Rebuild the static version with local, minimal JS and avoid copying opaque third-party runtime logic.");
  }

  for (const issue of capture.issues.slice(0, 12)) {
    findings.push({ category: "capture", severity: "warning", message: issue });
  }

  return {
    analysisId: randomUUID(),
    captureId: capture.captureId,
    analyzedAt: new Date().toISOString(),
    focus,
    findings,
    recommendations: [...new Set(recommendations)]
  };
}

function textLines(value: string, limit: number): string[] {
  return value.split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, limit);
}

function generateIndexHtml(capture: WebpageCapture, analysis: WebpageAnalysis, title: string, preserveContent: boolean, styleDirection: string): string {
  const page = firstUsefulPage(capture);
  const h1 = page.headings.find((heading) => heading.level === 1)?.text || page.title || title;
  const intro = page.metaDescription || textLines(page.visibleText, 1)[0] || `Improved static version of ${capture.sourceUrl}.`;
  const contentLines = preserveContent ? textLines(page.visibleText, 8) : [];
  const navLinks = page.links.filter((link) => link.text).slice(0, 6);
  const buttons = capture.interactions.filter((item) => item.text).slice(0, 6);
  const form = capture.forms[0];
  const recommendations = analysis.recommendations.slice(0, 4);

  const formHtml = form ? `<form class="lead-form" data-enhanced-form>
      ${form.fields.slice(0, 8).map((field) => `<label>${escapeHtml(field.placeholder || field.name || "Field")}<input name="${escapeHtml(field.name || "field")}" type="${escapeHtml(field.type === "textarea" || field.type === "select" ? "text" : field.type)}" ${field.required ? "required" : ""}></label>`).join("")}
      <button type="submit">Submit</button>
      <p class="form-status" aria-live="polite"></p>
    </form>` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(intro.slice(0, 155))}">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="#">${escapeHtml(title)}</a>
    <nav>${navLinks.map((link) => `<a href="${escapeHtml(safeHref(link.href))}">${escapeHtml(link.text)}</a>`).join("")}</nav>
  </header>
  <main>
    <section class="hero">
      <div>
        <p class="kicker">${escapeHtml(styleDirection)}</p>
        <h1>${escapeHtml(h1)}</h1>
        <p class="lede">${escapeHtml(intro)}</p>
        <div class="actions">
          ${(buttons.length > 0 ? buttons : [{ text: "Get started" }]).slice(0, 3).map((button) => `<a class="button" href="#">${escapeHtml(button.text)}</a>`).join("")}
        </div>
      </div>
      <aside class="evidence">
        <strong>Source-informed rebuild</strong>
        <span>${capture.pages.length} viewport capture(s)</span>
        <span>${capture.resources.length} resource record(s)</span>
        <span>${capture.forms.length} form(s)</span>
      </aside>
    </section>
    <section class="content-grid">
      ${contentLines.map((line, index) => `<article><span>${String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(line)}</p></article>`).join("")}
    </section>
    <section class="recommendations">
      <h2>Improvement Priorities</h2>
      <ul>${recommendations.map((recommendation) => `<li>${escapeHtml(recommendation)}</li>`).join("")}</ul>
    </section>
    ${formHtml}
  </main>
  <script src="./script.js"></script>
</body>
</html>`;
}

function generateStylesCss(): string {
  return `:root {
  color-scheme: light;
  --ink: #17211d;
  --muted: #607169;
  --paper: #f4f7f1;
  --panel: #ffffff;
  --line: #d8e0dc;
  --accent: #0b695d;
  --accent-strong: #063f38;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  background: linear-gradient(180deg, #eef4ed 0%, var(--paper) 48%, #ffffff 100%);
  color: var(--ink);
}
a { color: inherit; }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 18px clamp(18px, 4vw, 56px);
  border-bottom: 1px solid var(--line);
  background: rgba(255,255,255,0.84);
  backdrop-filter: blur(14px);
  position: sticky;
  top: 0;
}
.brand { font-weight: 800; text-decoration: none; }
nav { display: flex; gap: 16px; flex-wrap: wrap; color: var(--muted); font-size: 14px; }
nav a { text-decoration: none; }
main { width: min(1120px, calc(100vw - 32px)); margin: 0 auto; }
.hero {
  min-height: 68vh;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 32px;
  align-items: center;
  padding: 64px 0 40px;
}
.kicker { color: var(--accent); font-weight: 800; text-transform: uppercase; font-size: 13px; }
h1 { font-size: clamp(42px, 6vw, 76px); line-height: .96; margin: 0 0 20px; letter-spacing: 0; }
.lede { font-size: 20px; line-height: 1.5; color: var(--muted); max-width: 720px; }
.actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 26px; }
.button {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  padding: 0 18px;
  border-radius: 6px;
  background: var(--accent);
  color: white;
  text-decoration: none;
  font-weight: 700;
}
.evidence {
  display: grid;
  gap: 10px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 20px 50px rgba(18, 37, 30, .08);
}
.evidence span { color: var(--muted); }
.content-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  padding: 20px 0 42px;
}
article, .recommendations, .lead-form {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  padding: 18px;
}
article span { color: var(--accent); font-weight: 800; }
article p { color: var(--muted); line-height: 1.55; }
.recommendations { margin-bottom: 24px; }
.recommendations li { margin: 10px 0; line-height: 1.45; }
.lead-form {
  display: grid;
  gap: 14px;
  margin: 0 0 56px;
}
.lead-form label { display: grid; gap: 6px; color: var(--muted); }
.lead-form input {
  min-height: 44px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0 12px;
  font: inherit;
}
.lead-form button {
  min-height: 44px;
  border: 0;
  border-radius: 6px;
  background: var(--accent-strong);
  color: white;
  font-weight: 800;
}
.form-status { margin: 0; color: var(--accent); }
@media (max-width: 760px) {
  .topbar { align-items: flex-start; flex-direction: column; }
  .hero { grid-template-columns: 1fr; min-height: auto; padding-top: 42px; }
  .content-grid { grid-template-columns: 1fr; }
  h1 { font-size: 42px; }
}`;
}

function generateScriptJs(): string {
  return `for (const form of document.querySelectorAll("[data-enhanced-form]")) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const status = form.querySelector(".form-status");
    if (status) status.textContent = "Form captured locally in this static preview.";
  });
}
`;
}

type DesignConversionInput = z.infer<typeof convertDesignToStaticProjectSchema>;

function sentenceFromBrief(brief: string, fallback: string): string {
  return brief.split(/[.!?\n]/).map((item) => item.trim()).find(Boolean)?.slice(0, 220) || fallback;
}

function uniqueComponents(input: DesignConversionInput): string[] {
  const defaultsBySurface: Record<z.infer<typeof designSurfaceSchema>, string[]> = {
    admin_panel: ["sidebar", "topbar", "metric-card", "data-table", "toolbar", "status-pill"],
    landing_page: ["hero", "feature-grid", "testimonial", "pricing-card", "cta-band"],
    dashboard: ["sidebar", "topbar", "metric-card", "chart-panel", "activity-list"],
    game_ui: ["hud", "score-panel", "inventory", "action-bar", "modal"],
    mobile_app: ["app-shell", "bottom-nav", "list-item", "floating-action", "sheet"],
    component_library: ["button", "card", "tabs", "modal", "form-field", "toast"],
    generic_web: ["hero", "card", "button", "form-field", "navigation"]
  };
  return [...new Set([...(input.components.length ? input.components : defaultsBySurface[input.surface]), ...input.wireframe.map((item) => item.role)])]
    .map((component) => component.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""))
    .filter(Boolean)
    .slice(0, 24);
}

function designTokens(input: DesignConversionInput): Record<string, string | number> {
  const compact = input.styleTokens.density === "compact";
  const spacious = input.styleTokens.density === "spacious";
  return {
    primary: input.styleTokens.primary ?? "#145c52",
    accent: input.styleTokens.accent ?? "#d5a11e",
    background: input.styleTokens.background ?? "#f5f7f4",
    text: input.styleTokens.text ?? "#17211d",
    panel: "#ffffff",
    muted: "#66736f",
    line: "#dce3df",
    radius: input.styleTokens.radius ?? 8,
    spacing: compact ? 12 : spacious ? 24 : 18,
    controlHeight: compact ? 36 : spacious ? 48 : 42
  };
}

function renderWireframeItems(input: DesignConversionInput): string {
  const items = input.wireframe.length > 0
    ? input.wireframe
    : [
      { id: "hero", role: "primary-panel", text: sentenceFromBrief(input.designBrief, input.title), priority: "primary" as const },
      { id: "details", role: "content-grid", text: "Translate visual direction into editable, responsive sections.", priority: "secondary" as const },
      { id: "actions", role: "action-bar", text: "Use stable controls and clear feedback states.", priority: "secondary" as const }
    ];
  return items.map((item, index) => `<article class="wire-card ${escapeHtml(item.priority)}" data-component="${escapeHtml(item.role)}">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <h3>${escapeHtml(item.role)}</h3>
      <p>${escapeHtml(item.text || item.id)}</p>
    </article>`).join("\n");
}

function generateDesignIndexHtml(input: DesignConversionInput, components: string[]): string {
  const lead = sentenceFromBrief(input.designBrief, `Static implementation of ${input.title}.`);
  const referenceList = input.referenceImages.map((reference) => `<li><code>${escapeHtml(reference)}</code></li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(lead.slice(0, 155))}">
  <title>${escapeHtml(input.title)}</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body data-surface="${escapeHtml(input.surface)}">
  <aside class="app-sidebar">
    <a class="brand" href="#">${escapeHtml(input.title)}</a>
    <nav>${components.slice(0, 7).map((component) => `<a href="#${escapeHtml(component)}">${escapeHtml(component.replaceAll("-", " "))}</a>`).join("")}</nav>
  </aside>
  <main class="design-shell">
    <header class="hero-panel">
      <p class="eyebrow">${escapeHtml(input.surface.replaceAll("_", " "))}</p>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(lead)}</p>
      <div class="hero-actions">
        <button type="button" data-command="primary">Primary</button>
        <button type="button" class="secondary" data-command="secondary">Secondary</button>
      </div>
    </header>
    <section class="wire-grid" aria-label="Generated layout sections">
      ${renderWireframeItems(input)}
    </section>
    <section class="component-board" aria-label="Extracted components">
      ${components.map((component) => `<article id="${escapeHtml(component)}" class="component-card">
        <div class="component-preview ${escapeHtml(component)}"></div>
        <div>
          <h2>${escapeHtml(component.replaceAll("-", " "))}</h2>
          <p>Editable ${escapeHtml(component)} component generated from the design brief.</p>
        </div>
      </article>`).join("\n")}
    </section>
    ${referenceList ? `<section class="reference-list"><h2>Reference Inputs</h2><ul>${referenceList}</ul></section>` : ""}
    <section class="feedback-panel" aria-live="polite">
      <h2>Implementation Status</h2>
      <p data-status>Ready for visual review and screenshot comparison.</p>
    </section>
  </main>
  <script src="./script.js"></script>
</body>
</html>`;
}

function generateDesignStylesCss(tokens: Record<string, string | number>, variants: string[]): string {
  return `:root {
  --primary: ${tokens.primary};
  --accent: ${tokens.accent};
  --background: ${tokens.background};
  --text: ${tokens.text};
  --panel: ${tokens.panel};
  --muted: ${tokens.muted};
  --line: ${tokens.line};
  --radius: ${tokens.radius}px;
  --space: ${tokens.spacing}px;
  --control: ${tokens.controlHeight}px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  background: var(--background);
  color: var(--text);
  font-family: Inter, "Avenir Next", "Segoe UI", sans-serif;
}
.app-sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  padding: calc(var(--space) * 1.2);
  border-right: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 92%, var(--primary));
}
.brand { display: block; margin-bottom: calc(var(--space) * 1.4); font-weight: 800; text-decoration: none; }
nav { display: grid; gap: 8px; }
nav a { padding: 10px 12px; border-radius: var(--radius); color: var(--muted); text-decoration: none; }
nav a:hover { background: var(--background); color: var(--text); }
.design-shell { width: min(1180px, calc(100vw - 280px)); margin: 0 auto; padding: calc(var(--space) * 1.6); }
.hero-panel, .feedback-panel, .reference-list {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  padding: calc(var(--space) * 1.5);
}
.hero-panel { display: grid; gap: var(--space); min-height: 320px; align-content: center; }
.eyebrow { margin: 0; color: var(--primary); font-size: 12px; font-weight: 800; text-transform: uppercase; }
h1 { max-width: 780px; margin: 0; font-size: 54px; line-height: 1; letter-spacing: 0; }
h2, h3, p { margin-top: 0; }
p { color: var(--muted); line-height: 1.5; }
.hero-actions, .wire-grid, .component-board { display: grid; gap: var(--space); }
.hero-actions { grid-template-columns: repeat(2, max-content); }
button {
  min-height: var(--control);
  border: 0;
  border-radius: calc(var(--radius) - 2px);
  padding: 0 18px;
  background: var(--primary);
  color: white;
  font: inherit;
  font-weight: 800;
}
button.secondary { background: transparent; color: var(--primary); box-shadow: inset 0 0 0 1px var(--line); }
.wire-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); margin: var(--space) 0; }
.wire-card, .component-card {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  padding: var(--space);
}
.wire-card.primary { box-shadow: inset 4px 0 0 var(--primary); }
.wire-card span { color: var(--accent); font-weight: 900; }
.component-board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.component-card { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: var(--space); align-items: center; }
.component-preview {
  width: 88px;
  aspect-ratio: 1;
  border-radius: var(--radius);
  background: linear-gradient(135deg, var(--primary), var(--accent));
}
.reference-list, .feedback-panel { margin-top: var(--space); }
.reference-list code { overflow-wrap: anywhere; }
${variants.includes("tablet") ? "@media (max-width: 960px) { body { grid-template-columns: 1fr; } .app-sidebar { position: static; height: auto; } .design-shell { width: min(100% - 28px, 920px); } .wire-grid, .component-board { grid-template-columns: 1fr 1fr; } }" : ""}
${variants.includes("mobile") ? "@media (max-width: 640px) { h1 { font-size: 38px; } .wire-grid, .component-board, .hero-actions { grid-template-columns: 1fr; } .component-card { grid-template-columns: 1fr; } }" : ""}
`;
}

function generateDesignScriptJs(): string {
  return `document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => {
    const status = document.querySelector("[data-status]");
    if (status) status.textContent = \`\${button.textContent} action captured in the static design preview.\`;
  });
});
`;
}

function generateComponentsMarkdown(input: DesignConversionInput, components: string[], tokens: Record<string, string | number>): string {
  return `# ${input.title} Components

## Design Brief

${input.designBrief}

## Tokens

\`\`\`json
${JSON.stringify(tokens, null, 2)}
\`\`\`

## Components

${components.map((component) => `- \`${component}\`: generated as an editable HTML/CSS component with stable class names and responsive constraints.`).join("\n")}

## Reference Images

${input.referenceImages.length ? input.referenceImages.map((reference) => `- ${reference}`).join("\n") : "- None supplied."}
`;
}

function visualSimilarityReport(input: DesignConversionInput, components: string[]): Record<string, unknown> {
  const signals = [
    input.referenceImages.length > 0 ? "reference-images" : undefined,
    input.wireframe.length > 0 ? "wireframe-regions" : undefined,
    components.length > 0 ? "component-extraction" : undefined,
    input.responsiveVariants.length > 1 ? "responsive-variants" : undefined,
    Object.keys(input.styleTokens).length > 0 ? "style-tokens" : undefined
  ].filter(Boolean);
  const score = Math.min(0.92, 0.48 + signals.length * 0.08 + Math.min(input.wireframe.length, 8) * 0.015);
  return {
    method: "heuristic_design_brief_similarity",
    score: Number(score.toFixed(2)),
    confidence: input.referenceImages.length > 0 ? "medium" : "low",
    signals,
    gaps: [
      input.referenceImages.length === 0 ? "No actual screenshot/image artifact was supplied, so pixel-level diff cannot be computed." : undefined,
      "Run inspect_webpage_plus or visual regression after publishing for browser-captured evidence."
    ].filter(Boolean),
    nextStep: "Compare the published page screenshot against the design reference, then patch component files and re-run validation."
  };
}

function withoutScreenshots(results: Awaited<ReturnType<typeof inspectWebpageUrl>>) {
  return results.map(({ screenshotDataUrl, ...result }) => result);
}

export const webRebuildTools: ToolModule[] = [
  {
    definition: {
      name: "convert_design_to_static_project",
      description: "Convert a screenshot, wireframe, or design reference brief into editable static HTML/CSS/JS with components, CSS tokens, responsive variants, and a visual similarity report.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          designBrief: { type: "string", description: "Description of the screenshot, wireframe, or design target to recreate." },
          surface: { type: "string", enum: ["admin_panel", "landing_page", "dashboard", "game_ui", "mobile_app", "component_library", "generic_web"] },
          referenceImages: { type: "array", items: { type: "string" }, description: "Image artifact URLs, local paths, or design reference identifiers." },
          wireframe: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                role: { type: "string" },
                text: { type: "string" },
                priority: { type: "string", enum: ["primary", "secondary", "tertiary"] }
              },
              required: ["id", "role"],
              additionalProperties: false
            }
          },
          components: { type: "array", items: { type: "string" } },
          styleTokens: {
            type: "object",
            properties: {
              primary: { type: "string" },
              accent: { type: "string" },
              background: { type: "string" },
              text: { type: "string" },
              radius: { type: "number" },
              density: { type: "string", enum: ["compact", "comfortable", "spacious"] }
            },
            additionalProperties: false
          },
          responsiveVariants: { type: "array", items: { type: "string", enum: ["desktop", "tablet", "mobile"] } },
          browserValidation: { type: "boolean" },
          publish: { type: "boolean" }
        },
        required: ["title", "designBrief"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: convertDesignToStaticProjectSchema,
    handler: async (input, ctx) => {
      const parsed = convertDesignToStaticProjectSchema.parse(input);
      const components = uniqueComponents(parsed);
      const tokens = designTokens(parsed);
      const visualReport = visualSimilarityReport(parsed, components);
      const project = await createProject(ctx.projectRoot, {
        title: parsed.title,
        summary: `Design-to-code conversion generated from ${parsed.surface} reference.`,
        entryFile: "index.html",
        createdByClientId: ctx.clientId
      });
      const files = [
        await writeProjectFile(ctx.projectRoot, project.id, "index.html", generateDesignIndexHtml(parsed, components)),
        await writeProjectFile(ctx.projectRoot, project.id, "styles.css", generateDesignStylesCss(tokens, parsed.responsiveVariants)),
        await writeProjectFile(ctx.projectRoot, project.id, "script.js", generateDesignScriptJs()),
        await writeProjectFile(ctx.projectRoot, project.id, "design-system.json", `${JSON.stringify({ title: parsed.title, surface: parsed.surface, tokens, components, wireframe: parsed.wireframe, referenceImages: parsed.referenceImages }, null, 2)}\n`),
        await writeProjectFile(ctx.projectRoot, project.id, "components.md", generateComponentsMarkdown(parsed, components, tokens)),
        await writeProjectFile(ctx.projectRoot, project.id, "visual-validation.json", `${JSON.stringify(visualReport, null, 2)}\n`)
      ];
      const validation = await validateProject(ctx.projectRoot, project.id, "index.html", "static_html");
      let publishedUrl: string | undefined;
      let inspectionReportUrl: string | undefined;
      let browserInspection: Record<string, unknown> | undefined;

      if (validation.ok && parsed.publish) {
        const published = await publishProject(ctx.projectRoot, project.id, ctx.publicBaseUrl, "index.html", { shareBasePath: ctx.publicShareBasePath });
        publishedUrl = published.publishedUrl;
      }

      if (validation.ok && publishedUrl && parsed.browserValidation) {
        const browserResults = await inspectWebpageUrl(publishedUrl, {
          viewports: parsed.responsiveVariants,
          waitUntil: "networkidle",
          screenshot: true,
          fullPage: false,
          maxIssues: 12
        });
        const inspectionShare = await createShareArtifact({
          shareRoot: ctx.shareRoot,
          title: "Design Conversion Browser Inspection",
          summary: `Browser validation for ${project.id}.`,
          filename: `design-conversion-inspection-${project.id}.html`,
          html: renderWebpageInspectionReport(publishedUrl, browserResults)
        });
        inspectionReportUrl = makeShareUrl(ctx.publicBaseUrl, inspectionShare.id, inspectionShare.filename);
        const inspectionSummary = {
          ...summarizeBrowserInspection(withoutScreenshots(browserResults)),
          reportUrl: inspectionReportUrl,
          inspectedAt: new Date().toISOString()
        };
        browserInspection = inspectionSummary as unknown as Record<string, unknown>;
        await recordProjectBrowserInspection(ctx.projectRoot, project.id, inspectionSummary, "convert_design_to_static_project_browser_validation");
      }

      const ok = validation.ok && (!browserInspection || Boolean(browserInspection.ok));
      const report = {
        ok,
        projectId: project.id,
        publishedUrl,
        validation,
        browserInspection,
        inspectionReportUrl,
        designConversion: {
          title: parsed.title,
          surface: parsed.surface,
          components,
          tokens,
          responsiveVariants: parsed.responsiveVariants,
          visualSimilarity: visualReport
        },
        files
      };
      await appendProjectTaskHistory(ctx.projectRoot, project.id, {
        toolName: "convert_design_to_static_project",
        ok,
        summary: ok ? `Converted design reference into static project ${project.id}.` : `Design conversion created ${project.id} with validation issues.`,
        details: report
      });
      return {
        ok,
        summary: ok ? `Converted design reference into static project ${project.id}.` : `Design conversion created ${project.id} but validation found issues.`,
        jobId: project.id,
        previewUrl: publishedUrl,
        shareUrl: publishedUrl,
        artifacts: [...(publishedUrl ? [publishedUrl] : []), ...(inspectionReportUrl ? [inspectionReportUrl] : []), ...files.map((file) => file.path)],
        structuredContent: report as unknown as Record<string, unknown>,
        logs: [JSON.stringify(report, null, 2)],
        errors: [...validation.errors, ...((browserInspection?.blockingErrors as string[] | undefined) ?? [])]
      };
    }
  },
  {
    definition: {
      name: "capture_webpage",
      description: "Preview and capture an authorized HTTPS webpage with Playwright, including DOM summary, screenshots, resources, forms, interactions, and network/runtime signals.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Authorized public https:// URL to capture." },
          mode: { type: "string", enum: ["single_page", "same_origin_depth_1"] },
          viewports: { type: "array", items: { type: "string", enum: ["desktop", "tablet", "mobile"] } },
          maxPages: { type: "number", minimum: 1, maximum: 5 },
          timeoutMs: { type: "number", minimum: 1000, maximum: 120000 },
          respectRobotsTxt: { type: "boolean" },
          includeScreenshots: { type: "boolean" },
          includeNetwork: { type: "boolean" }
        },
        required: ["url"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: captureWebpageSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof captureWebpageSchema>;
      const capture = await captureWebpage(parsed);
      const captureRoot = getCaptureRoot(ctx.workspaceRoot);
      await saveWebpageCapture(captureRoot, capture);
      const share = await createShareArtifact({
        shareRoot: ctx.shareRoot,
        title: "Webpage Capture Report",
        summary: `Captured ${capture.sourceUrl}.`,
        filename: `webpage-capture-${capture.captureId}.html`,
        html: renderCaptureReport(capture)
      });
      const reportUrl = makeShareUrl(ctx.publicBaseUrl, share.id, share.filename);
      const structuredContent = {
        captureId: capture.captureId,
        sourceUrl: capture.sourceUrl,
        finalUrl: capture.finalUrl,
        reportUrl,
        pages: capture.pages.map(({ screenshotDataUrl, visibleText, ...page }) => ({ ...page, visibleTextSample: visibleText.slice(0, 1200) })),
        resources: capture.resources,
        forms: capture.forms,
        interactions: capture.interactions,
        issues: capture.issues,
        warnings: capture.warnings
      };
      return {
        ok: true,
        summary: `Captured ${capture.sourceUrl} into capture ${capture.captureId}.`,
        jobId: capture.captureId,
        previewUrl: reportUrl,
        shareUrl: reportUrl,
        artifacts: [reportUrl, `.captures/${capture.captureId}.json`],
        structuredContent,
        logs: [JSON.stringify(structuredContent, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "analyze_webpage_capture",
      description: "Analyze a stored webpage capture for UX, accessibility, performance, SEO, and implementation risks.",
      inputSchema: {
        type: "object",
        properties: {
          captureId: { type: "string" },
          focus: { type: "array", items: { type: "string", enum: [...focusValues] } }
        },
        required: ["captureId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: analyzeWebpageCaptureSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof analyzeWebpageCaptureSchema>;
      const captureRoot = getCaptureRoot(ctx.workspaceRoot);
      const capture = await readWebpageCapture(captureRoot, parsed.captureId);
      const analysis = analyzeCapture(capture, parsed.focus);
      await saveAnalysis(captureRoot, analysis);
      const share = await createShareArtifact({
        shareRoot: ctx.shareRoot,
        title: "Webpage Analysis Report",
        summary: `Analyzed capture ${capture.captureId}.`,
        filename: `webpage-analysis-${analysis.analysisId}.html`,
        html: renderAnalysisReport(capture, analysis)
      });
      const reportUrl = makeShareUrl(ctx.publicBaseUrl, share.id, share.filename);
      return {
        ok: true,
        summary: `Analyzed capture ${capture.captureId} into analysis ${analysis.analysisId}.`,
        jobId: analysis.analysisId,
        previewUrl: reportUrl,
        shareUrl: reportUrl,
        artifacts: [reportUrl, `.captures/${analysis.analysisId}.analysis.json`],
        structuredContent: { ...analysis, reportUrl } as unknown as Record<string, unknown>,
        logs: [JSON.stringify({ ...analysis, reportUrl }, null, 2)],
        errors: analysis.findings.filter((finding) => finding.severity === "error").map((finding) => finding.message)
      };
    }
  },
  {
    definition: {
      name: "generate_improved_static_page",
      description: "Generate a static, source-informed improved page from a webpage capture and analysis, then validate, publish, and optionally browser-inspect it.",
      inputSchema: {
        type: "object",
        properties: {
          captureId: { type: "string" },
          analysisId: { type: "string" },
          title: { type: "string" },
          preserveContent: { type: "boolean" },
          styleDirection: { type: "string" },
          browserValidation: { type: "boolean" }
        },
        required: ["captureId", "analysisId", "title"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: generateImprovedStaticPageSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof generateImprovedStaticPageSchema>;
      const captureRoot = getCaptureRoot(ctx.workspaceRoot);
      const capture = await readWebpageCapture(captureRoot, parsed.captureId);
      const analysis = await readAnalysis(captureRoot, parsed.analysisId);
      if (analysis.captureId !== capture.captureId) {
        throw new Error(`Analysis ${analysis.analysisId} does not belong to capture ${capture.captureId}.`);
      }

      const project = await createProject(ctx.projectRoot, {
        title: parsed.title,
        summary: `Improved static rebuild generated from ${capture.sourceUrl}.`,
        entryFile: "index.html",
        createdByClientId: ctx.clientId
      });
      const files = [
        await writeProjectFile(ctx.projectRoot, project.id, "index.html", generateIndexHtml(capture, analysis, parsed.title, parsed.preserveContent, parsed.styleDirection)),
        await writeProjectFile(ctx.projectRoot, project.id, "styles.css", generateStylesCss()),
        await writeProjectFile(ctx.projectRoot, project.id, "script.js", generateScriptJs())
      ];
      const validation = await validateProject(ctx.projectRoot, project.id, "index.html", "static_html");
      if (!validation.ok) {
        const report = { ok: false, projectId: project.id, validation, files };
        await appendProjectTaskHistory(ctx.projectRoot, project.id, {
          toolName: "generate_improved_static_page",
          ok: false,
          summary: `Static validation blocked improved page ${project.id}.`,
          details: report
        });
        return {
          ok: false,
          summary: `Static validation blocked improved page ${project.id}.`,
          jobId: project.id,
          artifacts: files.map((file) => file.path),
          structuredContent: report,
          logs: [JSON.stringify(report, null, 2)],
          errors: validation.errors
        };
      }

      const published = await publishProject(ctx.projectRoot, project.id, ctx.publicBaseUrl, "index.html", { shareBasePath: ctx.publicShareBasePath });
      let inspectionReportUrl: string | undefined;
      let browserInspection: Record<string, unknown> | undefined;
      if (parsed.browserValidation) {
        const browserResults = await inspectWebpageUrl(published.publishedUrl!, {
          viewports: ["desktop", "tablet", "mobile"],
          waitUntil: "networkidle",
          screenshot: true,
          fullPage: false,
          maxIssues: 12
        });
        const inspectionShare = await createShareArtifact({
          shareRoot: ctx.shareRoot,
          title: "Improved Page Browser Inspection",
          summary: `Browser validation for ${project.id}.`,
          filename: `improved-inspection-${project.id}.html`,
          html: renderWebpageInspectionReport(published.publishedUrl!, browserResults)
        });
        inspectionReportUrl = makeShareUrl(ctx.publicBaseUrl, inspectionShare.id, inspectionShare.filename);
        const inspectionSummary = {
          ...summarizeBrowserInspection(withoutScreenshots(browserResults)),
          reportUrl: inspectionReportUrl,
          inspectedAt: new Date().toISOString()
        };
        browserInspection = inspectionSummary as unknown as Record<string, unknown>;
        await recordProjectBrowserInspection(ctx.projectRoot, project.id, inspectionSummary, "generate_improved_static_page_browser_validation");
        if (!inspectionSummary.ok) {
          await unpublishProject(ctx.projectRoot, project.id, `Browser validation blocked improved page ${project.id}.`);
          const report = { ok: false, projectId: project.id, validation: { ...validation, browserInspection: inspectionSummary }, browserInspection: inspectionSummary, inspectionReportUrl, files };
          await appendProjectTaskHistory(ctx.projectRoot, project.id, {
            toolName: "generate_improved_static_page",
            ok: false,
            summary: `Browser validation blocked improved page ${project.id}.`,
            details: report
          });
          return {
            ok: false,
            summary: `Browser validation blocked improved page ${project.id}.`,
            jobId: project.id,
            artifacts: [inspectionReportUrl, ...files.map((file) => file.path)],
            structuredContent: report,
            logs: [JSON.stringify(report, null, 2)],
            errors: inspectionSummary.blockingErrors
          };
        }
      }

      const report = {
        ok: true,
        projectId: project.id,
        publishedUrl: published.publishedUrl,
        sourceUrl: capture.sourceUrl,
        captureId: capture.captureId,
        analysisId: analysis.analysisId,
        validation,
        browserInspection,
        inspectionReportUrl,
        files
      };
      await appendProjectTaskHistory(ctx.projectRoot, project.id, {
        toolName: "generate_improved_static_page",
        ok: true,
        summary: `Generated improved static page ${project.id}.`,
        details: report
      });
      return {
        ok: true,
        summary: `Generated improved static page ${project.id}.`,
        jobId: project.id,
        previewUrl: published.publishedUrl,
        shareUrl: published.publishedUrl,
        artifacts: [published.publishedUrl!, ...(inspectionReportUrl ? [inspectionReportUrl] : []), ...files.map((file) => file.path)],
        structuredContent: report as unknown as Record<string, unknown>,
        logs: [JSON.stringify(report, null, 2)],
        errors: []
      };
    }
  }
];
