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
  contentBaseUrl?: string;
  shareRoot: string;
  artifactRoot: string;
  userId?: string;
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

type RecordedInteractionStep =
  | { action: "click"; selector: string; label?: string; timestampMs?: number; timeoutMs?: number }
  | { action: "fill"; selector: string; value: string; label?: string; timestampMs?: number; timeoutMs?: number }
  | { action: "select"; selector: string; value: string; label?: string; timestampMs?: number; timeoutMs?: number }
  | { action: "press"; key: string; selector?: string; label?: string; timestampMs?: number; timeoutMs?: number }
  | { action: "scroll"; x?: number; y?: number; label?: string; timestampMs?: number }
  | { action: "wait"; ms: number; label?: string; timestampMs?: number }
  | { action: "assert"; text: string; label?: string; timestampMs?: number; timeoutMs?: number }
  | { action: "screenshot"; label?: string; timestampMs?: number };

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

const storageExpectationSchema = z.object({
  key: z.string().min(1).max(300),
  value: z.string().max(8000).optional(),
  contains: z.string().max(8000).optional()
}).refine((value) => value.value !== undefined || value.contains !== undefined, {
  message: "Either value or contains is required.",
  path: ["value"]
});

const formPersistenceFieldSchema = z.object({
  selector: z.string().min(1).max(500),
  value: z.string().max(8000),
  type: z.enum(["text", "select", "checkbox"]).optional().default("text"),
  expectedAfterReload: z.string().max(8000).optional()
});

const testFormPersistenceSchema = z.object({
  sessionId: z.string().min(1).optional(),
  url: z.string().url().optional(),
  fields: z.array(formPersistenceFieldSchema).min(1).max(30),
  clickSelectors: z.array(z.string().min(1).max(500)).max(20).optional().default([]),
  submitSelector: z.string().min(1).max(500).optional(),
  seedLocalStorage: z.record(z.string(), z.string()).optional().default({}),
  seedSessionStorage: z.record(z.string(), z.string()).optional().default({}),
  resetStorage: z.boolean().optional().default(false),
  expectedLocalStorage: z.array(storageExpectationSchema).max(40).optional().default([]),
  expectedSessionStorage: z.array(storageExpectationSchema).max(40).optional().default([]),
  expectedIndexedDbDatabases: z.array(z.string().min(1).max(200)).max(40).optional().default([]),
  checkNewPageSameContext: z.boolean().optional().default(false),
  timeoutMs: z.number().int().min(500).max(120000).optional().default(30000)
}).refine((value) => Boolean(value.sessionId || value.url), {
  message: "Either sessionId or url is required.",
  path: ["sessionId"]
});

const recordedInteractionStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), selector: z.string().min(1).max(500), label: z.string().min(1).max(160).optional(), timestampMs: z.number().int().min(0).optional(), timeoutMs: z.number().int().min(200).max(120000).optional() }),
  z.object({ action: z.literal("fill"), selector: z.string().min(1).max(500), value: z.string().max(8000), label: z.string().min(1).max(160).optional(), timestampMs: z.number().int().min(0).optional(), timeoutMs: z.number().int().min(200).max(120000).optional() }),
  z.object({ action: z.literal("select"), selector: z.string().min(1).max(500), value: z.string().max(1000), label: z.string().min(1).max(160).optional(), timestampMs: z.number().int().min(0).optional(), timeoutMs: z.number().int().min(200).max(120000).optional() }),
  z.object({ action: z.literal("press"), key: z.string().min(1).max(80), selector: z.string().min(1).max(500).optional(), label: z.string().min(1).max(160).optional(), timestampMs: z.number().int().min(0).optional(), timeoutMs: z.number().int().min(200).max(120000).optional() }),
  z.object({ action: z.literal("scroll"), x: z.number().int().optional().default(0), y: z.number().int().optional().default(600), label: z.string().min(1).max(160).optional(), timestampMs: z.number().int().min(0).optional() }),
  z.object({ action: z.literal("wait"), ms: z.number().int().min(50).max(30000), label: z.string().min(1).max(160).optional(), timestampMs: z.number().int().min(0).optional() }),
  z.object({ action: z.literal("assert"), text: z.string().min(1).max(1000), label: z.string().min(1).max(160).optional(), timestampMs: z.number().int().min(0).optional(), timeoutMs: z.number().int().min(200).max(120000).optional() }),
  z.object({ action: z.literal("screenshot"), label: z.string().min(1).max(160).optional(), timestampMs: z.number().int().min(0).optional() })
]);

const recordInteractionFlowSchema = z.object({
  title: z.string().min(1).max(160).optional().default("Interaction recording"),
  url: z.string().url().optional(),
  viewport: z.enum(["desktop", "tablet", "mobile"]).optional().default("desktop"),
  steps: z.array(recordedInteractionStepSchema).min(1).max(80),
  includeReplayHints: z.boolean().optional().default(true),
  filenamePrefix: z.string().min(1).max(80).optional().default("interaction-recording")
});

const replayInteractionRecordingSchema = z.object({
  sessionId: z.string().min(1).optional(),
  url: z.string().url().optional(),
  recording: z.object({
    title: z.string().min(1).max(160).optional(),
    url: z.string().url().optional(),
    steps: z.array(recordedInteractionStepSchema).min(1).max(80)
  }).optional(),
  steps: z.array(recordedInteractionStepSchema).min(1).max(80).optional(),
  captureScreenshots: z.boolean().optional().default(true),
  captureConsole: z.boolean().optional().default(true),
  captureNetwork: z.boolean().optional().default(true),
  dryRun: z.boolean().optional().default(false),
  timeoutMs: z.number().int().min(500).max(120000).optional().default(30000),
  stopOnFailure: z.boolean().optional().default(true)
}).refine((value) => Boolean(value.recording?.steps.length || value.steps?.length), {
  message: "recording.steps or steps is required.",
  path: ["recording"]
}).refine((value) => value.dryRun || Boolean(value.sessionId || value.url || value.recording?.url), {
  message: "sessionId, url, or recording.url is required unless dryRun=true.",
  path: ["url"]
});

const profileWebPerformanceSchema = z.object({
  sessionId: z.string().min(1).optional(),
  url: z.string().url().optional(),
  sampleMs: z.number().int().min(500).max(30000).optional().default(3000),
  targetFps: z.number().int().min(15).max(144).optional().default(60),
  longTaskThresholdMs: z.number().int().min(50).max(1000).optional().default(50),
  captureScreenshot: z.boolean().optional().default(false),
  captureTraceHints: z.boolean().optional().default(true),
  sampleMetrics: z.object({
    fpsSamples: z.array(z.number().min(0).max(240)).max(600).optional().default([]),
    longTasks: z.array(z.object({ duration: z.number().min(0), name: z.string().optional().default("task"), startTime: z.number().min(0).optional().default(0) })).max(500).optional().default([]),
    memoryTimeline: z.array(z.object({ usedJSHeapSize: z.number().min(0), totalJSHeapSize: z.number().min(0).optional(), timestampMs: z.number().min(0).optional() })).max(200).optional().default([]),
    layoutShifts: z.array(z.object({ value: z.number().min(0), startTime: z.number().min(0).optional().default(0) })).max(500).optional().default([]),
    resources: z.array(z.object({ name: z.string(), initiatorType: z.string().optional().default("resource"), duration: z.number().min(0), transferSize: z.number().min(0).optional().default(0) })).max(500).optional().default([]),
    scripts: z.array(z.object({ name: z.string(), duration: z.number().min(0), transferSize: z.number().min(0).optional().default(0) })).max(200).optional().default([]),
    selectorStats: z.array(z.object({ selector: z.string(), count: z.number().int().min(0), estimatedCost: z.number().min(0) })).max(200).optional().default([])
  }).optional()
}).refine((value) => Boolean(value.sessionId || value.url || value.sampleMetrics), {
  message: "sessionId, url, or sampleMetrics is required.",
  path: ["url"]
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
  return makeArtifactUrl(ctx.contentBaseUrl ?? ctx.publicBaseUrl, artifact.id, artifact.filename);
}

async function makeJsonArtifact(ctx: ToolContext, filename: string, payload: unknown): Promise<string> {
  const artifact = await createArtifact({
    artifactRoot: ctx.artifactRoot,
    filename,
    contentType: "application/json",
    content: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8")
  });
  return makeArtifactUrl(ctx.contentBaseUrl ?? ctx.publicBaseUrl, artifact.id, artifact.filename);
}

async function makeShareArtifact(ctx: ToolContext, filename: string, title: string, body: string): Promise<string> {
  const share = await createShareArtifact({
    shareRoot: ctx.shareRoot,
    title,
    summary: title,
    filename,
    html: wrapHtml(title, body),
    ownerUserId: ctx.userId
  });
  return makeShareUrl(ctx.publicBaseUrl, share.id, share.filename);
}

async function openTemporarySession(url: string, timeoutMs: number): Promise<TempSession> {
  // NOTE: these tools deliberately inspect arbitrary URLs including local dev servers
  // (localhost), so no public-only SSRF guard is applied here. They are off by default;
  // operators enabling them accept that they can reach private addresses.
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

  const close = async () => {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  };
  // goto runs before `close` reaches the caller, so on failure (timeout/abort) the
  // caller never gets a handle to close it — close here to avoid orphaning the browser.
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
  } catch (error) {
    await close();
    throw error;
  }
  return { session, close };
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

function interactionStepSummary(step: RecordedInteractionStep, index: number) {
  if (step.action === "click") return `${index + 1}. click ${step.selector}`;
  if (step.action === "fill") return `${index + 1}. fill ${step.selector}`;
  if (step.action === "select") return `${index + 1}. select ${step.selector}=${step.value}`;
  if (step.action === "press") return `${index + 1}. press ${step.key}${step.selector ? ` in ${step.selector}` : ""}`;
  if (step.action === "scroll") return `${index + 1}. scroll x=${step.x ?? 0} y=${step.y ?? 0}`;
  if (step.action === "wait") return `${index + 1}. wait ${step.ms}ms`;
  if (step.action === "assert") return `${index + 1}. assert text ${step.text}`;
  return `${index + 1}. screenshot ${step.label ?? ""}`.trim();
}

function normalizeRecordedSteps(steps: RecordedInteractionStep[]) {
  return steps.map((step, index) => ({
    id: `step_${String(index + 1).padStart(2, "0")}`,
    ...step,
    label: step.label ?? interactionStepSummary(step, index),
    timestampMs: step.timestampMs ?? index * 1000
  }));
}

function renderInteractionReport(title: string, rows: Array<Record<string, unknown>>, intro: string) {
  return `<p>${escapeHtml(intro)}</p>${tableFromRows(rows)}`;
}

async function executeRecordedStep(page: Page, step: RecordedInteractionStep, timeoutMs: number) {
  if (step.action === "click") await page.click(step.selector, { timeout: step.timeoutMs ?? timeoutMs });
  else if (step.action === "fill") await page.fill(step.selector, step.value, { timeout: step.timeoutMs ?? timeoutMs });
  else if (step.action === "select") await page.selectOption(step.selector, step.value, { timeout: step.timeoutMs ?? timeoutMs });
  else if (step.action === "press") {
    if (step.selector) await page.locator(step.selector).press(step.key, { timeout: step.timeoutMs ?? timeoutMs });
    else await page.keyboard.press(step.key);
  } else if (step.action === "scroll") await page.evaluate(({ x, y }) => window.scrollBy(x ?? 0, y ?? 0), { x: step.x ?? 0, y: step.y ?? 0 });
  else if (step.action === "wait") await page.waitForTimeout(step.ms);
  else if (step.action === "assert") await page.getByText(step.text).first().waitFor({ timeout: step.timeoutMs ?? timeoutMs });
}

type PersistenceAssertion = {
  id: string;
  ok: boolean;
  message: string;
  expected?: string;
  actual?: string;
};

async function seedBrowserStorage(page: Page, local: Record<string, string>, session: Record<string, string>, reset: boolean) {
  await page.evaluate(({ local, session, reset }) => {
    if (reset) {
      window.localStorage.clear();
      window.sessionStorage.clear();
    }
    for (const [key, value] of Object.entries(local)) window.localStorage.setItem(key, value);
    for (const [key, value] of Object.entries(session)) window.sessionStorage.setItem(key, value);
  }, { local, session, reset });
}

async function fieldValue(page: Page, selector: string, type: z.infer<typeof formPersistenceFieldSchema>["type"]) {
  return page.$eval(selector, (element, type) => {
    const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (type === "checkbox") return String((input as HTMLInputElement).checked);
    return String(input.value ?? "");
  }, type);
}

async function fillPersistenceField(page: Page, field: z.infer<typeof formPersistenceFieldSchema>, timeoutMs: number) {
  await page.waitForSelector(field.selector, { timeout: timeoutMs });
  if (field.type === "select") await page.selectOption(field.selector, field.value, { timeout: timeoutMs });
  else if (field.type === "checkbox") {
    const desired = /^(true|1|yes|checked)$/i.test(field.value);
    const checked = await page.isChecked(field.selector, { timeout: timeoutMs });
    if (checked !== desired) await page.click(field.selector, { timeout: timeoutMs });
  } else {
    await page.fill(field.selector, field.value, { timeout: timeoutMs });
  }
}

async function collectStorage(page: Page) {
  return page.evaluate(`(async () => {
    const collect = (store) => {
      const rows = {};
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (key) rows[key] = store.getItem(key) ?? "";
      }
      return rows;
    };
    const databases = typeof indexedDB.databases === "function"
      ? await indexedDB.databases().then((items) => items.map((item) => item.name).filter((name) => !!name)).catch(() => [])
      : [];
    return { localStorage: collect(window.localStorage), sessionStorage: collect(window.sessionStorage), indexedDbDatabases: databases };
  })()`) as Promise<{ localStorage: Record<string, string>; sessionStorage: Record<string, string>; indexedDbDatabases: string[] }>;
}

function storageAssertions(kind: "localStorage" | "sessionStorage", values: Record<string, string>, expectations: z.infer<typeof storageExpectationSchema>[]): PersistenceAssertion[] {
  return expectations.map((expectation) => {
    const actual = values[expectation.key];
    const ok = expectation.value !== undefined ? actual === expectation.value : actual?.includes(expectation.contains ?? "") === true;
    return { id: `${kind}:${expectation.key}`, ok, message: ok ? `${kind} ${expectation.key} matched.` : `${kind} ${expectation.key} mismatch.`, expected: expectation.value ?? `contains ${expectation.contains}`, actual };
  });
}

async function assertPersistenceState(page: Page, input: z.infer<typeof testFormPersistenceSchema>, phase: string): Promise<{ phase: string; assertions: PersistenceAssertion[]; storage: Awaited<ReturnType<typeof collectStorage>> }> {
  const assertions: PersistenceAssertion[] = [];
  for (const field of input.fields) {
    const expected = field.expectedAfterReload ?? field.value;
    const actual = await fieldValue(page, field.selector, field.type).catch((error) => `__ERROR__ ${error instanceof Error ? error.message : "read failed"}`);
    assertions.push({ id: `${phase}:field:${field.selector}`, ok: actual === expected, message: actual === expected ? `Field ${field.selector} persisted.` : `Field ${field.selector} did not persist.`, expected, actual });
  }
  const storage = await collectStorage(page);
  assertions.push(...storageAssertions("localStorage", storage.localStorage, input.expectedLocalStorage));
  assertions.push(...storageAssertions("sessionStorage", storage.sessionStorage, input.expectedSessionStorage));
  for (const dbName of input.expectedIndexedDbDatabases) {
    const ok = storage.indexedDbDatabases.includes(dbName);
    assertions.push({ id: `indexedDB:${dbName}`, ok, message: ok ? `IndexedDB ${dbName} exists.` : `IndexedDB ${dbName} was not found.`, expected: dbName, actual: storage.indexedDbDatabases.join(", ") });
  }
  return { phase, assertions, storage };
}

function persistenceReportHtml(report: Record<string, unknown>) {
  const phases = report.phases as Array<{ phase: string; assertions: PersistenceAssertion[] }> | undefined;
  const rows = (phases ?? []).flatMap((phase) => phase.assertions.map((assertion) => ({ phase: phase.phase, ...assertion })));
  return `<h1>Form Persistence Report</h1>${tableFromRows(rows)}<h2>Summary</h2><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>`;
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

function profileFindings(input: { targetFps: number; longTaskThresholdMs: number; metrics: z.infer<typeof profileWebPerformanceSchema>["sampleMetrics"] }) {
  const metrics = input.metrics ?? { fpsSamples: [], longTasks: [], memoryTimeline: [], layoutShifts: [], resources: [], scripts: [], selectorStats: [] };
  const fpsSamples = metrics.fpsSamples ?? [];
  const longTasks = (metrics.longTasks ?? []).filter((task) => task.duration >= input.longTaskThresholdMs);
  const memoryTimeline = metrics.memoryTimeline ?? [];
  const resources = metrics.resources ?? [];
  const scripts = metrics.scripts ?? [];
  const selectorStats = metrics.selectorStats ?? [];
  const layoutShifts = metrics.layoutShifts ?? [];
  const memoryGrowthBytes = memoryTimeline.length >= 2 ? memoryTimeline.at(-1)!.usedJSHeapSize - memoryTimeline[0].usedJSHeapSize : 0;
  const fpsSummary = {
    average: fpsSamples.length ? Number((fpsSamples.reduce((sum, value) => sum + value, 0) / fpsSamples.length).toFixed(2)) : undefined,
    p10: fpsSamples.length ? percentile(fpsSamples, 10) : undefined,
    min: fpsSamples.length ? Math.min(...fpsSamples) : undefined,
    droppedFrameRatio: fpsSamples.length ? Number((fpsSamples.filter((fps) => fps < input.targetFps * 0.75).length / fpsSamples.length).toFixed(3)) : undefined
  };
  const paintResourcePattern = /image|img|css|font/i;
  const paintCost = resources.filter((resource) => paintResourcePattern.test(resource.initiatorType)).reduce((sum, resource) => sum + resource.duration, 0);
  const totalBlockingTime = longTasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0);
  const findings: Array<{ severity: "high" | "medium" | "low"; category: string; message: string; suggestedFix: string }> = [];
  if (fpsSummary.average !== undefined && fpsSummary.average < input.targetFps * 0.75) findings.push({ severity: "high", category: "fps", message: `Average FPS ${fpsSummary.average} is below target ${input.targetFps}.`, suggestedFix: "Reduce animation work, simplify WebGL/SVG effects, virtualize heavy DOM, or throttle expensive loops." });
  if ((fpsSummary.droppedFrameRatio ?? 0) > 0.25) findings.push({ severity: "medium", category: "jank", message: `${Math.round((fpsSummary.droppedFrameRatio ?? 0) * 100)}% of FPS samples dropped below the jank threshold.`, suggestedFix: "Profile animation callbacks and move non-visual work out of the frame loop." });
  if (longTasks.length) findings.push({ severity: totalBlockingTime > 300 ? "high" : "medium", category: "long_task", message: `${longTasks.length} long task(s), total blocking time ${Math.round(totalBlockingTime)}ms.`, suggestedFix: "Split long JavaScript work, defer non-critical initialization, and avoid synchronous layout reads after writes." });
  if (memoryGrowthBytes > 10 * 1024 * 1024) findings.push({ severity: "medium", category: "memory", message: `JS heap grew by ${Math.round(memoryGrowthBytes / 1024 / 1024)}MB during the sample.`, suggestedFix: "Check retained objects, event listeners, caches, textures, and detached DOM nodes." });
  const cls = layoutShifts.reduce((sum, shift) => sum + shift.value, 0);
  if (cls > 0.1) findings.push({ severity: "medium", category: "layout", message: `Cumulative layout shift ${Number(cls.toFixed(3))} may indicate layout thrashing or unstable content.`, suggestedFix: "Reserve dimensions, batch DOM writes, and avoid measuring layout repeatedly during animation." });
  if (paintCost > 1000) findings.push({ severity: "medium", category: "paint", message: `Paint-related resources consumed about ${Math.round(paintCost)}ms.`, suggestedFix: "Compress large images, reduce filters/shadows, and simplify SVG paint areas." });
  const heavyScripts = scripts.filter((script) => script.duration > 200).sort((a, b) => b.duration - a.duration).slice(0, 8);
  if (heavyScripts.length) findings.push({ severity: "medium", category: "script", message: `${heavyScripts.length} script resource(s) took more than 200ms.`, suggestedFix: "Code split, defer, cache, or replace expensive script bundles." });
  const heavySelectors = selectorStats.filter((selector) => selector.estimatedCost > 1000 || selector.count > 1000).sort((a, b) => b.estimatedCost - a.estimatedCost).slice(0, 8);
  if (heavySelectors.length) findings.push({ severity: "low", category: "selector", message: `${heavySelectors.length} selector(s) have high DOM fan-out or estimated query cost.`, suggestedFix: "Use scoped selectors, IDs/data attributes, or cache repeated query results." });
  const score = Math.max(0, Math.min(100, 100 - findings.reduce((sum, finding) => sum + (finding.severity === "high" ? 25 : finding.severity === "medium" ? 12 : 5), 0)));
  return {
    score,
    status: findings.some((finding) => finding.severity === "high") ? "poor" : findings.length ? "needs_attention" : "pass",
    fpsSummary,
    longTaskBreakdown: { count: longTasks.length, totalBlockingTime: Math.round(totalBlockingTime), worstTasks: longTasks.sort((a, b) => b.duration - a.duration).slice(0, 10) },
    memoryTimeline,
    memoryGrowthBytes,
    layoutReport: { cumulativeLayoutShift: Number(cls.toFixed(3)), shifts: layoutShifts.slice(0, 20) },
    paintReport: { estimatedPaintResourceMs: Math.round(paintCost), paintResources: resources.filter((resource) => paintResourcePattern.test(resource.initiatorType)).slice(0, 20) },
    scriptHotspots: heavyScripts,
    heavySelectors,
    animationJankReport: { targetFps: input.targetFps, droppedFrameRatio: fpsSummary.droppedFrameRatio, samplesBelowTarget: fpsSamples.filter((fps) => fps < input.targetFps).length },
    findings,
    recommendations: [...new Set(findings.map((finding) => finding.suggestedFix))]
  };
}

async function collectPerformanceSample(page: Page, sampleMs: number) {
  return page.evaluate(async ({ sampleMs }) => {
    const fpsSamples: number[] = [];
    const longTasks: Array<{ name: string; duration: number; startTime: number }> = [];
    const layoutShifts: Array<{ value: number; startTime: number }> = [];
    const memoryTimeline: Array<{ usedJSHeapSize: number; totalJSHeapSize?: number; timestampMs: number }> = [];
    const observers: PerformanceObserver[] = [];
    const observe = (type: string, cb: (entry: PerformanceEntry) => void) => {
      try {
        const observer = new PerformanceObserver((list) => list.getEntries().forEach(cb));
        observer.observe({ type, buffered: true });
        observers.push(observer);
      } catch {
        // Unsupported browser performance entry type.
      }
    };
    observe("longtask", (entry) => longTasks.push({ name: entry.name, duration: entry.duration, startTime: entry.startTime }));
    observe("layout-shift", (entry) => {
      const value = (entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }).value ?? 0;
      const hadRecentInput = (entry as PerformanceEntry & { hadRecentInput?: boolean }).hadRecentInput ?? false;
      if (!hadRecentInput) layoutShifts.push({ value, startTime: entry.startTime });
    });
    let last = performance.now();
    let frames = 0;
    let cancelled = false;
    const frame = () => {
      if (cancelled) return;
      frames += 1;
      const now = performance.now();
      if (now - last >= 500) {
        fpsSamples.push(Number(((frames * 1000) / (now - last)).toFixed(2)));
        frames = 0;
        last = now;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const memoryTimer = window.setInterval(() => {
      const perf = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } };
      if (perf.memory) memoryTimeline.push({ usedJSHeapSize: perf.memory.usedJSHeapSize, totalJSHeapSize: perf.memory.totalJSHeapSize, timestampMs: performance.now() });
    }, 500);
    await new Promise((resolve) => window.setTimeout(resolve, sampleMs));
    cancelled = true;
    window.clearInterval(memoryTimer);
    observers.forEach((observer) => observer.disconnect());
    const resources = performance.getEntriesByType("resource").map((entry) => {
      const resource = entry as PerformanceResourceTiming;
      return { name: resource.name, initiatorType: resource.initiatorType, duration: Number(resource.duration.toFixed(2)), transferSize: resource.transferSize ?? 0 };
    });
    const scripts = resources.filter((resource) => /script/i.test(resource.initiatorType) || /\.m?js(?:\?|$)/i.test(resource.name));
    const selectorStats = ["*", "div", "svg *", "canvas", "table tr", "[data-state]", "[class]"].map((selector) => {
      const start = performance.now();
      const count = document.querySelectorAll(selector).length;
      const estimatedCost = Number(((performance.now() - start) * Math.max(1, count)).toFixed(2));
      return { selector, count, estimatedCost };
    });
    return { fpsSamples, longTasks, memoryTimeline, layoutShifts, resources, scripts, selectorStats };
  }, { sampleMs });
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
      name: "profile_web_performance",
      description: "Profile laggy web demos with FPS samples, long tasks, memory growth, layout shift, paint/resource cost, script hotspots, heavy selectors, and animation jank recommendations.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          url: { type: "string", format: "uri" },
          sampleMs: { type: "number" },
          targetFps: { type: "number" },
          longTaskThresholdMs: { type: "number" },
          captureScreenshot: { type: "boolean" },
          captureTraceHints: { type: "boolean" },
          sampleMetrics: { type: "object" }
        },
        additionalProperties: false
      }
    },
    enabledByDefault: false,
    schema: profileWebPerformanceSchema,
    handler: async (input, ctx) => {
      const parsed = profileWebPerformanceSchema.parse(input);
      const artifacts: string[] = [];
      let sample = parsed.sampleMetrics;
      let targetUrl = parsed.url;
      let screenshot: string | undefined;
      if (!sample) {
        const { session, close } = await resolveSession(parsed.sessionId, parsed.url);
        try {
          targetUrl = session.page.url();
          sample = await collectPerformanceSample(session.page, parsed.sampleMs);
          if (parsed.captureScreenshot) {
            const image = await session.page.screenshot({ type: "png", fullPage: true }).catch(() => undefined);
            if (image) {
              screenshot = await makeImageArtifact(ctx, safeArtifactFilename(`performance-${session.id}`, Date.now().toString(), "png"), image);
              artifacts.push(screenshot);
            }
          }
        } finally {
          await close();
        }
      }
      const analysis = profileFindings({ targetFps: parsed.targetFps, longTaskThresholdMs: parsed.longTaskThresholdMs, metrics: sample });
      const report = {
        url: targetUrl,
        sampledAt: new Date().toISOString(),
        sampleMs: parsed.sampleMs,
        targetFps: parsed.targetFps,
        screenshot,
        ...analysis,
        traceHints: parsed.captureTraceHints ? [
          "For JavaScript hot spots, rerun inspect_webpage_plus with captureTrace=true and inspect the trace in Playwright Trace Viewer.",
          "For WebGL scenes, compare draw calls, texture sizes, shader/material count, and requestAnimationFrame work per frame.",
          "For large admin panels, verify list virtualization, memoized render paths, and scoped DOM queries."
        ] : []
      };
      const jsonUrl = await makeJsonArtifact(ctx, safeArtifactFilename("web-performance", Date.now().toString(), "json"), report);
      artifacts.push(jsonUrl);
      const rows = [
        { metric: "score", value: report.score },
        { metric: "status", value: report.status },
        { metric: "averageFps", value: report.fpsSummary.average ?? "n/a" },
        { metric: "longTasks", value: report.longTaskBreakdown.count },
        { metric: "memoryGrowthBytes", value: report.memoryGrowthBytes },
        { metric: "cumulativeLayoutShift", value: report.layoutReport.cumulativeLayoutShift },
        { metric: "scriptHotspots", value: report.scriptHotspots.length },
        { metric: "heavySelectors", value: report.heavySelectors.length }
      ];
      const html = `${tableFromRows(rows)}<h3>Findings</h3>${tableFromRows(report.findings as Array<Record<string, unknown>>)}<h3>Recommendations</h3><ul>${report.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
      const reportUrl = await makeShareArtifact(ctx, safeArtifactFilename("web-performance", `${Date.now()}-report`, "html"), "Web Performance Profile", html);
      artifacts.push(reportUrl);
      return {
        ok: report.findings.every((finding) => finding.severity !== "high"),
        summary: `Performance profile ${report.status} with score ${report.score}.`,
        jobId: parsed.sessionId ?? targetUrl,
        artifacts,
        logs: trimLogLines([`score=${report.score}`, `status=${report.status}`, `findings=${report.findings.length}`]),
        structuredContent: trimStructuredContent(sanitizeSecretLikeValue({ ...report, reportUrl, jsonUrl }) as Record<string, unknown>),
        errors: report.findings.filter((finding) => finding.severity === "high").map((finding) => finding.message)
      };
    }
  },
  {
    definition: {
      name: "record_interaction_flow",
      description: "Create a replayable UI interaction recording from clicks, inputs, scrolls, waits, assertions, and screenshots, with JSON and HTML artifacts for bug reproduction.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string", format: "uri" },
          viewport: { type: "string", enum: ["desktop", "tablet", "mobile"] },
          steps: { type: "array" },
          includeReplayHints: { type: "boolean" },
          filenamePrefix: { type: "string" }
        },
        required: ["steps"],
        additionalProperties: false
      }
    },
    enabledByDefault: false,
    schema: recordInteractionFlowSchema,
    handler: async (input, ctx) => {
      const parsed = recordInteractionFlowSchema.parse(input);
      const recordingId = `interaction_${Date.now().toString(36)}`;
      const steps = normalizeRecordedSteps(parsed.steps);
      const recording = {
        version: 1,
        recordingId,
        title: parsed.title,
        url: parsed.url,
        viewport: parsed.viewport,
        createdAt: new Date().toISOString(),
        steps,
        replayHints: parsed.includeReplayHints ? {
          tool: "replay_interaction_recording",
          captureScreenshots: true,
          captureConsole: true,
          captureNetwork: true
        } : undefined
      };
      const jsonUrl = await makeJsonArtifact(ctx, safeArtifactFilename(parsed.filenamePrefix, recordingId, "json"), recording);
      const rows = steps.map((step) => ({ id: step.id, action: step.action, label: step.label, selector: "selector" in step ? step.selector : "", value: "value" in step ? step.value : "", timestampMs: step.timestampMs }));
      const reportUrl = await makeShareArtifact(ctx, safeArtifactFilename(parsed.filenamePrefix, `${recordingId}-report`, "html"), parsed.title, renderInteractionReport(parsed.title, rows, "Replayable interaction recording."));
      return {
        ok: true,
        summary: `Recorded ${steps.length} interaction step(s).`,
        jobId: recordingId,
        artifacts: [jsonUrl, reportUrl],
        logs: trimLogLines(steps.map((step, index) => interactionStepSummary(step, index))),
        structuredContent: trimStructuredContent(sanitizeSecretLikeValue({ recordingId, recording, recordingArtifact: jsonUrl, reportUrl, replaySteps: steps }) as Record<string, unknown>),
        errors: []
      };
    }
  },
  {
    definition: {
      name: "replay_interaction_recording",
      description: "Replay recorded UI interactions and attach per-step screenshot, console, and network trace summaries; supports dry-run replay planning without opening a browser.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          url: { type: "string", format: "uri" },
          recording: { type: "object" },
          steps: { type: "array" },
          captureScreenshots: { type: "boolean" },
          captureConsole: { type: "boolean" },
          captureNetwork: { type: "boolean" },
          dryRun: { type: "boolean" },
          timeoutMs: { type: "number" },
          stopOnFailure: { type: "boolean" }
        },
        additionalProperties: false
      }
    },
    enabledByDefault: false,
    schema: replayInteractionRecordingSchema,
    handler: async (input, ctx) => {
      const parsed = replayInteractionRecordingSchema.parse(input);
      const steps = normalizeRecordedSteps((parsed.recording?.steps ?? parsed.steps) as RecordedInteractionStep[]);
      const targetUrl = parsed.url ?? parsed.recording?.url;
      const replayId = `replay_${Date.now().toString(36)}`;
      if (parsed.dryRun) {
        const dryRunSteps = steps.map((step, index) => ({
          id: step.id,
          action: step.action,
          ok: true,
          dryRun: true,
          screenshot: parsed.captureScreenshots ? `planned-step-${index + 1}.png` : undefined,
          consoleTrace: parsed.captureConsole ? [] : undefined,
          networkTrace: parsed.captureNetwork ? [] : undefined,
          logs: [interactionStepSummary(step, index)]
        }));
        const reportUrl = await makeShareArtifact(ctx, safeArtifactFilename("interaction-replay", `${replayId}-dry-run`, "html"), "Interaction Replay Dry Run", renderInteractionReport("Interaction Replay Dry Run", dryRunSteps as Array<Record<string, unknown>>, "Dry-run replay plan; no browser actions were executed."));
        return { ok: true, summary: `Prepared dry-run replay for ${steps.length} step(s).`, jobId: replayId, artifacts: [reportUrl], logs: trimLogLines(dryRunSteps.map((step) => step.logs.join(" "))), structuredContent: trimStructuredContent(sanitizeSecretLikeValue({ replayId, dryRun: true, targetUrl, steps: dryRunSteps, reportUrl }) as Record<string, unknown>), errors: [] };
      }
      const { session, close } = await resolveSession(parsed.sessionId, targetUrl);
      const page = session.page;
      page.setDefaultTimeout(parsed.timeoutMs);
      const networkEvents: Array<{ type: string; url: string; method?: string; status?: number; failure?: string }> = [];
      const onRequestFailed = (request: Request) => networkEvents.push({ type: "requestfailed", url: request.url(), method: request.method(), failure: request.failure()?.errorText });
      const onResponse = (response: Response) => {
        if (response.status() >= 400) networkEvents.push({ type: "response", url: response.url(), status: response.status() });
      };
      if (parsed.captureNetwork) {
        page.on("requestfailed", onRequestFailed);
        page.on("response", onResponse);
      }
      const results: Array<Record<string, unknown>> = [];
      const artifacts: string[] = [];
      let failed = 0;
      try {
        for (const [index, step] of steps.entries()) {
          const consoleStart = session.consoleEvents.length;
          const networkStart = networkEvents.length;
          const result: Record<string, unknown> = { id: step.id, action: step.action, label: step.label, ok: true, startAt: new Date().toISOString(), logs: [interactionStepSummary(step, index)] };
          try {
            if (step.action === "screenshot") {
              // screenshot-only step; execution happens below.
            } else {
              await executeRecordedStep(page, step, parsed.timeoutMs);
            }
          } catch (error) {
            failed += 1;
            result.ok = false;
            result.error = error instanceof Error ? error.message : "Replay step failed.";
            if (parsed.stopOnFailure) {
              result.stopReason = "stopOnFailure";
            }
          }
          if (parsed.captureScreenshots) {
            const image = await page.screenshot({ type: "png", fullPage: true }).catch(() => undefined);
            if (image) {
              const screenshot = await makeImageArtifact(ctx, safeArtifactFilename(`replay-${session.id}`, `${index + 1}-${Date.now()}`, "png"), image);
              result.screenshot = screenshot;
              artifacts.push(screenshot);
            }
          }
          if (parsed.captureConsole) result.consoleTrace = session.consoleEvents.slice(consoleStart);
          if (parsed.captureNetwork) result.networkTrace = networkEvents.slice(networkStart);
          result.endAt = new Date().toISOString();
          results.push(result);
          if (result.ok === false && parsed.stopOnFailure) break;
        }
      } finally {
        if (parsed.captureNetwork) {
          page.off("requestfailed", onRequestFailed);
          page.off("response", onResponse);
        }
        await close();
      }
      const reportUrl = await makeShareArtifact(ctx, safeArtifactFilename("interaction-replay", `${replayId}-report`, "html"), "Interaction Replay Report", renderInteractionReport("Interaction Replay Report", results, "Replay results with per-step traces."));
      artifacts.push(reportUrl);
      return { ok: failed === 0, summary: failed === 0 ? `Replayed ${results.length} interaction step(s).` : `Replay found ${failed} failed step(s).`, jobId: replayId, artifacts, logs: trimLogLines(results.map((step) => `${step.id} ${step.action} ok=${step.ok}`)), structuredContent: trimStructuredContent(sanitizeSecretLikeValue({ replayId, targetUrl: page.url(), steps: results, reportUrl }) as Record<string, unknown>), errors: failed ? [`${failed} replay step(s) failed.`] : [] };
    }
  },
  {
    definition: {
      name: "test_form_persistence",
      description: "Run built-in form persistence scenarios: seed/reset storage, fill fields, click/save/submit, reload, assert form values, localStorage/sessionStorage, IndexedDB databases, and optional same-context new page persistence.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          url: { type: "string", format: "uri" },
          fields: { type: "array", items: { type: "object" } },
          clickSelectors: { type: "array", items: { type: "string" } },
          submitSelector: { type: "string" },
          seedLocalStorage: { type: "object" },
          seedSessionStorage: { type: "object" },
          resetStorage: { type: "boolean" },
          expectedLocalStorage: { type: "array", items: { type: "object" } },
          expectedSessionStorage: { type: "array", items: { type: "object" } },
          expectedIndexedDbDatabases: { type: "array", items: { type: "string" } },
          checkNewPageSameContext: { type: "boolean" },
          timeoutMs: { type: "number" }
        },
        required: ["fields"],
        additionalProperties: false
      }
    },
    enabledByDefault: false,
    schema: testFormPersistenceSchema,
    handler: async (input, ctx) => {
      const parsed = testFormPersistenceSchema.parse(input);
      const { session, close } = await resolveSession(parsed.sessionId, parsed.url);
      const phases: Array<{ phase: string; assertions: PersistenceAssertion[]; storage: Awaited<ReturnType<typeof collectStorage>> }> = [];
      const screenshots: string[] = [];
      try {
        const page = session.page;
        page.setDefaultTimeout(parsed.timeoutMs);
        await seedBrowserStorage(page, parsed.seedLocalStorage, parsed.seedSessionStorage, parsed.resetStorage);
        if (Object.keys(parsed.seedLocalStorage).length || Object.keys(parsed.seedSessionStorage).length || parsed.resetStorage) {
          await page.reload({ waitUntil: "networkidle", timeout: parsed.timeoutMs });
        }
        for (const field of parsed.fields) await fillPersistenceField(page, field, parsed.timeoutMs);
        for (const selector of parsed.clickSelectors) await page.click(selector, { timeout: parsed.timeoutMs });
        if (parsed.submitSelector) await page.click(parsed.submitSelector, { timeout: parsed.timeoutMs });
        await page.waitForTimeout(100);
        phases.push(await assertPersistenceState(page, parsed, "after-fill"));
        await page.reload({ waitUntil: "networkidle", timeout: parsed.timeoutMs });
        await page.waitForTimeout(200);
        phases.push(await assertPersistenceState(page, parsed, "after-reload"));
        if (parsed.checkNewPageSameContext) {
          const newPage = await page.context().newPage();
          try {
            await newPage.goto(page.url(), { waitUntil: "networkidle", timeout: parsed.timeoutMs });
            await newPage.waitForTimeout(200);
            phases.push(await assertPersistenceState(newPage, {
              ...parsed,
              fields: parsed.fields.filter((field) => field.type !== "checkbox"),
              expectedSessionStorage: []
            }, "new-page-same-context"));
          } finally {
            await newPage.close().catch(() => undefined);
          }
        }
        const failedAssertions = phases.flatMap((phase) => phase.assertions).filter((assertion) => !assertion.ok);
        if (failedAssertions.length) {
          const image = await page.screenshot({ type: "png", fullPage: true }).catch(() => undefined);
          if (image) screenshots.push(await makeImageArtifact(ctx, safeArtifactFilename(`form-persistence-${session.id}`, `failure-${Date.now()}`, "png"), image));
        }
        const report = sanitizeSecretLikeValue({
          sessionId: session.id,
          url: page.url(),
          phases,
          failedAssertions,
          resetStorage: parsed.resetStorage,
          seededLocalStorageKeys: Object.keys(parsed.seedLocalStorage),
          seededSessionStorageKeys: Object.keys(parsed.seedSessionStorage)
        }) as Record<string, unknown>;
        const jsonUrl = await makeJsonArtifact(ctx, safeArtifactFilename("form-persistence", Date.now().toString(), "json"), report);
        const reportUrl = await makeShareArtifact(ctx, safeArtifactFilename("form-persistence", `${Date.now()}-report`, "html"), "Form Persistence Report", persistenceReportHtml(report));
        return {
          ok: failedAssertions.length === 0,
          summary: failedAssertions.length === 0 ? "Form persistence checks passed." : `Form persistence found ${failedAssertions.length} failed assertion(s).`,
          jobId: session.id,
          artifacts: [jsonUrl, reportUrl, ...screenshots],
          logs: trimLogLines([`phases=${phases.length}`, `failedAssertions=${failedAssertions.length}`, `url=${page.url()}`]),
          structuredContent: trimStructuredContent(report),
          errors: failedAssertions.map((assertion) => assertion.message)
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
