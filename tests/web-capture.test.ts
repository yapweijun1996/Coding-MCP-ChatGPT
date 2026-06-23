import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { assertSafePublicUrl } from "../src/security/url.js";
import { getProjectManifest, readProjectFile } from "../src/projects/store.js";
import {
  getCaptureRoot,
  readWebpageCapture,
  saveWebpageCapture,
  type WebpageCapture
} from "../src/web-capture/capture.js";
import { webRebuildTools } from "../src/mcp/tools/web-rebuild.js";
import type { ToolContext } from "../src/mcp/types.js";

function fakeCapture(captureId = "11111111-1111-4111-8111-111111111111"): WebpageCapture {
  return {
    captureId,
    sourceUrl: "https://93.184.216.34/",
    finalUrl: "https://93.184.216.34/",
    mode: "single_page",
    capturedAt: "2026-06-16T00:00:00.000Z",
    pages: [{
      url: "https://93.184.216.34/",
      finalUrl: "https://93.184.216.34/",
      viewport: "desktop",
      title: "Example Product",
      canonicalUrl: "https://93.184.216.34/",
      metaDescription: "A clear product page for operations teams.",
      headings: [{ level: 1, text: "Example Product" }, { level: 2, text: "Plan work faster" }],
      visibleText: "Example Product helps operations teams plan work faster. Start a request, review status, and coordinate handoffs from one page.",
      links: [{ text: "Features", href: "https://93.184.216.34/features", sameOrigin: true }],
      images: [{ src: "https://93.184.216.34/hero.png", alt: "Product dashboard", width: 800, height: 500 }],
      scripts: ["https://93.184.216.34/app.js"],
      stylesheets: ["https://93.184.216.34/app.css"],
      forms: [{
        action: "https://93.184.216.34/contact",
        method: "POST",
        labels: ["Email"],
        fields: [{ name: "email", type: "email", placeholder: "Email", required: true }]
      }],
      interactions: [{ type: "link", text: "Features", selector: "a", href: "https://93.184.216.34/features" }],
      consoleErrors: [],
      pageErrors: [],
      resources: [{ url: "https://93.184.216.34/app.css", type: "stylesheet", method: "GET", status: 200, durationMs: 12 }]
    }],
    resources: [{ url: "https://93.184.216.34/app.css", type: "stylesheet", method: "GET", status: 200, durationMs: 12 }],
    forms: [{
      action: "https://93.184.216.34/contact",
      method: "POST",
      labels: ["Email"],
      fields: [{ name: "email", type: "email", placeholder: "Email", required: true }]
    }],
    interactions: [{ type: "link", text: "Features", selector: "a", href: "https://93.184.216.34/features" }],
    issues: [],
    warnings: []
  };
}

function tool(name: string) {
  const found = webRebuildTools.find((item) => item.definition.name === name);
  assert.ok(found, `Missing tool ${name}`);
  return found;
}

async function withTempRoot<T>(run: (root: string, ctx: ToolContext) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-web-capture-"));
  try {
    const ctx: ToolContext = {
      publicBaseUrl: "https://example.test",
      workspaceRoot: root,
      commandTimeoutMs: 1000,
      shareRoot: path.join(root, "shares"),
      projectRoot: path.join(root, "projects"),
      clientId: "test-client"
    };
    return await run(root, ctx);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("assertSafePublicUrl allows public https IPs and rejects unsafe URLs", async () => {
  assert.equal((await assertSafePublicUrl("https://93.184.216.34/")).protocol, "https:");
  await assert.rejects(assertSafePublicUrl("http://93.184.216.34/"), /Only https/);
  await assert.rejects(assertSafePublicUrl("https://localhost/"), /Localhost/);
  await assert.rejects(assertSafePublicUrl("https://127.0.0.1/"), /Private or reserved IP/);
  await assert.rejects(assertSafePublicUrl("https://10.0.0.1/"), /Private or reserved IP/);
});

test("capture_webpage schema applies defaults and rejects unsupported values", () => {
  const schema = tool("capture_webpage").schema;
  assert.ok(schema);
  const parsed = schema.parse({ url: "https://93.184.216.34/" }) as { mode: string; maxPages: number; viewports: string[] };
  assert.equal(parsed.mode, "single_page");
  assert.equal(parsed.maxPages, 1);
  assert.deepEqual(parsed.viewports, ["desktop", "mobile"]);
  assert.throws(() => schema.parse({ url: "https://93.184.216.34/", maxPages: 6 }), /Number must be less than or equal to 5/);
  assert.throws(() => schema.parse({ url: "https://93.184.216.34/", mode: "deep_crawl" }), /Invalid enum value/);
});

test("convert_design_to_static_project creates editable component output and validation report", async () => {
  await withTempRoot(async (_root, ctx) => {
    const convertTool = tool("convert_design_to_static_project");
    const parsed = convertTool.schema!.parse({
      title: "Ops Console Redesign",
      surface: "admin_panel",
      designBrief: "A dense but calm operations console with a left sidebar, top metrics, table rows, and clear retry feedback.",
      referenceImages: ["artifact://design-target.png"],
      components: ["sidebar", "metric card", "data table", "retry toast"],
      wireframe: [
        { id: "nav", role: "sidebar", text: "Persistent project navigation", priority: "primary" },
        { id: "metrics", role: "metric-card", text: "Four operational counters", priority: "primary" },
        { id: "table", role: "data-table", text: "Recent jobs with status pills", priority: "secondary" }
      ],
      styleTokens: { primary: "#0b695d", accent: "#d5a11e", background: "#f5f7f4", text: "#17211d", radius: 8, density: "compact" },
      responsiveVariants: ["desktop", "mobile"],
      publish: false,
      browserValidation: false
    });
    const result = await convertTool.handler(parsed, ctx);

    assert.equal(result.ok, true);
    const projectId = result.jobId!;
    const manifest = await getProjectManifest(ctx.projectRoot, projectId);
    assert.equal(manifest.metadata.status, "draft");
    assert.deepEqual(manifest.files.map((file) => file.path), ["components.md", "design-system.json", "index.html", "script.js", "styles.css", "visual-validation.json"]);

    const html = await readProjectFile(ctx.projectRoot, projectId, "index.html");
    assert.match(html, /Ops Console Redesign/);
    assert.match(html, /data-component="sidebar"/);
    const designSystem = JSON.parse(await readProjectFile(ctx.projectRoot, projectId, "design-system.json")) as { components: string[]; tokens: { primary: string } };
    assert.ok(designSystem.components.includes("retry-toast"));
    assert.equal(designSystem.tokens.primary, "#0b695d");
    const visual = JSON.parse(await readProjectFile(ctx.projectRoot, projectId, "visual-validation.json")) as { score: number; confidence: string; signals: string[] };
    assert.ok(visual.score > 0.5);
    assert.equal(visual.confidence, "medium");
    assert.ok(visual.signals.includes("reference-images"));
    const components = await readProjectFile(ctx.projectRoot, projectId, "components.md");
    assert.match(components, /retry-toast/);
  });
});

test("capture storage writes and reads capture JSON", async () => {
  await withTempRoot(async (root) => {
    const captureRoot = getCaptureRoot(root);
    const capture = fakeCapture();
    await saveWebpageCapture(captureRoot, capture);
    assert.equal((await readWebpageCapture(captureRoot, capture.captureId)).sourceUrl, capture.sourceUrl);
    await assert.rejects(readWebpageCapture(captureRoot, "22222222-2222-4222-8222-222222222222"), /Capture not found/);
  });
});

test("analyze and generate tools create a validated static project from a capture", async () => {
  await withTempRoot(async (root, ctx) => {
    const capture = fakeCapture();
    await saveWebpageCapture(getCaptureRoot(root), capture);

    const analyzeTool = tool("analyze_webpage_capture");
    const analyzeResult = await analyzeTool.handler(analyzeTool.schema!.parse({ captureId: capture.captureId }), ctx);
    assert.equal(analyzeResult.ok, true);
    const analysisId = (analyzeResult.structuredContent as { analysisId: string }).analysisId;
    assert.match(analysisId, /^[a-f0-9-]{36}$/);

    const generateTool = tool("generate_improved_static_page");
    const generateResult = await generateTool.handler(generateTool.schema!.parse({
      captureId: capture.captureId,
      analysisId,
      title: "Improved Example Product",
      preserveContent: true,
      browserValidation: false
    }), ctx);
    assert.equal(generateResult.ok, true);
    assert.ok(generateResult.shareUrl?.startsWith("https://example.test/share/"));

    const projectId = generateResult.jobId!;
    const manifest = await getProjectManifest(ctx.projectRoot, projectId);
    assert.equal(manifest.metadata.status, "published");
    assert.deepEqual(manifest.files.map((file) => file.path), ["index.html", "script.js", "styles.css"]);
    const html = await readProjectFile(ctx.projectRoot, projectId, "index.html");
    assert.match(html, /Example Product/);
    assert.match(html, /lead-form/);
  });
});
