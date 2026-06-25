import { z } from "zod";
import {
  addProjectReviewComments,
  listProjectReviewComments,
  replyProjectReviewComment,
  updateProjectReviewCommentStatus,
  writeProjectFile,
  type ProjectReviewComment,
  type ProjectReviewCommentStatus,
  type ProjectReviewCommentTargetType
} from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const severityEnum = z.enum(["low", "medium", "high", "critical"]);
const targetTypeEnum = z.enum(["file", "screenshot", "ui-region", "issue", "project"]);
const statusEnum = z.enum(["open", "resolved", "wontfix"]);

const regionSchema = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().min(1),
  height: z.number().min(1)
});

const commentInputSchema = z.object({
  title: z.string().min(3).max(200),
  body: z.string().min(1).max(5000),
  severity: severityEnum.default("medium"),
  targetType: targetTypeEnum.default("project"),
  filePath: z.string().min(1).max(240).optional(),
  lineStart: z.number().int().min(1).optional(),
  lineEnd: z.number().int().min(1).optional(),
  screenshotPath: z.string().min(1).max(240).optional(),
  region: regionSchema.optional(),
  selector: z.string().min(1).max(400).optional(),
  issueId: z.string().min(1).max(120).optional(),
  assignedTo: z.string().min(1).max(120).optional()
}).refine((comment) => !comment.lineEnd || !comment.lineStart || comment.lineEnd >= comment.lineStart, {
  message: "lineEnd must be greater than or equal to lineStart"
});

const addProjectReviewCommentSchema = z.object({
  projectId: z.string().min(8).max(80),
  comments: z.array(commentInputSchema).min(1).max(100)
});

const listProjectReviewCommentsSchema = z.object({
  projectId: z.string().min(8).max(80),
  status: statusEnum.optional(),
  targetType: targetTypeEnum.optional(),
  assignedTo: z.string().min(1).max(120).optional()
});

const replyProjectReviewCommentSchema = z.object({
  projectId: z.string().min(8).max(80),
  commentId: z.string().min(1).max(80),
  body: z.string().min(1).max(5000)
});

const resolveProjectReviewCommentSchema = z.object({
  projectId: z.string().min(8).max(80),
  commentId: z.string().min(1).max(80),
  status: z.enum(["resolved", "wontfix", "open"]),
  note: z.string().max(2000).optional()
});

const exportProjectReviewSummarySchema = z.object({
  projectId: z.string().min(8).max(80),
  outputPath: z.string().min(1).max(240).default("review/review-summary.md")
});

function location(comment: ProjectReviewComment): string {
  if (comment.targetType === "file") return `${comment.filePath ?? "file"}${comment.lineStart ? `:${comment.lineStart}${comment.lineEnd && comment.lineEnd !== comment.lineStart ? `-${comment.lineEnd}` : ""}` : ""}`;
  if (comment.targetType === "screenshot") return `${comment.screenshotPath ?? "screenshot"}${comment.region ? ` @ ${comment.region.x},${comment.region.y},${comment.region.width}x${comment.region.height}` : ""}`;
  if (comment.targetType === "ui-region") return comment.selector ?? "ui-region";
  if (comment.targetType === "issue") return comment.issueId ?? "issue";
  return "project";
}

function commentLine(comment: ProjectReviewComment): string {
  return `${comment.id} (${comment.status}/${comment.severity}/${comment.targetType}) ${location(comment)}: ${comment.title}`;
}

function summarize(comments: ProjectReviewComment[]) {
  return comments.reduce((acc, comment) => {
    acc.total += 1;
    acc.byStatus[comment.status] = (acc.byStatus[comment.status] ?? 0) + 1;
    acc.bySeverity[comment.severity] = (acc.bySeverity[comment.severity] ?? 0) + 1;
    acc.byTargetType[comment.targetType] = (acc.byTargetType[comment.targetType] ?? 0) + 1;
    return acc;
  }, { total: 0, byStatus: {} as Record<ProjectReviewCommentStatus, number>, bySeverity: {} as Record<string, number>, byTargetType: {} as Record<ProjectReviewCommentTargetType, number> });
}

function markdown(projectId: string, comments: ProjectReviewComment[]): string {
  const summary = summarize(comments);
  const rows = comments.map((comment) => `| ${comment.id} | ${comment.status} | ${comment.severity} | ${comment.targetType} | ${location(comment).replaceAll("|", "\\|")} | ${comment.title.replaceAll("|", "\\|")} | ${comment.assignedTo ?? ""} |`).join("\n");
  const open = comments.filter((comment) => comment.status === "open");
  return `# Project Review Summary

- Project: \`${projectId}\`
- Total comments: ${summary.total}
- Open comments: ${summary.byStatus.open ?? 0}
- Resolved comments: ${summary.byStatus.resolved ?? 0}
- Wontfix comments: ${summary.byStatus.wontfix ?? 0}

## Open Review Work

${open.length ? open.map((comment) => `- ${comment.id}: ${comment.title} (${comment.severity}, ${location(comment)})`).join("\n") : "- No open review comments."}

## Comment Table

| ID | Status | Severity | Target | Location | Title | Assigned |
| --- | --- | --- | --- | --- | --- | --- |
${rows || "| - | - | - | - | - | No comments | - |"}
`;
}

export const projectReviewCommentTools: ToolModule[] = [
  {
    definition: {
      name: "add_project_review_comment",
      description: "Attach project review comments to files/lines, screenshots/regions, UI selectors, issues, or project-level notes for human review workflows.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          comments: { type: "array", items: { type: "object" } }
        },
        required: ["projectId", "comments"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: addProjectReviewCommentSchema,
    handler: async (input, ctx) => {
      const parsed = addProjectReviewCommentSchema.parse(input);
      const { added } = await addProjectReviewComments(ctx.projectRoot, parsed.projectId, parsed.comments, ctx.clientId);
      return { ok: true, summary: `Added ${added.length} project review comment(s).`, jobId: parsed.projectId, artifacts: added.map((comment) => comment.id), structuredContent: { projectId: parsed.projectId, added, summary: summarize(added) }, logs: added.map(commentLine), errors: [] };
    }
  },
  {
    definition: {
      name: "list_project_review_comments",
      description: "List project review comments with optional status, target type, or assignee filters, including open/resolved counts.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          status: { type: "string", enum: ["open", "resolved", "wontfix"] },
          targetType: { type: "string", enum: ["file", "screenshot", "ui-region", "issue", "project"] },
          assignedTo: { type: "string" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: listProjectReviewCommentsSchema,
    handler: async (input, ctx) => {
      const parsed = listProjectReviewCommentsSchema.parse(input);
      const comments = await listProjectReviewComments(ctx.projectRoot, parsed.projectId, { status: parsed.status, targetType: parsed.targetType, assignedTo: parsed.assignedTo });
      return { ok: true, summary: `${comments.length} project review comment(s) returned.`, jobId: parsed.projectId, artifacts: [], structuredContent: { projectId: parsed.projectId, comments, summary: summarize(comments) }, logs: comments.map(commentLine), errors: [] };
    }
  },
  {
    definition: {
      name: "reply_project_review_comment",
      description: "Append a reviewer or agent reply to a project review comment thread.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, commentId: { type: "string" }, body: { type: "string" } }, required: ["projectId", "commentId", "body"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: replyProjectReviewCommentSchema,
    handler: async (input, ctx) => {
      const parsed = replyProjectReviewCommentSchema.parse(input);
      const comment = await replyProjectReviewComment(ctx.projectRoot, parsed.projectId, parsed.commentId, parsed.body, ctx.clientId);
      return { ok: true, summary: `Replied to project review comment ${comment.id}.`, jobId: parsed.projectId, artifacts: [comment.id], structuredContent: { projectId: parsed.projectId, comment }, logs: [commentLine(comment)], errors: [] };
    }
  },
  {
    definition: {
      name: "resolve_project_review_comment",
      description: "Mark a project review comment open, resolved, or wontfix with an optional note.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, commentId: { type: "string" }, status: { type: "string", enum: ["open", "resolved", "wontfix"] }, note: { type: "string" } }, required: ["projectId", "commentId", "status"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: resolveProjectReviewCommentSchema,
    handler: async (input, ctx) => {
      const parsed = resolveProjectReviewCommentSchema.parse(input);
      const comment = await updateProjectReviewCommentStatus(ctx.projectRoot, parsed.projectId, parsed.commentId, parsed.status, parsed.note);
      return { ok: true, summary: `Project review comment ${comment.id} marked ${comment.status}.`, jobId: parsed.projectId, artifacts: [comment.id], structuredContent: { projectId: parsed.projectId, comment }, logs: [commentLine(comment)], errors: [] };
    }
  },
  {
    definition: {
      name: "export_project_review_summary",
      description: "Export a Markdown summary of open/resolved project review comments for final human review handoff.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportProjectReviewSummarySchema,
    handler: async (input, ctx) => {
      const parsed = exportProjectReviewSummarySchema.parse(input);
      const comments = await listProjectReviewComments(ctx.projectRoot, parsed.projectId);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown(parsed.projectId, comments));
      return { ok: true, summary: `Exported review summary with ${comments.length} comment(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, outputPath: file.path, summary: summarize(comments) }, logs: [file.path], errors: [] };
    }
  }
];
