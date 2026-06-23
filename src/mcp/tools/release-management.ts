import { z } from "zod";
import { getProjectManifest, readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const semverish = /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?$/;

const releaseStatusSchema = z.enum(["planned", "ready", "published", "rolled_back"]);

const releaseRecordSchema = z.object({
  version: z.string().regex(semverish),
  title: z.string().min(1).max(200),
  status: releaseStatusSchema,
  entryFile: z.string().min(1).max(240),
  publishedUrl: z.string().max(1000).optional(),
  releaseNotesPath: z.string().min(1).max(240).optional(),
  changelogPath: z.string().min(1).max(240).optional(),
  rollbackPoint: z.object({
    version: z.string().min(1).max(80),
    publishedUrl: z.string().max(1000).optional(),
    entryFile: z.string().min(1).max(240).optional(),
    note: z.string().max(1000).optional()
  }).optional(),
  changes: z.array(z.string().min(1).max(500)).max(200).optional().default([]),
  checks: z.array(z.string().min(1).max(500)).max(200).optional().default([]),
  createdAt: z.string().datetime(),
  releasedAt: z.string().datetime().optional()
});

const createReleaseRecordInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  version: z.string().regex(semverish),
  title: z.string().min(1).max(200),
  status: releaseStatusSchema.optional().default("planned"),
  changes: z.array(z.string().min(1).max(500)).max(200).optional().default([]),
  checks: z.array(z.string().min(1).max(500)).max(200).optional().default([]),
  rollbackVersion: z.string().min(1).max(80).optional(),
  outputPath: z.string().min(1).max(240).optional().default("release-management/releases.json")
});

const createReleaseNotesInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  version: z.string().regex(semverish),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  changes: z.array(z.string().min(1).max(500)).max(200).optional().default([]),
  fixes: z.array(z.string().min(1).max(500)).max(200).optional().default([]),
  validation: z.array(z.string().min(1).max(500)).max(200).optional().default([]),
  rollback: z.string().max(1000).optional().default("Rollback to the previous published version if release checks fail."),
  outputPath: z.string().min(1).max(240).optional()
});

const updateChangelogInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  version: z.string().regex(semverish),
  date: z.string().min(1).max(40).optional(),
  entries: z.array(z.object({
    type: z.enum(["added", "changed", "fixed", "removed", "security"]),
    text: z.string().min(1).max(500)
  })).min(1).max(200),
  outputPath: z.string().min(1).max(240).optional().default("CHANGELOG.md")
});

const compareBeforeReleaseInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  version: z.string().regex(semverish),
  baseline: z.object({
    version: z.string().min(1).max(80),
    files: z.array(z.string().min(1).max(300)).max(500).optional().default([]),
    validationOk: z.boolean().optional(),
    publishedUrl: z.string().max(1000).optional()
  }).optional(),
  requiredChecks: z.array(z.string().min(1).max(160)).max(100).optional().default(["project validation"]),
  completedChecks: z.array(z.string().min(1).max(160)).max(100).optional().default([]),
  outputPath: z.string().min(1).max(240).optional().default("release-management/compare-before-release.json")
});

const createRollbackPointInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  version: z.string().regex(semverish),
  rollbackToVersion: z.string().min(1).max(80),
  reason: z.string().min(1).max(1000),
  outputPath: z.string().min(1).max(240).optional().default("release-management/rollback-point.json")
});

const listProjectReleasesInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  outputPath: z.string().min(1).max(240).optional().default("release-management/releases.json"),
  status: releaseStatusSchema.optional()
});

type ReleaseRecord = z.infer<typeof releaseRecordSchema>;

interface ReleaseManifest {
  version: 1;
  projectId: string;
  updatedAt: string;
  releases: ReleaseRecord[];
}

async function readReleaseManifest(projectRoot: string, projectId: string, outputPath: string): Promise<ReleaseManifest> {
  try {
    const raw = await readProjectFile(projectRoot, projectId, outputPath, 1024 * 1024);
    const parsed = JSON.parse(raw) as Partial<ReleaseManifest>;
    if (parsed.version === 1 && Array.isArray(parsed.releases)) {
      return { version: 1, projectId, updatedAt: parsed.updatedAt ?? new Date().toISOString(), releases: parsed.releases as ReleaseRecord[] };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/not found|ENOENT|no such file/i.test(message)) throw error;
  }
  return { version: 1, projectId, updatedAt: new Date().toISOString(), releases: [] };
}

async function writeReleaseManifest(projectRoot: string, projectId: string, outputPath: string, releases: ReleaseRecord[]) {
  const payload: ReleaseManifest = {
    version: 1,
    projectId,
    updatedAt: new Date().toISOString(),
    releases: releases.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  };
  const file = await writeProjectFile(projectRoot, projectId, outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  return { payload, file };
}

function normalizeReleaseNotesPath(version: string) {
  return `release-management/release-notes-${version.replace(/^v/, "v")}.md`;
}

export const releaseManagementTools: ToolModule[] = [
  {
    definition: {
      name: "create_release_record",
      description: "Create or update a project-local release record with version tag, status, changes, validation checks, published URL, and rollback point.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, version: { type: "string" }, title: { type: "string" }, status: { type: "string" }, changes: { type: "array", items: { type: "string" } }, checks: { type: "array", items: { type: "string" } }, rollbackVersion: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "version", "title"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createReleaseRecordInputSchema,
    handler: async (input, ctx) => {
      const parsed = createReleaseRecordInputSchema.parse(input);
      const [project, manifest] = await Promise.all([
        getProjectManifest(ctx.projectRoot, parsed.projectId),
        readReleaseManifest(ctx.projectRoot, parsed.projectId, parsed.outputPath)
      ]);
      const existing = manifest.releases.filter((release) => release.version !== parsed.version);
      const now = new Date().toISOString();
      const release: ReleaseRecord = {
        version: parsed.version,
        title: parsed.title,
        status: parsed.status,
        entryFile: project.entryFile,
        publishedUrl: project.publishedUrl,
        changes: parsed.changes,
        checks: parsed.checks,
        rollbackPoint: parsed.rollbackVersion ? { version: parsed.rollbackVersion, publishedUrl: project.publishedUrl, entryFile: project.entryFile, note: `Rollback target for ${parsed.version}.` } : undefined,
        createdAt: now,
        releasedAt: parsed.status === "published" ? now : undefined
      };
      const { payload, file } = await writeReleaseManifest(ctx.projectRoot, parsed.projectId, parsed.outputPath, [release, ...existing]);
      return { ok: true, summary: `Recorded release ${parsed.version} (${parsed.status}).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { release, releaseCount: payload.releases.length }, logs: [JSON.stringify(release, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "create_release_notes",
      description: "Create Markdown release notes for a version with summary, changes, fixes, validation, and rollback guidance.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, version: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, changes: { type: "array", items: { type: "string" } }, fixes: { type: "array", items: { type: "string" } }, validation: { type: "array", items: { type: "string" } }, rollback: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "version", "title", "summary"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createReleaseNotesInputSchema,
    handler: async (input, ctx) => {
      const parsed = createReleaseNotesInputSchema.parse(input);
      const outputPath = parsed.outputPath ?? normalizeReleaseNotesPath(parsed.version);
      const markdown = [`# ${parsed.title}`, "", `Version: ${parsed.version}`, "", "## Summary", parsed.summary, "", "## Changes", ...(parsed.changes.length ? parsed.changes.map((item) => `- ${item}`) : ["- No changes listed."]), "", "## Fixes", ...(parsed.fixes.length ? parsed.fixes.map((item) => `- ${item}`) : ["- No fixes listed."]), "", "## Validation", ...(parsed.validation.length ? parsed.validation.map((item) => `- ${item}`) : ["- Validation not recorded."]), "", "## Rollback", parsed.rollback, ""].join("\n");
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, outputPath, markdown);
      return { ok: true, summary: `Created release notes for ${parsed.version}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { path: file.path, markdown }, logs: [markdown], errors: [] };
    }
  },
  {
    definition: {
      name: "update_project_changelog",
      description: "Append a versioned changelog section with added/changed/fixed/removed/security entries.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, version: { type: "string" }, date: { type: "string" }, entries: { type: "array" }, outputPath: { type: "string" } }, required: ["projectId", "version", "entries"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: updateChangelogInputSchema,
    handler: async (input, ctx) => {
      const parsed = updateChangelogInputSchema.parse(input);
      let existing = "# Changelog\n\n";
      try {
        existing = await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, 1024 * 1024);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!/not found|ENOENT|no such file/i.test(message)) throw error;
      }
      const groups = parsed.entries.reduce<Record<string, string[]>>((acc, entry) => {
        (acc[entry.type] ??= []).push(entry.text);
        return acc;
      }, {});
      const section = [`## ${parsed.version} - ${parsed.date ?? new Date().toISOString().slice(0, 10)}`, "", ...Object.entries(groups).flatMap(([type, items]) => [`### ${type}`, ...items.map((item) => `- ${item}`), ""]), ""].join("\n");
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${section}\n${existing.replace(/^# Changelog\s*/i, "# Changelog\n\n")}`);
      return { ok: true, summary: `Updated changelog for ${parsed.version}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { path: file.path, version: parsed.version, entryCount: parsed.entries.length }, logs: [section], errors: [] };
    }
  },
  {
    definition: {
      name: "compare_before_release",
      description: "Run a compare-before-release check against current project files, validation status, baseline files, and required checks.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, version: { type: "string" }, baseline: { type: "object" }, requiredChecks: { type: "array", items: { type: "string" } }, completedChecks: { type: "array", items: { type: "string" } }, outputPath: { type: "string" } }, required: ["projectId", "version"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: compareBeforeReleaseInputSchema,
    handler: async (input, ctx) => {
      const parsed = compareBeforeReleaseInputSchema.parse(input);
      const project = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const currentFiles = project.files.map((file) => file.path).sort();
      const baselineFiles = parsed.baseline?.files ?? [];
      const addedFiles = currentFiles.filter((file) => !baselineFiles.includes(file));
      const removedFiles = baselineFiles.filter((file) => !currentFiles.includes(file));
      const missingChecks = parsed.requiredChecks.filter((check) => !parsed.completedChecks.includes(check));
      const validationOk = project.lastValidation?.ok === true;
      const warnings = [
        ...(!validationOk ? ["Project validation is not passing or has not been run."] : []),
        ...(missingChecks.length ? [`Missing release checks: ${missingChecks.join(", ")}.`] : [])
      ];
      const result = { ok: warnings.length === 0, version: parsed.version, baseline: parsed.baseline, current: { fileCount: currentFiles.length, entryFile: project.entryFile, publishedUrl: project.publishedUrl, validation: project.lastValidation ?? null }, addedFiles, removedFiles, missingChecks, warnings };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(result, null, 2)}\n`);
      return { ok: result.ok, summary: result.ok ? `Release ${parsed.version} compare checks passed.` : `Release ${parsed.version} compare found ${warnings.length} warning(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: warnings };
    }
  },
  {
    definition: {
      name: "create_rollback_point",
      description: "Create a rollback point document for a release version, linking the target rollback version and current published project state.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, version: { type: "string" }, rollbackToVersion: { type: "string" }, reason: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "version", "rollbackToVersion", "reason"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createRollbackPointInputSchema,
    handler: async (input, ctx) => {
      const parsed = createRollbackPointInputSchema.parse(input);
      const project = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const rollback = { version: parsed.version, rollbackToVersion: parsed.rollbackToVersion, reason: parsed.reason, currentPublishedUrl: project.publishedUrl, entryFile: project.entryFile, createdAt: new Date().toISOString(), steps: ["Stop current release promotion.", "Re-publish or restore rollback target artifacts.", "Run validation and browser smoke checks.", "Record rollback audit event and notify stakeholders."] };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(rollback, null, 2)}\n`);
      return { ok: true, summary: `Created rollback point for ${parsed.version} -> ${parsed.rollbackToVersion}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: rollback, logs: [JSON.stringify(rollback, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "list_project_releases",
      description: "List project-local release records, optionally filtered by status.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, outputPath: { type: "string" }, status: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: listProjectReleasesInputSchema,
    handler: async (input, ctx) => {
      const parsed = listProjectReleasesInputSchema.parse(input);
      const manifest = await readReleaseManifest(ctx.projectRoot, parsed.projectId, parsed.outputPath);
      const releases = manifest.releases.filter((release) => !parsed.status || release.status === parsed.status);
      return { ok: true, summary: `Found ${releases.length} release record(s).`, jobId: parsed.projectId, artifacts: [], structuredContent: { releases, totalCount: manifest.releases.length }, logs: releases.map((release) => `${release.version} ${release.status}: ${release.title}`), errors: [] };
    }
  }
];
