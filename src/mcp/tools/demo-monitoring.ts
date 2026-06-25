import { z } from "zod";
import { appendProjectTaskHistory, getProjectManifest, readProjectFile, writeProjectFile } from "../../projects/store.js";
import { assertSafePublicUrl } from "../../security/url.js";
import { installSsrfRouteGuard } from "../../security/playwright-guard.js";
import type { ToolModule } from "../types.js";

const monitorPublishedDemoHealthSchema = z.object({
  projectId: z.string().min(8).max(80),
  url: z.string().url().optional(),
  viewports: z.array(z.enum(["desktop", "mobile"])).min(1).max(2).default(["desktop", "mobile"]),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  slowLoadMs: z.number().int().min(100).max(120000).default(3500),
  slowRequestMs: z.number().int().min(100).max(60000).default(2500),
  maxEvents: z.number().int().min(1).max(100).default(30),
  allowPrivateNetwork: z.boolean().default(false),
  outputDir: z.string().min(1).max(160).default("monitoring")
});

type MonitorIssue = {
  category: "uptime" | "runtime" | "console" | "network" | "asset" | "performance";
  severity: "low" | "medium" | "high";
  message: string;
  url?: string;
  viewport?: string;
};

type MonitorRun = {
  id: string;
  checkedAt: string;
  url: string;
  ok: boolean;
  score: number;
  uptime: { ok: boolean; status?: number; statusText?: string; durationMs: number; error?: string };
  viewports: Array<{
    viewport: "desktop" | "mobile";
    finalUrl: string;
    title: string;
    loadMs: number;
    consoleErrors: string[];
    pageErrors: string[];
    failedRequests: Array<{ url: string; method: string; failure: string }>;
    brokenAssets: Array<{ url: string; resourceType: string; status?: number; failure?: string }>;
    slowRequests: Array<{ url: string; method: string; durationMs: number; status?: number }>;
  }>;
  issues: MonitorIssue[];
};

const viewportPresets = {
  desktop: { width: 1440, height: 900, isMobile: false },
  mobile: { width: 390, height: 844, isMobile: true }
} as const;

function safeSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "monitoring";
}

function outputPath(outputDir: string, filename: string): string {
  const dir = outputDir.split("/").map(safeSegment).filter(Boolean).join("/") || "monitoring";
  return `${dir}/${filename}`;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

async function uptimeCheck(url: string, timeoutMs: number): Promise<MonitorRun["uptime"]> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal, redirect: "follow" });
    return { ok: response.ok, status: response.status, statusText: response.statusText, durationMs: Date.now() - started };
  } catch (error) {
    return { ok: false, durationMs: Date.now() - started, error: error instanceof Error ? error.message : "Request failed." };
  } finally {
    clearTimeout(timer);
  }
}

async function browserMonitor(url: string, input: z.infer<typeof monitorPublishedDemoHealthSchema>) {
  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch({ headless: true });
  const results: MonitorRun["viewports"] = [];
  try {
    for (const viewport of input.viewports) {
      const preset = viewportPresets[viewport];
      const context = await browser.newContext({ viewport: { width: preset.width, height: preset.height }, isMobile: preset.isMobile, deviceScaleFactor: viewport === "desktop" ? 1 : 2 });
      const page = await context.newPage();
      if (!input.allowPrivateNetwork) await installSsrfRouteGuard(page, false);
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const failedRequests: Array<{ url: string; method: string; failure: string }> = [];
      const brokenAssets: Array<{ url: string; resourceType: string; status?: number; failure?: string }> = [];
      const slowRequests: Array<{ url: string; method: string; durationMs: number; status?: number }> = [];
      const starts = new Map<string, number>();
      page.on("console", (message) => {
        if (message.type() === "error" && consoleErrors.length < input.maxEvents) consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => {
        if (pageErrors.length < input.maxEvents) pageErrors.push(error.message);
      });
      page.on("request", (request) => starts.set(`${request.method()} ${request.url()}`, Date.now()));
      page.on("requestfailed", (request) => {
        if (failedRequests.length < input.maxEvents) failedRequests.push({ url: request.url(), method: request.method(), failure: request.failure()?.errorText ?? "request failed" });
        if (["image", "stylesheet", "script", "font"].includes(request.resourceType()) && brokenAssets.length < input.maxEvents) {
          brokenAssets.push({ url: request.url(), resourceType: request.resourceType(), failure: request.failure()?.errorText ?? "request failed" });
        }
      });
      page.on("response", (response) => {
        const request = response.request();
        const started = starts.get(`${request.method()} ${request.url()}`);
        const durationMs = started ? Date.now() - started : 0;
        const status = response.status();
        if (durationMs >= input.slowRequestMs && slowRequests.length < input.maxEvents) slowRequests.push({ url: response.url(), method: request.method(), durationMs, status });
        if (status >= 400 && ["image", "stylesheet", "script", "font"].includes(request.resourceType()) && brokenAssets.length < input.maxEvents) {
          brokenAssets.push({ url: response.url(), resourceType: request.resourceType(), status });
        }
      });
      await page.goto(url, { waitUntil: "networkidle", timeout: input.timeoutMs });
      const loadMs = await page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        return nav ? Math.round(nav.loadEventEnd || nav.domContentLoadedEventEnd || nav.duration) : 0;
      });
      results.push({
        viewport,
        finalUrl: page.url(),
        title: await page.title(),
        loadMs,
        consoleErrors,
        pageErrors,
        failedRequests,
        brokenAssets,
        slowRequests
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return results;
}

function issuesFor(run: Omit<MonitorRun, "issues" | "ok" | "score">, slowLoadMs: number): MonitorIssue[] {
  const issues: MonitorIssue[] = [];
  if (!run.uptime.ok) issues.push({ category: "uptime", severity: "high", message: run.uptime.error ?? `HTTP status ${run.uptime.status}`, url: run.url });
  for (const viewport of run.viewports) {
    if (viewport.loadMs >= slowLoadMs) issues.push({ category: "performance", severity: "medium", message: `Slow page load: ${viewport.loadMs}ms.`, url: viewport.finalUrl, viewport: viewport.viewport });
    for (const error of viewport.pageErrors) issues.push({ category: "runtime", severity: "high", message: error, url: viewport.finalUrl, viewport: viewport.viewport });
    for (const error of viewport.consoleErrors) issues.push({ category: "console", severity: "medium", message: error, url: viewport.finalUrl, viewport: viewport.viewport });
    for (const request of viewport.failedRequests) issues.push({ category: "network", severity: "high", message: `${request.method} failed: ${request.failure}`, url: request.url, viewport: viewport.viewport });
    for (const asset of viewport.brokenAssets) issues.push({ category: "asset", severity: "high", message: `${asset.resourceType} failed${asset.status ? ` with ${asset.status}` : ""}${asset.failure ? `: ${asset.failure}` : ""}`, url: asset.url, viewport: viewport.viewport });
    for (const request of viewport.slowRequests) issues.push({ category: "performance", severity: "low", message: `Slow request ${request.durationMs}ms${request.status ? ` status ${request.status}` : ""}.`, url: request.url, viewport: viewport.viewport });
  }
  return issues.slice(0, 200);
}

function scoreFor(issues: MonitorIssue[]) {
  const penalty = issues.reduce((total, issue) => total + (issue.severity === "high" ? 30 : issue.severity === "medium" ? 15 : 5), 0);
  return Math.max(0, 100 - penalty);
}

function renderMarkdown(run: MonitorRun, history: MonitorRun[]) {
  const rows = run.issues.length
    ? run.issues.map((issue) => `| ${issue.severity} | ${issue.category} | ${escapeMarkdown(issue.message)} | ${issue.viewport ?? "-"} | ${issue.url ? escapeMarkdown(issue.url) : "-"} |`).join("\n")
    : "| low | none | No monitoring issues detected. | - | - |";
  const recent = history.slice(-10).reverse().map((item) => `| ${item.checkedAt} | ${item.ok ? "pass" : "fail"} | ${item.score} | ${item.issues.length} | ${escapeMarkdown(item.url)} |`).join("\n");
  return `# Published Demo Health Report

Checked: ${run.checkedAt}

## Summary

- URL: ${run.url}
- Status: ${run.ok ? "pass" : "fail"}
- Score: ${run.score}
- HTTP status: ${run.uptime.status ?? run.uptime.error ?? "unknown"}
- Issues: ${run.issues.length}

## Current Issues

| Severity | Category | Message | Viewport | URL |
| --- | --- | --- | --- | --- |
${rows}

## Viewport Results

${run.viewports.map((viewport) => `- ${viewport.viewport}: load ${viewport.loadMs}ms, console errors ${viewport.consoleErrors.length}, page errors ${viewport.pageErrors.length}, failed requests ${viewport.failedRequests.length}, broken assets ${viewport.brokenAssets.length}`).join("\n")}

## Recent Deploy Health

| Checked At | Status | Score | Issues | URL |
| --- | --- | --- | --- | --- |
${recent || `| ${run.checkedAt} | ${run.ok ? "pass" : "fail"} | ${run.score} | ${run.issues.length} | ${escapeMarkdown(run.url)} |`}
`;
}

export const demoMonitoringTools: ToolModule[] = [
  {
    definition: {
      name: "monitor_published_demo_health",
      description: "Run production-style monitoring checks for a published demo: HTTP health, runtime/page errors, console errors, failed requests, broken assets, slow loads, slow requests, and deploy health history.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          url: { type: "string", format: "uri" },
          viewports: { type: "array", items: { type: "string", enum: ["desktop", "mobile"] } },
          timeoutMs: { type: "number" },
          slowLoadMs: { type: "number" },
          slowRequestMs: { type: "number" },
          maxEvents: { type: "number" },
          allowPrivateNetwork: { type: "boolean" },
          outputDir: { type: "string" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: monitorPublishedDemoHealthSchema,
    handler: async (input, ctx) => {
      const parsed = monitorPublishedDemoHealthSchema.parse(input);
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const url = parsed.url ?? manifest.publishedUrl;
      if (!url) throw new Error("Project has no publishedUrl. Provide url or publish the project first.");
      if (!parsed.allowPrivateNetwork) await assertSafePublicUrl(url, { protocols: ["http:", "https:"] });
      const checkedAt = new Date().toISOString();
      const uptime = await uptimeCheck(url, parsed.timeoutMs);
      const viewports = await browserMonitor(url, parsed);
      const partial = { id: `monitor_${checkedAt.replace(/[^0-9]/g, "").slice(0, 14)}`, checkedAt, url, uptime, viewports };
      const issues = issuesFor(partial, parsed.slowLoadMs);
      const run: MonitorRun = { ...partial, issues, ok: issues.every((issue) => issue.severity !== "high" && issue.category !== "console"), score: scoreFor(issues) };
      const historyPath = outputPath(parsed.outputDir, "deploy-health-history.json");
      const reportJsonPath = outputPath(parsed.outputDir, "latest-health-report.json");
      const reportMarkdownPath = outputPath(parsed.outputDir, "latest-health-report.md");
      const existingHistory = await readProjectFile(ctx.projectRoot, parsed.projectId, historyPath).then((raw) => JSON.parse(raw) as MonitorRun[]).catch(() => []);
      const history = [...(Array.isArray(existingHistory) ? existingHistory : []), run].slice(-50);
      const markdown = renderMarkdown(run, history);
      await writeProjectFile(ctx.projectRoot, parsed.projectId, historyPath, `${JSON.stringify(history, null, 2)}\n`);
      await writeProjectFile(ctx.projectRoot, parsed.projectId, reportJsonPath, `${JSON.stringify(run, null, 2)}\n`);
      await writeProjectFile(ctx.projectRoot, parsed.projectId, reportMarkdownPath, markdown);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, {
        toolName: "monitor_published_demo_health",
        ok: run.ok,
        summary: run.ok ? `Published demo health check passed for ${url}.` : `Published demo health check found ${issues.length} issue(s).`,
        details: { reportJsonPath, reportMarkdownPath, historyPath, score: run.score, issueCount: issues.length }
      });
      return {
        ok: run.ok,
        summary: run.ok ? `Published demo health check passed with score ${run.score}.` : `Published demo health check found ${issues.length} issue(s), score ${run.score}.`,
        jobId: parsed.projectId,
        previewUrl: url,
        shareUrl: url,
        artifacts: [historyPath, reportJsonPath, reportMarkdownPath],
        structuredContent: { ...run, historyPath, reportJsonPath, reportMarkdownPath },
        logs: [JSON.stringify(run, null, 2), markdown],
        errors: issues.filter((issue) => issue.severity === "high" || issue.category === "console").map((issue) => issue.message)
      };
    }
  }
];
