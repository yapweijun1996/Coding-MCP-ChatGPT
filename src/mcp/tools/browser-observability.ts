import { createArtifact, makeArtifactUrl } from "../../artifacts/store.js";
import { createShareArtifact } from "../../share/store.js";
import { makeShareUrl } from "../result.js";
import { z } from "zod";
import type { Browser, Page, Request, Response } from "playwright";
import type { ToolModule } from "../types.js";
import { getSessionOrThrow, type BrowserSession } from "./browser.js";
import {
  sanitizeSecretLikeValue,
  trimLogLines,
  trimStructuredContent,
  safeArtifactSuffix
} from "./agent-tool-utils.js";

type ToolContext = {
  publicBaseUrl: string;
  shareRoot: string;
  artifactRoot: string;
};

type TempSession = {
  session: BrowserSession;
  close: () => Promise<void>;
};

type ViewportName = "desktop" | "tablet" | "mobile";
type ViewportConfig = { width: number; height: number; isMobile: boolean };

type DomSnapshotResult = {
  sessionId: string;
  title: string;
  url: string;
  viewport: { width: number; height: number };
  textSummary: string;
  interactiveElements: Array<{ selector: string; tag: string; text: string; type?: string }>;
  links: Array<{ href: string; text: string; selector: string }>;
  forms: Array<{ id?: string; action?: string; method?: string; fieldCount: number; fields: string[] }>;
  headings: Array<{ level: string; text: string }>;
  landmarks: string[];
};

type FlowStepResult = {
  action: string;
  ok: boolean;
  startAt: string;
  endAt: string;
  logs: string[];
  error?: string;
  errorStack?: string;
  snapshot?: string;
};

type SmokeStep =
  | { action: "click"; selector: string; timeoutMs?: number }
  | { action: "fill"; selector: string; value: string; timeoutMs?: number }
  | { action: "assert"; text: string; timeoutMs?: number }
  | { action: "screenshot"; label?: string }
  | { action: "waitForUrl"; url: string; timeoutMs?: number }
  | { action: "waitForSelector"; selector: string; timeoutMs?: number };

type AxeImpact = "minor" | "moderate" | "serious" | "critical";
type AxeViolation = {
  id?: string;
  impact?: string;
  description?: string;
  help?: string;
  helpUrl?: string;
  nodes?: unknown[];
};

const VIEWPORTS: Record<ViewportName, ViewportConfig> = {
  desktop: { width: 1440, height: 900, isMobile: false },
  tablet: { width: 820, height: 1180, isMobile: true },
  mobile: { width: 390, height: 844, isMobile: true }
};

function isAxeImpact(value: string): value is AxeImpact {
  return value === "minor" || value === "moderate" || value === "serious" || value === "critical";
}

const browserDomSnapshotSchema = z.object({
  sessionId: z.string().min(1).optional(),
  url: z.string().url().optional(),
  maxTextLength: z.number().int().min(160).max(8000).optional().default(2400),
  collectFormDetails: z.boolean().optional().default(false),
  collectHeadings: z.boolean().optional().default(true),
  includeScreenshot: z.boolean().optional().default(false)
}).refine((value) => Boolean(value.sessionId || value.url), {
  message: "Either sessionId or url is required.",
  path: ["sessionId"]
});

const browserNetworkTraceSchema = z.object({
  sessionId: z.string().min(1),
  captureTimeMs: z.number().int().min(300).max(180000).optional().default(5000),
  slowThresholdMs: z.number().int().min(100).max(30000).optional().default(2000),
  includeStatusGroups: z.boolean().optional().default(true)
});

const browserConsoleLogSchema = z.object({
  sessionId: z.string().min(1),
  includeInfo: z.boolean().optional().default(true),
  includeWarnings: z.boolean().optional().default(true),
  includeErrors: z.boolean().optional().default(true),
  maxEntries: z.number().int().min(20).max(500).optional().default(200)
});

const browserStorageSnapshotSchema = z.object({
  sessionId: z.string().min(1),
  captureCookies: z.boolean().optional().default(true),
  captureStorage: z.boolean().optional().default(true),
  cookieKeysToMask: z.array(z.string().min(1).max(120)).optional().default(["cookie", "token", "session", "auth", "secret"]),
  storageKeysToMask: z.array(z.string().min(1).max(120)).optional().default(["cookie", "token", "session", "secret", "password", "api_key"])
});

const a11yAuditSchema = z.object({
  sessionId: z.string().min(1).optional(),
  url: z.string().url().optional(),
  rules: z.array(z.string().min(1).max(120)).max(80).optional().default([]),
  impact: z.array(z.enum(["minor", "moderate", "serious", "critical"])).optional().default([]),
  maxViolations: z.number().int().min(1).max(300).optional().default(120)
}).refine((value) => Boolean(value.sessionId || value.url), {
  message: "Either sessionId or url is required.",
  path: ["sessionId"]
});

const visualRegressionSchema = z.object({
  sessionId: z.string().min(1).optional(),
  url: z.string().url().optional(),
  viewports: z.array(z.enum(["desktop", "tablet", "mobile"])).min(1).max(3).optional().default(["desktop", "tablet", "mobile"]),
  fullPage: z.boolean().optional().default(true),
  filenamePrefix: z.string().min(1).max(80).optional().default("visual"),
  timeoutMs: z.number().int().min(500).max(120000).optional().default(30000)
}).refine((value) => Boolean(value.sessionId || value.url), {
  message: "Either sessionId or url is required.",
  path: ["sessionId"]
});

const runSmokeFlowSchema = z.object({
  sessionId: z.string().min(1).optional(),
  url: z.string().url().optional(),
  steps: z.array(
    z.discriminatedUnion("action", [
      z.object({ action: z.literal("click"), selector: z.string().min(1).max(500), timeoutMs: z.number().int().min(200).max(120000).optional() }),
      z.object({ action: z.literal("fill"), selector: z.string().min(1).max(500), value: z.string().max(8000), timeoutMs: z.number().int().min(200).max(120000).optional() }),
      z.object({ action: z.literal("assert"), text: z.string().min(1).max(1000), timeoutMs: z.number().int().min(200).max(120000).optional() }),
      z.object({ action: z.literal("screenshot"), label: z.string().min(1).max(120).optional() }),
      z.object({ action: z.literal("waitForUrl"), url: z.string().min(1).max(2048), timeoutMs: z.number().int().min(200).max(120000).optional() }),
      z.object({ action: z.literal("waitForSelector"), selector: z.string().min(1).max(500), timeoutMs: z.number().int().min(200).max(120000).optional() })
    ])
  ).min(1).max(30),
  timeoutMs: z.number().int().min(500).max(120000).optional().default(30000),
  stopOnFailure: z.boolean().optional().default(true)
}).refine((value) => Boolean(value.sessionId || value.url), {
  message: "Either sessionId or url is required.",
  path: ["sessionId"]
});

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function wrapHtml(title: string, body: string): string {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body { margin: 0; padding: 16px; font-family: ui-sans-serif, system-ui, sans-serif; color: #1a2028; background: #f7faf5; }
    .panel { margin: 12px 0; border: 1px solid #d8dfd7; background: #fff; border-radius: 8px; padding: 12px; }
    pre { white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <h2>${safeTitle}</h2>
  <div class="panel">${body}</div>
</body>
</html>`;
}

function tableFromRows(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "<p>no data</p>";
  const keys = [...new Set(rows.flatMap((entry) => Object.keys(entry)))];
  const head = `<tr>${keys.map((entry) => `<th>${escapeHtml(entry)}</th>`).join("")}</tr>`;
  const body = rows
    .map((entry) => `<tr>${keys.map((key) => `<td>${escapeHtml(String(entry[key] ?? ""))}</td>`).join("")}</tr>`)
    .join("");
  return `<table>${head}${body}</table>`;
}

function safeArtifactFilename(prefix: string, suffix: string, ext: string): string {
  return safeArtifactSuffix(`${prefix}-${suffix}`, ext);
}

async function makeImageArtifact(ctx: ToolContext, filename: string, image: Buffer): Promise<string> {
  const artifact = await createArtifact({
    artifactRoot: ctx.artifactRoot,
    filename,
    contentType: "image/png",
    content: image
  });
  return makeArtifactUrl(ctx.publicBaseUrl, artifact.id, artifact.filename);
}

async function makeShareArtifact(ctx: ToolContext, filename: string, title: string, body: string): Promise<string> {
  const share = await createShareArtifact({
    shareRoot: ctx.shareRoot,
    title,
    summary: title,
    filename,
    html: wrapHtml(title, body)
  });
  return makeShareUrl(ctx.publicBaseUrl, share.id, share.filename);
}

async function openTemporarySession(url: string, timeoutMs: number): Promise<TempSession> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const session: BrowserSession = {
    id: `tmp-${Math.random().toString(16).slice(2, 10)}`,
    browser: browser as Browser,
    page,
    step: 0,
    startedAt: new Date().toISOString(),
    createdBy: "agent",
    consoleEvents: [],
    pageErrors: []
  };

  page.on("console", (message) => {
    const location = message.location();
    session.consoleEvents.push({
      level: message.type(),
      text: message.text(),
      url: location.url,
      line: location.lineNumber,
      column: location.columnNumber
    });
  });
  page.on("pageerror", (error) => {
    session.pageErrors.push({ message: error.message, stack: error.stack });
  });

  await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
  return {
    session,
    close: async () => {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  };
}

async function resolveSession(sessionId: string | undefined, url: string | undefined): Promise<TempSession> {
  if (sessionId) {
    return { session: getSessionOrThrow(sessionId), close: async () => {} };
  }
  if (!url) {
    throw new Error("Either sessionId or url is required.");
  }
  return openTemporarySession(url, 30000);
}

async function collectDomSnapshot(page: Page, maxTextLength: number, collectHeadings: boolean): Promise<Omit<DomSnapshotResult, "sessionId">> {
  const data = await page.evaluate(
    ({ maxTextLength, collectHeadings }) => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const textSummary = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, maxTextLength);
      const interactiveElements = Array.from(document.querySelectorAll("a,button,input,select,textarea,[role='button'],[onclick]"))
        .slice(0, 140)
        .map((element, index) => {
          const tag = element.tagName.toLowerCase();
          const text = (element.textContent || "").trim().slice(0, 160);
          const id = element.getAttribute("id");
          const name = element.getAttribute("name");
          const selector = id ? `${tag}#${id}` : name ? `${tag}[name="${name}"]` : `${tag}:nth-of-type(${index + 1})`;
          return { selector, tag, text, type: element.getAttribute("type") || undefined };
        });
      const links = Array.from(document.querySelectorAll("a[href]")).slice(0, 120).map((anchor, index) => ({
        href: new URL(anchor.getAttribute("href") || "", window.location.href).toString(),
        text: (anchor.textContent || "").trim().slice(0, 160),
        selector: `a:nth-of-type(${index + 1})`
      }));
      const headings = collectHeadings
        ? Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((heading) => ({
          level: heading.tagName.toLowerCase(),
          text: (heading.textContent || "").trim().slice(0, 180)
        }))
        : [];
      const landmarks = Array.from(document.querySelectorAll("header,nav,main,footer,aside,section,article"))
        .map((node) => node.tagName.toLowerCase());
      return {
        title: document.title || "",
        url: window.location.href,
        viewport,
        textSummary,
        interactiveElements,
        links,
        headings,
        forms: Array.from(document.forms).map((form) => {
          const fields = Array.from(form.elements).map((input) => {
            const element = input as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
            return `${element.tagName.toLowerCase()}:${element.getAttribute("name") || element.id || "field"}`;
          });
          return {
            id: form.getAttribute("id") || undefined,
            action: form.getAttribute("action") || undefined,
            method: (form.getAttribute("method") || "get").toUpperCase(),
            fieldCount: fields.length,
            fields
          };
        }),
        landmarks
      };
    },
    { maxTextLength, collectHeadings }
  );
  return {
    ...data,
    forms: (data as { collectFormDetails?: boolean; forms?: Array<{ id?: string; action?: string; method?: string; fieldCount: number; fields: string[] }> }).forms ?? [],
    title: typeof data.title === "string" ? data.title : "",
    textSummary: typeof data.textSummary === "string" ? data.textSummary : ""
  };
}

export const browserObservabilityTools: ToolModule[] = [
  {
    definition: {
      name: "browser_dom_snapshot",
      description: "Collect browser DOM title/url/text/interactable elements/forms/links/headings/landmarks and optional screenshot.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          url: { type: "string", format: "uri" },
          maxTextLength: { type: "number" },
          collectFormDetails: { type: "boolean" },
          collectHeadings: { type: "boolean" },
          includeScreenshot: { type: "boolean" }
        },
        required: [],
        additionalProperties: false
      }
    },
    enabledByDefault: false,
    schema: browserDomSnapshotSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof browserDomSnapshotSchema>;
      const { session, close } = await resolveSession(parsed.sessionId, parsed.url);
      try {
        const page = session.page;
        const snapshot = await collectDomSnapshot(page, parsed.maxTextLength, parsed.collectHeadings);
        const payload: DomSnapshotResult = {
          sessionId: session.id,
          title: snapshot.title,
          url: snapshot.url,
          viewport: snapshot.viewport,
          textSummary: snapshot.textSummary,
          interactiveElements: snapshot.interactiveElements,
          links: snapshot.links,
          forms: parsed.collectFormDetails ? snapshot.forms : snapshot.forms.map((form) => ({ ...form, fields: [] })),
          headings: snapshot.headings,
          landmarks: snapshot.landmarks
        };
        let screenshot: string | undefined;
        if (parsed.includeScreenshot) {
          const image = await page.screenshot({ type: "png", fullPage: true });
          screenshot = await makeImageArtifact(ctx, safeArtifactFilename(`dom-${session.id}`, "snapshot", "png"), image);
        }
        return {
          ok: true,
          summary: `browser_dom_snapshot collected ${payload.interactiveElements.length} interactive elements.`,
          jobId: session.id,
          artifacts: screenshot ? [screenshot] : [],
          logs: trimLogLines([`session=${session.id}`, `url=${payload.url}`, `links=${payload.links.length}`]),
          structuredContent: trimStructuredContent(sanitizeSecretLikeValue(payload) as Record<string, unknown>),
          errors: []
        };
      } finally {
        await close();
      }
    }
  },
  {
    definition: {
      name: "browser_network_trace",
      description: "Collect request/response signals, failures, slow requests, and status group distribution.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          captureTimeMs: { type: "number" },
          slowThresholdMs: { type: "number" },
          includeStatusGroups: { type: "boolean" }
        },
        required: ["sessionId"],
        additionalProperties: false
      }
    },
    enabledByDefault: false,
    schema: browserNetworkTraceSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof browserNetworkTraceSchema>;
      const { session, close } = await resolveSession(parsed.sessionId, undefined);
      const startAt = Date.now();
      const requestStart = new WeakMap<Request, number>();
      const failures: Array<Record<string, unknown>> = [];
      const responses: Array<Record<string, unknown>> = [];
      const assetFailures: Array<Record<string, unknown>> = [];
      const statusGroups: Record<string, number> = {};
      const onRequest = (request: Request) => requestStart.set(request, Date.now());
      const onResponse = (response: Response) => {
        const request = response.request();
        const elapsedMs = Date.now() - (requestStart.get(request) ?? Date.now());
        const status = response.status();
        const entry = {
          url: response.url(),
          method: request.method(),
          status,
          elapsedMs
        };
        responses.push(entry);
        if (parsed.includeStatusGroups) {
          const bucket = `${Math.floor(status / 100)}xx`;
          statusGroups[bucket] = (statusGroups[bucket] ?? 0) + 1;
        }
      };
      const onRequestFailed = (request: Request) => {
        const elapsedMs = Date.now() - (requestStart.get(request) ?? Date.now());
        const info = {
          url: request.url(),
          method: request.method(),
          failure: request.failure()?.errorText ?? "failed",
          elapsedMs
        };
        failures.push(info);
        if (/\.(png|jpg|jpeg|webp|gif|css|js|svg|woff2?)(\?|$)/i.test(request.url())) {
          assetFailures.push({ ...info, kind: "asset" });
        }
      };

      session.page.on("request", onRequest);
      session.page.on("response", onResponse);
      session.page.on("requestfailed", onRequestFailed);
      try {
        await session.page.waitForTimeout(parsed.captureTimeMs);
      } finally {
        session.page.off("request", onRequest);
        session.page.off("response", onResponse);
        session.page.off("requestfailed", onRequestFailed);
        await close();
      }

      const slow = responses.filter((entry) => Number(entry.elapsedMs) > parsed.slowThresholdMs).sort((left, right) => Number(right.elapsedMs) - Number(left.elapsedMs));
      const summary = {
        sessionId: session.id,
        startedAt: new Date(startAt).toISOString(),
        captureTimeMs: parsed.captureTimeMs,
        totalResponses: responses.length,
        failed: failures.length,
        slowCount: slow.length,
        statusGroups: parsed.includeStatusGroups ? Object.entries(statusGroups).map(([group, count]) => ({ group, count })) : [],
        slowRequests: slow.slice(0, 80),
        failedRequests: failures.slice(0, 80),
        assetFailures: assetFailures.slice(0, 80)
      };
      const body = `<h3>Trace summary</h3>${tableFromRows([
        { metric: "responses", value: responses.length },
        { metric: "failed", value: failures.length },
        { metric: "slow", value: slow.length }
      ])}<h3>Slow requests</h3><pre>${escapeHtml(JSON.stringify(slow.slice(0, 40), null, 2))}</pre><h3>Failed requests</h3><pre>${escapeHtml(JSON.stringify(failures.slice(0, 40), null, 2))}</pre>`;
      const artifactUrl = await makeShareArtifact(ctx, "network-trace-report.html", "browser_network_trace", body);

      return {
        ok: true,
        summary: `browser_network_trace captured ${responses.length} responses and ${failures.length} failures.`,
        jobId: session.id,
        artifacts: [artifactUrl],
        logs: trimLogLines([`session=${session.id}`, `responses=${responses.length}`, `failures=${failures.length}`, `slow=${slow.length}`]),
        structuredContent: trimStructuredContent(sanitizeSecretLikeValue(summary) as Record<string, unknown>),
        errors: []
      };
    }
  },
  {
    definition: {
      name: "browser_console_log",
      description: "Collect console/page logs with source location and truncation.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          includeInfo: { type: "boolean" },
          includeWarnings: { type: "boolean" },
          includeErrors: { type: "boolean" },
          maxEntries: { type: "number" }
        },
        required: ["sessionId"],
        additionalProperties: false
      }
    },
    enabledByDefault: false,
    schema: browserConsoleLogSchema,
    handler: async (input, _ctx) => {
      const parsed = input as z.infer<typeof browserConsoleLogSchema>;
      const session = getSessionOrThrow(parsed.sessionId);
      const entries: Array<Record<string, unknown>> = [];
      for (const event of session.consoleEvents) {
        const level = (event.level || "log").toLowerCase();
        if (level === "log" && !parsed.includeInfo) continue;
        if (level === "warning" && !parsed.includeWarnings) continue;
        if (level === "error" && !parsed.includeErrors) continue;
        entries.push({
          type: level,
          message: event.text,
          url: event.url,
          line: event.line,
          column: event.column
        });
      }
      if (parsed.includeErrors) {
        for (const error of session.pageErrors) {
          entries.push({
            type: "pageError",
            message: error.message,
            stack: error.stack
          });
        }
      }
      const tail = entries.slice(-parsed.maxEntries);
      return {
        ok: true,
        summary: `browser_console_log captured ${tail.length} entries.`,
        jobId: session.id,
        artifacts: [],
        logs: trimLogLines(tail.map((entry) => `${entry.type}: ${String(entry.message || "").slice(0, 180)}`)),
        structuredContent: trimStructuredContent(sanitizeSecretLikeValue({ sessionId: session.id, logs: tail }) as Record<string, unknown>),
        errors: []
      };
    }
  },
  {
    definition: {
      name: "browser_storage_snapshot",
      description: "Read localStorage/sessionStorage entries and cookie metadata with secret masking.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          captureCookies: { type: "boolean" },
          captureStorage: { type: "boolean" },
          cookieKeysToMask: { type: "array", items: { type: "string" } },
          storageKeysToMask: { type: "array", items: { type: "string" } }
        },
        required: ["sessionId"],
        additionalProperties: false
      }
    },
    enabledByDefault: false,
    schema: browserStorageSnapshotSchema,
    handler: async (input) => {
      const parsed = input as z.infer<typeof browserStorageSnapshotSchema>;
      const session = getSessionOrThrow(parsed.sessionId);
      const storage = parsed.captureStorage
        ? await session.page.evaluate((maskKeys) => {
          const collect = (store: Storage) => {
            const rows: Array<{ key: string; value: string }> = [];
            for (let i = 0; i < store.length; i += 1) {
              const key = store.key(i);
              if (!key) continue;
              const lowered = key.toLowerCase();
              rows.push({
                key,
                value: maskKeys.some((entry: string) => lowered.includes(entry)) ? "[REDACTED]" : (store.getItem(key) ?? "")
              });
            }
            return rows;
          };
          return {
            localStorage: collect(window.localStorage),
            sessionStorage: collect(window.sessionStorage)
          };
        }, parsed.storageKeysToMask.map((entry) => entry.toLowerCase()))
        : { localStorage: [], sessionStorage: [] };

      const cookies = parsed.captureCookies
        ? await session.page.context().cookies().then((items) => items.map((entry) => ({
          name: entry.name,
          domain: entry.domain,
          path: entry.path,
          secure: entry.secure,
          sameSite: entry.sameSite,
          httpOnly: entry.httpOnly,
          value: "[REDACTED]",
          expires: entry.expires
        })))
        : [];

      const payload = sanitizeSecretLikeValue({ sessionId: session.id, url: session.page.url(), storage, cookies }) as Record<string, unknown>;
      return {
        ok: true,
        summary: `browser_storage_snapshot captured local/session storage and ${cookies.length} cookie entries.`,
        jobId: session.id,
        artifacts: [],
        logs: trimLogLines([`storageKeys=${storage.localStorage.length + storage.sessionStorage.length}`, `cookies=${cookies.length}`]),
        structuredContent: trimStructuredContent(payload),
        errors: []
      };
    }
  },
  {
    definition: {
      name: "run_a11y_audit_detailed",
      description: "Run axe-core accessibility audit and return detailed violation list with basic remediation hints.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          url: { type: "string", format: "uri" },
          rules: { type: "array", items: { type: "string" } },
          impact: { type: "array", items: { type: "string", enum: ["minor", "moderate", "serious", "critical"] } },
          maxViolations: { type: "number" }
        },
        required: [],
        additionalProperties: false
      }
    },
    enabledByDefault: false,
    schema: a11yAuditSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof a11yAuditSchema>;
      const { session, close } = await resolveSession(parsed.sessionId, parsed.url);
      try {
        let AxeBuilder: unknown;
        try {
          const module = await import("@axe-core/playwright");
          AxeBuilder = (module as { AxeBuilder?: unknown; default?: { AxeBuilder?: unknown } }).AxeBuilder
            ?? (module as { AxeBuilder?: unknown; default?: { AxeBuilder?: unknown } }).default?.AxeBuilder;
        } catch (error) {
          return {
            ok: false,
            summary: "run_a11y_audit_detailed requires @axe-core/playwright but dependency is unavailable.",
            jobId: session.id,
            artifacts: [],
            logs: [error instanceof Error ? error.message : "Dependency load failed."],
            errors: ["Dependency not available: @axe-core/playwright."],
            structuredContent: trimStructuredContent({ sessionId: session.id, module: "missing" })
          };
        }
        if (typeof AxeBuilder !== "function") {
          return {
            ok: false,
            summary: "AxeBuilder resolution failed.",
            jobId: session.id,
            artifacts: [],
            logs: ["AxeBuilder is not callable."],
            errors: ["Invalid @axe-core/playwright export."],
            structuredContent: trimStructuredContent({ sessionId: session.id })
          };
        }

        const builder = new (AxeBuilder as any)({ page: session.page });
        const result = typeof builder.withRules === "function" && parsed.rules.length > 0
          ? await builder.withRules(parsed.rules).analyze()
          : await builder.analyze();
        const rawViolations = (Array.isArray((result as { violations?: unknown }).violations) ? (result as { violations: unknown[] }).violations : []) as AxeViolation[];
        const violations = rawViolations
          .filter((entry: AxeViolation) => {
            const impact = String(entry.impact ?? "");
            return parsed.impact.length === 0 || (isAxeImpact(impact) && parsed.impact.includes(impact));
          })
          .slice(0, parsed.maxViolations)
          .map((violation: AxeViolation) => {
            return {
              id: violation.id ?? "",
              impact: violation.impact ?? "unknown",
              description: violation.description ?? "",
              help: violation.help ?? "",
              helpUrl: violation.helpUrl ?? "",
              selectors: Array.isArray(violation.nodes)
                ? violation.nodes.slice(0, 5).map((node) => String((node as { target?: unknown[] }).target?.[0] ?? ""))
                : [],
              suggestions: (Array.isArray(violation.nodes) ? violation.nodes.slice(0, 3).map((node) => String((node as { failureSummary?: string }).failureSummary ?? "")) : []).filter(Boolean)
            };
          });
        const rows = violations.map((violation: {
          id: string;
          impact: string;
          description: string;
          helpUrl: string;
          suggestions: string[];
        }) => ({
          rule: violation.id,
          impact: violation.impact,
          description: violation.description,
          helpUrl: violation.helpUrl,
          suggestionCount: violation.suggestions.length
        }));
        const body = `<h3>Violations: ${violations.length}</h3>${tableFromRows(rows)}<h3>Suggestions</h3><pre>${escapeHtml(JSON.stringify(violations, null, 2))}</pre>`;
        const artifactUrl = await makeShareArtifact(ctx, "a11y-violations.html", "run_a11y_audit_detailed", body);

        return {
          ok: true,
          summary: violations.length > 0 ? `run_a11y_audit_detailed found ${violations.length} violation(s).` : "run_a11y_audit_detailed found no violations.",
          jobId: session.id,
          artifacts: [artifactUrl],
          logs: trimLogLines([`violations=${violations.length}`, `rules=${parsed.rules.length}`, `impactFilters=${parsed.impact.join(",") || "all"}`]),
          structuredContent: trimStructuredContent(sanitizeSecretLikeValue({
            sessionId: session.id,
            summary: {
              total: violations.length,
              rules: parsed.rules.length,
              impact: parsed.impact
            },
            violations
          }) as Record<string, unknown>),
          errors: []
        };
      } finally {
        await close();
      }
    }
  },
  {
    definition: {
      name: "run_visual_regression_snapshot",
      description: "Capture desktop/tablet/mobile screenshots without pass/fail judgement.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          url: { type: "string", format: "uri" },
          viewports: { type: "array", items: { type: "string", enum: ["desktop", "tablet", "mobile"] } },
          fullPage: { type: "boolean" },
          filenamePrefix: { type: "string" },
          timeoutMs: { type: "number" }
        },
        required: [],
        additionalProperties: false
      }
    },
    enabledByDefault: false,
    schema: visualRegressionSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof visualRegressionSchema>;
      const { session, close } = await resolveSession(parsed.sessionId, parsed.url);
      const shots: string[] = [];
      const records: Array<{ viewport: ViewportName; width: number; height: number; artifactUrl: string }> = [];
      const baseline = session.page.viewportSize() ?? VIEWPORTS.desktop;
      try {
        for (const viewport of [...new Set(parsed.viewports)]) {
          const config = VIEWPORTS[viewport];
          await session.page.setViewportSize({ width: config.width, height: config.height });
          await session.page.goto(session.page.url(), { waitUntil: "networkidle", timeout: parsed.timeoutMs }).catch(() => undefined);
          const image = await session.page.screenshot({ type: "png", fullPage: parsed.fullPage });
          const artifactUrl = await makeImageArtifact(ctx, safeArtifactFilename(`${parsed.filenamePrefix}-${viewport}`, session.id, "png"), image);
          shots.push(artifactUrl);
          records.push({ viewport, width: config.width, height: config.height, artifactUrl });
        }
        if (baseline.width > 0 && baseline.height > 0) {
          await session.page.setViewportSize(baseline).catch(() => undefined);
        }
        const report = `<h3>Viewport snapshots</h3>${tableFromRows(records as Array<Record<string, unknown>>)}`;
        const reportArtifact = await makeShareArtifact(ctx, "visual-regression-summary.html", "run_visual_regression_snapshot", report);
        shots.push(reportArtifact);
        return {
          ok: true,
          summary: `run_visual_regression_snapshot captured ${records.length} snapshot(s).`,
          jobId: session.id,
          artifacts: shots,
          logs: trimLogLines([`session=${session.id}`, `count=${records.length}`]),
          structuredContent: trimStructuredContent(sanitizeSecretLikeValue({ sessionId: session.id, records }) as Record<string, unknown>),
          errors: []
        };
      } finally {
        await close();
      }
    }
  },
  {
    definition: {
      name: "run_smoke_flow",
      description: "Execute declarative browser steps and return step-level pass/fail plus logs and snapshots.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          url: { type: "string", format: "uri" },
          steps: {
            type: "array",
            items: {
              anyOf: [
                { type: "object", properties: { action: { const: "click" }, selector: { type: "string" }, timeoutMs: { type: "number" } }, required: ["action", "selector"] },
                { type: "object", properties: { action: { const: "fill" }, selector: { type: "string" }, value: { type: "string" }, timeoutMs: { type: "number" } }, required: ["action", "selector", "value"] },
                { type: "object", properties: { action: { const: "assert" }, text: { type: "string" }, timeoutMs: { type: "number" } }, required: ["action", "text"] },
                { type: "object", properties: { action: { const: "screenshot" }, label: { type: "string" } }, required: ["action"] },
                { type: "object", properties: { action: { const: "waitForUrl" }, url: { type: "string" }, timeoutMs: { type: "number" } }, required: ["action", "url"] },
                { type: "object", properties: { action: { const: "waitForSelector" }, selector: { type: "string" }, timeoutMs: { type: "number" } }, required: ["action", "selector"] }
              ]
            }
          },
          timeoutMs: { type: "number" },
          stopOnFailure: { type: "boolean" }
        },
        required: ["steps"],
        additionalProperties: false
      }
    },
    enabledByDefault: false,
    schema: runSmokeFlowSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof runSmokeFlowSchema>;
      const { session, close } = await resolveSession(parsed.sessionId, parsed.url);
      const stepResults: FlowStepResult[] = [];
      const snapshots: string[] = [];
      let failed = 0;
      try {
        const page = session.page;
        page.setDefaultTimeout(parsed.timeoutMs);
        for (const step of parsed.steps) {
          const result: FlowStepResult = {
            action: step.action,
            ok: true,
            startAt: new Date().toISOString(),
            endAt: "",
            logs: []
          };
          try {
            if (step.action === "click") {
              const timeout = step.timeoutMs ?? parsed.timeoutMs;
              result.logs.push(`click ${step.selector}`);
              await page.click(step.selector, { timeout });
            } else if (step.action === "fill") {
              const timeout = step.timeoutMs ?? parsed.timeoutMs;
              result.logs.push(`fill ${step.selector}`);
              await page.fill(step.selector, step.value, { timeout });
            } else if (step.action === "assert") {
              const timeout = step.timeoutMs ?? parsed.timeoutMs;
              result.logs.push(`assert text contains ${step.text}`);
              await page.getByText(step.text).first().waitFor({ timeout });
            } else if (step.action === "screenshot") {
              const image = await page.screenshot({ type: "png", fullPage: true });
              result.snapshot = await makeImageArtifact(ctx, safeArtifactFilename(`flow-${session.id}`, `${Date.now()}`, "png"), image);
              snapshots.push(result.snapshot);
              result.logs.push("screenshot saved");
            } else if (step.action === "waitForUrl") {
              const timeout = step.timeoutMs ?? parsed.timeoutMs;
              result.logs.push(`waitForUrl ${step.url}`);
              await page.waitForURL(step.url, { timeout });
            } else {
              const timeout = step.timeoutMs ?? parsed.timeoutMs;
              result.logs.push(`waitForSelector ${step.selector}`);
              await page.waitForSelector(step.selector, { timeout });
            }
          } catch (error) {
            result.ok = false;
            failed += 1;
            result.error = error instanceof Error ? error.message : "Step failed.";
            result.errorStack = error instanceof Error ? error.stack : undefined;
            const image = await page.screenshot({ type: "png", fullPage: true }).catch(() => undefined);
            if (image) {
              result.snapshot = await makeImageArtifact(ctx, safeArtifactFilename(`flow-${session.id}`, `error-${Date.now()}`, "png"), image);
              snapshots.push(result.snapshot);
            }
            if (parsed.stopOnFailure) {
              result.endAt = new Date().toISOString();
              stepResults.push(result);
              break;
            }
          }
          result.endAt = new Date().toISOString();
          stepResults.push(result);
        }

        return {
          ok: failed === 0,
          summary: failed === 0 ? "run_smoke_flow completed." : `run_smoke_flow finished with ${failed} failed step(s).`,
          jobId: session.id,
          artifacts: snapshots,
          logs: trimLogLines([`total=${stepResults.length}`, `failed=${failed}`, `url=${session.page.url()}`]),
          structuredContent: trimStructuredContent(sanitizeSecretLikeValue({ sessionId: session.id, steps: stepResults }) as Record<string, unknown>),
          errors: failed > 0 ? ["Some steps failed."] : []
        };
      } finally {
        await close();
      }
    }
  }
];
