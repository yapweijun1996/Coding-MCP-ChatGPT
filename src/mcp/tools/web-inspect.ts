import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createShareArtifact } from "../../share/store.js";
import { makeShareUrl } from "../result.js";
import type { ToolModule } from "../types.js";

type ViewportName = "desktop" | "tablet" | "mobile";

const viewportPresets: Record<ViewportName, { width: number; height: number; isMobile: boolean }> = {
  desktop: { width: 1440, height: 900, isMobile: false },
  tablet: { width: 834, height: 1112, isMobile: true },
  mobile: { width: 390, height: 844, isMobile: true }
};

const inspectWebpageSchema = z.object({
  url: z.string().url({ message: "url must be a valid http(s) URL." }),
  viewports: z.array(z.enum(["desktop", "tablet", "mobile"])).min(1).max(3).optional().default(["desktop", "tablet", "mobile"]),
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000),
  waitUntil: z.enum(["domcontentloaded", "load", "networkidle"]).optional().default("networkidle"),
  screenshot: z.boolean().optional().default(true),
  fullPage: z.boolean().optional().default(false),
  maxIssues: z.number().int().min(1).max(50).optional().default(12)
});

type LayoutIssue = {
  type: string;
  severity: "info" | "warning" | "error";
  message: string;
  selector?: string;
  text?: string;
  box?: { x: number; y: number; width: number; height: number };
};

type ViewportResult = {
  viewport: ViewportName;
  width: number;
  height: number;
  finalUrl: string;
  title: string;
  documentWidth: number;
  documentHeight: number;
  hasHorizontalOverflow: boolean;
  consoleErrors: string[];
  pageErrors: string[];
  issues: LayoutIssue[];
  screenshotDataUrl?: string;
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderReport(inputUrl: string, results: ViewportResult[]): string {
  const issueCount = results.reduce((total, result) => total + result.issues.length + result.consoleErrors.length + result.pageErrors.length, 0);
  const sections = results.map((result) => {
    const runtimeIssues = [
      ...result.consoleErrors.map((message) => `<li><strong>Console:</strong> ${escapeHtml(message)}</li>`),
      ...result.pageErrors.map((message) => `<li><strong>Page error:</strong> ${escapeHtml(message)}</li>`),
      ...result.issues.map((issue) => `<li><strong>${escapeHtml(issue.severity)} / ${escapeHtml(issue.type)}:</strong> ${escapeHtml(issue.message)}${issue.selector ? ` <code>${escapeHtml(issue.selector)}</code>` : ""}</li>`)
    ].join("");
    return `<section>
      <h2>${escapeHtml(result.viewport)} ${result.width}x${result.height}</h2>
      <dl>
        <div><dt>Title</dt><dd>${escapeHtml(result.title || "(empty)")}</dd></div>
        <div><dt>Final URL</dt><dd>${escapeHtml(result.finalUrl)}</dd></div>
        <div><dt>Document</dt><dd>${result.documentWidth}x${result.documentHeight}</dd></div>
        <div><dt>Horizontal overflow</dt><dd>${result.hasHorizontalOverflow ? "yes" : "no"}</dd></div>
      </dl>
      ${result.screenshotDataUrl ? `<img src="${result.screenshotDataUrl}" alt="${escapeHtml(result.viewport)} screenshot">` : ""}
      <h3>Findings</h3>
      <ul>${runtimeIssues || "<li>No obvious layout/runtime issues detected.</li>"}</ul>
    </section>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Webpage Inspection Report</title>
  <style>
    :root { color-scheme: light; --ink:#17211b; --muted:#5d675f; --line:#d9dfd8; --paper:#f7f8f4; --panel:#fff; --accent:#12645d; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--paper); color:var(--ink); }
    main { width:min(1120px, calc(100vw - 32px)); margin:32px auto; }
    header { margin-bottom:24px; }
    h1 { margin:0 0 8px; font-size:28px; letter-spacing:0; }
    p { margin:0; color:var(--muted); }
    section { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:18px; margin:16px 0; }
    h2 { margin:0 0 12px; font-size:20px; }
    h3 { margin:16px 0 8px; font-size:15px; }
    dl { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:10px; margin:0 0 14px; }
    dt { color:var(--muted); font-size:12px; }
    dd { margin:3px 0 0; overflow-wrap:anywhere; }
    img { display:block; width:100%; max-width:720px; border:1px solid var(--line); border-radius:6px; background:white; }
    li { margin:7px 0; line-height:1.45; }
    code { background:#eef1ed; border-radius:4px; padding:2px 5px; }
    @media (max-width: 720px) { dl { grid-template-columns:1fr; } main { width:min(100vw - 20px, 1120px); margin:20px auto; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Webpage Inspection Report</h1>
      <p>${escapeHtml(inputUrl)} · ${issueCount} issue(s) or runtime signal(s)</p>
    </header>
    ${sections}
  </main>
</body>
</html>`;
}

export const webInspectTools: ToolModule[] = [
  {
    definition: {
      name: "inspect_webpage",
      description: "Render a URL in Chromium across desktop, tablet, and mobile viewports, then report screenshots, console errors, and responsive layout issues.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL to inspect." },
          viewports: {
            type: "array",
            items: { type: "string", enum: ["desktop", "tablet", "mobile"] },
            description: "Viewport presets to inspect. Defaults to desktop, tablet, and mobile."
          },
          timeoutMs: { type: "number", minimum: 1000, maximum: 120000 },
          waitUntil: { type: "string", enum: ["domcontentloaded", "load", "networkidle"] },
          screenshot: { type: "boolean", description: "Embed screenshots in the generated report." },
          fullPage: { type: "boolean", description: "Capture full page screenshots instead of the first viewport." },
          maxIssues: { type: "number", minimum: 1, maximum: 50 }
        },
        required: ["url"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: inspectWebpageSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof inspectWebpageSchema>;
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      const results: ViewportResult[] = [];

      try {
        for (const viewportName of parsed.viewports) {
          const preset = viewportPresets[viewportName];
          const context = await browser.newContext({
            viewport: { width: preset.width, height: preset.height },
            isMobile: preset.isMobile,
            deviceScaleFactor: viewportName === "desktop" ? 1 : 2
          });
          const page = await context.newPage();
          const consoleErrors: string[] = [];
          const pageErrors: string[] = [];
          page.on("console", (message) => {
            if (message.type() === "error") consoleErrors.push(message.text());
          });
          page.on("pageerror", (error) => pageErrors.push(error.message));

          await page.goto(parsed.url, { waitUntil: parsed.waitUntil, timeout: parsed.timeoutMs });
          const metrics = await page.evaluate((maxIssues) => {
            const selectorFor = (element: Element): string => {
              const id = element.id ? `#${CSS.escape(element.id)}` : "";
              if (id) return `${element.tagName.toLowerCase()}${id}`;
              const className = typeof element.className === "string" && element.className.trim()
                ? `.${element.className.trim().split(/\s+/).slice(0, 3).map((item) => CSS.escape(item)).join(".")}`
                : "";
              return `${element.tagName.toLowerCase()}${className}`;
            };
            const visibleElements = Array.from(document.body.querySelectorAll("*")).filter((element) => {
              const box = element.getBoundingClientRect();
              const style = window.getComputedStyle(element);
              return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
            });
            const viewportWidth = window.innerWidth;
            const overflowElements = visibleElements
              .map((element) => {
                const box = element.getBoundingClientRect();
                return { element, box };
              })
              .filter(({ box }) => box.right > viewportWidth + 1 || box.left < -1)
              .slice(0, maxIssues)
              .map(({ element, box }) => ({
                type: "horizontal-overflow",
                severity: "error" as const,
                message: "Element extends outside the viewport horizontally.",
                selector: selectorFor(element),
                text: (element.textContent ?? "").trim().slice(0, 120),
                box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
              }));
            const tapTargets = visibleElements
              .filter((element) => /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(element.tagName) || element.getAttribute("role") === "button")
              .map((element) => ({ element, box: element.getBoundingClientRect() }))
              .filter(({ box }) => box.width > 0 && box.height > 0 && (box.width < 44 || box.height < 44))
              .slice(0, maxIssues)
              .map(({ element, box }) => ({
                type: "small-tap-target",
                severity: "warning" as const,
                message: "Interactive element is smaller than 44x44 CSS pixels.",
                selector: selectorFor(element),
                text: (element.textContent ?? "").trim().slice(0, 120),
                box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
              }));
            return {
              title: document.title,
              documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
              documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
              hasHorizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > viewportWidth + 1,
              issues: [...overflowElements, ...tapTargets].slice(0, maxIssues)
            };
          }, parsed.maxIssues);

          let screenshotDataUrl: string | undefined;
          if (parsed.screenshot) {
            const screenshot = await page.screenshot({ type: "jpeg", quality: 55, fullPage: parsed.fullPage });
            screenshotDataUrl = `data:image/jpeg;base64,${screenshot.toString("base64")}`;
          }

          results.push({
            viewport: viewportName,
            width: preset.width,
            height: preset.height,
            finalUrl: page.url(),
            title: metrics.title,
            documentWidth: metrics.documentWidth,
            documentHeight: metrics.documentHeight,
            hasHorizontalOverflow: metrics.hasHorizontalOverflow,
            consoleErrors: consoleErrors.slice(0, parsed.maxIssues),
            pageErrors: pageErrors.slice(0, parsed.maxIssues),
            issues: metrics.issues,
            screenshotDataUrl
          });
          await context.close();
        }
      } finally {
        await browser.close();
      }

      const report = renderReport(parsed.url, results);
      const share = await createShareArtifact({
        shareRoot: ctx.shareRoot,
        title: "Webpage Inspection Report",
        summary: `Inspected ${parsed.url} across ${results.length} viewport(s).`,
        filename: `web-inspect-${randomUUID()}.html`,
        html: report
      });
      const shareUrl = makeShareUrl(ctx.publicBaseUrl, share.id, share.filename);
      const summary = results.some((result) => result.hasHorizontalOverflow || result.consoleErrors.length || result.pageErrors.length || result.issues.length)
        ? `Inspected ${parsed.url}; issues or runtime signals were found.`
        : `Inspected ${parsed.url}; no obvious responsive layout issues found.`;
      const resultForLogs = results.map(({ screenshotDataUrl, ...result }) => result);

      return {
        ok: true,
        summary,
        shareUrl,
        previewUrl: shareUrl,
        artifacts: [shareUrl],
        logs: [JSON.stringify({ reportUrl: shareUrl, results: resultForLogs }, null, 2)],
        errors: []
      };
    }
  }
];
