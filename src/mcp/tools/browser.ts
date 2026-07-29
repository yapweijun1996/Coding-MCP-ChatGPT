import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createShareArtifact } from "../../share/store.js";
import { makeShareUrl } from "../result.js";
import { assertSafePublicUrl } from "../../security/url.js";
import { installSsrfRouteGuard } from "../../security/playwright-guard.js";
import type { Browser, Page } from "playwright";
import type { ToolModule, ToolResult } from "../types.js";

const BROWSER_PROTOCOLS = ["http:", "https:"];

// Browser sessions never legitimately target the private network, so unlike
// inspect_local_project there is no allowPrivateNetwork escape hatch: reject
// non-public URLs (file:, internal IPs, cloud metadata) before navigating.
async function guardBrowserUrl(url: string): Promise<void> {
  await assertSafePublicUrl(url, { protocols: BROWSER_PROTOCOLS });
}

export interface BrowserSession {
  id: string;
  browser: Browser;
  page: Page;
  step: number;
  startedAt: string;
  createdBy: string;
  consoleEvents: Array<{
    level: string;
    text: string;
    url?: string;
    line?: number;
    column?: number;
  }>;
  pageErrors: Array<{ message: string; stack?: string }>;
}

const MAX_SESSION_CONSOLE_LOGS = 400;
const MAX_BROWSER_SESSIONS = 10;

function pushBounded<T>(array: T[], value: T, max: number): void {
  array.push(value);
  if (array.length > max) {
    array.splice(0, array.length - max);
  }
}

function normalizeConsoleSource(source?: { url?: string; lineNumber?: number; columnNumber?: number }): { url?: string; line?: number; column?: number } {
  if (!source) return {};
  return {
    url: source.url,
    line: source.lineNumber,
    column: source.columnNumber
  };
}

const browserSessions = new Map<string, BrowserSession>();

const openBrowserSessionSchema = z.object({
  headless: z.boolean().optional().default(false),
  startUrl: z.string().url().optional(),
  width: z.number().int().min(600).max(3000).optional().default(1366),
  height: z.number().int().min(420).max(2600).optional().default(900),
  timeoutMs: z.number().int().min(500).max(120000).optional().default(20000)
});

const browserNavigateSchema = z.object({
  sessionId: z.string().min(1),
  url: z.string().url(),
  waitUntil: z.enum(["domcontentloaded", "load", "networkidle"]).optional().default("load"),
  timeoutMs: z.number().int().min(500).max(120000).optional().default(60000)
});

const browserActionSchema = z.object({
  sessionId: z.string().min(1),
  selector: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(120000).optional().default(15000)
});

const browserTypeSchema = z.object({
  sessionId: z.string().min(1),
  selector: z.string().min(1),
  text: z.string(),
  clear: z.boolean().optional().default(true),
  timeoutMs: z.number().int().min(100).max(120000).optional().default(15000)
});

const browserPressSchema = z.object({
  sessionId: z.string().min(1),
  key: z.string().min(1).max(64),
  timeoutMs: z.number().int().min(100).max(120000).optional().default(10000)
});

const browserScreenshotSchema = z.object({
  sessionId: z.string().min(1),
  label: z.string().max(80).optional().default("step"),
  fullPage: z.boolean().optional().default(false)
});

const browserWaitSchema = z.object({
  sessionId: z.string().min(1),
  ms: z.number().int().min(50).max(120000)
});

const closeBrowserSessionSchema = z.object({
  sessionId: z.string().min(1).optional(),
  all: z.boolean().optional().default(false)
}).refine((value) => value.all || !!value.sessionId, {
  message: "Either set all=true or provide a sessionId.",
  path: ["sessionId"]
});

export function getSessionOrThrow(sessionId: string): BrowserSession {
  const session = browserSessions.get(sessionId);
  if (!session) {
    throw new Error(`Browser session not found: ${sessionId}`);
  }
  return session;
}

export async function createBrowserSessionSnapshot(session: BrowserSession): Promise<Record<string, unknown>> {
  return {
    sessionId: session.id,
    step: session.step,
    url: session.page.url(),
    createdBy: session.createdBy,
    startedAt: session.startedAt,
    logs: {
      console: [...session.consoleEvents],
      pageErrors: [...session.pageErrors]
    }
  };
}

async function buildScreenshotArtifact(
  ctx: { publicBaseUrl: string; contentBaseUrl?: string; shareRoot: string; userId?: string },
  sessionId: string,
  step: number,
  label: string,
  page: Page,
  fullPage = false
): Promise<{ shareUrl: string; html: string }> {
  const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 70, fullPage });
  const dataUrl = `data:image/jpeg;base64,${screenshotBuffer.toString("base64")}`;
  const html = `<!doctype html>\n<html><head><meta charset="utf-8"><title>Browser Step ${step}</title></head><body style="margin:0;font-family:system-ui">\n<h3 style="padding:12px;margin:0;background:#f4f4f4;border-bottom:1px solid #ddd">Session ${sessionId} - Step ${step} - ${new Date().toISOString()}</h3>\n<p style="padding:0 12px;color:#444;font-size:13px">${label}</p>\n<div style="padding:12px"><img src="${dataUrl}" style="width:100%;max-width:100%;height:auto;border:1px solid #ddd;"></div>\n</body></html>`;
  const filename = `browser-${sessionId.slice(0, 8)}-${step}.html`;
  const share = await createShareArtifact({
    shareRoot: ctx.shareRoot,
    title: `Browser Step ${step}`,
    summary: `Session ${sessionId} step ${step}: ${label}`,
    filename,
    html,
    ownerUserId: ctx.userId
  });
  const shareUrl = makeShareUrl(ctx.publicBaseUrl, share.id, share.filename);
  return { shareUrl, html };
}

async function getPageSnapshot(session: BrowserSession, screenshotUrl?: string): Promise<Record<string, unknown>> {
  return {
    sessionId: session.id,
    step: session.step,
    url: session.page.url(),
    title: await session.page.title().catch(() => ""),
    startedAt: session.startedAt,
    createdBy: session.createdBy,
    screenshotUrl
  };
}

async function screenshotAndRespond(
  session: BrowserSession,
  label: string,
  ctx: { publicBaseUrl: string; contentBaseUrl?: string; shareRoot: string },
  summary: string,
  extraLogs: string[] = []
): Promise<ToolResult> {
  const step = ++session.step;
  const { shareUrl } = await buildScreenshotArtifact(ctx, session.id, step, label, session.page);
  return {
    ok: true,
    summary,
    jobId: session.id,
    previewUrl: shareUrl,
    shareUrl,
    artifacts: [shareUrl],
    structuredContent: await getPageSnapshot(session, shareUrl),
    logs: [`Session ${session.id} step ${step}: ${label}`, ...extraLogs],
    errors: []
  };
}

export async function closeAllBrowserSessions(): Promise<string[]> {
  const closed: string[] = [];
  for (const [id, session] of Array.from(browserSessions.entries())) {
    await session.page.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
    browserSessions.delete(id);
    closed.push(id);
  }
  return closed;
}

export const browserTools: ToolModule[] = [
  {
    definition: {
      name: "open_browser_session",
      description: "Start a visible or headless browser session for step-by-step UI actions.",
      inputSchema: {
        type: "object",
        properties: {
          headless: { type: "boolean" },
          startUrl: { type: "string", format: "uri" },
          width: { type: "number" },
          height: { type: "number" },
          timeoutMs: { type: "number" }
        },
        required: [],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: openBrowserSessionSchema,
  handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof openBrowserSessionSchema>;
      if (browserSessions.size >= MAX_BROWSER_SESSIONS) {
        return { ok: false, summary: "Browser session limit reached. Close an existing session before opening a new one.", artifacts: [], logs: [], errors: ["Too many open browser sessions."] };
      }
      const id = randomUUID();
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: parsed.headless,
        args: ["--no-sandbox"]
      });
      const context = await browser.newContext({
        viewport: { width: parsed.width, height: parsed.height }
      });
      const page = await context.newPage();
      // Block SSRF/redirect/subresource access to internal hosts for the whole
      // session lifetime (covers later browser_navigate calls too).
      await installSsrfRouteGuard(page, false);

      const session: BrowserSession = {
        id,
        browser,
        page,
        step: 0,
        startedAt: new Date().toISOString(),
        createdBy: ctx.clientId,
        consoleEvents: [],
        pageErrors: []
      };
      page.on("console", (message) => {
        const source = normalizeConsoleSource(message.location());
        pushBounded(session.consoleEvents, {
          level: message.type(),
          text: message.text(),
          ...source
        }, MAX_SESSION_CONSOLE_LOGS);
      });
      page.on("pageerror", (error) => {
        pushBounded(session.pageErrors, {
          message: error.message,
          stack: error.stack
        }, MAX_SESSION_CONSOLE_LOGS);
      });
      browserSessions.set(id, session);

      const logs = [
        `Created ${parsed.headless ? "headless" : "visible"} browser session ${id}`,
        `Viewport: ${parsed.width}x${parsed.height}`
      ];

      if (parsed.startUrl) {
        try {
          await guardBrowserUrl(parsed.startUrl);
          await page.goto(parsed.startUrl, { waitUntil: "load", timeout: parsed.timeoutMs });
          logs.push(`Navigated to ${parsed.startUrl}`);
          const screenshotResult = await screenshotAndRespond(session, `Open session at ${parsed.startUrl}`, ctx, `Started browser session ${id}.`, [
            `startUrl=${parsed.startUrl}`
          ]);
          return {
            ...screenshotResult,
            jobId: id,
            summary: `Started browser session ${id}.`
          };
        } catch (error) {
          // The session is already registered; a failed initial navigation would
          // otherwise leave a live browser in the map, burning a session slot forever.
          await page.close().catch(() => undefined);
          await browser.close().catch(() => undefined);
          browserSessions.delete(id);
          throw error;
        }
      }

      return {
        ok: true,
        summary: `Started browser session ${id}.`,
        jobId: id,
        artifacts: [],
        structuredContent: await getPageSnapshot(session),
        logs,
        errors: []
      };
    }
  },
  {
    definition: {
      name: "browser_navigate",
      description: "Navigate an existing browser session to a URL and capture a step screenshot.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          url: { type: "string", format: "uri" },
          waitUntil: { type: "string", enum: ["domcontentloaded", "load", "networkidle"] },
          timeoutMs: { type: "number" }
        },
        required: ["sessionId", "url"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: browserNavigateSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof browserNavigateSchema>;
      const session = getSessionOrThrow(parsed.sessionId);
      await guardBrowserUrl(parsed.url);
      await session.page.goto(parsed.url, { waitUntil: parsed.waitUntil, timeout: parsed.timeoutMs });
      return screenshotAndRespond(session, `Navigate to ${parsed.url}`, ctx, `Navigated to ${parsed.url}.`, [`url=${parsed.url}`]);
    }
  },
  {
    definition: {
      name: "browser_click",
      description: "Click an element by selector in an active browser session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          selector: { type: "string" },
          timeoutMs: { type: "number" }
        },
        required: ["sessionId", "selector"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: browserActionSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof browserActionSchema>;
      const session = getSessionOrThrow(parsed.sessionId);
      await session.page.click(parsed.selector, { timeout: parsed.timeoutMs });
      return screenshotAndRespond(session, `Click ${parsed.selector}`, ctx, `Clicked ${parsed.selector}.`, [
        `selector=${parsed.selector}`
      ]);
    }
  },
  {
    definition: {
      name: "browser_type",
      description: "Type text into an input/textarea in an active browser session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          selector: { type: "string" },
          text: { type: "string" },
          clear: { type: "boolean" },
          timeoutMs: { type: "number" }
        },
        required: ["sessionId", "selector", "text"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: browserTypeSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof browserTypeSchema>;
      const session = getSessionOrThrow(parsed.sessionId);
      if (parsed.clear) {
        await session.page.fill(parsed.selector, "");
      }
      await session.page.fill(parsed.selector, parsed.text, { timeout: parsed.timeoutMs });
      return screenshotAndRespond(session, `Type in ${parsed.selector}`, ctx, `Typed text into ${parsed.selector}.`, [
        `selector=${parsed.selector}`,
        `length=${parsed.text.length}`
      ]);
    }
  },
  {
    definition: {
      name: "browser_press",
      description: "Press a keyboard key in an active browser session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          key: { type: "string" },
          timeoutMs: { type: "number" }
        },
        required: ["sessionId", "key"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: browserPressSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof browserPressSchema>;
      const session = getSessionOrThrow(parsed.sessionId);
      await session.page.keyboard.press(parsed.key);
      return screenshotAndRespond(session, `Press ${parsed.key}`, ctx, `Pressed key ${parsed.key}.`, [
        `key=${parsed.key}`
      ]);
    }
  },
  {
    definition: {
      name: "browser_screenshot",
      description: "Capture current page screenshot for a browser session and return share link.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          label: { type: "string" },
          fullPage: { type: "boolean" }
        },
        required: ["sessionId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: browserScreenshotSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof browserScreenshotSchema>;
      const session = getSessionOrThrow(parsed.sessionId);
      const step = ++session.step;
      const { shareUrl } = await buildScreenshotArtifact(ctx, session.id, step, parsed.label, session.page, parsed.fullPage);
      return {
        ok: true,
        summary: `Captured screenshot for session ${session.id} at step ${step}.`,
        jobId: session.id,
        previewUrl: shareUrl,
        shareUrl,
        artifacts: [shareUrl],
        structuredContent: await getPageSnapshot(session, shareUrl),
        logs: [`Session ${session.id} screenshot step ${step}`, `label=${parsed.label}`],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "browser_wait",
      description: "Wait for a short duration in browser session before next step.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          ms: { type: "number" }
        },
        required: ["sessionId", "ms"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: browserWaitSchema,
    handler: async (input) => {
      const parsed = input as z.infer<typeof browserWaitSchema>;
      const session = getSessionOrThrow(parsed.sessionId);
      await new Promise((resolve) => setTimeout(resolve, parsed.ms));
      return {
        ok: true,
        summary: `Waited ${parsed.ms}ms in session ${session.id}.`,
        jobId: session.id,
        artifacts: [],
        structuredContent: await getPageSnapshot(session),
        logs: [`session=${session.id}`, `waitMs=${parsed.ms}`],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "close_browser_session",
      description: "Close one browser session or all active sessions.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          all: { type: "boolean" }
        },
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: closeBrowserSessionSchema,
    handler: async (input) => {
      const parsed = input as z.infer<typeof closeBrowserSessionSchema>;
      const targets: Array<{ id: string; session: BrowserSession }> = parsed.all
        ? Array.from(browserSessions.entries()).map(([id, session]) => ({ id, session }))
        : parsed.sessionId
          ? [{ id: parsed.sessionId, session: getSessionOrThrow(parsed.sessionId) }]
          : [];

      if (targets.length === 0) {
        return {
          ok: false,
          summary: "No browser sessions to close.",
          artifacts: [],
          logs: [],
          errors: ["No browser session target matched."]
        };
      }

      const summary = [] as string[];
      for (const { id, session } of targets) {
        try {
          await session.page.close();
        } catch { /* already closed */ }
        try {
          await session.browser.close();
        } catch { /* already closed */ }
        browserSessions.delete(id);
        summary.push(`Closed browser session ${id}.`);
      }
      return {
        ok: true,
        summary: summary.join(" "),
        artifacts: [],
        logs: summary,
        errors: []
      };
    }
  }
];
