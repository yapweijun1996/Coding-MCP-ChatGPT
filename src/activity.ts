import { randomUUID } from "node:crypto";
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
  errorCode?: string | number;
  errorMessage?: string;
  inputBytes?: number;
  args?: unknown;
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
  recordTelemetry({ id, time, ...event });
}

export function listActivity(limit = 80): ActivityEvent[] {
  // Newest first. Events are appended oldest -> newest, so take the tail and reverse;
  // returning slice(0, limit) would surface the OLDEST events and hide recent activity
  // once more than `limit` events have accumulated — the opposite of what a monitoring
  // view needs.
  return events.slice(-limit).reverse();
}
