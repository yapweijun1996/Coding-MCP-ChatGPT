import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { saveJob } from "../jobs/store.js";
import type { ToolContext, ToolResult } from "./types.js";

export function makePreviewUrl(publicBaseUrl: string, jobId: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/outcome/${jobId}`;
}

export function makeShareUrl(publicBaseUrl: string, shareId: string, filename: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/share/${shareId}/${filename}`;
}

export function createJobResult(ctx: ToolContext, title: string, summary: string, logs: string[], artifacts: string[] = []): ToolResult {
  const id = randomUUID();
  saveJob({
    id,
    status: "success",
    title,
    summary,
    logs,
    artifacts,
    errors: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  return {
    ok: true,
    summary,
    jobId: id,
    previewUrl: makePreviewUrl(ctx.publicBaseUrl, id),
    artifacts,
    logs,
    errors: []
  };
}

// A raw ZodError stringifies to a JSON dump of every issue, which the agent reported as an
// opaque "blocked / double check the input" failure with no actionable reason. Flatten it into
// "field: reason" lines naming the exact constraint (e.g. the 1 MiB content cap) so the caller
// can recover — split the file, shorten the path, or rename the argument.
export function formatZodError(error: ZodError): string {
  const lines = error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${field}: ${issue.message}`;
  });
  // Deduplicate while preserving order; multiple issues can map to the same field/message.
  const unique = [...new Set(lines)];
  return `Invalid arguments — ${unique.join("; ")}`;
}

export function errorResult(error: unknown): ToolResult {
  const message = error instanceof ZodError
    ? formatZodError(error)
    : error instanceof Error
      ? error.message
      : "Tool execution failed.";
  return {
    ok: false,
    summary: message,
    artifacts: [],
    logs: [],
    errors: [message]
  };
}
