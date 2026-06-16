export interface ActivityEvent {
  id: number;
  time: string;
  clientId: string;
  method: string;
  toolName?: string;
  ok: boolean;
  summary: string;
}

const maxEvents = 200;
const events: ActivityEvent[] = [];
let nextId = 1;

export function recordActivity(input: Omit<ActivityEvent, "id" | "time">): ActivityEvent {
  const event: ActivityEvent = {
    id: nextId++,
    time: new Date().toISOString(),
    ...input
  };
  events.unshift(event);
  if (events.length > maxEvents) events.pop();
  return event;
}

export function listActivity(limit = 80): ActivityEvent[] {
  return events.slice(0, limit);
}

