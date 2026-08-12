import type { z } from "zod";
import type { StoragePolicy } from "../storage/manager.js";

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
  /** Host-specific descriptor metadata, e.g. ChatGPT Apps SDK file parameters. */
  _meta?: Record<string, unknown>;
  /** MCP tool annotations such as readOnlyHint/openWorldHint/destructiveHint. */
  annotations?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
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
  storagePolicy?: StoragePolicy;
  conversationFileMaxBytes?: number;
  fileTransferTimeoutMs?: number;
  /** Host-owned cancellation for queued jobs; tool inputs can never set this. */
  abortSignal?: AbortSignal;
  /** Test/embedding seam for a trusted connector-file resolver; never populated from tool input. */
  conversationFileResolver?: unknown;
}

export interface ToolModule {
  definition: ToolDefinition;
  enabledByDefault: boolean;
  schema?: z.ZodType<unknown>;
  handler: (input: unknown, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}
