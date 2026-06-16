import { z } from "zod";
import { createShareArtifact } from "../../share/store.js";
import { createJobResult, makeShareUrl } from "../result.js";
import type { ToolModule } from "../types.js";

const createShareInputSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(2000),
  filename: z.string().min(6).max(86),
  html: z.string().min(1).max(1024 * 1024)
});

export const shareTools: ToolModule[] = [
  {
    definition: {
      name: "create_share",
      description: "Legacy standalone HTML share. Do not use for project deliverables; use create_project, write_project_file, and publish_project for restart-safe public links.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          filename: { type: "string", description: "Simple .html filename, for example index.html or report.html." },
          html: { type: "string", description: "Complete standalone HTML document. Max 1 MiB." }
        },
        required: ["title", "summary", "filename", "html"],
        additionalProperties: false
      }
    },
    enabledByDefault: false,
    schema: createShareInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof createShareInputSchema>;
      const share = await createShareArtifact({ shareRoot: ctx.shareRoot, title: parsed.title, summary: parsed.summary, filename: parsed.filename, html: parsed.html });
      const result = createJobResult(ctx, `Shared ${share.filename}`, parsed.summary, ["Share artifact created."], [`share/${share.id}/${share.filename}`]);
      return { ...result, shareUrl: makeShareUrl(ctx.publicBaseUrl, share.id, share.filename) };
    }
  }
];
