import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { createArtifact, makeArtifactUrl } from "../../artifacts/store.js";
import {
  appendProjectTaskHistory,
  bindProjectWorkspace,
  clearProjectFiles,
  getProject,
  getProjectStoredFilePath,
  getProjectWorkspaceDirectory,
  listProjectFiles,
  validateProject,
  publishProject,
  writeProjectAsset,
  writeProjectFile
} from "../../projects/store.js";
import { buildProjectPublishOptions } from "../../projects/publish-policy.js";
import type { ToolContext, ToolModule, ToolResult } from "../types.js";
import { childEnv, gitChildEnv } from "../child-env.js";
import { webInspectTools } from "./web-inspect.js";

const execFileAsync = promisify(execFile);
const maxLogBytes = 60000;
const maxFileListResults = 2000;
const defaultTimeoutMs = 300000;
const ignoredDirectoryNames = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage"]);
const textPublishExtensions = new Set([".html", ".css", ".js", ".mjs", ".json", ".webmanifest", ".txt", ".md", ".svg"]);
const assetPublishExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".glb", ".gltf", ".hdr", ".exr", ".ktx2", ".mp3", ".wav", ".ogg", ".mp4", ".webm", ".mov"]);
const workspaceAssetExtensions = new Set([...assetPublishExtensions]);
const maxWorkspaceAssetBytes = 100 * 1024 * 1024;

type NpmProjectCommand = "npm install" | "npm run build" | "npm test" | "npm run lint" | "npm run typecheck";

const bindProjectWorkspaceSchema = z.object({
  projectId: z.string().min(8).max(80),
  workspacePath: z.string().min(1).max(2000),
  requireGit: z.boolean().default(true)
});

const initProjectGitSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240).default("workspace"),
  importProjectFiles: z.boolean().default(true)
});

const projectPathSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().max(500).default(""),
  recursive: z.boolean().default(true),
  maxDepth: z.number().int().min(1).max(12).default(4),
  includeHidden: z.boolean().default(false),
  includeIgnored: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(maxFileListResults).default(500)
});

const searchInProjectSchema = z.object({
  projectId: z.string().min(8).max(80),
  query: z.string().min(1).max(1000),
  relativePath: z.string().max(500).default(""),
  useRegex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  includeHidden: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(500).default(100)
});

const applyPatchSchema = z.object({
  projectId: z.string().min(8).max(80),
  patch: z.string().min(1).max(1024 * 1024),
  checkOnly: z.boolean().default(false)
});

const shellCommandSchema = z.object({
  projectId: z.string().min(8).max(80),
  command: z.string().min(1).max(4000),
  cwd: z.string().max(500).optional(),
  timeoutMs: z.number().int().min(1000).max(900000).default(defaultTimeoutMs),
  maxOutputBytes: z.number().int().min(1000).max(200000).default(maxLogBytes),
  allowRiskyCommand: z.boolean().default(false)
});

const npmCommandSchema = z.object({
  projectId: z.string().min(8).max(80),
  command: z.enum(["npm install", "npm run build", "npm test", "npm run lint", "npm run typecheck"]),
  timeoutMs: z.number().int().min(1000).max(900000).default(defaultTimeoutMs)
});

const inspectProjectWorkspaceSchema = z.object({
  projectId: z.string().min(8).max(80),
  script: z.enum(["dev", "start"]).default("dev"),
  port: z.number().int().min(1024).max(65535).default(3000),
  host: z.string().min(1).max(128).default("127.0.0.1"),
  path: z.string().min(1).max(240).default("/"),
  viewports: z.array(z.enum(["desktop", "tablet", "mobile"])).min(1).max(3).default(["desktop", "tablet", "mobile"]),
  includeAccessibility: z.boolean().default(true),
  includeLighthouse: z.boolean().default(false),
  closeAfterCheck: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000)
});

const publishProjectWorkspaceSchema = z.object({
  projectId: z.string().min(8).max(80),
  outputDir: z.string().min(1).max(240).default("dist"),
  entryFile: z.string().min(1).max(240).default("index.html")
});

const writeProjectWorkspaceAssetSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(500),
  contentBase64: z.string().min(1).max(Math.ceil(maxWorkspaceAssetBytes * 4 / 3) + 8)
});

const importProjectWorkspaceAssetSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(500),
  sourcePath: z.string().min(1).max(2000)
});

const recordProjectWorkspaceVideoSchema = z.object({
  projectId: z.string().min(8).max(80),
  script: z.enum(["dev", "start"]).default("dev"),
  port: z.number().int().min(1024).max(65535).default(3000),
  host: z.string().min(1).max(128).default("127.0.0.1"),
  path: z.string().min(1).max(240).default("/"),
  viewport: z.enum(["desktop", "tablet", "mobile", "fullscreen"]).default("desktop"),
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(240).max(2160).optional(),
  durationMs: z.number().int().min(1000).max(120000).default(8000),
  waitAfterLoadMs: z.number().int().min(0).max(30000).default(1000),
  format: z.enum(["webm", "mp4"]).default("webm"),
  closeAfterRecord: z.boolean().default(true)
});

const recordProjectTaskSchema = z.object({
  projectId: z.string().min(8).max(80),
  status: z.enum(["queued", "in_progress", "completed", "blocked"]),
  summary: z.string().min(1).max(1000),
  details: z.record(z.unknown()).optional()
});

function trimOutput(value: string, maxBytes = maxLogBytes): string {
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
  return `${Buffer.from(normalized).subarray(0, maxBytes).toString("utf8")}... [truncated]`;
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function assertSafeRelativePath(relativePath: string): string {
  if (!relativePath) return "";
  if (path.isAbsolute(relativePath)) throw new Error("Absolute relativePath/cwd values are not allowed.");
  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) throw new Error("Parent traversal is not allowed.");
  return parts.join("/");
}

function assertSafeWorkspaceAssetPath(relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error("Absolute or empty asset paths are not allowed.");
  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("Asset path must include a filename.");
  if (parts.some((part) => part === ".." || part.startsWith("."))) {
    throw new Error("Parent traversal and hidden path segments are not allowed.");
  }
  const extension = path.extname(parts.at(-1) ?? "").toLowerCase();
  if (!workspaceAssetExtensions.has(extension)) throw new Error(`Unsupported workspace asset extension: ${extension || "(none)"}.`);
  return parts.join("/");
}

function contentTypeForWorkspaceAsset(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();
  const map = new Map([
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
    [".mp4", "video/mp4"],
    [".webm", "video/webm"],
    [".mov", "video/quicktime"]
  ]);
  return map.get(extension) ?? "application/octet-stream";
}

function decodePureBase64(value: string): Buffer {
  if (/^data:/i.test(value.trim())) throw new Error("contentBase64 must be raw base64 without a data: URL prefix.");
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error("contentBase64 is not valid base64.");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) throw new Error("contentBase64 decoded to an empty asset.");
  if (buffer.length > maxWorkspaceAssetBytes) throw new Error("Workspace asset exceeds 100 MiB.");
  return buffer;
}

async function safeResolveInside(root: string, relativePath = ""): Promise<string> {
  const safe = assertSafeRelativePath(relativePath);
  const resolvedRoot = await realpath(root);
  const candidate = path.resolve(resolvedRoot, safe);
  if (candidate === resolvedRoot) return resolvedRoot;
  // For a write to a not-yet-existing leaf, realpath(candidate) fails and a purely lexical
  // check would miss an intermediate-dir SYMLINK that redirects the write outside the
  // workspace. Resolve symlinks on the deepest path component that exists, assert it is inside
  // root, then re-append the not-yet-existing suffix (already ".."-free via assertSafeRelativePath).
  let existing = candidate;
  const missing: string[] = [];
  while (existing !== resolvedRoot) {
    try {
      await stat(existing);
      break;
    } catch {
      missing.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
  const resolvedExisting = await realpath(existing);
  const resolved = missing.length ? path.join(resolvedExisting, ...missing) : resolvedExisting;
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Resolved path is outside the bound project workspace.");
  }
  return resolved;
}

async function assertInsideRoot(root: string, target: string, label: string): Promise<{ root: string; target: string; relativePath: string }> {
  const resolvedRoot = await realpath(root);
  const resolvedTarget = await realpath(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} must be inside the configured workspace root.`);
  }
  return {
    root: resolvedRoot,
    target: resolvedTarget,
    relativePath: path.relative(resolvedRoot, resolvedTarget).replaceAll("\\", "/")
  };
}

function assertNoHiddenPathSegments(relativePath: string, label: string): void {
  const parts = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.some((part) => part.startsWith("."))) {
    throw new Error(`${label} must not include hidden path segments.`);
  }
}

async function findGitRoot(workspacePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspacePath,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      env: gitChildEnv()
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function resolveProjectWorkspace(ctx: ToolContext, projectId: string): Promise<string> {
  const project = await getProject(ctx.projectRoot, projectId);
  if (project.status === "deleted") throw new Error("Cannot access a deleted project.");
  if (project.workspaceBinding?.path) {
    const workspace = await assertInsideRoot(ctx.workspaceRoot, project.workspaceBinding.path, "workspaceBinding.path");
    return workspace.target;
  }
  const workspace = getProjectWorkspaceDirectory(ctx.projectRoot, projectId);
  return realpath(workspace).catch(() => workspace);
}

async function resolveProjectGitWorkspace(ctx: ToolContext, projectId: string): Promise<string> {
  const project = await getProject(ctx.projectRoot, projectId);
  if (project.status === "deleted") throw new Error("Cannot access a deleted project.");
  const workspace = project.workspaceBinding?.gitRoot ?? project.workspaceBinding?.path;
  const resolved = workspace
    ? (await assertInsideRoot(ctx.workspaceRoot, workspace, workspace === project.workspaceBinding?.gitRoot ? "workspaceBinding.gitRoot" : "workspaceBinding.path")).target
    : await realpath(getProjectWorkspaceDirectory(ctx.projectRoot, projectId)).catch(() => getProjectWorkspaceDirectory(ctx.projectRoot, projectId));
  const gitRoot = await findGitRoot(resolved);
  if (!gitRoot) {
    throw new Error(`Project ${projectId} is not bound to a Git repository. Call bind_project_workspace with a real repo path first.`);
  }
  if (workspace) return (await assertInsideRoot(ctx.workspaceRoot, gitRoot, "workspaceBinding.gitRoot")).target;
  return gitRoot;
}

async function listFiles(root: string, start: string, input: z.infer<typeof projectPathSchema>): Promise<Array<{ path: string; type: "file" | "directory"; size?: number; modifiedAt?: string }>> {
  const resolvedRoot = await realpath(root);
  const out: Array<{ path: string; type: "file" | "directory"; size?: number; modifiedAt?: string }> = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (out.length >= input.maxResults) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= input.maxResults) return;
      if (!input.includeHidden && entry.name.startsWith(".")) continue;
      if (!input.includeIgnored && entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) continue;
      const absolutePath = path.join(current, entry.name);
      const relative = path.relative(resolvedRoot, absolutePath).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        out.push({ path: relative, type: "directory" });
        if (input.recursive && depth < input.maxDepth) await walk(absolutePath, depth + 1);
      } else if (entry.isFile()) {
        const fileStat = await stat(absolutePath);
        out.push({ path: relative, type: "file", size: fileStat.size, modifiedAt: fileStat.mtime.toISOString() });
      }
    }
  }

  await walk(start, 1);
  return out;
}

// In-process fallback for search_in_project when ripgrep is unavailable. Deliberately reuses
// listFiles() above rather than the workspace-root searcher in legacy-tools.ts: that one
// resolves paths against a *different* root model (ctx.workspaceRoot, not the project's bound
// workspace), and routing project searches through it would blur a security boundary for no
// gain. Same root, same traversal rules, same ignore list — only the matching is new.
async function searchWithoutRipgrep(
  parsed: z.infer<typeof searchInProjectSchema>,
  workspace: string,
  start: string
): Promise<ToolResult> {
  let matcher: (line: string) => boolean;
  if (parsed.useRegex) {
    let regex: RegExp;
    try {
      regex = new RegExp(parsed.query, parsed.caseSensitive ? "" : "i");
    } catch (error) {
      const message = `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`;
      return { ok: false, summary: message, jobId: parsed.projectId, artifacts: [], logs: [], errors: [message] };
    }
    matcher = (line: string) => regex.test(line);
  } else {
    const needle = parsed.caseSensitive ? parsed.query : parsed.query.toLowerCase();
    matcher = (line: string) => (parsed.caseSensitive ? line : line.toLowerCase()).includes(needle);
  }

  const files = await listFiles(workspace, start, {
    projectId: parsed.projectId,
    relativePath: parsed.relativePath,
    recursive: true,
    maxDepth: 12,
    includeHidden: parsed.includeHidden,
    includeIgnored: false,
    // Walk a wide net of files to find up to maxResults matching LINES; the cap below is on
    // matches, not on files scanned.
    maxResults: 5000
  } as z.infer<typeof projectPathSchema>);

  const matches: Array<{ path: string; line: number; text: string }> = [];
  let scanned = 0;
  let skipped = 0;
  for (const file of files) {
    if (matches.length >= parsed.maxResults) break;
    if (file.type !== "file") continue;
    // Skip anything large or binary rather than pulling it into memory. rg does this natively;
    // without the guard a single vendored bundle could blow up the request.
    if ((file.size ?? 0) > 2 * 1024 * 1024) { skipped += 1; continue; }
    let content: string;
    try {
      content = await readFile(path.join(workspace, file.path), "utf8");
    } catch {
      skipped += 1;
      continue;
    }
    if (content.includes("\0")) { skipped += 1; continue; } // NUL byte => treat as binary
    scanned += 1;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= parsed.maxResults) break;
      if (matcher(lines[index])) {
        matches.push({ path: file.path, line: index + 1, text: lines[index].slice(0, 400) });
      }
    }
  }

  const summary = matches.length
    ? `Search completed with ${matches.length} match(es) (ripgrep unavailable, used in-process scan).`
    : "Search completed with no matches (ripgrep unavailable, used in-process scan).";
  return {
    ok: true,
    summary,
    jobId: parsed.projectId,
    artifacts: [],
    structuredContent: { engine: "in-process", matches, filesScanned: scanned, filesSkipped: skipped, truncated: matches.length >= parsed.maxResults },
    logs: [JSON.stringify({ engine: "in-process", matches, filesScanned: scanned, filesSkipped: skipped }, null, 2)],
    errors: []
  };
}

function rejectRiskyShell(command: string): void {
  const riskyPatterns = [
    /\brm\s+-[^\n;|&]*r[^\n;|&]*\s+(?:\/|\$HOME|~|\.)/,
    /\bsudo\b/,
    /\bmkfs\b/,
    /\bdd\s+.*\bof=/,
    /:\(\)\s*\{\s*:\|:\s*&\s*\}/,
    />\s*\/dev\/(?:sda|disk)/
  ];
  if (riskyPatterns.some((pattern) => pattern.test(command))) {
    throw new Error("Command looks destructive or privileged. Set allowRiskyCommand=true only after explicit operator approval.");
  }
}

async function runShell(command: string, cwd: string, timeoutMs: number, maxOutputBytes: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: trimOutput(stdout, maxOutputBytes), stderr: trimOutput(stderr, maxOutputBytes) });
    });
  });
}

async function runProcessWithInput(file: string, args: string[], cwd: string, input: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: file === "git" ? gitChildEnv() : childEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${file} ${args.join(" ")} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = { code, stdout: trimOutput(stdout), stderr: trimOutput(stderr) };
      if (code === 0) resolve(result);
      else reject(new Error(`${file} ${args.join(" ")} failed with code ${code}: ${result.stderr || result.stdout}`));
    });
    child.stdin.end(input);
  });
}

async function runNpmCommand(workspace: string, command: NpmProjectCommand, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const args = command === "npm install"
    ? ["install"]
    : command === "npm test"
      ? ["test"]
      : ["run", command.replace("npm run ", "")];
  return execFileAsync(npmExecutable(), args, { cwd: workspace, timeout: timeoutMs, maxBuffer: 1024 * 1024, env: childEnv() });
}

function outputFromExecutionError(error: unknown): { stdout: string; stderr: string; code?: string | number | null; message: string } {
  const err = error as { stdout?: unknown; stderr?: unknown; code?: unknown; signal?: unknown; message?: unknown };
  return {
    stdout: typeof err.stdout === "string" ? trimOutput(err.stdout) : "",
    stderr: typeof err.stderr === "string" ? trimOutput(err.stderr) : "",
    code: typeof err.code === "string" || typeof err.code === "number" || err.code === null ? err.code : undefined,
    message: typeof err.message === "string" ? trimOutput(err.message, 4000) : "Command failed."
  };
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.ok) return;
    } catch {
      // keep polling until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Local server did not become healthy within ${timeoutMs}ms.`);
}

function startWorkspaceServer(workspace: string, input: { script: "dev" | "start"; host: string; port: number; path: string }): { process: ReturnType<typeof spawn>; url: string; logs: string[] } {
  const args = ["run", input.script];
  if (input.script === "dev") args.push("--", "--host", input.host, "--port", String(input.port));
  const proc = spawn(npmExecutable(), args, {
    cwd: workspace,
    env: childEnv({ PORT: String(input.port), HOST: input.host }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [`Started npm run ${input.script} on ${input.host}:${input.port}`];
  proc.stdout?.on("data", (chunk) => logs.push(`[stdout] ${chunk.toString("utf8").trim()}`));
  proc.stderr?.on("data", (chunk) => logs.push(`[stderr] ${chunk.toString("utf8").trim()}`));
  const normalizedPath = input.path.startsWith("/") ? input.path : `/${input.path}`;
  return { process: proc, url: `http://${input.host}:${input.port}${normalizedPath}`, logs };
}

function viewportSize(viewport: z.infer<typeof recordProjectWorkspaceVideoSchema>["viewport"], width?: number, height?: number): { width: number; height: number; isMobile: boolean } {
  if (width && height) return { width, height, isMobile: viewport === "mobile" || viewport === "tablet" };
  if (viewport === "mobile") return { width: 390, height: 844, isMobile: true };
  if (viewport === "tablet") return { width: 834, height: 1112, isMobile: true };
  if (viewport === "fullscreen") return { width: 1920, height: 1080, isMobile: false };
  return { width: 1440, height: 900, isMobile: false };
}

async function maybeConvertWebmToMp4(webmPath: string, mp4Path: string, timeoutMs: number): Promise<void> {
  await execFileAsync(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-i", webmPath, "-movflags", "faststart", mp4Path], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: childEnv()
  });
}

async function copyPublishedDist(ctx: ToolContext, projectId: string, distRoot: string, entryFile: string): Promise<ToolResult> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolutePath);
      else if (entry.isFile()) files.push(path.relative(distRoot, absolutePath).replaceAll("\\", "/"));
    }
  }
  await walk(distRoot);
  if (!files.includes(entryFile)) throw new Error(`Entry file not found in outputDir: ${entryFile}`);

  await clearProjectFiles(ctx.projectRoot, projectId);
  const written = [];
  for (const file of files.sort()) {
    const extension = path.extname(file).toLowerCase();
    const absolutePath = path.join(distRoot, file);
    if (textPublishExtensions.has(extension)) written.push(await writeProjectFile(ctx.projectRoot, projectId, file, await readFile(absolutePath, "utf8")));
    else if (assetPublishExtensions.has(extension)) written.push(await writeProjectAsset(ctx.projectRoot, projectId, file, await readFile(absolutePath)));
    else throw new Error(`Unsupported dist file extension: ${file}`);
  }
  const validation = await validateProject(ctx.projectRoot, projectId, entryFile);
  if (!validation.ok) throw new Error(`Published dist validation failed: ${validation.errors.join("; ")}`);
  const publishPolicy = buildProjectPublishOptions(ctx);
  const published = await publishProject(ctx.projectRoot, projectId, publishPolicy.publicBaseUrl, entryFile, publishPolicy.options);
  const report = { projectId, publishedUrl: published.publishedUrl, entryFile, files: written, validation };
  await appendProjectTaskHistory(ctx.projectRoot, projectId, {
    toolName: "publish_project_workspace",
    ok: true,
    summary: `Published workspace build output to ${published.publishedUrl}.`,
    details: report
  });
  return {
    ok: true,
    summary: `Published workspace build output at ${published.publishedUrl}.`,
    jobId: projectId,
    previewUrl: published.publishedUrl,
    shareUrl: published.publishedUrl,
    artifacts: [published.publishedUrl!, ...written.map((file) => file.path)],
    structuredContent: report,
    logs: [JSON.stringify(report, null, 2)],
    errors: []
  };
}

export const projectDevTools: ToolModule[] = [
  {
    definition: {
      name: "init_project_git",
      description: "Create and git-init a real workspace for a project inside the tenant workspace root, seed it with the project's current files, make an initial commit, and bind the project to it. Use this when a project has no bound Git repository yet so that git_status/git_diff/git_commit/run_project_build and other workspace tools can be used. Idempotent: re-running rebinds the existing repo.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, relativePath: { type: "string", description: "Subdirectory under the workspace root to use as the repo (default 'workspace')." }, importProjectFiles: { type: "boolean", description: "Copy the project's stored files into the new repo (default true)." } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: initProjectGitSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof initProjectGitSchema>;
      const relativePath = typeof parsed.relativePath === "string" && parsed.relativePath ? parsed.relativePath : "workspace";
      const importProjectFiles = parsed.importProjectFiles ?? true;
      const project = await getProject(ctx.projectRoot, parsed.projectId);
      if (project.status === "deleted") throw new Error("Cannot initialize git for a deleted project.");
      await mkdir(ctx.workspaceRoot, { recursive: true });
      const safeRelative = assertSafeRelativePath(relativePath);
      if (!safeRelative) throw new Error("relativePath must name a subdirectory.");
      const workspace = await safeResolveInside(ctx.workspaceRoot, safeRelative);
      await mkdir(workspace, { recursive: true });

      const gitEnv = gitChildEnv();
      const gitOpts = { cwd: workspace, env: gitEnv, timeout: 30000, maxBuffer: 1024 * 1024 };
      // findGitRoot walks ancestors, so a workspace that sits INSIDE another repo (e.g. the
      // dev-token global workspace is a host-mounted repo) would otherwise be treated as
      // "already a repo" and our git add/commit would mutate that ancestor. Only skip init when
      // the existing repo root IS this workspace; otherwise git init a fresh nested repo here.
      const existingGitRoot = await findGitRoot(workspace);
      const existingIsSelf = existingGitRoot !== undefined
        && (await realpath(existingGitRoot).catch(() => existingGitRoot)) === workspace;
      const initialized = !existingIsSelf;
      if (initialized) {
        await execFileAsync("git", ["init", "-b", "main"], gitOpts);
        await execFileAsync("git", ["config", "user.email", "agent@coding-mcp.local"], gitOpts);
        await execFileAsync("git", ["config", "user.name", "Coding MCP Agent"], gitOpts);
      }

      let importedFiles = 0;
      if (importProjectFiles) {
        const files = await listProjectFiles(ctx.projectRoot, parsed.projectId);
        for (const file of files) {
          const source = await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, file.path);
          const destination = path.join(workspace, file.path);
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(source, destination);
          importedFiles += 1;
        }
      }

      await execFileAsync("git", ["add", "-A"], gitOpts);
      const { stdout: porcelain } = await execFileAsync("git", ["status", "--porcelain"], gitOpts);
      let committed = false;
      if (porcelain.trim() || initialized) {
        const message = importedFiles > 0 ? `Import ${importedFiles} file(s) from project ${parsed.projectId}` : "Initialize workspace";
        await execFileAsync("git", ["commit", "--allow-empty", "-m", message], gitOpts);
        committed = true;
      }

      const gitRoot = (await findGitRoot(workspace)) ?? workspace;
      const metadata = await bindProjectWorkspace(ctx.projectRoot, parsed.projectId, { path: workspace, gitRoot });
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, {
        toolName: "init_project_git",
        ok: true,
        summary: `Initialized git workspace for ${parsed.projectId}.`,
        details: { workspace, gitRoot, initialized, importedFiles, committed }
      });
      return {
        ok: true,
        summary: `Git workspace ready for ${parsed.projectId} at ${workspace} (${importedFiles} file(s) imported, initial commit: ${committed}). git_status/git_diff/git_commit are now usable.`,
        jobId: parsed.projectId,
        artifacts: [workspace],
        structuredContent: { workspace, gitRoot, initialized, importedFiles, committed, workspaceBinding: metadata.workspaceBinding },
        logs: [`workspace=${workspace}`, `gitRoot=${gitRoot}`, `initialized=${initialized}`, `importedFiles=${importedFiles}`, `committed=${committed}`],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "bind_project_workspace",
      description: "Bind a persistent projectId to a real local workspace path and optional Git repository.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, workspacePath: { type: "string" }, requireGit: { type: "boolean" } }, required: ["projectId", "workspacePath"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: bindProjectWorkspaceSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof bindProjectWorkspaceSchema>;
      const workspacePath = await realpath(parsed.workspacePath);
      await assertInsideRoot(ctx.workspaceRoot, workspacePath, "workspacePath");
      const workspaceStat = await stat(workspacePath);
      if (!workspaceStat.isDirectory()) throw new Error("workspacePath must be a directory.");
      const gitRoot = await findGitRoot(workspacePath);
      if (!gitRoot) throw new Error("workspacePath must be inside a Git work tree.");
      await assertInsideRoot(ctx.workspaceRoot, gitRoot, "gitRoot");
      const metadata = await bindProjectWorkspace(ctx.projectRoot, parsed.projectId, { path: workspacePath, gitRoot });
      return { ok: true, summary: `Bound ${parsed.projectId} to ${workspacePath}.`, jobId: parsed.projectId, artifacts: [workspacePath], structuredContent: { workspaceBinding: metadata.workspaceBinding }, logs: [JSON.stringify(metadata.workspaceBinding, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "list_project_files",
      description: "List files in a project-bound real workspace, excluding heavy generated folders by default.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, relativePath: { type: "string" }, recursive: { type: "boolean" }, maxDepth: { type: "number" }, includeHidden: { type: "boolean" }, includeIgnored: { type: "boolean" }, maxResults: { type: "number" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: projectPathSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof projectPathSchema>;
      const workspace = await resolveProjectWorkspace(ctx, parsed.projectId);
      const start = await safeResolveInside(workspace, parsed.relativePath);
      const files = await listFiles(workspace, start, parsed);
      return { ok: true, summary: `Listed ${files.length} item(s).`, jobId: parsed.projectId, artifacts: files.map((file) => file.path), structuredContent: { workspace, files, truncated: files.length >= parsed.maxResults }, logs: [JSON.stringify({ workspace, files, truncated: files.length >= parsed.maxResults }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "search_in_project",
      description: "Search file contents in a project-bound real workspace. Uses ripgrep when available and falls back to an in-process scan otherwise. node_modules and .git are always excluded. Use list_project_files to find files by name instead of by content.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project whose bound workspace to search." },
          query: { type: "string", description: "Text to find. Treated as a literal string unless useRegex is true." },
          relativePath: { type: "string", description: "Optional subdirectory to limit the search to, relative to the workspace root. Defaults to the whole workspace." },
          useRegex: { type: "boolean", description: "Treat query as a regular expression instead of literal text. Default false." },
          caseSensitive: { type: "boolean", description: "Match case exactly. Default false (case-insensitive)." },
          includeHidden: { type: "boolean", description: "Include dotfiles and dot-directories. Default false." },
          maxResults: { type: "number", description: "Maximum matching lines to return, 1-500. Default 100." }
        },
        required: ["projectId", "query"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: searchInProjectSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof searchInProjectSchema>;
      const workspace = await resolveProjectWorkspace(ctx, parsed.projectId);
      const start = await safeResolveInside(workspace, parsed.relativePath);
      const args = ["--json", "--line-number", "--max-count", String(parsed.maxResults), "--glob", "!node_modules/**", "--glob", "!.git/**"];
      if (!parsed.useRegex) args.push("--fixed-strings");
      if (!parsed.caseSensitive) args.push("--ignore-case");
      if (parsed.includeHidden) args.push("--hidden");
      // `--` terminates flag parsing so a query starting with `-` (e.g. `--pre=<cmd>`)
      // is treated as a search pattern, not a ripgrep flag → blocks arg injection / RCE.
      args.push("--", parsed.query, start);
      try {
        const { stdout, stderr } = await execFileAsync("rg", args, { cwd: workspace, timeout: 120000, maxBuffer: 1024 * 1024, env: childEnv() });
        return { ok: true, summary: "Search completed.", jobId: parsed.projectId, artifacts: [], logs: [trimOutput(stdout), trimOutput(stderr)].filter(Boolean), errors: [] };
      } catch (error) {
        const err = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
        if (err.code === 1 || err.code === "1") return { ok: true, summary: "Search completed with no matches.", jobId: parsed.projectId, artifacts: [], logs: [], errors: [] };
        // `spawn rg ENOENT` means ripgrep is not on PATH. This returned ok:false for 125/125
        // calls in production (see docs/tool-failure-baseline.md) because the container never
        // installed it. ripgrep is now in the Dockerfile, but a missing binary must not be a
        // hard failure again — degrade to an in-process scan so the agent still gets an answer.
        if (err.code === "ENOENT") {
          return await searchWithoutRipgrep(parsed, workspace, start);
        }
        throw error;
      }
    }
  },
  {
    definition: {
      name: "apply_patch",
      description: "Apply a unified diff patch to a project-bound workspace after git apply --check validation.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, patch: { type: "string" }, checkOnly: { type: "boolean" } }, required: ["projectId", "patch"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: applyPatchSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof applyPatchSchema>;
      const workspace = await resolveProjectWorkspace(ctx, parsed.projectId);
      await runProcessWithInput("git", ["apply", "--check", "-"], workspace, parsed.patch, 120000);
      if (!parsed.checkOnly) {
        await runProcessWithInput("git", ["apply", "-"], workspace, parsed.patch, 120000);
      }
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "apply_patch", ok: true, summary: parsed.checkOnly ? "Patch check passed." : "Patch applied.", details: { checkOnly: parsed.checkOnly } });
      return { ok: true, summary: parsed.checkOnly ? "Patch check passed." : "Patch applied.", jobId: parsed.projectId, artifacts: [], logs: [], errors: [] };
    }
  },
  {
    definition: {
      name: "run_shell_command",
      description: "Run a bounded shell command in a project-bound real workspace with a scrubbed environment.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "number" }, maxOutputBytes: { type: "number" }, allowRiskyCommand: { type: "boolean" } }, required: ["projectId", "command"], additionalProperties: false }
    },
    enabledByDefault: false,
    schema: shellCommandSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof shellCommandSchema>;
      if (!parsed.allowRiskyCommand) rejectRiskyShell(parsed.command);
      const workspace = await resolveProjectWorkspace(ctx, parsed.projectId);
      const cwd = await safeResolveInside(workspace, parsed.cwd);
      const result = await runShell(parsed.command, cwd, parsed.timeoutMs, parsed.maxOutputBytes);
      const ok = result.code === 0;
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "run_shell_command", ok, summary: `Command exited with code ${result.code}.`, details: { command: parsed.command, cwd, code: result.code } });
      return { ok, summary: `Command exited with code ${result.code}.`, jobId: parsed.projectId, artifacts: [], logs: [result.stdout, result.stderr].filter(Boolean), errors: ok ? [] : [`exit code ${result.code}`] };
    }
  },
  {
    definition: {
      name: "run_project_npm_command",
      description: "Run npm install/build/test/lint/typecheck in a project-bound real workspace.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, command: { type: "string", enum: ["npm install", "npm run build", "npm test", "npm run lint", "npm run typecheck"] }, timeoutMs: { type: "number" } }, required: ["projectId", "command"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: npmCommandSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof npmCommandSchema>;
      const workspace = await resolveProjectWorkspace(ctx, parsed.projectId);
      try {
        const { stdout, stderr } = await runNpmCommand(workspace, parsed.command, parsed.timeoutMs);
        const logs = [trimOutput(stdout), trimOutput(stderr)].filter(Boolean);
        await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "run_project_npm_command", ok: true, summary: `${parsed.command} finished.`, details: { command: parsed.command, cwd: workspace, logs } });
        return { ok: true, summary: `${parsed.command} finished.`, jobId: parsed.projectId, artifacts: [], structuredContent: { command: parsed.command, cwd: workspace, exitCode: 0 }, logs, errors: [] };
      } catch (error) {
        const failure = outputFromExecutionError(error);
        const logs = [failure.stdout, failure.stderr].filter(Boolean);
        const report = { command: parsed.command, cwd: workspace, exitCode: failure.code, message: failure.message, stdout: failure.stdout, stderr: failure.stderr };
        await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "run_project_npm_command", ok: false, summary: `${parsed.command} failed.`, details: report });
        return { ok: false, summary: `${parsed.command} failed.`, jobId: parsed.projectId, artifacts: [], structuredContent: report, logs, errors: [failure.message] };
      }
    }
  },
  {
    definition: {
      name: "write_project_workspace_asset",
      description: "Write a binary asset such as an image, texture, GLB/GLTF model, HDR, audio, or video into a project-bound workspace from raw base64.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, relativePath: { type: "string" }, contentBase64: { type: "string" } }, required: ["projectId", "relativePath", "contentBase64"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: writeProjectWorkspaceAssetSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof writeProjectWorkspaceAssetSchema>;
      const workspace = await resolveProjectWorkspace(ctx, parsed.projectId);
      const safePath = assertSafeWorkspaceAssetPath(parsed.relativePath);
      const buffer = decodePureBase64(parsed.contentBase64);
      const absolutePath = await safeResolveInside(workspace, safePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, buffer);
      const fileStat = await stat(absolutePath);
      const file = { path: safePath, size: fileStat.size, contentType: contentTypeForWorkspaceAsset(safePath), modifiedAt: fileStat.mtime.toISOString() };
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "write_project_workspace_asset", ok: true, summary: `Wrote workspace asset ${safePath}.`, details: file });
      return { ok: true, summary: `Wrote workspace asset ${safePath}.`, jobId: parsed.projectId, artifacts: [safePath], structuredContent: file, logs: [JSON.stringify(file, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "import_project_workspace_asset_from_local_file",
      description: "Copy a local generated/uploaded asset into a project-bound workspace, preserving binary bytes for images, textures, models, HDR, audio, or video.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, relativePath: { type: "string" }, sourcePath: { type: "string" } }, required: ["projectId", "relativePath", "sourcePath"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: importProjectWorkspaceAssetSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof importProjectWorkspaceAssetSchema>;
      const workspace = await resolveProjectWorkspace(ctx, parsed.projectId);
      const safePath = assertSafeWorkspaceAssetPath(parsed.relativePath);
      const sourceCandidate = path.isAbsolute(parsed.sourcePath) ? path.resolve(parsed.sourcePath) : path.resolve(ctx.workspaceRoot, parsed.sourcePath);
      const source = await assertInsideRoot(ctx.workspaceRoot, sourceCandidate, "sourcePath");
      assertNoHiddenPathSegments(source.relativePath, "sourcePath");
      const sourceStat = await stat(source.target);
      if (!sourceStat.isFile()) throw new Error("sourcePath must point to a file.");
      if (sourceStat.size > maxWorkspaceAssetBytes) throw new Error("Workspace asset exceeds 100 MiB.");
      const absolutePath = await safeResolveInside(workspace, safePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await copyFile(source.target, absolutePath);
      const fileStat = await stat(absolutePath);
      const file = { path: safePath, size: fileStat.size, contentType: contentTypeForWorkspaceAsset(safePath), sourcePath: source.relativePath, modifiedAt: fileStat.mtime.toISOString() };
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "import_project_workspace_asset_from_local_file", ok: true, summary: `Imported workspace asset ${safePath}.`, details: file });
      return { ok: true, summary: `Imported workspace asset ${safePath}.`, jobId: parsed.projectId, artifacts: [safePath], structuredContent: file, logs: [JSON.stringify(file, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "inspect_project_workspace",
      description: "Start a project-bound workspace dev server and inspect desktop/tablet/mobile screenshots, console errors, layout, and optional accessibility.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, script: { type: "string", enum: ["dev", "start"] }, port: { type: "number" }, host: { type: "string" }, path: { type: "string" }, viewports: { type: "array", items: { type: "string", enum: ["desktop", "tablet", "mobile"] } }, includeAccessibility: { type: "boolean" }, includeLighthouse: { type: "boolean" }, closeAfterCheck: { type: "boolean" }, timeoutMs: { type: "number" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: inspectProjectWorkspaceSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof inspectProjectWorkspaceSchema>;
      const workspace = await resolveProjectWorkspace(ctx, parsed.projectId);
      const inspectTool = webInspectTools.find((tool) => tool.definition.name === "inspect_local_project");
      if (!inspectTool) throw new Error("inspect_local_project tool is not registered.");
      const result = await inspectTool.handler({
        script: parsed.script,
        port: parsed.port,
        host: parsed.host,
        path: parsed.path,
        viewports: parsed.viewports,
        includeAccessibility: parsed.includeAccessibility,
        includeLighthouse: parsed.includeLighthouse,
        closeAfterCheck: parsed.closeAfterCheck,
        timeoutMs: parsed.timeoutMs
      }, { ...ctx, workspaceRoot: workspace });
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "inspect_project_workspace", ok: result.ok, summary: result.summary, details: result.structuredContent });
      return { ...result, jobId: parsed.projectId };
    }
  },
  {
    definition: {
      name: "record_project_workspace_video",
      description: "Start a project-bound workspace dev server, record real browser output to WebM, and optionally convert to MP4 when ffmpeg is installed.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          script: { type: "string", enum: ["dev", "start"] },
          port: { type: "number" },
          host: { type: "string" },
          path: { type: "string" },
          viewport: { type: "string", enum: ["desktop", "tablet", "mobile", "fullscreen"] },
          width: { type: "number" },
          height: { type: "number" },
          durationMs: { type: "number" },
          waitAfterLoadMs: { type: "number" },
          format: { type: "string", enum: ["webm", "mp4"] },
          closeAfterRecord: { type: "boolean" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: recordProjectWorkspaceVideoSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof recordProjectWorkspaceVideoSchema>;
      const workspace = await resolveProjectWorkspace(ctx, parsed.projectId);
      const server = startWorkspaceServer(workspace, parsed);
      const videoDir = path.join(os.tmpdir(), `coding-mcp-video-${parsed.projectId}-${Date.now()}`);
      await mkdir(videoDir, { recursive: true });
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      try {
        await waitForHttp(server.url, 30000);
        const { chromium } = await import("playwright");
        const size = viewportSize(parsed.viewport, parsed.width, parsed.height);
        const browser = await chromium.launch({ headless: true });
        let videoPath: string | undefined;
        try {
          const context = await browser.newContext({
            viewport: { width: size.width, height: size.height },
            isMobile: size.isMobile,
            deviceScaleFactor: size.isMobile ? 2 : 1,
            recordVideo: { dir: videoDir, size: { width: size.width, height: size.height } }
          });
          const page = await context.newPage();
          page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
          page.on("pageerror", (error) => pageErrors.push(error.message));
          await page.goto(server.url, { waitUntil: "networkidle", timeout: 30000 });
          if (parsed.waitAfterLoadMs > 0) await page.waitForTimeout(parsed.waitAfterLoadMs);
          await page.waitForTimeout(parsed.durationMs);
          const video = page.video();
          await context.close();
          videoPath = video ? await video.path() : undefined;
        } finally {
          await browser.close();
        }
        if (!videoPath) throw new Error("Playwright did not produce a video file.");
        const webmArtifact = await createArtifact({ artifactRoot: ctx.artifactRoot, filename: `${parsed.projectId}-recording.webm`, contentType: "video/webm", content: await readFile(videoPath) });
        const webmArtifactUrl = makeArtifactUrl(ctx.contentBaseUrl ?? ctx.publicBaseUrl, webmArtifact.id, webmArtifact.filename);
        let artifactUrl = webmArtifactUrl;
        let format = "webm";
        const artifacts = [webmArtifactUrl];
        const warnings: string[] = [];
        if (parsed.format === "mp4") {
          try {
            const mp4Path = path.join(videoDir, `${parsed.projectId}-recording.mp4`);
            await maybeConvertWebmToMp4(videoPath, mp4Path, Math.max(30000, parsed.durationMs * 3));
            const mp4Artifact = await createArtifact({ artifactRoot: ctx.artifactRoot, filename: `${parsed.projectId}-recording.mp4`, contentType: "video/mp4", content: await readFile(mp4Path) });
            artifactUrl = makeArtifactUrl(ctx.contentBaseUrl ?? ctx.publicBaseUrl, mp4Artifact.id, mp4Artifact.filename);
            artifacts.unshift(artifactUrl);
            format = "mp4";
          } catch (error) {
            const message = error instanceof Error ? error.message : "MP4 conversion failed.";
            warnings.push(`MP4 conversion failed; WebM artifact is available. ${message}`);
          }
        }
        const errors = [...consoleErrors, ...pageErrors, ...warnings];
        const ok = errors.length === 0;
        const report = { projectId: parsed.projectId, url: server.url, artifactUrl, webmArtifactUrl, requestedFormat: parsed.format, format, viewport: { name: parsed.viewport, width: size.width, height: size.height }, durationMs: parsed.durationMs, consoleErrors, pageErrors, warnings, serverLogs: server.logs.slice(-40) };
        await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "record_project_workspace_video", ok, summary: ok ? `Recorded browser output to ${format}.` : `Recorded browser output with issues.`, details: report });
        return { ok, summary: ok ? `Recorded browser output to ${format}.` : "Recorded browser output with issues.", jobId: parsed.projectId, previewUrl: artifactUrl, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors };
      } finally {
        if (parsed.closeAfterRecord && !server.process.killed) server.process.kill("SIGTERM");
        await rm(videoDir, { recursive: true, force: true });
      }
    }
  },
  {
    definition: {
      name: "publish_project_workspace",
      description: "Publish a built output directory from a project-bound real workspace to the project share URL.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, outputDir: { type: "string" }, entryFile: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: publishProjectWorkspaceSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof publishProjectWorkspaceSchema>;
      const workspace = await resolveProjectWorkspace(ctx, parsed.projectId);
      const outputDir = assertSafeRelativePath(parsed.outputDir);
      const distRoot = await safeResolveInside(workspace, outputDir);
      const distStat = await stat(distRoot);
      if (!distStat.isDirectory()) throw new Error(`outputDir is not a directory: ${outputDir}`);
      return copyPublishedDist(ctx, parsed.projectId, distRoot, parsed.entryFile);
    }
  },
  {
    definition: {
      name: "record_project_task",
      description: "Record queue/progress state for a project task in project activity history.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, status: { type: "string", enum: ["queued", "in_progress", "completed", "blocked"] }, summary: { type: "string" }, details: { type: "object" } }, required: ["projectId", "status", "summary"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: recordProjectTaskSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof recordProjectTaskSchema>;
      const metadata = await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, {
        toolName: `task_queue_${parsed.status}`,
        ok: parsed.status !== "blocked",
        summary: parsed.summary,
        details: { status: parsed.status, ...parsed.details }
      });
      return { ok: true, summary: `Recorded project task status: ${parsed.status}.`, jobId: parsed.projectId, artifacts: [], structuredContent: { latestTask: metadata.taskHistory?.at(-1), taskHistory: metadata.taskHistory }, logs: [JSON.stringify(metadata.taskHistory?.at(-1), null, 2)], errors: [] };
    }
  }
];

export async function runProjectGitCommand(ctx: ToolContext, projectId: string, args: string[], timeoutMs = ctx.commandTimeoutMs): Promise<{ stdout: string; stderr: string; cwd: string }> {
  const cwd = await resolveProjectGitWorkspace(ctx, projectId);
  const { stdout, stderr } = await execFileAsync("git", args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, env: gitChildEnv() });
  return { stdout, stderr, cwd };
}

export async function resolveProjectGitPath(ctx: ToolContext, projectId: string, relativePath: string): Promise<string> {
  const gitRoot = await resolveProjectGitWorkspace(ctx, projectId);
  const target = await safeResolveInside(gitRoot, relativePath);
  return path.relative(gitRoot, target).replaceAll("\\", "/");
}
