import { z } from "zod";
import {
  createProject,
  deleteProject,
  deleteProjectFile,
  getProjectManifest,
  getProjectWithFiles,
  listProjects,
  publishProjectAndReport,
  publishProject,
  readProjectFile,
  validateProject,
  writeProjectFile
} from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const createProjectInputSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().max(2000).optional().default(""),
  entryFile: z.string().min(1).max(240).optional().default("index.html")
});

const listProjectsInputSchema = z.object({
  includeDeleted: z.boolean().optional().default(false)
});

const projectIdInputSchema = z.object({
  projectId: z.string().min(8).max(80)
});

const writeProjectFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  content: z.string().max(1024 * 1024)
});

const readProjectFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  maxBytes: z.number().int().min(1).max(1024 * 1024).optional().default(65536)
});

const deleteProjectFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  confirm: z.boolean().refine((value) => value === true, { message: "Deletion requires confirm=true." })
});

const publishProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  entryFile: z.string().min(1).max(240).optional()
});

const validateProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  entryFile: z.string().min(1).max(240).optional()
});

const deleteProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  confirm: z.boolean().refine((value) => value === true, { message: "Deletion requires confirm=true." })
});

export const projectTools: ToolModule[] = [
  {
    definition: {
      name: "create_project",
      description: "Create a persistent coding project and return its projectId.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Project title." },
          summary: { type: "string", description: "Short project summary." },
          entryFile: { type: "string", description: "Entry file, default index.html." }
        },
        required: ["title"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: createProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof createProjectInputSchema>;
      const project = await createProject(ctx.projectRoot, {
        title: parsed.title,
        summary: parsed.summary,
        entryFile: parsed.entryFile,
        createdByClientId: ctx.clientId
      });
      return { ok: true, summary: `Created project ${project.id}.`, jobId: project.id, artifacts: [project.id], logs: [JSON.stringify(project, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "list_projects",
      description: "List persistent coding projects created through this MCP.",
      inputSchema: { type: "object", properties: { includeDeleted: { type: "boolean", description: "Include soft-deleted projects." } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listProjectsInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof listProjectsInputSchema>;
      const projects = await listProjects(ctx.projectRoot, parsed.includeDeleted);
      return { ok: true, summary: `Found ${projects.length} project(s).`, artifacts: projects.map((project) => project.id), logs: [JSON.stringify(projects, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "get_project",
      description: "Get project metadata, file list, and published URL if available.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: projectIdInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof projectIdInputSchema>;
      const project = await getProjectWithFiles(ctx.projectRoot, parsed.projectId);
      return { ok: true, summary: `Loaded project ${parsed.projectId}.`, jobId: parsed.projectId, shareUrl: project.metadata.publishedUrl, previewUrl: project.metadata.publishedUrl, artifacts: project.files.map((file) => file.path), logs: [JSON.stringify(project, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "get_project_manifest",
      description: "Get the agent-readable project manifest: metadata, files, entry file, published URL, last validation, and task history.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: projectIdInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof projectIdInputSchema>;
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      return {
        ok: true,
        summary: `Loaded agent manifest for project ${parsed.projectId}.`,
        jobId: parsed.projectId,
        previewUrl: manifest.publishedUrl,
        shareUrl: manifest.publishedUrl,
        artifacts: manifest.files.map((file) => file.path),
        logs: [JSON.stringify(manifest, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "write_project_file",
      description: "Write a UTF-8 file inside a persistent project.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, relativePath: { type: "string", description: "Project-relative path. No absolute paths, dotfiles, or parent traversal." }, content: { type: "string", description: "UTF-8 text content. Max 1 MiB." } }, required: ["projectId", "relativePath", "content"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: writeProjectFileInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof writeProjectFileInputSchema>;
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.relativePath, parsed.content);
      return { ok: true, summary: `Wrote ${file.path} in project ${parsed.projectId}.`, jobId: parsed.projectId, artifacts: [file.path], logs: [JSON.stringify(file, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "read_project_file",
      description: "Read a UTF-8 file from a persistent project.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, relativePath: { type: "string" }, maxBytes: { type: "number", minimum: 1, maximum: 1048576 } }, required: ["projectId", "relativePath"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: readProjectFileInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof readProjectFileInputSchema>;
      const content = await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.relativePath, parsed.maxBytes);
      return { ok: true, summary: `Read ${parsed.relativePath} from project ${parsed.projectId}.`, jobId: parsed.projectId, artifacts: [parsed.relativePath], logs: [content], errors: [] };
    }
  },
  {
    definition: {
      name: "delete_project_file",
      description: "Delete one file from a persistent project.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, relativePath: { type: "string" }, confirm: { type: "boolean", description: "Set true to confirm delete." } }, required: ["projectId", "relativePath", "confirm"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: deleteProjectFileInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof deleteProjectFileInputSchema>;
      await deleteProjectFile(ctx.projectRoot, parsed.projectId, parsed.relativePath);
      return { ok: true, summary: `Deleted ${parsed.relativePath} from project ${parsed.projectId}.`, jobId: parsed.projectId, artifacts: [parsed.relativePath], logs: [], errors: [] };
    }
  },
  {
    definition: {
      name: "validate_project",
      description: "Validate a project before delivery. Checks entry file, safe paths, file sizes, basic HTML structure, and whether a public URL can be generated.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          entryFile: { type: "string", description: "Entry file to validate. Defaults to project entryFile." }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: validateProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof validateProjectInputSchema>;
      const validation = await validateProject(ctx.projectRoot, parsed.projectId, parsed.entryFile);
      return {
        ok: validation.ok,
        summary: validation.ok
          ? `Project ${parsed.projectId} validation passed.`
          : `Project ${parsed.projectId} validation failed.`,
        jobId: parsed.projectId,
        artifacts: [validation.entryFile],
        logs: [JSON.stringify(validation, null, 2)],
        errors: validation.errors
      };
    }
  },
  {
    definition: {
      name: "publish_project",
      description: "Publish a project entry file and return a public share URL.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, entryFile: { type: "string", description: "Entry file to publish. Defaults to project entryFile." } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: publishProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof publishProjectInputSchema>;
      const project = await publishProject(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, parsed.entryFile);
      return { ok: true, summary: `Published project ${parsed.projectId}.`, jobId: parsed.projectId, previewUrl: project.publishedUrl, shareUrl: project.publishedUrl, artifacts: [project.entryFile], logs: [JSON.stringify(project, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "publish_and_report",
      description: "Recommended ChatGPT project delivery tool. Validate the project, publish it if valid, and return a stable public URL plus structured delivery report.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          entryFile: { type: "string", description: "Entry file to publish. Defaults to project entryFile." }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: validateProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof validateProjectInputSchema>;
      const report = await publishProjectAndReport(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, parsed.entryFile);
      return {
        ok: report.ok,
        summary: report.summary,
        jobId: report.projectId,
        previewUrl: report.publishedUrl,
        shareUrl: report.publishedUrl,
        artifacts: report.files.map((file) => file.path),
        logs: [JSON.stringify(report, null, 2)],
        errors: report.validation.errors
      };
    }
  },
  {
    definition: {
      name: "delete_project",
      description: "Soft-delete a persistent project. Disabled by default in admin tool access.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, confirm: { type: "boolean", description: "Set true to confirm delete." } }, required: ["projectId", "confirm"], additionalProperties: false }
    },
    enabledByDefault: false,
    schema: deleteProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof deleteProjectInputSchema>;
      const project = await deleteProject(ctx.projectRoot, parsed.projectId);
      return { ok: true, summary: `Soft-deleted project ${parsed.projectId}.`, jobId: parsed.projectId, artifacts: [], logs: [JSON.stringify(project, null, 2)], errors: [] };
    }
  }
];
