import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { atomicWrite } from "../../shared/atomic-write.js";
import { childEnv } from "../child-env.js";
import type { ToolModule } from "../types.js";

const execFileAsync = promisify(execFile);

const sandboxKindSchema = z.enum(["code_script", "build", "data_job", "experiment"]);
const sandboxCommandSchema = z.enum(["node", "python3", "npm"]);

const createSandboxProfileInputSchema = z.object({
  kind: sandboxKindSchema,
  title: z.string().min(1).max(200),
  timeoutMs: z.number().int().min(500).max(600000).optional().default(120000),
  maxOutputBytes: z.number().int().min(1000).max(500000).optional().default(50000),
  maxArtifactBytes: z.number().int().min(1000).max(50 * 1024 * 1024).optional().default(5 * 1024 * 1024),
  cleanupPolicy: z.enum(["keep", "cleanup_on_success", "cleanup_always"]).optional().default("cleanup_on_success"),
  allowedCommands: z.array(sandboxCommandSchema).min(1).max(3).optional().default(["node", "python3", "npm"])
});

const prepareSandboxWorkspaceInputSchema = z.object({
  sandboxId: z.string().regex(/^sandbox_[a-zA-Z0-9_-]{1,80}$/).optional(),
  profile: createSandboxProfileInputSchema,
  files: z.array(z.object({
    path: z.string().min(1).max(240),
    content: z.string().max(200000)
  })).max(100).optional().default([])
});

const runSandboxedCommandInputSchema = z.object({
  sandboxId: z.string().regex(/^sandbox_[a-zA-Z0-9_-]{1,80}$/),
  command: sandboxCommandSchema,
  args: z.array(z.string().min(1).max(240)).max(30).optional().default([]),
  cwd: z.string().min(1).max(240).optional().default("."),
  timeoutMs: z.number().int().min(500).max(600000).optional(),
  maxOutputBytes: z.number().int().min(1000).max(500000).optional(),
  collectArtifacts: z.array(z.string().min(1).max(240)).max(100).optional().default([])
});

const listSandboxRunsInputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional().default(50)
});

const cleanupSandboxInputSchema = z.object({
  sandboxId: z.string().regex(/^sandbox_[a-zA-Z0-9_-]{1,80}$/)
});

const exportSandboxReportInputSchema = z.object({
  sandboxId: z.string().regex(/^sandbox_[a-zA-Z0-9_-]{1,80}$/),
  outputPath: z.string().min(1).max(240).optional().default("sandbox-report.md")
});

type SandboxProfile = z.infer<typeof createSandboxProfileInputSchema>;

interface SandboxManifest {
  version: 1;
  sandboxId: string;
  profile: SandboxProfile;
  root: string;
  createdAt: string;
  updatedAt: string;
  runs: Array<{
    id: string;
    command: string;
    args: string[];
    cwd: string;
    exitCode: number | null;
    ok: boolean;
    timedOut: boolean;
    startedAt: string;
    finishedAt: string;
    stdout: string;
    stderr: string;
    artifacts: Array<{ path: string; size: number }>;
  }>;
  /** Set when a cleanup policy deleted the workspace; the manifest then lives in the archive. */
  removedAt?: string;
}

function sandboxesRoot(artifactRoot: string): string {
  return path.join(artifactRoot, "sandboxes");
}

function sandboxRoot(artifactRoot: string, sandboxId: string): string {
  return path.join(sandboxesRoot(artifactRoot), sandboxId);
}

function manifestPath(root: string): string {
  return path.join(root, "sandbox-manifest.json");
}

const MANIFEST_ARCHIVE_SUFFIX = ".manifest.json";
/** Upper bound on archived manifests; the oldest are pruned past this. */
const MAX_ARCHIVED_MANIFESTS = 200;

/** Manifest copy kept outside the workspace so cleanup policies do not erase run history. */
function archivedManifestPath(artifactRoot: string, id: string): string {
  return path.join(sandboxesRoot(artifactRoot), `${id}${MANIFEST_ARCHIVE_SUFFIX}`);
}

/** Reports for a removed workspace land here instead of resurrecting the deleted root. */
function archivedReportRoot(artifactRoot: string, id: string): string {
  return path.join(sandboxesRoot(artifactRoot), `${id}.reports`);
}

function sandboxId(): string {
  return `sandbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function trim(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= maxBytes) return value;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}... [truncated]`;
}

function safeRelativePath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("Sandbox paths must be relative.");
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) throw new Error("Sandbox path must include a filename or directory.");
  if (parts.some((part) => part === ".." || part.startsWith("."))) throw new Error("Parent traversal and hidden path segments are not allowed.");
  return parts.join("/");
}

function resolveInside(root: string, relativePath = "."): string {
  const normalized = relativePath === "." ? "." : safeRelativePath(relativePath);
  const target = path.resolve(root, normalized);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error("Path resolves outside sandbox.");
  return target;
}

async function readManifest(root: string): Promise<SandboxManifest> {
  return JSON.parse(await readFile(manifestPath(root), "utf8")) as SandboxManifest;
}

async function writeManifest(manifest: SandboxManifest): Promise<void> {
  await atomicWrite(manifestPath(manifest.root), `${JSON.stringify(manifest, null, 2)}\n`);
}

function archivedSandboxId(fileName: string): string {
  return fileName.slice(0, -MANIFEST_ARCHIVE_SUFFIX.length);
}

/**
 * Cap the archive: cleanup policies never call cleanup_sandbox, so without this every run
 * would leave a manifest behind forever and list_sandbox_runs would read them all on every
 * call. Oldest-first by mtime, and `protect` (the manifest just archived) is always kept.
 */
async function pruneArchivedManifests(artifactRoot: string, keep: number, protect: string): Promise<string[]> {
  const root = sandboxesRoot(artifactRoot);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((entry) => entry.isFile() && entry.name.startsWith("sandbox_") && entry.name.endsWith(MANIFEST_ARCHIVE_SUFFIX)).map((entry) => path.join(root, entry.name));
  if (names.length <= keep) return [];
  const dated = await Promise.all(names.filter((file) => file !== protect).map(async (file) => {
    const info = await stat(file).catch(() => undefined);
    return { file, mtimeMs: info?.mtimeMs ?? 0 };
  }));
  // Newest first, name as a deterministic tiebreak when timestamps collide.
  dated.sort((left, right) => right.mtimeMs - left.mtimeMs || right.file.localeCompare(left.file));
  const stale = dated.slice(Math.max(keep - 1, 0));
  for (const entry of stale) {
    await rm(entry.file, { force: true });
    await rm(archivedReportRoot(artifactRoot, archivedSandboxId(path.basename(entry.file))), { recursive: true, force: true });
  }
  return stale.map((entry) => entry.file);
}

/**
 * Persist the manifest next to the workspace instead of inside it, for the cleanup paths
 * where the workspace is about to be deleted. Writing it inside first would be a disk write
 * whose only fate is `rm`, and the run would then vanish from list_sandbox_runs entirely.
 */
async function archiveManifest(artifactRoot: string, manifest: SandboxManifest): Promise<{ path: string; pruned: string[] }> {
  const target = archivedManifestPath(artifactRoot, manifest.sandboxId);
  await atomicWrite(target, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path: target, pruned: await pruneArchivedManifests(artifactRoot, MAX_ARCHIVED_MANIFESTS, target) };
}

/** Read a live workspace manifest, falling back to the archived copy of a removed workspace. */
async function loadManifest(artifactRoot: string, id: string): Promise<SandboxManifest> {
  const live = await readManifest(sandboxRoot(artifactRoot, id)).catch(() => undefined);
  if (live) return live;
  return JSON.parse(await readFile(archivedManifestPath(artifactRoot, id), "utf8")) as SandboxManifest;
}

function validateArgs(command: z.infer<typeof sandboxCommandSchema>, args: string[]) {
  if (args.some((arg) => arg.includes("\0"))) throw new Error("NUL bytes are not allowed in command arguments.");
  if (command === "npm") {
    const allowed = [["test"], ["run", "build"], ["run", "typecheck"], ["run", "lint"], ["install", "--ignore-scripts"]];
    if (!allowed.some((pattern) => pattern.length === args.length && pattern.every((item, index) => item === args[index]))) {
      throw new Error("npm sandbox command must be one of: test, run build, run typecheck, run lint, install --ignore-scripts.");
    }
  }
}

async function collectArtifacts(root: string, paths: string[], maxArtifactBytes: number) {
  const artifacts: Array<{ path: string; size: number }> = [];
  for (const entry of paths) {
    const safe = safeRelativePath(entry);
    const absolute = resolveInside(root, safe);
    const fileStat = await stat(absolute).catch(() => undefined);
    if (!fileStat?.isFile()) continue;
    if (fileStat.size > maxArtifactBytes) throw new Error(`Artifact ${safe} exceeds maxArtifactBytes.`);
    artifacts.push({ path: safe, size: fileStat.size });
  }
  return artifacts;
}

interface InlineArtifact {
  path: string;
  size: number;
  encoding: "utf8" | "base64";
  content: string;
  truncated: boolean;
  omittedBytes: number;
}

/**
 * Read collected artifacts into memory before the workspace is deleted, so a cleanup
 * policy does not destroy the very files the caller asked for. `budgetBytes` caps the
 * total raw bytes inlined across all artifacts; anything beyond it is reported as
 * truncated rather than silently dropped.
 */
async function readArtifactsInline(root: string, artifacts: Array<{ path: string; size: number }>, budgetBytes: number): Promise<InlineArtifact[]> {
  const inlined: InlineArtifact[] = [];
  let remaining = Math.max(budgetBytes, 0);
  for (const artifact of artifacts) {
    const buffer = await readFile(resolveInside(root, artifact.path)).catch(() => undefined);
    if (!buffer) continue;
    const encoding: "utf8" | "base64" = isUtf8(buffer) && !buffer.includes(0) ? "utf8" : "base64";
    // base64 inflates 4/3, so spend the byte budget on the encoded form, not the raw bytes.
    const affordableRawBytes = encoding === "utf8" ? remaining : Math.floor(remaining / 4) * 3;
    const slice = buffer.subarray(0, Math.min(buffer.byteLength, affordableRawBytes));
    inlined.push({
      path: artifact.path,
      size: buffer.byteLength,
      encoding,
      content: slice.toString(encoding),
      truncated: slice.byteLength < buffer.byteLength,
      omittedBytes: buffer.byteLength - slice.byteLength
    });
    remaining = Math.max(remaining - (encoding === "utf8" ? slice.byteLength : Math.ceil(slice.byteLength / 3) * 4), 0);
  }
  return inlined;
}

async function listManifests(artifactRoot: string, limit: number) {
  const root = sandboxesRoot(artifactRoot);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  // Live workspaces first, so a re-prepared sandbox id wins over its archived predecessor.
  const manifests = new Map<string, SandboxManifest>();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("sandbox_") || entry.name.includes(".")) continue;
    const manifest = await readManifest(path.join(root, entry.name)).catch(() => undefined);
    if (manifest) manifests.set(manifest.sandboxId, manifest);
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("sandbox_") || !entry.name.endsWith(MANIFEST_ARCHIVE_SUFFIX)) continue;
    const manifest = await readFile(path.join(root, entry.name), "utf8").then((raw) => JSON.parse(raw) as SandboxManifest).catch(() => undefined);
    if (manifest && !manifests.has(manifest.sandboxId)) manifests.set(manifest.sandboxId, manifest);
  }
  return [...manifests.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit);
}

function renderReport(manifest: SandboxManifest) {
  return [
    `# Sandbox Report: ${manifest.sandboxId}`,
    "",
    `Kind: ${manifest.profile.kind}`,
    `Title: ${manifest.profile.title}`,
    `Cleanup policy: ${manifest.profile.cleanupPolicy}`,
    `Workspace: ${manifest.removedAt ? `removed at ${manifest.removedAt} (artifacts were returned inline by the run)` : manifest.root}`,
    "",
    "## Runs",
    ...(manifest.runs.length ? manifest.runs.map((run) => `- ${run.id}: ${run.command} ${run.args.join(" ")} => ${run.ok ? "ok" : "failed"} exit=${run.exitCode} artifacts=${run.artifacts.map((artifact) => artifact.path).join(", ") || "none"}`) : ["- No runs recorded."]),
    ""
  ].join("\n");
}

export const sandboxExecutionTools: ToolModule[] = [
  {
    definition: {
      name: "create_sandbox_profile",
      description: "Create a reviewable sandbox execution profile with command allowlist, time/output/artifact limits, and cleanup policy.",
      inputSchema: { type: "object", properties: { kind: { type: "string" }, title: { type: "string" }, timeoutMs: { type: "number" }, maxOutputBytes: { type: "number" }, maxArtifactBytes: { type: "number" }, cleanupPolicy: { type: "string" }, allowedCommands: { type: "array", items: { type: "string" } } }, required: ["kind", "title"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createSandboxProfileInputSchema,
    handler: (input) => {
      const profile = createSandboxProfileInputSchema.parse(input);
      return { ok: true, summary: `Created ${profile.kind} sandbox profile.`, artifacts: [], structuredContent: { profile }, logs: [JSON.stringify(profile, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "prepare_sandbox_workspace",
      description: "Create a sandbox workspace under artifactRoot with optional input files and a persisted manifest.",
      inputSchema: { type: "object", properties: { sandboxId: { type: "string" }, profile: { type: "object" }, files: { type: "array" } }, required: ["profile"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: prepareSandboxWorkspaceInputSchema,
    handler: async (input, ctx) => {
      const parsed = prepareSandboxWorkspaceInputSchema.parse(input);
      const id = parsed.sandboxId ?? sandboxId();
      const root = sandboxRoot(ctx.artifactRoot, id);
      await mkdir(root, { recursive: true });
      for (const file of parsed.files) {
        const safe = safeRelativePath(file.path);
        const absolute = resolveInside(root, safe);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, file.content, "utf8");
      }
      const now = new Date().toISOString();
      const manifest: SandboxManifest = { version: 1, sandboxId: id, profile: parsed.profile, root, createdAt: now, updatedAt: now, runs: [] };
      await writeManifest(manifest);
      return { ok: true, summary: `Prepared sandbox ${id}.`, artifacts: [root, manifestPath(root)], structuredContent: { sandboxId: id, root, fileCount: parsed.files.length, profile: parsed.profile }, logs: [JSON.stringify({ sandboxId: id, root }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "run_sandboxed_command",
      description: "Run an allowlisted command inside a prepared sandbox workspace with timeout/output limits and artifact collection.",
      inputSchema: { type: "object", properties: { sandboxId: { type: "string" }, command: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, timeoutMs: { type: "number" }, maxOutputBytes: { type: "number" }, collectArtifacts: { type: "array", items: { type: "string" } } }, required: ["sandboxId", "command"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: runSandboxedCommandInputSchema,
    handler: async (input, ctx) => {
      const parsed = runSandboxedCommandInputSchema.parse(input);
      const root = sandboxRoot(ctx.artifactRoot, parsed.sandboxId);
      // A failure before this point leaves the workspace on disk on purpose: the cleanup
      // policy is unknown until the manifest is read, and cleanup_sandbox can remove it.
      const manifest = await readManifest(root);
      let cleaned = false;
      try {
        if (!manifest.profile.allowedCommands.includes(parsed.command)) throw new Error(`Command ${parsed.command} is not allowed by sandbox profile.`);
        validateArgs(parsed.command, parsed.args);
        const cwd = resolveInside(root, parsed.cwd);
        const timeoutMs = parsed.timeoutMs ?? manifest.profile.timeoutMs;
        const maxOutputBytes = parsed.maxOutputBytes ?? manifest.profile.maxOutputBytes;
        const startedAt = new Date().toISOString();
        let stdout = "";
        let stderr = "";
        let exitCode: number | null = 0;
        let timedOut = false;
        try {
          const result = await execFileAsync(parsed.command, parsed.args, { cwd, timeout: timeoutMs, maxBuffer: maxOutputBytes * 2, env: childEnv() });
          stdout = result.stdout;
          stderr = result.stderr;
        } catch (error) {
          const err = error as NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: boolean };
          stdout = typeof err.stdout === "string" ? err.stdout : "";
          stderr = typeof err.stderr === "string" ? err.stderr : (error instanceof Error ? error.message : "Unknown sandbox execution error.");
          exitCode = typeof err.code === "number" ? err.code : null;
          timedOut = Boolean(err.killed) || /timeout/i.test(String(err.message));
        }
        const artifacts = await collectArtifacts(root, parsed.collectArtifacts, manifest.profile.maxArtifactBytes);
        const run = {
          id: `run_${manifest.runs.length + 1}`,
          command: parsed.command,
          args: parsed.args,
          cwd: path.relative(root, cwd) || ".",
          exitCode,
          ok: exitCode === 0 && !timedOut,
          timedOut,
          startedAt,
          finishedAt: new Date().toISOString(),
          stdout: trim(stdout, maxOutputBytes),
          stderr: trim(stderr, maxOutputBytes),
          artifacts
        };
        manifest.runs.push(run);
        manifest.updatedAt = run.finishedAt;
        const removesWorkspace = (run.ok && manifest.profile.cleanupPolicy === "cleanup_on_success") || manifest.profile.cleanupPolicy === "cleanup_always";
        // The workspace is about to disappear, so hand the artifact bytes back inline; the
        // returned paths then point only at what outlives the rm, never into the deleted root.
        const collectedArtifacts = removesWorkspace ? await readArtifactsInline(root, artifacts, maxOutputBytes) : [];
        let archivedManifest: string | undefined;
        let prunedArchives: string[] = [];
        if (removesWorkspace) {
          manifest.removedAt = run.finishedAt;
          // Archive before deleting: the copy outside the workspace is what survives the rm,
          // so list_sandbox_runs and export_sandbox_report still see this run.
          const archived = await archiveManifest(ctx.artifactRoot, manifest);
          archivedManifest = archived.path;
          prunedArchives = archived.pruned;
          await rm(root, { recursive: true, force: true });
          cleaned = true;
        } else {
          await writeManifest(manifest);
        }
        const pruneNote = prunedArchives.length ? ` Pruned ${prunedArchives.length} archived manifest(s) past the ${MAX_ARCHIVED_MANIFESTS} cap.` : "";
        const cleanupNote = removesWorkspace ? ` Workspace removed by ${manifest.profile.cleanupPolicy}; collected artifacts returned inline and run history archived.${pruneNote}` : "";
        return {
          ok: run.ok,
          summary: `Sandbox ${parsed.sandboxId} run ${run.ok ? "succeeded" : "failed"}.${cleanupNote}`,
          artifacts: archivedManifest ? [archivedManifest] : [manifestPath(root), ...artifacts.map((artifact) => path.join(root, artifact.path))],
          structuredContent: { sandboxId: parsed.sandboxId, run, workspaceRemoved: removesWorkspace, archivedManifest, prunedArchives, collectedArtifacts },
          logs: [run.stdout, run.stderr].filter(Boolean),
          errors: run.ok ? [] : [run.stderr || `exit code ${run.exitCode}`]
        };
      } finally {
        // cleanup_always must hold even when the run throws before the normal cleanup.
        if (!cleaned && manifest.profile.cleanupPolicy === "cleanup_always") {
          await rm(root, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  },
  {
    definition: {
      name: "list_sandbox_runs",
      description: "List recent sandbox manifests with profile, status, run count, and latest run metadata.",
      inputSchema: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listSandboxRunsInputSchema,
    handler: async (input, ctx) => {
      const parsed = listSandboxRunsInputSchema.parse(input);
      const manifests = await listManifests(ctx.artifactRoot, parsed.limit);
      const rows = manifests.map((manifest) => ({ sandboxId: manifest.sandboxId, profile: manifest.profile, createdAt: manifest.createdAt, updatedAt: manifest.updatedAt, runCount: manifest.runs.length, latestRun: manifest.runs.at(-1) }));
      return { ok: true, summary: `Found ${rows.length} sandbox run manifest(s).`, artifacts: [], structuredContent: { sandboxes: rows }, logs: rows.map((row) => `${row.sandboxId} ${row.profile.kind} runs=${row.runCount}`), errors: [] };
    }
  },
  {
    definition: {
      name: "cleanup_sandbox",
      description: "Delete a prepared sandbox workspace, its artifacts, and any archived run history.",
      inputSchema: { type: "object", properties: { sandboxId: { type: "string" } }, required: ["sandboxId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: cleanupSandboxInputSchema,
    handler: async (input, ctx) => {
      const parsed = cleanupSandboxInputSchema.parse(input);
      const root = sandboxRoot(ctx.artifactRoot, parsed.sandboxId);
      // Purge the archived manifest and reports too, otherwise an explicit cleanup would
      // leave the sandbox visible in list_sandbox_runs with no way to remove it.
      await rm(root, { recursive: true, force: true });
      await rm(archivedManifestPath(ctx.artifactRoot, parsed.sandboxId), { force: true });
      await rm(archivedReportRoot(ctx.artifactRoot, parsed.sandboxId), { recursive: true, force: true });
      return { ok: true, summary: `Cleaned up sandbox ${parsed.sandboxId}.`, artifacts: [], structuredContent: { sandboxId: parsed.sandboxId, removed: true }, logs: [], errors: [] };
    }
  },
  {
    definition: {
      name: "export_sandbox_report",
      description: "Export a Markdown report for a sandbox manifest with profile, runs, exit codes, and artifact references.",
      inputSchema: { type: "object", properties: { sandboxId: { type: "string" }, outputPath: { type: "string" } }, required: ["sandboxId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportSandboxReportInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportSandboxReportInputSchema.parse(input);
      const manifest = await loadManifest(ctx.artifactRoot, parsed.sandboxId);
      const markdown = renderReport(manifest);
      const relative = safeRelativePath(parsed.outputPath);
      // A removed workspace still has an archived manifest; write its report to a sibling
      // directory rather than recreating the workspace the cleanup policy just deleted.
      const reportRoot = manifest.removedAt ? archivedReportRoot(ctx.artifactRoot, parsed.sandboxId) : sandboxRoot(ctx.artifactRoot, parsed.sandboxId);
      const target = path.join(reportRoot, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await atomicWrite(target, markdown);
      return { ok: true, summary: `Exported sandbox report for ${parsed.sandboxId}.`, artifacts: [target], structuredContent: { path: target, markdown, workspaceRemoved: Boolean(manifest.removedAt) }, logs: [markdown], errors: [] };
    }
  }
];
