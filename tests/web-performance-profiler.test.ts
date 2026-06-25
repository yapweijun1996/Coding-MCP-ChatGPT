import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getToolModule } from "../src/mcp/registry.js";
import type { ToolContext } from "../src/mcp/types.js";
import { skillRegistry } from "../src/skills/registry.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "web-performance-profiler-test"
  };
}

test("profile_web_performance reports FPS, long tasks, memory, layout, scripts, and selectors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "web-performance-profiler-"));
  try {
    const ctx = toolContext(root);
    const profiler = getToolModule("profile_web_performance");
    assert.ok(profiler, "profile_web_performance registered");

    const result = await profiler!.handler({
      targetFps: 60,
      longTaskThresholdMs: 50,
      sampleMetrics: {
        fpsSamples: [60, 58, 24, 22, 20, 55],
        longTasks: [
          { name: "hydrate dashboard", duration: 180, startTime: 120 },
          { name: "chart render", duration: 90, startTime: 420 }
        ],
        memoryTimeline: [
          { usedJSHeapSize: 30 * 1024 * 1024, totalJSHeapSize: 64 * 1024 * 1024, timestampMs: 0 },
          { usedJSHeapSize: 48 * 1024 * 1024, totalJSHeapSize: 80 * 1024 * 1024, timestampMs: 3000 }
        ],
        layoutShifts: [{ value: 0.14, startTime: 700 }],
        resources: [
          { name: "https://example.test/app.js", initiatorType: "script", duration: 420, transferSize: 320000 },
          { name: "https://example.test/hero.png", initiatorType: "img", duration: 1300, transferSize: 900000 }
        ],
        scripts: [{ name: "https://example.test/app.js", duration: 420, transferSize: 320000 }],
        selectorStats: [{ selector: ".row .cell button", count: 1800, estimatedCost: 3200 }]
      }
    }, ctx);

    assert.equal(result.ok, false);
    const payload = result.structuredContent as {
      score: number;
      status: string;
      fpsSummary: { average: number; droppedFrameRatio: number };
      longTaskBreakdown: { count: number; totalBlockingTime: number };
      memoryGrowthBytes: number;
      layoutReport: { cumulativeLayoutShift: number };
      paintReport: { estimatedPaintResourceMs: number };
      scriptHotspots: Array<{ name: string }>;
      heavySelectors: Array<{ selector: string }>;
      animationJankReport: { samplesBelowTarget: number };
      findings: Array<{ category: string; severity: string }>;
      recommendations: string[];
      reportUrl: string;
      jsonUrl: string;
    };
    assert.equal(payload.status, "poor");
    assert.ok(payload.score < 100);
    assert.ok(payload.fpsSummary.average < 60);
    assert.ok(payload.fpsSummary.droppedFrameRatio > 0);
    assert.equal(payload.longTaskBreakdown.count, 2);
    assert.ok(payload.longTaskBreakdown.totalBlockingTime >= 170);
    assert.ok(payload.memoryGrowthBytes > 10 * 1024 * 1024);
    assert.equal(payload.layoutReport.cumulativeLayoutShift, 0.14);
    assert.ok(payload.paintReport.estimatedPaintResourceMs >= 1300);
    assert.equal(payload.scriptHotspots[0].name, "https://example.test/app.js");
    assert.equal(payload.heavySelectors[0].selector, ".row .cell button");
    assert.ok(payload.animationJankReport.samplesBelowTarget >= 4);
    assert.ok(payload.findings.some((finding) => finding.category === "fps" && finding.severity === "high"));
    assert.ok(payload.findings.some((finding) => finding.category === "long_task"));
    assert.ok(payload.findings.some((finding) => finding.category === "memory"));
    assert.ok(payload.recommendations.some((item) => item.includes("Reduce animation work")));
    assert.match(payload.reportUrl, /\/share\//);
    assert.match(payload.jsonUrl, /\/artifact\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile_web_performance is exposed through browser QA, observability, and debug skills", () => {
  const browserQa = skillRegistry.find((entry) => entry.id === "browser-qa");
  const observability = skillRegistry.find((entry) => entry.id === "agent-browser-observability");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(browserQa?.toolNames.includes("profile_web_performance"));
  assert.ok(observability?.toolNames.includes("profile_web_performance"));
  assert.ok(debug?.toolNames.includes("profile_web_performance"));
});
