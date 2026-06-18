import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { createJobResult } from "../result.js";
import type { ToolModule } from "../types.js";
import { legacyDelegatedTools } from "./legacy-delegate.js";
import { assertSafePublicUrl } from "../../security/url.js";

const execFileAsync = promisify(execFile);

const MAX_LOG_BYTES = 40000;
const DEFAULT_WEB_TIMEOUT_MS = 10000;
const DEFAULT_MAX_PREVIEW_BYTES = 20000;
const SERVER_SESSION_MAX_LOG_LINES = 200;
const DEFAULT_COMMAND_TIMEOUT_MS = 120000;

type NpmCommand = "npm test" | "npm run build" | "npm run typecheck" | "npm run lint" | "npm run format -- --check" | "npm run format";

interface ServerSession {
  process: ChildProcess;
  url: string;
  script: "dev" | "start";
  startedAt: string;
  exitCode: number | null;
  exited: boolean;
  logs: string[];
}

const runningServers = new Map<string, ServerSession>();

function trimOutput(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= MAX_LOG_BYTES) return normalized;
  return `${normalized.slice(0, MAX_LOG_BYTES)}... [truncated]`;
}

function safeResolveCwd(workspaceRoot: string, cwd?: string): string {
  const normalizedRoot = path.resolve(workspaceRoot);
  if (!cwd) return normalizedRoot;
  if (path.isAbsolute(cwd)) {
    const absoluteCandidate = path.resolve(cwd);
    if (absoluteCandidate === normalizedRoot || absoluteCandidate.startsWith(`${normalizedRoot}${path.sep}`)) {
      return absoluteCandidate;
    }
    throw new Error(`Invalid cwd outside workspace: ${cwd}`);
  }
  const candidate = path.resolve(workspaceRoot, cwd);
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Invalid cwd: ${cwd}`);
  }
  return candidate;
}

function appendServerLog(session: ServerSession, line: string, source: "stdout" | "stderr"): void {
  const text = trimOutput(line);
  if (!text) return;
  const prefixed = `[${source}] ${text}`;
  session.logs.push(prefixed);
  if (session.logs.length > SERVER_SESSION_MAX_LOG_LINES) {
    session.logs = session.logs.slice(-SERVER_SESSION_MAX_LOG_LINES);
  }
}

function parseUrl(urlString: string): URL {
  if (!/^https?:\/\//i.test(urlString)) {
    throw new Error(`Invalid URL "${urlString}": must start with http:// or https://.`);
  }
  return new URL(urlString);
}

const legacyCommandToolSchema = z.object({
  command: z.enum(["npm test", "npm run build", "npm run typecheck"])
});

const typedRunCommandSchema = z.object({
  command: z.literal("npm run typecheck"),
  timeoutMs: z.number().int().min(500).max(300000).optional().default(DEFAULT_COMMAND_TIMEOUT_MS)
});

const testsRunCommandSchema = z.object({
  command: z.literal("npm test"),
  timeoutMs: z.number().int().min(500).max(300000).optional().default(DEFAULT_COMMAND_TIMEOUT_MS)
});

const buildRunCommandSchema = z.object({
  command: z.literal("npm run build"),
  timeoutMs: z.number().int().min(500).max(300000).optional().default(DEFAULT_COMMAND_TIMEOUT_MS)
});

const lintRunCommandSchema = z.object({
  command: z.literal("npm run lint"),
  timeoutMs: z.number().int().min(500).max(300000).optional().default(DEFAULT_COMMAND_TIMEOUT_MS)
});

const formatCheckRunCommandSchema = z.object({
  command: z.literal("npm run format -- --check"),
  timeoutMs: z.number().int().min(500).max(300000).optional().default(DEFAULT_COMMAND_TIMEOUT_MS)
});

const formatWriteRunCommandSchema = z.object({
  command: z.literal("npm run format"),
  timeoutMs: z.number().int().min(500).max(300000).optional().default(DEFAULT_COMMAND_TIMEOUT_MS)
});

const diagnosticBundleRunCommandSchema = z.object({
  command: z.literal("diagnostic_bundle"),
  timeoutMs: z.number().int().min(500).max(300000).optional().default(DEFAULT_COMMAND_TIMEOUT_MS)
});

const diagnosticBundleFullRunCommandSchema = z.object({
  command: z.literal("diagnostic_bundle_full"),
  timeoutMs: z.number().int().min(500).max(300000).optional().default(DEFAULT_COMMAND_TIMEOUT_MS)
});

const checkUrlSchema = z.object({
  url: z.string().url({ message: "url must be a valid URL." }),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  timeoutMs: z.number().int().min(500).max(120000).default(DEFAULT_WEB_TIMEOUT_MS),
  maxBodyBytes: z.number().int().min(256).max(200000).default(DEFAULT_MAX_PREVIEW_BYTES)
});

const openLocalServerSchema = z.object({
  script: z.enum(["dev", "start"]).default("dev"),
  port: z.number().int().min(1024).max(65535).default(3000),
  host: z.string().min(1).max(128).default("127.0.0.1"),
  cwd: z.string().min(1).max(120).optional(),
  keepAlive: z.boolean().default(false)
});

const openLocalServerAndCheckSchema = z.object({
  script: z.enum(["dev", "start"]).default("dev"),
  port: z.number().int().min(1024).max(65535).default(3000),
  host: z.string().min(1).max(128).default("127.0.0.1"),
  cwd: z.string().min(1).max(120).optional(),
  path: z.string().min(1).max(240).default("/"),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  checkTimeoutMs: z.number().int().min(500).max(120000).default(10000),
  checkIntervalMs: z.number().int().min(100).max(5000).default(500),
  closeAfterCheck: z.boolean().default(true)
});

const stopLocalServerSchema = z.object({
  port: z.number().int().min(1024).max(65535).optional(),
  host: z.string().min(1).max(128).default("127.0.0.1"),
  all: z.boolean().default(false)
}).refine((value) => value.all || value.port !== undefined, {
  message: "Either set all=true or provide a port.",
  path: ["port"]
});

async function runNpmCommand(ctxCommandRoot: string, command: NpmCommand, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  const [file, args] = (() => {
    switch (command) {
      case "npm test":
        return ["npm", ["test"]];
      case "npm run build":
        return ["npm", ["run", "build"]];
      case "npm run typecheck":
        return ["npm", ["run", "typecheck"]];
      case "npm run lint":
        return ["npm", ["run", "lint"]];
      case "npm run format -- --check":
        return ["npm", ["run", "format", "--", "--check"]];
      case "npm run format":
        return ["npm", ["run", "format"]];
    }
  })();
  const { stdout, stderr } = await execFileAsync(file, args, {
    cwd: ctxCommandRoot,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  });
  return { stdout, stderr };
}

async function runNpmCommandSafe(ctxCommandRoot: string, command: NpmCommand, step: string, timeoutMs: number, logs: string[]): Promise<boolean> {
  try {
    const { stdout, stderr } = await runNpmCommand(ctxCommandRoot, command, timeoutMs);
    const stdoutTrimmed = trimOutput(stdout);
    const stderrTrimmed = trimOutput(stderr);
    if (stdoutTrimmed) logs.push(`[${step}] stdout: ${stdoutTrimmed}`);
    if (stderrTrimmed) logs.push(`[${step}] stderr: ${stderrTrimmed}`);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown; output?: unknown };
    if (typeof err?.stdout === "string" && err.stdout) {
      logs.push(`[${step}] stdout: ${trimOutput(err.stdout)}`);
    }
    if (typeof err?.stderr === "string" && err.stderr) {
      logs.push(`[${step}] stderr: ${trimOutput(err.stderr)}`);
    }
    if (Array.isArray(err.output) && err.output.length > 0) {
      const output = err.output.filter((value): value is string => typeof value === "string");
      if (output.length > 0) {
        logs.push(`[${step}] output: ${output.map(trimOutput).join(" | ")}`);
      }
    }
    logs.push(`[${step}] failed: ${err instanceof Error ? err.message : "Unknown execution error."}`);
    return false;
  }
}

function keyForServer(host: string, port: number): string {
  return `${host}:${port}`;
}

const checkUrlTool: ToolModule = {
  definition: {
    name: "check_url",
    description: "Fetch a webpage/API URL and return status, headers, and a response preview.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL." },
        method: { type: "string", enum: ["GET", "HEAD"] },
        timeoutMs: { type: "number", minimum: 500, maximum: 120000 },
        maxBodyBytes: { type: "number", minimum: 256, maximum: 200000 }
      },
      required: ["url"],
      additionalProperties: false
    }
  },
  enabledByDefault: false,
  schema: checkUrlSchema,
  handler: async (input, ctx) => {
    const parsed = input as z.infer<typeof checkUrlSchema>;
    const target = parseUrl(parsed.url);
    await assertSafePublicUrl(target, { protocols: ["http:", "https:"] });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), parsed.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(target.toString(), {
        method: parsed.method,
        signal: controller.signal,
        headers: { "User-Agent": "Coding-MCP-CheckURL/0.1" }
      });
      const durationMs = Date.now() - startedAt;
      const contentType = response.headers.get("content-type") ?? "unknown";
      const bodyText = parsed.method === "GET" ? await response.text() : "";
      const preview = parsed.method === "GET" ? trimOutput(bodyText.slice(0, parsed.maxBodyBytes)) : "";
      const logs = [
        `URL: ${target.toString()}`,
        `Status: ${response.status} ${response.statusText}`,
        `Final URL: ${response.url}`,
        `Content-Type: ${contentType}`,
        `Duration: ${durationMs}ms`,
        `Redirected: ${response.redirected}`,
        response.ok ? "Result: reachable" : "Result: non-2xx response",
        ...(preview ? [`Body preview:\n${preview}`] : [])
      ];
      if (response.ok) {
        return { ok: true, summary: `Checked ${target.href}.`, artifacts: [], logs, errors: [] };
      }
      return { ok: false, summary: `Request failed with ${response.status}.`, artifacts: [], logs, errors: [`${response.status} ${response.statusText}`] };
    } finally {
      clearTimeout(timeout);
    }
  }
};

const openLocalServerTool: ToolModule = {
  definition: {
    name: "open_local_server",
    description: "Start a local server process from workspace root for debugging page preview.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", enum: ["dev", "start"] },
        port: { type: "number", minimum: 1024, maximum: 65535 },
        host: { type: "string" },
        cwd: { type: "string" },
        keepAlive: { type: "boolean", description: "Keep server running for subsequent checks." }
      },
      additionalProperties: false
    }
  },
  enabledByDefault: false,
  schema: openLocalServerSchema,
  handler: async (input, ctx) => {
    const parsed = input as z.infer<typeof openLocalServerSchema>;
    const key = keyForServer(parsed.host, parsed.port);
    if (runningServers.has(key)) {
      const existing = runningServers.get(key)!;
      if (!existing.exited) {
        const probeLogs: string[] = [];
        const alive = await checkUrlOnce(existing.url, "HEAD", 1000, 1024, probeLogs);
        if (alive.ok) {
          return {
            ok: false,
            summary: `Server already running on ${existing.url}.`,
            artifacts: [existing.url],
            logs: [...existing.logs.slice(-30), ...probeLogs],
            errors: ["Port already occupied by a tracked MCP server session."]
          };
        }
        runningServers.delete(key);
      }
    }
    const workingDir = safeResolveCwd(ctx.workspaceRoot, parsed.cwd);
    const args = ["run", parsed.script];
    if (parsed.script === "dev") {
      args.push("--", "--host", parsed.host, "--port", String(parsed.port));
    }

    const proc = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const url = `http://${parsed.host}:${parsed.port}`;
    const session: ServerSession = {
      process: proc,
      url,
      script: parsed.script,
      startedAt: new Date().toISOString(),
      exitCode: null,
      exited: false,
      logs: [`Started script "${parsed.script}" with workingDir=${workingDir}`]
    };

    runningServers.set(key, session);

    proc.stdout?.on("data", (chunk) => {
      const sessionRef = runningServers.get(key);
      if (!sessionRef) return;
      appendServerLog(sessionRef, chunk.toString("utf8"), "stdout");
    });
    proc.stderr?.on("data", (chunk) => {
      const sessionRef = runningServers.get(key);
      if (!sessionRef) return;
      appendServerLog(sessionRef, chunk.toString("utf8"), "stderr");
    });
    proc.on("error", (error) => {
      const sessionRef = runningServers.get(key);
      if (!sessionRef) return;
      appendServerLog(sessionRef, `spawn error: ${error.message}`, "stderr");
      sessionRef.exited = true;
      sessionRef.exitCode = 1;
    });
    proc.on("exit", (code) => {
      const sessionRef = runningServers.get(key);
      if (!sessionRef) return;
      sessionRef.exited = true;
      sessionRef.exitCode = code === null ? 0 : code;
      appendServerLog(sessionRef, `process exited with code ${sessionRef.exitCode}`, "stderr");
      if (code !== null && code !== 0) {
        runningServers.delete(key);
      }
    });

    const summary = `Started local server ${parsed.script} at ${url}.`;
    const logs = [
      ...session.logs,
      `PID: ${proc.pid ?? "unknown"}`,
      `Working dir: ${workingDir}`,
      `KeepAlive: ${parsed.keepAlive ? "true" : "false"}`
    ];
    if (!parsed.keepAlive) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const latestSession = runningServers.get(key);
      if (latestSession) {
        logs.push(...latestSession.logs.slice(logs.length));
        if (!latestSession.exited) {
          try {
            latestSession.process.kill("SIGTERM");
            logs.push(`Stopped non-keepalive server ${url}.`);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to stop non-keepalive server.";
            logs.push(message);
          }
        }
        runningServers.delete(key);
      }
      return createJobResult(ctx, summary, `Started and stopped ${parsed.script} at ${url}.`, logs, [url]);
    }
    return { ok: true, summary, previewUrl: url, artifacts: [url], logs, errors: [] };
  }
};

const stopLocalServerTool: ToolModule = {
  definition: {
    name: "stop_local_server",
    description: "Stop a running local server started by open_local_server.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", minimum: 1024, maximum: 65535 },
        host: { type: "string", default: "127.0.0.1" },
        all: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  enabledByDefault: false,
  schema: stopLocalServerSchema,
  handler: async (input, ctx) => {
    const parsed = input as z.infer<typeof stopLocalServerSchema>;
    const targets: [string, ServerSession][] = parsed.all
      ? Array.from(runningServers.entries())
      : parsed.port === undefined
        ? []
        : runningServers.has(keyForServer(parsed.host, parsed.port))
          ? [[keyForServer(parsed.host, parsed.port), runningServers.get(keyForServer(parsed.host, parsed.port))!]]
          : [];
    if (targets.length === 0) {
      return {
        ok: false,
        summary: parsed.all ? "No tracked local server to stop." : `No tracked local server found on ${parsed.host}:${parsed.port}.`,
        artifacts: [],
        logs: [],
        errors: ["No matching local server session found."]
      };
    }

    const summaries: string[] = [];
    for (const [key, session] of targets) {
      if (session.exited) {
        runningServers.delete(key);
        summaries.push(`Server ${session.url} already exited with code ${session.exitCode}`);
        continue;
      }
      try {
        session.process.kill("SIGTERM");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to stop server process.";
        runningServers.delete(key);
        throw new Error(message);
      }
      await new Promise<void>((resolve) => {
        if (session.exited) {
          resolve();
          return;
        }
        const done = () => {
          session.exited = true;
          session.process.removeAllListeners("exit");
          resolve();
        };
        session.process.once("exit", done);
        setTimeout(done, 1000);
      });
      runningServers.delete(key);
      summaries.push(`Stopped ${session.url} (script=${session.script}).`);
    }

    return createJobResult(ctx, "Stopped local server(s).", summaries.join(" "), summaries, []);
  }
};

async function checkUrlOnce(url: string, method: "GET" | "HEAD", timeoutMs: number, maxBodyBytes: number, logs: string[]): Promise<{ ok: boolean; status?: number; statusText?: string; message?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { "User-Agent": "Coding-MCP-CheckURL/0.1" }
    });
    const status = response.status;
    const statusText = response.statusText;
    if (method === "GET") {
      const body = await response.text();
      if (body.length > maxBodyBytes) {
        logs.push(`Body preview (truncated): ${trimOutput(body.slice(0, maxBodyBytes))}`);
      } else {
        logs.push(`Body preview: ${trimOutput(body)}`);
      }
    }
    logs.push(`Checked ${url}: ${status} ${statusText}`);
    return { ok: response.ok, status, statusText };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown network error.";
    logs.push(`Checked ${url}: ${message}`);
    return { ok: false, message };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeUntilHealthy(url: string, method: "GET" | "HEAD", timeoutMs: number, checkIntervalMs: number, logs: string[]): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await checkUrlOnce(url, method, Math.min(2000, checkIntervalMs), 2000, logs);
    if (result.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
  }
  logs.push(`Health check timeout after ${timeoutMs}ms: ${url}`);
  return false;
}

export const commandTools: ToolModule[] = [
  ...legacyDelegatedTools(["run_command"]),
  {
    definition: {
      name: "run_typecheck",
      description: "Run npm run typecheck in workspace.",
      inputSchema: { type: "object", properties: { command: { type: "string", enum: ["npm run typecheck"] }, timeoutMs: { type: "number" } }, required: ["command"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: typedRunCommandSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof typedRunCommandSchema>;
      const { stdout, stderr } = await runNpmCommand(ctx.workspaceRoot, parsed.command, parsed.timeoutMs);
      return { ok: true, summary: "Typecheck finished.", artifacts: [], logs: [trimOutput(stdout), trimOutput(stderr)].filter(Boolean), errors: [] };
    }
  },
  {
    definition: {
      name: "run_tests",
      description: "Run npm test in workspace.",
      inputSchema: { type: "object", properties: { command: { type: "string", enum: ["npm test"] }, timeoutMs: { type: "number" } }, required: ["command"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: testsRunCommandSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof testsRunCommandSchema>;
      const { stdout, stderr } = await runNpmCommand(ctx.workspaceRoot, parsed.command, parsed.timeoutMs);
      return { ok: true, summary: "Tests finished.", artifacts: [], logs: [trimOutput(stdout), trimOutput(stderr)].filter(Boolean), errors: [] };
    }
  },
  {
    definition: {
      name: "run_build",
      description: "Run npm run build in workspace.",
      inputSchema: { type: "object", properties: { command: { type: "string", enum: ["npm run build"] }, timeoutMs: { type: "number" } }, required: ["command"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: buildRunCommandSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof buildRunCommandSchema>;
      const { stdout, stderr } = await runNpmCommand(ctx.workspaceRoot, parsed.command, parsed.timeoutMs);
      return { ok: true, summary: "Build finished.", artifacts: [], logs: [trimOutput(stdout), trimOutput(stderr)].filter(Boolean), errors: [] };
    }
  },
  {
    definition: {
      name: "run_lint",
      description: "Run npm run lint in workspace.",
      inputSchema: { type: "object", properties: { command: { type: "string", enum: ["npm run lint"] }, timeoutMs: { type: "number" } }, required: ["command"], additionalProperties: false }
    },
    enabledByDefault: false,
    schema: lintRunCommandSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof lintRunCommandSchema>;
      const { stdout, stderr } = await runNpmCommand(ctx.workspaceRoot, parsed.command, parsed.timeoutMs);
      return { ok: true, summary: "Lint finished.", artifacts: [], logs: [trimOutput(stdout), trimOutput(stderr)].filter(Boolean), errors: [] };
    }
  },
  {
    definition: {
      name: "run_format_check",
      description: "Run npm run format -- --check in workspace.",
      inputSchema: { type: "object", properties: { command: { type: "string", enum: ["npm run format -- --check"] }, timeoutMs: { type: "number" } }, required: ["command"], additionalProperties: false }
    },
    enabledByDefault: false,
    schema: formatCheckRunCommandSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof formatCheckRunCommandSchema>;
      const { stdout, stderr } = await runNpmCommand(ctx.workspaceRoot, parsed.command, parsed.timeoutMs);
      return { ok: true, summary: "Format check finished.", artifacts: [], logs: [trimOutput(stdout), trimOutput(stderr)].filter(Boolean), errors: [] };
    }
  },
  {
    definition: {
      name: "run_format_write",
      description: "Run npm run format in workspace.",
      inputSchema: { type: "object", properties: { command: { type: "string", enum: ["npm run format"] }, timeoutMs: { type: "number" } }, required: ["command"], additionalProperties: false }
    },
    enabledByDefault: false,
    schema: formatWriteRunCommandSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof formatWriteRunCommandSchema>;
      const { stdout, stderr } = await runNpmCommand(ctx.workspaceRoot, parsed.command, parsed.timeoutMs);
      return { ok: true, summary: "Format write finished.", artifacts: [], logs: [trimOutput(stdout), trimOutput(stderr)].filter(Boolean), errors: [] };
    }
  },
  {
    definition: {
      name: "diagnostic_bundle",
      description: "Run lint, typecheck, and tests in sequence.",
      inputSchema: { type: "object", properties: { command: { type: "string", enum: ["diagnostic_bundle"] }, timeoutMs: { type: "number" } }, required: ["command"], additionalProperties: false }
    },
    enabledByDefault: false,
    schema: diagnosticBundleRunCommandSchema,
    handler: async (_input, ctx) => {
      const parsed = _input as z.infer<typeof diagnosticBundleRunCommandSchema>;
      const logs: string[] = [];
      const steps: Array<{ command: NpmCommand; step: string }> = [
        { step: "lint", command: "npm run lint" },
        { step: "typecheck", command: "npm run typecheck" },
        { step: "tests", command: "npm test" }
      ];
      const failures: string[] = [];

      for (const { step, command } of steps) {
        const ok = await runNpmCommandSafe(ctx.workspaceRoot, command, step, parsed.timeoutMs, logs);
        if (!ok) {
          failures.push(step);
          break;
        }
      }

      if (failures.length === 0) {
        return { ok: true, summary: "diagnostic_bundle passed.", artifacts: [], logs, errors: [] };
      }
      return { ok: false, summary: `diagnostic_bundle failed at: ${failures.join(", ")}`, artifacts: [], logs, errors: failures };
    }
  },
  {
    definition: {
      name: "diagnostic_bundle_full",
      description: "Run lint, typecheck, and tests and collect all results in one run.",
      inputSchema: { type: "object", properties: { command: { type: "string", enum: ["diagnostic_bundle_full"] }, timeoutMs: { type: "number" } }, required: ["command"], additionalProperties: false }
    },
    enabledByDefault: false,
    schema: diagnosticBundleFullRunCommandSchema,
    handler: async (_input, ctx) => {
      const parsed = _input as z.infer<typeof diagnosticBundleFullRunCommandSchema>;
      const logs: string[] = [];
      const steps: Array<{ command: NpmCommand; step: string }> = [
        { step: "lint", command: "npm run lint" },
        { step: "typecheck", command: "npm run typecheck" },
        { step: "tests", command: "npm test" }
      ];
      const failures: string[] = [];

      for (const { step, command } of steps) {
        const ok = await runNpmCommandSafe(ctx.workspaceRoot, command, step, parsed.timeoutMs, logs);
        if (!ok) failures.push(step);
      }

      if (failures.length === 0) {
        return { ok: true, summary: "diagnostic_bundle_full passed.", artifacts: [], logs, errors: [] };
      }
      return { ok: false, summary: `diagnostic_bundle_full failed: ${failures.join(", ")}`, artifacts: [], logs, errors: failures };
    }
  },
  {
    definition: {
      name: "check_url",
      description: "Validate URL accessibility and return HTTP status with response preview.",
      inputSchema: { type: "object", properties: { url: { type: "string" }, method: { type: "string", enum: ["GET", "HEAD"] }, timeoutMs: { type: "number" }, maxBodyBytes: { type: "number" } }, required: ["url"], additionalProperties: false }
    },
    enabledByDefault: false,
    schema: checkUrlSchema,
    handler: checkUrlTool.handler
  },
  {
    definition: {
      name: "open_local_server",
      description: "Start a local dev or start server in workspace for page preview.",
      inputSchema: { type: "object", properties: { script: { type: "string", enum: ["dev", "start"] }, port: { type: "number" }, host: { type: "string" }, cwd: { type: "string" }, keepAlive: { type: "boolean" } }, additionalProperties: false }
    },
    enabledByDefault: false,
    schema: openLocalServerSchema,
    handler: openLocalServerTool.handler
  },
  {
    definition: {
      name: "stop_local_server",
      description: "Stop a tracked local server.",
      inputSchema: { type: "object", properties: { port: { type: "number" }, host: { type: "string" }, all: { type: "boolean" } }, additionalProperties: false }
    },
    enabledByDefault: false,
    schema: stopLocalServerSchema,
    handler: stopLocalServerTool.handler
  },
  {
    definition: {
      name: "open_local_server_and_check",
      description: "Start local server and probe a URL path until healthy.",
      inputSchema: {
        type: "object",
        properties: {
          script: { type: "string", enum: ["dev", "start"] },
          port: { type: "number" },
          host: { type: "string" },
          cwd: { type: "string" },
          path: { type: "string" },
          method: { type: "string", enum: ["GET", "HEAD"] },
          checkTimeoutMs: { type: "number" },
          checkIntervalMs: { type: "number" },
          closeAfterCheck: { type: "boolean" }
        },
        additionalProperties: false
      }
    },
    enabledByDefault: false,
    schema: openLocalServerAndCheckSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof openLocalServerAndCheckSchema>;
      const key = keyForServer(parsed.host, parsed.port);
      if (runningServers.has(key)) {
        const existing = runningServers.get(key)!;
        if (!existing.exited) {
          const probeLogs: string[] = [];
          const alive = await checkUrlOnce(existing.url, "HEAD", 1000, 1024, probeLogs);
          if (alive.ok) {
            return { ok: false, summary: `Server already running on ${existing.url}.`, artifacts: [existing.url], logs: [...existing.logs, ...probeLogs], errors: ["Port already occupied by a tracked MCP server session."] };
          }
          runningServers.delete(key);
        }
      }

      const normalizedPath = parsed.path.startsWith("/") ? parsed.path : `/${parsed.path}`;
      const startInput = openLocalServerSchema.parse({
        script: parsed.script,
        port: parsed.port,
        host: parsed.host,
        cwd: parsed.cwd,
        keepAlive: !parsed.closeAfterCheck
      });
      const openResult = await openLocalServerTool.handler(startInput, ctx);
      if (!openResult.ok) return openResult;

      const url = `http://${parsed.host}:${parsed.port}${normalizedPath}`;
      const logs = [...openResult.logs];
      const healthy = await probeUntilHealthy(url, parsed.method, parsed.checkTimeoutMs, parsed.checkIntervalMs, logs);
      if (parsed.closeAfterCheck) {
        await stopLocalServerTool.handler({ port: parsed.port, host: parsed.host, all: false }, ctx);
      }

      if (healthy) {
        return { ok: true, summary: `Server and health check passed at ${url}.`, artifacts: [url], logs, errors: [] };
      }
      return { ok: false, summary: `Health check failed for ${url}.`, artifacts: [url], logs, errors: ["Health check failed or timed out."] };
    }
  },
  ...[]
];
