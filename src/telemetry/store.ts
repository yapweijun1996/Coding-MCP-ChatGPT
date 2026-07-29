import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { withKeyedLock } from "../shared/keyed-lock.js";
import { redactSecrets } from "../shared/redact.js";

// Persistent telemetry sink for MCP calls. This is the durable, accumulating tier behind
// the in-memory activity ring (see activity.ts) — same capture chokepoint, two retention
// tiers. Writes are fire-and-forget and failure-isolated: a disk error must never throw
// into or delay the MCP request path. Events are appended as JSON Lines to a per-day file
// so they survive restarts and can be aggregated offline.
export interface TelemetryEvent {
  id: string;
  time: string;
  clientId?: string;
  clientType?: string;
  // MCP revision negotiated at initialize, carried onto every later call from the same
  // client. Needed to know which clients can actually use version-gated features such as
  // outputSchema (introduced in 2025-06-18) before building against them.
  protocolVersion?: string;
  userId?: string;
  method: string;
  toolName?: string;
  ok: boolean;
  durationMs?: number;
  errorCode?: string | number;
  errorMessage?: string;
  inputBytes?: number;
  args?: unknown;
  summary?: string;
}

let telemetryRoot = "";
const maxArgsChars = 4000;

export function initializeTelemetry(root: string): void {
  telemetryRoot = root;
}

export function isTelemetryEnabled(): boolean {
  return Boolean(telemetryRoot);
}

export function telemetryDayFilePath(time: string): string {
  // YYYY-MM-DD from an ISO timestamp.
  return path.join(telemetryRoot, `${time.slice(0, 10)}.jsonl`);
}

export function recordTelemetry(event: TelemetryEvent): void {
  if (!telemetryRoot) return;
  void persist(event).catch((error) => {
    // Swallow-and-log: telemetry must never break the request that produced it.
    console.error("Telemetry write failed:", error instanceof Error ? error.message : error);
  });
}

// Read one day's persisted events (YYYY-MM-DD). Returns [] for a missing day and skips any
// corrupt line rather than throwing, so aggregation over a date range is resilient.
export async function readTelemetryDay(day: string): Promise<TelemetryEvent[]> {
  if (!telemetryRoot) return [];
  let raw: string;
  try {
    raw = await readFile(path.join(telemetryRoot, `${day}.jsonl`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: TelemetryEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as TelemetryEvent);
    } catch {
      // Skip a torn final line (e.g. a write interrupted by a crash) instead of failing.
    }
  }
  return events;
}

async function persist(event: TelemetryEvent): Promise<void> {
  const safe: TelemetryEvent = { ...event };
  if (safe.args !== undefined) {
    safe.args = redactSecrets(safe.args);
    let serialized: string;
    try {
      serialized = JSON.stringify(safe.args) ?? "";
    } catch {
      serialized = "";
    }
    if (serialized.length > maxArgsChars) {
      safe.args = `${serialized.slice(0, maxArgsChars)}...[truncated ${serialized.length} chars]`;
    }
  }
  const filePath = telemetryDayFilePath(event.time);
  const line = `${JSON.stringify(safe)}\n`;
  // A single O_APPEND write is only atomic below the OS pipe-buffer size; a line with a
  // ~4000-char args field can exceed it and interleave with a concurrent append, producing
  // a torn line the reader silently drops. Serialize appends to each day file to prevent it.
  await withKeyedLock(filePath, async () => {
    await mkdir(telemetryRoot, { recursive: true });
    await appendFile(filePath, line, "utf8");
  });
}
