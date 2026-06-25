import {
  appendProjectTaskHistory,
  createProject,
  getProjectManifest as getProjectDeliveryManifest,
  listProjectFiles,
  publishProjectAndReport,
  readProjectFile,
  writeProjectFile,
  type ProjectFileInfo,
  type ProjectMetadata,
  type PublishProjectOptions,
  type ProjectValidationResult
} from "../projects/store.js";
import { withKeyedLock } from "../shared/keyed-lock.js";

// Research-level serialization key. Distinct from the project-level lock used inside
// writeProjectFile/appendProjectTaskHistory so these compound operations (which call
// those locked helpers) don't deadlock on a non-reentrant lock. Serializes the
// read-compute-id-then-write sequences so concurrent calls can't collide on
// source_NNN / evidence_NNN ids or clobber an appended note.
function researchLockKey(projectRoot: string, projectId: string): string {
  return `research:${projectRoot}::${projectId}`;
}

export type ResearchConfidence = "low" | "medium" | "high";
export type ResearchNoteType = "findings" | "contradictions" | "open-questions" | "methodology";

export interface ResearchMetadata {
  projectId: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  createdByClientId: string;
}

export interface ResearchSource {
  id: string;
  title: string;
  url: string;
  publisher?: string;
  claim: string;
  summary: string;
  confidence: ResearchConfidence;
  tags: string[];
  usedInReport: boolean;
  addedAt: string;
}

export interface ResearchEvidence {
  id: string;
  sourceId?: string;
  kind: string;
  url?: string;
  reportUrl?: string;
  summary: string;
  structuredContent?: unknown;
  recordedAt: string;
}

export interface ResearchNoteStatus {
  type: ResearchNoteType;
  path: string;
  exists: boolean;
  size?: number;
  modifiedAt?: string;
}

export interface ResearchReportStatus {
  markdownExists: boolean;
  htmlExists: boolean;
  markdownPath: "report.md";
  htmlPath: "report.html";
}

export interface ResearchManifest {
  research: ResearchMetadata;
  project: ProjectMetadata;
  sources: ResearchSource[];
  notes: ResearchNoteStatus[];
  evidence: ResearchEvidence[];
  report: ResearchReportStatus;
  publishedUrl?: string;
}

export interface ResearchValidationResult {
  ok: boolean;
  projectId: string;
  checkedAt: string;
  warnings: string[];
  errors: string[];
  sourceCount: number;
  usedSourceCount: number;
  report: ResearchReportStatus;
}

export interface PublishResearchReportResult {
  ok: boolean;
  projectId: string;
  publishedUrl?: string;
  entryFile: "report.html";
  researchValidation: ResearchValidationResult;
  projectValidation?: ProjectValidationResult;
  files: ProjectFileInfo[];
  summary: string;
  nextActions: string[];
}

const researchMetadataPath = "research/research.json";
const researchEvidencePath = "research/evidence/inspections.json";
const researchSourcePattern = /^research\/sources\/source_(\d{3,})\.json$/;
const reportMarkdownPath = "report.md";
const reportHtmlPath = "report.html";
const noteTypes: ResearchNoteType[] = ["findings", "contradictions", "open-questions", "methodology"];

function isValidResearchConfidence(value: unknown): value is ResearchConfidence {
  return value === "low" || value === "medium" || value === "high";
}

function assertHttpUrl(value: string, label = "url"): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must start with http:// or https://.`);
  }
}

function notePath(noteType: ResearchNoteType): string {
  return `research/notes/${noteType}.md`;
}

function sourcePath(id: string): string {
  return `research/sources/${id}.json`;
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseResearchMetadata(raw: string): ResearchMetadata {
  const value = parseJsonObject(raw, researchMetadataPath);
  const metadata: ResearchMetadata = {
    projectId: String(value.projectId ?? ""),
    title: String(value.title ?? ""),
    summary: String(value.summary ?? ""),
    createdAt: String(value.createdAt ?? ""),
    updatedAt: String(value.updatedAt ?? ""),
    createdByClientId: String(value.createdByClientId ?? "")
  };
  if (!metadata.projectId || !metadata.title || !metadata.createdAt) {
    throw new Error("Research metadata is incomplete.");
  }
  return metadata;
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}

function normalizeResearchSource(input: Omit<ResearchSource, "id" | "addedAt"> & { id: string; addedAt?: string }): ResearchSource {
  assertHttpUrl(input.url);
  if (!input.title.trim()) throw new Error("Source title is required.");
  if (!input.claim.trim()) throw new Error("Source claim is required.");
  if (!input.summary.trim()) throw new Error("Source summary is required.");
  if (!isValidResearchConfidence(input.confidence)) throw new Error("confidence must be low, medium, or high.");
  return {
    id: input.id,
    title: input.title.trim(),
    url: input.url.trim(),
    publisher: input.publisher?.trim() || undefined,
    claim: input.claim.trim(),
    summary: input.summary.trim(),
    confidence: input.confidence,
    tags: normalizeTags(input.tags),
    usedInReport: input.usedInReport ?? true,
    addedAt: input.addedAt ?? new Date().toISOString()
  };
}

function parseResearchSource(raw: string, fallbackId: string): ResearchSource {
  const value = parseJsonObject(raw, fallbackId);
  const tags = Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const confidence = value.confidence;
  if (!isValidResearchConfidence(confidence)) throw new Error(`Invalid confidence in ${fallbackId}.`);
  return normalizeResearchSource({
    id: typeof value.id === "string" && value.id ? value.id : fallbackId,
    title: String(value.title ?? ""),
    url: String(value.url ?? ""),
    publisher: typeof value.publisher === "string" ? value.publisher : undefined,
    claim: String(value.claim ?? ""),
    summary: String(value.summary ?? ""),
    confidence,
    tags,
    usedInReport: typeof value.usedInReport === "boolean" ? value.usedInReport : true,
    addedAt: typeof value.addedAt === "string" ? value.addedAt : undefined
  });
}

function parseResearchEvidenceList(raw: string): ResearchEvidence[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${researchEvidencePath} must be an array.`);
  return parsed.map((item, index): ResearchEvidence => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Evidence item ${index + 1} must be an object.`);
    }
    const value = item as Record<string, unknown>;
    return {
      id: typeof value.id === "string" && value.id ? value.id : `evidence_${String(index + 1).padStart(3, "0")}`,
      sourceId: typeof value.sourceId === "string" ? value.sourceId : undefined,
      kind: typeof value.kind === "string" && value.kind ? value.kind : "note",
      url: typeof value.url === "string" ? value.url : undefined,
      reportUrl: typeof value.reportUrl === "string" ? value.reportUrl : undefined,
      summary: typeof value.summary === "string" ? value.summary : "",
      structuredContent: value.structuredContent,
      recordedAt: typeof value.recordedAt === "string" ? value.recordedAt : new Date().toISOString()
    };
  });
}

async function safeReadProjectFile(projectRoot: string, projectId: string, relativePath: string): Promise<string | undefined> {
  try {
    return await readProjectFile(projectRoot, projectId, relativePath, 1024 * 1024);
  } catch {
    return undefined;
  }
}

async function readResearchMetadata(projectRoot: string, projectId: string): Promise<ResearchMetadata> {
  const raw = await readProjectFile(projectRoot, projectId, researchMetadataPath, 1024 * 1024);
  return parseResearchMetadata(raw);
}

async function writeResearchMetadata(projectRoot: string, metadata: ResearchMetadata): Promise<void> {
  await writeProjectFile(projectRoot, metadata.projectId, researchMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function touchResearchMetadata(projectRoot: string, projectId: string): Promise<void> {
  const metadata = await readResearchMetadata(projectRoot, projectId);
  await writeResearchMetadata(projectRoot, { ...metadata, updatedAt: new Date().toISOString() });
}

async function readResearchSources(projectRoot: string, projectId: string): Promise<ResearchSource[]> {
  const files = await listProjectFiles(projectRoot, projectId);
  const sourceFiles = files
    .map((file) => ({ file, match: researchSourcePattern.exec(file.path) }))
    .filter((item): item is { file: ProjectFileInfo; match: RegExpExecArray } => Boolean(item.match))
    .sort((a, b) => a.file.path.localeCompare(b.file.path));
  const sources: ResearchSource[] = [];
  for (const { file } of sourceFiles) {
    const raw = await readProjectFile(projectRoot, projectId, file.path, 1024 * 1024);
    sources.push(parseResearchSource(raw, file.path.split("/").at(-1)?.replace(/\.json$/, "") ?? file.path));
  }
  return sources;
}

async function nextResearchSourceId(projectRoot: string, projectId: string): Promise<string> {
  const files = await listProjectFiles(projectRoot, projectId);
  const maxIndex = files.reduce((max, file) => {
    const match = researchSourcePattern.exec(file.path);
    if (!match) return max;
    return Math.max(max, Number.parseInt(match[1], 10));
  }, 0);
  return `source_${String(maxIndex + 1).padStart(3, "0")}`;
}

async function readResearchEvidence(projectRoot: string, projectId: string): Promise<ResearchEvidence[]> {
  const raw = await safeReadProjectFile(projectRoot, projectId, researchEvidencePath);
  if (!raw) return [];
  return parseResearchEvidenceList(raw);
}

async function getNoteStatuses(projectRoot: string, projectId: string): Promise<ResearchNoteStatus[]> {
  const files = await listProjectFiles(projectRoot, projectId);
  return noteTypes.map((type) => {
    const path = notePath(type);
    const file = files.find((item) => item.path === path);
    return {
      type,
      path,
      exists: Boolean(file),
      size: file?.size,
      modifiedAt: file?.modifiedAt
    };
  });
}

async function getReportStatus(projectRoot: string, projectId: string): Promise<ResearchReportStatus> {
  const files = await listProjectFiles(projectRoot, projectId);
  return {
    markdownExists: files.some((file) => file.path === reportMarkdownPath),
    htmlExists: files.some((file) => file.path === reportHtmlPath),
    markdownPath: reportMarkdownPath,
    htmlPath: reportHtmlPath
  };
}

export async function createResearchProject(
  projectRoot: string,
  input: { title: string; summary?: string; createdByClientId: string }
): Promise<ResearchManifest> {
  const project = await createProject(projectRoot, {
    title: input.title,
    summary: input.summary ?? "",
    createdByClientId: input.createdByClientId,
    entryFile: reportHtmlPath
  });
  const now = new Date().toISOString();
  const metadata: ResearchMetadata = {
    projectId: project.id,
    title: input.title,
    summary: input.summary ?? "",
    createdAt: now,
    updatedAt: now,
    createdByClientId: input.createdByClientId
  };
  await writeResearchMetadata(projectRoot, metadata);
  await writeProjectFile(projectRoot, project.id, researchEvidencePath, "[]\n");
  for (const type of noteTypes) {
    await writeProjectFile(projectRoot, project.id, notePath(type), `# ${type}\n\n`);
  }
  await appendProjectTaskHistory(projectRoot, project.id, {
    toolName: "create_research_project",
    ok: true,
    summary: `Created research project ${project.id}.`,
    details: { projectId: project.id, title: input.title }
  });
  return getResearchManifest(projectRoot, project.id);
}

export async function addResearchSource(
  projectRoot: string,
  projectId: string,
  input: Omit<ResearchSource, "id" | "addedAt">
): Promise<ResearchSource> {
  return withKeyedLock(researchLockKey(projectRoot, projectId), async () => {
    await readResearchMetadata(projectRoot, projectId);
    const id = await nextResearchSourceId(projectRoot, projectId);
    const source = normalizeResearchSource({ ...input, id });
    await writeProjectFile(projectRoot, projectId, sourcePath(id), `${JSON.stringify(source, null, 2)}\n`);
    await touchResearchMetadata(projectRoot, projectId);
    await appendProjectTaskHistory(projectRoot, projectId, {
      toolName: "add_research_source",
      ok: true,
      summary: `Added research source ${id}.`,
      details: { sourceId: id, url: source.url, usedInReport: source.usedInReport }
    });
    return source;
  });
}

export async function listResearchSources(projectRoot: string, projectId: string): Promise<ResearchSource[]> {
  await readResearchMetadata(projectRoot, projectId);
  return readResearchSources(projectRoot, projectId);
}

export async function addResearchNote(
  projectRoot: string,
  projectId: string,
  input: { noteType: ResearchNoteType; content: string; append?: boolean }
): Promise<{ path: string; content: string }> {
  return withKeyedLock(researchLockKey(projectRoot, projectId), async () => {
    await readResearchMetadata(projectRoot, projectId);
    const path = notePath(input.noteType);
    const current = input.append ? await safeReadProjectFile(projectRoot, projectId, path) : undefined;
    const separator = current && !current.endsWith("\n") ? "\n" : "";
    const content = input.append ? `${current ?? ""}${separator}${input.content}` : input.content;
    await writeProjectFile(projectRoot, projectId, path, content.endsWith("\n") ? content : `${content}\n`);
    await touchResearchMetadata(projectRoot, projectId);
    await appendProjectTaskHistory(projectRoot, projectId, {
      toolName: "add_research_note",
      ok: true,
      summary: `Updated research note ${input.noteType}.`,
      details: { noteType: input.noteType, path, append: input.append ?? false }
    });
    return { path, content };
  });
}

export async function recordResearchEvidence(
  projectRoot: string,
  projectId: string,
  input: Omit<ResearchEvidence, "id" | "recordedAt">
): Promise<ResearchEvidence> {
  return withKeyedLock(researchLockKey(projectRoot, projectId), async () => {
    await readResearchMetadata(projectRoot, projectId);
    if (input.url) assertHttpUrl(input.url);
    if (input.reportUrl) assertHttpUrl(input.reportUrl, "reportUrl");
    if (!input.kind.trim()) throw new Error("Evidence kind is required.");
    if (!input.summary.trim()) throw new Error("Evidence summary is required.");
    const evidence = await readResearchEvidence(projectRoot, projectId);
    // Derive from the max existing suffix, not the array length, so removing an
    // item can never mint a duplicate id (matches nextResearchSourceId).
    const nextEvidenceIndex = evidence.reduce((max, e) => {
      const m = /^evidence_(\d+)$/.exec(e.id);
      return m ? Math.max(max, Number.parseInt(m[1], 10)) : max;
    }, 0) + 1;
    const item: ResearchEvidence = {
      id: `evidence_${String(nextEvidenceIndex).padStart(3, "0")}`,
      sourceId: input.sourceId,
      kind: input.kind.trim(),
      url: input.url,
      reportUrl: input.reportUrl,
      summary: input.summary.trim(),
      structuredContent: input.structuredContent,
      recordedAt: new Date().toISOString()
    };
    const next = [...evidence, item];
    await writeProjectFile(projectRoot, projectId, researchEvidencePath, `${JSON.stringify(next, null, 2)}\n`);
    await touchResearchMetadata(projectRoot, projectId);
    await appendProjectTaskHistory(projectRoot, projectId, {
      toolName: "record_research_evidence",
      ok: true,
      summary: `Recorded research evidence ${item.id}.`,
      details: { evidenceId: item.id, sourceId: item.sourceId, kind: item.kind }
    });
    return item;
  });
}

export async function getResearchManifest(projectRoot: string, projectId: string): Promise<ResearchManifest> {
  const [research, projectManifest, sources, notes, evidence, report] = await Promise.all([
    readResearchMetadata(projectRoot, projectId),
    getProjectDeliveryManifest(projectRoot, projectId),
    readResearchSources(projectRoot, projectId),
    getNoteStatuses(projectRoot, projectId),
    readResearchEvidence(projectRoot, projectId),
    getReportStatus(projectRoot, projectId)
  ]);
  return {
    research,
    project: projectManifest.metadata,
    sources,
    notes,
    evidence,
    report,
    publishedUrl: projectManifest.publishedUrl
  };
}

export async function writeResearchReport(
  projectRoot: string,
  projectId: string,
  input: { markdown: string; html: string }
): Promise<ResearchReportStatus> {
  return withKeyedLock(researchLockKey(projectRoot, projectId), async () => {
    await readResearchMetadata(projectRoot, projectId);
    if (!/^\s*<!doctype html>/i.test(input.html) || !/<html[\s>]/i.test(input.html) || !/<\/html>/i.test(input.html)) {
      throw new Error("html must be a complete HTML document with <!doctype html> and <html>.");
    }
    await writeProjectFile(projectRoot, projectId, reportMarkdownPath, input.markdown.endsWith("\n") ? input.markdown : `${input.markdown}\n`);
    await writeProjectFile(projectRoot, projectId, reportHtmlPath, input.html.endsWith("\n") ? input.html : `${input.html}\n`);
    await touchResearchMetadata(projectRoot, projectId);
    await appendProjectTaskHistory(projectRoot, projectId, {
      toolName: "write_research_report",
      ok: true,
      summary: `Wrote research report for ${projectId}.`,
      details: { markdownPath: reportMarkdownPath, htmlPath: reportHtmlPath }
    });
    return getReportStatus(projectRoot, projectId);
  });
}

export async function validateResearchManifest(projectRoot: string, projectId: string): Promise<ResearchValidationResult> {
  const checkedAt = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  let sources: ResearchSource[] = [];
  const report = await getReportStatus(projectRoot, projectId);

  try {
    await readResearchMetadata(projectRoot, projectId);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : `${researchMetadataPath} is missing or invalid.`);
  }

  try {
    sources = await readResearchSources(projectRoot, projectId);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Unable to read research sources.");
  }

  if (sources.length === 0) errors.push("At least one research source is required.");
  for (const source of sources) {
    try {
      normalizeResearchSource(source);
    } catch (error) {
      errors.push(`Invalid source ${source.id}: ${error instanceof Error ? error.message : "invalid source"}`);
    }
    if (source.usedInReport && (!source.title || !source.url || !source.claim || !source.summary || !source.confidence)) {
      errors.push(`Used source ${source.id} is missing required fields.`);
    }
  }

  if (!report.markdownExists) errors.push(`${reportMarkdownPath} is required.`);
  if (!report.htmlExists) errors.push(`${reportHtmlPath} is required.`);

  if (report.htmlExists) {
    const html = await safeReadProjectFile(projectRoot, projectId, reportHtmlPath);
    const referencesSource = sources.some((source) => html?.includes(source.id) || html?.includes(source.url));
    if (!referencesSource) {
      errors.push(`${reportHtmlPath} must reference at least one source id or URL.`);
    }
  }

  const usedSourceCount = sources.filter((source) => source.usedInReport).length;
  if (usedSourceCount === 0 && sources.length > 0) warnings.push("No sources are marked usedInReport.");

  return {
    ok: errors.length === 0,
    projectId,
    checkedAt,
    warnings,
    errors,
    sourceCount: sources.length,
    usedSourceCount,
    report
  };
}

export async function publishResearchReport(
  projectRoot: string,
  projectId: string,
  publicBaseUrl: string,
  options: PublishProjectOptions = {}
): Promise<PublishResearchReportResult> {
  const researchValidation = await validateResearchManifest(projectRoot, projectId);
  const filesBeforePublish = await listProjectFiles(projectRoot, projectId);
  if (!researchValidation.ok) {
    await appendProjectTaskHistory(projectRoot, projectId, {
      toolName: "publish_research_report",
      ok: false,
      summary: `Research publish blocked for ${projectId}.`,
      details: { researchValidation }
    });
    return {
      ok: false,
      projectId,
      entryFile: reportHtmlPath,
      researchValidation,
      files: filesBeforePublish,
      summary: `Research publish blocked for ${projectId}.`,
      nextActions: ["Fix research validation errors before publishing."]
    };
  }

  const projectReport = await publishProjectAndReport(projectRoot, projectId, publicBaseUrl, reportHtmlPath, options);
  await appendProjectTaskHistory(projectRoot, projectId, {
    toolName: "publish_research_report",
    ok: projectReport.ok,
    summary: projectReport.ok
      ? `Published research report ${projectId}.`
      : `Research report project validation failed for ${projectId}.`,
    details: { researchValidation, projectValidation: projectReport.validation, publishedUrl: projectReport.publishedUrl }
  });

  return {
    ok: projectReport.ok,
    projectId,
    publishedUrl: projectReport.publishedUrl,
    entryFile: reportHtmlPath,
    researchValidation,
    projectValidation: projectReport.validation,
    files: projectReport.files,
    summary: projectReport.ok ? `Published research report at ${projectReport.publishedUrl}.` : projectReport.summary,
    nextActions: projectReport.ok ? ["Return the publishedUrl to the user."] : projectReport.nextActions
  };
}

export async function getResearchSummary(projectRoot: string, projectId: string): Promise<{
  sourceCount: number;
  usedSourceCount: number;
  evidenceCount: number;
  report: ResearchReportStatus;
} | undefined> {
  try {
    const manifest = await getResearchManifest(projectRoot, projectId);
    return {
      sourceCount: manifest.sources.length,
      usedSourceCount: manifest.sources.filter((source) => source.usedInReport).length,
      evidenceCount: manifest.evidence.length,
      report: manifest.report
    };
  } catch {
    return undefined;
  }
}
