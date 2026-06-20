import { z } from "zod";
import type { ToolContext, ToolModule, ToolResult } from "../types.js";
import {
  getIssueStats,
  listIssues,
  reportIssue,
  updateIssueStatus,
  type FeedbackIssue
} from "../../feedback/store.js";

const severityEnum = z.enum(["low", "medium", "high", "critical"]);
const categoryEnum = z.enum([
  "tool_error",
  "tool_missing",
  "tool_unclear",
  "auth",
  "performance",
  "docs",
  "other"
]);
const statusEnum = z.enum(["open", "investigating", "resolved", "wontfix"]);

const reportIssueSchema = z.object({
  title: z.string().min(4).max(200),
  detail: z.string().min(1).max(16000),
  severity: severityEnum.default("medium"),
  category: categoryEnum.default("other"),
  toolName: z.string().max(120).optional(),
  reproSteps: z.string().max(8000).optional(),
  context: z.record(z.unknown()).optional()
});

const listIssuesSchema = z.object({
  status: statusEnum.optional(),
  severity: severityEnum.optional(),
  category: categoryEnum.optional(),
  toolName: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(200).default(50)
});

const updateIssueStatusSchema = z.object({
  id: z.string().min(1).max(120),
  status: statusEnum,
  resolutionNote: z.string().max(4000).optional()
});

function issueLine(issue: FeedbackIssue): string {
  const where = issue.toolName ? ` [${issue.toolName}]` : "";
  return `${issue.id} (${issue.status}/${issue.severity}/${issue.category})${where}: ${issue.title}`;
}

export const feedbackTools: ToolModule[] = [
  {
    definition: {
      name: "report_issue",
      description:
        "Report a problem you (the AI agent) hit while using this MCP server — a tool that errored, a missing capability, unclear behavior, an auth/connection snag, or a docs gap. Stored to a feedback inbox the maintainers triage and fix one by one. Use this instead of silently giving up when a tool does not work as expected.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short summary of the problem." },
          detail: {
            type: "string",
            description: "What you were trying to do, what happened, and the exact error if any."
          },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          category: {
            type: "string",
            enum: ["tool_error", "tool_missing", "tool_unclear", "auth", "performance", "docs", "other"]
          },
          toolName: { type: "string", description: "The MCP tool involved, if any." },
          reproSteps: { type: "string", description: "Steps or tool calls that reproduce the problem." },
          context: { type: "object", description: "Optional structured context (inputs, ids, snippets)." }
        },
        required: ["title", "detail"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: reportIssueSchema,
    handler: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = input as z.infer<typeof reportIssueSchema>;
      const issue = await reportIssue(ctx.feedbackRoot, {
        title: parsed.title,
        detail: parsed.detail,
        severity: parsed.severity,
        category: parsed.category,
        toolName: parsed.toolName,
        reproSteps: parsed.reproSteps,
        context: parsed.context,
        reportedByClientId: ctx.clientId,
        reportedByUserId: ctx.userId
      });
      return {
        ok: true,
        summary: `Reported issue ${issue.id}: ${issue.title}`,
        jobId: issue.id,
        artifacts: [],
        structuredContent: { issue },
        logs: [issueLine(issue)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "list_reported_issues",
      description:
        "List issues previously reported via report_issue, newest first, with optional status/severity/category/tool filters. Use to check whether a problem was already reported before filing a duplicate, or to review the current backlog.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["open", "investigating", "resolved", "wontfix"] },
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          category: {
            type: "string",
            enum: ["tool_error", "tool_missing", "tool_unclear", "auth", "performance", "docs", "other"]
          },
          toolName: { type: "string" },
          limit: { type: "number" }
        },
        required: [],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: listIssuesSchema,
    handler: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = input as z.infer<typeof listIssuesSchema>;
      const [issues, stats] = await Promise.all([
        listIssues(ctx.feedbackRoot, {
          status: parsed.status,
          severity: parsed.severity,
          category: parsed.category,
          toolName: parsed.toolName,
          limit: parsed.limit
        }),
        getIssueStats(ctx.feedbackRoot)
      ]);
      return {
        ok: true,
        summary: `${issues.length} issue(s) shown; ${stats.open} open of ${stats.total} total.`,
        artifacts: [],
        structuredContent: { issues, stats },
        logs: issues.map(issueLine),
        errors: []
      };
    }
  },
  {
    definition: {
      name: "update_issue_status",
      description:
        "Maintainer-only: update the status of a reported issue (open -> investigating -> resolved/wontfix) with an optional resolution note. Disabled by default so the reporting agent cannot close its own issues; enable it for maintainer/admin sessions.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["open", "investigating", "resolved", "wontfix"] },
          resolutionNote: { type: "string" }
        },
        required: ["id", "status"],
        additionalProperties: false
      }
    },
    enabledByDefault: false,
    schema: updateIssueStatusSchema,
    handler: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = input as z.infer<typeof updateIssueStatusSchema>;
      const issue = await updateIssueStatus(ctx.feedbackRoot, {
        id: parsed.id,
        status: parsed.status,
        resolutionNote: parsed.resolutionNote
      });
      return {
        ok: true,
        summary: `Issue ${issue.id} is now ${issue.status}.`,
        jobId: issue.id,
        artifacts: [],
        structuredContent: { issue },
        logs: [issueLine(issue)],
        errors: []
      };
    }
  }
];
