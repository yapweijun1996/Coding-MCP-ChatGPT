import { randomUUID } from "node:crypto";
import { runtimeTelemetrySnapshot } from "./telemetry/runtime.js";
import { recordTelemetry } from "./telemetry/store.js";

export interface ActivityEvent {
  id: string;
  time: string;
  clientId: string;
  userId?: string;
  method: string;
  toolName?: string;
  ok: boolean;
  summary: string;
}

// recordActivity accepts richer fields than the live ring displays. The ring keeps a slim
// event (cheap, capped); the persistent telemetry sink keeps the full event. This is the
// single capture chokepoint — callers record once and both tiers are fed.
export interface RecordActivityInput {
  clientId: string;
  userId?: string;
  method: string;
  toolName?: string;
  ok: boolean;
  summary: string;
  clientType?: string;
  protocolVersion?: string;
  durationMs?: number;
  queueWaitMs?: number;
  executionMs?: number;
  queueDepth?: number;
  eventLoopDelayMs?: number;
  rssBytes?: number;
  toolListCount?: number;
  toolListBytes?: number;
  errorCode?: string | number;
  errorMessage?: string;
  failureCategory?: "input_validation" | "environment" | "execution" | "timeout" | "cancelled";
  inputBytes?: number;
  args?: unknown;
}

function inferFailureCategory(event: RecordActivityInput): RecordActivityInput["failureCategory"] {
  if (event.ok) return undefined;
  const text = `${event.summary} ${event.errorMessage ?? ""}`.toLowerCase();
  if (/\bcancel(?:led|ed)?\b/.test(text)) return "cancelled";
  if (/\btimeout\b|timed out|\b524\b/.test(text)) return "timeout";
  if (/invalid arguments|requires .*?(?:number|string|array)|invalid enum|must be|missing .*?(?:field|parameter)|zod/.test(text)) return "input_validation";
  if (/enoent|not installed|executable doesn't exist|not on .*path|could not be created|webgl|missing script/.test(text)) return "environment";
  return "execution";
}

const MAX_EVENTS = 500;
const events: ActivityEvent[] = [];

export function recordActivity(event: RecordActivityInput): void {
  const id = randomUUID();
  const time = new Date().toISOString();
  // Live in-memory ring: slim event only, so the 500-cap buffer stays lean even when the
  // call carried large arguments.
  events.push({
    id,
    time,
    clientId: event.clientId,
    userId: event.userId,
    method: event.method,
    toolName: event.toolName,
    ok: event.ok,
    summary: event.summary
  });
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  // Durable tier: full event, fire-and-forget (no-op until telemetry is initialized).
  recordTelemetry({
    id,
    time,
    ...runtimeTelemetrySnapshot(),
    ...event,
    failureCategory: event.failureCategory ?? inferFailureCategory(event)
  });
}

export function listActivity(limit = 80): ActivityEvent[] {
  // Newest first. Events are appended oldest -> newest, so take the tail and reverse;
  // returning slice(0, limit) would surface the OLDEST events and hide recent activity
  // once more than `limit` events have accumulated — the opposite of what a monitoring
  // view needs.
  return events.slice(-limit).reverse();
}
