import { z } from "zod";
import { getProjectTask, readProjectFile, writeProjectFile } from "../../projects/store.js";
import { getJob } from "../../jobs/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const notificationStorePath = "notifications/project-notifications.json";

const channelTypeEnum = z.enum(["in_app", "email", "webhook", "slack", "sms", "calendar"]);
const eventTypeEnum = z.enum(["completed_task", "failed_job", "review_needed", "blocked_task", "project_change", "release_ready", "deployment_status", "budget_warning", "custom"]);
const notificationStatusEnum = z.enum(["draft", "scheduled", "sent", "cancelled", "failed"]);
const priorityEnum = z.enum(["low", "normal", "high", "urgent"]);

const configureChannelSchema = z.object({
  projectId: z.string().min(8).max(80),
  channelId: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  name: z.string().min(2).max(160),
  type: channelTypeEnum.default("in_app"),
  targetLabel: z.string().min(1).max(240).default("Project activity feed"),
  enabled: z.boolean().default(true),
  notes: z.string().max(1000).optional()
});

const sendNotificationSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(3).max(180),
  message: z.string().min(1).max(4000),
  eventType: eventTypeEnum.default("custom"),
  priority: priorityEnum.default("normal"),
  channelIds: z.array(z.string().min(1).max(80)).max(20).default(["in_app"]),
  taskId: z.string().min(1).max(120).optional(),
  jobId: z.string().min(1).max(200).optional(),
  changeSummary: z.string().max(2000).optional(),
  actionUrl: z.string().url().max(1000).optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

const scheduleNotificationSchema = sendNotificationSchema.extend({
  scheduledFor: z.string().datetime(),
  reminderKey: z.string().min(1).max(120).optional()
});

const listNotificationsSchema = z.object({
  projectId: z.string().min(8).max(80),
  status: notificationStatusEnum.optional(),
  eventType: eventTypeEnum.optional(),
  priority: priorityEnum.optional(),
  channelId: z.string().min(1).max(80).optional(),
  taskId: z.string().min(1).max(120).optional(),
  jobId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(500).default(100)
});

const processDueNotificationsSchema = z.object({
  projectId: z.string().min(8).max(80),
  now: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).default(50)
});

const exportNotificationReportSchema = z.object({
  projectId: z.string().min(8).max(80),
  outputPath: z.string().min(1).max(240).default("notifications/notification-report.md")
});

interface NotificationChannel {
  id: string;
  name: string;
  type: z.infer<typeof channelTypeEnum>;
  targetLabel: string;
  enabled: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectNotification {
  id: string;
  title: string;
  message: string;
  eventType: z.infer<typeof eventTypeEnum>;
  priority: z.infer<typeof priorityEnum>;
  status: z.infer<typeof notificationStatusEnum>;
  channelIds: string[];
  taskId?: string;
  jobId?: string;
  changeSummary?: string;
  actionUrl?: string;
  reminderKey?: string;
  scheduledFor?: string;
  sentAt?: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

interface NotificationStore {
  version: 1;
  channels: NotificationChannel[];
  notifications: ProjectNotification[];
}

function emptyStore(): NotificationStore {
  return {
    version: 1,
    channels: [{
      id: "in_app",
      name: "Project activity feed",
      type: "in_app",
      targetLabel: "Project activity feed",
      enabled: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    }],
    notifications: []
  };
}

async function readStore(ctx: ToolContext, projectId: string): Promise<NotificationStore> {
  try {
    const raw = await readProjectFile(ctx.projectRoot, projectId, notificationStorePath);
    const parsed = JSON.parse(raw) as NotificationStore;
    const base = emptyStore();
    const channels = Array.isArray(parsed.channels) ? parsed.channels : [];
    return {
      version: 1,
      channels: channels.some((channel) => channel.id === "in_app") ? channels : [base.channels[0], ...channels],
      notifications: Array.isArray(parsed.notifications) ? parsed.notifications : []
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return emptyStore();
    }
    throw error;
  }
}

async function writeStore(ctx: ToolContext, projectId: string, store: NotificationStore) {
  return writeProjectFile(ctx.projectRoot, projectId, notificationStorePath, `${JSON.stringify(store, null, 2)}\n`);
}

function nextId(prefix: string, existing: Array<{ id: string }>): string {
  const max = existing.reduce((current, item) => {
    const match = new RegExp(`^${prefix}_(\\d+)$`).exec(item.id);
    return match ? Math.max(current, Number.parseInt(match[1]!, 10)) : current;
  }, 0);
  return `${prefix}_${String(max + 1).padStart(3, "0")}`;
}

function enabledChannels(store: NotificationStore, channelIds: string[]): NotificationChannel[] {
  const channels = channelIds.map((id) => store.channels.find((channel) => channel.id === id)).filter((channel): channel is NotificationChannel => Boolean(channel));
  return channels.filter((channel) => channel.enabled);
}

function validateChannels(store: NotificationStore, channelIds: string[]) {
  const missing = channelIds.filter((id) => !store.channels.some((channel) => channel.id === id));
  if (missing.length > 0) throw new Error(`Unknown notification channel(s): ${missing.join(", ")}`);
  const disabled = channelIds.filter((id) => store.channels.some((channel) => channel.id === id && !channel.enabled));
  if (disabled.length > 0) throw new Error(`Disabled notification channel(s): ${disabled.join(", ")}`);
}

async function validateReferences(ctx: ToolContext, projectId: string, taskId?: string, jobId?: string) {
  if (taskId) await getProjectTask(ctx.projectRoot, projectId, taskId);
  // Scope to the caller's own jobs: a non-owner gets the same "not found" as a missing id, so
  // notification references cannot probe another tenant's job-id space.
  if (jobId) {
    const job = getJob(jobId);
    if (!job || job.ownerUserId !== ctx.userId) throw new Error(`No background job found for ${jobId}.`);
  }
}

function notificationFrom(input: z.infer<typeof sendNotificationSchema>, status: ProjectNotification["status"], now: string, scheduledFor?: string, reminderKey?: string): ProjectNotification {
  return {
    id: "pending",
    title: input.title,
    message: input.message,
    eventType: input.eventType,
    priority: input.priority,
    status,
    channelIds: input.channelIds,
    taskId: input.taskId,
    jobId: input.jobId,
    changeSummary: input.changeSummary,
    actionUrl: input.actionUrl,
    reminderKey,
    scheduledFor,
    sentAt: status === "sent" ? now : undefined,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata
  };
}

function summarize(notifications: ProjectNotification[]) {
  return notifications.reduce((acc, item) => {
    acc.total += 1;
    acc.byStatus[item.status] = (acc.byStatus[item.status] ?? 0) + 1;
    acc.byEventType[item.eventType] = (acc.byEventType[item.eventType] ?? 0) + 1;
    acc.byPriority[item.priority] = (acc.byPriority[item.priority] ?? 0) + 1;
    return acc;
  }, {
    total: 0,
    byStatus: {} as Record<string, number>,
    byEventType: {} as Record<string, number>,
    byPriority: {} as Record<string, number>
  });
}

function line(item: ProjectNotification): string {
  const target = [item.taskId ? `task=${item.taskId}` : undefined, item.jobId ? `job=${item.jobId}` : undefined].filter(Boolean).join(" ");
  return `${item.id} ${item.status}/${item.eventType}/${item.priority}${target ? ` ${target}` : ""}: ${item.title}`;
}

function markdown(projectId: string, store: NotificationStore): string {
  const summary = summarize(store.notifications);
  const rows = store.notifications.map((item) => `| ${item.id} | ${item.status} | ${item.eventType} | ${item.priority} | ${item.channelIds.join(", ")} | ${item.scheduledFor ?? ""} | ${item.sentAt ?? ""} | ${item.title.replaceAll("|", "\\|")} |`).join("\n");
  return `# Notification Report

- Project: \`${projectId}\`
- Channels: ${store.channels.length}
- Notifications: ${summary.total}
- Scheduled: ${summary.byStatus.scheduled ?? 0}
- Sent: ${summary.byStatus.sent ?? 0}
- Failed: ${summary.byStatus.failed ?? 0}

## Channels

${store.channels.map((channel) => `- ${channel.id} (${channel.type}, ${channel.enabled ? "enabled" : "disabled"}): ${channel.targetLabel}`).join("\n")}

## Active Notifications

${store.notifications.filter((item) => item.status === "scheduled" || item.status === "failed").map((item) => `- ${line(item)}`).join("\n") || "- No active notifications."}

## Notification Table

| ID | Status | Event | Priority | Channels | Scheduled | Sent | Title |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows || "| - | - | - | - | - | - | - | No notifications |"}
`;
}

export const notificationTools: ToolModule[] = [
  {
    definition: {
      name: "configure_notification_channel",
      description: "Create or update a project-local notification channel definition without storing external secrets.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, channelId: { type: "string" }, name: { type: "string" }, type: { type: "string" }, targetLabel: { type: "string" }, enabled: { type: "boolean" }, notes: { type: "string" } }, required: ["projectId", "name"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: configureChannelSchema,
    handler: async (input, ctx) => {
      const parsed = configureChannelSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const now = new Date().toISOString();
      const id = parsed.channelId ?? nextId("channel", store.channels);
      const index = store.channels.findIndex((channel) => channel.id === id);
      const channel: NotificationChannel = {
        id,
        name: parsed.name,
        type: parsed.type,
        targetLabel: parsed.targetLabel,
        enabled: parsed.enabled,
        notes: parsed.notes,
        createdAt: index >= 0 ? store.channels[index]!.createdAt : now,
        updatedAt: now
      };
      if (index >= 0) store.channels[index] = channel;
      else store.channels.push(channel);
      const file = await writeStore(ctx, parsed.projectId, store);
      return { ok: true, summary: `${index >= 0 ? "Updated" : "Created"} notification channel ${id}.`, jobId: parsed.projectId, artifacts: [file.path, id], structuredContent: { projectId: parsed.projectId, channel }, logs: [`${id}: ${channel.type} -> ${channel.targetLabel}`], errors: [] };
    }
  },
  {
    definition: {
      name: "send_project_notification",
      description: "Record an immediate project notification for completed tasks, failed jobs, review needed, blocked tasks, or important project changes.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, message: { type: "string" }, eventType: { type: "string" }, priority: { type: "string" }, channelIds: { type: "array", items: { type: "string" } }, taskId: { type: "string" }, jobId: { type: "string" }, changeSummary: { type: "string" }, actionUrl: { type: "string" }, metadata: { type: "object" } }, required: ["projectId", "title", "message"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: sendNotificationSchema,
    handler: async (input, ctx) => {
      const parsed = sendNotificationSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      validateChannels(store, parsed.channelIds);
      await validateReferences(ctx, parsed.projectId, parsed.taskId, parsed.jobId);
      const now = new Date().toISOString();
      const notification = { ...notificationFrom(parsed, "sent", now), id: nextId("notification", store.notifications) };
      store.notifications.push(notification);
      const file = await writeStore(ctx, parsed.projectId, store);
      const channels = enabledChannels(store, parsed.channelIds);
      return { ok: true, summary: `Sent project notification ${notification.id} to ${channels.length} channel(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, notification, channels }, logs: [line(notification), ...channels.map((channel) => `${channel.id}: ${channel.targetLabel}`)], errors: [] };
    }
  },
  {
    definition: {
      name: "schedule_project_notification",
      description: "Schedule a project notification for later delivery and store it in the project notification queue.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, message: { type: "string" }, eventType: { type: "string" }, priority: { type: "string" }, channelIds: { type: "array", items: { type: "string" } }, taskId: { type: "string" }, jobId: { type: "string" }, changeSummary: { type: "string" }, actionUrl: { type: "string" }, metadata: { type: "object" }, scheduledFor: { type: "string" }, reminderKey: { type: "string" } }, required: ["projectId", "title", "message", "scheduledFor"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: scheduleNotificationSchema,
    handler: async (input, ctx) => {
      const parsed = scheduleNotificationSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      validateChannels(store, parsed.channelIds);
      await validateReferences(ctx, parsed.projectId, parsed.taskId, parsed.jobId);
      const now = new Date().toISOString();
      const notification = { ...notificationFrom(parsed, "scheduled", now, parsed.scheduledFor, parsed.reminderKey), id: nextId("notification", store.notifications) };
      store.notifications.push(notification);
      const file = await writeStore(ctx, parsed.projectId, store);
      return { ok: true, summary: `Scheduled project notification ${notification.id} for ${parsed.scheduledFor}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, notification }, logs: [line(notification)], errors: [] };
    }
  },
  {
    definition: {
      name: "list_project_notifications",
      description: "List project notification channels and notifications filtered by status, event type, priority, channel, task, or job.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, status: { type: "string" }, eventType: { type: "string" }, priority: { type: "string" }, channelId: { type: "string" }, taskId: { type: "string" }, jobId: { type: "string" }, limit: { type: "number" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listNotificationsSchema,
    handler: async (input, ctx) => {
      const parsed = listNotificationsSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const notifications = store.notifications
        .filter((item) => !parsed.status || item.status === parsed.status)
        .filter((item) => !parsed.eventType || item.eventType === parsed.eventType)
        .filter((item) => !parsed.priority || item.priority === parsed.priority)
        .filter((item) => !parsed.channelId || item.channelIds.includes(parsed.channelId))
        .filter((item) => !parsed.taskId || item.taskId === parsed.taskId)
        .filter((item) => !parsed.jobId || item.jobId === parsed.jobId)
        .slice(-parsed.limit)
        .reverse();
      return { ok: true, summary: `Found ${notifications.length} notification(s).`, jobId: parsed.projectId, artifacts: [notificationStorePath], structuredContent: { projectId: parsed.projectId, channels: store.channels, notifications, summary: summarize(store.notifications) }, logs: notifications.map(line), errors: [] };
    }
  },
  {
    definition: {
      name: "process_due_project_notifications",
      description: "Mark scheduled project notifications due at or before now as sent and return their delivery packets.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, now: { type: "string" }, limit: { type: "number" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: processDueNotificationsSchema,
    handler: async (input, ctx) => {
      const parsed = processDueNotificationsSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const now = parsed.now ?? new Date().toISOString();
      const due = store.notifications.filter((item) => item.status === "scheduled" && item.scheduledFor && item.scheduledFor <= now).slice(0, parsed.limit);
      const dueIds = new Set(due.map((item) => item.id));
      store.notifications = store.notifications.map((item) => dueIds.has(item.id) ? { ...item, status: "sent", sentAt: now, updatedAt: now } : item);
      const file = await writeStore(ctx, parsed.projectId, store);
      const sent = store.notifications.filter((item) => dueIds.has(item.id));
      return { ok: true, summary: `Processed ${sent.length} due notification(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, sent }, logs: sent.map(line), errors: [] };
    }
  },
  {
    definition: {
      name: "export_notification_report",
      description: "Export a Markdown report summarizing notification channels, sent notifications, scheduled reminders, and failures.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportNotificationReportSchema,
    handler: async (input, ctx) => {
      const parsed = exportNotificationReportSchema.parse(input);
      const store = await readStore(ctx, parsed.projectId);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown(parsed.projectId, store));
      return { ok: true, summary: `Exported notification report to ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, outputPath: file.path, summary: summarize(store.notifications) }, logs: [file.path], errors: [] };
    }
  }
];
