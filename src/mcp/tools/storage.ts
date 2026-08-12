import { z } from "zod";
import { getStoragePolicy, getStorageReport } from "../../storage/manager.js";
import { listProjects, purgeProject } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const storageUsageInputSchema = z.object({});

const purgeProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  confirm: z.boolean().refine((value) => value === true, { message: "Permanent deletion requires confirm=true." })
});

export const storageTools: ToolModule[] = [
  {
    definition: {
      name: "get_my_storage_usage",
      description: "Report current-user project and workspace storage usage, quota status, and largest projects. Absolute filesystem paths are omitted.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: storageUsageInputSchema,
    handler: async (_input, ctx) => {
      const projects = await listProjects(ctx.projectRoot, true);
      const report = await getStorageReport([{
        id: ctx.userId ? `user:${ctx.userId}` : "current-scope",
        label: "Current user",
        projectRoot: ctx.projectRoot,
        workspaceRoot: ctx.workspaceRoot,
        projects: projects.map((project) => ({
          id: project.id,
          title: project.title,
          status: project.status,
          workspacePath: project.workspaceBinding?.path
        }))
      }], ctx.storagePolicy ?? getStoragePolicy());
      return {
        ok: true,
        summary: `Current user storage is ${report.totals.totalBytes} bytes (${report.globalQuota.state}).`,
        artifacts: [],
        structuredContent: report as unknown as Record<string, unknown>,
        logs: [JSON.stringify(report, null, 2)],
        errors: report.warnings
      };
    }
  },
  {
    definition: {
      name: "purge_project",
      description: "Permanently delete one project, its stored files, internal workspace, safe bound workspace, and project backups. This cannot be undone.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, confirm: { type: "boolean", description: "Set true to confirm permanent deletion." } }, required: ["projectId", "confirm"], additionalProperties: false }
    },
    enabledByDefault: false,
    schema: purgeProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = purgeProjectInputSchema.parse(input);
      const result = await purgeProject(ctx.projectRoot, parsed.projectId, {
        workspaceRoot: ctx.workspaceRoot,
        artifactRoot: ctx.artifactRoot,
        shareRoot: ctx.shareRoot
      });
      return {
        ok: true,
        summary: `Permanently deleted project ${parsed.projectId} and reclaimed approximately ${result.projectBytes + result.workspaceBytes + result.artifactBytes + result.shareBytes} bytes.`,
        jobId: parsed.projectId,
        artifacts: [],
        structuredContent: result as unknown as Record<string, unknown>,
        logs: [JSON.stringify(result, null, 2)],
        errors: []
      };
    }
  }
];
