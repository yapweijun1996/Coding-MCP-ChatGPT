import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ZipArchive } from "archiver";
import {
  getProjectFilesDirectory,
  getProjectManifest,
  getProjectWorkspaceDirectory,
  readProjectFile,
  writeProjectAsset,
  writeProjectFile
} from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";
import { z } from "zod";

const exportManifestPath = "exports/export-package-manifest.json";

const formatEnum = z.enum(["zip", "pdf", "docx", "pptx", "html-bundle", "screenshots", "share-archive"]);

const createExportPackageManifestSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(3).max(200).default("Project Export Package"),
  formats: z.array(formatEnum).min(1).max(7).default(["zip", "html-bundle", "share-archive"]),
  includeProjectFiles: z.boolean().default(true),
  includeWorkspaceFiles: z.boolean().default(false),
  includeReports: z.boolean().default(true),
  includeScreenshots: z.boolean().default(false),
  notes: z.array(z.string().min(1).max(240)).max(30).default([])
});

const buildZipExportPackageSchema = z.object({
  projectId: z.string().min(8).max(80),
  manifestPath: z.string().min(1).max(240).default(exportManifestPath),
  outputPath: z.string().min(1).max(240).default("exports/project-export-package.zip")
});

const createHtmlBundleSchema = z.object({
  projectId: z.string().min(8).max(80),
  manifestPath: z.string().min(1).max(240).default(exportManifestPath),
  outputPath: z.string().min(1).max(240).default("exports/html-bundle-index.html")
});

const listExportPackagesSchema = z.object({
  projectId: z.string().min(8).max(80)
});

const exportPackageReportSchema = z.object({
  projectId: z.string().min(8).max(80),
  outputPath: z.string().min(1).max(240).default("exports/export-package-report.md")
});

interface ExportPackageManifest {
  id: string;
  title: string;
  formats: Array<z.infer<typeof formatEnum>>;
  includeProjectFiles: boolean;
  includeWorkspaceFiles: boolean;
  includeReports: boolean;
  includeScreenshots: boolean;
  notes: string[];
  createdAt: string;
  projectId: string;
  entryFile: string;
  publishedUrl?: string;
  files: Array<{ path: string; size: number; role: "project" | "report" | "screenshot" }>;
  readiness: Array<{ format: string; ready: boolean; note: string }>;
  packages: Array<{ format: string; path: string; size?: number; createdAt: string }>;
}

function safeExportPath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) throw new Error("Invalid export output path.");
  return normalized;
}

// Shape guard for the export package manifest. loadManifest used to blind-cast arbitrary JSON
// `as ExportPackageManifest`, so pointing these tools at a foreign manifest (e.g. a music
// export-manifest.json) sailed past the cast and then crashed deep inside the renderers with an
// opaque TypeError — `manifest.title.replaceAll` (undefined) in create_html_export_bundle and
// `manifest.packages.push` (undefined) in build_zip_export_package. Validating here turns that into
// one actionable error at the single load chokepoint instead of two undebuggable crashes.
const exportPackageManifestSchema = z.object({
  id: z.string(),
  title: z.string(),
  formats: z.array(formatEnum),
  includeProjectFiles: z.boolean(),
  includeWorkspaceFiles: z.boolean(),
  includeReports: z.boolean(),
  includeScreenshots: z.boolean(),
  notes: z.array(z.string()),
  createdAt: z.string(),
  projectId: z.string(),
  entryFile: z.string(),
  publishedUrl: z.string().optional(),
  files: z.array(z.object({ path: z.string(), size: z.number(), role: z.enum(["project", "report", "screenshot"]) })),
  readiness: z.array(z.object({ format: z.string(), ready: z.boolean(), note: z.string() })),
  packages: z.array(z.object({ format: z.string(), path: z.string(), size: z.number().optional(), createdAt: z.string() }))
});

async function loadManifest(ctx: ToolContext, projectId: string, manifestPath: string): Promise<ExportPackageManifest> {
  const raw = await readProjectFile(ctx.projectRoot, projectId, manifestPath);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Export manifest ${manifestPath} is not valid JSON.`);
  }
  const result = exportPackageManifestSchema.safeParse(json);
  if (!result.success) {
    const presentKeys = json && typeof json === "object" ? Object.keys(json as Record<string, unknown>).join(", ") || "none" : "none";
    throw new Error(`${manifestPath} is not a valid export package manifest (present fields: ${presentKeys}). Create one with create_export_package_manifest, or pass the correct manifestPath (default ${exportManifestPath}).`);
  }
  return result.data as ExportPackageManifest;
}

async function writeManifest(ctx: ToolContext, projectId: string, manifest: ExportPackageManifest, manifestPath = exportManifestPath) {
  return writeProjectFile(ctx.projectRoot, projectId, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function readinessFor(formats: Array<z.infer<typeof formatEnum>>, hasScreenshots: boolean) {
  return formats.map((format) => {
    if (format === "zip" || format === "html-bundle" || format === "share-archive") return { format, ready: true, note: "Supported by export package tools." };
    if (format === "screenshots") return { format, ready: hasScreenshots, note: hasScreenshots ? "Screenshot file references found." : "Run screenshot_project or browser screenshot tools first." };
    return { format, ready: false, note: `${format.toUpperCase()} output requires a dedicated converter/exporter step; this manifest records the requested target.` };
  });
}

function classifyRole(filePath: string): "project" | "report" | "screenshot" {
  if (/\.(png|jpe?g|webp)$/i.test(filePath) || /screenshot/i.test(filePath)) return "screenshot";
  if (/(report|summary|README|CHANGELOG|manifest|\.md$|\.json$)/i.test(filePath)) return "report";
  return "project";
}

function htmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function markdown(manifest: ExportPackageManifest): string {
  return `# Export Package Report

- Project: \`${manifest.projectId}\`
- Title: ${manifest.title}
- Entry file: \`${manifest.entryFile}\`
- Published URL: ${manifest.publishedUrl ?? "not published"}
- Requested formats: ${manifest.formats.join(", ")}
- Files: ${manifest.files.length}
- Packages: ${manifest.packages.length}

## Readiness

${manifest.readiness.map((item) => `- ${item.ready ? "ready" : "pending"}: ${item.format} - ${item.note}`).join("\n")}

## Packages

${manifest.packages.map((item) => `- \`${item.path}\` (${item.format}${item.size ? `, ${item.size} bytes` : ""})`).join("\n") || "- No packages built yet."}
`;
}

function htmlBundle(manifest: ExportPackageManifest): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(manifest.title)}</title>
<style>body{font-family:Inter,system-ui,sans-serif;margin:32px;color:#172033}main{max-width:960px;margin:auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d8dee9;padding:10px;text-align:left}code{background:#eef2f7;padding:2px 5px;border-radius:4px}</style></head>
<body><main>
<h1>${htmlEscape(manifest.title)}</h1>
<p>Project <code>${htmlEscape(manifest.projectId)}</code>${manifest.publishedUrl ? ` · <a href="${htmlEscape(manifest.publishedUrl)}">published URL</a>` : ""}</p>
<h2>Readiness</h2><ul>${manifest.readiness.map((item) => `<li>${item.ready ? "ready" : "pending"}: ${htmlEscape(item.format)} - ${htmlEscape(item.note)}</li>`).join("")}</ul>
<h2>Files</h2><table><thead><tr><th>Path</th><th>Role</th><th>Size</th></tr></thead><tbody>${manifest.files.map((file) => `<tr><td><code>${htmlEscape(file.path)}</code></td><td>${file.role}</td><td>${file.size}</td></tr>`).join("")}</tbody></table>
</main></body></html>`;
}

async function createZipFromManifest(ctx: ToolContext, projectId: string, manifest: ExportPackageManifest, outputPath: string): Promise<Buffer> {
  const tmpDir = path.join(ctx.artifactRoot, "export-packages");
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `${projectId}-${Date.now()}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(tmpPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    if (manifest.includeProjectFiles) archive.directory(getProjectFilesDirectory(ctx.projectRoot, projectId), "published");
    if (manifest.includeWorkspaceFiles) archive.glob("**/*", { cwd: getProjectWorkspaceDirectory(ctx.projectRoot, projectId), ignore: ["node_modules/**", "dist/**", ".git/**"] }, { prefix: "workspace" });
    archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: "export-package-manifest.json" });
    archive.finalize().catch(reject);
  });
  const buffer = await readFile(tmpPath);
  await writeProjectAsset(ctx.projectRoot, projectId, safeExportPath(outputPath), buffer, "application/zip");
  return buffer;
}

export const exportPackageTools: ToolModule[] = [
  {
    definition: {
      name: "create_export_package_manifest",
      description: "Create a project-local export package manifest for ZIP, PDF, DOCX, PPTX, HTML bundle, screenshots, and share-ready archive targets.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, formats: { type: "array", items: { type: "string", enum: ["zip", "pdf", "docx", "pptx", "html-bundle", "screenshots", "share-archive"] } }, includeProjectFiles: { type: "boolean" }, includeWorkspaceFiles: { type: "boolean" }, includeReports: { type: "boolean" }, includeScreenshots: { type: "boolean" }, notes: { type: "array", items: { type: "string" } } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createExportPackageManifestSchema,
    handler: async (input, ctx) => {
      const parsed = createExportPackageManifestSchema.parse(input);
      const project = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const files = project.files
        .map((file) => ({ path: file.path, size: file.size, role: classifyRole(file.path) }))
        .filter((file) => (parsed.includeReports || file.role !== "report") && (parsed.includeScreenshots || file.role !== "screenshot"));
      const hasScreenshots = files.some((file) => file.role === "screenshot");
      const manifest: ExportPackageManifest = {
        id: `export_${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`,
        title: parsed.title,
        formats: parsed.formats,
        includeProjectFiles: parsed.includeProjectFiles,
        includeWorkspaceFiles: parsed.includeWorkspaceFiles,
        includeReports: parsed.includeReports,
        includeScreenshots: parsed.includeScreenshots,
        notes: parsed.notes,
        createdAt: new Date().toISOString(),
        projectId: parsed.projectId,
        entryFile: project.entryFile,
        publishedUrl: project.publishedUrl,
        files,
        readiness: readinessFor(parsed.formats, hasScreenshots),
        packages: []
      };
      const file = await writeManifest(ctx, parsed.projectId, manifest);
      return { ok: true, summary: `Created export package manifest with ${files.length} file(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, manifest }, logs: [JSON.stringify(manifest, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "build_zip_export_package",
      description: "Build a real ZIP export package from a project export manifest and store it as a project asset.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, manifestPath: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: buildZipExportPackageSchema,
    handler: async (input, ctx) => {
      const parsed = buildZipExportPackageSchema.parse(input);
      const manifest = await loadManifest(ctx, parsed.projectId, parsed.manifestPath);
      const buffer = await createZipFromManifest(ctx, parsed.projectId, manifest, parsed.outputPath);
      manifest.packages.push({ format: "zip", path: parsed.outputPath, size: buffer.length, createdAt: new Date().toISOString() });
      await writeManifest(ctx, parsed.projectId, manifest, parsed.manifestPath);
      return { ok: true, summary: `Built ZIP export package ${parsed.outputPath}.`, jobId: parsed.projectId, artifacts: [parsed.outputPath], structuredContent: { projectId: parsed.projectId, outputPath: parsed.outputPath, size: buffer.length, manifest }, logs: [`${parsed.outputPath}: ${buffer.length} bytes`], errors: [] };
    }
  },
  {
    definition: {
      name: "create_html_export_bundle",
      description: "Create a share-ready HTML bundle index that summarizes package contents, readiness, files, and published URL.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, manifestPath: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createHtmlBundleSchema,
    handler: async (input, ctx) => {
      const parsed = createHtmlBundleSchema.parse(input);
      const manifest = await loadManifest(ctx, parsed.projectId, parsed.manifestPath);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, htmlBundle(manifest));
      manifest.packages.push({ format: "html-bundle", path: file.path, size: file.size, createdAt: new Date().toISOString() });
      await writeManifest(ctx, parsed.projectId, manifest, parsed.manifestPath);
      return { ok: true, summary: `Created HTML export bundle ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, outputPath: file.path, manifest }, logs: [file.path], errors: [] };
    }
  },
  {
    definition: {
      name: "list_export_packages",
      description: "List export package manifests and built package artifacts for a project.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listExportPackagesSchema,
    handler: async (input, ctx) => {
      const parsed = listExportPackagesSchema.parse(input);
      const manifest = await loadManifest(ctx, parsed.projectId, exportManifestPath).catch(() => undefined);
      return { ok: true, summary: manifest ? `Found export manifest with ${manifest.packages.length} package(s).` : "No export package manifest found.", jobId: parsed.projectId, artifacts: manifest ? [exportManifestPath, ...manifest.packages.map((item) => item.path)] : [], structuredContent: { projectId: parsed.projectId, manifest }, logs: [manifest ? JSON.stringify(manifest, null, 2) : "No manifest."], errors: [] };
    }
  },
  {
    definition: {
      name: "export_package_report",
      description: "Export a Markdown report for package readiness, requested formats, files, generated packages, and remaining converter steps.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportPackageReportSchema,
    handler: async (input, ctx) => {
      const parsed = exportPackageReportSchema.parse(input);
      const manifest = await loadManifest(ctx, parsed.projectId, exportManifestPath);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, markdown(manifest));
      return { ok: true, summary: `Exported package report to ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { projectId: parsed.projectId, outputPath: file.path, manifest }, logs: [file.path], errors: [] };
    }
  }
];
