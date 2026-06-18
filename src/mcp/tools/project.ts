import path from "node:path";
import { z } from "zod";
import { createArtifact, makeArtifactUrl } from "../../artifacts/store.js";
import { createShareArtifact } from "../../share/store.js";
import { assertSafePublicUrl } from "../../security/url.js";
import {
  appendProjectTaskHistory,
  createProject,
  deleteProject,
  deleteProjectFile,
  forkProject,
  getProjectActivity,
  getProjectManifest,
  getProjectWithFiles,
  importProjectAssetFromLocalFile,
  listProjects,
  patchProjectFile,
  publishProjectAndReport,
  publishProject,
  readProjectFile,
  recordProjectBrowserInspection,
  unpublishProject,
  validateProject,
  writeProjectAsset,
  writeProjectFile
} from "../../projects/store.js";
import { makeShareUrl } from "../result.js";
import type { ToolModule } from "../types.js";
import { inspectWebpageUrl, renderWebpageInspectionReport, summarizeBrowserInspection } from "./web-inspect.js";

const maxBase64AssetChars = 40 * 1024 * 1024;
const maxImportedImageBytes = 10 * 1024 * 1024;
const maxImportedPresentationBytes = 25 * 1024 * 1024;
const maxUrlRedirects = 5;

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

const writeProjectAssetInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  contentBase64: z.string().min(1).max(maxBase64AssetChars),
  contentType: z.string().min(1).max(120).optional()
});

const importProjectAssetFromLocalFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  sourcePath: z.string().min(1).max(2000),
  contentType: z.string().min(1).max(120).optional()
});

const importProjectAssetFromUrlInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  url: z.string().url()
});

const patchProjectFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  operations: z.array(z.object({
    find: z.string().min(1).max(20000),
    replace: z.string().max(20000),
    all: z.boolean().optional().default(false)
  })).min(1).max(40)
});

const forkProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160).optional(),
  summary: z.string().max(2000).optional()
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
  entryFile: z.string().min(1).max(240).optional(),
  profile: z.literal("static_html").optional().default("static_html")
});

const getProjectActivityInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  limit: z.number().int().min(1).max(100).optional().default(50)
});

const screenshotProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  entryFile: z.string().min(1).max(240).optional(),
  viewports: z.array(z.enum(["desktop", "tablet", "mobile"])).min(1).max(3).optional().default(["desktop", "tablet", "mobile"]),
  fullPage: z.boolean().optional().default(false),
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000)
});

const deliverStaticProjectInputSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().max(2000).optional().default(""),
  entryFile: z.string().min(1).max(240).optional().default("index.html"),
  profile: z.literal("static_html").optional().default("static_html"),
  browserValidation: z.boolean().optional().default(true),
  files: z.array(z.object({
    path: z.string().min(1).max(240),
    content: z.string().max(1024 * 1024)
  })).min(1).max(40)
});

const deleteProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  confirm: z.boolean().refine((value) => value === true, { message: "Deletion requires confirm=true." })
});

function decodePureBase64(value: string): Buffer {
  if (/^data:/i.test(value.trim())) {
    throw new Error("contentBase64 must be raw base64 without a data: URL prefix.");
  }
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error("contentBase64 is not valid base64.");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) throw new Error("contentBase64 decoded to an empty asset.");
  const canonical = buffer.toString("base64").replace(/=+$/, "");
  const supplied = normalized.replace(/=+$/, "");
  if (canonical !== supplied) throw new Error("contentBase64 is not valid base64.");
  return buffer;
}

function maxBytesForAssetPath(relativePath: string): number {
  return path.extname(relativePath).toLowerCase() === ".pptx" ? maxImportedPresentationBytes : maxImportedImageBytes;
}

function resolveLocalSourcePath(workspaceRoot: string, sourcePath: string): string {
  const resolved = path.isAbsolute(sourcePath) ? path.resolve(sourcePath) : path.resolve(workspaceRoot, sourcePath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Source path must be inside the workspace directory.");
  }
  return resolved;
}

async function fetchProjectAsset(url: string, relativePath: string): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
  let currentUrl = new URL(url);
  const maxBytes = maxBytesForAssetPath(relativePath);

  for (let redirectCount = 0; redirectCount <= maxUrlRedirects; redirectCount += 1) {
    await assertSafePublicUrl(currentUrl);
    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: { "User-Agent": "Coding-MCP-AssetImport/0.1" }
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Asset import redirect is missing a Location header.");
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok) throw new Error(`Asset import failed with ${response.status} ${response.statusText}.`);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!contentType) throw new Error("Asset import response is missing a content-type header.");
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) throw new Error("Asset import response exceeds the size limit.");

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error("Asset import response exceeds the size limit.");
    return { buffer, contentType, finalUrl: currentUrl.toString() };
  }

  throw new Error("Asset import exceeded the redirect limit.");
}

function withoutScreenshots(results: Awaited<ReturnType<typeof inspectWebpageUrl>>) {
  return results.map(({ screenshotDataUrl, ...result }) => result);
}

function bufferFromDataUrl(dataUrl: string): { contentType: string; buffer: Buffer } {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) throw new Error("Screenshot data URL is not valid base64.");
  return { contentType: match[1], buffer: Buffer.from(match[2], "base64") };
}

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
        structuredContent: manifest as unknown as Record<string, unknown>,
        logs: [JSON.stringify(manifest, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "get_project_activity",
      description: "Get project task history, latest validation, publish status, and creator connector.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 100 }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: getProjectActivityInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof getProjectActivityInputSchema>;
      const activity = await getProjectActivity(ctx.projectRoot, parsed.projectId, parsed.limit);
      return {
        ok: true,
        summary: `Loaded activity for project ${parsed.projectId}.`,
        jobId: parsed.projectId,
        previewUrl: activity.publishedUrl,
        shareUrl: activity.publishedUrl,
        artifacts: [],
        structuredContent: activity as unknown as Record<string, unknown>,
        logs: [JSON.stringify(activity, null, 2)],
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
      name: "write_project_asset",
      description: "Write a binary image or PPTX asset inside a persistent project from raw base64 content.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          relativePath: { type: "string", description: "Project-relative asset path, e.g. assets/hero.png. No absolute paths, dotfiles, or parent traversal." },
          contentBase64: { type: "string", description: "Raw base64 asset bytes without a data: URL prefix." },
          contentType: { type: "string", description: "Optional MIME type, e.g. image/png." }
        },
        required: ["projectId", "relativePath", "contentBase64"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: writeProjectAssetInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof writeProjectAssetInputSchema>;
      const buffer = decodePureBase64(parsed.contentBase64);
      const file = await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.relativePath, buffer, parsed.contentType);
      return { ok: true, summary: `Wrote asset ${file.path} in project ${parsed.projectId}.`, jobId: parsed.projectId, artifacts: [file.path], logs: [JSON.stringify(file, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "import_project_asset_from_local_file",
      description: "Import a local uploaded/generated image or PPTX file into a persistent project, e.g. copy /mnt/data/character.png to assets/character.png.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          relativePath: { type: "string", description: "Project-relative asset path, e.g. assets/character.png." },
          sourcePath: { type: "string", description: "Absolute local runtime path, or workspace-relative path, to an uploaded/generated asset." },
          contentType: { type: "string", description: "Optional MIME type, e.g. image/png." }
        },
        required: ["projectId", "relativePath", "sourcePath"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: importProjectAssetFromLocalFileInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof importProjectAssetFromLocalFileInputSchema>;
      const sourcePath = resolveLocalSourcePath(ctx.workspaceRoot, parsed.sourcePath);
      const file = await importProjectAssetFromLocalFile(ctx.projectRoot, parsed.projectId, parsed.relativePath, sourcePath, parsed.contentType);
      return {
        ok: true,
        summary: `Imported local asset ${file.path} in project ${parsed.projectId}.`,
        jobId: parsed.projectId,
        artifacts: [file.path],
        structuredContent: { ...file, sourcePath },
        logs: [JSON.stringify({ ...file, sourcePath }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "import_project_asset_from_url",
      description: "Import an HTTPS image or PPTX asset into a persistent project after private-network and MIME validation.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          relativePath: { type: "string", description: "Project-relative asset path, e.g. assets/hero.png." },
          url: { type: "string", description: "HTTPS URL to import." }
        },
        required: ["projectId", "relativePath", "url"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: importProjectAssetFromUrlInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof importProjectAssetFromUrlInputSchema>;
      const imported = await fetchProjectAsset(parsed.url, parsed.relativePath);
      const file = await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.relativePath, imported.buffer, imported.contentType);
      return {
        ok: true,
        summary: `Imported asset ${file.path} in project ${parsed.projectId}.`,
        jobId: parsed.projectId,
        artifacts: [file.path],
        logs: [JSON.stringify({ ...file, sourceUrl: parsed.url, finalUrl: imported.finalUrl, contentType: imported.contentType }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "patch_project_file",
      description: "Patch a UTF-8 project file with exact find/replace operations without rewriting the whole file.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          relativePath: { type: "string", description: "Project-relative text file path." },
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                find: { type: "string", description: "Exact text to find." },
                replace: { type: "string", description: "Replacement text." },
                all: { type: "boolean", description: "Replace all occurrences instead of only the first." }
              },
              required: ["find", "replace"],
              additionalProperties: false
            }
          }
        },
        required: ["projectId", "relativePath", "operations"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: patchProjectFileInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof patchProjectFileInputSchema>;
      const file = await patchProjectFile(ctx.projectRoot, parsed.projectId, parsed.relativePath, parsed.operations);
      return { ok: true, summary: `Patched ${file.path} in project ${parsed.projectId}.`, jobId: parsed.projectId, artifacts: [file.path], logs: [JSON.stringify(file, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "fork_project",
      description: "Create a draft V2-style copy of an existing project, preserving files but not publish status.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Source project id." },
          title: { type: "string", description: "Optional title for the fork." },
          summary: { type: "string", description: "Optional summary for the fork." }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: forkProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof forkProjectInputSchema>;
      const project = await forkProject(ctx.projectRoot, parsed.projectId, {
        title: parsed.title,
        summary: parsed.summary,
        createdByClientId: ctx.clientId
      });
      return { ok: true, summary: `Forked ${parsed.projectId} into ${project.id}.`, jobId: project.id, artifacts: [project.id], structuredContent: project as unknown as Record<string, unknown>, logs: [JSON.stringify(project, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "deliver_static_project",
      description: "Create a static project from multiple text files, validate it, publish it, browser-inspect it, and return a final delivery report.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Project title." },
          summary: { type: "string", description: "Short project summary." },
          entryFile: { type: "string", description: "Entry file, default index.html." },
          profile: { type: "string", enum: ["static_html"], description: "Validation profile. Only static_html is supported in v1." },
          browserValidation: { type: "boolean", description: "Run browser validation after publish. Defaults to true." },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" }
              },
              required: ["path", "content"],
              additionalProperties: false
            },
            description: "Text project files to write."
          }
        },
        required: ["title", "files"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: deliverStaticProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof deliverStaticProjectInputSchema>;
      const project = await createProject(ctx.projectRoot, {
        title: parsed.title,
        summary: parsed.summary,
        entryFile: parsed.entryFile,
        createdByClientId: ctx.clientId
      });
      const files = [];
      for (const fileInput of parsed.files) {
        files.push(await writeProjectFile(ctx.projectRoot, project.id, fileInput.path, fileInput.content));
      }

      const validation = await validateProject(ctx.projectRoot, project.id, parsed.entryFile, parsed.profile);
      if (!validation.ok) {
        const report = {
          ok: false,
          projectId: project.id,
          entryFile: validation.entryFile,
          files,
          validation,
          nextActions: ["Fix static validation errors, then call publish_and_report or deliver_static_project again."]
        };
        await appendProjectTaskHistory(ctx.projectRoot, project.id, {
          toolName: "deliver_static_project",
          ok: false,
          summary: `Static validation blocked delivery for ${project.id}.`,
          details: report
        });
        return {
          ok: false,
          summary: `Static validation blocked delivery for ${project.id}.`,
          jobId: project.id,
          artifacts: files.map((file) => file.path),
          structuredContent: report,
          logs: [JSON.stringify(report, null, 2)],
          errors: validation.errors
        };
      }

      const published = await publishProject(ctx.projectRoot, project.id, ctx.publicBaseUrl, validation.entryFile, { shareBasePath: ctx.publicShareBasePath });
      let browserInspection: Record<string, unknown> | undefined;
      let inspectionReportUrl: string | undefined;
      if (parsed.browserValidation) {
        const browserResults = await inspectWebpageUrl(published.publishedUrl!, {
          viewports: ["desktop", "tablet", "mobile"],
          waitUntil: "networkidle",
          screenshot: true,
          fullPage: false,
          maxIssues: 12
        });
        const inspectionReport = renderWebpageInspectionReport(published.publishedUrl!, browserResults);
        const inspectionShare = await createShareArtifact({
          shareRoot: ctx.shareRoot,
          title: "Delivery Browser Inspection Report",
          summary: `Browser validation for ${project.id}.`,
          filename: `delivery-inspection-${project.id}.html`,
          html: inspectionReport
        });
        inspectionReportUrl = makeShareUrl(ctx.publicBaseUrl, inspectionShare.id, inspectionShare.filename);
        const inspectionWithoutScreenshots = withoutScreenshots(browserResults);
        const inspectionSummary = {
          ...summarizeBrowserInspection(inspectionWithoutScreenshots),
          reportUrl: inspectionReportUrl,
          inspectedAt: new Date().toISOString()
        };
        browserInspection = inspectionSummary as unknown as Record<string, unknown>;
        await recordProjectBrowserInspection(ctx.projectRoot, project.id, inspectionSummary, "deliver_static_project_browser_validation");
        if (!inspectionSummary.ok) {
          await unpublishProject(ctx.projectRoot, project.id, `Browser validation blocked delivery for ${project.id}.`);
          const report = {
            ok: false,
            projectId: project.id,
            entryFile: validation.entryFile,
            files,
            validation: { ...validation, browserInspection: inspectionSummary },
            browserInspection: inspectionSummary,
            inspectionReportUrl,
            nextActions: ["Fix browser validation errors, then run deliver_static_project again."]
          };
          await appendProjectTaskHistory(ctx.projectRoot, project.id, {
            toolName: "deliver_static_project",
            ok: false,
            summary: `Browser validation blocked delivery for ${project.id}.`,
            details: report
          });
          return {
            ok: false,
            summary: `Browser validation blocked delivery for ${project.id}.`,
            jobId: project.id,
            artifacts: [inspectionReportUrl, ...files.map((file) => file.path)],
            structuredContent: report,
            logs: [JSON.stringify(report, null, 2)],
            errors: inspectionSummary.blockingErrors
          };
        }
      }

      const report = {
        ok: true,
        projectId: project.id,
        publishedUrl: published.publishedUrl,
        entryFile: published.entryFile,
        files,
        validation,
        browserInspection,
        inspectionReportUrl,
        nextActions: [`Return this public URL to the user: ${published.publishedUrl}`]
      };
      await appendProjectTaskHistory(ctx.projectRoot, project.id, {
        toolName: "deliver_static_project",
        ok: true,
        summary: `Delivered static project ${project.id}.`,
        details: report
      });
      return {
        ok: true,
        summary: `Delivered static project ${project.id}.`,
        jobId: project.id,
        previewUrl: published.publishedUrl,
        shareUrl: published.publishedUrl,
        artifacts: [published.publishedUrl!, ...(inspectionReportUrl ? [inspectionReportUrl] : []), ...files.map((file) => file.path)],
        structuredContent: report,
        logs: [JSON.stringify(report, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "screenshot_project",
      description: "Publish or reuse a project preview and capture desktop/tablet/mobile screenshots as image artifacts for visual QA.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          entryFile: { type: "string", description: "Entry file to inspect. Defaults to project entryFile." },
          viewports: { type: "array", items: { type: "string", enum: ["desktop", "tablet", "mobile"] } },
          fullPage: { type: "boolean", description: "Capture full-page screenshots." },
          timeoutMs: { type: "number", minimum: 1000, maximum: 120000 }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: screenshotProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof screenshotProjectInputSchema>;
      const published = await publishProject(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, parsed.entryFile, { shareBasePath: ctx.publicShareBasePath });
      const results = await inspectWebpageUrl(published.publishedUrl!, {
        viewports: parsed.viewports,
        waitUntil: "networkidle",
        screenshot: true,
        fullPage: parsed.fullPage,
        timeoutMs: parsed.timeoutMs,
        maxIssues: 12
      });
      const screenshotUrls: string[] = [];
      for (const result of results) {
        if (!result.screenshotDataUrl) continue;
        const screenshot = bufferFromDataUrl(result.screenshotDataUrl);
        const artifact = await createArtifact({
          artifactRoot: ctx.artifactRoot,
          filename: `${parsed.projectId}-${result.viewport}-screenshot.jpg`,
          contentType: screenshot.contentType,
          content: screenshot.buffer
        });
        const screenshotUrl = makeArtifactUrl(ctx.publicBaseUrl, artifact.id, artifact.filename);
        result.screenshotUrl = screenshotUrl;
        screenshotUrls.push(screenshotUrl);
      }
      const reportHtml = renderWebpageInspectionReport(published.publishedUrl!, results);
      const reportShare = await createShareArtifact({
        shareRoot: ctx.shareRoot,
        title: "Project Screenshot Inspection",
        summary: `Screenshot inspection for ${parsed.projectId}.`,
        filename: `project-screenshots-${parsed.projectId}.html`,
        html: reportHtml
      });
      const reportUrl = makeShareUrl(ctx.publicBaseUrl, reportShare.id, reportShare.filename);
      const resultForLogs = withoutScreenshots(results);
      const inspection = { ...summarizeBrowserInspection(resultForLogs), reportUrl, screenshotUrls, inspectedAt: new Date().toISOString() };
      await recordProjectBrowserInspection(ctx.projectRoot, parsed.projectId, inspection, "screenshot_project");
      return {
        ok: inspection.ok,
        summary: inspection.ok
          ? `Captured ${screenshotUrls.length} screenshot(s) for project ${parsed.projectId}.`
          : `Captured screenshots for project ${parsed.projectId}; visual/runtime issues were found.`,
        jobId: parsed.projectId,
        previewUrl: reportUrl,
        shareUrl: reportUrl,
        artifacts: [reportUrl, ...screenshotUrls],
        structuredContent: inspection as unknown as Record<string, unknown>,
        logs: [JSON.stringify(inspection, null, 2)],
        errors: inspection.blockingErrors
      };
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
          entryFile: { type: "string", description: "Entry file to validate. Defaults to project entryFile." },
          profile: { type: "string", enum: ["static_html"], description: "Validation profile. Only static_html is supported in v1." }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: validateProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof validateProjectInputSchema>;
      const validation = await validateProject(ctx.projectRoot, parsed.projectId, parsed.entryFile, parsed.profile);
      return {
        ok: validation.ok,
        summary: validation.ok
          ? `Project ${parsed.projectId} validation passed.`
          : `Project ${parsed.projectId} validation failed.`,
        jobId: parsed.projectId,
        artifacts: [validation.entryFile],
        structuredContent: validation as unknown as Record<string, unknown>,
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
      const project = await publishProject(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, parsed.entryFile, { shareBasePath: ctx.publicShareBasePath });
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
      const report = await publishProjectAndReport(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, parsed.entryFile, { shareBasePath: ctx.publicShareBasePath });
      return {
        ok: report.ok,
        summary: report.summary,
        jobId: report.projectId,
        previewUrl: report.publishedUrl,
        shareUrl: report.publishedUrl,
        artifacts: report.files.map((file) => file.path),
        structuredContent: report as unknown as Record<string, unknown>,
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
