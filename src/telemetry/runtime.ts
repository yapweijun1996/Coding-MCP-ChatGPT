import { monitorEventLoopDelay } from "node:perf_hooks";

export interface RuntimeTelemetrySnapshot {
  eventLoopDelayMs?: number;
  rssBytes: number;
}

// One low-resolution histogram per process is substantially cheaper than installing a
// timer for every request. The value is the process-lifetime p95, which is stable enough
// to correlate latency regressions with event-loop pressure without affecting the hot path.
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
let cachedAt = 0;
let cachedSnapshot: RuntimeTelemetrySnapshot | undefined;

export function runtimeTelemetrySnapshot(): RuntimeTelemetrySnapshot {
  const now = Date.now();
  if (cachedSnapshot && now - cachedAt < 1000) return cachedSnapshot;
  const delayMs = eventLoopDelay.count > 0
    ? Math.round((eventLoopDelay.percentile(95) / 1_000_000) * 1000) / 1000
    : undefined;
  cachedAt = now;
  cachedSnapshot = {
    eventLoopDelayMs: Number.isFinite(delayMs) ? delayMs : undefined,
    rssBytes: process.memoryUsage.rss()
  };
  return cachedSnapshot;
}
