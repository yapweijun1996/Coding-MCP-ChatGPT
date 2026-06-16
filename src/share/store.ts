import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ShareRecord {
  id: string;
  filename: string;
  title: string;
  summary: string;
  filePath: string;
  createdAt: string;
}

const shares = new Map<string, ShareRecord>();

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
}): Promise<ShareRecord> {
  if (input.html.length > 1024 * 1024) {
    throw new Error("Shared HTML must be 1 MiB or smaller.");
  }

  const id = randomUUID();
  const filename = sanitizeFilename(input.filename);
  const dir = path.join(input.shareRoot, id);
  const filePath = path.join(dir, filename);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, input.html, "utf8");

  const record: ShareRecord = {
    id,
    filename,
    title: input.title,
    summary: input.summary,
    filePath,
    createdAt: new Date().toISOString()
  };
  shares.set(`${id}/${filename}`, record);
  return record;
}

export async function readShareArtifact(id: string, filename: string): Promise<{ record: ShareRecord; html: string } | undefined> {
  const safeFilename = sanitizeFilename(filename);
  const record = shares.get(`${id}/${safeFilename}`);
  if (!record) return undefined;
  return {
    record,
    html: await readFile(record.filePath, "utf8")
  };
}

export function countShares(): number {
  return shares.size;
}
