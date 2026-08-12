import { lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { withKeyedLock } from "../shared/keyed-lock.js";

const KiB = 1024;
const MiB = KiB * 1024;
const GiB = MiB * 1024;
const TiB = GiB * 1024;

export interface StoragePolicy {
  projectQuotaBytes: number;
  userQuotaBytes: number;
  globalQuotaBytes: number;
  warningThreshold: number;
  deletedProjectRetentionDays: number;
  monitorIntervalMs: number;
}

export interface StorageUsage {
  bytes: number;
  files: number;
  directories: number;
}

export interface StorageProjectDescriptor {
  id: string;
  title: string;
  status: string;
  workspacePath?: string;
}

export interface StorageScope {
  id: string;
  label: string;
  projectRoot: string;
  workspaceRoot: string;
  projects: readonly StorageProjectDescriptor[];
}

export type StorageQuotaState = "unlimited" | "ok" | "warning" | "over_quota";

export interface StorageQuotaStatus {
  state: StorageQuotaState;
  usedBytes: number;
  quotaBytes: number | null;
  remainingBytes: number | null;
  percentUsed: number | null;
}

export interface StorageProjectUsage extends StorageProjectDescriptor {
  projectBytes: number;
  workspaceBytes: number;
  totalBytes: number;
  quota: StorageQuotaStatus;
}

export interface StorageScopeReport {
  id: string;
  label: string;
  projectCount: number;
  projectUsage: StorageUsage;
  workspaceUsage: StorageUsage;
  totalBytes: number;
  quota: StorageQuotaStatus;
  projects: StorageProjectUsage[];
}

export interface StorageReport {
  generatedAt: string;
  scopes: StorageScopeReport[];
  artifactUsage: StorageUsage;
  shareUsage: StorageUsage;
  telemetryUsage: StorageUsage;
  totals: {
    projectBytes: number;
    workspaceBytes: number;
    artifactBytes: number;
    shareBytes: number;
    telemetryBytes: number;
    totalBytes: number;
  };
  globalQuota: StorageQuotaStatus;
  warnings: string[];
}

export interface StorageReportRoots {
  artifactRoot?: string;
  shareRoot?: string;
  telemetryRoot?: string;
}

export interface StorageQuotaInput {
  projectRoot: string;
  projectDirectory?: string;
  workspaceRoot?: string;
  workspacePath?: string;
  additionalBytes: number;
  /** Bytes currently present only in a same-directory staging file. */
  temporaryBytesToExclude?: number;
  globalRoots?: readonly string[];
  policy?: StoragePolicy;
}

export class StorageQuotaExceededError extends Error {
  readonly code = "STORAGE_QUOTA_EXCEEDED";
  readonly scope: "project" | "user" | "global";
  readonly usedBytes: number;
  readonly quotaBytes: number;
  readonly requestedBytes: number;

  constructor(input: { scope: "project" | "user" | "global"; usedBytes: number; quotaBytes: number; requestedBytes: number }) {
    super(`Storage ${input.scope} quota exceeded: ${input.usedBytes} bytes used, ${input.requestedBytes} bytes requested, ${input.quotaBytes} byte limit.`);
    this.name = "StorageQuotaExceededError";
    this.scope = input.scope;
    this.usedBytes = input.usedBytes;
    this.quotaBytes = input.quotaBytes;
    this.requestedBytes = input.requestedBytes;
  }
}

export const defaultStoragePolicy: StoragePolicy = {
  projectQuotaBytes: 5 * GiB,
  userQuotaBytes: 25 * GiB,
  globalQuotaBytes: 100 * GiB,
  warningThreshold: 0.8,
  deletedProjectRetentionDays: 7,
  monitorIntervalMs: 15 * 60 * 1000
};

let activeStoragePolicy: StoragePolicy = { ...defaultStoragePolicy };
type StorageRootProvider = () => Promise<readonly string[]>;
let globalStorageRootsProvider: StorageRootProvider | undefined;
const quotaCacheTtlMs = 5000;
const globalUsageCache = new Map<string, { usage: StorageUsage; expiresAt: number }>();
let providedRootsCache: { roots: string[]; expiresAt: number } | undefined;

function parseByteLimit(raw: string | undefined, fallback: number): number {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib|t|tb|tib)?$/.exec(value);
  if (!match) return fallback;
  const amount = Number.parseFloat(match[1]!);
  const multiplier = match[2] === "t" || match[2] === "tb" || match[2] === "tib"
    ? TiB
    : match[2] === "g" || match[2] === "gb" || match[2] === "gib"
      ? GiB
      : match[2] === "m" || match[2] === "mb" || match[2] === "mib"
        ? MiB
        : match[2] === "k" || match[2] === "kb" || match[2] === "kib"
          ? KiB
          : 1;
  const parsed = Math.round(amount * multiplier);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseNonNegativeInteger(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseDurationMs(raw: string | undefined, fallback: number): number {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(value);
  if (!match) return fallback;
  const amount = Number.parseFloat(match[1]!);
  const multiplier = match[2] === "h" ? 60 * 60 * 1000 : match[2] === "m" ? 60 * 1000 : match[2] === "s" ? 1000 : 1;
  const parsed = Math.round(amount * multiplier);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseWarningThreshold(raw: string | undefined, fallback: number): number {
  const value = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(value) || value <= 0 || value > 100) return fallback;
  return value / 100;
}

export function resolveStoragePolicy(env: NodeJS.ProcessEnv = process.env): StoragePolicy {
  return {
    projectQuotaBytes: parseByteLimit(env.PROJECT_STORAGE_QUOTA, defaultStoragePolicy.projectQuotaBytes),
    userQuotaBytes: parseByteLimit(env.USER_STORAGE_QUOTA, defaultStoragePolicy.userQuotaBytes),
    globalQuotaBytes: parseByteLimit(env.GLOBAL_STORAGE_QUOTA, defaultStoragePolicy.globalQuotaBytes),
    warningThreshold: parseWarningThreshold(env.STORAGE_WARN_AT_PERCENT, defaultStoragePolicy.warningThreshold),
    deletedProjectRetentionDays: parseNonNegativeInteger(env.DELETED_PROJECT_RETENTION_DAYS, defaultStoragePolicy.deletedProjectRetentionDays),
    monitorIntervalMs: parseDurationMs(env.STORAGE_MONITOR_INTERVAL_MS, defaultStoragePolicy.monitorIntervalMs)
  };
}

export function configureStoragePolicy(policy: StoragePolicy): void {
  activeStoragePolicy = { ...policy };
  globalUsageCache.clear();
}

export function getStoragePolicy(): StoragePolicy {
  return { ...activeStoragePolicy };
}

/**
 * Configure the complete set of roots that participate in the global hard
 * quota. The server installs this after user/project stores are initialized;
 * tests and embedders can instead pass `globalRoots` to withStorageQuota.
 */
export function configureStorageRootProvider(provider: StorageRootProvider | undefined): void {
  globalStorageRootsProvider = provider;
  providedRootsCache = undefined;
  globalUsageCache.clear();
}

async function resolveGlobalRoots(input: StorageQuotaInput): Promise<string[]> {
  if (input.globalRoots) return resolvedRoots([...input.globalRoots]);
  if (!globalStorageRootsProvider) return resolvedRoots([input.projectRoot, input.workspaceRoot]);
  if (providedRootsCache && providedRootsCache.expiresAt > Date.now()) return providedRootsCache.roots;
  const roots = resolvedRoots([...await globalStorageRootsProvider()]);
  providedRootsCache = { roots, expiresAt: Date.now() + quotaCacheTtlMs };
  return roots;
}

function resolvedRoots(roots: Array<string | undefined>): string[] {
  const unique = [...new Set(roots.filter((root): root is string => Boolean(root)).map((root) => path.resolve(root)))];
  const sorted = unique.sort((left, right) => left.length - right.length);
  return sorted.filter((root, index) => !sorted.slice(0, index).some((parent) => root === parent || root.startsWith(`${parent}${path.sep}`)));
}

export async function measureDirectory(root: string): Promise<StorageUsage> {
  const usage: StorageUsage = { bytes: 0, files: 0, directories: 0 };
  const resolvedRoot = path.resolve(root);

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        usage.directories += 1;
        await walk(absolute);
      } else if (entry.isFile()) {
        const fileStat = await lstat(absolute);
        usage.files += 1;
        usage.bytes += fileStat.size;
      }
    }
  }

  await walk(resolvedRoot);
  return usage;
}

function emptyUsage(): StorageUsage {
  return { bytes: 0, files: 0, directories: 0 };
}

async function measureOptionalDirectory(root: string | undefined): Promise<StorageUsage> {
  return root ? measureDirectory(root) : emptyUsage();
}

async function measureRoots(roots: Array<string | undefined>): Promise<StorageUsage> {
  const usage: StorageUsage = { bytes: 0, files: 0, directories: 0 };
  for (const root of resolvedRoots(roots)) {
    const measured = await measureDirectory(root);
    usage.bytes += measured.bytes;
    usage.files += measured.files;
    usage.directories += measured.directories;
  }
  return usage;
}

function isStrictlyInside(root: string | undefined, target: string | undefined): boolean {
  if (!root || !target) return false;
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  return normalizedTarget !== normalizedRoot && normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function quotaStatus(usedBytes: number, quotaBytes: number, warningThreshold: number): StorageQuotaStatus {
  if (quotaBytes <= 0) {
    return { state: "unlimited", usedBytes, quotaBytes: null, remainingBytes: null, percentUsed: null };
  }
  const percentUsed = Math.round((usedBytes / quotaBytes) * 10000) / 100;
  return {
    state: usedBytes > quotaBytes ? "over_quota" : usedBytes >= quotaBytes * warningThreshold ? "warning" : "ok",
    usedBytes,
    quotaBytes,
    remainingBytes: Math.max(0, quotaBytes - usedBytes),
    percentUsed
  };
}

export async function withStorageQuota<T>(input: StorageQuotaInput, action: () => Promise<T>): Promise<T> {
  const policy = input.policy ?? activeStoragePolicy;
  if (policy.projectQuotaBytes <= 0 && policy.userQuotaBytes <= 0 && policy.globalQuotaBytes <= 0) return action();

  const lockKey = policy.globalQuotaBytes > 0 ? "storage-quota:global" : `storage-quota:${path.resolve(input.projectRoot)}`;
  return withKeyedLock(lockKey, async () => {
    const additionalBytes = Math.max(0, input.additionalBytes);
    const temporaryBytesToExclude = Math.max(0, input.temporaryBytesToExclude ?? 0);
    const projectUsage = input.projectDirectory
      ? await measureRoots([input.projectDirectory, isStrictlyInside(input.workspaceRoot, input.workspacePath) ? input.workspacePath : undefined])
      : undefined;
    const userUsage = policy.userQuotaBytes > 0 ? await measureRoots([input.projectRoot, input.workspaceRoot]) : undefined;
    const globalRoots = policy.globalQuotaBytes > 0 ? await resolveGlobalRoots(input) : [];
    const globalCacheKey = globalRoots.join("\u0000");
    const cachedGlobalUsage = globalUsageCache.get(globalCacheKey);
    const globalUsage = policy.globalQuotaBytes > 0
      ? cachedGlobalUsage && cachedGlobalUsage.expiresAt > Date.now()
        ? cachedGlobalUsage.usage
        : await measureRoots(globalRoots)
      : undefined;
    if (globalUsage && (!cachedGlobalUsage || cachedGlobalUsage.expiresAt <= Date.now())) {
      globalUsageCache.set(globalCacheKey, { usage: globalUsage, expiresAt: Date.now() + quotaCacheTtlMs });
    }

    const effectiveProjectBytes = projectUsage ? Math.max(0, projectUsage.bytes - temporaryBytesToExclude) : undefined;
    const effectiveUserBytes = userUsage ? Math.max(0, userUsage.bytes - temporaryBytesToExclude) : 0;
    const effectiveGlobalBytes = globalUsage ? Math.max(0, globalUsage.bytes - temporaryBytesToExclude) : undefined;

    if (effectiveProjectBytes !== undefined && policy.projectQuotaBytes > 0 && effectiveProjectBytes + additionalBytes > policy.projectQuotaBytes) {
      throw new StorageQuotaExceededError({
        scope: "project",
        usedBytes: effectiveProjectBytes,
        quotaBytes: policy.projectQuotaBytes,
        requestedBytes: additionalBytes
      });
    }
    if (policy.userQuotaBytes > 0 && effectiveUserBytes + additionalBytes > policy.userQuotaBytes) {
      throw new StorageQuotaExceededError({
        scope: "user",
        usedBytes: effectiveUserBytes,
        quotaBytes: policy.userQuotaBytes,
        requestedBytes: additionalBytes
      });
    }
    if (effectiveGlobalBytes !== undefined && effectiveGlobalBytes + additionalBytes > policy.globalQuotaBytes) {
      throw new StorageQuotaExceededError({
        scope: "global",
        usedBytes: effectiveGlobalBytes,
        quotaBytes: policy.globalQuotaBytes,
        requestedBytes: additionalBytes
      });
    }
    const result = await action();
    if (globalUsage) {
      const netAdditionalBytes = Math.max(0, additionalBytes - temporaryBytesToExclude);
      globalUsageCache.set(globalCacheKey, {
        usage: { ...globalUsage, bytes: globalUsage.bytes + netAdditionalBytes },
        expiresAt: Date.now() + quotaCacheTtlMs
      });
    }
    return result;
  });
}

/**
 * Apply only the global hard limit to a non-project root such as artifacts,
 * shares, or telemetry. Project and user limits are intentionally handled by
 * the caller that owns those scopes.
 */
export async function withGlobalStorageQuota<T>(input: { root: string; additionalBytes: number; globalRoots?: readonly string[] }, action: () => Promise<T>): Promise<T> {
  const policy = getStoragePolicy();
  return withStorageQuota({
    projectRoot: input.root,
    additionalBytes: input.additionalBytes,
    globalRoots: input.globalRoots,
    policy: { ...policy, projectQuotaBytes: 0, userQuotaBytes: 0 }
  }, action);
}

export async function getStorageReport(
  scopes: readonly StorageScope[],
  policy: StoragePolicy = activeStoragePolicy,
  roots: StorageReportRoots = {}
): Promise<StorageReport> {
  const scopeReports = await Promise.all(scopes.map(async (scope): Promise<StorageScopeReport> => {
    const [projectUsage, workspaceUsage] = await Promise.all([
      measureDirectory(scope.projectRoot),
      measureDirectory(scope.workspaceRoot)
    ]);
    const projects = await Promise.all(scope.projects.map(async (project): Promise<StorageProjectUsage> => {
      const projectPath = path.join(scope.projectRoot, project.id);
      const projectBytes = await measureDirectory(projectPath);
      const workspaceBytes = isStrictlyInside(scope.workspaceRoot, project.workspacePath)
        ? await measureDirectory(project.workspacePath!)
        : { bytes: 0, files: 0, directories: 0 };
      const totalBytes = projectBytes.bytes + workspaceBytes.bytes;
      return {
        id: project.id,
        title: project.title,
        status: project.status,
        projectBytes: projectBytes.bytes,
        workspaceBytes: workspaceBytes.bytes,
        totalBytes,
        quota: quotaStatus(totalBytes, policy.projectQuotaBytes, policy.warningThreshold)
      };
    }));
    const totalBytes = projectUsage.bytes + workspaceUsage.bytes;
    return {
      id: scope.id,
      label: scope.label,
      projectCount: scope.projects.length,
      projectUsage,
      workspaceUsage,
      totalBytes,
      quota: quotaStatus(totalBytes, policy.userQuotaBytes, policy.warningThreshold),
      projects: projects.sort((left, right) => right.totalBytes - left.totalBytes)
    };
  }));

  const [artifactUsage, shareUsage, telemetryUsage] = await Promise.all([
    measureOptionalDirectory(roots.artifactRoot),
    measureOptionalDirectory(roots.shareRoot),
    measureOptionalDirectory(roots.telemetryRoot)
  ]);
  const projectBytes = scopeReports.reduce((sum, scope) => sum + scope.projectUsage.bytes, 0);
  const workspaceBytes = scopeReports.reduce((sum, scope) => sum + scope.workspaceUsage.bytes, 0);
  const totalBytes = projectBytes + workspaceBytes + artifactUsage.bytes + shareUsage.bytes + telemetryUsage.bytes;
  const warnings = scopeReports
    .filter((scope) => scope.quota.state === "warning" || scope.quota.state === "over_quota")
    .map((scope) => `Storage scope ${scope.label} is ${scope.quota.state} (${scope.quota.percentUsed ?? 0}% used).`);
  const globalQuota = quotaStatus(totalBytes, policy.globalQuotaBytes, policy.warningThreshold);
  if (globalQuota.state === "warning" || globalQuota.state === "over_quota") {
    warnings.push(`Global storage is ${globalQuota.state} (${globalQuota.percentUsed ?? 0}% used).`);
  }

  return {
    generatedAt: new Date().toISOString(),
    scopes: scopeReports,
    artifactUsage,
    shareUsage,
    telemetryUsage,
    totals: { projectBytes, workspaceBytes, artifactBytes: artifactUsage.bytes, shareBytes: shareUsage.bytes, telemetryBytes: telemetryUsage.bytes, totalBytes },
    globalQuota,
    warnings
  };
}

export async function removeProjectArtifacts(artifactRoot: string | undefined, projectId: string): Promise<number> {
  if (!artifactRoot) return 0;
  let removedBytes = 0;
  const backupsRoot = path.join(artifactRoot, "project-backups");
  const backupEntries = await readdir(backupsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of backupEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith("backup_")) continue;
    const backupRoot = path.join(backupsRoot, entry.name);
    let manifest: { projectId?: unknown } | undefined;
    try {
      const raw = await readFile(path.join(backupRoot, "backup-manifest.json"), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") manifest = parsed as { projectId?: unknown };
    } catch {
      continue;
    }
    if (manifest?.projectId !== projectId) continue;
    removedBytes += (await measureDirectory(backupRoot)).bytes;
    await rm(backupRoot, { recursive: true, force: true });
  }

  const exportRoot = path.join(artifactRoot, "export-packages");
  const exportEntries = await readdir(exportRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of exportEntries) {
    if (!entry.isFile() || !entry.name.startsWith(`${projectId}-`)) continue;
    const target = path.join(exportRoot, entry.name);
    const fileStat = await lstat(target).catch(() => undefined);
    if (!fileStat?.isFile()) continue;
    removedBytes += fileStat.size;
    await rm(target, { force: true });
  }

  // Browser/video/screenshot artifacts use UUID directories and are not backed
  // by a durable project manifest. Project-aware producers include the project
  // id in the filename, so remove only those exact-name matches and leave
  // generic artifacts (which may belong to another workflow) untouched.
  const projectIdNeedle = projectId.toLowerCase();
  const artifactEntries = await readdir(artifactRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of artifactEntries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const artifactDirectory = path.join(artifactRoot, entry.name);
    const files = await readdir(artifactDirectory, { withFileTypes: true }).catch(() => []);
    let metadataProjectId: string | undefined;
    let metadataFound = false;
    try {
      const metadata = JSON.parse(await readFile(path.join(artifactDirectory, "artifact.json"), "utf8")) as { projectId?: unknown };
      metadataFound = true;
      if (typeof metadata.projectId === "string") metadataProjectId = metadata.projectId;
    } catch {
      // Legacy artifacts do not have durable project metadata.
    }
    const matchesMetadata = metadataProjectId === projectId;
    const matchesLegacyName = !metadataFound && files.some((file) => file.isFile() && file.name.toLowerCase().includes(projectIdNeedle));
    if (!matchesMetadata && !matchesLegacyName) continue;
    removedBytes += (await measureDirectory(artifactDirectory)).bytes;
    await rm(artifactDirectory, { recursive: true, force: true });
  }

  return removedBytes;
}

async function removeProjectShares(shareRoot: string | undefined, projectId: string): Promise<number> {
  if (!shareRoot) return 0;
  let removedBytes = 0;
  const shareEntries = await readdir(shareRoot, { withFileTypes: true }).catch(() => []);
  const projectIdNeedle = projectId.toLowerCase();
  for (const entry of shareEntries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const shareDirectory = path.join(shareRoot, entry.name);
    const files = await readdir(shareDirectory, { withFileTypes: true }).catch(() => []);
    let metadataProjectId: string | undefined;
    let metadataFound = false;
    try {
      const metadata = JSON.parse(await readFile(path.join(shareDirectory, "share.json"), "utf8")) as { projectId?: unknown };
      metadataFound = true;
      if (typeof metadata.projectId === "string") metadataProjectId = metadata.projectId;
    } catch {
      // Legacy shares do not have durable project metadata.
    }
    const matchesMetadata = metadataProjectId === projectId;
    const matchesLegacyName = !metadataFound && files.some((file) => file.isFile() && file.name.toLowerCase().includes(projectIdNeedle));
    if (!matchesMetadata && !matchesLegacyName) continue;
    removedBytes += (await measureDirectory(shareDirectory)).bytes;
    await rm(shareDirectory, { recursive: true, force: true });
  }
  return removedBytes;
}

export async function purgeProjectStorage(input: {
  projectDirectory: string;
  workspaceRoot?: string;
  workspacePath?: string;
  artifactRoot?: string;
  shareRoot?: string;
}): Promise<{ projectBytes: number; workspaceBytes: number; artifactBytes: number; shareBytes: number; workspaceRemoved: boolean }> {
  const projectBytes = (await measureDirectory(input.projectDirectory)).bytes;
  const canRemoveWorkspace = isStrictlyInside(input.workspaceRoot, input.workspacePath);
  const workspaceBytes = canRemoveWorkspace ? (await measureDirectory(input.workspacePath!)).bytes : 0;
  const artifactBytes = await removeProjectArtifacts(input.artifactRoot, path.basename(input.projectDirectory));
  const shareBytes = await removeProjectShares(input.shareRoot, path.basename(input.projectDirectory));
  await rm(input.projectDirectory, { recursive: true, force: true });
  if (canRemoveWorkspace) await rm(input.workspacePath!, { recursive: true, force: true });
  return { projectBytes, workspaceBytes, artifactBytes, shareBytes, workspaceRemoved: canRemoveWorkspace };
}
