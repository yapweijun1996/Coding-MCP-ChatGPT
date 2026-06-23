import { z } from "zod";
import { readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

interface KnowledgeChunk {
  id: string;
  documentId: string;
  title: string;
  sourcePath?: string;
  text: string;
  tokens: string[];
  tokenWeights: Record<string, number>;
  startChar: number;
  endChar: number;
  createdAt: string;
  updatedAt?: string;
  lastReviewedAt?: string;
}

interface KnowledgeIndex {
  schemaVersion: 1;
  projectId?: string;
  documents: Array<{ id: string; title: string; sourcePath?: string; createdAt: string; updatedAt?: string; lastReviewedAt?: string; chunkCount: number }>;
  chunks: KnowledgeChunk[];
  createdAt: string;
}

const knowledgeDocumentSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(200000).optional(),
  sourcePath: z.string().min(1).max(240).optional(),
  updatedAt: z.string().min(1).max(80).optional(),
  lastReviewedAt: z.string().min(1).max(80).optional()
});

const ingestKnowledgeDocumentInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(200000).optional(),
  sourcePath: z.string().min(1).max(240).optional(),
  documentId: z.string().min(1).max(120).optional(),
  lastReviewedAt: z.string().min(1).max(80).optional(),
  outputPath: z.string().min(1).max(240).optional().default("knowledge-base/document.json")
}).refine((input) => Boolean(input.content || input.sourcePath), {
  message: "Provide content or sourcePath."
});

const chunkKnowledgeDocumentInputSchema = z.object({
  document: knowledgeDocumentSchema,
  chunkSize: z.number().int().min(200).max(4000).optional().default(1000),
  overlap: z.number().int().min(0).max(1000).optional().default(120)
});

const buildKnowledgeIndexInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  documents: z.array(knowledgeDocumentSchema).min(1).max(100),
  chunkSize: z.number().int().min(200).max(4000).optional().default(1000),
  overlap: z.number().int().min(0).max(1000).optional().default(120),
  outputPath: z.string().min(1).max(240).optional().default("knowledge-base/index.json")
});

const searchKnowledgeBaseInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  indexPath: z.string().min(1).max(240).optional(),
  index: z.record(z.string(), z.unknown()).optional(),
  query: z.string().min(1).max(500),
  topK: z.number().int().min(1).max(50).optional().default(5)
}).refine((input) => Boolean(input.index || (input.projectId && input.indexPath)), {
  message: "Provide index or projectId + indexPath."
});

const citeKnowledgeSourcesInputSchema = z.object({
  answer: z.string().min(1).max(20000),
  searchResults: z.array(z.object({
    chunkId: z.string().min(1).max(160),
    title: z.string().min(1).max(200),
    sourcePath: z.string().min(1).max(240).optional(),
    snippet: z.string().min(1).max(4000),
    score: z.number().optional()
  })).min(1).max(30)
});

const detectStaleKnowledgeInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  indexPath: z.string().min(1).max(240).optional(),
  index: z.record(z.string(), z.unknown()).optional(),
  maxAgeDays: z.number().int().min(1).max(3650).optional().default(90),
  now: z.string().min(1).max(80).optional()
}).refine((input) => Boolean(input.index || (input.projectId && input.indexPath)), {
  message: "Provide index or projectId + indexPath."
});

const updateProjectMemoryNoteInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(4000),
  tags: z.array(z.string().min(1).max(80)).max(30).optional().default([]),
  sourceRefs: z.array(z.string().min(1).max(240)).max(50).optional().default([]),
  outputPath: z.string().min(1).max(240).optional().default("knowledge-base/project-memory.md")
});

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length >= 2).slice(0, 20000);
}

function weights(tokens: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const token of tokens) out[token] = (out[token] ?? 0) + 1;
  return out;
}

function cosine(left: Record<string, number>, right: Record<string, number>): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const value of Object.values(left)) leftNorm += value * value;
  for (const value of Object.values(right)) rightNorm += value * value;
  for (const [token, value] of Object.entries(left)) dot += value * (right[token] ?? 0);
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function chunkText(document: z.infer<typeof knowledgeDocumentSchema>, content: string, chunkSize: number, overlap: number): KnowledgeChunk[] {
  const now = new Date().toISOString();
  const documentId = document.id ?? slug(document.title);
  const chunks: KnowledgeChunk[] = [];
  const step = Math.max(1, chunkSize - overlap);
  for (let start = 0; start < content.length; start += step) {
    const end = Math.min(content.length, start + chunkSize);
    const text = content.slice(start, end).trim();
    if (!text) continue;
    const tokens = tokenize(text);
    chunks.push({
      id: `${documentId}#chunk_${String(chunks.length + 1).padStart(4, "0")}`,
      documentId,
      title: document.title,
      sourcePath: document.sourcePath,
      text,
      tokens,
      tokenWeights: weights(tokens),
      startChar: start,
      endChar: end,
      createdAt: now,
      updatedAt: document.updatedAt,
      lastReviewedAt: document.lastReviewedAt
    });
    if (end >= content.length) break;
  }
  return chunks;
}

async function loadDocumentContent(ctx: ToolContext, projectId: string, document: z.infer<typeof knowledgeDocumentSchema>): Promise<string> {
  if (document.content) return document.content;
  if (!document.sourcePath) throw new Error("Document requires content or sourcePath.");
  return readProjectFile(ctx.projectRoot, projectId, document.sourcePath, 5 * 1024 * 1024);
}

async function loadIndex(ctx: ToolContext, input: z.infer<typeof searchKnowledgeBaseInputSchema> | z.infer<typeof detectStaleKnowledgeInputSchema>): Promise<KnowledgeIndex> {
  if (input.index) return input.index as unknown as KnowledgeIndex;
  if (!input.projectId || !input.indexPath) throw new Error("projectId and indexPath are required.");
  return JSON.parse(await readProjectFile(ctx.projectRoot, input.projectId, input.indexPath, 10 * 1024 * 1024)) as KnowledgeIndex;
}

function searchIndex(index: KnowledgeIndex, query: string, topK: number) {
  const queryWeights = weights(tokenize(query));
  return index.chunks
    .map((chunk) => {
      const score = cosine(queryWeights, chunk.tokenWeights);
      const snippet = chunk.text.length <= 500 ? chunk.text : `${chunk.text.slice(0, 497)}...`;
      return {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        title: chunk.title,
        sourcePath: chunk.sourcePath,
        score: Math.round(score * 10000) / 10000,
        snippet,
        citation: `${chunk.title}${chunk.sourcePath ? ` (${chunk.sourcePath}` : ""}${chunk.sourcePath ? `, chars ${chunk.startChar}-${chunk.endChar})` : ""}`
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId))
    .slice(0, topK);
}

function ageDays(value: string | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.floor((now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000));
}

export const knowledgeBaseTools: ToolModule[] = [
  {
    definition: {
      name: "ingest_knowledge_document",
      description: "Persist a project knowledge document from inline content or a project text file.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, content: { type: "string" }, sourcePath: { type: "string" }, documentId: { type: "string" }, lastReviewedAt: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "title"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: ingestKnowledgeDocumentInputSchema,
    handler: async (input, ctx) => {
      const parsed = ingestKnowledgeDocumentInputSchema.parse(input);
      const content = parsed.content ?? await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.sourcePath!, 5 * 1024 * 1024);
      const document = { id: parsed.documentId ?? slug(parsed.title), title: parsed.title, sourcePath: parsed.sourcePath, content, lastReviewedAt: parsed.lastReviewedAt, createdAt: new Date().toISOString() };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(document, null, 2)}\n`);
      return { ok: true, summary: `Ingested knowledge document ${document.id}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { ...document, contentLength: content.length, content: undefined }, logs: [JSON.stringify({ id: document.id, title: document.title, contentLength: content.length }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "chunk_knowledge_document",
      description: "Chunk a knowledge document and attach deterministic lexical token weights for local retrieval.",
      inputSchema: { type: "object", properties: { document: { type: "object" }, chunkSize: { type: "number" }, overlap: { type: "number" } }, required: ["document"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: chunkKnowledgeDocumentInputSchema,
    handler: (input) => {
      const parsed = chunkKnowledgeDocumentInputSchema.parse(input);
      if (!parsed.document.content) throw new Error("document.content is required for direct chunking.");
      const chunks = chunkText(parsed.document, parsed.document.content, parsed.chunkSize, parsed.overlap);
      return { ok: true, summary: `Created ${chunks.length} knowledge chunk(s).`, artifacts: [], structuredContent: { chunks }, logs: [JSON.stringify({ chunkCount: chunks.length }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "build_project_knowledge_index",
      description: "Build a project-local lexical RAG index from supplied documents or project text files.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, documents: { type: "array" }, chunkSize: { type: "number" }, overlap: { type: "number" }, outputPath: { type: "string" } }, required: ["projectId", "documents"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: buildKnowledgeIndexInputSchema,
    handler: async (input, ctx) => {
      const parsed = buildKnowledgeIndexInputSchema.parse(input);
      const documents = [];
      const chunks: KnowledgeChunk[] = [];
      for (const document of parsed.documents) {
        const content = await loadDocumentContent(ctx, parsed.projectId, document);
        const documentChunks = chunkText(document, content, parsed.chunkSize, parsed.overlap);
        chunks.push(...documentChunks);
        documents.push({ id: document.id ?? slug(document.title), title: document.title, sourcePath: document.sourcePath, createdAt: new Date().toISOString(), updatedAt: document.updatedAt, lastReviewedAt: document.lastReviewedAt, chunkCount: documentChunks.length });
      }
      const index: KnowledgeIndex = { schemaVersion: 1, projectId: parsed.projectId, documents, chunks, createdAt: new Date().toISOString() };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(index, null, 2)}\n`);
      return { ok: true, summary: `Built knowledge index with ${chunks.length} chunk(s) from ${documents.length} document(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { indexPath: file.path, documentCount: documents.length, chunkCount: chunks.length, index }, logs: [JSON.stringify({ indexPath: file.path, documentCount: documents.length, chunkCount: chunks.length }, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "search_knowledge_base",
      description: "Search a project-local knowledge index and return scored snippets with source citations.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, indexPath: { type: "string" }, index: { type: "object" }, query: { type: "string" }, topK: { type: "number" } }, required: ["query"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: searchKnowledgeBaseInputSchema,
    handler: async (input, ctx) => {
      const parsed = searchKnowledgeBaseInputSchema.parse(input);
      const index = await loadIndex(ctx, parsed);
      const results = searchIndex(index, parsed.query, parsed.topK);
      return { ok: true, summary: `Found ${results.length} knowledge result(s).`, jobId: parsed.projectId, artifacts: [], structuredContent: { query: parsed.query, results }, logs: [JSON.stringify(results, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "cite_knowledge_sources",
      description: "Attach citation markers and a source list to an answer from knowledge search results.",
      inputSchema: { type: "object", properties: { answer: { type: "string" }, searchResults: { type: "array" } }, required: ["answer", "searchResults"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: citeKnowledgeSourcesInputSchema,
    handler: (input) => {
      const parsed = citeKnowledgeSourcesInputSchema.parse(input);
      const sources = parsed.searchResults.map((result, index) => ({ marker: `[${index + 1}]`, chunkId: result.chunkId, title: result.title, sourcePath: result.sourcePath, score: result.score, snippet: result.snippet }));
      const citedAnswer = `${parsed.answer}\n\nSources:\n${sources.map((source) => `${source.marker} ${source.title}${source.sourcePath ? ` - ${source.sourcePath}` : ""}`).join("\n")}`;
      return { ok: true, summary: `Prepared cited answer with ${sources.length} source(s).`, artifacts: [], structuredContent: { citedAnswer, sources }, logs: [citedAnswer], errors: [] };
    }
  },
  {
    definition: {
      name: "detect_stale_knowledge",
      description: "Detect stale documents/chunks in a project knowledge index based on lastReviewedAt or updatedAt age.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, indexPath: { type: "string" }, index: { type: "object" }, maxAgeDays: { type: "number" }, now: { type: "string" } }, additionalProperties: false }
    },
    enabledByDefault: true,
    schema: detectStaleKnowledgeInputSchema,
    handler: async (input, ctx) => {
      const parsed = detectStaleKnowledgeInputSchema.parse(input);
      const index = await loadIndex(ctx, parsed);
      const now = parsed.now ? new Date(parsed.now) : new Date();
      const stale = index.documents.map((document) => {
        const reference = document.lastReviewedAt ?? document.updatedAt ?? document.createdAt;
        const age = ageDays(reference, now);
        return { ...document, referenceDate: reference, ageDays: age, stale: age === undefined || age > parsed.maxAgeDays };
      }).filter((document) => document.stale);
      return { ok: true, summary: `Detected ${stale.length} stale knowledge document(s).`, jobId: parsed.projectId, artifacts: [], structuredContent: { maxAgeDays: parsed.maxAgeDays, stale }, logs: [JSON.stringify(stale, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "update_project_memory_note",
      description: "Append a durable project memory note with summary, tags, and source references.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, tags: { type: "array", items: { type: "string" } }, sourceRefs: { type: "array", items: { type: "string" } }, outputPath: { type: "string" } }, required: ["projectId", "title", "summary"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: updateProjectMemoryNoteInputSchema,
    handler: async (input, ctx) => {
      const parsed = updateProjectMemoryNoteInputSchema.parse(input);
      let existing = "";
      try {
        existing = await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, 5 * 1024 * 1024);
      } catch {
        existing = "# Project Memory\n\n";
      }
      const entry = [
        `## ${parsed.title}`,
        "",
        `Recorded: ${new Date().toISOString()}`,
        `Tags: ${parsed.tags.join(", ") || "none"}`,
        "",
        parsed.summary,
        "",
        "Sources:",
        ...(parsed.sourceRefs.length ? parsed.sourceRefs.map((source) => `- ${source}`) : ["- none"]),
        ""
      ].join("\n");
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${existing.trim()}\n\n${entry}\n`);
      return { ok: true, summary: `Updated project memory note ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { path: file.path, title: parsed.title, tags: parsed.tags, sourceRefs: parsed.sourceRefs }, logs: [entry], errors: [] };
    }
  }
];
