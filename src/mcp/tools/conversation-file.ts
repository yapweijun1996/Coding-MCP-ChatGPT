import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ConversationFileError, getConversationFileResolver, isConversationFileReference } from "../../files/conversation-file.js";
import { inspectAssetPrefix, isContentTypeCompatible } from "../../files/asset-inspection.js";
import {
  appendProjectTaskHistory,
  assertSafeProjectAssetPath,
  getProject,
  getProjectFileContentType,
  maxProjectAssetBytesForExtension,
  ProjectAssetStreamError,
  validateProjectAssetBytes,
  writeProjectAssetFromStream
} from "../../projects/store.js";
import { StorageQuotaExceededError } from "../../storage/manager.js";
import type { ToolModule, ToolResult } from "../types.js";

const fileReferenceSchema = z.object({
  download_url: z.string().url().max(4000),
  file_id: z.string().min(1).max(500),
  mime_type: z.string().min(1).max(160).optional(),
  file_name: z.string().min(1).max(512).optional(),
  name: z.string().min(1).max(512).optional(),
  size: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).optional(),
  source_type: z.string().max(120).optional(),
  origin: z.string().max(120).optional(),
  generated: z.boolean().optional()
}).passthrough();

const promoteConversationFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  file: fileReferenceSchema,
  relativePath: z.string().min(1).max(240),
  overwrite: z.boolean().optional().default(false),
  preserveOriginal: z.boolean().optional().default(true)
});

const promoteConversationFileInputSchemaForTool = {
  type: "object",
  properties: {
    projectId: { type: "string", description: "Code-MCP project ID." },
    file: {
      type: "object",
      description: "Connector-provided ChatGPT conversation file reference. Do not replace with Base64 or a local filesystem path.",
      properties: {
        download_url: { type: "string", format: "uri", description: "Short-lived connector download URL supplied by ChatGPT." },
        file_id: { type: "string", description: "Opaque connector file ID, when supplied alongside download_url." },
        mime_type: { type: "string" },
        file_name: { type: "string" },
        name: { type: "string" },
        size: { oneOf: [{ type: "integer", minimum: 0 }, { type: "string", pattern: "^\\d+$" }] },
        source_type: { type: "string" },
        origin: { type: "string" },
        generated: { type: "boolean" }
      },
      required: ["download_url", "file_id"],
      additionalProperties: true
    },
    relativePath: { type: "string", description: "Project-relative asset path, for example assets/hero.png." },
    overwrite: { type: "boolean", default: false },
    preserveOriginal: { type: "boolean", default: true, description: "Must remain true for this lossless transfer tool." }
  },
  required: ["projectId", "file", "relativePath"],
  additionalProperties: false
} as Record<string, unknown>;

function safeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!details) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (["download_url", "url", "sourcePath", "file_id"].includes(key)) continue;
    if (typeof value === "string" && value.length > 1000) output[key] = value.slice(0, 1000);
    else output[key] = value;
  }
  return output;
}

function resultFailure(projectId: string | undefined, code: string, message: string, details: Record<string, unknown> = {}): ToolResult {
  const structuredContent: Record<string, unknown> = { ok: false, code, ...safeDetails(details) };
  return {
    ok: false,
    summary: `${code}: ${message}`,
    jobId: projectId,
    artifacts: [],
    structuredContent,
    logs: [JSON.stringify(structuredContent)],
    errors: [message]
  };
}

function classifyError(error: unknown): { code: string; message: string; details: Record<string, unknown> } {
  if (error instanceof ConversationFileError || error instanceof ProjectAssetStreamError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof StorageQuotaExceededError) {
    return {
      code: error.scope === "project" ? "PROJECT_STORAGE_LIMIT" : "STORAGE_LIMIT_EXCEEDED",
      message: `Insufficient ${error.scope} storage quota for this transfer.`,
      details: {
        requiredBytes: error.requestedBytes,
        availableBytes: Math.max(0, error.quotaBytes - error.usedBytes),
        usedBytes: error.usedBytes,
        maxBytes: error.quotaBytes,
        scope: error.scope
      }
    };
  }
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const code = error.code;
    if (code === "ENOENT") return { code: "PROJECT_NOT_FOUND", message: "The selected project does not exist.", details: {} };
    if (code === "EACCES" || code === "EPERM") return { code: "PROJECT_WRITE_DENIED", message: "The selected project is not writable.", details: {} };
  }
  if (error instanceof Error) {
    if (/parent traversal|absolute|outside the project|symlink|asset root|destination/i.test(error.message)) {
      return { code: "PATH_OUT_OF_SCOPE", message: error.message, details: {} };
    }
    if (/contentType|magic bytes|MIME|OOXML|must contain an <svg|valid UTF-8|asset must be/i.test(error.message)) {
      return { code: "MIME_MISMATCH", message: error.message, details: {} };
    }
    return { code: "TRANSFER_INTERRUPTED", message: "The connector file transfer did not complete.", details: {} };
  }
  return { code: "CONNECTOR_FILE_UNAVAILABLE", message: "The connector file could not be transferred.", details: {} };
}

async function recordPromotionFailure(ctx: Parameters<ToolModule["handler"]>[1], projectId: string, relativePath: string, failure: { code: string; message: string; details: Record<string, unknown> }): Promise<void> {
  try {
    const metadata = await getProject(ctx.projectRoot, projectId);
    if (metadata.status === "deleted") return;
    await appendProjectTaskHistory(ctx.projectRoot, projectId, {
      toolName: "promote_conversation_file_to_project",
      ok: false,
      summary: `Asset promotion failed (${failure.code}).`,
      details: {
        auditEvent: "project_asset_promoted",
        code: failure.code,
        path: relativePath,
        ...safeDetails(failure.details)
      }
    });
  } catch {
    // The MCP activity log still records the failed tool call. Do not hide the original error
    // behind a best-effort project-history failure.
  }
}

function normalizeContentType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

async function inspectAndValidateTemp(input: {
  tempPath: string;
  prefix: Buffer;
  relativePath: string;
  declaredContentTypes: Array<string | undefined>;
}): Promise<Record<string, unknown>> {
  const extension = path.extname(input.relativePath).toLowerCase();
  let detected = inspectAssetPrefix(input.prefix);
  if (!detected && extension === ".gltf") detected = { contentType: "model/gltf+json", format: "gltf" };
  if (!detected && extension === ".sfz") detected = { contentType: "text/plain", format: "sfz" };
  if (!detected) throw new ConversationFileError("UNSUPPORTED_FILE_TYPE", "The source bytes do not match a supported asset format.");

  const expectedContentType = getProjectFileContentType(input.relativePath);
  const allowsPptxDeclaredType = extension === ".pptx"
    && detected.contentType === "application/zip"
    && expectedContentType === "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  for (const declared of input.declaredContentTypes.map(normalizeContentType).filter((value): value is string => Boolean(value))) {
    if (!isContentTypeCompatible(declared, detected.contentType) && !(allowsPptxDeclaredType && declared === expectedContentType)) {
      throw new ConversationFileError("MIME_MISMATCH", "Declared connector MIME type does not match the source magic bytes.", {
        declaredContentType: declared,
        detectedContentType: detected.contentType
      });
    }
  }

  let validationBuffer = input.prefix;
  if (extension === ".pptx" || extension === ".svg" || extension === ".gltf" || extension === ".sfz") {
    validationBuffer = await readFile(input.tempPath);
  }

  if (extension === ".pptx") {
    if (detected.contentType !== "application/zip") {
      throw new ConversationFileError("MIME_MISMATCH", "A .pptx destination must contain an OOXML presentation package.");
    }
    detected = { ...detected, contentType: expectedContentType, format: "pptx" };
  } else if (expectedContentType !== "application/octet-stream" && expectedContentType !== detected.contentType) {
    throw new ConversationFileError("MIME_MISMATCH", "The destination extension does not match the source magic bytes.", {
      destinationContentType: expectedContentType,
      detectedContentType: detected.contentType,
      path: input.relativePath
    });
  }

  try {
    validateProjectAssetBytes(input.relativePath, validationBuffer, detected.contentType);
  } catch (error) {
    if (error instanceof Error) throw new ConversationFileError("MIME_MISMATCH", error.message);
    throw error;
  }
  return {
    contentType: detected.contentType,
    format: detected.format,
    ...(detected.width === undefined ? {} : { width: detected.width }),
    ...(detected.height === undefined ? {} : { height: detected.height }),
    ...(detected.hasAlpha === undefined ? {} : { hasAlpha: detected.hasAlpha }),
    ...(detected.orientation === undefined ? {} : { orientation: detected.orientation })
  };
}

export const conversationFileTools: ToolModule[] = [
  {
    definition: {
      name: "promote_conversation_file_to_project",
      description: "Promote a ChatGPT conversation attachment, image_gen generated image, or connector-provided file directly into a Code-MCP project. Preserves the original binary bytes, resolution, metadata and image quality by default; use this instead of Base64 when the source comes from the ChatGPT conversation or image generation workflow. This transfer tool never resizes, recompresses, converts, crops or optimizes the file. Use import_project_asset_from_local_file only for files already on the Code-MCP server filesystem, import_project_asset_from_url for a safe reachable HTTPS URL, and write_project_asset only for explicit Base64 compatibility workflows.",
      inputSchema: promoteConversationFileInputSchemaForTool,
      _meta: { "openai/fileParams": ["file"] },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
      outputSchema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          projectId: { type: "string" },
          path: { type: "string" },
          contentType: { type: "string" },
          size: { type: "integer" },
          width: { type: "integer" },
          height: { type: "integer" },
          format: { type: "string" },
          hasAlpha: { type: "boolean" },
          orientation: { type: "integer" },
          sha256: { type: "string" },
          sourceSha256: { type: "string" },
          destinationSha256: { type: "string" },
          byteExact: { type: "boolean" },
          qualityPreserved: { type: "boolean" },
          transformed: { type: "boolean" },
          alreadyPresent: { type: "boolean" }
        },
        required: ["ok"]
      }
    },
    enabledByDefault: true,
    schema: promoteConversationFileInputSchema,
    handler: async (input, ctx) => {
      let parsed: z.infer<typeof promoteConversationFileInputSchema>;
      try {
        parsed = promoteConversationFileInputSchema.parse(input);
      } catch {
        return resultFailure(undefined, "FILE_REFERENCE_INVALID", "The promotion input is invalid.");
      }

      if (!parsed.preserveOriginal) {
        const failure = { code: "PRESERVE_ORIGINAL_REQUIRED", message: "Promotion is lossless only; call an explicit optimization tool for transformations.", details: {} };
        await recordPromotionFailure(ctx, parsed.projectId, parsed.relativePath, failure);
        return resultFailure(parsed.projectId, failure.code, failure.message);
      }
      if (!isConversationFileReference(parsed.file)) {
        const failure = { code: "FILE_REFERENCE_INVALID", message: "The file must be a connector-provided file reference, not a local path or Base64 string.", details: {} };
        await recordPromotionFailure(ctx, parsed.projectId, parsed.relativePath, failure);
        return resultFailure(parsed.projectId, failure.code, failure.message);
      }

      try {
        assertSafeProjectAssetPath(parsed.relativePath);
      } catch (error) {
        const failure = classifyError(error);
        await recordPromotionFailure(ctx, parsed.projectId, parsed.relativePath, failure);
        return resultFailure(parsed.projectId, failure.code, failure.message, failure.details);
      }

      let project;
      try {
        project = await getProject(ctx.projectRoot, parsed.projectId);
        if (project.status === "deleted") throw new ProjectAssetStreamError("PROJECT_WRITE_DENIED", "Cannot promote an asset into a deleted project.");
      } catch (error) {
        const failure = classifyError(error);
        await recordPromotionFailure(ctx, parsed.projectId, parsed.relativePath, failure);
        return resultFailure(parsed.projectId, failure.code, failure.message, failure.details);
      }

      let resolved;
      try {
        resolved = await getConversationFileResolver(ctx.conversationFileResolver).resolve(parsed.file, { timeoutMs: ctx.fileTransferTimeoutMs });
      } catch (error) {
        const failure = classifyError(error);
        await recordPromotionFailure(ctx, parsed.projectId, parsed.relativePath, failure);
        return resultFailure(parsed.projectId, failure.code, failure.message, failure.details);
      }

      try {
        const extension = path.extname(parsed.relativePath).toLowerCase();
        const configuredMax = ctx.conversationFileMaxBytes ?? 100 * 1024 * 1024;
        const maxBytes = Math.min(configuredMax, maxProjectAssetBytesForExtension(extension));
        if (resolved.expectedBytes !== undefined && resolved.expectedBytes > maxBytes) {
          const failure = {
            code: "FILE_TOO_LARGE",
            message: "The connector file exceeds the configured project asset limit.",
            details: { maxBytes, actualBytes: resolved.expectedBytes }
          };
          await recordPromotionFailure(ctx, parsed.projectId, parsed.relativePath, failure);
          return resultFailure(parsed.projectId, failure.code, failure.message, failure.details);
        }

        const sourceContentTypes = [resolved.declaredContentType, resolved.responseContentType];
        const result = await writeProjectAssetFromStream(ctx.projectRoot, parsed.projectId, parsed.relativePath, resolved.stream, {
          expectedBytes: resolved.expectedBytes,
          maxBytes,
          overwrite: parsed.overwrite,
          contentType: getProjectFileContentType(parsed.relativePath),
          policy: ctx.storagePolicy,
          toolName: "promote_conversation_file_to_project",
          historyDetails: {
            auditEvent: "project_asset_promoted",
            sourceType: resolved.sourceType,
            ...(resolved.sourceFileName ? { sourceFileName: resolved.sourceFileName } : {}),
            sourceContentType: resolved.declaredContentType ?? resolved.responseContentType,
            sourceSize: resolved.expectedBytes
          },
          validateTemp: async ({ tempPath, prefix }) => inspectAndValidateTemp({
            tempPath,
            prefix,
            relativePath: parsed.relativePath,
            declaredContentTypes: sourceContentTypes
          })
        });
        const assetMetadata = result.metadata ?? {};
        const output: Record<string, unknown> = {
          ok: true,
          projectId: parsed.projectId,
          path: result.file.path,
          contentType: assetMetadata.contentType ?? getProjectFileContentType(result.file.path),
          size: result.file.size,
          ...assetMetadata,
          sha256: result.destinationSha256,
          sourceSha256: result.sourceSha256,
          destinationSha256: result.destinationSha256,
          byteExact: result.byteExact,
          qualityPreserved: result.byteExact,
          transformed: false,
          alreadyPresent: result.alreadyPresent,
          sourceType: resolved.sourceType,
          ...(resolved.sourceFileName ? { sourceFileName: resolved.sourceFileName } : {}),
          sourceContentType: resolved.declaredContentType ?? resolved.responseContentType ?? assetMetadata.contentType,
          sourceSize: result.sourceSize,
          overwrite: parsed.overwrite
        };
        return {
          ok: true,
          summary: `Promoted ${result.file.path} into project ${parsed.projectId} with byte-exact preservation.`,
          jobId: parsed.projectId,
          artifacts: [result.file.path],
          structuredContent: output,
          logs: [JSON.stringify(output)],
          errors: []
        };
      } catch (error) {
        const failure = resolved.wasAborted?.() ? { code: "TRANSFER_INTERRUPTED", message: "The connector file transfer was interrupted.", details: {} } : classifyError(error);
        await recordPromotionFailure(ctx, parsed.projectId, parsed.relativePath, failure);
        return resultFailure(parsed.projectId, failure.code, failure.message, failure.details);
      } finally {
        resolved.release?.();
      }
    }
  }
];
