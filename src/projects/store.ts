import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type ProjectStatus = "draft" | "published" | "deleted";
export type ProjectValidationStatus = "valid" | "warnings" | "failed";

export interface ProjectValidationResult {
  ok: boolean;
  status: ProjectValidationStatus;
  projectId: string;
  entryFile: string;
  filesChecked: number;
  warnings: string[];
  errors: string[];
  checkedAt: string;
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

export const maxProjectFileBytes = 1024 * 1024;

const metadataFilename = "project.json";
const filesDirectoryName = "files";
const maxTaskHistoryItems = 100;
const allowedTextExtensions = new Set([".html", ".css", ".js", ".json", ".txt", ".md", ".svg"]);

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

function getProjectMetadataPath(projectRoot: string, projectId: string): string {
  return path.join(getProjectDirectory(projectRoot, projectId), metadataFilename);
}

function assertSafeProjectId(projectId: string): void {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(projectId)) {
    throw new Error("Invalid projectId.");
  }
}

export function assertSafeProjectFilePath(relativePath: string): string {
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
  if (!allowedTextExtensions.has(extension)) {
    throw new Error(`Unsupported project file extension: ${extension || "(none)"}.`);
  }

  return parts.join("/");
}

function resolveProjectFilePath(projectRoot: string, projectId: string, relativePath: string): string {
  const safeRelativePath = assertSafeProjectFilePath(relativePath);
  const filesRoot = getProjectFilesDirectory(projectRoot, projectId);
  const resolved = path.resolve(filesRoot, safeRelativePath);
  const normalizedRoot = path.resolve(filesRoot);
  if (!resolved.startsWith(`${normalizedRoot}${path.sep}`) && resolved !== normalizedRoot) {
    throw new Error("Resolved project file path is outside the project.");
  }
  return resolved;
}

function normalizeProjectMetadata(metadata: ProjectMetadata): ProjectMetadata {
  return {
    ...metadata,
    taskHistory: metadata.taskHistory ?? []
  };
}

async function readProjectMetadata(projectRoot: string, projectId: string): Promise<ProjectMetadata> {
  const raw = await readFile(getProjectMetadataPath(projectRoot, projectId), "utf8");
  const parsed = JSON.parse(raw) as ProjectMetadata;
  return normalizeProjectMetadata(parsed);
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
  await writeProjectMetadata(projectRoot, metadata);
  return metadata;
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

export async function validateProject(projectRoot: string, projectId: string, entryFile?: string): Promise<ProjectValidationResult> {
  const metadata = await getProject(projectRoot, projectId);
  const warnings: string[] = [];
  const errors: string[] = [];
  const checkedAt = new Date().toISOString();
  const files = await listProjectFiles(projectRoot, projectId);
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
      assertSafeProjectFilePath(file.path);
    } catch (error) {
      errors.push(`Invalid file path ${file.path}: ${error instanceof Error ? error.message : "invalid path"}`);
    }
    if (file.size > maxProjectFileBytes) {
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
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Unable to read entry file: ${safeEntryFile}`);
    }
  } else {
    warnings.push(`Entry file is not HTML: ${safeEntryFile}`);
  }

  const result: ProjectValidationResult = {
    ok: errors.length === 0,
    status: errors.length > 0 ? "failed" : warnings.length > 0 ? "warnings" : "valid",
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

export async function publishProject(projectRoot: string, projectId: string, publicBaseUrl: string, entryFile?: string): Promise<ProjectMetadata> {
  const metadata = await getProject(projectRoot, projectId);
  if (metadata.status === "deleted") throw new Error("Cannot publish a deleted project.");

  const safeEntryFile = assertSafeProjectFilePath(entryFile ?? metadata.entryFile);
  await stat(resolveProjectFilePath(projectRoot, projectId, safeEntryFile));
  const publishedUrl = `${publicBaseUrl.replace(/\/$/, "")}/share/${projectId}/${safeEntryFile}`;
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

export async function publishProjectAndReport(projectRoot: string, projectId: string, publicBaseUrl: string, entryFile?: string): Promise<{
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

  const published = await publishProject(projectRoot, projectId, publicBaseUrl, validation.entryFile);
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

  const absolutePath = resolveProjectFilePath(projectRoot, projectId, relativePath);
  await rm(absolutePath, { force: true });
  const updated = addHistory(metadata, {
    toolName: "delete_project_file",
    ok: true,
    summary: `Deleted ${relativePath}.`,
    details: { path: relativePath }
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
