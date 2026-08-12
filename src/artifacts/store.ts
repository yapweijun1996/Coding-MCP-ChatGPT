import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../shared/atomic-write.js";
import { withGlobalStorageQuota } from "../storage/manager.js";

export interface ArtifactRecord {
  id: string;
  filename: string;
  contentType: string;
  filePath: string;
  createdAt: string;
  projectId?: string;
}

const MAX_ARTIFACT_BYTES = 250 * 1024 * 1024;
const ARTIFACT_METADATA_FILENAME = "artifact.json";

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
  projectId?: string;
  globalRoots?: readonly string[];
}): Promise<ArtifactRecord> {
  const content = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : input.content;
  if (content.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact must be ${MAX_ARTIFACT_BYTES} bytes or smaller.`);
  }

  const id = randomUUID();
  const filename = sanitizeArtifactFilename(input.filename);
  const dir = path.join(input.artifactRoot, id);
  const filePath = path.join(dir, filename);
  const createdAt = new Date().toISOString();
  const metadata = {
    id,
    filename,
    contentType: input.contentType,
    createdAt,
    ...(input.projectId ? { projectId: input.projectId } : {})
  };
  const metadataContent = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
  await withGlobalStorageQuota({
    root: input.artifactRoot,
    additionalBytes: content.byteLength + metadataContent.byteLength,
    globalRoots: input.globalRoots
  }, async () => {
    await mkdir(dir, { recursive: true });
    await atomicWrite(filePath, content);
    await atomicWrite(path.join(dir, ARTIFACT_METADATA_FILENAME), metadataContent);
  });

  return {
    id,
    filename,
    contentType: input.contentType,
    filePath,
    createdAt,
    projectId: input.projectId
  };
}

export async function readArtifact(artifactRoot: string, id: string, filename: string): Promise<{ record: ArtifactRecord; content: Buffer } | undefined> {
  const safeId = sanitizeArtifactId(id);
  const safeFilename = sanitizeArtifactFilename(filename);
  if (safeFilename === ARTIFACT_METADATA_FILENAME) return undefined;
  const filePath = path.join(artifactRoot, safeId, safeFilename);
  const content = await readFile(filePath).catch(() => undefined);
  if (!content) return undefined;
  const metadata = await readFile(path.join(artifactRoot, safeId, ARTIFACT_METADATA_FILENAME), "utf8")
    .then((raw) => JSON.parse(raw) as { contentType?: unknown; createdAt?: unknown; projectId?: unknown })
    .catch(() => undefined);
  return {
    record: {
      id: safeId,
      filename: safeFilename,
      contentType: typeof metadata?.contentType === "string" ? metadata.contentType : contentTypeForFilename(safeFilename),
      filePath,
      createdAt: typeof metadata?.createdAt === "string" ? metadata.createdAt : "",
      projectId: typeof metadata?.projectId === "string" ? metadata.projectId : undefined
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
