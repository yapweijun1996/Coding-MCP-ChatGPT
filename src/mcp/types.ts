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
  structuredContent?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  publicBaseUrl: string;
  contentBaseUrl?: string;
  workspaceRoot: string;
  commandTimeoutMs: number;
  shareRoot: string;
  artifactRoot: string;
  feedbackRoot: string;
  projectRoot: string;
  clientId: string;
  userId?: string;
  publicShareBasePath?: string;
}

export interface ToolModule {
  definition: ToolDefinition;
  enabledByDefault: boolean;
  schema?: z.ZodType<unknown>;
  handler: (input: unknown, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}
