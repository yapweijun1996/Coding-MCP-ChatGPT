import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../shared/atomic-write.js";

export interface ArtifactRecord {
  id: string;
  filename: string;
  contentType: string;
  filePath: string;
  createdAt: string;
}

const MAX_ARTIFACT_BYTES = 250 * 1024 * 1024;

function sanitizeArtifactId(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid artifact id.");
  return id;
}

function sanitizeArtifactFilename(filename: string): string {
  const normalized = filename.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,120}$/.test(normalized)) {
    throw new Error("filename must use letters, numbers, dot, underscore, or dash.");
  }
  return normalized;
}

export function makeArtifactUrl(publicBaseUrl: string, artifactId: string, filename: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/artifact/${artifactId}/${filename}`;
}

export async function createArtifact(input: {
  artifactRoot: string;
  filename: string;
  contentType: string;
  content: Buffer | string;
}): Promise<ArtifactRecord> {
  const content = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : input.content;
  if (content.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact must be ${MAX_ARTIFACT_BYTES} bytes or smaller.`);
  }

  const id = randomUUID();
  const filename = sanitizeArtifactFilename(input.filename);
  const dir = path.join(input.artifactRoot, id);
  const filePath = path.join(dir, filename);
  await mkdir(dir, { recursive: true });
  await atomicWrite(filePath, content);

  return {
    id,
    filename,
    contentType: input.contentType,
    filePath,
    createdAt: new Date().toISOString()
  };
}

export async function readArtifact(artifactRoot: string, id: string, filename: string): Promise<{ record: ArtifactRecord; content: Buffer } | undefined> {
  const safeId = sanitizeArtifactId(id);
  const safeFilename = sanitizeArtifactFilename(filename);
  const filePath = path.join(artifactRoot, safeId, safeFilename);
  const content = await readFile(filePath).catch(() => undefined);
  if (!content) return undefined;
  return {
    record: {
      id: safeId,
      filename: safeFilename,
      contentType: contentTypeForFilename(safeFilename),
      filePath,
      createdAt: ""
    },
    content
  };
}

function contentTypeForFilename(filename: string): string {
  const extension = filename.toLowerCase().split(".").pop();
  if (extension === "json") return "application/json";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webm") return "video/webm";
  if (extension === "mp4") return "video/mp4";
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "wav") return "audio/wav";
  if (extension === "ogg") return "audio/ogg";
  if (extension === "zip") return "application/zip";
  if (extension === "html") return "text/html";
  return "application/octet-stream";
}
