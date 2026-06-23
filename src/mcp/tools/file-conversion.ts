import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getProjectStoredFilePath, readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

type TableRow = Record<string, string | number | boolean | null>;

const sourceBaseSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  path: z.string().min(1).max(240).optional(),
  workspacePath: z.string().min(1).max(500).optional()
});

const sourceSchema = sourceBaseSchema.refine((input) => Boolean((input.projectId && input.path) || input.workspacePath), {
  message: "Provide either projectId + path or workspacePath."
});

const inspectConvertibleFileInputSchema = sourceBaseSchema.extend({
  maxBytes: z.number().int().min(1).max(100 * 1024 * 1024).optional().default(25 * 1024 * 1024),
  includeArchiveEntries: z.boolean().optional().default(true)
}).refine((input) => Boolean((input.projectId && input.path) || input.workspacePath), {
  message: "Provide either projectId + path or workspacePath."
});

const listSafeArchiveEntriesInputSchema = sourceBaseSchema.extend({
  maxEntries: z.number().int().min(1).max(5000).optional().default(500),
  maxBytes: z.number().int().min(1).max(100 * 1024 * 1024).optional().default(25 * 1024 * 1024)
}).refine((input) => Boolean((input.projectId && input.path) || input.workspacePath), {
  message: "Provide either projectId + path or workspacePath."
});

const tableSourceBaseSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  path: z.string().min(1).max(240).optional(),
  inputFormat: z.enum(["csv", "json"]).optional().default("csv"),
  rows: z.array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))).max(5000).optional()
});

const tableSourceSchema = tableSourceBaseSchema.refine((input) => Boolean(input.rows || (input.projectId && input.path)), {
  message: "Provide either rows or projectId + path."
});

const convertTableDataFormatInputSchema = tableSourceBaseSchema.extend({
  outputFormat: z.enum(["csv", "json", "markdown"]).optional().default("json"),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("file-conversion/table-converted.json")
}).refine((input) => Boolean(input.rows || (input.projectId && input.path)), {
  message: "Provide either rows or projectId + path."
});

const createFileConversionPlanInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  sources: z.array(z.object({
    path: z.string().min(1).max(500),
    format: z.enum(["pdf", "docx", "xlsx", "csv", "json", "epub", "zip", "image", "audio", "video", "unknown"]).optional().default("unknown"),
    desiredOutput: z.enum(["text", "markdown", "json", "csv", "images", "archive_report", "transcode_report"]).optional().default("markdown")
  })).min(1).max(100),
  safetyLevel: z.enum(["inspect_only", "safe_text_export", "requires_external_converter"]).optional().default("inspect_only"),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("file-conversion/conversion-plan.json")
});

const exportFileConversionReportInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160),
  findings: z.array(z.string().min(1).max(500)).max(100).optional().default([]),
  inspectedFiles: z.array(z.record(z.string(), z.unknown())).max(200).optional().default([]),
  outputFormat: z.enum(["markdown", "json"]).optional().default("markdown"),
  outputPath: z.string().min(1).max(240).optional().default("file-conversion/conversion-report.md")
});

const createMediaConversionManifestInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  assets: z.array(z.object({
    path: z.string().min(1).max(500),
    mediaType: z.enum(["image", "audio", "video"]),
    sourceFormat: z.string().min(1).max(40),
    targetFormat: z.string().min(1).max(40),
    targetWidth: z.number().int().min(1).max(16384).optional(),
    targetHeight: z.number().int().min(1).max(16384).optional(),
    bitrateKbps: z.number().int().min(1).max(500000).optional()
  })).min(1).max(200),
  outputPath: z.string().min(1).max(240).optional().default("file-conversion/media-conversion-manifest.json")
});

function assertSafeWorkspacePath(ctx: ToolContext, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error("workspacePath must be a relative path.");
  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("workspacePath must include a filename.");
  if (parts.some((part) => part === ".." || part.startsWith("."))) throw new Error("Parent traversal and hidden path segments are not allowed.");
  const resolved = path.resolve(ctx.workspaceRoot, parts.join("/"));
  const root = path.resolve(ctx.workspaceRoot);
  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) throw new Error("workspacePath resolves outside workspaceRoot.");
  return resolved;
}

async function readSourceBytes(ctx: ToolContext, source: z.infer<typeof sourceSchema>, maxBytes: number): Promise<{ bytes: Buffer; sourceLabel: string; size: number }> {
  let absolutePath: string;
  let sourceLabel: string;
  if (source.workspacePath) {
    absolutePath = assertSafeWorkspacePath(ctx, source.workspacePath);
    sourceLabel = `workspace:${source.workspacePath}`;
  } else {
    if (!source.projectId || !source.path) throw new Error("projectId and path are required for project sources.");
    absolutePath = await getProjectStoredFilePath(ctx.projectRoot, source.projectId, source.path);
    sourceLabel = `${source.projectId}:${source.path}`;
  }
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error("Source must point to a file.");
  if (info.size > maxBytes) throw new Error(`Source file exceeds maxBytes. Size=${info.size}, maxBytes=${maxBytes}.`);
  return { bytes: await readFile(absolutePath), sourceLabel, size: info.size };
}

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.subarray(start, end).toString("ascii");
}

function detectFormat(buffer: Buffer, filePath: string): Record<string, unknown> {
  const extension = path.extname(filePath).toLowerCase();
  const magic = buffer.subarray(0, 16).toString("hex");
  let format = "unknown";
  let mime = "application/octet-stream";
  if (ascii(buffer, 0, 5) === "%PDF-") [format, mime] = ["pdf", "application/pdf"];
  else if (ascii(buffer, 0, 4) === "PK\u0003\u0004") [format, mime] = ["zip", "application/zip"];
  else if (buffer[0] === 0x89 && ascii(buffer, 1, 4) === "PNG") [format, mime] = ["png", "image/png"];
  else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) [format, mime] = ["jpeg", "image/jpeg"];
  else if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 12) === "WEBP") [format, mime] = ["webp", "image/webp"];
  else if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 12) === "WAVE") [format, mime] = ["wav", "audio/wav"];
  else if (ascii(buffer, 4, 8) === "ftyp") [format, mime] = ["mp4", "video/mp4"];
  else if (ascii(buffer, 0, 4) === "OggS") [format, mime] = ["ogg", "audio/ogg"];
  else if (ascii(buffer, 0, 4) === "glTF") [format, mime] = ["glb", "model/gltf-binary"];
  else if (extension === ".json") [format, mime] = ["json", "application/json"];
  else if ([".txt", ".md", ".csv"].includes(extension)) [format, mime] = [extension.slice(1), "text/plain"];
  const zipEntries = format === "zip" ? parseZipEntries(buffer, 50).entries.map((entry) => entry.name) : [];
  if (zipEntries.includes("word/document.xml")) [format, mime] = ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
  else if (zipEntries.includes("xl/workbook.xml")) [format, mime] = ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];
  else if (zipEntries.includes("ppt/presentation.xml")) [format, mime] = ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"];
  else if (zipEntries.includes("mimetype") && buffer.includes(Buffer.from("application/epub+zip", "utf8"))) [format, mime] = ["epub", "application/epub+zip"];
  return { format, mime, extension, magic };
}

function parseZipEntries(buffer: Buffer, maxEntries: number) {
  const issues: string[] = [];
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd === -1) return { entries: [], issues: ["ZIP end-of-central-directory record not found."] };
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: Array<{ name: string; compressedSize: number; uncompressedSize: number; safe: boolean; issues: string[] }> = [];
  for (let index = 0; index < Math.min(totalEntries, maxEntries); index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      issues.push("Central directory ended unexpectedly.");
      break;
    }
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const entryIssues: string[] = [];
    if (!name || path.isAbsolute(name) || name.startsWith("/") || name.includes("..")) entryIssues.push("Unsafe archive path.");
    if (name.split("/").some((part) => part.startsWith("."))) entryIssues.push("Hidden archive path segment.");
    if (uncompressedSize > 50 * 1024 * 1024) entryIssues.push("Large uncompressed entry.");
    if (compressedSize > 0 && uncompressedSize / compressedSize > 100) entryIssues.push("High compression ratio.");
    entries.push({ name, compressedSize, uncompressedSize, safe: entryIssues.length === 0, issues: entryIssues });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (totalEntries > maxEntries) issues.push(`Archive has ${totalEntries} entries; returned first ${maxEntries}.`);
  return { entries, issues };
}

function parseCsv(text: string): TableRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") quoted = false;
      else cell += char;
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  row.push(cell);
  rows.push(row);
  const [header = [], ...body] = rows.filter((item) => item.some((value) => value.trim() !== ""));
  const columns = header.map((value, index) => value.trim() || `column_${index + 1}`);
  return body.slice(0, 5000).map((values) => Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""])));
}

function parseJsonRows(text: string): TableRow[] {
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed) ? parsed : (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { rows?: unknown }).rows) ? (parsed as { rows: unknown[] }).rows : undefined);
  if (!rows) throw new Error("JSON table must be an array of objects or an object with rows.");
  return rows.slice(0, 5000).map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error("Each JSON table row must be an object.");
    return Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : JSON.stringify(value)]));
  });
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function rowsToCsv(rows: TableRow[]): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [columns.map(csvEscape).join(","), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))].join("\n") + "\n";
}

function rowsToMarkdown(rows: TableRow[]): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${columns.map((column) => String(row[column] ?? "").replaceAll("|", "\\|")).join(" | ")} |`),
    ""
  ].join("\n");
}

async function loadTableRows(ctx: ToolContext, input: z.infer<typeof tableSourceSchema>): Promise<TableRow[]> {
  if (input.rows) return input.rows;
  if (!input.projectId || !input.path) throw new Error("projectId and path are required when rows are not provided.");
  const text = await readProjectFile(ctx.projectRoot, input.projectId, input.path, 5 * 1024 * 1024);
  return input.inputFormat === "json" ? parseJsonRows(text) : parseCsv(text);
}

function conversionAdvice(format: string, desiredOutput: string): string[] {
  const advice: string[] = [];
  if (["pdf", "docx", "xlsx", "epub"].includes(format)) advice.push("Inspect metadata and container contents before extraction.");
  if (format === "zip") advice.push("List archive entries and reject traversal, hidden, oversized, or high-ratio entries before extraction.");
  if (["image", "audio", "video"].includes(format)) advice.push("Record target codec, dimensions, bitrate, and external converter requirement before transcoding.");
  if (format === "csv" || format === "json") advice.push(`Use convert_table_data_format for ${desiredOutput} exports when row counts are bounded.`);
  if (advice.length === 0) advice.push("Start with inspect_convertible_file to identify the format and safe next step.");
  return advice;
}

export const fileConversionTools: ToolModule[] = [
  {
    definition: {
      name: "inspect_convertible_file",
      description: "Inspect a workspace/project file by extension and magic bytes, with ZIP-based Office/EPUB detection and optional archive preview.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, path: { type: "string" }, workspacePath: { type: "string" }, maxBytes: { type: "number" }, includeArchiveEntries: { type: "boolean" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: inspectConvertibleFileInputSchema,
    handler: async (input, ctx) => {
      const parsed = inspectConvertibleFileInputSchema.parse(input);
      const loaded = await readSourceBytes(ctx, parsed, parsed.maxBytes);
      const filePath = parsed.workspacePath ?? parsed.path ?? "";
      const detected = detectFormat(loaded.bytes, filePath);
      const archive = parsed.includeArchiveEntries && ["zip", "docx", "xlsx", "pptx", "epub"].includes(String(detected.format)) ? parseZipEntries(loaded.bytes, 100) : undefined;
      const report = { source: loaded.sourceLabel, size: loaded.size, ...detected, archive };
      return { ok: true, summary: `Detected ${detected.format} for ${loaded.sourceLabel}.`, artifacts: [loaded.sourceLabel], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "list_safe_archive_entries",
      description: "List ZIP/DOCX/XLSX/EPUB central-directory entries without extracting files, flagging unsafe paths and zip-bomb risks.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, path: { type: "string" }, workspacePath: { type: "string" }, maxEntries: { type: "number" }, maxBytes: { type: "number" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listSafeArchiveEntriesInputSchema,
    handler: async (input, ctx) => {
      const parsed = listSafeArchiveEntriesInputSchema.parse(input);
      const loaded = await readSourceBytes(ctx, parsed, parsed.maxBytes);
      const report = { source: loaded.sourceLabel, ...parseZipEntries(loaded.bytes, parsed.maxEntries) };
      const unsafeCount = report.entries.filter((entry) => !entry.safe).length;
      return { ok: unsafeCount === 0 && report.issues.length === 0, summary: `Listed ${report.entries.length} archive entrie(s), ${unsafeCount} unsafe.`, artifacts: [loaded.sourceLabel], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: unsafeCount || report.issues.length ? ["Archive has safety issues."] : [] };
    }
  },
  {
    definition: {
      name: "convert_table_data_format",
      description: "Convert bounded CSV/JSON table data from inline rows or project text files into CSV, JSON, or Markdown.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, path: { type: "string" }, inputFormat: { type: "string", enum: ["csv", "json"] }, rows: { type: "array" }, outputFormat: { type: "string", enum: ["csv", "json", "markdown"] }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: convertTableDataFormatInputSchema,
    handler: async (input, ctx) => {
      const parsed = convertTableDataFormatInputSchema.parse(input);
      const rows = await loadTableRows(ctx, parsed);
      const converted = parsed.outputFormat === "csv" ? rowsToCsv(rows) : parsed.outputFormat === "markdown" ? rowsToMarkdown(rows) : `${JSON.stringify(rows, null, 2)}\n`;
      const artifacts: string[] = [];
      if (parsed.writeToProject) {
        if (!parsed.projectId) throw new Error("projectId is required when writeToProject is true.");
        const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, converted);
        artifacts.push(file.path);
      }
      return { ok: true, summary: `Converted ${rows.length} row(s) to ${parsed.outputFormat}.`, jobId: parsed.projectId, artifacts, structuredContent: { rowCount: rows.length, outputFormat: parsed.outputFormat, converted }, logs: [converted], errors: [] };
    }
  },
  {
    definition: {
      name: "create_file_conversion_plan",
      description: "Create a safe conversion/extraction plan for PDF, DOCX, XLSX, CSV, EPUB, ZIP, image, audio, or video sources.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, sources: { type: "array" }, safetyLevel: { type: "string", enum: ["inspect_only", "safe_text_export", "requires_external_converter"] }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["sources"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createFileConversionPlanInputSchema,
    handler: async (input, ctx) => {
      const parsed = createFileConversionPlanInputSchema.parse(input);
      const plan = { projectId: parsed.projectId, safetyLevel: parsed.safetyLevel, sources: parsed.sources.map((source) => ({ ...source, advice: conversionAdvice(source.format, source.desiredOutput) })), createdAt: new Date().toISOString() };
      const artifacts: string[] = [];
      if (parsed.writeToProject) {
        if (!parsed.projectId) throw new Error("projectId is required when writeToProject is true.");
        const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(plan, null, 2)}\n`);
        artifacts.push(file.path);
      }
      return { ok: true, summary: `Created conversion plan for ${parsed.sources.length} source(s).`, jobId: parsed.projectId, artifacts, structuredContent: plan, logs: [JSON.stringify(plan, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "export_file_conversion_report",
      description: "Export a Markdown or JSON file conversion inspection report into a project.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, findings: { type: "array", items: { type: "string" } }, inspectedFiles: { type: "array" }, outputFormat: { type: "string", enum: ["markdown", "json"] }, outputPath: { type: "string" } }, required: ["projectId", "title"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportFileConversionReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportFileConversionReportInputSchema.parse(input);
      const payload = { title: parsed.title, findings: parsed.findings, inspectedFiles: parsed.inspectedFiles, createdAt: new Date().toISOString() };
      const content = parsed.outputFormat === "json"
        ? `${JSON.stringify(payload, null, 2)}\n`
        : [`# ${parsed.title}`, "", "## Findings", ...(parsed.findings.length ? parsed.findings.map((item) => `- ${item}`) : ["- No findings recorded."]), "", "## Inspected Files", "```json", JSON.stringify(parsed.inspectedFiles, null, 2), "```", ""].join("\n");
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, content);
      return { ok: true, summary: `Exported file conversion report to ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: payload, logs: [content], errors: [] };
    }
  },
  {
    definition: {
      name: "create_media_conversion_manifest",
      description: "Create a reviewable image/audio/video conversion manifest with target formats, dimensions, bitrate, and external-converter caveats.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, assets: { type: "array" }, outputPath: { type: "string" } }, required: ["projectId", "assets"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createMediaConversionManifestInputSchema,
    handler: async (input, ctx) => {
      const parsed = createMediaConversionManifestInputSchema.parse(input);
      const manifest = { projectId: parsed.projectId, assets: parsed.assets, caveats: ["This manifest does not transcode bytes; run an approved converter such as ffmpeg or image tooling in a separate verified step.", "Inspect output dimensions, duration, codecs, and file size after conversion."], createdAt: new Date().toISOString() };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: true, summary: `Created media conversion manifest for ${parsed.assets.length} asset(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: manifest, logs: [JSON.stringify(manifest, null, 2)], errors: [] };
    }
  }
];
