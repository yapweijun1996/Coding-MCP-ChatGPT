import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import type { ToolContext } from "../src/mcp/types.js";
import { createProject } from "../src/projects/store.js";
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
    clientId: "demo-analytics-test"
  };
}

test("demo analytics tools track page views, devices, clicks, errors, funnels, and reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "demo-analytics-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Demo analytics project", createdByClientId: "coder" });

    const plan = await callTool("create_demo_analytics_plan", {
      projectId: project.id,
      name: "Demo launch analytics",
      goals: ["Understand onboarding drop-off"],
      trackedEvents: ["page_view", "click", "error", "funnel_step"],
      funnels: [
        {
          id: "signup",
          label: "Signup funnel",
          steps: [
            { id: "landing", label: "Viewed landing", eventType: "page_view", path: "/" },
            { id: "cta", label: "Clicked CTA", eventType: "click", target: "start-trial" },
            { id: "form", label: "Viewed signup form", eventType: "page_view", path: "/signup" }
          ]
        }
      ],
      privacyNotes: ["No email addresses or credentials."]
    }, ctx);
    assert.equal(plan.ok, true);
    assert.equal((plan.structuredContent as { plan: { id: string } }).plan.id, "analytics_plan_001");

    const recorded = await callTool("record_demo_analytics_event", {
      projectId: project.id,
      events: [
        { eventType: "page_view", sessionId: "s1", timestamp: "2026-06-25T01:00:00.000Z", path: "/", deviceType: "desktop" },
        { eventType: "click", sessionId: "s1", timestamp: "2026-06-25T01:00:02.000Z", path: "/", deviceType: "desktop", target: "start-trial", funnelId: "signup" },
        { eventType: "page_view", sessionId: "s1", timestamp: "2026-06-25T01:00:04.000Z", path: "/signup", deviceType: "desktop" },
        { eventType: "page_view", sessionId: "s2", timestamp: "2026-06-25T01:05:00.000Z", path: "/", deviceType: "mobile" },
        { eventType: "click", sessionId: "s2", timestamp: "2026-06-25T01:05:03.000Z", path: "/", deviceType: "mobile", target: "pricing-link" },
        { eventType: "error", sessionId: "s2", timestamp: "2026-06-25T01:05:05.000Z", path: "/", deviceType: "mobile", errorMessage: "Signup API returned 500", errorSource: "fetch" },
        { eventType: "page_view", sessionId: "s3", timestamp: "2026-06-25T01:10:00.000Z", path: "/", deviceType: "tablet" }
      ]
    }, ctx);
    assert.equal(recorded.ok, true);
    assert.equal((recorded.structuredContent as { events: unknown[] }).events.length, 7);

    const summaryResult = await callTool("summarize_demo_analytics", { projectId: project.id }, ctx);
    const summary = (summaryResult.structuredContent as {
      summary: {
        sessions: number;
        pageViews: number;
        clicks: number;
        errors: number;
        byDeviceType: Record<string, number>;
        topPages: Array<{ key: string; count: number }>;
        topClickTargets: Array<{ key: string; count: number }>;
        topErrors: Array<{ key: string; count: number }>;
      };
    }).summary;
    assert.equal(summary.sessions, 3);
    assert.equal(summary.pageViews, 4);
    assert.equal(summary.clicks, 2);
    assert.equal(summary.errors, 1);
    assert.equal(summary.byDeviceType.mobile, 3);
    assert.deepEqual(summary.topPages[0], { key: "/", count: 3 });
    assert.equal(summary.topClickTargets.some((item) => item.key === "start-trial" && item.count === 1), true);
    assert.equal(summary.topErrors[0].key, "Signup API returned 500");

    const mobileEvents = await callTool("list_demo_analytics_events", { projectId: project.id, deviceType: "mobile", limit: 10 }, ctx);
    assert.equal((mobileEvents.structuredContent as { events: unknown[] }).events.length, 3);

    const funnelResult = await callTool("analyze_demo_interaction_funnel", { projectId: project.id, funnelId: "signup" }, ctx);
    const funnel = (funnelResult.structuredContent as {
      report: {
        totalSessions: number;
        completedSessions: number;
        completionRate: number;
        steps: Array<{ id: string; reached: number; dropOff: number; dropOffRate: number }>;
      };
    }).report;
    assert.equal(funnel.totalSessions, 3);
    assert.equal(funnel.completedSessions, 1);
    assert.equal(funnel.completionRate, 0.3333);
    assert.equal(funnel.steps[0].reached, 3);
    assert.equal(funnel.steps[1].reached, 1);
    assert.equal(funnel.steps[1].dropOff, 2);
    assert.equal(funnel.steps[1].dropOffRate, 0.6667);

    const report = await callTool("export_demo_analytics_report", { projectId: project.id }, ctx);
    assert.equal(report.ok, true);
    assert.deepEqual(report.artifacts, ["analytics/demo-analytics-report.md"]);
    const markdown = await readFile(path.join(ctx.projectRoot, project.id, "files/analytics/demo-analytics-report.md"), "utf8");
    assert.match(markdown, /# Demo Analytics Report/);
    assert.match(markdown, /Page views: 4/);
    assert.match(markdown, /Signup API returned 500/);
    assert.match(markdown, /Signup funnel/);
    assert.match(markdown, /Clicked CTA/);

    const store = JSON.parse(await readFile(path.join(ctx.projectRoot, project.id, "files/analytics/demo-analytics.json"), "utf8")) as { plans: unknown[]; events: unknown[] };
    assert.equal(store.plans.length, 1);
    assert.equal(store.events.length, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyze_demo_interaction_funnel rejects unknown funnels", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "demo-analytics-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Demo analytics project", createdByClientId: "coder" });
    const result = await callTool("analyze_demo_interaction_funnel", { projectId: project.id, funnelId: "missing" }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.summary, /Funnel missing not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("demo analytics tools are exposed through core, coding, debug, and demo-analytics skills", () => {
  const toolNames = ["create_demo_analytics_plan", "record_demo_analytics_event", "list_demo_analytics_events", "summarize_demo_analytics", "analyze_demo_interaction_funnel", "export_demo_analytics_report"];
  for (const skillId of ["core", "coding", "debug", "demo-analytics"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    for (const toolName of toolNames) {
      assert.ok(skill!.toolNames.includes(toolName), `${skillId} exposes ${toolName}`);
    }
  }
});
