import { z } from "zod";
import {
  getProjectManifest,
  readProjectFile,
  writeProjectFile
} from "../../projects/store.js";
import type { ProjectTaskHistoryItem } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const auditEventTypeSchema = z.enum(["tool_call", "file_change", "publish", "failure", "retry", "approval", "delivery", "validation", "other"]);
const auditStatusSchema = z.enum(["planned", "started", "succeeded", "failed", "blocked", "approved", "rejected"]);

const auditEventSchema = z.object({
  id: z.string().regex(/^audit_[a-zA-Z0-9_-]{1,80}$/).optional(),
  type: auditEventTypeSchema,
  status: auditStatusSchema,
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(2000),
  toolName: z.string().min(1).max(160).optional(),
  paths: z.array(z.string().min(1).max(300)).max(100).optional().default([]),
  artifacts: z.array(z.string().min(1).max(500)).max(100).optional().default([]),
  approvedBy: z.string().min(1).max(160).optional(),
  relatedId: z.string().min(1).max(160).optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({})
});

const recordAuditEventInputSchema = auditEventSchema.extend({
  projectId: z.string().min(8).max(80),
  occurredAt: z.string().datetime().optional(),
  auditPath: z.string().min(1).max(240).optional().default("audit-log/audit-log.json")
});

const listAuditEventsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  auditPath: z.string().min(1).max(240).optional().default("audit-log/audit-log.json"),
  type: auditEventTypeSchema.optional(),
  status: auditStatusSchema.optional(),
  toolName: z.string().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(500).optional().default(100)
});

const importProjectActivityAuditInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  historyLimit: z.number().int().min(1).max(500).optional().default(100),
  auditPath: z.string().min(1).max(240).optional().default("audit-log/audit-log.json")
});

const summarizeAuditLogInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  auditPath: z.string().min(1).max(240).optional().default("audit-log/audit-log.json")
});

const recordDeliveryAuditInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(200),
  deliveredFiles: z.array(z.string().min(1).max(300)).max(200).optional().default([]),
  validation: z.array(z.string().min(1).max(500)).max(100).optional().default([]),
  publishedUrl: z.string().min(1).max(1000).optional(),
  notes: z.string().max(2000).optional().default(""),
  auditPath: z.string().min(1).max(240).optional().default("audit-log/audit-log.json")
});

const exportAuditLogReportInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(200).optional().default("Audit Log Report"),
  auditPath: z.string().min(1).max(240).optional().default("audit-log/audit-log.json"),
  outputPath: z.string().min(1).max(240).optional().default("audit-log/audit-report.md")
});

type AuditEvent = z.infer<typeof auditEventSchema> & { id: string; occurredAt: string };

interface AuditLogFile {
  version: 1;
  projectId: string;
  updatedAt: string;
  events: AuditEvent[];
}

function eventId(): string {
  return `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function eventLine(event: AuditEvent): string {
  const tool = event.toolName ? ` [${event.toolName}]` : "";
  return `${event.occurredAt} ${event.id} (${event.type}/${event.status})${tool}: ${event.title}`;
}

async function readAuditLog(projectRoot: string, projectId: string, auditPath: string): Promise<AuditLogFile> {
  try {
    const raw = await readProjectFile(projectRoot, projectId, auditPath, 2 * 1024 * 1024);
    const parsed = JSON.parse(raw) as Partial<AuditLogFile>;
    if (parsed.version === 1 && Array.isArray(parsed.events)) {
      return {
        version: 1,
        projectId,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
        events: parsed.events as AuditEvent[]
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/not found|ENOENT|no such file/i.test(message)) throw error;
  }
  return { version: 1, projectId, updatedAt: new Date().toISOString(), events: [] };
}

async function writeAuditLog(projectRoot: string, projectId: string, auditPath: string, events: AuditEvent[]) {
  const payload: AuditLogFile = {
    version: 1,
    projectId,
    updatedAt: new Date().toISOString(),
    events: events.sort((a, b) => (a.occurredAt ?? "").localeCompare(b.occurredAt ?? ""))
  };
  const file = await writeProjectFile(projectRoot, projectId, auditPath, `${JSON.stringify(payload, null, 2)}\n`);
  return { payload, file };
}

function historyEvent(item: ProjectTaskHistoryItem, index: number): AuditEvent {
  const toolName = item.toolName;
  const type: z.infer<typeof auditEventTypeSchema> = toolName.includes("publish")
    ? "publish"
    : toolName.includes("write") || toolName.includes("patch") || toolName.includes("asset") || toolName.includes("delete")
      ? "file_change"
      : item.ok === false ? "failure" : "tool_call";
  return {
    id: `audit_history_${index + 1}`,
    type,
    status: item.ok ? "succeeded" : "failed",
    title: item.summary,
    detail: item.summary,
    toolName,
    paths: [],
    artifacts: [],
    relatedId: `history_${index + 1}`,
    metadata: item.details && typeof item.details === "object" ? item.details as Record<string, unknown> : {},
    occurredAt: item.time
  };
}

function summarize(events: AuditEvent[]) {
  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  for (const event of events) {
    byType[event.type] = (byType[event.type] ?? 0) + 1;
    byStatus[event.status] = (byStatus[event.status] ?? 0) + 1;
    if (event.toolName) byTool[event.toolName] = (byTool[event.toolName] ?? 0) + 1;
  }
  const failures = events.filter((event) => event.status === "failed" || event.type === "failure");
  const approvals = events.filter((event) => event.type === "approval");
  const publishes = events.filter((event) => event.type === "publish");
  const deliveries = events.filter((event) => event.type === "delivery");
  return {
    totalEvents: events.length,
    byType,
    byStatus,
    byTool,
    failureCount: failures.length,
    approvalCount: approvals.length,
    publishCount: publishes.length,
    deliveryCount: deliveries.length,
    firstEventAt: events[0]?.occurredAt ?? null,
    lastEventAt: events.at(-1)?.occurredAt ?? null,
    recentFailures: failures.slice(-10).reverse(),
    recentDeliveries: deliveries.slice(-10).reverse()
  };
}

export const auditLogTools: ToolModule[] = [
  {
    definition: {
      name: "record_audit_event",
      description: "Record a project-local audit event for tool calls, file changes, publishes, failures, retries, approvals, validation, or delivery.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, type: { type: "string" }, status: { type: "string" }, title: { type: "string" }, detail: { type: "string" }, toolName: { type: "string" }, paths: { type: "array", items: { type: "string" } }, artifacts: { type: "array", items: { type: "string" } }, approvedBy: { type: "string" }, relatedId: { type: "string" }, metadata: { type: "object" }, occurredAt: { type: "string" }, auditPath: { type: "string" } }, required: ["projectId", "type", "status", "title", "detail"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: recordAuditEventInputSchema,
    handler: async (input, ctx) => {
      const parsed = recordAuditEventInputSchema.parse(input);
      const log = await readAuditLog(ctx.projectRoot, parsed.projectId, parsed.auditPath);
      const event: AuditEvent = { ...auditEventSchema.parse(parsed), id: parsed.id ?? eventId(), occurredAt: parsed.occurredAt ?? new Date().toISOString() };
      const { payload, file } = await writeAuditLog(ctx.projectRoot, parsed.projectId, parsed.auditPath, [...log.events, event]);
      return { ok: true, summary: `Recorded audit event ${event.id}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { event, eventCount: payload.events.length }, logs: [eventLine(event)], errors: [] };
    }
  },
  {
    definition: {
      name: "list_audit_events",
      description: "List project-local audit events with optional type, status, and tool filters.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, auditPath: { type: "string" }, type: { type: "string" }, status: { type: "string" }, toolName: { type: "string" }, limit: { type: "number" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listAuditEventsInputSchema,
    handler: async (input, ctx) => {
      const parsed = listAuditEventsInputSchema.parse(input);
      const log = await readAuditLog(ctx.projectRoot, parsed.projectId, parsed.auditPath);
      const events = log.events
        .filter((event) => !parsed.type || event.type === parsed.type)
        .filter((event) => !parsed.status || event.status === parsed.status)
        .filter((event) => !parsed.toolName || event.toolName === parsed.toolName)
        .slice(-parsed.limit)
        .reverse();
      return { ok: true, summary: `Found ${events.length} audit event(s).`, jobId: parsed.projectId, artifacts: [], structuredContent: { projectId: parsed.projectId, events, totalEvents: log.events.length }, logs: events.map(eventLine), errors: [] };
    }
  },
  {
    definition: {
      name: "import_project_activity_audit",
      description: "Import existing project task history into the project-local audit log for delivery and handoff traceability.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, historyLimit: { type: "number" }, auditPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: importProjectActivityAuditInputSchema,
    handler: async (input, ctx) => {
      const parsed = importProjectActivityAuditInputSchema.parse(input);
      const [manifest, log] = await Promise.all([
        getProjectManifest(ctx.projectRoot, parsed.projectId),
        readAuditLog(ctx.projectRoot, parsed.projectId, parsed.auditPath)
      ]);
      const existing = new Set(log.events.map((event) => event.relatedId ?? event.id));
      const imported = manifest.taskHistory.slice(-parsed.historyLimit)
        .map(historyEvent)
        .filter((event) => !existing.has(event.relatedId ?? event.id));
      const { payload, file } = await writeAuditLog(ctx.projectRoot, parsed.projectId, parsed.auditPath, [...log.events, ...imported]);
      return { ok: true, summary: `Imported ${imported.length} project history item(s) into audit log.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { imported, eventCount: payload.events.length }, logs: imported.map(eventLine), errors: [] };
    }
  },
  {
    definition: {
      name: "summarize_audit_log",
      description: "Summarize project-local audit events by type, status, tool, failures, approvals, publishes, and delivery records.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, auditPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: summarizeAuditLogInputSchema,
    handler: async (input, ctx) => {
      const parsed = summarizeAuditLogInputSchema.parse(input);
      const log = await readAuditLog(ctx.projectRoot, parsed.projectId, parsed.auditPath);
      const summary = summarize(log.events);
      return { ok: true, summary: `Audit log has ${summary.totalEvents} event(s), ${summary.failureCount} failure(s), ${summary.deliveryCount} delivery record(s).`, jobId: parsed.projectId, artifacts: [], structuredContent: summary, logs: [JSON.stringify(summary, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "record_delivery_audit",
      description: "Record a final delivery audit event with delivered files, validation evidence, published URL, and notes.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, deliveredFiles: { type: "array", items: { type: "string" } }, validation: { type: "array", items: { type: "string" } }, publishedUrl: { type: "string" }, notes: { type: "string" }, auditPath: { type: "string" } }, required: ["projectId", "title"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: recordDeliveryAuditInputSchema,
    handler: async (input, ctx) => {
      const parsed = recordDeliveryAuditInputSchema.parse(input);
      const log = await readAuditLog(ctx.projectRoot, parsed.projectId, parsed.auditPath);
      const event: AuditEvent = {
        id: eventId(),
        type: "delivery",
        status: "succeeded",
        title: parsed.title,
        detail: parsed.notes || `Delivered ${parsed.deliveredFiles.length} file(s).`,
        paths: parsed.deliveredFiles,
        artifacts: parsed.publishedUrl ? [parsed.publishedUrl] : [],
        metadata: { validation: parsed.validation, publishedUrl: parsed.publishedUrl },
        occurredAt: new Date().toISOString()
      };
      const { payload, file } = await writeAuditLog(ctx.projectRoot, parsed.projectId, parsed.auditPath, [...log.events, event]);
      return { ok: true, summary: `Recorded delivery audit ${event.id}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { event, eventCount: payload.events.length }, logs: [eventLine(event)], errors: [] };
    }
  },
  {
    definition: {
      name: "export_audit_log_report",
      description: "Export a Markdown audit log report with summary counts and chronological event history.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, auditPath: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportAuditLogReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportAuditLogReportInputSchema.parse(input);
      const log = await readAuditLog(ctx.projectRoot, parsed.projectId, parsed.auditPath);
      const summary = summarize(log.events);
      const markdown = [
        `# ${parsed.title}`,
        "",
        "## Summary",
        "```json",
        JSON.stringify(summary, null, 2),
        "```",
        "",
        "## Events",
        ...(log.events.length ? log.events.map((event) => `- ${eventLine(event)}\n  - ${event.detail}`) : ["- No audit events recorded."]),
        ""
      ].join("\n");
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown);
      return { ok: true, summary: `Exported audit log report to ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { summary, report: markdown }, logs: [markdown], errors: [] };
    }
  }
];
