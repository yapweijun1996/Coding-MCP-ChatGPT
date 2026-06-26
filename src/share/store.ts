import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../shared/atomic-write.js";

export interface ShareRecord {
  id: string;
  filename: string;
  title: string;
  summary: string;
  filePath: string;
  createdAt: string;
  shareAccess: "private" | "anyone_with_link";
  ownerUserId?: string;
}

const shares = new Map<string, ShareRecord>();
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
      shares.set(`${id}/${filename}`, reconstructRecord(shareRoot, id, filename, createdAt));
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
}): Promise<ShareRecord> {
  if (input.html.length > 1024 * 1024) {
    throw new Error("Shared HTML must be 1 MiB or smaller.");
  }

  const id = randomUUID();
  const filename = sanitizeFilename(input.filename);
  const dir = path.join(input.shareRoot, id);
  const filePath = path.join(dir, filename);
  await mkdir(dir, { recursive: true });
  await atomicWrite(filePath, input.html);

  const record: ShareRecord = {
    id,
    filename,
    title: input.title,
    summary: input.summary,
    filePath,
    createdAt: new Date().toISOString(),
    shareAccess: input.shareAccess ?? "private",
    ownerUserId: input.ownerUserId
  };
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
    const candidate = reconstructRecord(shareRootDir, id, safeFilename, new Date().toISOString());
    try {
      const html = await readFile(candidate.filePath, "utf8");
      shares.set(`${id}/${safeFilename}`, candidate);
      return { record: candidate, html };
    } catch {
      return undefined;
    }
  }
  if (!record) return undefined;
  return {
    record,
    html: await readFile(record.filePath, "utf8")
  };
}

export function countShares(): number {
  return shares.size;
}
