import type { z } from "zod";

export interface ToolResult {
  ok: boolean;
  summary: string;
  jobId?: string;
  previewUrl?: string;
  shareUrl?: string;
  artifacts: string[];
  logs: string[];
  errors: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  publicBaseUrl: string;
  workspaceRoot: string;
  commandTimeoutMs: number;
  shareRoot: string;
  projectRoot: string;
  clientId: string;
}

export interface ToolModule {
  definition: ToolDefinition;
  enabledByDefault: boolean;
  schema?: z.ZodType<unknown>;
  handler: (input: unknown, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}
