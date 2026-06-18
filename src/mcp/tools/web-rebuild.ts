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

function analysisPath(captureRoot: string, analysisId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(analysisId)) throw new Error("Invalid analysisId.");
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
    <nav>${navLinks.map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a>`).join("")}</nav>
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

function withoutScreenshots(results: Awaited<ReturnType<typeof inspectWebpageUrl>>) {
  return results.map(({ screenshotDataUrl, ...result }) => result);
}

export const webRebuildTools: ToolModule[] = [
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
