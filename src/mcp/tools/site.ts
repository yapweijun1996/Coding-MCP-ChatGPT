import { z } from "zod";
import type { ToolModule, ToolContext, ToolResult } from "../types.js";
import { getUserById } from "../../user-store.js";
import { clearHomepage, getHomepage, setHomepage } from "../../site/store.js";
import { resolveHomepageProjectForSet } from "../../site/homepage.js";

const setHomepageSchema = z.object({ projectId: z.string().min(1) });
const emptySchema = z.object({}).strip();

function rootUrl(ctx: ToolContext): string {
  return `${ctx.publicBaseUrl.replace(/\/$/, "")}/`;
}

async function requireAdmin(ctx: ToolContext): Promise<ToolResult | undefined> {
  const user = ctx.userId ? await getUserById(ctx.userId) : undefined;
  if (!user || user.role !== "admin") {
    return { ok: false, summary: "Only admins can manage the homepage.", artifacts: [], logs: [], errors: ["Forbidden: admin role required."] };
  }
  return undefined;
}

export const siteTools: ToolModule[] = [
  {
    definition: {
      name: "set_homepage",
      description: "Set a published project as the public homepage served at the site root (/). Admin only.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string", description: "A published project in your workspace to serve at the site root." } },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: setHomepageSchema,
    handler: async (input, ctx) => {
      const denied = await requireAdmin(ctx);
      if (denied) return denied;
      const { projectId } = input as z.infer<typeof setHomepageSchema>;
      let resolved: Awaited<ReturnType<typeof resolveHomepageProjectForSet>>;
      try {
        resolved = await resolveHomepageProjectForSet(projectId, { preferredProjectRoot: ctx.projectRoot });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to resolve homepage project.";
        return { ok: false, summary: message, artifacts: [], logs: [], errors: [message] };
      }
      setHomepage({ projectId, ownerUserId: resolved.owner.id });
      return { ok: true, summary: `Homepage set to project ${projectId}.`, previewUrl: rootUrl(ctx), shareUrl: rootUrl(ctx), artifacts: [], logs: [`Visitors to ${rootUrl(ctx)} now see "${resolved.project.title}".`], errors: [] };
    }
  },
  {
    definition: {
      name: "clear_homepage",
      description: "Clear the site homepage so the root (/) shows the default landing page. Admin only.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: emptySchema,
    handler: async (_input, ctx) => {
      const denied = await requireAdmin(ctx);
      if (denied) return denied;
      clearHomepage();
      return { ok: true, summary: "Homepage cleared; the site root now shows the default landing page.", artifacts: [], logs: [], errors: [] };
    }
  },
  {
    definition: {
      name: "get_homepage",
      description: "Get the project currently serving as the public homepage, if any.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: emptySchema,
    handler: async (_input, ctx) => {
      const home = getHomepage();
      if (!home.homeProjectId) {
        return { ok: true, summary: "No homepage is set; the site root shows the default landing page.", artifacts: [], logs: [], errors: [] };
      }
      return { ok: true, summary: `Homepage is project ${home.homeProjectId}.`, previewUrl: rootUrl(ctx), artifacts: [], logs: [JSON.stringify(home, null, 2)], errors: [] };
    }
  }
];
