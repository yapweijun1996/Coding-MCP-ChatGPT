import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolModule } from "../types.js";
import { ensureUnderWorkspace, sanitizeSecretLikeValue, trimLogLines, trimStructuredContent } from "./agent-tool-utils.js";
import { childEnv, gitChildEnv } from "../child-env.js";

const execFileAsync = promisify(execFile);

type CommandInput = {
  file: string;
  args: string[];
  allowExtraArgs: boolean;
};

const ALLOWED_COMMANDS: Record<string, CommandInput> = {
  "npm run build": { file: "npm", args: ["run", "build"], allowExtraArgs: true },
  "npm run test": { file: "npm", args: ["run", "test"], allowExtraArgs: true },
  "npm run typecheck": { file: "npm", args: ["run", "typecheck"], allowExtraArgs: true },
  "npm run lint": { file: "npm", args: ["run", "lint"], allowExtraArgs: true },
  "npm run format -- --check": { file: "npm", args: ["run", "format", "--", "--check"], allowExtraArgs: false },
  "npm test": { file: "npm", args: ["test"], allowExtraArgs: true }
};

const repoSummarySchema = z.object({
  projectRoot: z.string().min(1).max(240).optional(),
  includeWorkspaceRootScan: z.boolean().optional().default(false)
});

const testFailureDigestSchema = z.object({
  command: z.string().min(1).max(120),
  args: z.array(z.string().min(1).max(160)).max(24).optional().default([]),
  timeoutMs: z.number().int().min(200).max(300000).optional().default(120000),
  maxStackLines: z.number().int().min(5).max(260).optional().default(60),
  workspaceRoot: z.string().min(1).max(220).optional()
});

const changedFilesSchema = z.object({
  baseRef: z.string().min(1).max(120).optional(),
  targetRef: z.string().min(1).max(120).optional(),
  maxFiles: z.number().int().min(1).max(500).optional().default(200),
  includeDiffSummary: z.boolean().optional().default(true)
});

const refactorHintsSchema = z.object({
  projectRoot: z.string().min(1).max(240).optional(),
  maxFiles: z.number().int().min(1).max(100).optional().default(25),
  lineThreshold: z.number().int().min(100).max(10000).optional().default(1000),
  byteThreshold: z.number().int().min(4096).max(1024 * 1024).optional().default(40 * 1024),
  maxReadableBytes: z.number().int().min(4096).max(5 * 1024 * 1024).optional().default(1024 * 1024),
  includeExtensions: z.array(z.string().min(2).max(16)).max(40).optional().default([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".css",
    ".html",
    ".md",
    ".json"
  ]),
  excludeDirs: z.array(z.string().min(1).max(80)).max(40).optional().default([
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    ".cache"
  ])
});

function readJson<T>(filePath: string): Promise<T | undefined> {
  return fs.readFile(filePath, "utf8")
    .then((raw) => {
      try {
        const parsed = JSON.parse(raw);
        return (typeof parsed === "object" && parsed !== null ? parsed : undefined) as T;
      } catch {
        return undefined;
      }
    })
    .catch(() => undefined);
}

function inferFrameworkSignals(pkg: Record<string, unknown> | undefined): string[] {
  if (!pkg) return [];
  const dependencies = {
    ...(pkg.dependencies as Record<string, unknown>),
    ...(pkg.devDependencies as Record<string, unknown>)
  };
  const names = Object.keys(dependencies ?? {});
  const includes = (name: string) => names.includes(name);
  const signals: string[] = [];
  if (includes("react")) signals.push("React");
  if (includes("next")) signals.push("Next.js");
  if (includes("vite")) signals.push("Vite");
  if (includes("webpack")) signals.push("Webpack");
  if (includes("playwright")) signals.push("Playwright");
  if (includes("vitest")) signals.push("Vitest");
  if (includes("jest")) signals.push("Jest");
  if (includes("typescript")) signals.push("TypeScript");
  if (includes("tailwindcss")) signals.push("Tailwind CSS");
  return signals;
}

function extractCommand(pkg: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!pkg || typeof pkg.scripts !== "object" || pkg.scripts === null) return undefined;
  const scripts = pkg.scripts as Record<string, unknown>;
  const value = scripts[key];
  return typeof value === "string" ? value : undefined;
}

async function inferProjectFiles(root: string, include: boolean): Promise<Array<{ path: string; exists: boolean }>> {
  const candidates = [
    "README.md",
    "AGENTS.md",
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
    "vite.config.js",
    "next.config.ts",
    "next.config.js",
    "playwright.config.ts",
    "playwright.config.js"
  ];
  if (!include) return candidates.map((item) => ({ path: item, exists: false }));
  return Promise.all(candidates.map(async (item) => {
    const absolute = path.join(root, item);
    try {
      await fs.access(absolute);
      return { path: item, exists: true };
    } catch {
      return { path: item, exists: false };
    }
  }));
}

function extractFilesFromOutput(raw: string): string[] {
  const fileMatch = /[A-Za-z0-9._\/-]+\.[A-Za-z0-9]+:\d+/g;
  const candidate = raw.match(fileMatch) ?? [];
  const byName = new Map<string, true>();
  for (const entry of candidate) {
    byName.set(entry.split(":")[0], true);
  }
  return Array.from(byName.keys()).slice(0, 40);
}

function extractStack(raw: string, maxLines: number): string[] {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const selected = lines.filter((line) => /at\s/.test(line) || /\(.*:\d+:\d+\)/.test(line) || /Error/.test(line));
  if (selected.length > 0) return selected.slice(0, maxLines);
  return lines.slice(0, maxLines);
}

function parseExitCode(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

function parseGitStatus(output: string): Array<{ path: string; status: string }> {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim() || "M", path: line.replace(/^[MADRCU!?* ]+\s*/u, "").trim() }))
    .filter((entry) => entry.path);
}

async function collectRefactorHintFiles(root: string, options: z.infer<typeof refactorHintsSchema>) {
  const extensions = new Set(options.includeExtensions.map((ext) => ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`));
  const excludeDirs = new Set(options.excludeDirs);
  const files: Array<{ absolutePath: string; relativePath: string; bytes: number }> = [];
  const pending = [root];

  while (pending.length > 0 && files.length < options.maxFiles * 50) {
    const current = pending.pop();
    if (!current) continue;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(root, absolutePath);
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name)) pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;
      const stats = await fs.stat(absolutePath).catch(() => undefined);
      if (!stats) continue;
      files.push({ absolutePath, relativePath, bytes: stats.size });
    }
  }

  return files;
}

function detectRefactorSignals(content: string, relativePath: string): string[] {
  const signals: string[] = [];
  const importCount = (content.match(/^\s*import\s.+from\s/mg) ?? []).length;
  const exportCount = (content.match(/^\s*export\s/mg) ?? []).length;
  const functionCount = (content.match(/\b(function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|=>\s*\{)/g) ?? []).length;
  const classCount = (content.match(/\bclass\s+\w+/g) ?? []).length;
  const responsibilities = [
    /<[A-Z][A-Za-z0-9]*(\s|>)/.test(content) || /\bReact\b|useState\(|useEffect\(/.test(content) ? "ui" : "",
    /\b(fetch|axios|XMLHttpRequest)\b/.test(content) ? "network" : "",
    /\b(fs\.|readFile|writeFile|readdir|stat\()/.test(content) ? "filesystem" : "",
    /\b(exec|spawn|execFile|child_process)\b/.test(content) ? "process" : "",
    /\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(content) ? "database" : "",
    /\bprocess\.env\b/.test(content) ? "configuration" : ""
  ].filter(Boolean);

  if (importCount >= 20) signals.push(`many imports (${importCount})`);
  if (exportCount >= 20) signals.push(`many exports (${exportCount})`);
  if (functionCount + classCount >= 25) signals.push(`many declarations (${functionCount + classCount})`);
  if (responsibilities.length >= 3) signals.push(`mixed responsibilities (${responsibilities.join(", ")})`);
  if ((content.match(/\bTODO\b|\bFIXME\b|\bhack\b/gi) ?? []).length >= 5) signals.push("many maintenance comments");
  if (/index\.(ts|tsx|js|jsx)$/u.test(relativePath) && exportCount >= 15) signals.push("barrel file may hide module ownership");

  return signals;
}

async function analyzeRefactorHintFile(file: { absolutePath: string; relativePath: string; bytes: number }, options: z.infer<typeof refactorHintsSchema>) {
  const oversizedByBytes = file.bytes >= options.byteThreshold;
  if (file.bytes > options.maxReadableBytes && !oversizedByBytes) return undefined;
  const content = file.bytes <= options.maxReadableBytes ? await fs.readFile(file.absolutePath, "utf8").catch(() => "") : "";
  const lines = content ? content.split(/\r?\n/).length : undefined;
  const oversizedByLines = typeof lines === "number" && lines >= options.lineThreshold;
  const signals = content ? detectRefactorSignals(content, file.relativePath) : [];
  if (!oversizedByBytes && !oversizedByLines && signals.length === 0) return undefined;

  const reasons = [
    oversizedByLines ? `line count is ${lines}, threshold is ${options.lineThreshold}` : "",
    oversizedByBytes ? `file size is ${file.bytes} bytes, threshold is ${options.byteThreshold}` : "",
    ...signals
  ].filter(Boolean);
  const score = (oversizedByLines ? 3 : 0) + (oversizedByBytes ? 2 : 0) + signals.length;

  return {
    path: file.relativePath,
    bytes: file.bytes,
    lines,
    score,
    reasons,
    recommendation: "Consider a behavior-preserving refactor into smaller owned modules before adding more feature work.",
    suggestedValidation: [
      "Map current public exports and callers before moving code.",
      "Extract one responsibility at a time.",
      "Run the smallest relevant typecheck/test/build check after each pass."
    ]
  };
}

export const codeIntelligenceTools: ToolModule[] = [
  {
    definition: {
      name: "repo_summary",
      description: "Summarize package metadata, scripts, framework signals, and inferred command profile.",
      inputSchema: {
        type: "object",
        properties: {
          projectRoot: { type: "string" },
          includeWorkspaceRootScan: { type: "boolean" }
        },
        required: [],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: repoSummarySchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof repoSummarySchema>;
      const root = ensureUnderWorkspace(ctx.workspaceRoot, parsed.projectRoot ?? ".");
      const packageJson = await readJson<Record<string, unknown>>(path.join(root, "package.json"));
      const scripts = (packageJson?.scripts && typeof packageJson.scripts === "object" && !Array.isArray(packageJson.scripts))
        ? packageJson.scripts as Record<string, unknown>
        : {};
      const result = {
        root,
        packageManager: typeof packageJson?.packageManager === "string" ? packageJson.packageManager : "npm",
        engines: packageJson?.engines ?? {},
        scripts: Object.fromEntries(Object.entries(scripts).slice(0, 80)),
        frameworkSignals: inferFrameworkSignals(packageJson),
        commandHints: {
          test: extractCommand(packageJson, "test") ?? "npm run test",
          build: extractCommand(packageJson, "build") ?? "npm run build",
          typecheck: extractCommand(packageJson, "typecheck") ?? "npm run typecheck",
          lint: extractCommand(packageJson, "lint") ?? "npm run lint"
        },
        packageJsonFound: Boolean(packageJson),
        workspaceSignalFiles: await inferProjectFiles(root, parsed.includeWorkspaceRootScan)
      };
      return {
        ok: true,
        summary: `repo_summary built summary for ${path.basename(root)}`,
        jobId: root,
        artifacts: [],
        logs: trimLogLines([`root=${root}`, `signals=${result.frameworkSignals.join(",") || "none"}`, `scripts=${Object.keys(result.scripts).length}`]),
        structuredContent: trimStructuredContent(sanitizeSecretLikeValue(result) as Record<string, unknown>),
        errors: []
      };
    }
  },
  {
    definition: {
      name: "test_failure_digest",
      description: "Execute an allow-listed command and extract failure files, exit code, and stack highlights.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          timeoutMs: { type: "number" },
          maxStackLines: { type: "number" },
          workspaceRoot: { type: "string" }
        },
        required: ["command"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: testFailureDigestSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof testFailureDigestSchema>;
      const allowed = ALLOWED_COMMANDS[parsed.command];
      if (!allowed) {
        return {
          ok: false,
          summary: `Command not allowed: ${parsed.command}`,
          jobId: parsed.command,
          artifacts: [],
          logs: [`command=${parsed.command}`],
          structuredContent: trimStructuredContent({
            command: parsed.command,
            allowlist: Object.keys(ALLOWED_COMMANDS)
          }),
          errors: ["Command is not in allowlist."]
        };
      }
      if (!allowed.allowExtraArgs && parsed.args.length > 0) {
        return {
          ok: false,
          summary: "Extra args are not allowed for this command.",
          jobId: parsed.command,
          artifacts: [],
          logs: ["args provided but not allowed"],
          structuredContent: trimStructuredContent({ command: parsed.command, args: parsed.args }),
          errors: ["Extra args blocked by allowlist policy."]
        };
      }
      const root = ensureUnderWorkspace(ctx.workspaceRoot, parsed.workspaceRoot ?? ".");
      const args = [...allowed.args, ...parsed.args];
      const logLines: string[] = [];
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      const startAt = Date.now();
      try {
        const result = await execFileAsync(allowed.file, args, { cwd: root, timeout: parsed.timeoutMs, env: childEnv() });
        stdout = result.stdout?.toString() ?? "";
        stderr = result.stderr?.toString() ?? "";
        logLines.push(`command=success`);
      } catch (error) {
        const err = error as Error & { stdout?: unknown; stderr?: unknown; code?: number };
        stdout = (err.stdout?.toString?.() ?? "") as string;
        stderr = (err.stderr?.toString?.() ?? "") as string;
        exitCode = parseExitCode(err.code, 1);
        logLines.push(`command=failed`, `exitCode=${exitCode}`);
      }
      const combined = `${stdout}\n${stderr}`.trim();
      const failedFiles = extractFilesFromOutput(combined);
      const topStack = extractStack(combined, parsed.maxStackLines);
      const summary = {
        command: `${allowed.file} ${args.join(" ")}`,
        workspaceRoot: root,
        exitCode,
        elapsedMs: Date.now() - startAt,
        failedFiles,
        topStack
      };
      return {
        ok: exitCode === 0,
        summary: exitCode === 0 ? `test_failure_digest succeeded: ${parsed.command}` : `test_failure_digest reported failure for ${parsed.command}`,
        jobId: parsed.command,
        artifacts: [],
        logs: trimLogLines([`command=${parsed.command}`, `exitCode=${exitCode}`, `failedFiles=${failedFiles.length}`, `stackLines=${topStack.length}`]),
        structuredContent: trimStructuredContent(sanitizeSecretLikeValue(summary) as Record<string, unknown>),
        errors: exitCode === 0 ? [] : ["command failed"]
      };
    }
  },
  {
    definition: {
      name: "refactor_hints",
      description: "Scan workspace files and return advisory hints for oversized or mixed-responsibility modules that may need refactoring.",
      inputSchema: {
        type: "object",
        properties: {
          projectRoot: { type: "string" },
          maxFiles: { type: "number" },
          lineThreshold: { type: "number" },
          byteThreshold: { type: "number" },
          maxReadableBytes: { type: "number" },
          includeExtensions: { type: "array", items: { type: "string" } },
          excludeDirs: { type: "array", items: { type: "string" } }
        },
        required: [],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: refactorHintsSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof refactorHintsSchema>;
      const root = ensureUnderWorkspace(ctx.workspaceRoot, parsed.projectRoot ?? ".");
      const files = await collectRefactorHintFiles(root, parsed);
      const analyzed = await Promise.all(files.map((file) => analyzeRefactorHintFile(file, parsed)));
      const candidates = analyzed
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .sort((a, b) => b.score - a.score || b.bytes - a.bytes)
        .slice(0, parsed.maxFiles);
      const result = {
        root,
        policy: {
          advisoryOnly: true,
          lineThreshold: parsed.lineThreshold,
          byteThreshold: parsed.byteThreshold,
          instruction: "Use these hints to recommend refactor candidates. Do not split files automatically unless the user explicitly asks for implementation."
        },
        scannedFiles: files.length,
        candidateCount: candidates.length,
        candidates,
        agentTips: [
          "Prioritize files with both size and mixed-responsibility signals.",
          "Prefer small reviewable refactor passes that preserve public behavior.",
          "Before editing, identify callers, public exports, and the validation command that proves behavior stayed stable."
        ]
      };
      return {
        ok: true,
        summary: `refactor_hints found ${candidates.length} candidate file(s).`,
        jobId: root,
        artifacts: [],
        logs: trimLogLines([`root=${root}`, `scannedFiles=${files.length}`, `candidates=${candidates.length}`]),
        structuredContent: trimStructuredContent(sanitizeSecretLikeValue(result) as Record<string, unknown>),
        errors: []
      };
    }
  },
  {
    definition: {
      name: "changed_files_context",
      description: "Collect git status/diff context and summarize changed files for review decisions.",
      inputSchema: {
        type: "object",
        properties: {
          baseRef: { type: "string" },
          targetRef: { type: "string" },
          maxFiles: { type: "number" },
          includeDiffSummary: { type: "boolean" }
        },
        required: [],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: changedFilesSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof changedFilesSchema>;
      const root = ensureUnderWorkspace(ctx.workspaceRoot, ".");
      const outputStatus = await execFileAsync("git", ["status", "--short"], { cwd: root, env: gitChildEnv() })
        .then((result) => result.stdout.toString())
        .catch((error) => (error as Error & { stdout?: unknown }).stdout?.toString?.() ?? "");
      const changedStatus = parseGitStatus(outputStatus);
      const includeDiff = Boolean(parsed.baseRef && parsed.targetRef);
      const base = parsed.baseRef?.trim() || "";
      const target = parsed.targetRef?.trim() || "";
      const diffArgs = includeDiff ? ["diff", `${base}..${target}`, "--name-status"] : ["diff", "--name-status"];
      const outputDiff = includeDiff
        ? await execFileAsync("git", diffArgs, { cwd: root, env: gitChildEnv() }).then((result) => result.stdout.toString()).catch(() => "")
        : "";
      const diffItems = outputDiff
        ? outputDiff
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [status, file] = line.split(/\s+/, 2);
            return { file: file || "", status: status || "M" };
          })
          .filter((entry) => entry.file)
        : [];
      const statusCount: Record<string, number> = {};
      const touched = new Map<string, string[]>();
      for (const entry of [...changedStatus, ...diffItems]) {
        const entryPath = "file" in entry ? entry.file : entry.path;
        if (!entryPath || entryPath.includes("->")) continue;
        touched.set(entryPath, touched.get(entryPath) || []);
        touched.get(entryPath)?.push(entry.status);
        statusCount[entry.status] = (statusCount[entry.status] ?? 0) + 1;
      }
      const changedFiles = [...touched.keys()].slice(0, parsed.maxFiles);
      const summary = {
        changedFiles,
        statusCount,
        total: changedFiles.length,
        gitBase: base || "working-tree",
        gitTarget: target || "working-tree",
        diffSummary: includeDiff && parsed.includeDiffSummary
          ? outputDiff.trim().split(/\r?\n/).slice(0, 30)
          : []
      };
      return {
        ok: true,
        summary: `changed_files_context found ${changedFiles.length} changed file(s).`,
        jobId: base || target || "working-tree",
        artifacts: [],
        logs: trimLogLines([`files=${changedFiles.length}`, `statusGroups=${Object.entries(statusCount).length}`]),
        structuredContent: trimStructuredContent({
          ...(sanitizeSecretLikeValue(summary) as Record<string, unknown>),
          recommendations: [
            "Review changed files in priority order",
            "Start from recently added/removed files first",
            `maxFiles=${parsed.maxFiles}`
          ],
          includeDiffSummary: parsed.includeDiffSummary
        }) as Record<string, unknown>,
        errors: []
      };
    }
  }
];
