import { z } from "zod";
import type { ToolModule } from "../types.js";
import {
  addResearchNote,
  addResearchSource,
  createResearchProject,
  getResearchManifest,
  listResearchSources,
  publishResearchReport,
  recordResearchEvidence,
  writeResearchReport
} from "../../research/store.js";

const projectIdSchema = z.object({
  projectId: z.string().min(8).max(80)
});

const createResearchProjectSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().max(2000).optional().default("")
});

const addResearchSourceSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(240),
  url: z.string().url(),
  publisher: z.string().max(160).optional(),
  claim: z.string().min(1).max(4000),
  summary: z.string().min(1).max(8000),
  confidence: z.enum(["low", "medium", "high"]),
  tags: z.array(z.string().min(1).max(80)).max(20).optional().default([]),
  usedInReport: z.boolean().optional().default(true)
});

const addResearchNoteSchema = z.object({
  projectId: z.string().min(8).max(80),
  noteType: z.enum(["findings", "contradictions", "open-questions", "methodology"]),
  content: z.string().min(1).max(1024 * 1024),
  append: z.boolean().optional().default(true)
});

const recordResearchEvidenceSchema = z.object({
  projectId: z.string().min(8).max(80),
  sourceId: z.string().min(1).max(80).optional(),
  kind: z.string().min(1).max(120),
  url: z.string().url().optional(),
  reportUrl: z.string().url().optional(),
  summary: z.string().min(1).max(8000),
  structuredContent: z.unknown().optional()
});

const writeResearchReportSchema = z.object({
  projectId: z.string().min(8).max(80),
  markdown: z.string().min(1).max(1024 * 1024),
  html: z.string().min(1).max(1024 * 1024)
});

export const researchTools: ToolModule[] = [
  {
    definition: {
      name: "create_research_project",
      description: "Create a persistent research project backed by Project storage.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Research project title." },
          summary: { type: "string", description: "Short research brief or scope." }
        },
        required: ["title"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: createResearchProjectSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof createResearchProjectSchema>;
      const manifest = await createResearchProject(ctx.projectRoot, {
        title: parsed.title,
        summary: parsed.summary,
        createdByClientId: ctx.clientId
      });
      const report = {
        ok: true,
        projectId: manifest.project.id,
        manifest,
        nextActions: ["Add sources with add_research_source, write report.md/report.html, then publish_research_report."]
      };
      return {
        ok: true,
        summary: `Created research project ${manifest.project.id}.`,
        jobId: manifest.project.id,
        artifacts: [manifest.project.id],
        structuredContent: report,
        logs: [JSON.stringify(report, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "add_research_source",
      description: "Add one researched source to a research project. Does not search or fetch the web.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          publisher: { type: "string" },
          claim: { type: "string" },
          summary: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          tags: { type: "array", items: { type: "string" } },
          usedInReport: { type: "boolean" }
        },
        required: ["projectId", "title", "url", "claim", "summary", "confidence"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: addResearchSourceSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof addResearchSourceSchema>;
      const source = await addResearchSource(ctx.projectRoot, parsed.projectId, parsed);
      return {
        ok: true,
        summary: `Added research source ${source.id}.`,
        jobId: parsed.projectId,
        artifacts: [source.id],
        structuredContent: { source },
        logs: [JSON.stringify(source, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "list_research_sources",
      description: "List research sources for a project.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: projectIdSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof projectIdSchema>;
      const sources = await listResearchSources(ctx.projectRoot, parsed.projectId);
      return {
        ok: true,
        summary: `Listed ${sources.length} research source(s).`,
        jobId: parsed.projectId,
        artifacts: sources.map((source) => source.id),
        structuredContent: { sources },
        logs: [JSON.stringify(sources, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "add_research_note",
      description: "Write or append a structured research note.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          noteType: { type: "string", enum: ["findings", "contradictions", "open-questions", "methodology"] },
          content: { type: "string" },
          append: { type: "boolean" }
        },
        required: ["projectId", "noteType", "content"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: addResearchNoteSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof addResearchNoteSchema>;
      const note = await addResearchNote(ctx.projectRoot, parsed.projectId, parsed);
      return {
        ok: true,
        summary: `Updated research note ${parsed.noteType}.`,
        jobId: parsed.projectId,
        artifacts: [note.path],
        structuredContent: note,
        logs: [JSON.stringify(note, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "record_research_evidence",
      description: "Record supporting evidence such as an inspect_webpage report URL for a research project.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          sourceId: { type: "string" },
          kind: { type: "string" },
          url: { type: "string" },
          reportUrl: { type: "string" },
          summary: { type: "string" },
          structuredContent: {}
        },
        required: ["projectId", "kind", "summary"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: recordResearchEvidenceSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof recordResearchEvidenceSchema>;
      const evidence = await recordResearchEvidence(ctx.projectRoot, parsed.projectId, parsed);
      return {
        ok: true,
        summary: `Recorded research evidence ${evidence.id}.`,
        jobId: parsed.projectId,
        artifacts: [evidence.id],
        structuredContent: { evidence },
        logs: [JSON.stringify(evidence, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "get_research_manifest",
      description: "Get research metadata, sources, notes, evidence, report status, and published URL.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: projectIdSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof projectIdSchema>;
      const manifest = await getResearchManifest(ctx.projectRoot, parsed.projectId);
      return {
        ok: true,
        summary: `Loaded research manifest for ${parsed.projectId}.`,
        jobId: parsed.projectId,
        previewUrl: manifest.publishedUrl,
        shareUrl: manifest.publishedUrl,
        artifacts: manifest.sources.map((source) => source.id),
        structuredContent: manifest as unknown as Record<string, unknown>,
        logs: [JSON.stringify(manifest, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "write_research_report",
      description: "Write report.md and report.html for a research project.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          markdown: { type: "string" },
          html: { type: "string", description: "Complete HTML document beginning with <!doctype html>." }
        },
        required: ["projectId", "markdown", "html"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: writeResearchReportSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof writeResearchReportSchema>;
      const report = await writeResearchReport(ctx.projectRoot, parsed.projectId, parsed);
      return {
        ok: true,
        summary: `Wrote research report for ${parsed.projectId}.`,
        jobId: parsed.projectId,
        artifacts: [report.markdownPath, report.htmlPath],
        structuredContent: { report },
        logs: [JSON.stringify(report, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "publish_research_report",
      description: "Validate research manifest and publish report.html as the project entry file.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: projectIdSchema,
    handler: async (input, ctx) => {
      const parsed = input as z.infer<typeof projectIdSchema>;
      const report = await publishResearchReport(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, { shareBasePath: ctx.publicShareBasePath });
      return {
        ok: report.ok,
        summary: report.summary,
        jobId: parsed.projectId,
        previewUrl: report.publishedUrl,
        shareUrl: report.publishedUrl,
        artifacts: report.files.map((file) => file.path),
        structuredContent: report as unknown as Record<string, unknown>,
        logs: [JSON.stringify(report, null, 2)],
        errors: report.researchValidation.errors
      };
    }
  }
];
