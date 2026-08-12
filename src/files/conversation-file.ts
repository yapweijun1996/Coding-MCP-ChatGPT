import { Readable } from "node:stream";
import { assertSafePublicUrl } from "../security/url.js";

export type ConversationFileSourceType = "chatgpt_conversation_file" | "chatgpt_image_gen";

export interface ConversationFileReference {
  download_url?: unknown;
  file_id?: unknown;
  mime_type?: unknown;
  file_name?: unknown;
  name?: unknown;
  size?: unknown;
  source_type?: unknown;
  origin?: unknown;
  generated?: unknown;
  [key: string]: unknown;
}

export interface ResolvedConversationFile {
  stream: Readable;
  expectedBytes?: number;
  declaredContentType?: string;
  responseContentType?: string;
  sourceFileName?: string;
  sourceType: ConversationFileSourceType;
  fileId?: string;
  wasAborted?: () => boolean;
  release?: () => void;
}

export interface ConversationFileResolver {
  resolve(reference: ConversationFileReference, options?: { timeoutMs?: number }): Promise<ResolvedConversationFile>;
}

export class ConversationFileError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ConversationFileError";
    this.code = code;
    this.details = details;
  }
}

const defaultAllowedHostSuffixes = ["oaiusercontent.com"];
const maxRedirects = 5;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function normalizedContentType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

function safeSourceFileName(reference: ConversationFileReference): string | undefined {
  const raw = stringValue(reference.file_name) ?? stringValue(reference.name);
  if (!raw) return undefined;
  const basename = raw.replaceAll("\\", "/").split("/").at(-1)?.split(/[?#]/, 1)[0]?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!basename || basename === "." || basename === "..") return undefined;
  return basename.slice(0, 255);
}

function sourceTypeFor(reference: ConversationFileReference): ConversationFileSourceType {
  const source = `${stringValue(reference.source_type) ?? ""} ${stringValue(reference.origin) ?? ""}`.toLowerCase();
  return reference.generated === true || source.includes("image_gen") || source.includes("generated_image")
    ? "chatgpt_image_gen"
    : "chatgpt_conversation_file";
}

function hostMatchesSuffix(hostname: string, suffix: string): boolean {
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, "");
  const normalizedSuffix = suffix.toLowerCase().replace(/^\.+/, "").replace(/\.$/, "");
  return normalizedHost === normalizedSuffix || normalizedHost.endsWith(`.${normalizedSuffix}`);
}

function assertAllowedDownloadHost(url: URL, allowedHostSuffixes: readonly string[]): void {
  if (!allowedHostSuffixes.some((suffix) => hostMatchesSuffix(url.hostname, suffix))) {
    throw new ConversationFileError("FILE_REFERENCE_INVALID", "The connector file download host is not an approved ChatGPT file host.");
  }
}

async function fetchConnectorStream(
  rawUrl: string,
  timeoutMs: number,
  allowedHostSuffixes: readonly string[],
  fetchImpl: typeof fetch
): Promise<{
  response: Response;
  wasAborted: () => boolean;
  release: () => void;
}> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new ConversationFileError("FILE_REFERENCE_INVALID", "The connector file reference does not contain a valid download URL.");
  }
  if (current.protocol !== "https:") {
    throw new ConversationFileError("FILE_REFERENCE_INVALID", "Connector file download URLs must use HTTPS.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
  };

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      assertAllowedDownloadHost(current, allowedHostSuffixes);
      // DNS/IP/private-network checks are repeated on every redirect hop. The identity
      // encoding request avoids a transparent content-encoding rewrite in the connector path.
      current = await assertSafePublicUrl(current);
      const response = await fetchImpl(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "Accept-Encoding": "identity" }
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location) return { response, wasAborted: () => controller.signal.aborted, release };
      try {
        current = new URL(location, current);
      } catch {
        throw new ConversationFileError("FILE_REFERENCE_INVALID", "The connector file redirect was invalid.");
      }
    }
    throw new ConversationFileError("FILE_REFERENCE_INVALID", "The connector file download used too many redirects.");
  } catch (error) {
    release();
    if (error instanceof ConversationFileError) throw error;
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new ConversationFileError("TRANSFER_INTERRUPTED", "The connector file download timed out or was interrupted.");
    }
    throw new ConversationFileError("CONNECTOR_FILE_UNAVAILABLE", "The connector file could not be downloaded.");
  }
}

export interface ConversationFileResolverOptions {
  /** Production uses the fixed ChatGPT host allowlist. Tests/embedders may provide a fetch seam without changing it. */
  allowedHostSuffixes?: readonly string[];
  fetchImpl?: typeof fetch;
}

export function createConversationFileResolver(options: ConversationFileResolverOptions = {}): ConversationFileResolver {
  const allowedHostSuffixes = options.allowedHostSuffixes ?? defaultAllowedHostSuffixes;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async resolve(reference, resolveOptions = {}) {
      const downloadUrl = stringValue(reference.download_url);
      const fileId = stringValue(reference.file_id);
      if (!downloadUrl) {
        if (fileId) {
          throw new ConversationFileError(
            "CONNECTOR_FILE_UNAVAILABLE",
            "The connector supplied a file_id without a temporary download_url; this server cannot resolve a file ID by guessing an OpenAI API endpoint.",
            { hasFileId: true }
          );
        }
        throw new ConversationFileError("FILE_REFERENCE_INVALID", "The connector file reference is missing download_url.");
      }

      const timeoutMs = resolveOptions.timeoutMs ?? 5 * 60 * 1000;
      const fetched = await fetchConnectorStream(downloadUrl, timeoutMs, allowedHostSuffixes, fetchImpl);
      if (fetched.response.status === 401 || fetched.response.status === 403 || fetched.response.status === 404 || fetched.response.status === 410) {
        fetched.release();
        if (fetched.response.body) await fetched.response.body.cancel().catch(() => undefined);
        throw new ConversationFileError("FILE_REFERENCE_EXPIRED", "The connector file download URL is expired or unavailable.", { status: fetched.response.status });
      }
      if (!fetched.response.ok || !fetched.response.body) {
        fetched.release();
        if (fetched.response.body) await fetched.response.body.cancel().catch(() => undefined);
        throw new ConversationFileError("CONNECTOR_FILE_UNAVAILABLE", "The connector file response was unavailable.", { status: fetched.response.status });
      }

      const headerSize = nonNegativeSafeInteger(fetched.response.headers.get("content-length"));
      const referenceSize = nonNegativeSafeInteger(reference.size);
      if (headerSize !== undefined && referenceSize !== undefined && headerSize !== referenceSize) {
        fetched.release();
        await fetched.response.body.cancel().catch(() => undefined);
        throw new ConversationFileError("TRANSFER_INTERRUPTED", "Connector file size metadata disagrees with the download response.", { expectedBytes: referenceSize, responseBytes: headerSize });
      }

      return {
        stream: Readable.fromWeb(fetched.response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
        expectedBytes: headerSize ?? referenceSize,
        declaredContentType: normalizedContentType(stringValue(reference.mime_type)),
        responseContentType: normalizedContentType(fetched.response.headers.get("content-type") ?? undefined),
        sourceFileName: safeSourceFileName(reference),
        sourceType: sourceTypeFor(reference),
        fileId,
        wasAborted: fetched.wasAborted,
        release: fetched.release
      };
    }
  };
}

export const defaultConversationFileResolver: ConversationFileResolver = createConversationFileResolver();

export function isConversationFileReference(value: unknown): value is ConversationFileReference {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function getConversationFileResolver(value: unknown): ConversationFileResolver {
  if (value && typeof value === "object" && "resolve" in value && typeof value.resolve === "function") {
    return value as ConversationFileResolver;
  }
  return defaultConversationFileResolver;
}
