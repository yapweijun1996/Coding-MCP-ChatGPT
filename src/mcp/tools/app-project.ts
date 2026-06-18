import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  appendProjectTaskHistory,
  clearProjectFiles,
  createProject,
  getProject,
  getProjectManifest,
  getProjectWorkspaceDirectory,
  publishProject,
  validateProject,
  writeProjectAsset,
  writeProjectFile
} from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const execFileAsync = promisify(execFile);
const maxLogBytes = 40000;
const maxWorkspaceTextBytes = 1024 * 1024;
const defaultNpmTimeoutMs = 300000;
const defaultDevPort = 5173;
const allowedWorkspaceExtensions = new Set([".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".json", ".webmanifest", ".md", ".txt", ".svg", ".vue"]);
const textDistExtensions = new Set([".html", ".css", ".js", ".json", ".webmanifest", ".txt", ".md", ".svg"]);
const assetDistExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

type AppTemplate = "vite-react" | "vite-vue" | "vite-vanilla";

interface DevSession {
  process: ChildProcess;
  projectId: string;
  url: string;
  startedAt: string;
  logs: string[];
  exited: boolean;
  exitCode: number | null;
}

const devSessions = new Map<string, DevSession>();

const createAppProjectInputSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().max(2000).optional().default(""),
  template: z.enum(["vite-react", "vite-vue", "vite-vanilla"]).default("vite-react")
});

const projectIdInputSchema = z.object({
  projectId: z.string().min(8).max(80)
});

const workspaceFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  content: z.string().max(maxWorkspaceTextBytes)
});

const readWorkspaceFileInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  relativePath: z.string().min(1).max(240),
  maxBytes: z.number().int().min(1).max(maxWorkspaceTextBytes).default(65536)
});

const npmLifecycleInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  timeoutMs: z.number().int().min(1000).max(900000).default(defaultNpmTimeoutMs)
});

const runProjectDevInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  host: z.string().min(1).max(128).default("127.0.0.1"),
  port: z.number().int().min(1024).max(65535).default(defaultDevPort),
  keepAlive: z.boolean().default(true)
});

const stopProjectDevInputSchema = z.object({
  projectId: z.string().min(8).max(80)
});

const publishProjectDistInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  outputDir: z.string().min(1).max(80).default("dist"),
  entryFile: z.string().min(1).max(240).default("index.html")
});

function trimOutput(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= maxLogBytes) return normalized;
  return `${normalized.slice(0, maxLogBytes)}... [truncated]`;
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function assertSafeWorkspacePath(relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error("Absolute or empty app project paths are not allowed.");
  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("App project path must include a filename.");
  if (parts.some((part) => part === ".." || part.startsWith("."))) throw new Error("Parent traversal and hidden path segments are not allowed.");
  const extension = path.extname(parts.at(-1) ?? "").toLowerCase();
  if (!allowedWorkspaceExtensions.has(extension)) throw new Error(`Unsupported app project file extension: ${extension || "(none)"}.`);
  return parts.join("/");
}

function assertSafeOutputDir(outputDir: string): string {
  if (!outputDir || path.isAbsolute(outputDir)) throw new Error("Absolute or empty outputDir is not allowed.");
  const normalized = outputDir.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("outputDir must include a directory name.");
  if (parts.some((part) => part === ".." || part.startsWith("."))) throw new Error("Parent traversal and hidden outputDir segments are not allowed.");
  return parts.join("/");
}

function resolveWorkspaceFile(projectRoot: string, projectId: string, relativePath: string): { safePath: string; absolutePath: string } {
  const safePath = assertSafeWorkspacePath(relativePath);
  const workspaceRoot = getProjectWorkspaceDirectory(projectRoot, projectId);
  const absolutePath = path.resolve(workspaceRoot, safePath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (absolutePath !== normalizedRoot && !absolutePath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Resolved app project path is outside the workspace.");
  }
  return { safePath, absolutePath };
}

function templateFiles(template: AppTemplate, title: string): Array<{ path: string; content: string }> {
  const safeTitle = title.replace(/"/g, '\\"');
  if (template === "vite-vue") {
    return [
      { path: "package.json", content: `${JSON.stringify({ scripts: { dev: "vite", build: "vite build", preview: "vite preview" }, dependencies: { "@vitejs/plugin-vue": "^6.0.0", vite: "^7.0.0", vue: "^3.5.0" }, devDependencies: {} }, null, 2)}\n` },
      { path: "index.html", content: `<div id="app"></div><script type="module" src="/src/main.js"></script>\n` },
      { path: "src/main.js", content: `import { createApp } from "vue";\nimport "./style.css";\n\ncreateApp({\n  template: '<main><h1>${safeTitle}</h1><p>Your Vue demo is ready.</p></main>'\n}).mount("#app");\n` },
      { path: "src/style.css", content: baseCss() }
    ];
  }
  if (template === "vite-vanilla") {
    return [
      { path: "package.json", content: `${JSON.stringify({ scripts: { dev: "vite", build: "vite build", preview: "vite preview" }, dependencies: { vite: "^7.0.0" }, devDependencies: {} }, null, 2)}\n` },
      { path: "index.html", content: `<div id="app"></div><script type="module" src="/src/main.js"></script>\n` },
      { path: "src/main.js", content: `import "./style.css";\n\ndocument.querySelector("#app").innerHTML = '<main><h1>${safeTitle}</h1><p>Your Vite demo is ready.</p></main>';\n` },
      { path: "src/style.css", content: baseCss() }
    ];
  }
  return [
    { path: "package.json", content: `${JSON.stringify({ scripts: { dev: "vite", build: "vite build", preview: "vite preview" }, dependencies: { "@vitejs/plugin-react": "^5.0.0", vite: "^7.0.0", react: "^19.0.0", "react-dom": "^19.0.0" }, devDependencies: {} }, null, 2)}\n` },
    { path: "index.html", content: `<div id="root"></div><script type="module" src="/src/main.jsx"></script>\n` },
    { path: "src/main.jsx", content: `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport "./style.css";\n\nfunction App() {\n  return <main><h1>${safeTitle}</h1><p>Your React demo is ready.</p></main>;\n}\n\ncreateRoot(document.getElementById("root")).render(<App />);\n` },
    { path: "src/style.css", content: baseCss() }
  ];
}

function baseCss(): string {
  return `body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, sans-serif; background: #eef3f1; color: #17231f; }\nmain { width: min(720px, calc(100vw - 32px)); }\nh1 { font-size: 44px; line-height: 1.05; margin: 0 0 14px; }\np { font-size: 18px; color: #52605a; }\n`;
}

async function writeWorkspaceFile(projectRoot: string, projectId: string, relativePath: string, content: string): Promise<{ path: string; size: number; modifiedAt: string }> {
  if (Buffer.byteLength(content, "utf8") > maxWorkspaceTextBytes) throw new Error("App project file content exceeds 1 MiB.");
  const project = await getProject(projectRoot, projectId);
  if (project.status === "deleted") throw new Error("Cannot write to a deleted project.");
  const { safePath, absolutePath } = resolveWorkspaceFile(projectRoot, projectId, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  const fileStat = await stat(absolutePath);
  return { path: safePath, size: fileStat.size, modifiedAt: fileStat.mtime.toISOString() };
}

async function runNpm(projectRoot: string, projectId: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const cwd = getProjectWorkspaceDirectory(projectRoot, projectId);
  return execFileAsync(npmExecutable(), args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 });
}

async function listDistFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        output.push(path.relative(root, absolutePath).replaceAll("\\", "/"));
      }
    }
  }
  await walk(root);
  return output.sort();
}

function appendDevLog(session: DevSession, chunk: Buffer, stream: "stdout" | "stderr"): void {
  const text = trimOutput(chunk.toString("utf8"));
  if (!text) return;
  session.logs.push(`[${stream}] ${text}`);
  if (session.logs.length > 120) session.logs = session.logs.slice(-120);
}

export const appProjectTools: ToolModule[] = [
  {
    definition: {
      name: "create_app_project",
      description: "Create a Vite app project workspace for idea-to-demo delivery.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          template: { type: "string", enum: ["vite-react", "vite-vue", "vite-vanilla"] }
        },
        required: ["title"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: createAppProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof createAppProjectInputSchema>;
      const project = await createProject(ctx.projectRoot, {
        title: parsed.title,
        summary: parsed.summary,
        entryFile: "index.html",
        createdByClientId: ctx.clientId
      });
      const files = [];
      for (const file of templateFiles(parsed.template, parsed.title)) {
        files.push(await writeWorkspaceFile(ctx.projectRoot, project.id, file.path, file.content));
      }
      await appendProjectTaskHistory(ctx.projectRoot, project.id, {
        toolName: "create_app_project",
        ok: true,
        summary: `Created ${parsed.template} app project ${project.id}.`,
        details: { template: parsed.template, workspaceFiles: files }
      });
      return { ok: true, summary: `Created ${parsed.template} app project ${project.id}.`, jobId: project.id, artifacts: files.map((file) => file.path), structuredContent: { projectId: project.id, template: parsed.template, workspaceFiles: files }, logs: [JSON.stringify({ projectId: project.id, template: parsed.template, workspaceFiles: files }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "write_app_project_file",
      description: "Write a UTF-8 source file inside an app project workspace.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, relativePath: { type: "string" }, content: { type: "string" } }, required: ["projectId", "relativePath", "content"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: workspaceFileInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof workspaceFileInputSchema>;
      const file = await writeWorkspaceFile(ctx.projectRoot, parsed.projectId, parsed.relativePath, parsed.content);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "write_app_project_file", ok: true, summary: `Wrote app source ${file.path}.`, details: file });
      return { ok: true, summary: `Wrote app source ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], logs: [JSON.stringify(file, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "read_app_project_file",
      description: "Read a UTF-8 source file from an app project workspace.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, relativePath: { type: "string" }, maxBytes: { type: "number" } }, required: ["projectId", "relativePath"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: readWorkspaceFileInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof readWorkspaceFileInputSchema>;
      const { safePath, absolutePath } = resolveWorkspaceFile(ctx.projectRoot, parsed.projectId, parsed.relativePath);
      const fileStat = await stat(absolutePath);
      if (fileStat.size > parsed.maxBytes) throw new Error(`App project file is too large to read. Size=${fileStat.size}, maxBytes=${parsed.maxBytes}.`);
      const content = await readFile(absolutePath, "utf8");
      return { ok: true, summary: `Read app source ${safePath}.`, jobId: parsed.projectId, artifacts: [safePath], logs: [content], errors: [] };
    }
  },
  {
    definition: {
      name: "install_project_dependencies",
      description: "Run npm install inside an app project workspace.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, timeoutMs: { type: "number" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: npmLifecycleInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof npmLifecycleInputSchema>;
      const { stdout, stderr } = await runNpm(ctx.projectRoot, parsed.projectId, ["install"], parsed.timeoutMs);
      const logs = [trimOutput(stdout), trimOutput(stderr)].filter(Boolean);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "install_project_dependencies", ok: true, summary: "Installed app project dependencies.", details: { logs } });
      return { ok: true, summary: "Installed app project dependencies.", jobId: parsed.projectId, artifacts: ["workspace/package.json"], logs, errors: [] };
    }
  },
  {
    definition: {
      name: "run_project_build",
      description: "Run npm run build inside an app project workspace.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, timeoutMs: { type: "number" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: npmLifecycleInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof npmLifecycleInputSchema>;
      const { stdout, stderr } = await runNpm(ctx.projectRoot, parsed.projectId, ["run", "build"], parsed.timeoutMs);
      const logs = [trimOutput(stdout), trimOutput(stderr)].filter(Boolean);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "run_project_build", ok: true, summary: "Built app project.", details: { logs } });
      return { ok: true, summary: "Built app project.", jobId: parsed.projectId, artifacts: ["workspace/dist"], logs, errors: [] };
    }
  },
  {
    definition: {
      name: "run_project_dev",
      description: "Start npm run dev for an app project workspace and return a local preview URL.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, host: { type: "string" }, port: { type: "number" }, keepAlive: { type: "boolean" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: false,
    schema: runProjectDevInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof runProjectDevInputSchema>;
      const existing = devSessions.get(parsed.projectId);
      if (existing && !existing.exited) {
        return { ok: true, summary: `Dev server already running at ${existing.url}.`, jobId: parsed.projectId, previewUrl: existing.url, artifacts: [existing.url], logs: existing.logs, errors: [] };
      }
      const cwd = getProjectWorkspaceDirectory(ctx.projectRoot, parsed.projectId);
      const child = spawn(npmExecutable(), ["run", "dev", "--", "--host", parsed.host, "--port", String(parsed.port)], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      const url = `http://${parsed.host}:${parsed.port}`;
      const session: DevSession = { process: child, projectId: parsed.projectId, url, startedAt: new Date().toISOString(), logs: [`Started npm run dev at ${url}.`], exited: false, exitCode: null };
      devSessions.set(parsed.projectId, session);
      child.stdout?.on("data", (chunk: Buffer) => appendDevLog(session, chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => appendDevLog(session, chunk, "stderr"));
      child.on("exit", (code) => {
        session.exited = true;
        session.exitCode = code === null ? 0 : code;
        session.logs.push(`process exited with code ${session.exitCode}`);
      });
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "run_project_dev", ok: true, summary: `Started app dev server at ${url}.`, details: { url, keepAlive: parsed.keepAlive } });
      if (!parsed.keepAlive) {
        setTimeout(() => child.kill("SIGTERM"), 1000);
      }
      return { ok: true, summary: `Started app dev server at ${url}.`, jobId: parsed.projectId, previewUrl: url, artifacts: [url], logs: session.logs, errors: [] };
    }
  },
  {
    definition: {
      name: "stop_project_dev",
      description: "Stop a running app project dev server.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: false,
    schema: stopProjectDevInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof stopProjectDevInputSchema>;
      const session = devSessions.get(parsed.projectId);
      if (!session || session.exited) return { ok: false, summary: "No running dev server for project.", jobId: parsed.projectId, artifacts: [], logs: [], errors: ["No running dev server."] };
      session.process.kill("SIGTERM");
      devSessions.delete(parsed.projectId);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "stop_project_dev", ok: true, summary: `Stopped app dev server at ${session.url}.`, details: { url: session.url } });
      return { ok: true, summary: `Stopped app dev server at ${session.url}.`, jobId: parsed.projectId, artifacts: [session.url], logs: session.logs, errors: [] };
    }
  },
  {
    definition: {
      name: "publish_project_dist",
      description: "Publish a built app project's dist directory to the stable /share project URL.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, outputDir: { type: "string" }, entryFile: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: publishProjectDistInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof publishProjectDistInputSchema>;
      const safeOutputDir = assertSafeOutputDir(parsed.outputDir);
      const workspaceRoot = getProjectWorkspaceDirectory(ctx.projectRoot, parsed.projectId);
      const distRoot = path.resolve(workspaceRoot, safeOutputDir);
      if (distRoot !== workspaceRoot && !distRoot.startsWith(`${path.resolve(workspaceRoot)}${path.sep}`)) throw new Error("Resolved outputDir is outside the app workspace.");
      const distStat = await stat(distRoot);
      if (!distStat.isDirectory()) throw new Error(`Build output is not a directory: ${safeOutputDir}`);
      const files = await listDistFiles(distRoot);
      if (!files.includes(parsed.entryFile)) throw new Error(`Entry file not found in ${safeOutputDir}: ${parsed.entryFile}`);
      await clearProjectFiles(ctx.projectRoot, parsed.projectId);
      const publishedFiles = [];
      for (const file of files) {
        const extension = path.extname(file).toLowerCase();
        const absolutePath = path.join(distRoot, file);
        if (textDistExtensions.has(extension)) {
          publishedFiles.push(await writeProjectFile(ctx.projectRoot, parsed.projectId, file, await readFile(absolutePath, "utf8")));
        } else if (assetDistExtensions.has(extension)) {
          publishedFiles.push(await writeProjectAsset(ctx.projectRoot, parsed.projectId, file, await readFile(absolutePath)));
        } else {
          throw new Error(`Unsupported dist file extension: ${file}`);
        }
      }
      const validation = await validateProject(ctx.projectRoot, parsed.projectId, parsed.entryFile);
      if (!validation.ok) throw new Error(`Published dist validation failed: ${validation.errors.join("; ")}`);
      const project = await publishProject(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, parsed.entryFile);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "publish_project_dist", ok: true, summary: `Published ${safeOutputDir} to ${project.publishedUrl}.`, details: { outputDir: safeOutputDir, entryFile: parsed.entryFile, files: publishedFiles } });
      return { ok: true, summary: `Published app dist at ${project.publishedUrl}.`, jobId: parsed.projectId, previewUrl: project.publishedUrl, shareUrl: project.publishedUrl, artifacts: [project.publishedUrl!, ...publishedFiles.map((file) => file.path)], structuredContent: { projectId: parsed.projectId, outputDir: safeOutputDir, entryFile: parsed.entryFile, publishedUrl: project.publishedUrl, files: publishedFiles, validation }, logs: [JSON.stringify({ publishedUrl: project.publishedUrl, files: publishedFiles, validation }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "get_app_project_report",
      description: "Return app project manifest and latest delivery state.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: projectIdInputSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof projectIdInputSchema>;
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const session = devSessions.get(parsed.projectId);
      return { ok: true, summary: `Loaded app project report for ${parsed.projectId}.`, jobId: parsed.projectId, previewUrl: manifest.publishedUrl ?? session?.url, shareUrl: manifest.publishedUrl, artifacts: manifest.files.map((file) => file.path), structuredContent: { manifest, devServer: session ? { url: session.url, startedAt: session.startedAt, exited: session.exited, exitCode: session.exitCode, logs: session.logs } : undefined }, logs: [JSON.stringify({ manifest, devServer: session }, null, 2)], errors: [] };
    }
  }
];
