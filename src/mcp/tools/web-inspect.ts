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
import type { Page, Request, Response } from "playwright";

export type ViewportName = "desktop" | "tablet" | "mobile";

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
    for (const error of result.consoleErrors) blockingErrors.push(`${result.viewport} console error: ${error}`);
    for (const error of result.pageErrors) blockingErrors.push(`${result.viewport} page error: ${error}`);
    if (result.network) {
      for (const request of result.network.failedRequests) blockingErrors.push(`${result.viewport} failed request: ${request.method} ${request.url} (${request.failure})`);
      for (const asset of result.network.assetFailures) blockingErrors.push(`${result.viewport} asset failure: ${asset.resourceType} ${asset.url}`);
    }
    if (result.hasHorizontalOverflow) blockingErrors.push(`${result.viewport} has horizontal overflow.`);
    if (!result.title.trim()) warnings.push(`${result.viewport} page title is empty.`);
    for (const warning of result.consoleWarnings) warnings.push(`${result.viewport} console warning: ${warning}`);
    for (const issue of result.issues) {
      const message = `${result.viewport} ${issue.type}: ${issue.message}${issue.selector ? ` (${issue.selector})` : ""}`;
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
    const runtimeIssues = [
      ...result.consoleErrors.map((message) => `<li><strong>Console error:</strong> ${escapeHtml(message)}</li>`),
      ...result.consoleWarnings.map((message) => `<li><strong>Console warning:</strong> ${escapeHtml(message)}</li>`),
      ...result.pageErrors.map((message) => `<li><strong>Page error:</strong> ${escapeHtml(message)}</li>`),
      ...(result.network?.failedRequests ?? []).map((request) => `<li><strong>Failed request:</strong> ${escapeHtml(request.method)} ${escapeHtml(request.url)} (${escapeHtml(request.failure)})</li>`),
      ...(result.network?.assetFailures ?? []).map((asset) => `<li><strong>Asset failure:</strong> ${escapeHtml(asset.resourceType)} ${escapeHtml(asset.url)} ${asset.status ? `(${asset.status})` : ""}</li>`),
      ...result.issues.map((issue) => `<li><strong>${escapeHtml(issue.severity)} / ${escapeHtml(issue.type)}:</strong> ${escapeHtml(issue.message)}${issue.selector ? ` <code>${escapeHtml(issue.selector)}</code>` : ""}</li>`)
    ].join("");
    return `<section><h2>${escapeHtml(result.viewport)} ${result.width}x${result.height}</h2>
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

async function inspectWithPlaywright(url: string, options: InspectWebpagePlusOptions, ctx?: ToolContext): Promise<ViewportResult[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
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
        if (ctx) screenshotUrl = await saveArtifactUrl(ctx, `${viewportName}-screenshot-${runId}.jpg`, "image/jpeg", screenshot);
        else screenshotDataUrl = `data:image/jpeg;base64,${screenshot.toString("base64")}`;
      }
      let traceUrl: string | undefined;
      if (options.captureTrace) {
        const tracePath = path.join(traceDir, `${viewportName}-trace.zip`);
        await context.tracing.stop({ path: tracePath });
        if (ctx) traceUrl = await saveArtifactUrl(ctx, `${viewportName}-trace-${runId}.zip`, "application/zip", await readFile(tracePath));
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

async function handleInspectWebpage(input: unknown, ctx: ToolContext, plus: boolean): Promise<ToolResult> {
  const parsed = (plus ? inspectWebpagePlusSchema : inspectWebpageSchema).parse(input);
  const options = plus ? parsed as InspectWebpagePlusOptions : { ...parsed, captureNetwork: false, captureTrace: false, slowRequestMs: 2500 };
  const results = await inspectWithPlaywright(parsed.url, options, plus ? ctx : undefined);
  const reportUrl = await createHtmlReport(ctx, plus ? "Webpage Debug Report" : "Webpage Inspection Report", `Inspected ${parsed.url}`, plus ? "web-debug" : "web-inspect", renderWebpageInspectionReport(parsed.url, results));
  const resultForLogs = results.map(resultWithoutImages);
  const inspection = { ...summarizeBrowserInspection(resultForLogs), reportUrl, inspectedAt: new Date().toISOString() };
  return toolResult(inspection.ok ? `Inspected ${parsed.url}; no blocking responsive/runtime issues found.` : `Inspected ${parsed.url}; blocking responsive/runtime issues were found.`, reportUrl, inspection);
}

async function handleAccessibility(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = auditAccessibilitySchema.parse(input);
  const { chromium } = await import("playwright");
  const { AxeBuilder } = await import("@axe-core/playwright");
  const browser = await chromium.launch({ headless: true });
  const results: Array<Record<string, unknown>> = [];
  try {
    for (const viewportName of parsed.viewports) {
      const preset = viewportPresets[viewportName];
      const context = await browser.newContext({ viewport: { width: preset.width, height: preset.height }, isMobile: preset.isMobile, deviceScaleFactor: viewportName === "desktop" ? 1 : 2 });
      const page = await context.newPage();
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

async function handleLighthouse(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = auditLighthouseSchema.parse(input);
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

function startLocalServer(ctx: ToolContext, input: z.infer<typeof inspectLocalProjectSchema>): { process: ChildProcess; url: string; logs: string[] } {
  const args = ["run", input.script];
  if (input.script === "dev") args.push("--", "--host", input.host, "--port", String(input.port));
  const proc = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: ctx.workspaceRoot,
    env: { ...process.env, PORT: String(input.port), HOST: input.host },
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
    const inspection = await handleInspectWebpage({ url: server.url, viewports: parsed.viewports, timeoutMs: parsed.timeoutMs, screenshot: true, captureNetwork: true, captureTrace: false }, ctx, true);
    const parts: Record<string, unknown> = { inspection: inspection.structuredContent, serverLogs: server.logs.slice(-40) };
    if (parsed.includeAccessibility) parts.accessibility = (await handleAccessibility({ url: server.url, viewports: parsed.viewports.filter((viewport) => viewport !== "tablet"), timeoutMs: parsed.timeoutMs }, ctx)).structuredContent;
    if (parsed.includeLighthouse) parts.lighthouse = (await handleLighthouse({ url: server.url, categories: ["accessibility", "seo"], formFactor: "desktop", timeoutMs: Math.max(parsed.timeoutMs, 30000) }, ctx)).structuredContent;
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
    definition: toolDefinition("inspect_local_project", "Start the local project server, inspect it with browser QA tools, optionally run accessibility/Lighthouse audits, then stop it.", { script: { type: "string", enum: ["dev", "start"] }, port: { type: "number" }, host: { type: "string" }, path: { type: "string" }, viewports: commonWebProperties.viewports, includeAccessibility: { type: "boolean" }, includeLighthouse: { type: "boolean" }, closeAfterCheck: { type: "boolean" }, timeoutMs: { type: "number" } }, []),
    enabledByDefault: true,
    schema: inspectLocalProjectSchema,
    handler: handleLocalProject
  }
];
