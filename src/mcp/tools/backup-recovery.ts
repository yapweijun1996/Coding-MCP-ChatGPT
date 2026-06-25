import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "../../shared/atomic-write.js";
import {
  assertSafeProjectStoredPath,
  clearProjectFiles,
  getProjectManifest,
  getProjectFileContentType,
  getProjectStoredFilePath,
  isProjectTextFilePath,
  readProjectFile,
  writeProjectAsset,
  writeProjectFile
} from "../../projects/store.js";
import type { ProjectManifest } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const backupIdSchema = z.string().regex(/^backup_[a-zA-Z0-9_-]{1,80}$/);

const createProjectBackupInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  label: z.string().min(1).max(160),
  reason: z.string().max(1000).optional().default("Manual recovery point."),
  includeFiles: z.array(z.string().min(1).max(240)).max(500).optional(),
  backupId: backupIdSchema.optional()
});

const listProjectBackupsInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  limit: z.number().int().min(1).max(200).optional().default(50)
});

const verifyRecoveryPointInputSchema = z.object({
  backupId: backupIdSchema
});

const restoreProjectBackupInputSchema = z.object({
  backupId: backupIdSchema,
  projectId: z.string().min(8).max(80),
  mode: z.enum(["overwrite_all", "missing_only"]).optional().default("overwrite_all"),
  confirm: z.boolean().refine((value) => value === true, { message: "Restore requires confirm=true." })
});

const restoreLatestProjectBackupInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  mode: z.enum(["overwrite_all", "missing_only"]).optional().default("overwrite_all"),
  labelContains: z.string().min(1).max(160).optional(),
  confirm: z.boolean().optional().default(false)
});

const recoverDeletedProjectFileInputSchema = z.object({
  backupId: backupIdSchema,
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  confirm: z.boolean().refine((value) => value === true, { message: "File recovery requires confirm=true." })
});

const exportProjectBackupArchiveInputSchema = z.object({
  backupId: backupIdSchema,
  outputPath: z.string().min(1).max(240).optional().default("project-backup-archive.json")
});

interface BackupFileEntry {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
  text: boolean;
}

interface BackupManifest {
  version: 1;
  backupId: string;
  projectId: string;
  label: string;
  reason: string;
  entryFile: string;
  projectStatus: string;
  publishedUrl?: string;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
  files: BackupFileEntry[];
}

function backupsRoot(artifactRoot: string): string {
  return path.join(artifactRoot, "project-backups");
}

function backupRoot(artifactRoot: string, backupId: string): string {
  return path.join(backupsRoot(artifactRoot), backupId);
}

function backupFilesRoot(root: string): string {
  return path.join(root, "files");
}

function backupManifestPath(root: string): string {
  return path.join(root, "backup-manifest.json");
}

function createBackupId(projectId: string): string {
  return `backup_${projectId.replace(/^project_/, "").slice(0, 12)}_${Date.now().toString(36)}`;
}

function safeArchivePath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("Archive paths must be relative.");
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) throw new Error("Archive path must include a filename.");
  if (parts.some((part) => part === ".." || part.startsWith("."))) throw new Error("Parent traversal and hidden path segments are not allowed.");
  return parts.join("/");
}

function resolveBackupFile(root: string, relativePath: string): string {
  const safe = safeArchivePath(relativePath);
  const target = path.resolve(backupFilesRoot(root), safe);
  const base = path.resolve(backupFilesRoot(root));
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error("Backup file path resolves outside backup.");
  return target;
}

async function sha256File(absolutePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(absolutePath)).digest("hex");
}

async function readBackupManifest(root: string): Promise<BackupManifest> {
  return JSON.parse(await readFile(backupManifestPath(root), "utf8")) as BackupManifest;
}

async function writeBackupManifest(root: string, manifest: BackupManifest): Promise<void> {
  await atomicWrite(backupManifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function listBackupManifests(artifactRoot: string, projectId: string | undefined, limit: number): Promise<BackupManifest[]> {
  const root = backupsRoot(artifactRoot);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const manifests: BackupManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("backup_")) continue;
    const manifest = await readBackupManifest(path.join(root, entry.name)).catch(() => undefined);
    if (manifest && (!projectId || manifest.projectId === projectId)) manifests.push(manifest);
  }
  return manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit);
}

async function verifyManifest(root: string, manifest: BackupManifest) {
  const findings: string[] = [];
  let checkedBytes = 0;
  for (const file of manifest.files) {
    const absolute = resolveBackupFile(root, file.path);
    const fileStat = await stat(absolute).catch(() => undefined);
    if (!fileStat?.isFile()) {
      findings.push(`${file.path}: missing backup file`);
      continue;
    }
    checkedBytes += fileStat.size;
    if (fileStat.size !== file.size) findings.push(`${file.path}: size mismatch expected=${file.size} actual=${fileStat.size}`);
    const actualHash = await sha256File(absolute);
    if (actualHash !== file.sha256) findings.push(`${file.path}: sha256 mismatch`);
  }
  if (checkedBytes !== manifest.totalBytes) findings.push(`totalBytes mismatch expected=${manifest.totalBytes} actual=${checkedBytes}`);
  return { ok: findings.length === 0, checkedBytes, findings };
}

function selectFiles(project: ProjectManifest, includeFiles: string[] | undefined): BackupFileEntry[] {
  const selected = includeFiles?.length
    ? includeFiles.map((file) => assertSafeProjectStoredPath(file))
    : project.files.map((file) => file.path);
  const available = new Map(project.files.map((file) => [file.path, file]));
  return selected.map((relativePath) => {
    const file = available.get(relativePath);
    if (!file) throw new Error(`Project file ${relativePath} does not exist.`);
    return {
      path: relativePath,
      size: file.size,
      sha256: "",
      contentType: "",
      text: isProjectTextFilePath(relativePath)
    };
  });
}

async function restoreFile(projectRoot: string, projectId: string, root: string, file: BackupFileEntry) {
  const source = resolveBackupFile(root, file.path);
  if (file.text) {
    await writeProjectFile(projectRoot, projectId, file.path, await readFile(source, "utf8"));
  } else {
    await writeProjectAsset(projectRoot, projectId, file.path, await readFile(source), file.contentType);
  }
}

async function restoreBackupFiles(projectRoot: string, projectId: string, root: string, manifest: BackupManifest, mode: "overwrite_all" | "missing_only") {
  const existing = new Set((await getProjectManifest(projectRoot, projectId)).files.map((file) => file.path));
  if (mode === "overwrite_all") await clearProjectFiles(projectRoot, projectId);
  const restored: string[] = [];
  for (const file of manifest.files) {
    if (mode === "missing_only" && existing.has(file.path)) continue;
    await restoreFile(projectRoot, projectId, root, file);
    restored.push(file.path);
  }
  return restored;
}

export const backupRecoveryTools: ToolModule[] = [
  {
    definition: {
      name: "create_project_backup",
      description: "Create a project recovery point by copying selected project files into artifactRoot with hashes and a manifest.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, label: { type: "string" }, reason: { type: "string" }, includeFiles: { type: "array", items: { type: "string" } }, backupId: { type: "string" } }, required: ["projectId", "label"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createProjectBackupInputSchema,
    handler: async (input, ctx) => {
      const parsed = createProjectBackupInputSchema.parse(input);
      const project = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const id = parsed.backupId ?? createBackupId(parsed.projectId);
      const root = backupRoot(ctx.artifactRoot, id);
      await mkdir(backupFilesRoot(root), { recursive: true });
      const files = selectFiles(project, parsed.includeFiles);
      for (const file of files) {
        const source = await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, file.path);
        const target = resolveBackupFile(root, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(source, target);
        const fileStat = await stat(target);
        file.size = fileStat.size;
        file.sha256 = await sha256File(target);
        file.contentType = getProjectFileContentType(file.path);
      }
      const manifest: BackupManifest = {
        version: 1,
        backupId: id,
        projectId: parsed.projectId,
        label: parsed.label,
        reason: parsed.reason,
        entryFile: project.entryFile,
        projectStatus: project.metadata.status,
        publishedUrl: project.publishedUrl,
        createdAt: new Date().toISOString(),
        fileCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        files
      };
      await writeBackupManifest(root, manifest);
      return { ok: true, summary: `Created backup ${id} with ${files.length} file(s).`, jobId: parsed.projectId, artifacts: [root, backupManifestPath(root)], structuredContent: { backup: manifest }, logs: [JSON.stringify(manifest, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "list_project_backups",
      description: "List project backup manifests, optionally filtered by projectId.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, limit: { type: "number" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listProjectBackupsInputSchema,
    handler: async (input, ctx) => {
      const parsed = listProjectBackupsInputSchema.parse(input);
      const backups = await listBackupManifests(ctx.artifactRoot, parsed.projectId, parsed.limit);
      return { ok: true, summary: `Found ${backups.length} backup(s).`, artifacts: [], structuredContent: { backups }, logs: backups.map((backup) => `${backup.backupId} ${backup.projectId} files=${backup.fileCount}`), errors: [] };
    }
  },
  {
    definition: {
      name: "verify_recovery_point",
      description: "Verify a backup recovery point by checking every file exists and matches manifest size and sha256.",
      inputSchema: { type: "object", properties: { backupId: { type: "string" } }, required: ["backupId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: verifyRecoveryPointInputSchema,
    handler: async (input, ctx) => {
      const parsed = verifyRecoveryPointInputSchema.parse(input);
      const root = backupRoot(ctx.artifactRoot, parsed.backupId);
      const manifest = await readBackupManifest(root);
      const verification = await verifyManifest(root, manifest);
      return { ok: verification.ok, summary: verification.ok ? `Recovery point ${parsed.backupId} verified.` : `Recovery point ${parsed.backupId} has ${verification.findings.length} issue(s).`, artifacts: [backupManifestPath(root)], structuredContent: { backup: manifest, verification }, logs: [JSON.stringify(verification, null, 2)], errors: verification.findings };
    }
  },
  {
    definition: {
      name: "restore_project_backup",
      description: "Restore all files from a verified backup into a project, either replacing all files or filling missing files only.",
      inputSchema: { type: "object", properties: { backupId: { type: "string" }, projectId: { type: "string" }, mode: { type: "string" }, confirm: { type: "boolean" } }, required: ["backupId", "projectId", "confirm"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: restoreProjectBackupInputSchema,
    handler: async (input, ctx) => {
      const parsed = restoreProjectBackupInputSchema.parse(input);
      const root = backupRoot(ctx.artifactRoot, parsed.backupId);
      const manifest = await readBackupManifest(root);
      const verification = await verifyManifest(root, manifest);
      if (!verification.ok) throw new Error(`Cannot restore unverified backup: ${verification.findings.join("; ")}`);
      const restored = await restoreBackupFiles(ctx.projectRoot, parsed.projectId, root, manifest, parsed.mode);
      return { ok: true, summary: `Restored ${restored.length} file(s) from ${parsed.backupId}.`, jobId: parsed.projectId, artifacts: [backupManifestPath(root)], structuredContent: { backupId: parsed.backupId, projectId: parsed.projectId, mode: parsed.mode, restored }, logs: restored, errors: [] };
    }
  },
  {
    definition: {
      name: "restore_latest_project_backup",
      description: "One-click rollback helper: find the latest verified backup for a project, preview it by default, and restore it when confirm=true.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, mode: { type: "string" }, labelContains: { type: "string" }, confirm: { type: "boolean" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: restoreLatestProjectBackupInputSchema,
    handler: async (input, ctx) => {
      const parsed = restoreLatestProjectBackupInputSchema.parse(input);
      const backups = (await listBackupManifests(ctx.artifactRoot, parsed.projectId, 200))
        .filter((backup) => !parsed.labelContains || backup.label.toLowerCase().includes(parsed.labelContains!.toLowerCase()));
      const manifest = backups[0];
      if (!manifest) throw new Error(`No project backup found for ${parsed.projectId}${parsed.labelContains ? ` matching ${parsed.labelContains}` : ""}.`);
      const root = backupRoot(ctx.artifactRoot, manifest.backupId);
      const verification = await verifyManifest(root, manifest);
      const preview = {
        backupId: manifest.backupId,
        projectId: parsed.projectId,
        label: manifest.label,
        reason: manifest.reason,
        createdAt: manifest.createdAt,
        mode: parsed.mode,
        fileCount: manifest.fileCount,
        files: manifest.files.map((file) => file.path),
        verification
      };
      if (!verification.ok) return { ok: false, summary: `Latest backup ${manifest.backupId} failed verification.`, jobId: parsed.projectId, artifacts: [backupManifestPath(root)], structuredContent: { ...preview, restored: [] }, logs: [JSON.stringify(preview, null, 2)], errors: verification.findings };
      if (!parsed.confirm) {
        return { ok: true, summary: `Preview restore from latest backup ${manifest.backupId}; rerun with confirm=true to restore ${manifest.fileCount} file(s).`, jobId: parsed.projectId, artifacts: [backupManifestPath(root)], structuredContent: { ...preview, restored: [], dryRun: true }, logs: [JSON.stringify(preview, null, 2)], errors: [] };
      }
      const restored = await restoreBackupFiles(ctx.projectRoot, parsed.projectId, root, manifest, parsed.mode);
      return { ok: true, summary: `Restored ${restored.length} file(s) from latest backup ${manifest.backupId}.`, jobId: parsed.projectId, artifacts: [backupManifestPath(root)], structuredContent: { ...preview, restored, dryRun: false }, logs: restored, errors: [] };
    }
  },
  {
    definition: {
      name: "recover_deleted_project_file",
      description: "Recover one project file from a verified backup without replacing the rest of the project.",
      inputSchema: { type: "object", properties: { backupId: { type: "string" }, projectId: { type: "string" }, relativePath: { type: "string" }, confirm: { type: "boolean" } }, required: ["backupId", "projectId", "relativePath", "confirm"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: recoverDeletedProjectFileInputSchema,
    handler: async (input, ctx) => {
      const parsed = recoverDeletedProjectFileInputSchema.parse(input);
      const safeRelativePath = assertSafeProjectStoredPath(parsed.relativePath);
      const root = backupRoot(ctx.artifactRoot, parsed.backupId);
      const manifest = await readBackupManifest(root);
      const file = manifest.files.find((entry) => entry.path === safeRelativePath);
      if (!file) throw new Error(`Backup ${parsed.backupId} does not contain ${safeRelativePath}.`);
      const verification = await verifyManifest(root, { ...manifest, files: [file], fileCount: 1, totalBytes: file.size });
      if (!verification.ok) throw new Error(`Cannot recover unverified file: ${verification.findings.join("; ")}`);
      await restoreFile(ctx.projectRoot, parsed.projectId, root, file);
      return { ok: true, summary: `Recovered ${safeRelativePath} from ${parsed.backupId}.`, jobId: parsed.projectId, artifacts: [resolveBackupFile(root, file.path)], structuredContent: { backupId: parsed.backupId, projectId: parsed.projectId, recovered: file }, logs: [safeRelativePath], errors: [] };
    }
  },
  {
    definition: {
      name: "export_project_backup_archive",
      description: "Export a portable JSON archive containing the backup manifest and base64-encoded files.",
      inputSchema: { type: "object", properties: { backupId: { type: "string" }, outputPath: { type: "string" } }, required: ["backupId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: exportProjectBackupArchiveInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportProjectBackupArchiveInputSchema.parse(input);
      const root = backupRoot(ctx.artifactRoot, parsed.backupId);
      const manifest = await readBackupManifest(root);
      const verification = await verifyManifest(root, manifest);
      if (!verification.ok) throw new Error(`Cannot export unverified backup: ${verification.findings.join("; ")}`);
      const archive = {
        version: 1,
        exportedAt: new Date().toISOString(),
        manifest,
        files: await Promise.all(manifest.files.map(async (file) => ({
          path: file.path,
          sha256: file.sha256,
          contentBase64: (await readFile(resolveBackupFile(root, file.path))).toString("base64")
        })))
      };
      const target = path.join(root, safeArchivePath(parsed.outputPath));
      await mkdir(path.dirname(target), { recursive: true });
      await atomicWrite(target, `${JSON.stringify(archive, null, 2)}\n`);
      return { ok: true, summary: `Exported backup archive for ${parsed.backupId}.`, artifacts: [target], structuredContent: { path: target, fileCount: manifest.fileCount }, logs: [JSON.stringify({ path: target, fileCount: manifest.fileCount }, null, 2)], errors: [] };
    }
  }
];
