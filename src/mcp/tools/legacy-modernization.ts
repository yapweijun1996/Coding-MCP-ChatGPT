import path from "node:path";
import { z } from "zod";
import { appendProjectTaskHistory, getProjectManifest, readProjectFile, validateProject, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const modernizeLegacyProjectSchema = z.object({
  projectId: z.string().min(8).max(80),
  entryFile: z.string().min(1).max(240).optional(),
  outputDir: z.string().min(1).max(160).default("modernized"),
  mode: z.enum(["plan", "apply"]).default("apply"),
  preserveOriginal: z.boolean().default(true),
  validate: z.boolean().default(true)
});

type ModernizationFinding = {
  id: string;
  severity: "low" | "medium" | "high";
  message: string;
  recommendation: string;
};

function safeSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "modernized";
}

function outputPath(outputDir: string, filename: string): string {
  const clean = outputDir.split("/").map(safeSegment).filter(Boolean).join("/") || "modernized";
  return `${clean}/${filename}`;
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractTagBlocks(html: string, tag: "style" | "script") {
  const blocks: Array<{ full: string; attrs: string; content: string }> = [];
  const pattern = tag === "style"
    ? /<style\b([^>]*)>([\s\S]*?)<\/style>/gi
    : /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    blocks.push({ full: match[0], attrs: match[1] ?? "", content: match[2] ?? "" });
  }
  return blocks;
}

function hasSrc(attrs: string): boolean {
  return /\bsrc\s*=/i.test(attrs);
}

function hasHref(attrs: string): boolean {
  return /\bhref\s*=/i.test(attrs);
}

function analyzeLegacyHtml(html: string): ModernizationFinding[] {
  const findings: ModernizationFinding[] = [];
  const inlineStyles = extractTagBlocks(html, "style");
  const inlineScripts = extractTagBlocks(html, "script").filter((block) => !hasSrc(block.attrs));
  const inlineHandlers = html.match(/\son[a-z]+\s*=/gi) ?? [];
  const inlineStyleAttrs = html.match(/\sstyle\s*=/gi) ?? [];
  const duplicateIds = duplicateMatches([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1] ?? ""));
  if (inlineStyles.length) findings.push({ id: "inline-style-blocks", severity: "medium", message: `${inlineStyles.length} inline <style> block(s) found.`, recommendation: "Extract shared styles into a stylesheet and keep the HTML focused on structure." });
  if (inlineScripts.length) findings.push({ id: "inline-script-blocks", severity: "medium", message: `${inlineScripts.length} inline <script> block(s) found.`, recommendation: "Extract behavior into a JavaScript module or app script with a clear bootstrap boundary." });
  if (inlineHandlers.length) findings.push({ id: "inline-event-handlers", severity: "high", message: `${inlineHandlers.length} inline event handler attribute(s) found.`, recommendation: "Move event handlers into delegated JavaScript listeners where feasible." });
  if (inlineStyleAttrs.length) findings.push({ id: "inline-style-attributes", severity: "medium", message: `${inlineStyleAttrs.length} inline style attribute(s) found.`, recommendation: "Move repeated visual rules into CSS classes and tokens." });
  if (duplicateIds.length) findings.push({ id: "duplicate-ids", severity: "high", message: `Duplicate id value(s): ${duplicateIds.join(", ")}.`, recommendation: "Make ids unique before wiring modular JavaScript." });
  if (html.length > 20000) findings.push({ id: "large-single-file", severity: "medium", message: `Entry file is ${html.length} character(s).`, recommendation: "Split large single-file demos into HTML, CSS, JS, and docs." });
  if (!/<meta\s+name=["']viewport["']/i.test(html)) findings.push({ id: "missing-viewport", severity: "low", message: "Viewport meta tag is missing.", recommendation: "Add a responsive viewport meta tag during modernization." });
  return findings;
}

function duplicateMatches(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value).sort();
}

function relativeAssetReference(fromFile: string, toFile: string): string {
  const fromDir = path.posix.dirname(fromFile.replaceAll("\\", "/"));
  const rel = path.posix.relative(fromDir === "." ? "" : fromDir, toFile.replaceAll("\\", "/"));
  return rel || path.posix.basename(toFile);
}

function stripEmptyLines(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function ensureViewport(html: string): string {
  if (/<meta\s+name=["']viewport["']/i.test(html)) return html;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b([^>]*)>/i, `<head$1>\n  <meta name="viewport" content="width=device-width, initial-scale=1">`);
  return html;
}

function modernizeHtml(html: string, cssPath: string, jsPath: string, outputEntry: string) {
  const styleBlocks = extractTagBlocks(html, "style");
  const inlineScriptBlocks = extractTagBlocks(html, "script").filter((block) => !hasSrc(block.attrs));
  const css = stripEmptyLines(styleBlocks.map((block, index) => `/* Extracted from inline <style> block ${index + 1}. */\n${block.content.trim()}`).filter(Boolean).join("\n\n"));
  const js = stripEmptyLines(inlineScriptBlocks.map((block, index) => `// Extracted from inline <script> block ${index + 1}.\n${block.content.trim()}`).filter(Boolean).join("\n\n"));
  let nextHtml = html;
  for (const block of styleBlocks) nextHtml = nextHtml.replace(block.full, "");
  for (const block of inlineScriptBlocks) nextHtml = nextHtml.replace(block.full, "");
  nextHtml = ensureViewport(nextHtml);
  const cssHref = relativeAssetReference(outputEntry, cssPath);
  const jsSrc = relativeAssetReference(outputEntry, jsPath);
  if (css) {
    if (/<\/head>/i.test(nextHtml)) nextHtml = nextHtml.replace(/<\/head>/i, `  <link rel="stylesheet" href="${cssHref}">\n</head>`);
    else nextHtml = `<link rel="stylesheet" href="${cssHref}">\n${nextHtml}`;
  }
  if (js) {
    if (/<\/body>/i.test(nextHtml)) nextHtml = nextHtml.replace(/<\/body>/i, `  <script src="${jsSrc}" defer></script>\n</body>`);
    else nextHtml = `${nextHtml}\n<script src="${jsSrc}" defer></script>`;
  }
  return { html: `${stripEmptyLines(nextHtml)}\n`, css: css ? `${css}\n` : "", js: js ? `${js}\n` : "" };
}

function renderMarkdownReport(input: {
  projectId: string;
  sourceEntry: string;
  outputEntry: string;
  files: string[];
  findings: ModernizationFinding[];
  mode: "plan" | "apply";
  validation?: unknown;
}) {
  const findingRows = input.findings.length
    ? input.findings.map((finding) => `| ${finding.severity} | ${finding.id} | ${finding.message} | ${finding.recommendation} |`).join("\n")
    : "| low | none | No legacy findings detected. | Keep project modular and validated. |";
  return `# Legacy Modernization Report

Project: \`${input.projectId}\`

## Summary

- Mode: \`${input.mode}\`
- Source entry: \`${input.sourceEntry}\`
- Modernized entry: \`${input.outputEntry}\`
- Files produced: ${input.files.length}

## Findings

| Severity | ID | Message | Recommendation |
| --- | --- | --- | --- |
${findingRows}

## Migration Plan

1. Preserve the original source entry for comparison.
2. Extract inline CSS into a dedicated stylesheet.
3. Extract inline JavaScript into a dedicated app script.
4. Add responsive viewport metadata when missing.
5. Validate the modernized entry and compare behavior with focused browser checks.

## Files

${input.files.map((file) => `- \`${file}\``).join("\n") || "- No files written in plan mode."}
`;
}

export const legacyModernizationTools: ToolModule[] = [
  {
    definition: {
      name: "modernize_legacy_project",
      description: "Analyze an older single-file or messy static project, generate a migration plan, optionally split inline HTML/CSS/JS into modular files, preserve the original, validate the modernized entry, and write migration reports.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          entryFile: { type: "string" },
          outputDir: { type: "string" },
          mode: { type: "string", enum: ["plan", "apply"] },
          preserveOriginal: { type: "boolean" },
          validate: { type: "boolean" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: modernizeLegacyProjectSchema,
    handler: async (input, ctx) => {
      const parsed = modernizeLegacyProjectSchema.parse(input);
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const sourceEntry = parsed.entryFile ?? manifest.entryFile;
      const sourceHtml = await readProjectFile(ctx.projectRoot, parsed.projectId, sourceEntry, 2 * 1024 * 1024);
      const findings = analyzeLegacyHtml(sourceHtml);
      const outputEntry = outputPath(parsed.outputDir, "index.html");
      const cssPath = outputPath(parsed.outputDir, "styles.css");
      const jsPath = outputPath(parsed.outputDir, "app.js");
      const jsonReportPath = outputPath(parsed.outputDir, "migration-report.json");
      const markdownReportPath = outputPath(parsed.outputDir, "migration-report.md");
      const migrated = modernizeHtml(sourceHtml, cssPath, jsPath, outputEntry);
      const plannedFiles = [
        outputEntry,
        ...(migrated.css ? [cssPath] : []),
        ...(migrated.js ? [jsPath] : []),
        jsonReportPath,
        markdownReportPath
      ];
      const written: string[] = [];
      let validation: Awaited<ReturnType<typeof validateProject>> | undefined;
      if (parsed.mode === "apply") {
        await writeProjectFile(ctx.projectRoot, parsed.projectId, outputEntry, migrated.html);
        written.push(outputEntry);
        if (migrated.css) {
          await writeProjectFile(ctx.projectRoot, parsed.projectId, cssPath, migrated.css);
          written.push(cssPath);
        }
        if (migrated.js) {
          await writeProjectFile(ctx.projectRoot, parsed.projectId, jsPath, migrated.js);
          written.push(jsPath);
        }
        if (parsed.validate) validation = await validateProject(ctx.projectRoot, parsed.projectId, outputEntry, "static_html");
      }
      const report = {
        projectId: parsed.projectId,
        sourceEntry,
        outputEntry,
        mode: parsed.mode,
        preserveOriginal: parsed.preserveOriginal,
        findings,
        plannedFiles,
        writtenFiles: written,
        extracted: {
          cssBytes: migrated.css.length,
          jsBytes: migrated.js.length,
          htmlBytes: migrated.html.length
        },
        validation
      };
      const markdown = renderMarkdownReport({ projectId: parsed.projectId, sourceEntry, outputEntry, files: parsed.mode === "apply" ? written : plannedFiles, findings, mode: parsed.mode, validation });
      await writeProjectFile(ctx.projectRoot, parsed.projectId, jsonReportPath, `${JSON.stringify(report, null, 2)}\n`);
      await writeProjectFile(ctx.projectRoot, parsed.projectId, markdownReportPath, markdown);
      const artifacts = [...written, jsonReportPath, markdownReportPath];
      const ok = parsed.mode === "plan" || !validation || validation.ok;
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, {
        toolName: "modernize_legacy_project",
        ok,
        summary: parsed.mode === "plan" ? `Generated legacy modernization plan for ${sourceEntry}.` : `Modernized ${sourceEntry} into ${outputEntry}.`,
        details: report
      });
      return {
        ok,
        summary: parsed.mode === "plan"
          ? `Generated modernization plan with ${findings.length} finding(s).`
          : ok ? `Modernized legacy project into ${outputEntry}.` : `Modernized legacy project, but validation found ${validation?.errors.length ?? 0} error(s).`,
        jobId: parsed.projectId,
        artifacts,
        structuredContent: report,
        logs: [JSON.stringify(report, null, 2), markdown],
        errors: validation?.errors ?? []
      };
    }
  }
];
