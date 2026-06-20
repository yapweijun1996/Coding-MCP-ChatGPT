import { z } from "zod";
import type { ToolContext, ToolModule, ToolResult } from "../types.js";
import {
  listReviewFeedback,
  submitReviewFeedback,
  updateReviewFindingStatus,
  type ReviewFinding
} from "../../projects/store.js";

const severityEnum = z.enum(["low", "medium", "high", "critical"]);
const categoryEnum = z.enum(["bug", "ux", "visual", "accessibility", "performance", "content", "security", "other"]);
const statusEnum = z.enum(["open", "addressed", "wontfix"]);

const reviewFindingSchema = z.object({
  title: z.string().min(3).max(200),
  detail: z.string().min(1).max(4000),
  severity: severityEnum.default("medium"),
  category: categoryEnum.default("bug"),
  area: z.string().max(300).optional(),
  suggestion: z.string().max(2000).optional(),
  pageUrl: z.string().max(2000).optional()
});

const submitReviewFeedbackSchema = z.object({
  projectId: z.string().min(8).max(80),
  findings: z.array(reviewFindingSchema).min(1).max(50)
});

const getReviewFeedbackSchema = z.object({
  projectId: z.string().min(8).max(80),
  status: statusEnum.optional()
});

const resolveReviewFeedbackSchema = z.object({
  projectId: z.string().min(8).max(80),
  findingId: z.string().min(1).max(80),
  status: z.enum(["addressed", "wontfix"]),
  note: z.string().max(2000).optional()
});

function findingLine(finding: ReviewFinding): string {
  const where = finding.area ? ` @${finding.area}` : "";
  return `${finding.id} (${finding.status}/${finding.severity}/${finding.category})${where}: ${finding.title}`;
}

export const reviewFeedbackTools: ToolModule[] = [
  {
    definition: {
      name: "submit_review_feedback",
      description:
        "Submit structured review feedback for a generated project's page back to the coding agent. Use this after testing or reviewing a generated page to report concrete findings (bugs, UX, visual, accessibility, performance, content) so the coding agent can iterate. Findings are stored on the project (not published) and read back with get_review_feedback. Each finding: title, detail, severity, category, optional area (selector/section), suggestion, and pageUrl.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "The project whose page was reviewed." },
          findings: {
            type: "array",
            description: "One or more structured findings.",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Short summary of the finding." },
                detail: { type: "string", description: "What is wrong and how it was observed." },
                severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
                category: { type: "string", enum: ["bug", "ux", "visual", "accessibility", "performance", "content", "security", "other"] },
                area: { type: "string", description: "Selector, section, or component the finding refers to." },
                suggestion: { type: "string", description: "Suggested fix." },
                pageUrl: { type: "string", description: "URL of the reviewed page." }
              },
              required: ["title", "detail"],
              additionalProperties: false
            }
          }
        },
        required: ["projectId", "findings"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: submitReviewFeedbackSchema,
    handler: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = input as z.infer<typeof submitReviewFeedbackSchema>;
      const { added } = await submitReviewFeedback(ctx.projectRoot, parsed.projectId, parsed.findings, ctx.clientId);
      return {
        ok: true,
        summary: `Recorded ${added.length} review finding(s) for ${parsed.projectId}.`,
        jobId: parsed.projectId,
        artifacts: added.map((finding) => finding.id),
        structuredContent: { projectId: parsed.projectId, added },
        logs: added.map(findingLine),
        errors: []
      };
    }
  },
  {
    definition: {
      name: "get_review_feedback",
      description:
        "Read review feedback findings recorded for a project (newest review batch last), optionally filtered by status (open / addressed / wontfix). The coding agent uses this to pull open findings and fix them, then calls resolve_review_feedback.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          status: { type: "string", enum: ["open", "addressed", "wontfix"] }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: getReviewFeedbackSchema,
    handler: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = input as z.infer<typeof getReviewFeedbackSchema>;
      const findings = await listReviewFeedback(ctx.projectRoot, parsed.projectId, { status: parsed.status });
      const openCount = findings.filter((finding) => finding.status === "open").length;
      return {
        ok: true,
        summary: `${findings.length} finding(s)${parsed.status ? ` with status ${parsed.status}` : ""}; ${openCount} open.`,
        jobId: parsed.projectId,
        artifacts: [],
        structuredContent: { projectId: parsed.projectId, findings, openCount },
        logs: findings.map(findingLine),
        errors: []
      };
    }
  },
  {
    definition: {
      name: "resolve_review_feedback",
      description:
        "Mark a review finding as addressed (fixed) or wontfix, with an optional resolution note. Used by the coding agent to close the review loop after acting on a finding.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          findingId: { type: "string", description: "The finding id, e.g. finding_001." },
          status: { type: "string", enum: ["addressed", "wontfix"] },
          note: { type: "string", description: "Optional resolution note." }
        },
        required: ["projectId", "findingId", "status"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: resolveReviewFeedbackSchema,
    handler: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = input as z.infer<typeof resolveReviewFeedbackSchema>;
      const finding = await updateReviewFindingStatus(ctx.projectRoot, parsed.projectId, parsed.findingId, parsed.status, parsed.note);
      return {
        ok: true,
        summary: `Review finding ${finding.id} marked ${finding.status}.`,
        jobId: parsed.projectId,
        artifacts: [],
        structuredContent: { projectId: parsed.projectId, finding },
        logs: [findingLine(finding)],
        errors: []
      };
    }
  }
];
