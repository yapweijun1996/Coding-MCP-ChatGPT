import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createArtifact, makeArtifactUrl } from "../../artifacts/store.js";
import { createShareArtifact } from "../../share/store.js";
import { makeShareUrl } from "../result.js";
import type { ToolContext, ToolModule, ToolResult } from "../types.js";
import { childEnv } from "../child-env.js";
import { assertSafePublicUrl } from "../../security/url.js";
import { installSsrfRouteGuard } from "../../security/playwright-guard.js";
import type { Page, Request, Response } from "playwright";

const INSPECTION_PROTOCOLS = ["http:", "https:"];

// SSRF guard for the public web-inspect tools. The headless browser/Lighthouse would
// otherwise fetch any URL the caller supplies — including cloud metadata
// (169.254.169.254) and internal services — and return the response to the client.
// `inspect_local_project` is the one legitimate private-network consumer and passes
// allowPrivateNetwork=true.
async function guardInspectionUrl(url: string, allowPrivateNetwork: boolean): Promise<void> {
  if (allowPrivateNetwork) return;
  await assertSafePublicUrl(url, { protocols: INSPECTION_PROTOCOLS });
}

export type ViewportName = "desktop" | "tablet" | "mobile";
export type BrowserName = "chromium" | "firefox" | "webkit";

const viewportPresets: Record<ViewportName, { width: number; height: number; isMobile: boolean }> = {
  desktop: { width: 1440, height: 900, isMobile: false },
  tablet: { width: 834, height: 1112, isMobile: true },
  mobile: { width: 390, height: 844, isMobile: true }
};

const viewportSchema = z.array(z.enum(["desktop", "tablet", "mobile"])).min(1).max(3);
const waitUntilSchema = z.enum(["domcontentloaded", "load", "networkidle"]);

const inspectWebpageSchema = z.object({
  url: z.string().url({ message: "url must be a valid http(s) URL." }),
  viewports: viewportSchema.optional().default(["desktop", "tablet", "mobile"]),
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000),
  waitUntil: waitUntilSchema.optional().default("networkidle"),
  screenshot: z.boolean().optional().default(true),
  fullPage: z.boolean().optional().default(false),
  maxIssues: z.number().int().min(1).max(50).optional().default(12)
});

const inspectWebpagePlusSchema = inspectWebpageSchema.extend({
  captureNetwork: z.boolean().optional().default(true),
  captureTrace: z.boolean().optional().default(false),
  slowRequestMs: z.number().int().min(100).max(60000).optional().default(2500)
});

const browserSchema = z.array(z.enum(["chromium", "firefox", "webkit"])).min(1).max(3);

const inspectWebpageMultiBrowserSchema = inspectWebpagePlusSchema.extend({
  browsers: browserSchema.optional().default(["chromium", "firefox", "webkit"]),
  continueOnBrowserError: z.boolean().optional().default(true)
});

const networkScenarioSchema = z.enum(["offline", "slow3g", "slow4g", "flaky", "timeout"]);
const inspectNetworkConditionsSchema = z.object({
  url: z.string().url(),
  scenarios: z.array(networkScenarioSchema).min(1).max(5).optional().default(["offline", "slow3g"]),
  viewport: z.enum(["desktop", "tablet", "mobile"]).optional().default("mobile"),
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000),
  settleMs: z.number().int().min(250).max(15000).optional().default(2000),
  screenshot: z.boolean().optional().default(true),
  maxRequests: z.number().int().min(1).max(120).optional().default(40)
});

const auditAccessibilitySchema = z.object({
  url: z.string().url(),
  viewports: viewportSchema.optional().default(["desktop", "mobile"]),
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000),
  includedRules: z.array(z.string().min(1).max(120)).max(50).optional().default([]),
  excludedRules: z.array(z.string().min(1).max(120)).max(50).optional().default([]),
  maxViolations: z.number().int().min(1).max(100).optional().default(25)
});

const lighthouseCategorySchema = z.enum(["performance", "accessibility", "best-practices", "seo", "pwa"]);
const auditLighthouseSchema = z.object({
  url: z.string().url(),
  categories: z.array(lighthouseCategorySchema).min(1).max(5).optional().default(["performance", "accessibility", "best-practices", "seo"]),
  formFactor: z.enum(["desktop", "mobile"]).optional().default("desktop"),
  timeoutMs: z.number().int().min(5000).max(180000).optional().default(60000)
});

const flowStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), selector: z.string().min(1).max(500), timeoutMs: z.number().int().min(500).max(60000).optional() }),
  z.object({ action: z.literal("fill"), selector: z.string().min(1).max(500), value: z.string().max(5000), timeoutMs: z.number().int().min(500).max(60000).optional() }),
  z.object({ action: z.literal("press"), selector: z.string().min(1).max(500), key: z.string().min(1).max(80), timeoutMs: z.number().int().min(500).max(60000).optional() }),
  z.object({ action: z.literal("select"), selector: z.string().min(1).max(500), value: z.string().min(1).max(500), timeoutMs: z.number().int().min(500).max(60000).optional() }),
  z.object({ action: z.literal("waitForSelector"), selector: z.string().min(1).max(500), timeoutMs: z.number().int().min(500).max(60000).optional() }),
  z.object({ action: z.literal("waitForUrl"), url: z.string().min(1).max(1000), timeoutMs: z.number().int().min(500).max(60000).optional() }),
  z.object({ action: z.literal("assertText"), text: z.string().min(1).max(1000), timeoutMs: z.number().int().min(500).max(60000).optional() }),
  z.object({ action: z.literal("screenshot"), name: z.string().min(1).max(80).optional() })
]);

const inspectInteractionFlowSchema = z.object({
  url: z.string().url(),
  viewport: z.enum(["desktop", "tablet", "mobile"]).optional().default("desktop"),
  steps: z.array(flowStepSchema).min(1).max(30),
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000),
  screenshotEachStep: z.boolean().optional().default(false)
});

const analyzeWebpageVisualSchema = z.object({
  url: z.string().url(),
  viewports: viewportSchema.optional().default(["desktop", "mobile"]),
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000),
  fullPage: z.boolean().optional().default(false),
  maxFindings: z.number().int().min(1).max(80).optional().default(30)
});

const inspectDomAtPointSchema = z.object({
  url: z.string().url(),
  viewport: z.enum(["desktop", "tablet", "mobile"]).optional().default("desktop"),
  x: z.number().int().min(0).max(10000),
  y: z.number().int().min(0).max(10000),
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000),
  includeScreenshot: z.boolean().optional().default(true)
});

const threeDViewPresetSchema = z.enum(["front", "back", "left", "right", "top", "isometric", "mobile_portrait", "mobile_landscape"]);
const inspect3dSceneVisualsSchema = z.object({
  url: z.string().url(),
  canvasSelector: z.string().min(1).max(240).optional().default("canvas"),
  expectedStyle: z.string().max(240).optional(),
  expectedFacing: z.enum(["front", "back", "left", "right", "any"]).optional().default("any"),
  expectedCameraDistance: z.number().min(0).max(100000).optional(),
  viewPresets: z.array(threeDViewPresetSchema).min(1).max(8).optional().default(["front", "back", "left", "right", "isometric", "mobile_portrait"]),
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000),
  settleMs: z.number().int().min(100).max(10000).optional().default(750),
  maxFindings: z.number().int().min(1).max(80).optional().default(40)
});

const inspectLocalProjectSchema = z.object({
  script: z.enum(["dev", "start"]).optional().default("dev"),
  port: z.number().int().min(1024).max(65535).optional().default(3000),
  host: z.string().min(1).max(128).optional().default("127.0.0.1"),
  path: z.string().min(1).max(240).optional().default("/"),
  viewports: viewportSchema.optional().default(["desktop", "tablet", "mobile"]),
  includeAccessibility: z.boolean().optional().default(true),
  includeLighthouse: z.boolean().optional().default(false),
  closeAfterCheck: z.boolean().optional().default(true),
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000)
});

export type LayoutIssue = {
  type: string;
  severity: "info" | "warning" | "error";
  message: string;
  selector?: string;
  text?: string;
  box?: { x: number; y: number; width: number; height: number };
};

export type NetworkSummary = {
  failedRequests: Array<{ url: string; method: string; failure: string }>;
  slowRequests: Array<{ url: string; method: string; durationMs: number; status?: number }>;
  statusGroups: Record<string, number>;
  assetFailures: Array<{ url: string; resourceType: string; status?: number; failure?: string }>;
};

export type ViewportResult = {
  browser?: BrowserName;
  viewport: ViewportName;
  width: number;
  height: number;
  finalUrl: string;
  title: string;
  documentWidth: number;
  documentHeight: number;
  hasHorizontalOverflow: boolean;
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
  issues: LayoutIssue[];
  network?: NetworkSummary;
  screenshotUrl?: string;
  screenshotDataUrl?: string;
  traceUrl?: string;
};

export type BrowserInspectionSummary = {
  ok: boolean;
  blockingErrors: string[];
  warnings: string[];
  results: Array<Omit<ViewportResult, "screenshotDataUrl">>;
  reportUrl?: string;
  inspectedAt: string;
};

export type BrowserInspectionOptions = z.infer<typeof inspectWebpageSchema>;
type InspectWebpagePlusOptions = z.infer<typeof inspectWebpagePlusSchema>;
type InspectWebpageMultiBrowserOptions = z.infer<typeof inspectWebpageMultiBrowserSchema>;
type NetworkScenarioName = z.infer<typeof networkScenarioSchema>;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function jsonForLog(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function artifactRoot(ctx: ToolContext): string {
  return ctx.artifactRoot;
}

async function saveArtifactUrl(ctx: ToolContext, filename: string, contentType: string, content: Buffer | string): Promise<string> {
  const artifact = await createArtifact({ artifactRoot: artifactRoot(ctx), filename, contentType, content });
  return makeArtifactUrl(ctx.publicBaseUrl, artifact.id, artifact.filename);
}

function resultWithoutImages(result: ViewportResult): Omit<ViewportResult, "screenshotDataUrl"> {
  const { screenshotDataUrl, ...rest } = result;
  return rest;
}

export function summarizeBrowserInspection(results: Array<Omit<ViewportResult, "screenshotDataUrl">>): Omit<BrowserInspectionSummary, "reportUrl" | "inspectedAt"> {
  const blockingErrors: string[] = [];
  const warnings: string[] = [];
  for (const result of results) {
    const label = result.browser ? `${result.browser}/${result.viewport}` : result.viewport;
    for (const error of result.consoleErrors) blockingErrors.push(`${label} console error: ${error}`);
    for (const error of result.pageErrors) blockingErrors.push(`${label} page error: ${error}`);
    if (result.network) {
      for (const request of result.network.failedRequests) blockingErrors.push(`${label} failed request: ${request.method} ${request.url} (${request.failure})`);
      for (const asset of result.network.assetFailures) blockingErrors.push(`${label} asset failure: ${asset.resourceType} ${asset.url}`);
    }
    if (result.hasHorizontalOverflow) blockingErrors.push(`${label} has horizontal overflow.`);
    if (!result.title.trim()) warnings.push(`${label} page title is empty.`);
    for (const warning of result.consoleWarnings) warnings.push(`${label} console warning: ${warning}`);
    for (const issue of result.issues) {
      const message = `${label} ${issue.type}: ${issue.message}${issue.selector ? ` (${issue.selector})` : ""}`;
      if (issue.severity === "error") blockingErrors.push(message);
      else warnings.push(message);
    }
  }
  return { ok: blockingErrors.length === 0, blockingErrors, warnings, results };
}

function renderInspectionReport(title: string, inputUrl: string, sections: string[], summaryLines: string[] = []): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root{color-scheme:light;--ink:#17211b;--muted:#5d675f;--line:#d9dfd8;--paper:#f7f8f4;--panel:#fff;--accent:#12645d}
    body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--paper);color:var(--ink)}
    main{width:min(1160px,calc(100vw - 32px));margin:32px auto}
    header{margin-bottom:24px}h1{margin:0 0 8px;font-size:28px;letter-spacing:0}p{margin:0;color:var(--muted)}
    section{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:18px;margin:16px 0}
    h2{margin:0 0 12px;font-size:20px}h3{margin:16px 0 8px;font-size:15px}
    dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0 0 14px}dt{color:var(--muted);font-size:12px}dd{margin:3px 0 0;overflow-wrap:anywhere}
    img{display:block;width:100%;max-width:760px;border:1px solid var(--line);border-radius:6px;background:white}
    li{margin:7px 0;line-height:1.45;overflow-wrap:anywhere}code{background:#eef1ed;border-radius:4px;padding:2px 5px}
    .score{display:inline-block;min-width:42px;text-align:center;border-radius:999px;padding:4px 8px;background:#eef1ed}
    @media (max-width:720px){dl{grid-template-columns:1fr}main{width:min(100vw - 20px,1120px);margin:20px auto}}
  </style>
</head>
<body><main><header><h1>${escapeHtml(title)}</h1><p>${escapeHtml(inputUrl)}</p>${summaryLines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</header>${sections.join("")}</main></body></html>`;
}

export function renderWebpageInspectionReport(inputUrl: string, results: ViewportResult[]): string {
  const issueCount = results.reduce((total, result) => total + result.issues.length + result.consoleErrors.length + result.consoleWarnings.length + result.pageErrors.length + (result.network?.failedRequests.length ?? 0) + (result.network?.assetFailures.length ?? 0), 0);
  const sections = results.map((result) => {
    const label = result.browser ? `${result.browser} / ${result.viewport}` : result.viewport;
    const runtimeIssues = [
      ...result.consoleErrors.map((message) => `<li><strong>Console error:</strong> ${escapeHtml(message)}</li>`),
      ...result.consoleWarnings.map((message) => `<li><strong>Console warning:</strong> ${escapeHtml(message)}</li>`),
      ...result.pageErrors.map((message) => `<li><strong>Page error:</strong> ${escapeHtml(message)}</li>`),
      ...(result.network?.failedRequests ?? []).map((request) => `<li><strong>Failed request:</strong> ${escapeHtml(request.method)} ${escapeHtml(request.url)} (${escapeHtml(request.failure)})</li>`),
      ...(result.network?.assetFailures ?? []).map((asset) => `<li><strong>Asset failure:</strong> ${escapeHtml(asset.resourceType)} ${escapeHtml(asset.url)} ${asset.status ? `(${asset.status})` : ""}</li>`),
      ...result.issues.map((issue) => `<li><strong>${escapeHtml(issue.severity)} / ${escapeHtml(issue.type)}:</strong> ${escapeHtml(issue.message)}${issue.selector ? ` <code>${escapeHtml(issue.selector)}</code>` : ""}</li>`)
    ].join("");
    return `<section><h2>${escapeHtml(label)} ${result.width}x${result.height}</h2>
      <dl><div><dt>Title</dt><dd>${escapeHtml(result.title || "(empty)")}</dd></div><div><dt>Final URL</dt><dd>${escapeHtml(result.finalUrl)}</dd></div><div><dt>Document</dt><dd>${result.documentWidth}x${result.documentHeight}</dd></div><div><dt>Horizontal overflow</dt><dd>${result.hasHorizontalOverflow ? "yes" : "no"}</dd></div></dl>
      ${result.screenshotUrl ? `<img src="${result.screenshotUrl}" alt="${escapeHtml(result.viewport)} screenshot">` : result.screenshotDataUrl ? `<img src="${result.screenshotDataUrl}" alt="${escapeHtml(result.viewport)} screenshot">` : ""}
      ${result.traceUrl ? `<p><a href="${result.traceUrl}">Download Playwright trace</a></p>` : ""}
      <h3>Findings</h3><ul>${runtimeIssues || "<li>No obvious layout/runtime issues detected.</li>"}</ul></section>`;
  });
  return renderInspectionReport("Webpage Inspection Report", inputUrl, sections, [`${issueCount} issue(s) or runtime signal(s)`]);
}

async function evaluateLayout(page: Page, maxIssues: number): Promise<{ title: string; documentWidth: number; documentHeight: number; hasHorizontalOverflow: boolean; issues: LayoutIssue[] }> {
  return page.evaluate((limit) => {
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
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.right > viewportWidth + 1 || box.left < -1)
      .slice(0, limit)
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
      .slice(0, limit)
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
      issues: [...overflowElements, ...tapTargets].slice(0, limit)
    };
  }, maxIssues);
}

function setupNetworkCapture(page: Page, slowRequestMs: number, maxIssues: number): NetworkSummary {
  const started = new Map<Request, number>();
  const summary: NetworkSummary = { failedRequests: [], slowRequests: [], statusGroups: {}, assetFailures: [] };
  page.on("request", (request) => started.set(request, Date.now()));
  page.on("requestfailed", (request) => {
    started.delete(request);
    if (summary.failedRequests.length < maxIssues) summary.failedRequests.push({ url: request.url(), method: request.method(), failure: request.failure()?.errorText ?? "request failed" });
    const type = request.resourceType();
    if (["image", "stylesheet", "script", "font"].includes(type) && summary.assetFailures.length < maxIssues) summary.assetFailures.push({ url: request.url(), resourceType: type, failure: request.failure()?.errorText });
  });
  page.on("response", (response: Response) => {
    const status = response.status();
    const group = `${Math.floor(status / 100)}xx`;
    summary.statusGroups[group] = (summary.statusGroups[group] ?? 0) + 1;
    const request = response.request();
    const durationMs = Date.now() - (started.get(request) ?? Date.now());
    started.delete(request);
    if (durationMs >= slowRequestMs && summary.slowRequests.length < maxIssues) summary.slowRequests.push({ url: response.url(), method: request.method(), durationMs, status });
    const type = request.resourceType();
    if (status >= 400 && ["image", "stylesheet", "script", "font"].includes(type) && summary.assetFailures.length < maxIssues) {
      summary.assetFailures.push({ url: response.url(), resourceType: type, status });
    }
  });
  return summary;
}

async function inspectWithPlaywright(url: string, options: InspectWebpagePlusOptions, ctx?: ToolContext, allowPrivateNetwork = false, browserName: BrowserName = "chromium"): Promise<ViewportResult[]> {
  const playwright = await import("playwright");
  const browserType = {
    chromium: playwright.chromium,
    firefox: playwright.firefox,
    webkit: playwright.webkit
  }[browserName];
  const browser = await browserType.launch({ headless: true });
  const results: ViewportResult[] = [];
  const runId = randomUUID();
  const traceDir = path.join(os.tmpdir(), `coding-mcp-trace-${runId}`);
  if (options.captureTrace) await mkdir(traceDir, { recursive: true });

  try {
    for (const viewportName of options.viewports) {
      const preset = viewportPresets[viewportName];
      const context = await browser.newContext({ viewport: { width: preset.width, height: preset.height }, isMobile: preset.isMobile, deviceScaleFactor: viewportName === "desktop" ? 1 : 2 });
      if (options.captureTrace) await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      const page = await context.newPage();
      await installSsrfRouteGuard(page, allowPrivateNetwork);
      const consoleErrors: string[] = [];
      const consoleWarnings: string[] = [];
      const pageErrors: string[] = [];
      const network = options.captureNetwork ? setupNetworkCapture(page, options.slowRequestMs, options.maxIssues) : undefined;
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
        if (message.type() === "warning") consoleWarnings.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.goto(url, { waitUntil: options.waitUntil, timeout: options.timeoutMs });
      const metrics = await evaluateLayout(page, options.maxIssues);
      let screenshotUrl: string | undefined;
      let screenshotDataUrl: string | undefined;
      if (options.screenshot) {
        const screenshot = await page.screenshot({ type: "jpeg", quality: 62, fullPage: options.fullPage });
        if (ctx) screenshotUrl = await saveArtifactUrl(ctx, `${browserName}-${viewportName}-screenshot-${runId}.jpg`, "image/jpeg", screenshot);
        else screenshotDataUrl = `data:image/jpeg;base64,${screenshot.toString("base64")}`;
      }
      let traceUrl: string | undefined;
      if (options.captureTrace) {
        const tracePath = path.join(traceDir, `${browserName}-${viewportName}-trace.zip`);
        await context.tracing.stop({ path: tracePath });
        if (ctx) traceUrl = await saveArtifactUrl(ctx, `${browserName}-${viewportName}-trace-${runId}.zip`, "application/zip", await readFile(tracePath));
      }
      results.push({
        browser: browserName,
        viewport: viewportName,
        width: preset.width,
        height: preset.height,
        finalUrl: page.url(),
        title: metrics.title,
        documentWidth: metrics.documentWidth,
        documentHeight: metrics.documentHeight,
        hasHorizontalOverflow: metrics.hasHorizontalOverflow,
        consoleErrors: consoleErrors.slice(0, options.maxIssues),
        consoleWarnings: consoleWarnings.slice(0, options.maxIssues),
        pageErrors: pageErrors.slice(0, options.maxIssues),
        issues: metrics.issues,
        network,
        screenshotUrl,
        screenshotDataUrl,
        traceUrl
      });
      await context.close();
    }
  } finally {
    await browser.close();
    if (options.captureTrace) await rm(traceDir, { recursive: true, force: true });
  }
  return results;
}

export async function inspectWebpageUrl(url: string, options: Partial<BrowserInspectionOptions> = {}): Promise<ViewportResult[]> {
  const parsed = inspectWebpageSchema.parse({ url, ...options });
  return inspectWithPlaywright(parsed.url, { ...parsed, captureNetwork: false, captureTrace: false, slowRequestMs: 2500 }, undefined);
}

async function createHtmlReport(ctx: ToolContext, title: string, summary: string, filenamePrefix: string, html: string): Promise<string> {
  const share = await createShareArtifact({ shareRoot: ctx.shareRoot, title, summary, filename: `${filenamePrefix}-${randomUUID()}.html`, html });
  return makeShareUrl(ctx.publicBaseUrl, share.id, share.filename);
}

function toolResult(summary: string, reportUrl: string, structured: Record<string, unknown>): ToolResult {
  return { ok: true, summary, shareUrl: reportUrl, previewUrl: reportUrl, artifacts: [reportUrl], structuredContent: structured, logs: [jsonForLog(structured)], errors: [] };
}

async function handleInspectWebpage(input: unknown, ctx: ToolContext, plus: boolean, allowPrivateNetwork = false): Promise<ToolResult> {
  const parsed = (plus ? inspectWebpagePlusSchema : inspectWebpageSchema).parse(input);
  await guardInspectionUrl(parsed.url, allowPrivateNetwork);
  const options = plus ? parsed as InspectWebpagePlusOptions : { ...parsed, captureNetwork: false, captureTrace: false, slowRequestMs: 2500 };
  const results = await inspectWithPlaywright(parsed.url, options, plus ? ctx : undefined, allowPrivateNetwork);
  const reportUrl = await createHtmlReport(ctx, plus ? "Webpage Debug Report" : "Webpage Inspection Report", `Inspected ${parsed.url}`, plus ? "web-debug" : "web-inspect", renderWebpageInspectionReport(parsed.url, results));
  const resultForLogs = results.map(resultWithoutImages);
  const inspection = { ...summarizeBrowserInspection(resultForLogs), reportUrl, inspectedAt: new Date().toISOString() };
  return toolResult(inspection.ok ? `Inspected ${parsed.url}; no blocking responsive/runtime issues found.` : `Inspected ${parsed.url}; blocking responsive/runtime issues were found.`, reportUrl, inspection);
}

async function handleInspectWebpageMultiBrowser(input: unknown, ctx: ToolContext, allowPrivateNetwork = false): Promise<ToolResult> {
  const parsed = inspectWebpageMultiBrowserSchema.parse(input);
  await guardInspectionUrl(parsed.url, allowPrivateNetwork);
  const results: ViewportResult[] = [];
  const browserFailures: Array<{ browser: BrowserName; error: string }> = [];
  const options: InspectWebpagePlusOptions = {
    url: parsed.url,
    viewports: parsed.viewports,
    timeoutMs: parsed.timeoutMs,
    waitUntil: parsed.waitUntil,
    screenshot: parsed.screenshot,
    fullPage: parsed.fullPage,
    maxIssues: parsed.maxIssues,
    captureNetwork: parsed.captureNetwork,
    captureTrace: parsed.captureTrace,
    slowRequestMs: parsed.slowRequestMs
  };

  for (const browserName of [...new Set(parsed.browsers)] as BrowserName[]) {
    try {
      results.push(...await inspectWithPlaywright(parsed.url, options, ctx, allowPrivateNetwork, browserName));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Browser inspection failed.";
      browserFailures.push({ browser: browserName, error: message });
      if (!parsed.continueOnBrowserError) throw error;
    }
  }

  const resultForLogs = results.map(resultWithoutImages);
  const inspection = {
    ...summarizeBrowserInspection(resultForLogs),
    browserFailures,
    comparedBrowsers: [...new Set(results.map((result) => result.browser).filter(Boolean))],
    requestedBrowsers: parsed.browsers,
    reportUrl: "",
    inspectedAt: new Date().toISOString()
  };
  const reportUrl = await createHtmlReport(ctx, "Multi-Browser Inspection Report", `Inspected ${parsed.url}`, "multi-browser-inspect", renderWebpageInspectionReport(parsed.url, results));
  inspection.reportUrl = reportUrl;
  const ok = inspection.ok && browserFailures.length === 0;
  return {
    ok,
    summary: ok
      ? `Multi-browser inspection passed for ${parsed.url}.`
      : `Multi-browser inspection found ${inspection.blockingErrors.length} blocking issue(s) and ${browserFailures.length} browser failure(s).`,
    shareUrl: reportUrl,
    previewUrl: reportUrl,
    artifacts: [reportUrl, ...results.map((result) => result.screenshotUrl).filter((value): value is string => Boolean(value))],
    structuredContent: inspection as unknown as Record<string, unknown>,
    logs: [jsonForLog(inspection)],
    errors: [...inspection.blockingErrors, ...browserFailures.map((failure) => `${failure.browser}: ${failure.error}`)]
  };
}

function scenarioDelayMs(scenario: NetworkScenarioName): number {
  if (scenario === "slow3g") return 1800;
  if (scenario === "slow4g") return 450;
  if (scenario === "flaky") return 750;
  return 0;
}

async function handleNetworkConditions(input: unknown, ctx: ToolContext, allowPrivateNetwork = false): Promise<ToolResult> {
  const parsed = inspectNetworkConditionsSchema.parse(input);
  await guardInspectionUrl(parsed.url, allowPrivateNetwork);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const preset = viewportPresets[parsed.viewport];
  const scenarioResults: Array<Record<string, unknown>> = [];
  const screenshots: string[] = [];

  try {
    for (const scenario of parsed.scenarios) {
      const context = await browser.newContext({ viewport: { width: preset.width, height: preset.height }, isMobile: preset.isMobile, deviceScaleFactor: parsed.viewport === "desktop" ? 1 : 2 });
      const page = await context.newPage();
      await installSsrfRouteGuard(page, allowPrivateNetwork);
      const requests: Array<Record<string, unknown>> = [];
      const failures: Array<Record<string, unknown>> = [];
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      let requestIndex = 0;

      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("request", (request) => {
        if (requests.length < parsed.maxRequests) requests.push({ url: request.url(), method: request.method(), resourceType: request.resourceType() });
      });
      page.on("requestfailed", (request) => {
        if (failures.length < parsed.maxRequests) failures.push({ url: request.url(), method: request.method(), resourceType: request.resourceType(), failure: request.failure()?.errorText ?? "failed" });
      });

      await page.route("**/*", async (route) => {
        const request = route.request();
        requestIndex += 1;
        const isMainDocument = request.resourceType() === "document" && request.url() === parsed.url;
        if (scenario === "offline" && !isMainDocument) return route.abort("internetdisconnected");
        if (scenario === "timeout" && !isMainDocument) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(parsed.timeoutMs + 500, 10000)));
          return route.abort("timedout");
        }
        if (scenario === "flaky" && !isMainDocument && requestIndex % 3 === 0) return route.abort("connectionreset");
        const delay = scenarioDelayMs(scenario);
        if (delay > 0 && !isMainDocument) await new Promise((resolve) => setTimeout(resolve, delay));
        return route.continue();
      });

      let navigationError: string | undefined;
      try {
        await page.goto(parsed.url, { waitUntil: "domcontentloaded", timeout: parsed.timeoutMs });
        await page.waitForTimeout(parsed.settleMs);
      } catch (error) {
        navigationError = error instanceof Error ? error.message : "Navigation failed.";
      }

      const uiSignals = await page.evaluate(() => {
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const lowered = text.toLowerCase();
        return {
          title: document.title,
          textSample: text.slice(0, 1600),
          hasOfflineCopy: /\boffline\b|no internet|no network|connection lost|reconnect/.test(lowered),
          hasLoadingCopy: /\bloading\b|please wait|spinner|fetching|syncing/.test(lowered),
          hasErrorCopy: /\berror\b|failed|try again|retry|timeout|unavailable/.test(lowered),
          serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
          online: navigator.onLine
        };
      }).catch((error) => ({
        title: "",
        textSample: "",
        hasOfflineCopy: false,
        hasLoadingCopy: false,
        hasErrorCopy: false,
        serviceWorkerControlled: false,
        online: undefined,
        evaluateError: error instanceof Error ? error.message : "Evaluation failed."
      }));

      let screenshotUrl: string | undefined;
      if (parsed.screenshot) {
        const image = await page.screenshot({ type: "jpeg", quality: 68, fullPage: false }).catch(() => undefined);
        if (image) {
          screenshotUrl = await saveArtifactUrl(ctx, `network-${scenario}-${randomUUID()}.jpg`, "image/jpeg", image);
          screenshots.push(screenshotUrl);
        }
      }
      const result = {
        scenario,
        viewport: parsed.viewport,
        finalUrl: page.url(),
        navigationError,
        requestCount: requests.length,
        failureCount: failures.length,
        requests: requests.slice(0, parsed.maxRequests),
        failures: failures.slice(0, parsed.maxRequests),
        consoleErrors: consoleErrors.slice(0, 20),
        pageErrors: pageErrors.slice(0, 20),
        uiSignals,
        screenshotUrl,
        passedRecoverySignal: Boolean(uiSignals.hasOfflineCopy || uiSignals.hasLoadingCopy || uiSignals.hasErrorCopy || uiSignals.serviceWorkerControlled)
      };
      scenarioResults.push(result);
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const blocking = scenarioResults
    .filter((result) => !result.passedRecoverySignal)
    .map((result) => `${result.scenario}: no offline/loading/error/recovery UI signal detected.`);
  const sections = scenarioResults.map((result) => `<section><h2>${escapeHtml(String(result.scenario))}</h2>${result.screenshotUrl ? `<img src="${escapeHtml(String(result.screenshotUrl))}" alt="${escapeHtml(String(result.scenario))} screenshot">` : ""}<pre>${escapeHtml(jsonForLog(result))}</pre></section>`);
  const reportUrl = await createHtmlReport(ctx, "Network Conditions Report", `Inspected ${parsed.url}`, "network-conditions", renderInspectionReport("Network Conditions Report", parsed.url, sections, [`${blocking.length} scenario(s) missing recovery UI signals`]));
  const report = {
    ok: blocking.length === 0,
    url: parsed.url,
    viewport: parsed.viewport,
    scenarios: parsed.scenarios,
    blockingErrors: blocking,
    reportUrl,
    inspectedAt: new Date().toISOString(),
    results: scenarioResults
  };
  return {
    ok: report.ok,
    summary: report.ok ? `Network condition inspection passed for ${parsed.url}.` : `Network condition inspection found ${blocking.length} recovery gap(s).`,
    shareUrl: reportUrl,
    previewUrl: reportUrl,
    artifacts: [reportUrl, ...screenshots],
    structuredContent: report,
    logs: [jsonForLog(report)],
    errors: blocking
  };
}

async function handleAccessibility(input: unknown, ctx: ToolContext, allowPrivateNetwork = false): Promise<ToolResult> {
  const parsed = auditAccessibilitySchema.parse(input);
  await guardInspectionUrl(parsed.url, allowPrivateNetwork);
  const { chromium } = await import("playwright");
  const { AxeBuilder } = await import("@axe-core/playwright");
  const browser = await chromium.launch({ headless: true });
  const results: Array<Record<string, unknown>> = [];
  try {
    for (const viewportName of parsed.viewports) {
      const preset = viewportPresets[viewportName];
      const context = await browser.newContext({ viewport: { width: preset.width, height: preset.height }, isMobile: preset.isMobile, deviceScaleFactor: viewportName === "desktop" ? 1 : 2 });
      const page = await context.newPage();
      await installSsrfRouteGuard(page, allowPrivateNetwork);
      await page.goto(parsed.url, { waitUntil: "networkidle", timeout: parsed.timeoutMs });
      let builder = new AxeBuilder({ page });
      if (parsed.includedRules.length) builder = builder.withRules(parsed.includedRules);
      if (parsed.excludedRules.length) builder = builder.disableRules(parsed.excludedRules);
      const axe = await builder.analyze();
      const screenshotUrl = await saveArtifactUrl(ctx, `${viewportName}-a11y-${randomUUID()}.jpg`, "image/jpeg", await page.screenshot({ type: "jpeg", quality: 62, fullPage: false }));
      results.push({
        viewport: viewportName,
        screenshotUrl,
        violations: axe.violations.slice(0, parsed.maxViolations).map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          description: violation.description,
          help: violation.help,
          helpUrl: violation.helpUrl,
          nodes: violation.nodes.slice(0, 8).map((node) => ({ target: node.target, html: node.html, failureSummary: node.failureSummary }))
        }))
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const sections = results.map((result) => {
    const violations = result.violations as Array<Record<string, unknown>>;
    return `<section><h2>${escapeHtml(String(result.viewport))}</h2>${result.screenshotUrl ? `<img src="${escapeHtml(String(result.screenshotUrl))}" alt="${escapeHtml(String(result.viewport))} accessibility screenshot">` : ""}<h3>Violations</h3><ul>${violations.map((violation) => `<li><strong>${escapeHtml(String(violation.impact ?? "unknown"))} / ${escapeHtml(String(violation.id))}:</strong> ${escapeHtml(String(violation.help))} <a href="${escapeHtml(String(violation.helpUrl))}">help</a></li>`).join("") || "<li>No axe violations detected.</li>"}</ul></section>`;
  });
  const reportUrl = await createHtmlReport(ctx, "Accessibility Audit Report", `Audited ${parsed.url}`, "accessibility-audit", renderInspectionReport("Accessibility Audit Report", parsed.url, sections));
  const totalViolations = results.reduce((sum, result) => sum + (result.violations as unknown[]).length, 0);
  return toolResult(`Accessibility audit found ${totalViolations} violation(s).`, reportUrl, { reportUrl, url: parsed.url, totalViolations, results });
}

async function handleLighthouse(input: unknown, ctx: ToolContext, allowPrivateNetwork = false): Promise<ToolResult> {
  const parsed = auditLighthouseSchema.parse(input);
  await guardInspectionUrl(parsed.url, allowPrivateNetwork);
  const lighthouse = (await import("lighthouse")).default;
  const chromeLauncher = await import("chrome-launcher");
  const chrome = await chromeLauncher.launch({ chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"] });
  try {
    const result = await lighthouse(parsed.url, {
      port: chrome.port,
      onlyCategories: parsed.categories,
      formFactor: parsed.formFactor,
      screenEmulation: parsed.formFactor === "mobile"
        ? { mobile: true, width: 390, height: 844, deviceScaleFactor: 2, disabled: false }
        : { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1, disabled: false },
      maxWaitForLoad: parsed.timeoutMs
    });
    if (!result) throw new Error("Lighthouse did not return a result.");
    const lhr = result.lhr;
    // Lighthouse drives its own Chrome, so installSsrfRouteGuard cannot intercept its
    // navigations. Validate the URL it actually landed on: if the entry URL redirected
    // into a private/reserved host, discard the report so its contents never reach the
    // client (the request fired, but the response is withheld — that kills the exfil).
    if (!allowPrivateNetwork) {
      const finalUrl = (lhr as { mainDocumentUrl?: string; finalDisplayedUrl?: string; finalUrl?: string }).mainDocumentUrl
        ?? (lhr as { finalDisplayedUrl?: string }).finalDisplayedUrl
        ?? (lhr as { finalUrl?: string }).finalUrl;
      if (finalUrl) await assertSafePublicUrl(finalUrl, { protocols: INSPECTION_PROTOCOLS });
    }
    const scores = Object.fromEntries(Object.entries(lhr.categories).map(([key, category]) => [key, category.score === null ? null : Math.round(category.score * 100)]));
    const failedAudits = Object.values(lhr.audits)
      .filter((audit) => audit.score !== null && audit.score !== undefined && audit.score < 1 && audit.scoreDisplayMode !== "notApplicable")
      .slice(0, 20)
      .map((audit) => ({ id: audit.id, title: audit.title, score: audit.score, displayValue: audit.displayValue ?? "" }));
    const htmlReport = Array.isArray(result.report) ? result.report.join("\n") : result.report;
    const reportUrl = await saveArtifactUrl(ctx, `lighthouse-${randomUUID()}.html`, "text/html", htmlReport);
    return toolResult(`Lighthouse audit completed for ${parsed.url}.`, reportUrl, { reportUrl, url: parsed.url, formFactor: parsed.formFactor, scores, failedAudits });
  } finally {
    await chrome.kill();
  }
}

async function runFlowStep(page: Page, step: z.infer<typeof flowStepSchema>, defaultTimeout: number): Promise<string> {
  const timeout = "timeoutMs" in step && step.timeoutMs ? step.timeoutMs : defaultTimeout;
  switch (step.action) {
    case "click":
      await page.locator(step.selector).click({ timeout });
      return `clicked ${step.selector}`;
    case "fill":
      await page.locator(step.selector).fill(step.value, { timeout });
      return `filled ${step.selector}`;
    case "press":
      await page.locator(step.selector).press(step.key, { timeout });
      return `pressed ${step.key} on ${step.selector}`;
    case "select":
      await page.locator(step.selector).selectOption(step.value, { timeout });
      return `selected ${step.value} on ${step.selector}`;
    case "waitForSelector":
      await page.waitForSelector(step.selector, { timeout });
      return `waited for ${step.selector}`;
    case "waitForUrl":
      await page.waitForURL(step.url, { timeout });
      return `waited for URL ${step.url}`;
    case "assertText":
      await page.getByText(step.text).waitFor({ timeout });
      return `found text ${step.text}`;
    case "screenshot":
      return `captured screenshot ${step.name ?? "step"}`;
  }
}

async function handleInteractionFlow(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = inspectInteractionFlowSchema.parse(input);
  await guardInspectionUrl(parsed.url, false);
  const { chromium } = await import("playwright");
  const preset = viewportPresets[parsed.viewport];
  const browser = await chromium.launch({ headless: true });
  const stepResults: Array<Record<string, unknown>> = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let finalUrl = parsed.url;
  try {
    const context = await browser.newContext({ viewport: { width: preset.width, height: preset.height }, isMobile: preset.isMobile, deviceScaleFactor: parsed.viewport === "desktop" ? 1 : 2 });
    const page = await context.newPage();
    await installSsrfRouteGuard(page, false);
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(parsed.url, { waitUntil: "networkidle", timeout: parsed.timeoutMs });
    for (let index = 0; index < parsed.steps.length; index += 1) {
      const step = parsed.steps[index];
      try {
        const message = await runFlowStep(page, step, parsed.timeoutMs);
        let screenshotUrl: string | undefined;
        if (parsed.screenshotEachStep || step.action === "screenshot") {
          screenshotUrl = await saveArtifactUrl(ctx, `flow-step-${index + 1}-${randomUUID()}.jpg`, "image/jpeg", await page.screenshot({ type: "jpeg", quality: 62, fullPage: false }));
        }
        stepResults.push({ index: index + 1, action: step.action, ok: true, message, screenshotUrl });
      } catch (error) {
        const screenshotUrl = await saveArtifactUrl(ctx, `flow-failure-${index + 1}-${randomUUID()}.jpg`, "image/jpeg", await page.screenshot({ type: "jpeg", quality: 62, fullPage: false }));
        stepResults.push({ index: index + 1, action: step.action, ok: false, error: error instanceof Error ? error.message : "Step failed.", screenshotUrl });
        break;
      }
    }
    finalUrl = page.url();
    await context.close();
  } finally {
    await browser.close();
  }
  const sections = [`<section><h2>Steps</h2><ul>${stepResults.map((step) => `<li><strong>${step.ok ? "pass" : "fail"} / ${step.index} / ${escapeHtml(String(step.action))}:</strong> ${escapeHtml(String(step.message ?? step.error ?? ""))}${step.screenshotUrl ? ` <a href="${escapeHtml(String(step.screenshotUrl))}">screenshot</a>` : ""}</li>`).join("")}</ul></section>`];
  const reportUrl = await createHtmlReport(ctx, "Interaction Flow Report", `Tested ${parsed.url}`, "interaction-flow", renderInspectionReport("Interaction Flow Report", parsed.url, sections, [`Final URL: ${finalUrl}`]));
  const ok = stepResults.every((step) => step.ok) && consoleErrors.length === 0 && pageErrors.length === 0;
  return { ...toolResult(ok ? "Interaction flow passed." : "Interaction flow found failures.", reportUrl, { reportUrl, url: parsed.url, finalUrl, steps: stepResults, consoleErrors, pageErrors }), ok };
}

async function handleAnalyzeVisual(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = analyzeWebpageVisualSchema.parse(input);
  await guardInspectionUrl(parsed.url, false);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const results: Array<Record<string, unknown>> = [];
  try {
    for (const viewportName of parsed.viewports) {
      const preset = viewportPresets[viewportName];
      const context = await browser.newContext({ viewport: { width: preset.width, height: preset.height }, isMobile: preset.isMobile, deviceScaleFactor: viewportName === "desktop" ? 1 : 2 });
      const page = await context.newPage();
      await installSsrfRouteGuard(page, false);
      await page.goto(parsed.url, { waitUntil: "networkidle", timeout: parsed.timeoutMs });
      const screenshotUrl = await saveArtifactUrl(ctx, `visual-analysis-${viewportName}-${randomUUID()}.jpg`, "image/jpeg", await page.screenshot({ type: "jpeg", quality: 68, fullPage: parsed.fullPage }));
      const analysis = await page.evaluate((limit) => {
        const selectorFor = (element: Element): string => {
          if (element.id) return `${element.tagName.toLowerCase()}#${CSS.escape(element.id)}`;
          const className = typeof element.className === "string" && element.className.trim()
            ? `.${element.className.trim().split(/\s+/).slice(0, 3).map((item) => CSS.escape(item)).join(".")}`
            : "";
          return `${element.tagName.toLowerCase()}${className}`;
        };
        const rgb = (value: string): [number, number, number] | undefined => {
          const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
          return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
        };
        const luminance = ([r, g, b]: [number, number, number]) => {
          const channel = (v: number) => {
            const normalized = v / 255;
            return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        const contrast = (fg?: [number, number, number], bg?: [number, number, number]) => {
          if (!fg || !bg) return undefined;
          const lighter = Math.max(luminance(fg), luminance(bg));
          const darker = Math.min(luminance(fg), luminance(bg));
          return (lighter + 0.05) / (darker + 0.05);
        };
        const backgroundFor = (element: Element): string => {
          let current: Element | null = element;
          while (current) {
            const bg = getComputedStyle(current).backgroundColor;
            if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
            current = current.parentElement;
          }
          return getComputedStyle(document.body).backgroundColor || "rgb(255,255,255)";
        };
        const visibleElements = Array.from(document.body.querySelectorAll("*")).filter((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        });
        const textFindings: Array<Record<string, unknown>> = [];
        for (const element of visibleElements) {
          const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
          if (!text || text.length > 300) continue;
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const fontSize = Number.parseFloat(style.fontSize || "0");
          const ratio = contrast(rgb(style.color), rgb(backgroundFor(element)));
          const clipped = element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
          if ((ratio !== undefined && ratio < (fontSize >= 18 ? 3 : 4.5)) || fontSize < 12 || clipped) {
            textFindings.push({
              type: ratio !== undefined && ratio < (fontSize >= 18 ? 3 : 4.5) ? "low-contrast-text" : fontSize < 12 ? "small-text" : "clipped-text",
              selector: selectorFor(element),
              text: text.slice(0, 140),
              box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
              fontSize,
              contrastRatio: ratio ? Number(ratio.toFixed(2)) : undefined
            });
          }
          if (textFindings.length >= limit) break;
        }
        const regions = visibleElements
          .map((element) => {
            const box = element.getBoundingClientRect();
            return {
              selector: selectorFor(element),
              role: element.getAttribute("role") || element.tagName.toLowerCase(),
              text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
              box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
              area: Math.round(box.width * box.height)
            };
          })
          .filter((entry) => entry.area > 12000)
          .sort((left, right) => right.area - left.area)
          .slice(0, 12);
        return {
          title: document.title,
          viewportSize: { width: window.innerWidth, height: window.innerHeight },
          bodyTextLength: (document.body.innerText || "").trim().length,
          imageCount: document.images.length,
          interactiveCount: document.querySelectorAll("a,button,input,select,textarea,[role='button'],[onclick]").length,
          findings: textFindings,
          regions
        };
      }, parsed.maxFindings);
      results.push({ viewport: viewportName, screenshotUrl, ...analysis });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const totalFindings = results.reduce((sum, result) => sum + ((result.findings as unknown[])?.length ?? 0), 0);
  const sections = results.map((result) => `<section><h2>${escapeHtml(String(result.viewport))}</h2><img src="${escapeHtml(String(result.screenshotUrl))}" alt="${escapeHtml(String(result.viewport))} visual analysis screenshot"><h3>Agent-readable visual findings</h3><pre>${escapeHtml(jsonForLog(result))}</pre></section>`);
  const reportUrl = await createHtmlReport(ctx, "Visual Debug Analysis", `Analyzed ${parsed.url}`, "visual-analysis", renderInspectionReport("Visual Debug Analysis", parsed.url, sections, [`${totalFindings} visual finding(s)`]));
  return toolResult(`Visual analysis produced ${totalFindings} finding(s) across ${results.length} viewport(s).`, reportUrl, { reportUrl, url: parsed.url, totalFindings, results });
}

async function handleDomAtPoint(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = inspectDomAtPointSchema.parse(input);
  await guardInspectionUrl(parsed.url, false);
  const { chromium } = await import("playwright");
  const preset = viewportPresets[parsed.viewport];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: preset.width, height: preset.height }, isMobile: preset.isMobile, deviceScaleFactor: parsed.viewport === "desktop" ? 1 : 2 });
    const page = await context.newPage();
    await installSsrfRouteGuard(page, false);
    await page.goto(parsed.url, { waitUntil: "networkidle", timeout: parsed.timeoutMs });
    const stack = await page.evaluate(({ x, y }) => {
      const selectorFor = (element: Element): string => {
        if (element.id) return `${element.tagName.toLowerCase()}#${CSS.escape(element.id)}`;
        const className = typeof element.className === "string" && element.className.trim()
          ? `.${element.className.trim().split(/\s+/).slice(0, 3).map((item) => CSS.escape(item)).join(".")}`
          : "";
        return `${element.tagName.toLowerCase()}${className}`;
      };
      return document.elementsFromPoint(x, y).slice(0, 12).map((element, index) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          index,
          selector: selectorFor(element),
          tag: element.tagName.toLowerCase(),
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 220),
          attributes: {
            id: element.getAttribute("id"),
            class: element.getAttribute("class"),
            role: element.getAttribute("role"),
            ariaLabel: element.getAttribute("aria-label"),
            href: element.getAttribute("href"),
            type: element.getAttribute("type"),
            disabled: element.hasAttribute("disabled") ? "true" : undefined,
            onclick: element.hasAttribute("onclick") ? "inline" : undefined
          },
          box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
          styles: {
            display: style.display,
            position: style.position,
            zIndex: style.zIndex,
            pointerEvents: style.pointerEvents,
            visibility: style.visibility,
            opacity: style.opacity,
            overflow: style.overflow,
            color: style.color,
            backgroundColor: style.backgroundColor
          },
          likelyInteractive: /^(a|button|input|select|textarea)$/i.test(element.tagName) || element.getAttribute("role") === "button" || element.hasAttribute("onclick")
        };
      });
    }, { x: parsed.x, y: parsed.y });
    const screenshotUrl = parsed.includeScreenshot
      ? await saveArtifactUrl(ctx, `dom-point-${parsed.viewport}-${randomUUID()}.jpg`, "image/jpeg", await page.screenshot({ type: "jpeg", quality: 70, fullPage: false }))
      : undefined;
    await context.close();
    const payload = { reportUrl: undefined as string | undefined, url: parsed.url, viewport: parsed.viewport, point: { x: parsed.x, y: parsed.y }, topElement: stack[0], stack, screenshotUrl };
    const reportUrl = await createHtmlReport(ctx, "DOM Point Inspection", `Inspected ${parsed.url}`, "dom-point", renderInspectionReport("DOM Point Inspection", parsed.url, [`<section><h2>Point ${parsed.x},${parsed.y}</h2>${screenshotUrl ? `<img src="${escapeHtml(screenshotUrl)}" alt="DOM point screenshot">` : ""}<pre>${escapeHtml(jsonForLog(payload))}</pre></section>`]));
    payload.reportUrl = reportUrl;
    return toolResult(stack.length > 0 ? `Found ${stack.length} element(s) at ${parsed.x},${parsed.y}.` : `No element found at ${parsed.x},${parsed.y}.`, reportUrl, payload);
  } finally {
    await browser.close();
  }
}

function viewportFor3dPreset(preset: z.infer<typeof threeDViewPresetSchema>): { width: number; height: number; isMobile: boolean; deviceScaleFactor: number } {
  if (preset === "mobile_portrait") return { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 };
  if (preset === "mobile_landscape") return { width: 844, height: 390, isMobile: true, deviceScaleFactor: 2 };
  return { width: 1440, height: 900, isMobile: false, deviceScaleFactor: 1 };
}

function severityRank(severity: string): number {
  return severity === "critical" ? 4 : severity === "high" ? 3 : severity === "medium" ? 2 : severity === "low" ? 1 : 0;
}

function scoreFromFindings(findings: Array<{ severity: string }>, base = 100): number {
  const penalty = findings.reduce((sum, finding) => sum + (finding.severity === "critical" ? 30 : finding.severity === "high" ? 18 : finding.severity === "medium" ? 9 : 4), 0);
  return Math.max(0, Math.min(100, base - penalty));
}

async function handleInspect3dSceneVisuals(input: unknown, ctx: ToolContext, allowPrivateNetwork = false): Promise<ToolResult> {
  const parsed = inspect3dSceneVisualsSchema.parse(input);
  await guardInspectionUrl(parsed.url, allowPrivateNetwork);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const results: Array<Record<string, unknown>> = [];
  const screenshots: string[] = [];

  try {
    for (const viewPreset of parsed.viewPresets) {
      const viewport = viewportFor3dPreset(viewPreset);
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.isMobile, deviceScaleFactor: viewport.deviceScaleFactor });
      const page = await context.newPage();
      await installSsrfRouteGuard(page, allowPrivateNetwork);
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.goto(parsed.url, { waitUntil: "networkidle", timeout: parsed.timeoutMs });
      const hookResult = await page.evaluate(async (preset) => {
        const maybeWindow = window as typeof window & { __set3DView__?: (view: string) => unknown | Promise<unknown> };
        if (typeof maybeWindow.__set3DView__ === "function") {
          await maybeWindow.__set3DView__(preset);
          return "window.__set3DView__";
        }
        window.dispatchEvent(new CustomEvent("mcp:set-3d-view", { detail: { preset } }));
        return "CustomEvent:mcp:set-3d-view";
      }, viewPreset).catch((error) => `view hook failed: ${error instanceof Error ? error.message : "unknown"}`);
      await page.waitForTimeout(parsed.settleMs);

      const screenshot = await page.screenshot({ type: "jpeg", quality: 72, fullPage: false });
      const screenshotUrl = await saveArtifactUrl(ctx, `3d-visual-${viewPreset}-${randomUUID()}.jpg`, "image/jpeg", screenshot);
      screenshots.push(screenshotUrl);

      const analysis = await page.evaluate(({ canvasSelector, expectedFacing, maxFindings }) => {
        type Finding = { severity: "low" | "medium" | "high" | "critical"; issueType: string; message: string; likelyCause: string; suggestedFix: string; selector?: string; evidence?: Record<string, unknown> };
        const findings: Finding[] = [];
        const selectorFor = (element: Element): string => {
          if (element.id) return `${element.tagName.toLowerCase()}#${CSS.escape(element.id)}`;
          const className = typeof element.className === "string" && element.className.trim()
            ? `.${element.className.trim().split(/\s+/).slice(0, 3).map((item) => CSS.escape(item)).join(".")}`
            : "";
          return `${element.tagName.toLowerCase()}${className}`;
        };
        const boxFor = (rect: DOMRect) => ({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), right: Math.round(rect.right), bottom: Math.round(rect.bottom) });
        const canvas = document.querySelector(canvasSelector) as HTMLCanvasElement | null;
        const bodyText = (document.body.innerText || "").replace(/\s+/g, " ").trim();
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const documentSize = { width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) };
        if (!canvas) {
          findings.push({ severity: "critical", issueType: "missing-canvas", message: `No canvas found for selector ${canvasSelector}.`, likelyCause: "The 3D scene did not mount or selector is wrong.", suggestedFix: "Confirm the WebGL canvas selector and wait for the renderer to mount.", selector: canvasSelector });
          return { title: document.title, bodyTextSample: bodyText.slice(0, 800), viewport, documentSize, canvas: null, canvasPixels: null, overlayCandidates: [], runtimeSignals: {}, findings: findings.slice(0, maxFindings) };
        }
        const rect = canvas.getBoundingClientRect();
        const canvasBox = boxFor(rect);
        const canvasArea = rect.width * rect.height;
        const viewportArea = window.innerWidth * window.innerHeight;
        if (rect.width < 160 || rect.height < 160 || canvasArea / viewportArea < 0.12) {
          findings.push({ severity: "high", issueType: "model-too-small-or-canvas-too-small", message: "Canvas occupies too little of the viewport for a 3D showcase.", likelyCause: "Canvas/container sizing or camera framing leaves the model hard to inspect.", suggestedFix: "Increase canvas area and adjust camera distance/FOV so the model fills the primary viewport.", selector: canvasSelector, evidence: { canvasBox, viewport } });
        }
        if (rect.left < -1 || rect.top < -1 || rect.right > window.innerWidth + 1 || rect.bottom > window.innerHeight + 1) {
          findings.push({ severity: "high", issueType: "canvas-clipped", message: "Canvas extends outside the visible viewport.", likelyCause: "Responsive layout or fixed container is clipping the WebGL scene.", suggestedFix: "Constrain canvas with responsive width/height and verify mobile safe areas.", selector: canvasSelector, evidence: { canvasBox, viewport } });
        }
        if (documentSize.width > window.innerWidth + 1) {
          findings.push({ severity: "medium", issueType: "mobile-canvas-overflow", message: "Document has horizontal overflow.", likelyCause: "Canvas or surrounding UI exceeds viewport width.", suggestedFix: "Set max-width:100%, avoid fixed desktop widths, and test mobile landscape/portrait.", evidence: { viewport, documentSize } });
        }
        let canvasPixels: Record<string, unknown> | null = null;
        try {
          const sample = document.createElement("canvas");
          const width = Math.min(96, Math.max(1, Math.floor(canvas.width || rect.width)));
          const height = Math.min(96, Math.max(1, Math.floor(canvas.height || rect.height)));
          sample.width = width;
          sample.height = height;
          const ctx = sample.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(canvas, 0, 0, width, height);
            const data = ctx.getImageData(0, 0, width, height).data;
            let lit = 0;
            let dark = 0;
            let bright = 0;
            let nonTransparent = 0;
            let edgeColored = 0;
            let totalLuma = 0;
            for (let i = 0; i < data.length; i += 4) {
              const alpha = data[i + 3];
              if (alpha < 8) continue;
              nonTransparent += 1;
              const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
              totalLuma += luma;
              if (luma > 12) lit += 1;
              if (luma < 28) dark += 1;
              if (luma > 238) bright += 1;
              const pixel = i / 4;
              const x = pixel % width;
              const y = Math.floor(pixel / width);
              if ((x < 3 || y < 3 || x > width - 4 || y > height - 4) && luma > 20) edgeColored += 1;
            }
            const pixels = width * height;
            const nonTransparentRatio = nonTransparent / pixels;
            const averageLuma = nonTransparent ? totalLuma / nonTransparent : 0;
            canvasPixels = { readable: true, width, height, nonTransparentRatio: Number(nonTransparentRatio.toFixed(3)), averageLuma: Math.round(averageLuma), darkRatio: Number((dark / Math.max(nonTransparent, 1)).toFixed(3)), brightRatio: Number((bright / Math.max(nonTransparent, 1)).toFixed(3)), edgeColoredRatio: Number((edgeColored / Math.max(nonTransparent, 1)).toFixed(3)) };
            if (nonTransparentRatio < 0.02 || lit / Math.max(nonTransparent, 1) < 0.02) findings.push({ severity: "critical", issueType: "model-hidden-or-blank-render", message: "Canvas appears blank or nearly blank.", likelyCause: "Renderer failed, model is off camera, or scene/background is empty.", suggestedFix: "Check renderer initialization, asset loading, camera target, and scene lighting.", selector: canvasSelector, evidence: canvasPixels });
            if (averageLuma < 35) findings.push({ severity: "high", issueType: "model-too-dark", message: "Canvas is very dark.", likelyCause: "Lighting/exposure/materials are too dark or model is unlit.", suggestedFix: "Increase ambient/key light, adjust tone mapping/exposure, and verify material colors.", selector: canvasSelector, evidence: canvasPixels });
            if (bright / Math.max(nonTransparent, 1) > 0.65) findings.push({ severity: "medium", issueType: "overexposed-scene", message: "Canvas has a high ratio of near-white pixels.", likelyCause: "Lighting or background may be overexposed.", suggestedFix: "Lower exposure/intensity and use balanced background contrast.", selector: canvasSelector, evidence: canvasPixels });
            if (edgeColored / Math.max(nonTransparent, 1) > 0.20) findings.push({ severity: "medium", issueType: "model-clipped-by-frame", message: "Significant rendered content reaches canvas edges.", likelyCause: "Camera is too close or model is clipped by frame.", suggestedFix: "Increase camera distance, adjust FOV, or recenter model bounds.", selector: canvasSelector, evidence: canvasPixels });
          }
        } catch (error) {
          canvasPixels = { readable: false, error: error instanceof Error ? error.message : "canvas pixel read failed" };
          findings.push({ severity: "low", issueType: "canvas-pixel-read-unavailable", message: "Canvas pixel sampling was unavailable.", likelyCause: "Canvas may be tainted by cross-origin textures or WebGL readback restrictions.", suggestedFix: "Serve textures with CORS or use same-origin assets for automated visual QA.", selector: canvasSelector });
        }
        const visibleElements = Array.from(document.body.querySelectorAll("*")).filter((element) => {
          if (element === canvas) return false;
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0.05;
        });
        const overlayCandidates = visibleElements
          .map((element) => ({ element, box: element.getBoundingClientRect(), style: getComputedStyle(element), selector: selectorFor(element), text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120) }))
          .filter((entry) => entry.box.right > rect.left && entry.box.left < rect.right && entry.box.bottom > rect.top && entry.box.top < rect.bottom && entry.box.width * entry.box.height > Math.min(canvasArea * 0.04, 18000))
          .slice(0, 12)
          .map((entry) => ({ selector: entry.selector, text: entry.text, box: boxFor(entry.box), position: entry.style.position, zIndex: entry.style.zIndex }));
        if (overlayCandidates.some((entry) => entry.text.length > 0)) {
          findings.push({ severity: "medium", issueType: "ui-overlay-on-canvas", message: "Visible UI content overlaps the 3D canvas.", likelyCause: "Panels, headers, labels, or controls may be covering the model.", suggestedFix: "Reserve non-overlapping layout space or add responsive overlay constraints.", selector: canvasSelector, evidence: { overlayCandidates: overlayCandidates.slice(0, 5) } });
        }
        const runtimeSignals = {
          webglContextAvailable: Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl") || canvas.getContext("experimental-webgl")),
          exposedViewHook: typeof (window as typeof window & { __set3DView__?: unknown }).__set3DView__ === "function",
          expectedFacing,
          pageFacingHint: (document.body.getAttribute("data-facing") || canvas.getAttribute("data-facing") || "").toLowerCase(),
          threeObjectCount: typeof (window as typeof window & { THREE?: unknown }).THREE !== "undefined" ? "three-global-present" : undefined,
          performanceNow: Math.round(performance.now())
        };
        if (expectedFacing !== "any" && runtimeSignals.pageFacingHint && runtimeSignals.pageFacingHint !== expectedFacing) {
          findings.push({ severity: "medium", issueType: "wrong-facing-direction", message: `Page facing hint is ${runtimeSignals.pageFacingHint}, expected ${expectedFacing}.`, likelyCause: "Model rotation or camera preset does not match expected forward vector.", suggestedFix: "Rotate model root or adjust camera preset target/orbit angle.", selector: canvasSelector, evidence: runtimeSignals });
        }
        if (!runtimeSignals.webglContextAvailable) findings.push({ severity: "critical", issueType: "webgl-context-unavailable", message: "Canvas does not expose a WebGL context.", likelyCause: "Renderer may not have initialized or canvas is not the WebGL scene.", suggestedFix: "Check renderer mount code and canvas selector.", selector: canvasSelector });
        return { title: document.title, bodyTextSample: bodyText.slice(0, 800), viewport, documentSize, canvas: { selector: canvasSelector, box: canvasBox, intrinsicSize: { width: canvas.width, height: canvas.height } }, canvasPixels, overlayCandidates, runtimeSignals, findings: findings.slice(0, maxFindings) };
      }, { canvasSelector: parsed.canvasSelector, expectedFacing: parsed.expectedFacing, maxFindings: parsed.maxFindings });

      results.push({ viewPreset, viewportConfig: viewport, screenshotUrl, hookResult, consoleErrors: consoleErrors.slice(0, 20), pageErrors: pageErrors.slice(0, 20), ...analysis });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const allFindings = results.flatMap((result) => (Array.isArray(result.findings) ? result.findings as Array<{ severity: string; issueType: string; message: string }> : []).map((finding) => ({ viewPreset: result.viewPreset, ...finding })));
  allFindings.sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
  const lightingFindings = allFindings.filter((finding) => /dark|overexposed|blank/.test(finding.issueType));
  const compositionFindings = allFindings.filter((finding) => /small|large|clipped|inside|overlay|hidden|frame/.test(finding.issueType));
  const mobileFindings = allFindings.filter((finding) => String(finding.viewPreset).startsWith("mobile") || /mobile|overflow/.test(finding.issueType));
  const scores = {
    lightingScore: scoreFromFindings(lightingFindings),
    compositionScore: scoreFromFindings(compositionFindings),
    mobileFramingScore: scoreFromFindings(mobileFindings)
  };
  const blocking = allFindings.filter((finding) => finding.severity === "critical" || finding.severity === "high").map((finding) => `${finding.viewPreset} ${finding.issueType}: ${finding.message}`);
  const sections = results.map((result) => `<section><h2>${escapeHtml(String(result.viewPreset))}</h2>${result.screenshotUrl ? `<img src="${escapeHtml(String(result.screenshotUrl))}" alt="${escapeHtml(String(result.viewPreset))} 3D visual QA screenshot">` : ""}<h3>Analysis</h3><pre>${escapeHtml(jsonForLog(result))}</pre></section>`);
  const reportUrl = await createHtmlReport(ctx, "3D Scene Visual QA Report", `Inspected ${parsed.url}`, "3d-visual-qa", renderInspectionReport("3D Scene Visual QA Report", parsed.url, sections, [`${allFindings.length} 3D visual finding(s)`, `Lighting ${scores.lightingScore}/100 · Composition ${scores.compositionScore}/100 · Mobile ${scores.mobileFramingScore}/100`]));
  const report = { ok: blocking.length === 0, url: parsed.url, canvasSelector: parsed.canvasSelector, expectedStyle: parsed.expectedStyle, expectedFacing: parsed.expectedFacing, viewPresets: parsed.viewPresets, reportUrl, screenshots, findings: allFindings, scores, inspectedAt: new Date().toISOString(), results };
  return {
    ok: report.ok,
    summary: report.ok ? `3D visual QA passed for ${parsed.url}.` : `3D visual QA found ${blocking.length} blocking 3D visual issue(s).`,
    shareUrl: reportUrl,
    previewUrl: reportUrl,
    artifacts: [reportUrl, ...screenshots],
    structuredContent: report,
    logs: [jsonForLog(report)],
    errors: blocking
  };
}

function startLocalServer(ctx: ToolContext, input: z.infer<typeof inspectLocalProjectSchema>): { process: ChildProcess; url: string; logs: string[] } {
  const args = ["run", input.script];
  if (input.script === "dev") args.push("--", "--host", input.host, "--port", String(input.port));
  const proc = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: ctx.workspaceRoot,
    env: childEnv({ PORT: String(input.port), HOST: input.host }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [`Started npm run ${input.script} on ${input.host}:${input.port}`];
  proc.stdout?.on("data", (chunk) => logs.push(`[stdout] ${chunk.toString("utf8").trim()}`));
  proc.stderr?.on("data", (chunk) => logs.push(`[stderr] ${chunk.toString("utf8").trim()}`));
  const normalizedPath = input.path.startsWith("/") ? input.path : `/${input.path}`;
  return { process: proc, url: `http://${input.host}:${input.port}${normalizedPath}`, logs };
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.ok) return;
    } catch {
      // keep polling until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Local server did not become healthy within ${timeoutMs}ms.`);
}

async function handleLocalProject(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = inspectLocalProjectSchema.parse(input);
  const server = startLocalServer(ctx, parsed);
  try {
    await waitForHttp(server.url, parsed.timeoutMs);
    // Local project inspection targets its own spawned dev server on localhost, so
    // private-network access is expected and explicitly permitted here.
    const inspection = await handleInspectWebpage({ url: server.url, viewports: parsed.viewports, timeoutMs: parsed.timeoutMs, screenshot: true, captureNetwork: true, captureTrace: false }, ctx, true, true);
    const parts: Record<string, unknown> = { inspection: inspection.structuredContent, serverLogs: server.logs.slice(-40) };
    if (parsed.includeAccessibility) parts.accessibility = (await handleAccessibility({ url: server.url, viewports: parsed.viewports.filter((viewport) => viewport !== "tablet"), timeoutMs: parsed.timeoutMs }, ctx, true)).structuredContent;
    if (parsed.includeLighthouse) parts.lighthouse = (await handleLighthouse({ url: server.url, categories: ["accessibility", "seo"], formFactor: "desktop", timeoutMs: Math.max(parsed.timeoutMs, 30000) }, ctx, true)).structuredContent;
    const reportUrl = await createHtmlReport(ctx, "Local Project Inspection Report", `Inspected ${server.url}`, "local-project-inspect", renderInspectionReport("Local Project Inspection Report", server.url, [`<section><h2>Summary</h2><pre>${escapeHtml(jsonForLog(parts))}</pre></section>`]));
    return toolResult(`Local project inspection completed for ${server.url}.`, reportUrl, { reportUrl, url: server.url, ...parts });
  } finally {
    if (parsed.closeAfterCheck && !server.process.killed) server.process.kill("SIGTERM");
  }
}

function toolDefinition(name: string, description: string, properties: Record<string, unknown>, required: string[] = ["url"]): ToolModule["definition"] {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

const commonWebProperties = {
  url: { type: "string", description: "Absolute http(s) URL to inspect." },
  viewports: { type: "array", items: { type: "string", enum: ["desktop", "tablet", "mobile"] } },
  timeoutMs: { type: "number", minimum: 1000, maximum: 120000 },
  waitUntil: { type: "string", enum: ["domcontentloaded", "load", "networkidle"] },
  screenshot: { type: "boolean" },
  fullPage: { type: "boolean" },
  maxIssues: { type: "number", minimum: 1, maximum: 50 }
};

export const webInspectTools: ToolModule[] = [
  {
    definition: toolDefinition("inspect_webpage", "Render a URL in Chromium across desktop, tablet, and mobile viewports, then report screenshots, console errors, and responsive layout issues.", commonWebProperties),
    enabledByDefault: true,
    schema: inspectWebpageSchema,
    handler: (input, ctx) => handleInspectWebpage(input, ctx, false)
  },
  {
    definition: toolDefinition("inspect_webpage_plus", "Run deeper Chromium webpage inspection with screenshots, layout checks, console/page errors, failed/slow network requests, and optional Playwright trace.", { ...commonWebProperties, captureNetwork: { type: "boolean" }, captureTrace: { type: "boolean" }, slowRequestMs: { type: "number" } }),
    enabledByDefault: true,
    schema: inspectWebpagePlusSchema,
    handler: (input, ctx) => handleInspectWebpage(input, ctx, true)
  },
  {
    definition: toolDefinition("inspect_webpage_multibrowser", "Run webpage inspection across Chromium, Firefox, and WebKit/Safari-equivalent engines, with screenshots and browser-specific layout/runtime/network findings.", { ...commonWebProperties, browsers: { type: "array", items: { type: "string", enum: ["chromium", "firefox", "webkit"] } }, captureNetwork: { type: "boolean" }, captureTrace: { type: "boolean" }, slowRequestMs: { type: "number" }, continueOnBrowserError: { type: "boolean" } }),
    enabledByDefault: true,
    schema: inspectWebpageMultiBrowserSchema,
    handler: handleInspectWebpageMultiBrowser
  },
  {
    definition: toolDefinition("inspect_network_conditions", "Simulate offline, slow 3G/4G, flaky network, and timeout scenarios, then report loading/error/retry/cache recovery signals with screenshots.", { url: { type: "string" }, scenarios: { type: "array", items: { type: "string", enum: ["offline", "slow3g", "slow4g", "flaky", "timeout"] } }, viewport: { type: "string", enum: ["desktop", "tablet", "mobile"] }, timeoutMs: { type: "number" }, settleMs: { type: "number" }, screenshot: { type: "boolean" }, maxRequests: { type: "number" } }),
    enabledByDefault: true,
    schema: inspectNetworkConditionsSchema,
    handler: handleNetworkConditions
  },
  {
    definition: toolDefinition("audit_accessibility", "Audit a webpage with axe across desktop/mobile viewports and return WCAG-style accessibility findings.", { url: { type: "string" }, viewports: commonWebProperties.viewports, timeoutMs: commonWebProperties.timeoutMs, includedRules: { type: "array", items: { type: "string" } }, excludedRules: { type: "array", items: { type: "string" } }, maxViolations: { type: "number" } }),
    enabledByDefault: true,
    schema: auditAccessibilitySchema,
    handler: handleAccessibility
  },
  {
    definition: toolDefinition("audit_lighthouse", "Run Lighthouse performance, accessibility, best-practices, SEO, and PWA audits.", { url: { type: "string" }, categories: { type: "array", items: { type: "string", enum: ["performance", "accessibility", "best-practices", "seo", "pwa"] } }, formFactor: { type: "string", enum: ["desktop", "mobile"] }, timeoutMs: { type: "number" } }),
    enabledByDefault: true,
    schema: auditLighthouseSchema,
    handler: handleLighthouse
  },
  {
    definition: toolDefinition("inspect_interaction_flow", "Execute a safe declarative browser interaction flow and report step results, screenshots, and runtime errors.", { url: { type: "string" }, viewport: { type: "string", enum: ["desktop", "tablet", "mobile"] }, steps: { type: "array", items: { type: "object" } }, timeoutMs: { type: "number" }, screenshotEachStep: { type: "boolean" } }),
    enabledByDefault: true,
    schema: inspectInteractionFlowSchema,
    handler: handleInteractionFlow
  },
  {
    definition: toolDefinition("analyze_webpage_visual", "Capture screenshots and return agent-readable visual findings with coordinates, contrast/readability checks, clipped text, major regions, and screenshot artifacts.", { url: { type: "string" }, viewports: commonWebProperties.viewports, timeoutMs: commonWebProperties.timeoutMs, fullPage: commonWebProperties.fullPage, maxFindings: { type: "number", minimum: 1, maximum: 80 } }),
    enabledByDefault: true,
    schema: analyzeWebpageVisualSchema,
    handler: handleAnalyzeVisual
  },
  {
    definition: toolDefinition("inspect_3d_scene_visuals", "Capture multi-view WebGL/Three.js screenshots and report 3D-specific visual QA findings: dark/blank scene, clipping, canvas sizing, overlays, mobile overflow, facing hints, and composition scores.", { url: { type: "string" }, canvasSelector: { type: "string" }, expectedStyle: { type: "string" }, expectedFacing: { type: "string", enum: ["front", "back", "left", "right", "any"] }, expectedCameraDistance: { type: "number" }, viewPresets: { type: "array", items: { type: "string", enum: ["front", "back", "left", "right", "top", "isometric", "mobile_portrait", "mobile_landscape"] } }, timeoutMs: { type: "number" }, settleMs: { type: "number" }, maxFindings: { type: "number" } }),
    enabledByDefault: true,
    schema: inspect3dSceneVisualsSchema,
    handler: handleInspect3dSceneVisuals
  },
  {
    definition: toolDefinition("inspect_dom_at_point", "Map a viewport coordinate to the DOM element stack, computed styles, bounding boxes, pointer/z-index signals, and optional screenshot.", { url: { type: "string" }, viewport: { type: "string", enum: ["desktop", "tablet", "mobile"] }, x: { type: "number" }, y: { type: "number" }, timeoutMs: { type: "number" }, includeScreenshot: { type: "boolean" } }, ["url", "x", "y"]),
    enabledByDefault: true,
    schema: inspectDomAtPointSchema,
    handler: handleDomAtPoint
  },
  {
    definition: toolDefinition("inspect_local_project", "Start the local project server, inspect it with browser QA tools, optionally run accessibility/Lighthouse audits, then stop it.", { script: { type: "string", enum: ["dev", "start"] }, port: { type: "number" }, host: { type: "string" }, path: { type: "string" }, viewports: commonWebProperties.viewports, includeAccessibility: { type: "boolean" }, includeLighthouse: { type: "boolean" }, closeAfterCheck: { type: "boolean" }, timeoutMs: { type: "number" } }, []),
    enabledByDefault: true,
    schema: inspectLocalProjectSchema,
    handler: handleLocalProject
  }
];
