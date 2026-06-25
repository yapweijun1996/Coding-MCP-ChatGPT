import { z } from "zod";
import { appendProjectTaskHistory, getProjectManifest, readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ProjectManifest, ProjectTaskHistoryItem } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const generateProjectDocsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  version: z.string().min(1).max(80).default("v0.1.0"),
  readmePath: z.string().min(1).max(240).default("README.md"),
  changelogPath: z.string().min(1).max(240).default("CHANGELOG.md"),
  includeHistoryLimit: z.number().int().min(1).max(100).default(30),
  knownLimitations: z.array(z.string().min(1).max(400)).max(50).default([]),
  nextSteps: z.array(z.string().min(1).max(400)).max(50).default([]),
  validationReportPath: z.string().min(1).max(240).optional()
});

function compact(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text || undefined;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function attr(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return compact(match?.[1] ?? match?.[2] ?? match?.[3]);
}

function extractHtmlSummary(html: string) {
  const title = compact(stripTags(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ""));
  const h1 = compact(stripTags(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? ""));
  const descriptionTag = [...html.matchAll(/<meta\b[^>]*>/gi)].find((match) => attr(match[0], "name")?.toLowerCase() === "description")?.[0];
  return { title, heading: h1, description: attr(descriptionTag ?? "", "content") };
}

function inferTech(files: string[]): string[] {
  const tech = new Set<string>();
  if (files.some((file) => /\.html?$/i.test(file))) tech.add("Static HTML");
  if (files.some((file) => /\.css$/i.test(file))) tech.add("CSS");
  if (files.some((file) => /\.(js|mjs)$/i.test(file))) tech.add("JavaScript");
  if (files.some((file) => /\.(ts|tsx)$/i.test(file))) tech.add("TypeScript");
  if (files.some((file) => /\.tsx$/i.test(file))) tech.add("React");
  if (files.some((file) => /\.(png|jpe?g|webp|gif|svg)$/i.test(file))) tech.add("Image/SVG assets");
  if (files.some((file) => /\.(mp3|wav|ogg|mp4|webm)$/i.test(file))) tech.add("Media assets");
  if (files.some((file) => /\.webmanifest$/i.test(file))) tech.add("PWA manifest");
  return [...tech];
}

function inferFeatures(manifest: ProjectManifest, html?: { title?: string; heading?: string; description?: string }): string[] {
  const features = new Set<string>();
  if (html?.heading) features.add(html.heading);
  if (html?.description) features.add(html.description);
  const filePaths = manifest.files.map((file) => file.path);
  if (filePaths.some((file) => /mock-api|routes\.json|client\.js/i.test(file))) features.add("Mock API fixtures for frontend states");
  if (filePaths.some((file) => /i18n|locales?|translations?/i.test(file))) features.add("Internationalization resources");
  if (filePaths.some((file) => /asset-optimization|optimized-assets|optimized-svgs/i.test(file))) features.add("Published asset optimization reports");
  if (filePaths.some((file) => /security|compliance/i.test(file))) features.add("Security or compliance audit artifacts");
  if (filePaths.some((file) => /test|qa|report|audit/i.test(file))) features.add("Generated QA/reporting artifacts");
  for (const item of manifest.taskHistory.slice(-20)) {
    if (/created|generated|added|published|exported|optimized|audited|scanned/i.test(item.summary)) features.add(item.summary.replace(/\.$/, ""));
  }
  if (features.size === 0) features.add(`${manifest.metadata.title} project files and entry page`);
  return [...features].slice(0, 12);
}

function historyEntries(history: ProjectTaskHistoryItem[]) {
  const added: string[] = [];
  const changed: string[] = [];
  const fixed: string[] = [];
  const validation: string[] = [];
  const limitations: string[] = [];
  for (const item of history) {
    const text = item.summary.replace(/\.$/, "");
    if (!item.ok) limitations.push(text);
    else if (/fix|repair|resolve|resolved|patch/i.test(text)) fixed.push(text);
    else if (/validat|audit|inspect|scan|test|check/i.test(text)) validation.push(text);
    else if (/publish|create|add|generate|export|write/i.test(text)) added.push(text);
    else changed.push(text);
  }
  return { added: unique(added), changed: unique(changed), fixed: unique(fixed), validation: unique(validation), limitations: unique(limitations) };
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(0, 16);
}

function bullets(items: string[], fallback: string): string {
  return (items.length ? items : [fallback]).map((item) => `- ${item}`).join("\n");
}

function renderReadme(input: {
  manifest: ProjectManifest;
  html?: { title?: string; heading?: string; description?: string };
  tech: string[];
  features: string[];
  limitations: string[];
  nextSteps: string[];
  validationReportPath?: string;
}) {
  const project = input.manifest;
  const title = input.html?.title ?? project.metadata.title;
  const summary = input.html?.description ?? project.metadata.summary ?? `Project ${project.metadata.id}.`;
  const validation = project.lastValidation;
  const published = project.publishedUrl ?? "Not published yet.";
  const validationLines = [
    validation ? `Status: ${validation.status} (${validation.ok ? "passing" : "not passing"})` : "Status: not recorded",
    validation ? `Entry file: ${validation.entryFile}` : `Entry file: ${project.entryFile}`,
    validation ? `Files checked: ${validation.filesChecked}` : `Files checked: ${project.files.length}`,
    ...(validation?.browserInspection?.reportUrl ? [`Browser inspection: ${validation.browserInspection.reportUrl}`] : []),
    ...(input.validationReportPath ? [`Validation report: ${input.validationReportPath}`] : [])
  ];
  return `# ${title}

${summary}

## Project

- Project ID: \`${project.metadata.id}\`
- Entry file: \`${project.entryFile}\`
- Published URL: ${published}
- Created: ${project.metadata.createdAt}
- Updated: ${project.metadata.updatedAt}

## Features

${bullets(input.features, "Project feature summary not recorded yet.")}

## Technology

${bullets(input.tech, "Static project files")}

## Run And Use

- Open \`${project.entryFile}\` from the project files for local review.
- Use the published URL above for shareable demo review when available.
- Re-run validation after changing HTML, CSS, JavaScript, assets, or generated reports.

## Validation

${bullets(validationLines, "Validation not recorded.")}

## Known Limitations

${bullets(input.limitations, "No known limitations recorded.")}

## Next Steps

${bullets(input.nextSteps, "Run final validation and browser QA before handoff.")}

## Files

${project.files.slice(0, 30).map((file) => `- \`${file.path}\` (${file.size} bytes)`).join("\n") || "- No files recorded."}
`;
}

function renderChangelog(input: {
  version: string;
  date: string;
  projectTitle: string;
  entries: ReturnType<typeof historyEntries>;
  validationStatus: string;
  publishedUrl?: string;
  knownLimitations: string[];
  nextSteps: string[];
}) {
  return `# Changelog

## ${input.version} - ${input.date}

### Added
${bullets(input.entries.added, `Generated documentation for ${input.projectTitle}.`)}

### Changed
${bullets(input.entries.changed, "No changed items inferred from project history.")}

### Fixed
${bullets(input.entries.fixed, "No fixes inferred from project history.")}

### Validation
- ${input.validationStatus}
${input.publishedUrl ? `- Published URL: ${input.publishedUrl}` : "- Published URL not recorded."}
${input.entries.validation.map((item) => `- ${item}`).join("\n") || "- No validation task history inferred."}

### Known Limitations
${bullets(unique([...input.knownLimitations, ...input.entries.limitations]), "No known limitations recorded.")}

### Next Steps
${bullets(input.nextSteps, "Run validation and browser QA before the next release.")}
`;
}

export const projectDocsTools: ToolModule[] = [
  {
    definition: {
      name: "generate_project_docs",
      description: "Generate durable project README and CHANGELOG files from project files, task history, validation results, published URL, inferred features, known limitations, and next steps.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          version: { type: "string" },
          readmePath: { type: "string" },
          changelogPath: { type: "string" },
          includeHistoryLimit: { type: "number" },
          knownLimitations: { type: "array", items: { type: "string" } },
          nextSteps: { type: "array", items: { type: "string" } },
          validationReportPath: { type: "string" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: generateProjectDocsInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateProjectDocsInputSchema.parse(input);
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const entryHtml = await readProjectFile(ctx.projectRoot, parsed.projectId, manifest.entryFile, 2 * 1024 * 1024).catch(() => "");
      const html = entryHtml ? extractHtmlSummary(entryHtml) : undefined;
      const tech = inferTech(manifest.files.map((file) => file.path));
      const history = manifest.taskHistory.slice(-parsed.includeHistoryLimit);
      const entries = historyEntries(history);
      const limitations = unique([...parsed.knownLimitations, ...entries.limitations, ...(manifest.lastValidation?.errors ?? [])]);
      const nextSteps = unique(parsed.nextSteps.length ? parsed.nextSteps : [
        ...(manifest.lastValidation?.ok ? [] : ["Run validate_project and resolve blocking errors."]),
        ...(manifest.publishedUrl ? ["Share the published URL with reviewers."] : ["Publish the project after validation passes."]),
        "Keep README and CHANGELOG updated after major feature or asset changes."
      ]);
      const readme = renderReadme({ manifest, html, tech, features: inferFeatures(manifest, html), limitations, nextSteps, validationReportPath: parsed.validationReportPath });
      const validationStatus = manifest.lastValidation ? `Validation ${manifest.lastValidation.status} at ${manifest.lastValidation.checkedAt}.` : "Validation not recorded.";
      const changelog = renderChangelog({ version: parsed.version, date: new Date().toISOString().slice(0, 10), projectTitle: manifest.metadata.title, entries, validationStatus, publishedUrl: manifest.publishedUrl, knownLimitations: limitations, nextSteps });
      const readmeFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.readmePath, readme);
      const changelogFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.changelogPath, changelog);
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "generate_project_docs", ok: true, summary: `Generated README and CHANGELOG for ${manifest.metadata.title}.`, details: { readmePath: readmeFile.path, changelogPath: changelogFile.path, version: parsed.version, featureCount: inferFeatures(manifest, html).length } });
      return { ok: true, summary: `Generated README and CHANGELOG for ${manifest.metadata.title}.`, jobId: parsed.projectId, previewUrl: manifest.publishedUrl, shareUrl: manifest.publishedUrl, artifacts: [readmeFile.path, changelogFile.path], structuredContent: { projectId: parsed.projectId, readmePath: readmeFile.path, changelogPath: changelogFile.path, version: parsed.version, features: inferFeatures(manifest, html), limitations, nextSteps, publishedUrl: manifest.publishedUrl, validation: manifest.lastValidation }, logs: [readme, changelog], errors: [] };
    }
  }
];
