import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafePublicUrl, safeFetch } from "../security/url.js";
import { installSsrfRouteGuard } from "../security/playwright-guard.js";
import { bindAbort, signalWithTimeout, throwIfAborted } from "../shared/abort.js";

export type WebCaptureMode = "single_page" | "same_origin_depth_1";
export type CaptureViewport = "desktop" | "tablet" | "mobile";

export type WebCaptureOptions = {
  url: string;
  mode: WebCaptureMode;
  viewports: CaptureViewport[];
  maxPages: number;
  timeoutMs: number;
  respectRobotsTxt: boolean;
  includeScreenshots: boolean;
  includeNetwork: boolean;
};

export type CapturedResource = {
  url: string;
  type: string;
  status?: number;
  method?: string;
  durationMs?: number;
  failed?: boolean;
  failureText?: string;
};

export type CapturedLink = {
  text: string;
  href: string;
  sameOrigin: boolean;
};

export type CapturedImage = {
  src: string;
  alt: string;
  width?: number;
  height?: number;
};

export type CapturedForm = {
  action: string;
  method: string;
  labels: string[];
  fields: Array<{ name: string; type: string; placeholder: string; required: boolean }>;
};

export type CapturedInteraction = {
  type: "button" | "link";
  text: string;
  selector: string;
  href?: string;
};

export type CapturedPage = {
  url: string;
  finalUrl: string;
  viewport: CaptureViewport;
  title: string;
  canonicalUrl?: string;
  metaDescription?: string;
  headings: Array<{ level: number; text: string }>;
  visibleText: string;
  links: CapturedLink[];
  images: CapturedImage[];
  scripts: string[];
  stylesheets: string[];
  forms: CapturedForm[];
  interactions: CapturedInteraction[];
  consoleErrors: string[];
  pageErrors: string[];
  resources: CapturedResource[];
  screenshotDataUrl?: string;
};

export type WebpageCapture = {
  captureId: string;
  sourceUrl: string;
  finalUrl: string;
  mode: WebCaptureMode;
  capturedAt: string;
  pages: CapturedPage[];
  resources: CapturedResource[];
  forms: CapturedForm[];
  interactions: CapturedInteraction[];
  issues: string[];
  warnings: string[];
};

const viewportPresets: Record<CaptureViewport, { width: number; height: number; isMobile: boolean }> = {
  desktop: { width: 1440, height: 900, isMobile: false },
  tablet: { width: 834, height: 1112, isMobile: true },
  mobile: { width: 390, height: 844, isMobile: true }
};

const maxResourceRecords = 120;
const maxVisibleTextChars = 200 * 1024;

type DomSnapshot = Omit<CapturedPage, "url" | "finalUrl" | "viewport" | "consoleErrors" | "pageErrors" | "resources" | "screenshotDataUrl">;

function uniqueBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function capturePath(captureRoot: string, captureId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(captureId)) throw new Error("Invalid captureId.");
  return path.join(captureRoot, `${captureId}.json`);
}

export function getCaptureRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".captures");
}

export async function saveWebpageCapture(captureRoot: string, capture: WebpageCapture): Promise<void> {
  await mkdir(captureRoot, { recursive: true });
  await writeFile(capturePath(captureRoot, capture.captureId), `${JSON.stringify(capture, null, 2)}\n`, "utf8");
}

export async function readWebpageCapture(captureRoot: string, captureId: string): Promise<WebpageCapture> {
  try {
    return JSON.parse(await readFile(capturePath(captureRoot, captureId), "utf8")) as WebpageCapture;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Capture not found: ${captureId}`);
    }
    throw error;
  }
}

async function readRobotsTxt(origin: string, timeoutMs: number, signal?: AbortSignal): Promise<{ warnings: string[]; disallowRules: string[] }> {
  try {
    const response = await safeFetch(new URL("/robots.txt", origin), { signal: signalWithTimeout(signal, Math.min(timeoutMs, 10000)) });
    if (response.status === 404) return { warnings: ["robots.txt was not found."], disallowRules: [] };
    if (!response.ok) return { warnings: [`robots.txt returned ${response.status}.`], disallowRules: [] };
    const text = await response.text();
    const disallowRules: string[] = [];
    let appliesToAnyAgent = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*/, "").trim();
      const [rawKey, ...rawValue] = line.split(":");
      const key = rawKey?.trim().toLowerCase();
      const value = rawValue.join(":").trim();
      if (key === "user-agent") appliesToAnyAgent = value === "*";
      if (appliesToAnyAgent && key === "disallow" && value) disallowRules.push(value);
    }
    return { warnings: [], disallowRules };
  } catch (error) {
    throwIfAborted(signal);
    const message = error instanceof Error ? error.message : "Unable to read robots.txt.";
    return { warnings: [`Unable to confirm robots.txt: ${message}`], disallowRules: [] };
  }
}

function isRobotsDisallowed(url: URL, rules: string[]): boolean {
  return rules.some((rule) => rule !== "/" && url.pathname.startsWith(rule)) || rules.includes("/");
}

async function collectPage(targetUrl: URL, viewport: CaptureViewport, options: WebCaptureOptions, signal?: AbortSignal): Promise<CapturedPage> {
  throwIfAborted(signal);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const unbindAbort = bindAbort(signal, () => browser.close());
  const preset = viewportPresets[viewport];
  const resourceStarts = new Map<string, number>();
  const resources: CapturedResource[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  try {
    const context = await browser.newContext({
      viewport: { width: preset.width, height: preset.height },
      isMobile: preset.isMobile,
      deviceScaleFactor: viewport === "desktop" ? 1 : 2
    });
    const page = await context.newPage();
    await installSsrfRouteGuard(page, false);

    if (options.includeNetwork) {
      page.on("request", (request) => resourceStarts.set(`${request.method()} ${request.url()}`, Date.now()));
      page.on("requestfinished", async (request) => {
        if (resources.length >= maxResourceRecords) return;
        const response = await request.response();
        const key = `${request.method()} ${request.url()}`;
        const started = resourceStarts.get(key);
        resources.push({
          url: request.url(),
          type: request.resourceType(),
          method: request.method(),
          status: response?.status(),
          durationMs: started ? Date.now() - started : undefined
        });
      });
      page.on("requestfailed", (request) => {
        if (resources.length >= maxResourceRecords) return;
        const key = `${request.method()} ${request.url()}`;
        const started = resourceStarts.get(key);
        resources.push({
          url: request.url(),
          type: request.resourceType(),
          method: request.method(),
          durationMs: started ? Date.now() - started : undefined,
          failed: true,
          failureText: request.failure()?.errorText
        });
      });
    }

    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(targetUrl.toString(), { waitUntil: "networkidle", timeout: options.timeoutMs });
    const finalUrl = page.url();
    const snapshot = await page.evaluate((maxText) => {
      const textOf = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
      const absolute = (value: string | null): string => {
        if (!value) return "";
        try {
          return new URL(value, document.baseURI).toString();
        } catch {
          return value;
        }
      };
      const selectorFor = (element: Element): string => {
        if (element.id) return `${element.tagName.toLowerCase()}#${element.id}`;
        const className = typeof element.className === "string" ? element.className : "";
        const firstClass = className.trim().split(/\s+/).find(Boolean);
        return firstClass ? `${element.tagName.toLowerCase()}.${firstClass}` : element.tagName.toLowerCase();
      };
      const currentOrigin = location.origin;
      const headings = Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 40).map((element) => ({
        level: Number(element.tagName.slice(1)),
        text: textOf(element.textContent).slice(0, 180)
      })).filter((item) => item.text);
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).slice(0, 120).map((element) => {
        const href = absolute(element.getAttribute("href"));
        return { text: textOf(element.textContent).slice(0, 140), href, sameOrigin: href.startsWith(currentOrigin) };
      }).filter((item) => item.href);
      const images = Array.from(document.querySelectorAll<HTMLImageElement>("img[src]")).slice(0, 80).map((element) => ({
        src: absolute(element.getAttribute("src")),
        alt: element.alt,
        width: element.naturalWidth || element.width || undefined,
        height: element.naturalHeight || element.height || undefined
      }));
      const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]")).slice(0, 80).map((element) => absolute(element.getAttribute("src"))).filter(Boolean);
      const stylesheets = Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet'][href]")).slice(0, 80).map((element) => absolute(element.getAttribute("href"))).filter(Boolean);
      const forms = Array.from(document.querySelectorAll<HTMLFormElement>("form")).slice(0, 20).map((form) => ({
        action: absolute(form.getAttribute("action")),
        method: (form.getAttribute("method") || "get").toUpperCase(),
        labels: Array.from(form.querySelectorAll("label")).map((label) => textOf(label.textContent).slice(0, 100)).filter(Boolean),
        fields: Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")).slice(0, 40).map((field) => ({
          name: field.getAttribute("name") || field.id || "",
          type: field.getAttribute("type") || field.tagName.toLowerCase(),
          placeholder: field.getAttribute("placeholder") || "",
          required: field.hasAttribute("required")
        }))
      }));
      const interactions = [
        ...Array.from(document.querySelectorAll<HTMLButtonElement>("button")).slice(0, 60).map((element) => ({
          type: "button" as const,
          text: textOf(element.textContent).slice(0, 120),
          selector: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`,
          href: undefined
        })),
        ...Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).slice(0, 60).map((element) => ({
          type: "link" as const,
          text: textOf(element.textContent).slice(0, 120),
          selector: selectorFor(element),
          href: absolute(element.getAttribute("href"))
        }))
      ].filter((item) => item.text || item.href);
      return {
        title: document.title,
        canonicalUrl: absolute(document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.getAttribute("href") ?? null) || undefined,
        metaDescription: document.querySelector<HTMLMetaElement>("meta[name='description']")?.content,
        headings,
        visibleText: textOf(document.body?.innerText).slice(0, maxText),
        links,
        images,
        scripts,
        stylesheets,
        forms,
        interactions
      };
    }, maxVisibleTextChars) as DomSnapshot;

    let screenshotDataUrl: string | undefined;
    if (options.includeScreenshots) {
      const screenshot = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
      screenshotDataUrl = `data:image/jpeg;base64,${screenshot.toString("base64")}`;
    }

    await context.close();
    return {
      url: targetUrl.toString(),
      finalUrl,
      viewport,
      ...snapshot,
      consoleErrors: consoleErrors.slice(0, 30),
      pageErrors: pageErrors.slice(0, 30),
      resources: resources.slice(0, maxResourceRecords),
      screenshotDataUrl
    };
  } finally {
    unbindAbort();
    await browser.close().catch(() => undefined);
  }
}

export async function captureWebpage(options: WebCaptureOptions, signal?: AbortSignal): Promise<WebpageCapture> {
  throwIfAborted(signal);
  const source = await assertSafePublicUrl(options.url);
  const warnings: string[] = [];
  const issues: string[] = [];
  let disallowRules: string[] = [];

  if (options.respectRobotsTxt) {
    const robots = await readRobotsTxt(source.origin, options.timeoutMs, signal);
    warnings.push(...robots.warnings);
    disallowRules = robots.disallowRules;
    if (isRobotsDisallowed(source, disallowRules)) {
      throw new Error(`robots.txt disallows capture for ${source.pathname}.`);
    }
  }

  const targetUrls = [source];
  const firstPage = await collectPage(source, options.viewports[0], options, signal);
  if (options.mode === "same_origin_depth_1") {
    for (const link of firstPage.links) {
      throwIfAborted(signal);
      if (targetUrls.length >= options.maxPages) break;
      if (!link.sameOrigin) continue;
      const candidate = await assertSafePublicUrl(link.href);
      candidate.hash = "";
      if (options.respectRobotsTxt && isRobotsDisallowed(candidate, disallowRules)) {
        warnings.push(`Skipped ${candidate.toString()} because robots.txt disallows it.`);
        continue;
      }
      if (!targetUrls.some((url) => url.toString() === candidate.toString())) targetUrls.push(candidate);
    }
  }

  const pages: CapturedPage[] = [firstPage];
  for (const targetUrl of targetUrls) {
    for (const viewport of options.viewports) {
      throwIfAborted(signal);
      if (targetUrl.toString() === source.toString() && viewport === options.viewports[0]) continue;
      pages.push(await collectPage(targetUrl, viewport, options, signal));
    }
  }

  for (const page of pages) {
    if (!page.title.trim()) issues.push(`${page.finalUrl} has no document title.`);
    if (!page.headings.some((heading) => heading.level === 1)) issues.push(`${page.finalUrl} has no H1 heading.`);
    for (const error of page.consoleErrors) issues.push(`${page.finalUrl} console error: ${error}`);
    for (const error of page.pageErrors) issues.push(`${page.finalUrl} page error: ${error}`);
    for (const resource of page.resources.filter((item) => item.failed || (item.status && item.status >= 400))) {
      issues.push(`${page.finalUrl} resource issue: ${resource.status ?? "failed"} ${resource.url}`);
    }
  }

  return {
    captureId: randomUUID(),
    sourceUrl: source.toString(),
    finalUrl: pages[0]?.finalUrl ?? source.toString(),
    mode: options.mode,
    capturedAt: new Date().toISOString(),
    pages,
    resources: uniqueBy(pages.flatMap((page) => page.resources), (resource) => `${resource.method ?? ""} ${resource.url}`).slice(0, maxResourceRecords),
    forms: pages.flatMap((page) => page.forms).slice(0, 60),
    interactions: pages.flatMap((page) => page.interactions).slice(0, 120),
    issues: uniqueBy(issues, (issue) => issue).slice(0, 120),
    warnings: uniqueBy(warnings, (warning) => warning).slice(0, 60)
  };
}
