import { readTelemetryDay, type TelemetryEvent } from "./store.js";

// Per-dimension call metrics. The dimension is either a tool name or a client type.
export interface TelemetryMetric {
  key: string;
  calls: number;
  errors: number;
  errorRate: number; // 0..1
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  avgMs: number | null;
}

export interface TelemetryErrorSample {
  time: string;
  toolName?: string;
  clientType?: string;
  durationMs?: number;
  errorMessage?: string;
}

export interface TelemetrySummary {
  windowDays: number;
  from: string;
  to: string;
  totalCalls: number;
  totalErrors: number;
  errorRate: number;
  byTool: TelemetryMetric[];
  byClient: TelemetryMetric[];
  recentErrors: TelemetryErrorSample[];
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  // Nearest-rank: smallest value whose rank covers p% of samples.
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[index];
}

function metricsByKey(calls: TelemetryEvent[], keyOf: (event: TelemetryEvent) => string | undefined): TelemetryMetric[] {
  const groups = new Map<string, TelemetryEvent[]>();
  for (const event of calls) {
    const key = keyOf(event);
    if (!key) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(event);
    else groups.set(key, [event]);
  }
  const metrics: TelemetryMetric[] = [];
  for (const [key, events] of groups) {
    const errors = events.filter((event) => event.ok === false).length;
    const durations = events
      .map((event) => event.durationMs)
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b);
    const sum = durations.reduce((total, value) => total + value, 0);
    metrics.push({
      key,
      calls: events.length,
      errors,
      errorRate: events.length === 0 ? 0 : errors / events.length,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      maxMs: durations.length ? durations[durations.length - 1] : null,
      avgMs: durations.length ? Math.round(sum / durations.length) : null
    });
  }
  // Most problematic first: highest error count, then highest call volume.
  metrics.sort((a, b) => b.errors - a.errors || b.calls - a.calls);
  return metrics;
}

// Pure aggregation over an event set — no I/O, no clock. Tests drive this directly.
export function aggregateEvents(events: TelemetryEvent[]): Omit<TelemetrySummary, "windowDays" | "from" | "to"> {
  const calls = events.filter((event) => event.method === "tools/call");
  const totalErrors = calls.filter((event) => event.ok === false).length;
  const recentErrors: TelemetryErrorSample[] = calls
    .filter((event) => event.ok === false)
    .sort((a, b) => b.time.localeCompare(a.time))
    .slice(0, 20)
    .map((event) => ({
      time: event.time,
      toolName: event.toolName,
      clientType: event.clientType,
      durationMs: event.durationMs,
      errorMessage: event.errorMessage
    }));
  return {
    totalCalls: calls.length,
    totalErrors,
    errorRate: calls.length === 0 ? 0 : totalErrors / calls.length,
    byTool: metricsByKey(calls, (event) => event.toolName),
    byClient: metricsByKey(calls, (event) => event.clientType ?? "unknown"),
    recentErrors
  };
}

// UTC day strings (YYYY-MM-DD), newest first, for the last `n` days inclusive of `now`.
export function lastNDays(now: Date, n: number): string[] {
  const days: string[] = [];
  for (let offset = 0; offset < n; offset += 1) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    days.push(date.toISOString().slice(0, 10));
  }
  return days;
}

export async function summarizeTelemetry(windowDays = 7, now: Date = new Date()): Promise<TelemetrySummary> {
  const days = lastNDays(now, Math.max(1, windowDays));
  const events = (await Promise.all(days.map((day) => readTelemetryDay(day)))).flat();
  return {
    windowDays,
    from: days[days.length - 1],
    to: days[0],
    ...aggregateEvents(events)
  };
}
