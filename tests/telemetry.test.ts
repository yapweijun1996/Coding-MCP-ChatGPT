import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeTelemetry, isTelemetryEnabled, recordTelemetry, telemetryDayFilePath } from "../src/telemetry/store.js";
import { aggregateEvents, lastNDays, summarizeTelemetry, type TelemetrySummary } from "../src/telemetry/aggregate.js";
import type { TelemetryEvent } from "../src/telemetry/store.js";
import { recordActivity, listActivity } from "../src/activity.js";

async function waitForFile(dir: string): Promise<string[]> {
  // Telemetry writes are fire-and-forget; poll briefly for the async append to land.
  for (let i = 0; i < 40; i += 1) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    if (entries.length > 0) return entries;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readdir(dir).catch(() => [] as string[]);
}

test("recordTelemetry appends a JSON line to a per-day file with full fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telemetry-"));
  try {
    initializeTelemetry(root);
    assert.equal(isTelemetryEnabled(), true);
    const time = "2026-06-20T10:00:00.000Z";
    recordTelemetry({
      id: "abc",
      time,
      clientId: "client-1",
      clientType: "Claude 1.0",
      method: "tools/call",
      toolName: "run_build",
      ok: false,
      durationMs: 1234,
      errorMessage: "build failed",
      inputBytes: 42,
      args: { projectId: "p1" },
      summary: "run_build failed."
    });
    const files = await waitForFile(root);
    assert.deepEqual(files, ["2026-06-20.jsonl"]);
    const raw = await readFile(telemetryDayFilePath(time), "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.toolName, "run_build");
    assert.equal(event.clientType, "Claude 1.0");
    assert.equal(event.durationMs, 1234);
    assert.equal(event.ok, false);
    assert.equal(event.args.projectId, "p1");
  } finally {
    initializeTelemetry("");
    await rm(root, { recursive: true, force: true });
  }
});

test("recordTelemetry truncates oversized args", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telemetry-"));
  try {
    initializeTelemetry(root);
    recordTelemetry({ id: "big", time: "2026-06-20T11:00:00.000Z", method: "tools/call", toolName: "write_asset", ok: true, args: { blob: "x".repeat(20000) } });
    await waitForFile(root);
    const raw = await readFile(telemetryDayFilePath("2026-06-20T11:00:00.000Z"), "utf8");
    const event = JSON.parse(raw.trim().split("\n").at(-1) as string);
    assert.equal(typeof event.args, "string");
    assert.match(event.args, /\[truncated \d+ chars\]/);
  } finally {
    initializeTelemetry("");
    await rm(root, { recursive: true, force: true });
  }
});

test("recordTelemetry is a no-op (no throw) when telemetry is not initialized", async () => {
  initializeTelemetry("");
  assert.equal(isTelemetryEnabled(), false);
  assert.doesNotThrow(() => recordTelemetry({ id: "x", time: new Date().toISOString(), method: "ping", ok: true }));
});

test("aggregateEvents computes per-tool and per-client metrics with percentiles", () => {
  const mk = (overrides: Partial<TelemetryEvent>): TelemetryEvent => ({
    id: "x", time: "2026-06-20T10:00:00.000Z", method: "tools/call", clientId: "c", ok: true, ...overrides
  });
  const events: TelemetryEvent[] = [
    mk({ toolName: "run_build", clientType: "claude", ok: true, durationMs: 100 }),
    mk({ toolName: "run_build", clientType: "claude", ok: false, durationMs: 200, errorMessage: "boom", time: "2026-06-20T10:05:00.000Z" }),
    mk({ toolName: "run_build", clientType: "gemini", ok: true, durationMs: 300 }),
    mk({ toolName: "run_build", clientType: "gemini", ok: true, durationMs: 900 }),
    mk({ toolName: "list_projects", clientType: "claude", ok: true, durationMs: 10 }),
    mk({ id: "init", method: "initialize", ok: true }) // must be excluded from call metrics
  ];
  const agg = aggregateEvents(events);
  assert.equal(agg.totalCalls, 5);
  assert.equal(agg.totalErrors, 1);

  const build = agg.byTool.find((m) => m.key === "run_build");
  assert.ok(build);
  assert.equal(build!.calls, 4);
  assert.equal(build!.errors, 1);
  assert.equal(build!.maxMs, 900);
  assert.equal(build!.p50Ms, 200); // sorted [100,200,300,900], nearest-rank p50 -> index 1
  assert.equal(build!.p95Ms, 900);

  // Most problematic tool sorts first (run_build has the only error).
  assert.equal(agg.byTool[0].key, "run_build");
  // Per-client split present.
  assert.ok(agg.byClient.find((m) => m.key === "claude"));
  assert.ok(agg.byClient.find((m) => m.key === "gemini"));
  // Recent errors captured with message.
  assert.equal(agg.recentErrors.length, 1);
  assert.equal(agg.recentErrors[0].errorMessage, "boom");
});

test("summarizeTelemetry reads persisted day files and aggregates end to end", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telemetry-"));
  try {
    initializeTelemetry(root);
    const day = "2026-06-20T12:00:00.000Z";
    recordTelemetry({ id: "1", time: day, clientId: "c", clientType: "claude", method: "tools/call", toolName: "run_build", ok: true, durationMs: 120 });
    recordTelemetry({ id: "2", time: "2026-06-20T12:01:00.000Z", clientId: "c", clientType: "claude", method: "tools/call", toolName: "run_build", ok: false, durationMs: 80, errorMessage: "fail" });
    await waitForFile(root);
    // Poll until both appends have landed (fire-and-forget).
    let summary = await summarizeTelemetry(1, new Date(day));
    for (let i = 0; i < 40 && summary.totalCalls < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      summary = await summarizeTelemetry(1, new Date(day));
    }
    assert.equal(summary.totalCalls, 2);
    assert.equal(summary.totalErrors, 1);
    assert.equal(summary.byTool[0].key, "run_build");
    assert.equal(summary.byTool[0].errors, 1);
    assert.equal(summary.byClient[0].key, "claude");
  } finally {
    initializeTelemetry("");
    await rm(root, { recursive: true, force: true });
  }
});

test("lastNDays returns newest-first UTC day strings", () => {
  const days = lastNDays(new Date("2026-06-20T08:00:00.000Z"), 3);
  assert.deepEqual(days, ["2026-06-20", "2026-06-19", "2026-06-18"]);
});

test("aggregateEvents handles an empty set without dividing by zero", () => {
  const agg: Omit<TelemetrySummary, "windowDays" | "from" | "to"> = aggregateEvents([]);
  assert.equal(agg.totalCalls, 0);
  assert.equal(agg.errorRate, 0);
  assert.deepEqual(agg.byTool, []);
});

test("listActivity returns newest events first", () => {
  recordActivity({ clientId: "test", method: "tools/call", toolName: "first_tool", ok: true, summary: "first" });
  recordActivity({ clientId: "test", method: "tools/call", toolName: "second_tool", ok: true, summary: "second" });
  const recent = listActivity(5);
  const firstIdx = recent.findIndex((event) => event.toolName === "first_tool");
  const secondIdx = recent.findIndex((event) => event.toolName === "second_tool");
  assert.ok(secondIdx !== -1 && firstIdx !== -1);
  assert.ok(secondIdx < firstIdx, "the more recently recorded event must come first");
});
