import { z } from "zod";
import { createJobResult } from "../result.js";
import type { ToolModule, ToolContext } from "../types.js";

const pingInputSchema = z.object({
  message: z.string().optional()
});

const previewInputSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(2000)
});

export const previewTools: ToolModule[] = [
  {
    definition: {
      name: "ping",
      description: "Check that the Coding MCP server is reachable.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Optional message to echo." }
        },
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: pingInputSchema,
    handler: (input: unknown) => {
      const parsed = input as z.infer<typeof pingInputSchema>;
      return {
        ok: true,
        summary: "pong",
        artifacts: [],
        logs: [parsed.message ?? "Coding MCP is reachable."],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "create_preview",
      description: "Create a demo preview result and return an outcome URL.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" }
        },
        required: ["title", "summary"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: previewInputSchema,
    handler: (input: unknown, ctx: ToolContext) => {
      const parsed = input as z.infer<typeof previewInputSchema>;
      return createJobResult(ctx, parsed.title, parsed.summary, ["Preview job created."], []);
    }
  }
];
