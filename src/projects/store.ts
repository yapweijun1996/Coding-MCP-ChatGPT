import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { withKeyedLock } from "../shared/keyed-lock.js";
import { atomicWrite } from "../shared/atomic-write.js";

// Serialization key for a single project's metadata + files. All read-modify-write
// sequences for one project run under this key so concurrent tool calls can't clobber
// each other's task history / status / file content (lost-update races).
function projectLockKey(projectRoot: string, projectId: string): string {
  return `project:${path.resolve(projectRoot)}::${projectId}`;
}

export type ProjectStatus = "draft" | "private" | "published" | "deleted";
export type ProjectShareAccess = "private" | "anyone_with_link";
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

export type ProjectTaskStatus = "todo" | "doing" | "blocked" | "done";
export type ProjectTaskPriority = "low" | "medium" | "high" | "urgent";

export interface ProjectTaskEvidenceLink {
  label: string;
  kind?: "validation" | "inspect_report" | "screenshot" | "published_url" | "changed_file" | "artifact" | "note";
  url?: string;
  artifact?: string;
  filePath?: string;
  note?: string;
  recordedAt?: string;
}

export interface ProjectTaskItem {
  id: string;
  title: string;
  status: ProjectTaskStatus;
  priority: ProjectTaskPriority;
  notes: string;
  progress: number;
  dependsOn: string[];
  evidence: ProjectTaskEvidenceLink[];
  blockedReason?: string;
  unblockRequirement?: string;
  blockedAt?: string;
  completionSummary?: string;
  completedFiles?: string[];
  completionValidation?: {
    ok: boolean;
    status: ProjectValidationStatus;
    checkedAt: string;
    entryFile: string;
    errors: string[];
    warnings: string[];
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ProjectWorkspaceBinding {
  path: string;
  gitRoot?: string;
  boundAt: string;
}

export type ReviewSeverity = "low" | "medium" | "high" | "critical";
export type ReviewCategory =
  | "bug"
  | "ux"
  | "visual"
  | "accessibility"
  | "performance"
  | "content"
  | "security"
  | "other";
export type ReviewStatus = "open" | "addressed" | "wontfix";
export type ProjectReviewCommentStatus = "open" | "resolved" | "wontfix";
export type ProjectReviewCommentTargetType = "file" | "screenshot" | "ui-region" | "issue" | "project";

export interface ProjectReviewCommentRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProjectReviewCommentReply {
  id: string;
  body: string;
  authorClientId?: string;
  createdAt: string;
}

export interface ProjectReviewComment {
  id: string;
  title: string;
  body: string;
  severity: ReviewSeverity;
  status: ProjectReviewCommentStatus;
  targetType: ProjectReviewCommentTargetType;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  screenshotPath?: string;
  region?: ProjectReviewCommentRegion;
  selector?: string;
  issueId?: string;
  assignedTo?: string;
  reviewerClientId?: string;
  resolutionNote?: string;
  replies: ProjectReviewCommentReply[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface ProjectReviewCommentInput {
  title: string;
  body: string;
  severity: ReviewSeverity;
  targetType: ProjectReviewCommentTargetType;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  screenshotPath?: string;
  region?: ProjectReviewCommentRegion;
  selector?: string;
  issueId?: string;
  assignedTo?: string;
}

// A single structured finding from a reviewer (e.g. ChatGPT after testing the generated page),
// fed back to the coding agent so it can iterate on this specific project. Stored on the
// project metadata (project.json), NOT in the published files/ directory, so it never leaks to
// the public share URL.
export interface ReviewFinding {
  id: string;
  title: string;
  detail: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  area?: string;
  suggestion?: string;
  pageUrl?: string;
  status: ReviewStatus;
  resolutionNote?: string;
  reportedByClientId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewFindingInput {
  title: string;
  detail: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  area?: string;
  suggestion?: string;
  pageUrl?: string;
}

export interface ProjectMetadata {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  createdByClientId: string;
  status: ProjectStatus;
  shareAccess?: ProjectShareAccess;
  entryFile: string;
  publishedUrl?: string;
  workspaceBinding?: ProjectWorkspaceBinding;
  lastValidation?: ProjectValidationResult;
  taskHistory?: ProjectTaskHistoryItem[];
  taskList?: ProjectTaskItem[];
  reviewFeedback?: ReviewFinding[];
  reviewComments?: ProjectReviewComment[];
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
  workspaceBinding?: ProjectWorkspaceBinding;
  lastValidation?: ProjectValidationResult;
  taskHistory: ProjectTaskHistoryItem[];
  taskList: ProjectTaskItem[];
}

export interface ProjectActivity {
  projectId: string;
  status: ProjectStatus;
  publishedUrl?: string;
  createdByClientId: string;
  lastValidation?: ProjectValidationResult;
  taskHistory: ProjectTaskHistoryItem[];
  taskList: ProjectTaskItem[];
}

export interface ProjectTaskGraphNode extends ProjectTaskItem {
  blockedBy: string[];
  blocked: boolean;
  dependents: string[];
  blockedReasons: Array<{
    type: "explicit" | "dependency";
    reason: string;
    unblockRequirement: string;
    blockingTaskId?: string;
  }>;
}

export interface ProjectTaskGraph {
  projectId: string;
  nodes: ProjectTaskGraphNode[];
  edges: Array<{ from: string; to: string }>;
  readyTasks: ProjectTaskGraphNode[];
  blockedTasks: ProjectTaskGraphNode[];
  cycles: string[][];
}

export interface PublishProjectOptions {
  shareBasePath?: string;
  shareAccess?: ProjectShareAccess;
}

export const maxProjectFileBytes = 1024 * 1024;
export const maxProjectImageAssetBytes = 10 * 1024 * 1024;
export const maxProjectMediaAssetBytes = 100 * 1024 * 1024;
export const maxProjectPresentationAssetBytes = 25 * 1024 * 1024;
export const maxProjectArchiveAssetBytes = 50 * 1024 * 1024;

const metadataFilename = "project.json";
const filesDirectoryName = "files";
const workspaceDirectoryName = "workspace";
const maxTaskHistoryItems = 100;
const allowedTextExtensions = new Set([".html", ".css", ".js", ".mjs", ".json", ".webmanifest", ".txt", ".md", ".csv", ".svg"]);
const allowedAssetExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".glb", ".gltf", ".hdr", ".exr", ".ktx2", ".mp3", ".wav", ".ogg", ".mid", ".midi", ".sfz", ".sf2", ".sf3", ".mp4", ".webm", ".pptx", ".zip"]);
const mediaAssetExtensions = new Set([".glb", ".gltf", ".hdr", ".exr", ".ktx2", ".mp3", ".wav", ".ogg", ".mid", ".midi", ".sfz", ".sf2", ".sf3", ".mp4", ".webm"]);
const projectContentTypes = new Map([
  [".html", "text/html"],
  [".css", "text/css"],
  [".js", "application/javascript"],
  [".mjs", "application/javascript"],
  [".json", "application/json"],
  [".webmanifest", "application/manifest+json"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".csv", "text/csv"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".glb", "model/gltf-binary"],
  [".gltf", "model/gltf+json"],
  [".hdr", "image/vnd.radiance"],
  [".exr", "image/aces"],
  [".ktx2", "image/ktx2"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".mid", "audio/midi"],
  [".midi", "audio/midi"],
  [".sfz", "text/plain"],
  [".sf2", "audio/soundfont"],
  [".sf3", "audio/soundfont"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".zip", "application/zip"]
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
  if (extension === ".zip") {
    if (buffer.length > maxProjectArchiveAssetBytes) throw new Error("ZIP asset exceeds 50 MiB.");
  } else if (extension === ".pptx") {
    if (buffer.length > maxProjectPresentationAssetBytes) throw new Error("PPTX asset exceeds 25 MiB.");
  } else if (mediaAssetExtensions.has(extension)) {
    if (buffer.length > maxProjectMediaAssetBytes) throw new Error("Media/model asset exceeds 100 MiB.");
  } else if (buffer.length > maxProjectImageAssetBytes) {
    throw new Error("Image asset exceeds 10 MiB.");
  }

  if (extension === ".png" && !hasBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) throw new Error("PNG asset has invalid magic bytes.");
  if ((extension === ".jpg" || extension === ".jpeg") && !hasBytes(buffer, [0xff, 0xd8, 0xff])) throw new Error("JPEG asset has invalid magic bytes.");
  if (extension === ".gif" && !includesAscii(buffer.subarray(0, 6), "GIF87a") && !includesAscii(buffer.subarray(0, 6), "GIF89a")) throw new Error("GIF asset has invalid magic bytes.");
  if (extension === ".webp" && (!includesAscii(buffer.subarray(0, 4), "RIFF") || !includesAscii(buffer.subarray(8, 12), "WEBP"))) throw new Error("WebP asset has invalid magic bytes.");
  if (extension === ".glb" && !includesAscii(buffer.subarray(0, 4), "glTF")) throw new Error("GLB asset has invalid magic bytes.");
  if ((extension === ".mid" || extension === ".midi") && !includesAscii(buffer.subarray(0, 4), "MThd")) throw new Error("MIDI asset has invalid magic bytes.");
  if ((extension === ".sf2" || extension === ".sf3") && (!includesAscii(buffer.subarray(0, 4), "RIFF") || !includesAscii(buffer.subarray(8, 12), "sfbk"))) throw new Error("SoundFont asset has invalid magic bytes.");
  if (extension === ".sfz") {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      decoder.decode(buffer);
    } catch {
      throw new Error("SFZ assets must be valid UTF-8.");
    }
  }
  if (extension === ".gltf") {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parsed = JSON.parse(decoder.decode(buffer)) as { asset?: { version?: unknown } };
    if (!parsed.asset || typeof parsed.asset.version !== "string") throw new Error("GLTF asset must contain asset.version.");
  }
  if (extension === ".pptx" && (!hasBytes(buffer, [0x50, 0x4b]) || !includesAscii(buffer, "[Content_Types].xml") || !includesAscii(buffer, "ppt/"))) {
    throw new Error("PPTX asset must be an OOXML presentation package.");
  }
  if (extension === ".zip" && !hasBytes(buffer, [0x50, 0x4b])) throw new Error("ZIP asset has invalid magic bytes.");
  if (extension === ".svg") validateSvgAsset(buffer);
}

function maxProjectAssetBytesForExtension(extension: string): number {
  if (extension === ".zip") return maxProjectArchiveAssetBytes;
  if (extension === ".pptx") return maxProjectPresentationAssetBytes;
  if (mediaAssetExtensions.has(extension)) return maxProjectMediaAssetBytes;
  if (allowedAssetExtensions.has(extension)) return maxProjectImageAssetBytes;
  return maxProjectFileBytes;
}

function normalizeProjectMetadata(metadata: ProjectMetadata): ProjectMetadata {
  const taskList = (metadata.taskList ?? []).map((task) => ({ ...task, dependsOn: task.dependsOn ?? [] }));
  return {
    ...metadata,
    shareAccess: metadata.shareAccess ?? "private",
    taskHistory: metadata.taskHistory ?? [],
    taskList
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
  await atomicWrite(getProjectMetadataPath(projectRoot, metadata.id), `${JSON.stringify(normalizeProjectMetadata(metadata), null, 2)}\n`);
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
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
    const metadata = await getProject(projectRoot, projectId);
    const updated = addHistory(metadata, event);
    await writeProjectMetadata(projectRoot, updated);
    return updated;
  });
}

const maxReviewFindings = 500;
const maxReviewComments = 1000;

function nextReviewFindingId(findings: ReviewFinding[]): number {
  return findings.reduce((max, finding) => {
    const match = /^finding_(\d+)$/.exec(finding.id);
    return match ? Math.max(max, Number.parseInt(match[1], 10)) : max;
  }, 0) + 1;
}

// Reviewer (e.g. ChatGPT) submits structured findings about a generated project's page. Both
// the review feedback and the task-history entry are written under one held lock via addHistory
// — calling appendProjectTaskHistory here would deadlock on the same non-reentrant project lock.
export async function submitReviewFeedback(
  projectRoot: string,
  projectId: string,
  findings: ReviewFindingInput[],
  reportedByClientId?: string
): Promise<{ metadata: ProjectMetadata; added: ReviewFinding[] }> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
    const metadata = await getProject(projectRoot, projectId);
    if (metadata.status === "deleted") throw new Error("Cannot review a deleted project.");
    const existing = metadata.reviewFeedback ?? [];
    const now = new Date().toISOString();
    let counter = nextReviewFindingId(existing);
    const added: ReviewFinding[] = findings.map((finding) => ({
      id: `finding_${String(counter++).padStart(3, "0")}`,
      title: finding.title.trim(),
      detail: finding.detail.trim(),
      severity: finding.severity,
      category: finding.category,
      area: finding.area?.trim() || undefined,
      suggestion: finding.suggestion?.trim() || undefined,
      pageUrl: finding.pageUrl?.trim() || undefined,
      status: "open",
      reportedByClientId,
      createdAt: now,
      updatedAt: now
    }));
    const nextFindings = [...existing, ...added].slice(-maxReviewFindings);
    const updated = addHistory({ ...metadata, reviewFeedback: nextFindings }, {
      toolName: "submit_review_feedback",
      ok: true,
      summary: `Received ${added.length} review finding(s) for ${projectId}.`,
      details: { count: added.length, ids: added.map((finding) => finding.id) }
    });
    await writeProjectMetadata(projectRoot, updated);
    return { metadata: updated, added };
  });
}

export async function listReviewFeedback(
  projectRoot: string,
  projectId: string,
  filter: { status?: ReviewStatus } = {}
): Promise<ReviewFinding[]> {
  const metadata = await getProject(projectRoot, projectId);
  const findings = metadata.reviewFeedback ?? [];
  return filter.status ? findings.filter((finding) => finding.status === filter.status) : findings;
}

export async function updateReviewFindingStatus(
  projectRoot: string,
  projectId: string,
  findingId: string,
  status: ReviewStatus,
  resolutionNote?: string
): Promise<ReviewFinding> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
    const metadata = await getProject(projectRoot, projectId);
    const findings = metadata.reviewFeedback ?? [];
    const index = findings.findIndex((finding) => finding.id === findingId);
    if (index === -1) throw new Error(`No review finding ${findingId} in project ${projectId}.`);
    const now = new Date().toISOString();
    const updatedFinding: ReviewFinding = {
      ...findings[index],
      status,
      resolutionNote: resolutionNote?.trim() || findings[index].resolutionNote,
      updatedAt: now
    };
    const nextFindings = [...findings];
    nextFindings[index] = updatedFinding;
    const updated = addHistory({ ...metadata, reviewFeedback: nextFindings }, {
      toolName: "resolve_review_feedback",
      ok: true,
      summary: `Review finding ${findingId} marked ${status}.`,
      details: { findingId, status }
    });
    await writeProjectMetadata(projectRoot, updated);
    return updatedFinding;
  });
}

function nextProjectReviewCommentId(comments: ProjectReviewComment[]): number {
  const max = comments.reduce((current, comment) => {
    const match = /^comment_(\d+)$/.exec(comment.id);
    return match ? Math.max(current, Number.parseInt(match[1]!, 10)) : current;
  }, 0);
  return max + 1;
}

export async function addProjectReviewComments(
  projectRoot: string,
  projectId: string,
  comments: ProjectReviewCommentInput[],
  reviewerClientId?: string
): Promise<{ metadata: ProjectMetadata; added: ProjectReviewComment[] }> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
    const metadata = await readProjectMetadata(projectRoot, projectId);
    if (metadata.status === "deleted") throw new Error("Cannot add review comments to a deleted project.");
    const existing = metadata.reviewComments ?? [];
    const now = new Date().toISOString();
    let counter = nextProjectReviewCommentId(existing);
    const added = comments.map((comment) => {
      const item: ProjectReviewComment = {
        ...comment,
        id: `comment_${String(counter++).padStart(3, "0")}`,
        status: "open",
        reviewerClientId,
        replies: [],
        createdAt: now,
        updatedAt: now
      };
      return item;
    });
    const nextComments = [...existing, ...added].slice(-maxReviewComments);
    const updated = addHistory({ ...metadata, reviewComments: nextComments }, {
      toolName: "add_project_review_comment",
      ok: true,
      summary: `Added ${added.length} project review comment(s).`,
      details: { commentIds: added.map((comment) => comment.id) }
    });
    await writeProjectMetadata(projectRoot, updated);
    return { metadata: updated, added };
  });
}

export async function listProjectReviewComments(
  projectRoot: string,
  projectId: string,
  filters: { status?: ProjectReviewCommentStatus; targetType?: ProjectReviewCommentTargetType; assignedTo?: string } = {}
): Promise<ProjectReviewComment[]> {
  const metadata = await readProjectMetadata(projectRoot, projectId);
  return (metadata.reviewComments ?? []).filter((comment) => {
    if (filters.status && comment.status !== filters.status) return false;
    if (filters.targetType && comment.targetType !== filters.targetType) return false;
    if (filters.assignedTo && comment.assignedTo !== filters.assignedTo) return false;
    return true;
  });
}

export async function replyProjectReviewComment(
  projectRoot: string,
  projectId: string,
  commentId: string,
  body: string,
  authorClientId?: string
): Promise<ProjectReviewComment> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
    const metadata = await readProjectMetadata(projectRoot, projectId);
    const comments = metadata.reviewComments ?? [];
    const index = comments.findIndex((comment) => comment.id === commentId);
    if (index < 0) throw new Error(`No project review comment ${commentId}.`);
    const now = new Date().toISOString();
    const current = comments[index]!;
    const reply: ProjectReviewCommentReply = {
      id: `reply_${String(current.replies.length + 1).padStart(3, "0")}`,
      body,
      authorClientId,
      createdAt: now
    };
    const updatedComment: ProjectReviewComment = { ...current, replies: [...current.replies, reply], updatedAt: now };
    const nextComments = [...comments.slice(0, index), updatedComment, ...comments.slice(index + 1)];
    const updated = addHistory({ ...metadata, reviewComments: nextComments }, {
      toolName: "reply_project_review_comment",
      ok: true,
      summary: `Replied to project review comment ${commentId}.`,
      details: { commentId, replyId: reply.id }
    });
    await writeProjectMetadata(projectRoot, updated);
    return updatedComment;
  });
}

export async function updateProjectReviewCommentStatus(
  projectRoot: string,
  projectId: string,
  commentId: string,
  status: ProjectReviewCommentStatus,
  resolutionNote?: string
): Promise<ProjectReviewComment> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
    const metadata = await readProjectMetadata(projectRoot, projectId);
    const comments = metadata.reviewComments ?? [];
    const index = comments.findIndex((comment) => comment.id === commentId);
    if (index < 0) throw new Error(`No project review comment ${commentId}.`);
    const now = new Date().toISOString();
    const updatedComment: ProjectReviewComment = {
      ...comments[index]!,
      status,
      resolutionNote,
      updatedAt: now,
      resolvedAt: status === "open" ? undefined : now
    };
    const nextComments = [...comments.slice(0, index), updatedComment, ...comments.slice(index + 1)];
    const updated = addHistory({ ...metadata, reviewComments: nextComments }, {
      toolName: "resolve_project_review_comment",
      ok: true,
      summary: `Marked project review comment ${commentId} ${status}.`,
      details: { commentId, status, resolutionNote }
    });
    await writeProjectMetadata(projectRoot, updated);
    return updatedComment;
  });
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
    shareAccess: "private",
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
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
    const metadata = await getProject(projectRoot, projectId);
    if (metadata.status === "deleted") throw new Error("Cannot clear files from a deleted project.");
    const filesRoot = getProjectFilesDirectory(projectRoot, projectId);
    await rm(filesRoot, { recursive: true, force: true });
    await mkdir(filesRoot, { recursive: true });
  });
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
    workspaceBinding: metadata.workspaceBinding,
    lastValidation: metadata.lastValidation,
    taskHistory: metadata.taskHistory ?? [],
    taskList: metadata.taskList ?? []
  };
}

export async function bindProjectWorkspace(
  projectRoot: string,
  projectId: string,
  binding: Omit<ProjectWorkspaceBinding, "boundAt">
): Promise<ProjectMetadata> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
    const metadata = await getProject(projectRoot, projectId);
    if (metadata.status === "deleted") throw new Error("Cannot bind a workspace to a deleted project.");
    const workspaceBinding: ProjectWorkspaceBinding = {
      path: binding.path,
      gitRoot: binding.gitRoot,
      boundAt: new Date().toISOString()
    };
    const updated = addHistory({ ...metadata, workspaceBinding }, {
      toolName: "bind_project_workspace",
      ok: true,
      summary: `Bound project ${projectId} to workspace ${workspaceBinding.path}.`,
      details: workspaceBinding
    });
    await writeProjectMetadata(projectRoot, updated);
    return updated;
  });
}

export async function getProjectActivity(projectRoot: string, projectId: string, limit = 50): Promise<ProjectActivity> {
  const metadata = await getProject(projectRoot, projectId);
  return {
    projectId,
    status: metadata.status,
    publishedUrl: metadata.publishedUrl,
    createdByClientId: metadata.createdByClientId,
    lastValidation: metadata.lastValidation,
    taskHistory: (metadata.taskHistory ?? []).slice(-limit),
    taskList: metadata.taskList ?? []
  };
}

function nextProjectTaskId(tasks: ProjectTaskItem[]): string {
  const next = tasks.reduce((max, task) => {
    const match = /^task_(\d+)$/.exec(task.id);
    return match ? Math.max(max, Number.parseInt(match[1], 10)) : max;
  }, 0) + 1;
  return `task_${String(next).padStart(3, "0")}`;
}

export async function listProjectTasks(projectRoot: string, projectId: string, filter: { status?: ProjectTaskStatus; priority?: ProjectTaskPriority } = {}): Promise<ProjectTaskItem[]> {
  const metadata = await getProject(projectRoot, projectId);
  let tasks = metadata.taskList ?? [];
  if (filter.status) tasks = tasks.filter((task) => task.status === filter.status);
  if (filter.priority) tasks = tasks.filter((task) => task.priority === filter.priority);
  return tasks.slice().sort((left, right) => {
    const statusRank: Record<ProjectTaskStatus, number> = { doing: 0, blocked: 1, todo: 2, done: 3 };
    const priorityRank: Record<ProjectTaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
    return statusRank[left.status] - statusRank[right.status]
      || priorityRank[left.priority] - priorityRank[right.priority]
      || right.updatedAt.localeCompare(left.updatedAt);
  });
}

export async function getProjectTask(projectRoot: string, projectId: string, taskId: string): Promise<ProjectTaskItem> {
  const metadata = await getProject(projectRoot, projectId);
  const task = (metadata.taskList ?? []).find((item) => item.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  return task;
}

export async function searchProjectTasks(
  projectRoot: string,
  projectId: string,
  query: string,
  filter: { status?: ProjectTaskStatus; priority?: ProjectTaskPriority; maxResults?: number } = {}
): Promise<ProjectTaskItem[]> {
  const tokens = query.toLowerCase().split(/\s+/).map((token) => token.trim()).filter(Boolean);
  const tasks = await listProjectTasks(projectRoot, projectId, { status: filter.status, priority: filter.priority });
  const maxResults = filter.maxResults ?? 50;
  const matches = !query.trim()
    ? tasks
    : tasks.filter((task) => {
      const haystack = [
        task.id,
        task.title,
        task.status,
        task.priority,
        task.notes,
        ...task.dependsOn,
        ...task.evidence.flatMap((item) => [item.label, item.kind, item.url, item.artifact, item.filePath, item.note].filter(Boolean))
      ].join("\n").toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  return matches.slice(0, maxResults);
}

function findTaskCycles(tasks: ProjectTaskItem[]): string[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (taskId: string) => {
    if (visiting.has(taskId)) {
      const start = stack.indexOf(taskId);
      if (start >= 0) cycles.push([...stack.slice(start), taskId]);
      return;
    }
    if (visited.has(taskId)) return;
    const task = byId.get(taskId);
    if (!task) return;
    visiting.add(taskId);
    stack.push(taskId);
    for (const dependency of task.dependsOn ?? []) visit(dependency);
    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
  return cycles;
}

function assertValidTaskDependencies(tasks: ProjectTaskItem[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself.`);
      if (!ids.has(dependency)) throw new Error(`Task ${task.id} depends on unknown task ${dependency}.`);
    }
  }
  const cycles = findTaskCycles(tasks);
  if (cycles.length > 0) throw new Error(`Task dependency cycle detected: ${cycles[0].join(" -> ")}.`);
}

export async function getProjectTaskGraph(projectRoot: string, projectId: string): Promise<ProjectTaskGraph> {
  const metadata = await getProject(projectRoot, projectId);
  const tasks = metadata.taskList ?? [];
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), task.id]);
    }
  }
  const nodes: ProjectTaskGraphNode[] = tasks.map((task) => {
    const blockedBy = (task.dependsOn ?? []).filter((dependency) => tasks.find((candidate) => candidate.id === dependency)?.status !== "done");
    const blockedReasons = [
      ...(task.status === "blocked" ? [{
        type: "explicit" as const,
        reason: task.blockedReason ?? "Task was manually marked blocked.",
        unblockRequirement: task.unblockRequirement ?? "Record what is needed to unblock this task."
      }] : []),
      ...blockedBy.map((dependency) => {
        const blockingTask = tasks.find((candidate) => candidate.id === dependency);
        return {
          type: "dependency" as const,
          reason: `Waiting for dependency ${dependency}${blockingTask ? `: ${blockingTask.title}` : ""}.`,
          unblockRequirement: `Complete ${dependency}${blockingTask ? `: ${blockingTask.title}` : ""}.`,
          blockingTaskId: dependency
        };
      })
    ];
    return {
      ...task,
      blockedBy,
      blocked: blockedBy.length > 0 || task.status === "blocked",
      dependents: dependents.get(task.id) ?? [],
      blockedReasons
    };
  });
  const edges = tasks.flatMap((task) => (task.dependsOn ?? []).map((dependency) => ({ from: dependency, to: task.id })));
  const readyTasks = nodes.filter((task) => !task.blocked && task.status !== "done");
  const blockedTasks = nodes.filter((task) => task.blocked && task.status !== "done");
  return { projectId, nodes, edges, readyTasks, blockedTasks, cycles: findTaskCycles(tasks) };
}

export async function upsertProjectTask(
  projectRoot: string,
  projectId: string,
  input: {
    taskId?: string;
    title: string;
    status?: ProjectTaskStatus;
    priority?: ProjectTaskPriority;
    notes?: string;
    progress?: number;
    dependsOn?: string[];
    evidence?: ProjectTaskEvidenceLink[];
    blockedReason?: string;
    unblockRequirement?: string;
    completionSummary?: string;
    completedFiles?: string[];
    completionValidation?: ProjectTaskItem["completionValidation"];
  }
): Promise<ProjectTaskItem> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
    const metadata = await getProject(projectRoot, projectId);
    if (metadata.status === "deleted") throw new Error("Cannot update tasks for a deleted project.");
    const now = new Date().toISOString();
    const tasks = metadata.taskList ?? [];
    const index = input.taskId ? tasks.findIndex((task) => task.id === input.taskId) : -1;
    const previous = index >= 0 ? tasks[index] : undefined;
    const status = input.status ?? previous?.status ?? "todo";
    const blockedReason = input.blockedReason !== undefined ? input.blockedReason.trim() || undefined : previous?.blockedReason;
    const unblockRequirement = input.unblockRequirement !== undefined ? input.unblockRequirement.trim() || undefined : previous?.unblockRequirement;
    const completionSummary = input.completionSummary !== undefined ? input.completionSummary.trim() || undefined : previous?.completionSummary;
    const completedFiles = input.completedFiles !== undefined ? [...new Set(input.completedFiles.map((file) => file.trim()).filter(Boolean))] : previous?.completedFiles;
    const nextTask: ProjectTaskItem = {
      id: previous?.id ?? nextProjectTaskId(tasks),
      title: input.title.trim(),
      status,
      priority: input.priority ?? previous?.priority ?? "medium",
      notes: input.notes?.trim() ?? previous?.notes ?? "",
      progress: input.progress ?? previous?.progress ?? 0,
      dependsOn: input.dependsOn ?? previous?.dependsOn ?? [],
      evidence: input.evidence ?? previous?.evidence ?? [],
      blockedReason: status === "blocked" ? blockedReason : undefined,
      unblockRequirement: status === "blocked" ? unblockRequirement : undefined,
      blockedAt: status === "blocked" ? previous?.blockedAt ?? now : undefined,
      completionSummary: status === "done" ? completionSummary : undefined,
      completedFiles: status === "done" ? completedFiles : undefined,
      completionValidation: status === "done" ? input.completionValidation ?? previous?.completionValidation : undefined,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      completedAt: input.status === "done" ? previous?.completedAt ?? now : previous?.completedAt
    };
    const nextTasks = index >= 0 ? [...tasks.slice(0, index), nextTask, ...tasks.slice(index + 1)] : [...tasks, nextTask];
    assertValidTaskDependencies(nextTasks);
    const updated = addHistory({ ...metadata, taskList: nextTasks }, {
      toolName: "upsert_project_task",
      ok: nextTask.status !== "blocked",
      summary: `${previous ? "Updated" : "Created"} task ${nextTask.id}: ${nextTask.title}`,
      details: { taskId: nextTask.id, status: nextTask.status, priority: nextTask.priority, progress: nextTask.progress }
    });
    await writeProjectMetadata(projectRoot, updated);
    return nextTask;
  });
}

export async function recordProjectTaskEvidence(
  projectRoot: string,
  projectId: string,
  taskId: string,
  evidence: ProjectTaskEvidenceLink[]
): Promise<ProjectTaskItem> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
    const metadata = await getProject(projectRoot, projectId);
    if (metadata.status === "deleted") throw new Error("Cannot update tasks for a deleted project.");
    const tasks = metadata.taskList ?? [];
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) throw new Error(`Task ${taskId} not found.`);
    const now = new Date().toISOString();
    const normalized = evidence.map((item) => ({
      ...item,
      label: item.label.trim(),
      note: item.note?.trim(),
      recordedAt: item.recordedAt ?? now
    }));
    const task = tasks[index];
    const nextTask: ProjectTaskItem = {
      ...task,
      evidence: [...task.evidence, ...normalized],
      updatedAt: now
    };
    const nextTasks = [...tasks.slice(0, index), nextTask, ...tasks.slice(index + 1)];
    const updated = addHistory({ ...metadata, taskList: nextTasks }, {
      toolName: "record_project_task_evidence",
      ok: true,
      summary: `Recorded ${normalized.length} evidence link(s) for task ${taskId}: ${task.title}`,
      details: {
        taskId,
        evidence: normalized.map((item) => ({
          label: item.label,
          kind: item.kind,
          url: item.url,
          artifact: item.artifact,
          filePath: item.filePath
        }))
      }
    });
    await writeProjectMetadata(projectRoot, updated);
    return nextTask;
  });
}

export async function deleteProjectTask(projectRoot: string, projectId: string, taskId: string): Promise<ProjectTaskItem> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
    const metadata = await getProject(projectRoot, projectId);
    if (metadata.status === "deleted") throw new Error("Cannot update tasks for a deleted project.");
    const tasks = metadata.taskList ?? [];
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) throw new Error(`Task ${taskId} not found.`);
    const dependents = tasks.filter((task) => task.dependsOn.includes(taskId)).map((task) => task.id);
    if (dependents.length > 0) throw new Error(`Cannot delete task ${taskId}; dependent task(s) still reference it: ${dependents.join(", ")}.`);
    const deletedTask = tasks[index];
    const nextTasks = [...tasks.slice(0, index), ...tasks.slice(index + 1)];
    const updated = addHistory({ ...metadata, taskList: nextTasks }, {
      toolName: "delete_project_task",
      ok: true,
      summary: `Deleted task ${taskId}: ${deletedTask.title}`,
      details: { taskId, title: deletedTask.title }
    });
    await writeProjectMetadata(projectRoot, updated);
    return deletedTask;
  });
}

export async function writeProjectFile(projectRoot: string, projectId: string, relativePath: string, content: string): Promise<ProjectFileInfo> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
  if (Buffer.byteLength(content, "utf8") > maxProjectFileBytes) {
    throw new Error("Project file content exceeds 1 MiB.");
  }

  const metadata = await getProject(projectRoot, projectId);
  if (metadata.status === "deleted") throw new Error("Cannot write to a deleted project.");

  const absolutePath = resolveProjectFilePath(projectRoot, projectId, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await atomicWrite(absolutePath, content);

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
  });
}

export async function patchProjectFile(
  projectRoot: string,
  projectId: string,
  relativePath: string,
  operations: Array<{ find: string; replace: string; all?: boolean }>
): Promise<ProjectFileInfo> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
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

  await atomicWrite(absolutePath, content);
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
  });
}

export async function writeProjectAsset(projectRoot: string, projectId: string, relativePath: string, content: Buffer, contentType?: string): Promise<ProjectFileInfo> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
  const safeRelativePath = assertSafeProjectAssetPath(relativePath);
  validateProjectAssetBytes(safeRelativePath, content, contentType);

  const metadata = await getProject(projectRoot, projectId);
  if (metadata.status === "deleted") throw new Error("Cannot write to a deleted project.");

  const absolutePath = resolveProjectAssetPath(projectRoot, projectId, safeRelativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await atomicWrite(absolutePath, content);

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
  });
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
  const maxBytes = maxProjectAssetBytesForExtension(path.extname(relativePath).toLowerCase());
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
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
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
    const maxBytes = maxProjectAssetBytesForExtension(extension);
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
  });
}

export async function publishProject(projectRoot: string, projectId: string, publicBaseUrl: string, entryFile?: string, options: PublishProjectOptions = {}): Promise<ProjectMetadata> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
    const metadata = await getProject(projectRoot, projectId);
    if (metadata.status === "deleted") throw new Error("Cannot publish a deleted project.");

    const safeEntryFile = assertSafeProjectFilePath(entryFile ?? metadata.entryFile);
    await stat(resolveProjectFilePath(projectRoot, projectId, safeEntryFile));
    const publishedUrl = makeProjectPublicUrl(publicBaseUrl, options.shareBasePath, projectId, safeEntryFile);
    const updated = addHistory({
      ...metadata,
      status: "published" as ProjectStatus,
      shareAccess: options.shareAccess ?? metadata.shareAccess ?? "private",
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
  });
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
    // Delegates to publishProject, which acquires the lock itself — do not wrap here
    // (the lock is not reentrant; nesting would deadlock).
    return publishProject(projectRoot, projectId, publicBaseUrl, undefined, options);
  }

  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
    const metadata = await getProject(projectRoot, projectId);
    if (metadata.status === "deleted") throw new Error("Cannot update a deleted project.");
    const updated = addHistory({
      ...metadata,
      status,
      shareAccess: status === "private" ? "private" : metadata.shareAccess ?? "private",
      publishedUrl: undefined
    }, {
      toolName: "set_project_status",
      ok: true,
      summary: `Set ${projectId} status to ${status}.`,
      details: { status }
    });
    await writeProjectMetadata(projectRoot, updated);
    return updated;
  });
}

export async function setProjectShareAccess(
  projectRoot: string,
  projectId: string,
  shareAccess: ProjectShareAccess
): Promise<ProjectMetadata> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
    const metadata = await getProject(projectRoot, projectId);
    if (metadata.status === "deleted") throw new Error("Cannot update a deleted project.");
    const updated = addHistory({
      ...metadata,
      shareAccess
    }, {
      toolName: "set_project_share_access",
      ok: true,
      summary: `Set ${projectId} share access to ${shareAccess}.`,
      details: { shareAccess }
    });
    await writeProjectMetadata(projectRoot, updated);
    return updated;
  });
}

export async function unpublishProject(projectRoot: string, projectId: string, reason: string): Promise<ProjectMetadata> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
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
  });
}

export async function recordProjectBrowserInspection(
  projectRoot: string,
  projectId: string,
  browserInspection: ProjectBrowserInspectionSummary,
  toolName = "browser_validate_project"
): Promise<ProjectMetadata> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
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
  });
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
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
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
  });
}

export async function deleteProject(projectRoot: string, projectId: string): Promise<ProjectMetadata> {
  return withKeyedLock(projectLockKey(projectRoot, projectId), async () => {
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
  });
}
