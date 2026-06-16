import { randomUUID } from "node:crypto";
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

export function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : "Tool execution failed.";
  return {
    ok: false,
    summary: message,
    artifacts: [],
    logs: [],
    errors: [message]
  };
}
