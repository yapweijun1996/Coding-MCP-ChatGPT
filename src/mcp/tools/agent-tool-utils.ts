import path from "node:path";
import { randomUUID } from "node:crypto";

export type TrimmedText = {
  text: string;
  truncated: boolean;
  maxBytes: number;
  bytes: number;
};

const MAX_LOG_BYTES = 40 * 1024;
const MAX_STRUCTURED_BYTES = 200 * 1024;
const SECRET_KEY_HINTS = /(token|secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:entication)?|credential|cookie|session|private[_-]?key)/i;

function normalizeSecretTextValue(value: string): string {
  const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g;
  const jwtPattern = /\b(?:eyJ|eyA|eyQ)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
  const longHexPattern = /\b[A-Fa-f0-9]{24,}\b/g;

  let next = value;
  next = next.replaceAll("[REDACTED]", "[REDACTED]");
  next = next.replace(bearerPattern, "Bearer [REDACTED]");
  next = next.replace(jwtPattern, "[REDACTED_TOKEN]");
  next = next.replace(longHexPattern, "[REDACTED]");

  return next.replace(/\b((?:authorization|cookie|token|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|credential)\b\s*[:=]\s*)("[^"]{0,255}"|'[^']{0,255}'|[^\s,;{}\[]+)/gi, (match, key) => {
    return `${key}[REDACTED]`;
  });
}

function safeByteTrim(value: string, maxBytes: number): TrimmedText {
  const currentBytes = Buffer.byteLength(value, "utf8");
  if (currentBytes <= maxBytes) {
    return {
      text: value,
      truncated: false,
      bytes: currentBytes,
      maxBytes
    };
  }

  const suffix = "...[truncated]";
  const available = Math.max(1, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let cut = value.length;
  while (cut > 0 && Buffer.byteLength(value.slice(0, cut), "utf8") > available) {
    cut -= 1;
  }
  const truncatedText = `${value.slice(0, cut)}${suffix}`;
  return {
    text: truncatedText,
    truncated: true,
    bytes: currentBytes,
    maxBytes
  };
}

export function trimText(value: string, maxBytes = MAX_LOG_BYTES): TrimmedText {
  return safeByteTrim(value, maxBytes);
}

export function trimLogLines(lines: string[], maxBytes = MAX_LOG_BYTES): string[] {
  const normalized = lines.map((line) => String(line ?? "").replace(/\s+$/, ""));
  const output: string[] = [];
  let used = 0;

  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const line = normalized[index];
    const candidate = output.length === 0 ? line : `${line}\n${output.join("\n")}`;
    const nextBytes = Buffer.byteLength(candidate, "utf8");
    if (nextBytes > maxBytes) {
      const remaining = maxBytes - used;
      if (remaining > 40) {
        const truncatedLine = safeByteTrim(line, remaining).text;
        const withMarker = truncatedLine.length > 0 ? `[truncated] ${truncatedLine}` : "[truncated lines]";
        output.unshift(withMarker);
      }
      break;
    }
    output.unshift(line);
    used = nextBytes;
  }

  return output;
}

export function trimStructuredContent(value: Record<string, unknown>, maxBytes = MAX_STRUCTURED_BYTES): Record<string, unknown> {
  const raw = JSON.stringify(value ?? {}, null, 2);
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) return value;
  return {
    truncated: true,
    maxBytes,
    totalBytes: Buffer.byteLength(raw, "utf8"),
    preview: safeByteTrim(raw, maxBytes).text
  };
}

export function ensureUnderWorkspace(workspaceRoot: string, target: string): string {
  const workspace = path.resolve(workspaceRoot);
  const candidate = path.isAbsolute(target) ? path.resolve(target) : path.resolve(workspace, target);
  if (candidate === workspace || candidate.startsWith(`${workspace}${path.sep}`)) {
    return candidate;
  }
  throw new Error(`Path outside workspace root: ${target}`);
}

export function sanitizeSecretLikeText(value: string): string {
  return normalizeSecretTextValue(value);
}

export function sanitizeSecretLikeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeSecretLikeText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSecretLikeValue(item));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_HINTS.test(key)) {
        result[key] = "[REDACTED]";
        continue;
      }
      result[key] = sanitizeSecretLikeValue(item);
    }
    return result;
  }

  return value;
}

export function safeArtifactSuffix(prefix: string, ext: string): string {
  const safePrefix = prefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 72);

  const safeExt = ext.replace(/^\./, "").toLowerCase();
  return `${safePrefix || "agent-output"}.${safeExt}`;
}

export function makeRandomHexId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}
