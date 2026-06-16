import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolModule } from "../types.js";
import { createShareArtifact } from "../../share/store.js";
import { makeShareUrl } from "../result.js";
import { addResearchNote } from "../../research/store.js";
import { sanitizeSecretLikeValue, trimLogLines, trimStructuredContent, ensureUnderWorkspace } from "./agent-tool-utils.js";

const searchProjectDocsSchema = z.object({
  query: z.string().min(1).max(420),
  roots: z.array(z.string().min(1).max(240)).optional().default([]),
  maxSnippets: z.number().int().min(1).max(120).optional().default(30),
  extensions: z.array(z.string().min(1).max(16)).optional().default(["md", "mdx", "txt", "json"]),
  maxBytesPerSnippet: z.number().int().min(120).max(5000).optional().default(1200)
});

const extractProjectConventionsSchema = z.object({
  paths: z.array(z.string().min(1).max(240)).optional().default([]),
  fileHints: z.array(z.string().min(1).max(120)).optional().default(["README", "AGENTS", "package.json", "docs", "lint", "test", "build", "deploy", "agent", "eslint", "prettier"])
});

const writeAgentNoteSchema = z.object({
  noteType: z.enum(["engineering", "diagnostics", "qa", "decision", "ops", "research", "other"]),
  title: z.string().min(2).max(220),
  content: z.string().min(1).max(50000),
  tags: z.array(z.string().min(1).max(80)).optional().default([]),
  target: z.enum(["artifact", "research"]),
  projectId: z.string().min(1).max(120).optional()
});

type QueryMode = "and" | "or";

function parseQuery(input: string): { mode: QueryMode; groups: string[][] } {
  const normalized = input.trim().toLowerCase();
  const tokensOr = normalized.split(/\\s+or\\s+/i).map((item) => item.trim()).filter(Boolean);
  if (normalized.includes(" or ") && tokensOr.length > 1) {
    return {
      mode: "or",
      groups: tokensOr.map((entry) => entry.split(/\\s+/).filter(Boolean))
    };
  }
  return { mode: "and", groups: [normalized.split(/\\s+/).filter(Boolean)] };
}

function scoreCandidate(content: string, parsed: ReturnType<typeof parseQuery>): number {
  const normalized = content.toLowerCase();
  return parsed.groups.reduce((score, group) => {
    if (parsed.mode === "or") {
      return score + (group.some((token) => normalized.includes(token)) ? group.length : 0);
    }
    return score + (group.every((token) => normalized.includes(token)) ? group.length * 5 : 0);
  }, 0);
}

function snippetFrom(content: string, parsedQuery: string, maxBytes: number): string {
  const tokens = parsedQuery.toLowerCase().trim().split(/\\s+/).filter(Boolean);
  const lines = content.split(/\\r?\\n/);
  let hitLine = 0;
  if (tokens.length > 0) {
    const allTokens = lines.map((line, index) => ({ line: index, score: tokens.reduce((sum, token) => (line.toLowerCase().includes(token) ? sum + 1 : sum), 0) }));
    const best = allTokens.reduce((acc, entry) => entry.score > acc.score ? entry : acc, allTokens[0]);
    if (best && best.score > 0) hitLine = best.line;
  }
  const start = Math.max(0, hitLine - 2);
  const end = Math.min(lines.length, hitLine + 4);
  const section = lines.slice(start, end).join("\n");
  const buffer = Buffer.from(section, "utf8");
  return buffer.length <= maxBytes ? section : buffer.slice(0, maxBytes).toString("utf8");
}

function normalizeExtensions(entries: string[]): Set<string> {
  return new Set(entries.map((entry) => entry.toLowerCase().replace(/^\\./, "").trim()));
}

async function walkProjectFiles(root: string, out: string[], depth: number, extensions: Set<string>, hints: Set<string>): Promise<void> {
  if (depth < 0) return;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    if (["node_modules", ".git", ".next", "dist", "coverage", "tmp", "out", "build"].includes(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkProjectFiles(absolute, out, depth - 1, extensions, hints);
      continue;
    }
    if (!entry.isFile()) continue;
    const base = entry.name.toLowerCase();
    const ext = path.extname(base).toLowerCase().replace(/^\./, "");
    const hasHint = [...hints].some((hint) => base.includes(hint));
    if (extensions.has(ext) || hasHint) {
      out.push(absolute);
    }
  }
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function mapEngineeringNoteType(noteType: string): "findings" | "contradictions" | "open-questions" | "methodology" {
  if (noteType === "research") return "findings";
  if (noteType === "diagnostics") return "open-questions";
  if (noteType === "decision") return "methodology";
  return "findings";
}

export const docsKnowledgeTools: ToolModule[] = [
  {
    definition: {
      name: "search_project_docs",
      description: "Search README/AGENTS/docs and project metadata for ranked snippets.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          roots: { type: "array", items: { type: "string" } },
          maxSnippets: { type: "number" },
          extensions: { type: "array", items: { type: "string" } },
          maxBytesPerSnippet: { type: "number" }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: searchProjectDocsSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof searchProjectDocsSchema>;
      const parsedQuery = parseQuery(parsed.query);
      const extensionSet = normalizeExtensions(parsed.extensions);
      const hints = new Set(["readme", "agents", "guide", "instructions", "doc", "package.json"]);
      const files: string[] = [];
      const searchRoots = parsed.roots.length > 0 ? parsed.roots : [ctx.workspaceRoot];
      for (const root of searchRoots) {
        const absolute = ensureUnderWorkspace(ctx.workspaceRoot, root);
        await walkProjectFiles(absolute, files, 6, extensionSet, hints);
      }
      const candidates = Array.from(new Set(files));
      const matches: Array<{ file: string; score: number; line: number; snippet: string }> = [];
      for (const absolute of candidates) {
        const file = await fs.readFile(absolute, "utf8").catch(() => undefined);
        if (!file) continue;
        const score = scoreCandidate(file, parsedQuery);
        if (score <= 0) continue;
        matches.push({
          file: path.relative(ctx.workspaceRoot, absolute),
          score,
          line: 1,
          snippet: snippetFrom(file, parsed.query, parsed.maxBytesPerSnippet)
        });
      }
      matches.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));
      const top = matches.slice(0, parsed.maxSnippets);
      return {
        ok: true,
        summary: top.length > 0 ? `search_project_docs found ${top.length} match(es).` : "No documentation snippets found.",
        jobId: ctx.workspaceRoot,
        artifacts: [],
        logs: trimLogLines([`files=${candidates.length}`, `matches=${top.length}`]),
        structuredContent: trimStructuredContent(sanitizeSecretLikeValue({ query: parsed.query, roots: searchRoots, matches: top }) as Record<string, unknown>),
        errors: []
      };
    }
  },
  {
    definition: {
      name: "extract_project_conventions",
      description: "Extract style, lint/format/testing/deploy and agent instruction patterns from project docs.",
      inputSchema: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" } },
          fileHints: { type: "array", items: { type: "string" } }
        },
        required: [],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: extractProjectConventionsSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof extractProjectConventionsSchema>;
      const hints = new Set(parsed.fileHints.map((hint) => hint.toLowerCase()));
      const scanRoots = parsed.paths.length > 0 ? parsed.paths : [ctx.workspaceRoot];
      const files: string[] = [];
      const extensions = new Set(["md", "mdx", "json", "yml", "yaml"]);
      for (const entry of scanRoots) {
        const absolute = ensureUnderWorkspace(ctx.workspaceRoot, entry);
        await walkProjectFiles(absolute, files, 8, extensions, hints);
      }

      const buckets = {
        scripts: [] as string[],
        lint: [] as string[],
        format: [] as string[],
        testing: [] as string[],
        deploy: [] as string[],
        agent: [] as string[],
        other: [] as string[]
      };

      const inspectLine = (line: string, file: string) => {
        const normalized = line.toLowerCase();
        const text = `${file}: ${line.trim()}`;
        if (normalized.includes("npm run") || normalized.includes("pnpm") || normalized.includes("yarn")) {
          buckets.scripts.push(text);
        } else if (normalized.includes("eslint") || normalized.includes("lint")) {
          buckets.lint.push(text);
        } else if (normalized.includes("prettier") || normalized.includes("biome") || normalized.includes("format")) {
          buckets.format.push(text);
        } else if (normalized.includes("jest") || normalized.includes("vitest") || normalized.includes("test")) {
          buckets.testing.push(text);
        } else if (normalized.includes("deploy") || normalized.includes("release") || normalized.includes("publish")) {
          buckets.deploy.push(text);
        } else if (normalized.includes("agent") || normalized.includes("instruction") || normalized.includes("playbook")) {
          buckets.agent.push(text);
        } else if (normalized.length > 0) {
          buckets.other.push(text);
        }
      };

      for (const absolute of files) {
        const content = await fs.readFile(absolute, "utf8").catch(() => undefined);
        if (!content) continue;
        const relative = path.relative(ctx.workspaceRoot, absolute);
        const lines = content.split(/\\r?\\n/);
        for (const line of lines.slice(0, 220)) {
          if (line.trim()) inspectLine(line, relative);
        }
      }

      const payload = {
        scanned: [...files].map((entry) => path.relative(ctx.workspaceRoot, entry)),
        buckets,
        topSuggestions: [
          ...buckets.lint.slice(0, 20),
          ...buckets.format.slice(0, 20),
          ...buckets.testing.slice(0, 20),
          ...buckets.deploy.slice(0, 20),
          ...buckets.agent.slice(0, 20)
        ]
      };
      return {
        ok: true,
        summary: `extract_project_conventions scanned ${payload.scanned.length} file(s).`,
        jobId: ctx.workspaceRoot,
        artifacts: [],
        logs: trimLogLines([`files=${payload.scanned.length}`, `scriptHints=${buckets.scripts.length}`, `agentHints=${buckets.agent.length}`]),
        structuredContent: trimStructuredContent(sanitizeSecretLikeValue(payload) as Record<string, unknown>),
        errors: []
      };
    }
  },
  {
    definition: {
      name: "write_agent_note",
      description: "Write non-invasive agent notes to artifact (default) or project research note.",
      inputSchema: {
        type: "object",
        properties: {
          noteType: { type: "string", enum: ["engineering", "diagnostics", "qa", "decision", "ops", "research", "other"] },
          title: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          target: { type: "string", enum: ["artifact", "research"] },
          projectId: { type: "string" }
        },
        required: ["noteType", "title", "content", "target"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: writeAgentNoteSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof writeAgentNoteSchema>;
      const safeTitle = escapeHtml(parsed.title);
      const safeTags = parsed.tags.join(", ");
      const body = `<h1>${safeTitle}</h1><p>type: ${parsed.noteType}</p><p>tags: ${escapeHtml(safeTags)}</p><pre>${escapeHtml(parsed.content)}</pre>`;
      if (parsed.target === "research") {
        if (!parsed.projectId) {
          return {
            ok: false,
            summary: "write_agent_note target=research requires projectId.",
            artifacts: [],
            logs: ["projectId missing."],
            structuredContent: { target: parsed.target },
            errors: ["Missing projectId for research target."]
          };
        }
        const noteType = mapEngineeringNoteType(parsed.noteType);
        const content = `${parsed.title}\\n\\n${parsed.content}`;
        const note = await addResearchNote(ctx.projectRoot, parsed.projectId, {
          noteType,
          content,
          append: true
        });
        return {
          ok: true,
          summary: `write_agent_note stored research note for ${noteType}.`,
          jobId: parsed.projectId,
          artifacts: [],
          logs: trimLogLines([`projectId=${parsed.projectId}`, `noteType=${noteType}`, `path=${note.path}`]),
          structuredContent: trimStructuredContent({
            target: "research",
            projectId: parsed.projectId,
            noteType
          }),
          errors: []
        };
      }
      const safeFilename = `agent-note-${Date.now()}.html`;
      const share = await createShareArtifact({
        shareRoot: ctx.shareRoot,
        title: parsed.title,
        summary: parsed.noteType,
        filename: safeFilename,
        html: `<html><body style=\"font-family:ui-sans-serif\">${body}</body></html>`
      });
      return {
        ok: true,
        summary: `write_agent_note wrote artifact note: ${parsed.title}`,
        jobId: parsed.noteType,
        artifacts: [makeShareUrl(ctx.publicBaseUrl, share.id, share.filename)],
        logs: trimLogLines([`artifact=${share.id}`, `title=${parsed.title}`]),
        structuredContent: trimStructuredContent({ target: "artifact", filename: share.filename, title: parsed.title }),
        errors: []
      };
    }
  }
];
