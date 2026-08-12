const redacted = "[redacted]";
const sensitiveExactKeys = new Set([
  "password",
  "passcode",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "clientsecret",
  "authorization",
  "cookie",
  "secret",
  // ChatGPT connector file references contain short-lived signed URLs and opaque IDs.
  // They must not be copied into activity or telemetry previews.
  "downloadurl",
  "fileid"
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof Buffer);
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  if (sensitiveExactKeys.has(normalized)) return true;
  return /(?:^|[_-])(?:token|secret|password|passcode|authorization|cookie)(?:$|[_-])/i.test(key)
    || /(?:accessToken|refreshToken|apiKey|clientSecret)$/i.test(key);
}

export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Buffer) return redacted;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  if (!isPlainRecord(value)) return redacted;

  const secretObject = value.secret === true;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (shouldRedactKey(key) || (secretObject && (key === "value" || key === "safeDefault"))) {
      output[key] = redacted;
    } else {
      output[key] = redactSecrets(item, seen);
    }
  }
  return output;
}
