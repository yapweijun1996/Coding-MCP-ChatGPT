import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

export type ProjectStatus = "draft" | "private" | "published" | "deleted";
export type ProjectValidationStatus = "valid" | "warnings" | "failed";
export type ProjectValidationProfile = "static_html";

export interface ProjectBrowserInspectionSummary {
  ok: boolean;
  blockingErrors: string[];
  warnings: string[];
  reportUrl?: string;
  inspectedAt: string;
}

export interface ProjectValidationResult {
  ok: boolean;
  status: ProjectValidationStatus;
  profile: ProjectValidationProfile;
  projectId: string;
  entryFile: string;
  filesChecked: number;
  warnings: string[];
  errors: string[];
  checkedAt: string;
  browserInspection?: ProjectBrowserInspectionSummary;
}

export interface ProjectTaskHistoryItem {
  id: string;
  time: string;
  toolName: string;
  ok: boolean;
  summary: string;
  details?: unknown;
}

export interface ProjectMetadata {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  createdByClientId: string;
  status: ProjectStatus;
  entryFile: string;
  publishedUrl?: string;
  lastValidation?: ProjectValidationResult;
  taskHistory?: ProjectTaskHistoryItem[];
}

export interface ProjectFileInfo {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface ProjectSummary extends ProjectMetadata {
  filesCount: number;
}

export interface ProjectManifest {
  metadata: ProjectMetadata;
  files: ProjectFileInfo[];
  entryFile: string;
  publishedUrl?: string;
  lastValidation?: ProjectValidationResult;
  taskHistory: ProjectTaskHistoryItem[];
}

export interface ProjectActivity {
  projectId: string;
  status: ProjectStatus;
  publishedUrl?: string;
  createdByClientId: string;
  lastValidation?: ProjectValidationResult;
  taskHistory: ProjectTaskHistoryItem[];
}

export interface PublishProjectOptions {
  shareBasePath?: string;
}

export const maxProjectFileBytes = 1024 * 1024;
export const maxProjectImageAssetBytes = 10 * 1024 * 1024;
export const maxProjectPresentationAssetBytes = 25 * 1024 * 1024;

const metadataFilename = "project.json";
const filesDirectoryName = "files";
const workspaceDirectoryName = "workspace";
const maxTaskHistoryItems = 100;
const allowedTextExtensions = new Set([".html", ".css", ".js", ".mjs", ".json", ".webmanifest", ".txt", ".md", ".svg"]);
const allowedAssetExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".pptx"]);
const projectContentTypes = new Map([
  [".html", "text/html"],
  [".css", "text/css"],
  [".js", "application/javascript"],
  [".mjs", "application/javascript"],
  [".json", "application/json"],
  [".webmanifest", "application/manifest+json"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"]
]);

type DirectoryEntryLike = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
};

export function getProjectDirectory(projectRoot: string, projectId: string): string {
  assertSafeProjectId(projectId);
  return path.join(projectRoot, projectId);
}

export function getProjectFilesDirectory(projectRoot: string, projectId: string): string {
  return path.join(getProjectDirectory(projectRoot, projectId), filesDirectoryName);
}

export function getProjectWorkspaceDirectory(projectRoot: string, projectId: string): string {
  return path.join(getProjectDirectory(projectRoot, projectId), workspaceDirectoryName);
}

function getProjectMetadataPath(projectRoot: string, projectId: string): string {
  return path.join(getProjectDirectory(projectRoot, projectId), metadataFilename);
}

function assertSafeProjectId(projectId: string): void {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(projectId)) {
    throw new Error("Invalid projectId.");
  }
}

function assertSafeProjectPath(relativePath: string, allowedExtensions: Set<string>, label: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Absolute or empty project file paths are not allowed.");
  }

  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) {
    throw new Error("Project file path must include a filename.");
  }
  if (parts.some((part) => part === ".." || part.startsWith("."))) {
    throw new Error("Parent traversal and hidden path segments are not allowed.");
  }

  const extension = path.extname(parts.at(-1) ?? "").toLowerCase();
  if (!allowedExtensions.has(extension)) {
    throw new Error(`Unsupported project ${label} extension: ${extension || "(none)"}.`);
  }

  return parts.join("/");
}

export function assertSafeProjectFilePath(relativePath: string): string {
  return assertSafeProjectPath(relativePath, allowedTextExtensions, "file");
}

export function assertSafeProjectAssetPath(relativePath: string): string {
  return assertSafeProjectPath(relativePath, allowedAssetExtensions, "asset");
}

export function assertSafeProjectStoredPath(relativePath: string): string {
  return assertSafeProjectPath(relativePath, new Set([...allowedTextExtensions, ...allowedAssetExtensions]), "file");
}

function resolveProjectFilePath(projectRoot: string, projectId: string, relativePath: string): string {
  const safeRelativePath = assertSafeProjectFilePath(relativePath);
  return resolveProjectStoredPath(projectRoot, projectId, safeRelativePath);
}

function resolveProjectAssetPath(projectRoot: string, projectId: string, relativePath: string): string {
  const safeRelativePath = assertSafeProjectAssetPath(relativePath);
  return resolveProjectStoredPath(projectRoot, projectId, safeRelativePath);
}

function resolveProjectStoredPath(projectRoot: string, projectId: string, relativePath: string): string {
  const filesRoot = getProjectFilesDirectory(projectRoot, projectId);
  const resolved = path.resolve(filesRoot, relativePath);
  const normalizedRoot = path.resolve(filesRoot);
  if (!resolved.startsWith(`${normalizedRoot}${path.sep}`) && resolved !== normalizedRoot) {
    throw new Error("Resolved project file path is outside the project.");
  }
  return resolved;
}

export function getProjectFileContentType(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();
  return projectContentTypes.get(extension) ?? "application/octet-stream";
}

export function isProjectTextFilePath(relativePath: string): boolean {
  return allowedTextExtensions.has(path.extname(relativePath).toLowerCase());
}

export async function getProjectStoredFilePath(projectRoot: string, projectId: string, relativePath: string): Promise<string> {
  const metadata = await getProject(projectRoot, projectId);
  if (metadata.status === "deleted") throw new Error("Cannot access a deleted project.");
  const safeRelativePath = assertSafeProjectStoredPath(relativePath);
  return resolveProjectStoredPath(projectRoot, projectId, safeRelativePath);
}

function normalizeContentType(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

function expectedContentTypesForExtension(extension: string): string[] {
  const contentType = projectContentTypes.get(extension);
  if (!contentType) return [];
  if (extension === ".svg") return [contentType, "text/xml", "application/xml"];
  return [contentType];
}

function ensureContentTypeMatches(extension: string, contentType: string | undefined): void {
  const normalized = normalizeContentType(contentType);
  if (!normalized) return;
  const expected = expectedContentTypesForExtension(extension);
  if (!expected.includes(normalized)) {
    throw new Error(`contentType ${contentType} does not match ${extension}.`);
  }
}

function hasBytes(buffer: Buffer, bytes: number[], offset = 0): boolean {
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function includesAscii(buffer: Buffer, value: string): boolean {
  return buffer.includes(Buffer.from(value, "ascii"));
}

function validateSvgAsset(buffer: Buffer): void {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let svg: string;
  try {
    svg = decoder.decode(buffer);
  } catch {
    throw new Error("SVG assets must be valid UTF-8.");
  }
  if (!/<\s*svg[\s>]/i.test(svg)) throw new Error("SVG asset must contain an <svg> root.");
  if (/<\s*script\b/i.test(svg)) throw new Error("SVG assets must not contain script tags.");
  if (/<\s*foreignObject\b/i.test(svg)) throw new Error("SVG assets must not contain foreignObject elements.");
  if (/\bon\w+\s*=/i.test(svg)) throw new Error("SVG assets must not contain event handler attributes.");
  if (/\b(?:href|src|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/|data:)/i.test(svg)) {
    throw new Error("SVG assets must not reference external or data URLs.");
  }
}

function validateProjectAssetBytes(relativePath: string, buffer: Buffer, contentType?: string): void {
  const extension = path.extname(relativePath).toLowerCase();
  ensureContentTypeMatches(extension, contentType);

  if (buffer.length === 0) throw new Error("Project asset content is empty.");
  if (extension === ".pptx") {
    if (buffer.length > maxProjectPresentationAssetBytes) throw new Error("PPTX asset exceeds 25 MiB.");
  } else if (buffer.length > maxProjectImageAssetBytes) {
    throw new Error("Image asset exceeds 10 MiB.");
  }

  if (extension === ".png" && !hasBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) throw new Error("PNG asset has invalid magic bytes.");
  if ((extension === ".jpg" || extension === ".jpeg") && !hasBytes(buffer, [0xff, 0xd8, 0xff])) throw new Error("JPEG asset has invalid magic bytes.");
  if (extension === ".gif" && !includesAscii(buffer.subarray(0, 6), "GIF87a") && !includesAscii(buffer.subarray(0, 6), "GIF89a")) throw new Error("GIF asset has invalid magic bytes.");
  if (extension === ".webp" && (!includesAscii(buffer.subarray(0, 4), "RIFF") || !includesAscii(buffer.subarray(8, 12), "WEBP"))) throw new Error("WebP asset has invalid magic bytes.");
  if (extension === ".pptx" && (!hasBytes(buffer, [0x50, 0x4b]) || !includesAscii(buffer, "[Content_Types].xml") || !includesAscii(buffer, "ppt/"))) {
    throw new Error("PPTX asset must be an OOXML presentation package.");
  }
  if (extension === ".svg") validateSvgAsset(buffer);
}

function normalizeProjectMetadata(metadata: ProjectMetadata): ProjectMetadata {
  return {
    ...metadata,
    taskHistory: metadata.taskHistory ?? []
  };
}

async function readProjectMetadata(projectRoot: string, projectId: string): Promise<ProjectMetadata> {
  const raw = await readFile(getProjectMetadataPath(projectRoot, projectId), "utf8");
  const parsed = JSON.parse(raw);
  if (
    !parsed || typeof parsed !== "object"
    || typeof parsed.id !== "string"
    || typeof parsed.title !== "string"
    || typeof parsed.status !== "string"
    || typeof parsed.entryFile !== "string"
  ) {
    throw new Error(`Project metadata for ${projectId} is invalid or corrupted.`);
  }
  return normalizeProjectMetadata(parsed as ProjectMetadata);
}

async function writeProjectMetadata(projectRoot: string, metadata: ProjectMetadata): Promise<void> {
  await mkdir(getProjectDirectory(projectRoot, metadata.id), { recursive: true });
  await writeFile(getProjectMetadataPath(projectRoot, metadata.id), `${JSON.stringify(normalizeProjectMetadata(metadata), null, 2)}\n`, "utf8");
}

function addHistory(metadata: ProjectMetadata, event: Omit<ProjectTaskHistoryItem, "id" | "time">): ProjectMetadata {
  const item: ProjectTaskHistoryItem = {
    id: randomUUID(),
    time: new Date().toISOString(),
    ...event
  };
  return {
    ...metadata,
    updatedAt: item.time,
    taskHistory: [...(metadata.taskHistory ?? []), item].slice(-maxTaskHistoryItems)
  };
}

function makeProjectPublicUrl(publicBaseUrl: string, shareBasePath: string | undefined, projectId: string, entryFile: string): string {
  const base = publicBaseUrl.replace(/\/$/, "");
  const sharePath = shareBasePath?.startsWith("/") ? shareBasePath : `/${shareBasePath ?? "share"}`;
  return `${base}${sharePath.replace(/\/$/, "")}/${projectId}/${entryFile}`;
}

export async function appendProjectTaskHistory(
  projectRoot: string,
  projectId: string,
  event: Omit<ProjectTaskHistoryItem, "id" | "time">
): Promise<ProjectMetadata> {
  const metadata = await getProject(projectRoot, projectId);
  const updated = addHistory(metadata, event);
  await writeProjectMetadata(projectRoot, updated);
  return updated;
}

export async function createProject(
  projectRoot: string,
  input: { title: string; summary?: string; createdByClientId: string; entryFile?: string }
): Promise<ProjectMetadata> {
  const id = `project_${randomUUID()}`;
  const now = new Date().toISOString();
  const entryFile = assertSafeProjectFilePath(input.entryFile ?? "index.html");
  const metadata: ProjectMetadata = {
    id,
    title: input.title,
    summary: input.summary ?? "",
    createdAt: now,
    updatedAt: now,
    createdByClientId: input.createdByClientId,
    status: "draft",
    entryFile,
    taskHistory: [
      {
        id: randomUUID(),
        time: now,
        toolName: "create_project",
        ok: true,
        summary: `Created project ${id}.`,
        details: { entryFile }
      }
    ]
  };
  await mkdir(getProjectFilesDirectory(projectRoot, id), { recursive: true });
  await mkdir(getProjectWorkspaceDirectory(projectRoot, id), { recursive: true });
  await writeProjectMetadata(projectRoot, metadata);
  return metadata;
}

export async function clearProjectFiles(projectRoot: string, projectId: string): Promise<void> {
  const metadata = await getProject(projectRoot, projectId);
  if (metadata.status === "deleted") throw new Error("Cannot clear files from a deleted project.");
  const filesRoot = getProjectFilesDirectory(projectRoot, projectId);
  await rm(filesRoot, { recursive: true, force: true });
  await mkdir(filesRoot, { recursive: true });
}

export async function listProjectFiles(projectRoot: string, projectId: string): Promise<ProjectFileInfo[]> {
  const filesRoot = getProjectFilesDirectory(projectRoot, projectId);
  const output: ProjectFileInfo[] = [];

  async function walk(currentDirectory: string): Promise<void> {
    let entries: DirectoryEntryLike[];
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStat = await stat(absolutePath);
      output.push({
        path: path.relative(filesRoot, absolutePath).replaceAll("\\", "/"),
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString()
      });
    }
  }

  await walk(filesRoot);
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

export async function listProjects(projectRoot: string, includeDeleted = false): Promise<ProjectSummary[]> {
  let entries: DirectoryEntryLike[];
  try {
    entries = await readdir(projectRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const projects = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      try {
        const metadata = await readProjectMetadata(projectRoot, entry.name);
        if (!includeDeleted && metadata.status === "deleted") return undefined;
        const files = await listProjectFiles(projectRoot, entry.name);
        return { ...metadata, filesCount: files.length };
      } catch {
        return undefined;
      }
    }));

  return projects
    .filter((project): project is ProjectSummary => Boolean(project))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function countProjects(projectRoot: string): Promise<number> {
  return (await listProjects(projectRoot, false)).length;
}

export async function getProject(projectRoot: string, projectId: string): Promise<ProjectMetadata> {
  return readProjectMetadata(projectRoot, projectId);
}

export async function getProjectWithFiles(projectRoot: string, projectId: string): Promise<{ metadata: ProjectMetadata; files: ProjectFileInfo[] }> {
  const metadata = await getProject(projectRoot, projectId);
  const files = await listProjectFiles(projectRoot, projectId);
  return { metadata, files };
}

export async function getProjectManifest(projectRoot: string, projectId: string): Promise<ProjectManifest> {
  const { metadata, files } = await getProjectWithFiles(projectRoot, projectId);
  return {
    metadata,
    files,
    entryFile: metadata.entryFile,
    publishedUrl: metadata.publishedUrl,
    lastValidation: metadata.lastValidation,
    taskHistory: metadata.taskHistory ?? []
  };
}

export async function getProjectActivity(projectRoot: string, projectId: string, limit = 50): Promise<ProjectActivity> {
  const metadata = await getProject(projectRoot, projectId);
  return {
    projectId,
    status: metadata.status,
    publishedUrl: metadata.publishedUrl,
    createdByClientId: metadata.createdByClientId,
    lastValidation: metadata.lastValidation,
    taskHistory: (metadata.taskHistory ?? []).slice(-limit)
  };
}

export async function writeProjectFile(projectRoot: string, projectId: string, relativePath: string, content: string): Promise<ProjectFileInfo> {
  if (Buffer.byteLength(content, "utf8") > maxProjectFileBytes) {
    throw new Error("Project file content exceeds 1 MiB.");
  }

  const metadata = await getProject(projectRoot, projectId);
  if (metadata.status === "deleted") throw new Error("Cannot write to a deleted project.");

  const absolutePath = resolveProjectFilePath(projectRoot, projectId, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");

  const fileStat = await stat(absolutePath);
  const file = {
    path: assertSafeProjectFilePath(relativePath),
    size: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString()
  };
  const updated = addHistory(metadata, {
    toolName: "write_project_file",
    ok: true,
    summary: `Wrote ${file.path}.`,
    details: { path: file.path, size: file.size }
  });
  await writeProjectMetadata(projectRoot, updated);

  return file;
}

export async function patchProjectFile(
  projectRoot: string,
  projectId: string,
  relativePath: string,
  operations: Array<{ find: string; replace: string; all?: boolean }>
): Promise<ProjectFileInfo> {
  const metadata = await getProject(projectRoot, projectId);
  if (metadata.status === "deleted") throw new Error("Cannot patch a deleted project.");

  const safeRelativePath = assertSafeProjectFilePath(relativePath);
  const absolutePath = resolveProjectStoredPath(projectRoot, projectId, safeRelativePath);
  const fileStatBefore = await stat(absolutePath);
  if (fileStatBefore.size > maxProjectFileBytes) {
    throw new Error(`Project file is too large to patch. Size=${fileStatBefore.size}, maxBytes=${maxProjectFileBytes}.`);
  }

  let content = await readFile(absolutePath, "utf8");
  const applied: Array<{ find: string; replace: string; count: number; all: boolean }> = [];
  for (const operation of operations) {
    if (!operation.find) throw new Error("Patch find text must not be empty.");
    const count = operation.all
      ? content.split(operation.find).length - 1
      : content.includes(operation.find) ? 1 : 0;
    if (count === 0) throw new Error(`Patch find text not found in ${safeRelativePath}: ${operation.find.slice(0, 80)}`);
    content = operation.all
      ? content.split(operation.find).join(operation.replace)
      : content.replace(operation.find, operation.replace);
    applied.push({ find: operation.find, replace: operation.replace, count, all: operation.all === true });
  }

  if (Buffer.byteLength(content, "utf8") > maxProjectFileBytes) {
    throw new Error("Patched project file content exceeds 1 MiB.");
  }

  await writeFile(absolutePath, content, "utf8");
  const fileStat = await stat(absolutePath);
  const file = {
    path: safeRelativePath,
    size: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString()
  };
  const updated = addHistory(metadata, {
    toolName: "patch_project_file",
    ok: true,
    summary: `Patched ${file.path}.`,
    details: { path: file.path, operations: applied.map((operation) => ({ count: operation.count, all: operation.all })) }
  });
  await writeProjectMetadata(projectRoot, updated);

  return file;
}

export async function writeProjectAsset(projectRoot: string, projectId: string, relativePath: string, content: Buffer, contentType?: string): Promise<ProjectFileInfo> {
  const safeRelativePath = assertSafeProjectAssetPath(relativePath);
  validateProjectAssetBytes(safeRelativePath, content, contentType);

  const metadata = await getProject(projectRoot, projectId);
  if (metadata.status === "deleted") throw new Error("Cannot write to a deleted project.");

  const absolutePath = resolveProjectAssetPath(projectRoot, projectId, safeRelativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);

  const fileStat = await stat(absolutePath);
  const file = {
    path: safeRelativePath,
    size: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString()
  };
  const updated = addHistory(metadata, {
    toolName: "write_project_asset",
    ok: true,
    summary: `Wrote asset ${file.path}.`,
    details: { path: file.path, size: file.size, contentType: getProjectFileContentType(file.path) }
  });
  await writeProjectMetadata(projectRoot, updated);

  return file;
}

export async function importProjectAssetFromLocalFile(
  projectRoot: string,
  projectId: string,
  relativePath: string,
  sourcePath: string,
  contentType?: string
): Promise<ProjectFileInfo> {
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error("sourcePath must point to a file.");
  const maxBytes = path.extname(relativePath).toLowerCase() === ".pptx" ? maxProjectPresentationAssetBytes : maxProjectImageAssetBytes;
  if (sourceStat.size > maxBytes) throw new Error("Local asset exceeds the size limit.");
  const buffer = await readFile(sourcePath);
  return writeProjectAsset(projectRoot, projectId, relativePath, buffer, contentType);
}

export async function readProjectFile(projectRoot: string, projectId: string, relativePath: string, maxBytes = maxProjectFileBytes): Promise<string> {
  const metadata = await getProject(projectRoot, projectId);
  if (metadata.status === "deleted") throw new Error("Cannot read a deleted project.");

  const absolutePath = resolveProjectFilePath(projectRoot, projectId, relativePath);
  const fileStat = await stat(absolutePath);
  if (fileStat.size > maxBytes) {
    throw new Error(`Project file is too large to read. Size=${fileStat.size}, maxBytes=${maxBytes}.`);
  }
  return readFile(absolutePath, "utf8");
}

function isExternalOrNonFileReference(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed
    || trimmed.startsWith("#")
    || /^(?:https?:|\/\/|data:|mailto:|tel:|javascript:|blob:)/i.test(trimmed);
}

function normalizeHtmlReference(entryFile: string, reference: string): string | undefined {
  if (isExternalOrNonFileReference(reference)) return undefined;
  const withoutQuery = reference.split("#")[0]?.split("?")[0] ?? "";
  if (!withoutQuery || withoutQuery.startsWith("/")) return undefined;
  const entryDirectory = path.posix.dirname(entryFile.replaceAll("\\", "/"));
  const joined = entryDirectory === "." ? withoutQuery : path.posix.join(entryDirectory, withoutQuery);
  return path.posix.normalize(joined);
}

function extractLocalHtmlReferences(entryFile: string, html: string): string[] {
  const references = new Set<string>();
  const patterns = [
    /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi,
    /\bsrcset\s*=\s*["']([^"']+)["']/gi
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      const candidates = pattern.source.includes("srcset")
        ? raw.split(",").map((item) => item.trim().split(/\s+/)[0]).filter(Boolean)
        : [raw];
      for (const candidate of candidates) {
        const normalized = normalizeHtmlReference(entryFile, candidate);
        if (normalized) references.add(normalized);
      }
    }
  }
  return [...references].sort();
}

export async function validateProject(projectRoot: string, projectId: string, entryFile?: string, profile: ProjectValidationProfile = "static_html"): Promise<ProjectValidationResult> {
  const metadata = await getProject(projectRoot, projectId);
  const warnings: string[] = [];
  const errors: string[] = [];
  const checkedAt = new Date().toISOString();
  const files = await listProjectFiles(projectRoot, projectId);
  const filePaths = new Set(files.map((file) => file.path));
  const safeEntryFile = (() => {
    try {
      return assertSafeProjectFilePath(entryFile ?? metadata.entryFile);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Invalid entry file.");
      return entryFile ?? metadata.entryFile;
    }
  })();

  if (metadata.status === "deleted") {
    errors.push("Cannot validate a deleted project.");
  }

  for (const file of files) {
    try {
      assertSafeProjectStoredPath(file.path);
    } catch (error) {
      errors.push(`Invalid file path ${file.path}: ${error instanceof Error ? error.message : "invalid path"}`);
    }
    const extension = path.extname(file.path).toLowerCase();
    const maxBytes = extension === ".pptx" ? maxProjectPresentationAssetBytes : allowedAssetExtensions.has(extension) ? maxProjectImageAssetBytes : maxProjectFileBytes;
    if (file.size > maxBytes) {
      errors.push(`File exceeds max size: ${file.path}`);
    }
  }

  const entry = files.find((file) => file.path === safeEntryFile);
  if (!entry) {
    errors.push(`Entry file not found: ${safeEntryFile}`);
  } else if (safeEntryFile.toLowerCase().endsWith(".html")) {
    try {
      const html = await readProjectFile(projectRoot, projectId, safeEntryFile, maxProjectFileBytes);
      const lowerHtml = html.toLowerCase();
      if (!lowerHtml.includes("<html") || !lowerHtml.includes("</html>")) {
        warnings.push(`Entry HTML should include <html> and </html>: ${safeEntryFile}`);
      }
      if (!lowerHtml.includes("<body") || !lowerHtml.includes("</body>")) {
        warnings.push(`Entry HTML should include <body> and </body>: ${safeEntryFile}`);
      }
      const references = extractLocalHtmlReferences(safeEntryFile, html);
      for (const reference of references) {
        try {
          const safeReference = assertSafeProjectStoredPath(reference);
          if (!filePaths.has(safeReference)) {
            errors.push(`Referenced local resource not found: ${reference}`);
          }
        } catch (error) {
          errors.push(`Invalid local resource reference ${reference}: ${error instanceof Error ? error.message : "invalid reference"}`);
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Unable to read entry file: ${safeEntryFile}`);
    }
  } else {
    warnings.push(`Entry file is not HTML: ${safeEntryFile}`);
  }

  const result: ProjectValidationResult = {
    ok: errors.length === 0,
    status: errors.length > 0 ? "failed" : warnings.length > 0 ? "warnings" : "valid",
    profile,
    projectId,
    entryFile: safeEntryFile,
    filesChecked: files.length,
    warnings,
    errors,
    checkedAt
  };

  const updated = addHistory({ ...metadata, lastValidation: result }, {
    toolName: "validate_project",
    ok: result.ok,
    summary: result.ok ? `Validated project ${projectId}.` : `Validation failed for ${projectId}.`,
    details: result
  });
  await writeProjectMetadata(projectRoot, updated);

  return result;
}

export async function publishProject(projectRoot: string, projectId: string, publicBaseUrl: string, entryFile?: string, options: PublishProjectOptions = {}): Promise<ProjectMetadata> {
  const metadata = await getProject(projectRoot, projectId);
  if (metadata.status === "deleted") throw new Error("Cannot publish a deleted project.");

  const safeEntryFile = assertSafeProjectFilePath(entryFile ?? metadata.entryFile);
  await stat(resolveProjectFilePath(projectRoot, projectId, safeEntryFile));
  const publishedUrl = makeProjectPublicUrl(publicBaseUrl, options.shareBasePath, projectId, safeEntryFile);
  const updated = addHistory({
    ...metadata,
    status: "published" as ProjectStatus,
    entryFile: safeEntryFile,
    publishedUrl
  }, {
    toolName: "publish_project",
    ok: true,
    summary: `Published ${projectId}.`,
    details: { entryFile: safeEntryFile, publishedUrl }
  });
  await writeProjectMetadata(projectRoot, updated);
  return updated;
}

export async function forkProject(
  projectRoot: string,
  sourceProjectId: string,
  input: { title?: string; summary?: string; createdByClientId: string }
): Promise<ProjectMetadata> {
  const source = await getProject(projectRoot, sourceProjectId);
  if (source.status === "deleted") throw new Error("Cannot fork a deleted project.");

  const id = `project_${randomUUID()}`;
  const now = new Date().toISOString();
  const metadata: ProjectMetadata = {
    id,
    title: input.title ?? `${source.title} V2`,
    summary: input.summary ?? source.summary,
    createdAt: now,
    updatedAt: now,
    createdByClientId: input.createdByClientId,
    status: "draft",
    entryFile: source.entryFile,
    lastValidation: undefined,
    taskHistory: [
      {
        id: randomUUID(),
        time: now,
        toolName: "fork_project",
        ok: true,
        summary: `Forked ${sourceProjectId} into ${id}.`,
        details: { sourceProjectId }
      }
    ]
  };

  await mkdir(getProjectDirectory(projectRoot, id), { recursive: true });
  await cp(getProjectFilesDirectory(projectRoot, sourceProjectId), getProjectFilesDirectory(projectRoot, id), { recursive: true });
  await writeProjectMetadata(projectRoot, metadata);
  return metadata;
}

export async function setProjectStatus(projectRoot: string, projectId: string, status: Exclude<ProjectStatus, "deleted">, publicBaseUrl: string, options: PublishProjectOptions = {}): Promise<ProjectMetadata> {
  if (status === "published") {
    return publishProject(projectRoot, projectId, publicBaseUrl, undefined, options);
  }

  const metadata = await getProject(projectRoot, projectId);
  if (metadata.status === "deleted") throw new Error("Cannot update a deleted project.");
  const updated = addHistory({
    ...metadata,
    status,
    publishedUrl: undefined
  }, {
    toolName: "set_project_status",
    ok: true,
    summary: `Set ${projectId} status to ${status}.`,
    details: { status }
  });
  await writeProjectMetadata(projectRoot, updated);
  return updated;
}

export async function unpublishProject(projectRoot: string, projectId: string, reason: string): Promise<ProjectMetadata> {
  const metadata = await getProject(projectRoot, projectId);
  if (metadata.status === "deleted") throw new Error("Cannot unpublish a deleted project.");
  const updated = addHistory({
    ...metadata,
    status: "draft" as ProjectStatus,
    publishedUrl: undefined
  }, {
    toolName: "unpublish_project",
    ok: true,
    summary: reason
  });
  await writeProjectMetadata(projectRoot, updated);
  return updated;
}

export async function recordProjectBrowserInspection(
  projectRoot: string,
  projectId: string,
  browserInspection: ProjectBrowserInspectionSummary,
  toolName = "browser_validate_project"
): Promise<ProjectMetadata> {
  const metadata = await getProject(projectRoot, projectId);
  const previousValidation = metadata.lastValidation;
  const errors = [...(previousValidation?.errors ?? []), ...browserInspection.blockingErrors];
  const warnings = [...(previousValidation?.warnings ?? []), ...browserInspection.warnings];
  const lastValidation: ProjectValidationResult = {
    ok: (previousValidation?.ok ?? true) && browserInspection.ok,
    status: errors.length > 0 ? "failed" : warnings.length > 0 ? "warnings" : "valid",
    profile: previousValidation?.profile ?? "static_html",
    projectId,
    entryFile: previousValidation?.entryFile ?? metadata.entryFile,
    filesChecked: previousValidation?.filesChecked ?? 0,
    warnings,
    errors,
    checkedAt: browserInspection.inspectedAt,
    browserInspection
  };
  const updated = addHistory({ ...metadata, lastValidation }, {
    toolName,
    ok: browserInspection.ok,
    summary: browserInspection.ok
      ? `Browser validation passed for ${projectId}.`
      : `Browser validation failed for ${projectId}.`,
    details: browserInspection
  });
  await writeProjectMetadata(projectRoot, updated);
  return updated;
}

export async function publishProjectAndReport(projectRoot: string, projectId: string, publicBaseUrl: string, entryFile?: string, options: PublishProjectOptions = {}): Promise<{
  ok: boolean;
  projectId: string;
  publishedUrl?: string;
  entryFile: string;
  files: ProjectFileInfo[];
  validation: ProjectValidationResult;
  summary: string;
  nextActions: string[];
}> {
  const validation = await validateProject(projectRoot, projectId, entryFile);
  const manifestBeforePublish = await getProjectManifest(projectRoot, projectId);
  if (!validation.ok) {
    await appendProjectTaskHistory(projectRoot, projectId, {
      toolName: "publish_and_report",
      ok: false,
      summary: `Publish blocked by validation errors for ${projectId}.`,
      details: { validation }
    });
    return {
      ok: false,
      projectId,
      entryFile: validation.entryFile,
      files: manifestBeforePublish.files,
      validation,
      summary: `Publish blocked by validation errors for ${projectId}.`,
      nextActions: ["Fix validation errors before publishing."]
    };
  }

  const published = await publishProject(projectRoot, projectId, publicBaseUrl, validation.entryFile, options);
  const manifest = await getProjectManifest(projectRoot, projectId);
  await appendProjectTaskHistory(projectRoot, projectId, {
    toolName: "publish_and_report",
    ok: true,
    summary: `Published and reported ${projectId}.`,
    details: { publishedUrl: published.publishedUrl, validation }
  });
  return {
    ok: true,
    projectId,
    publishedUrl: published.publishedUrl,
    entryFile: published.entryFile,
    files: manifest.files,
    validation,
    summary: `Published project ${projectId} at ${published.publishedUrl}.`,
    nextActions: ["Return the publishedUrl to the user."]
  };
}

export async function deleteProjectFile(projectRoot: string, projectId: string, relativePath: string): Promise<void> {
  const metadata = await getProject(projectRoot, projectId);
  if (metadata.status === "deleted") throw new Error("Cannot delete files from a deleted project.");

  const safeRelativePath = assertSafeProjectStoredPath(relativePath);
  const absolutePath = resolveProjectStoredPath(projectRoot, projectId, safeRelativePath);
  await rm(absolutePath, { force: true });
  const updated = addHistory(metadata, {
    toolName: "delete_project_file",
    ok: true,
    summary: `Deleted ${safeRelativePath}.`,
    details: { path: safeRelativePath }
  });
  await writeProjectMetadata(projectRoot, updated);
}

export async function deleteProject(projectRoot: string, projectId: string): Promise<ProjectMetadata> {
  const metadata = await getProject(projectRoot, projectId);
  const updated = addHistory({
    ...metadata,
    status: "deleted" as ProjectStatus,
    publishedUrl: undefined
  }, {
    toolName: "delete_project",
    ok: true,
    summary: `Soft-deleted project ${projectId}.`
  });
  await writeProjectMetadata(projectRoot, updated);
  return updated;
}
