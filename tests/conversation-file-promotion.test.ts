import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { conversationFileTools } from "../src/mcp/tools/conversation-file.js";
import { ConversationFileError, createConversationFileResolver, defaultConversationFileResolver, type ConversationFileResolver } from "../src/files/conversation-file.js";
import { createProject, getProjectFilesDirectory, getProject, type ProjectMetadata } from "../src/projects/store.js";
import type { StoragePolicy } from "../src/storage/manager.js";
import type { ToolContext } from "../src/mcp/types.js";

const promote = conversationFileTools[0]!;
const unlimitedPolicy: StoragePolicy = {
  projectQuotaBytes: 0,
  userQuotaBytes: 0,
  globalQuotaBytes: 0,
  warningThreshold: 0.8,
  deletedProjectRetentionDays: 7,
  monitorIntervalMs: 0
};

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function pngFixture(width: number, height: number, colorType = 6, size = 512): Buffer {
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const row = Buffer.alloc(width * channels + 1);
  const rawPixels = Buffer.alloc(row.length * height);
  for (let offset = 0; offset < rawPixels.length; offset += row.length) row.copy(rawPixels, offset);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const prefix = Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(rawPixels))]);
  const iend = pngChunk("IEND", Buffer.alloc(0));
  const fillerBytes = size - prefix.length - iend.length - 12;
  const filler = fillerBytes >= 7 ? pngChunk("tEXt", Buffer.concat([Buffer.from("filler\0", "ascii"), Buffer.alloc(fillerBytes - 7, 0x5a)])) : Buffer.alloc(0);
  return Buffer.concat([prefix, filler, iend]);
}

function jpegFixture(width: number, height: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]), sof, Buffer.from([0xff, 0xd9])]);
}

function chunkedStream(bytes: Buffer, chunkSize = 64 * 1024, onRead?: () => void): Readable {
  async function* chunks(): AsyncGenerator<Buffer> {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      onRead?.();
      yield bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    }
  }
  return Readable.from(chunks());
}

function resolverFor(bytes: Buffer, options: { sourceType?: "chatgpt_conversation_file" | "chatgpt_image_gen"; onRead?: () => void; expectedBytes?: number } = {}): ConversationFileResolver {
  return {
    async resolve(reference) {
      const contentType = typeof reference.mime_type === "string" ? reference.mime_type : "image/png";
      return {
        stream: chunkedStream(bytes, 64 * 1024, options.onRead),
        expectedBytes: options.expectedBytes ?? bytes.length,
        declaredContentType: contentType,
        responseContentType: contentType,
        sourceFileName: typeof reference.file_name === "string" ? reference.file_name : "fixture.png",
        sourceType: options.sourceType ?? "chatgpt_conversation_file",
        release: () => undefined
      };
    }
  };
}

function interruptedResolver(bytes: Buffer): ConversationFileResolver {
  return {
    async resolve() {
      const stream = new Readable({
        read() {
          this.push(bytes.subarray(0, 64));
          this.destroy(new Error("simulated connection reset"));
        }
      });
      return {
        stream,
        expectedBytes: bytes.length,
        declaredContentType: "image/png",
        responseContentType: "image/png",
        sourceType: "chatgpt_conversation_file"
      };
    }
  };
}

function context(projectRoot: string, resolver: ConversationFileResolver | undefined, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: path.join(projectRoot, "..", "workspace"),
    commandTimeoutMs: 30_000,
    shareRoot: path.join(projectRoot, "..", "shares"),
    artifactRoot: path.join(projectRoot, "..", "artifacts"),
    feedbackRoot: path.join(projectRoot, "..", "feedback"),
    projectRoot,
    clientId: "conversation-file-test",
    storagePolicy: unlimitedPolicy,
    conversationFileResolver: resolver,
    conversationFileMaxBytes: 100 * 1024 * 1024,
    fileTransferTimeoutMs: 30_000,
    ...overrides
  };
}

function fileReference(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { download_url: "https://files.oaiusercontent.com/fixture", file_id: "file_fixture", ...overrides };
}

async function makeProject(projectRoot: string, title = "Conversation file test"): Promise<ProjectMetadata> {
  await mkdir(projectRoot, { recursive: true });
  return createProject(projectRoot, { title, createdByClientId: "conversation-file-test" });
}

function content(result: Awaited<ReturnType<typeof promote.handler>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

test("publishes the native top-level ChatGPT file parameter contract", () => {
  assert.deepEqual(promote.definition._meta, { "openai/fileParams": ["file"] });
  assert.deepEqual((promote.definition.inputSchema as { properties: { file: { required: string[] } } }).properties.file.required, ["download_url", "file_id"]);
  assert.match(promote.definition.description, /instead of Base64/i);
});

test("does not resolve guessed file IDs or arbitrary local/foreign URLs", async () => {
  await assert.rejects(defaultConversationFileResolver.resolve({ file_id: "file_only" }), (error: unknown) => error instanceof ConversationFileError && error.code === "CONNECTOR_FILE_UNAVAILABLE");
  await assert.rejects(defaultConversationFileResolver.resolve({ download_url: "file:///etc/passwd", file_id: "file_local" }), (error: unknown) => error instanceof ConversationFileError && error.code === "FILE_REFERENCE_INVALID");
  await assert.rejects(defaultConversationFileResolver.resolve({ download_url: "https://example.com/file.png", file_id: "file_foreign" }), (error: unknown) => error instanceof ConversationFileError && error.code === "FILE_REFERENCE_INVALID");
});

test("streams the documented connector file reference without an in-context byte payload", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "conversation-native-resolver-"));
  const projectRoot = path.join(base, "projects");
  const source = pngFixture(1920, 1080, 6, 4096);
  try {
    const project = await makeProject(projectRoot, "Native resolver");
    const resolver = createConversationFileResolver({ fetchImpl: (async () => new Response(source, {
      status: 200,
      headers: { "content-length": String(source.length), "content-type": "image/png" }
    })) as typeof fetch });
    const result = await promote.handler({
      projectId: project.id,
      file: fileReference({ file_name: "generated.png", mime_type: "image/png", generated: true }),
      relativePath: "assets/generated.png"
    }, context(projectRoot, resolver));
    const output = content(result);
    assert.equal(result.ok, true);
    assert.equal(output.sourceType, "chatgpt_image_gen");
    assert.equal(output.byteExact, true);
    assert.deepEqual(await readFile(path.join(getProjectFilesDirectory(projectRoot, project.id), "assets/generated.png")), source);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("promotes a transparent 4096x2731 PNG byte-for-byte and records provenance", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "conversation-png-"));
  const projectRoot = path.join(base, "projects");
  try {
    const project = await makeProject(projectRoot);
    const source = pngFixture(4096, 2731, 6, 1024 * 1024 + 123);
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const result = await promote.handler({
      projectId: project.id,
      file: fileReference({ file_name: "imagegen.png", mime_type: "image/png", generated: true }),
      relativePath: "assets/hero-yong-tau-foo.png"
    }, context(projectRoot, resolverFor(source, { sourceType: "chatgpt_image_gen" })));
    const output = content(result);
    assert.equal(result.ok, true);
    assert.equal(output.width, 4096);
    assert.equal(output.height, 2731);
    assert.equal(output.hasAlpha, true);
    assert.equal(output.contentType, "image/png");
    assert.equal(output.size, source.length);
    assert.equal(output.sha256, sourceHash);
    assert.equal(output.sourceSha256, sourceHash);
    assert.equal(output.destinationSha256, sourceHash);
    assert.equal(output.byteExact, true);
    assert.equal(output.qualityPreserved, true);
    assert.equal(output.transformed, false);
    assert.equal(output.sourceType, "chatgpt_image_gen");
    const destination = await readFile(path.join(getProjectFilesDirectory(projectRoot, project.id), "assets/hero-yong-tau-foo.png"));
    assert.deepEqual(destination, source);
    const updated = await getProject(projectRoot, project.id);
    const audit = updated.taskHistory?.at(-1)?.details as Record<string, unknown>;
    assert.equal(updated.taskHistory?.at(-1)?.toolName, "promote_conversation_file_to_project");
    assert.equal(audit.auditEvent, "project_asset_promoted");
    assert.equal(audit.byteExact, true);
    assert.equal(audit.sourceType, "chatgpt_image_gen");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("promotes JPEGs without re-encoding and supports the normal attachment source", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "conversation-jpeg-"));
  const projectRoot = path.join(base, "projects");
  try {
    const project = await makeProject(projectRoot, "JPEG attachment");
    const source = jpegFixture(2560, 1440);
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const result = await promote.handler({
      projectId: project.id,
      file: fileReference({ file_name: "restaurant-photo.jpg", mime_type: "image/jpeg" }),
      relativePath: "assets/restaurant-photo.jpg"
    }, context(projectRoot, resolverFor(source, { onRead: () => undefined })));
    const output = content(result);
    assert.equal(result.ok, true);
    assert.equal(output.width, 2560);
    assert.equal(output.height, 1440);
    assert.equal(output.hasAlpha, false);
    assert.equal(output.format, "jpeg");
    assert.equal(output.sourceType, "chatgpt_conversation_file");
    assert.equal(output.sha256, sourceHash);
    assert.deepEqual(await readFile(path.join(getProjectFilesDirectory(projectRoot, project.id), "assets/restaurant-photo.jpg")), source);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("accepts the required full-resolution dimension fixtures and a 12 MiB streamed image", async () => {
  const resolutions = [[1920, 1080], [2560, 1440], [3840, 2160]] as const;
  const base = await mkdtemp(path.join(tmpdir(), "conversation-resolution-"));
  const projectRoot = path.join(base, "projects");
  try {
    for (const [index, [width, height]] of resolutions.entries()) {
      const project = await makeProject(projectRoot, `Resolution ${width}x${height}`);
      const size = index === resolutions.length - 1 ? 12 * 1024 * 1024 : 512;
      const source = pngFixture(width, height, 2, size);
      const result = await promote.handler({
        projectId: project.id,
        file: fileReference({ file_name: `resolution-${width}.png`, mime_type: "image/png" }),
        relativePath: `assets/resolution-${width}.png`
      }, context(projectRoot, resolverFor(source)));
      const output = content(result);
      assert.equal(result.ok, true);
      assert.equal(output.width, width);
      assert.equal(output.height, height);
      assert.equal(output.size, source.length);
      assert.equal(output.byteExact, true);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("is idempotent for an identical retry and protects existing bytes on conflicts", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "conversation-retry-"));
  const projectRoot = path.join(base, "projects");
  try {
    const project = await makeProject(projectRoot, "Retry");
    const source = pngFixture(1920, 1080, 6, 1024);
    const input = { projectId: project.id, file: fileReference({ file_name: "hero.png", mime_type: "image/png" }), relativePath: "assets/hero.png" };
    const first = await promote.handler(input, context(projectRoot, resolverFor(source)));
    const second = await promote.handler(input, context(projectRoot, resolverFor(source)));
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(content(second).alreadyPresent, true);

    const different = pngFixture(1920, 1080, 6, 1024);
    different[different.length - 1] = 0x41;
    const conflict = await promote.handler(input, context(projectRoot, resolverFor(different)));
    assert.equal(conflict.ok, false);
    assert.equal(content(conflict).code, "ASSET_ALREADY_EXISTS");
    assert.deepEqual(await readFile(path.join(getProjectFilesDirectory(projectRoot, project.id), "assets/hero.png")), source);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("uses atomic replacement only for explicit overwrite=true", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "conversation-overwrite-"));
  const projectRoot = path.join(base, "projects");
  try {
    const project = await makeProject(projectRoot, "Overwrite");
    const first = pngFixture(1920, 1080, 6, 1024);
    const replacement = pngFixture(1920, 1080, 2, 2048);
    const input = { projectId: project.id, file: fileReference({ file_name: "hero.png", mime_type: "image/png" }), relativePath: "assets/hero.png" };
    await promote.handler(input, context(projectRoot, resolverFor(first)));
    const result = await promote.handler({ ...input, overwrite: true }, context(projectRoot, resolverFor(replacement)));
    assert.equal(result.ok, true);
    assert.equal(content(result).size, replacement.length);
    assert.deepEqual(await readFile(path.join(getProjectFilesDirectory(projectRoot, project.id), "assets/hero.png")), replacement);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("rejects interrupted transfers without leaving a partial destination", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "conversation-interrupt-"));
  const projectRoot = path.join(base, "projects");
  try {
    const project = await makeProject(projectRoot, "Interrupted");
    const source = pngFixture(3840, 2160, 6, 4096);
    const result = await promote.handler({
      projectId: project.id,
      file: fileReference({ file_name: "interrupted.png", mime_type: "image/png" }),
      relativePath: "assets/interrupted.png"
    }, context(projectRoot, interruptedResolver(source)));
    assert.equal(result.ok, false);
    assert.equal(content(result).code, "TRANSFER_INTERRUPTED");
    await assert.rejects(stat(path.join(getProjectFilesDirectory(projectRoot, project.id), "assets/interrupted.png")), /ENOENT/);
    const entries = await readdir(path.join(getProjectFilesDirectory(projectRoot, project.id), "assets"));
    assert.deepEqual(entries, []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("rejects traversal, Windows absolute paths, MIME spoofing, and symlink escapes", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "conversation-security-"));
  const projectRoot = path.join(base, "projects");
  try {
    const project = await makeProject(projectRoot, "Security");
    const source = pngFixture(1920, 1080);
    for (const relativePath of ["../../outside.png", "/etc/passwd", "C:\\windows\\file.png", "assets/../../secret.png"]) {
      const result = await promote.handler({ projectId: project.id, file: fileReference({ file_name: "file.png", mime_type: "image/png" }), relativePath }, context(projectRoot, resolverFor(source)));
      assert.equal(result.ok, false, relativePath);
      assert.equal(content(result).code, "PATH_OUT_OF_SCOPE", relativePath);
    }

    const spoof = await promote.handler({ projectId: project.id, file: fileReference({ file_name: "spoof.png", mime_type: "image/png" }), relativePath: "assets/spoof.png" }, context(projectRoot, resolverFor(Buffer.from([0x50, 0x4b, 0x03, 0x04]))));
    assert.equal(spoof.ok, false);
    assert.equal(content(spoof).code, "MIME_MISMATCH");

    const outside = path.join(base, "outside");
    await mkdir(outside, { recursive: true });
    const filesRoot = getProjectFilesDirectory(projectRoot, project.id);
    await symlink(outside, path.join(filesRoot, "linked"));
    const symlinkResult = await promote.handler({ projectId: project.id, file: fileReference({ file_name: "file.png", mime_type: "image/png" }), relativePath: "linked/escaped.png" }, context(projectRoot, resolverFor(source)));
    assert.equal(symlinkResult.ok, false);
    assert.equal(content(symlinkResult).code, "PATH_OUT_OF_SCOPE");
    await assert.rejects(stat(path.join(outside, "escaped.png")), /ENOENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("checks quota before reading a known-size source", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "conversation-quota-"));
  const projectRoot = path.join(base, "projects");
  try {
    const project = await makeProject(projectRoot, "Quota");
    const source = pngFixture(3840, 2160, 6, 1024 * 1024);
    let started = false;
    const result = await promote.handler({
      projectId: project.id,
      file: fileReference({ file_name: "quota.png", mime_type: "image/png" }),
      relativePath: "assets/quota.png"
    }, context(projectRoot, resolverFor(source, { onRead: () => { started = true; } }), {
      storagePolicy: { ...unlimitedPolicy, projectQuotaBytes: 1 }
    }));
    assert.equal(result.ok, false);
    assert.equal(content(result).code, "PROJECT_STORAGE_LIMIT");
    assert.equal(started, false);
    await assert.rejects(stat(path.join(getProjectFilesDirectory(projectRoot, project.id), "assets", "quota.png")), /ENOENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
