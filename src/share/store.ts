import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../shared/atomic-write.js";
import { withGlobalStorageQuota } from "../storage/manager.js";

export interface ShareRecord {
  id: string;
  filename: string;
  title: string;
  summary: string;
  filePath: string;
  createdAt: string;
  shareAccess: "private" | "anyone_with_link";
  ownerUserId?: string;
  projectId?: string;
}

const shares = new Map<string, ShareRecord>();
const SHARE_METADATA_FILENAME = "share.json";
// Remembered so readShareArtifact can self-heal on a map miss (e.g. a share
// created before initialize ran, or a scan that skipped it).
let shareRootDir: string | undefined;

function reconstructRecord(shareRoot: string, id: string, filename: string, createdAt: string): ShareRecord {
  return {
    id,
    filename,
    title: filename.replace(/\.html$/, ""),
    summary: "",
    filePath: path.join(shareRoot, id, filename),
    createdAt,
    shareAccess: "private"
  };
}

function recordFromMetadata(
  shareRoot: string,
  id: string,
  filename: string,
  fallbackCreatedAt: string,
  metadata: unknown
): ShareRecord | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = metadata as Record<string, unknown>;
  if (value.filename !== filename || typeof value.title !== "string" || typeof value.summary !== "string") return undefined;
  const shareAccess = value.shareAccess === "anyone_with_link" ? "anyone_with_link" : value.shareAccess === "private" ? "private" : undefined;
  if (!shareAccess) return undefined;
  return {
    id,
    filename,
    title: value.title,
    summary: value.summary,
    filePath: path.join(shareRoot, id, filename),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : fallbackCreatedAt,
    shareAccess,
    ownerUserId: typeof value.ownerUserId === "string" ? value.ownerUserId : undefined,
    projectId: typeof value.projectId === "string" ? value.projectId : undefined
  };
}

// Share artifacts live on disk under shareRoot/<id>/<filename> but the lookup
// map is in-memory, so without rehydration every restart/rebuild orphans 100%
// of previously issued share URLs (404). Scan the tree at boot, mirroring
// initializeJobStore. Best-effort: a missing/unreadable root is fine (no shares yet).
export async function initializeShareStore(shareRoot: string): Promise<void> {
  shareRootDir = shareRoot;
  let ids: string[];
  try {
    ids = await readdir(shareRoot);
  } catch {
    return;
  }
  for (const id of ids) {
    const dir = path.join(shareRoot, id);
    let files: string[];
    let createdAt = new Date().toISOString();
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      createdAt = info.birthtime.toISOString();
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const filename of files) {
      if (!filename.endsWith(".html")) continue;
      const metadata = await readFile(path.join(dir, SHARE_METADATA_FILENAME), "utf8")
        .then((raw) => JSON.parse(raw) as unknown)
        .catch(() => undefined);
      shares.set(`${id}/${filename}`, recordFromMetadata(shareRoot, id, filename, createdAt, metadata) ?? reconstructRecord(shareRoot, id, filename, createdAt));
    }
  }
}

function sanitizeFilename(filename: string): string {
  const normalized = filename.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,80}\.html$/.test(normalized)) {
    throw new Error("filename must be a simple .html file name using letters, numbers, dot, underscore, or dash.");
  }
  return normalized;
}

export async function createShareArtifact(input: {
  shareRoot: string;
  title: string;
  summary: string;
  filename: string;
  html: string;
  shareAccess?: "private" | "anyone_with_link";
  ownerUserId?: string;
  projectId?: string;
  globalRoots?: readonly string[];
}): Promise<ShareRecord> {
  if (input.html.length > 1024 * 1024) {
    throw new Error("Shared HTML must be 1 MiB or smaller.");
  }

  const id = randomUUID();
  const filename = sanitizeFilename(input.filename);
  const dir = path.join(input.shareRoot, id);
  const filePath = path.join(dir, filename);
  const createdAt = new Date().toISOString();
  const record: ShareRecord = {
    id,
    filename,
    title: input.title,
    summary: input.summary,
    filePath,
    createdAt,
    shareAccess: input.shareAccess ?? "private",
    ownerUserId: input.ownerUserId,
    projectId: input.projectId
  };
  const metadata = {
    id: record.id,
    filename: record.filename,
    title: record.title,
    summary: record.summary,
    createdAt: record.createdAt,
    shareAccess: record.shareAccess,
    ...(record.ownerUserId ? { ownerUserId: record.ownerUserId } : {}),
    ...(record.projectId ? { projectId: record.projectId } : {})
  };
  const metadataContent = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
  await withGlobalStorageQuota({
    root: input.shareRoot,
    additionalBytes: Buffer.byteLength(input.html, "utf8") + metadataContent.byteLength,
    globalRoots: input.globalRoots
  }, async () => {
    await mkdir(dir, { recursive: true });
    await atomicWrite(filePath, input.html);
    await atomicWrite(path.join(dir, SHARE_METADATA_FILENAME), metadataContent);
  });
  shares.set(`${id}/${filename}`, record);
  return record;
}

export async function readShareArtifact(id: string, filename: string): Promise<{ record: ShareRecord; html: string } | undefined> {
  const safeFilename = sanitizeFilename(filename);
  const record = shares.get(`${id}/${safeFilename}`);
  if (!record && shareRootDir) {
    // Self-heal: the file may exist on disk but be absent from the map.
    // Reject path-escaping ids (the filename is already sanitized above).
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id)) return undefined;
    const candidatePath = path.join(shareRootDir, id, safeFilename);
    try {
      const html = await readFile(candidatePath, "utf8");
      const metadata = await readFile(path.join(shareRootDir, id, SHARE_METADATA_FILENAME), "utf8")
        .then((raw) => JSON.parse(raw) as unknown)
        .catch(() => undefined);
      const candidate = recordFromMetadata(shareRootDir, id, safeFilename, new Date().toISOString(), metadata)
        ?? reconstructRecord(shareRootDir, id, safeFilename, new Date().toISOString());
      shares.set(`${id}/${safeFilename}`, candidate);
      return { record: candidate, html };
    } catch {
      return undefined;
    }
  }
  if (!record) return undefined;
  const html = await readFile(record.filePath, "utf8").catch(() => undefined);
  if (html === undefined) return undefined;
  return {
    record,
    html
  };
}

export function forgetSharesForProject(projectId: string): void {
  const needle = projectId.toLowerCase();
  for (const [key, record] of shares) {
    if (record.projectId === projectId || (!record.projectId && record.filename.toLowerCase().includes(needle))) shares.delete(key);
  }
}

export function countShares(): number {
  return shares.size;
}
