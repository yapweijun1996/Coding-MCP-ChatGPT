import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  addProjectReviewComments,
  getProject,
  getProjectFilesDirectory,
  listProjectFiles,
  validateProject,
  writeProjectFile,
  type ProjectReviewCommentInput
} from "../../projects/store.js";
import type { ToolModule } from "../types.js";

// ── Finding types ────────────────────────────────────────────────────────────

type ReviewSeverity = "low" | "medium" | "high" | "critical";
type ReviewCategory =
  | "accessibility"
  | "performance"
  | "maintainability"
  | "security"
  | "duplication"
  | "naming";

interface CodeReviewFinding {
  title: string;
  detail: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  evidence: string;
  suggestion: string;
}

// ── Input schema ─────────────────────────────────────────────────────────────

const reviewProjectCodeSchema = z.object({
  projectId: z.string().min(8).max(80),
  entryFile: z.string().min(1).max(240).optional(),
  scopePaths: z.array(z.string().min(1).max(240)).max(50).optional(),
  includeValidation: z.boolean().optional().default(true),
  syncComments: z.boolean().optional().default(true),
  outputMarkdownPath: z.string().min(1).max(240).optional().default("review/code-review.md"),
  outputJsonPath: z.string().min(1).max(240).optional().default("review/code-review.json")
});

// ── Static analysis helpers ──────────────────────────────────────────────────

const textExtensions = new Set([".html", ".css", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".svg"]);
const scriptExtensions = new Set([".js", ".mjs", ".ts", ".tsx", ".jsx"]);
const maxReadBytes = 200 * 1024;

function charIndexToLine(content: string, charIndex: number): number {
  const before = content.slice(0, Math.max(0, charIndex));
  return before.split(/\r?\n/).length;
}

function analyzeHtml(content: string, filePath: string): CodeReviewFinding[] {
  const findings: CodeReviewFinding[] = [];

  if (/<html[\s>]/i.test(content) && !/<title[\s>]/i.test(content)) {
    findings.push({
      title: "Missing <title> element",
      detail: "HTML document has no <title> element. Required for accessibility, browser tab labeling, and SEO.",
      severity: "medium",
      category: "accessibility",
      filePath,
      evidence: "No <title> tag found in document",
      suggestion: "Add a descriptive <title> element inside <head>."
    });
  }

  if (/<html(?![^>]*lang=)[^>]*>/i.test(content)) {
    findings.push({
      title: "Missing lang attribute on <html>",
      detail: "The <html> element has no lang attribute, forcing screen readers to guess the document language.",
      severity: "low",
      category: "accessibility",
      filePath,
      evidence: "No lang= attribute on <html>",
      suggestion: 'Add lang="en" (or the appropriate language code) to the <html> element.'
    });
  }

  if (!/<meta[^>]+name\s*=\s*["']viewport["']/i.test(content)) {
    findings.push({
      title: "Missing viewport meta tag",
      detail: "No <meta name=\"viewport\"> found. Pages without a viewport meta tag render incorrectly on mobile devices.",
      severity: "medium",
      category: "performance",
      filePath,
      evidence: "No meta[name=viewport] found",
      suggestion: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> inside <head>.'
    });
  }

  const imgNoAlt = [...content.matchAll(/<img(?![^>]*\balt\s*=)[^>]*/gi)];
  if (imgNoAlt.length > 0) {
    const lineStart = charIndexToLine(content, imgNoAlt[0].index ?? 0);
    findings.push({
      title: `${imgNoAlt.length} image(s) missing alt attribute`,
      detail: `Found ${imgNoAlt.length} <img> element(s) without alt attributes. Screen readers cannot describe these images.`,
      severity: "medium",
      category: "accessibility",
      filePath,
      lineStart,
      evidence: imgNoAlt[0][0].slice(0, 120),
      suggestion: 'Add descriptive alt="..." to all images. Use alt="" for decorative-only images.'
    });
  }

  const emptyButtons = [...content.matchAll(/<button(?![^>]*aria-label)[^>]*>\s*(<\/button>|$)/gi)];
  if (emptyButtons.length > 0) {
    const lineStart = charIndexToLine(content, emptyButtons[0].index ?? 0);
    findings.push({
      title: `${emptyButtons.length} button(s) without accessible text`,
      detail: "Buttons with no text content and no aria-label are invisible to screen reader users.",
      severity: "high",
      category: "accessibility",
      filePath,
      lineStart,
      evidence: emptyButtons[0][0].slice(0, 120),
      suggestion: "Add text content or an aria-label to every button."
    });
  }

  const inlineHandlers = [...content.matchAll(/\bon[a-z]+=["'][^"']{0,}/gi)];
  if (inlineHandlers.length > 3) {
    const lineStart = charIndexToLine(content, inlineHandlers[0].index ?? 0);
    findings.push({
      title: `${inlineHandlers.length} inline event handler(s) detected`,
      detail: "Inline event handlers (onclick=, onchange=, etc.) mix behavior and markup and resist CSP hardening.",
      severity: "medium",
      category: "maintainability",
      filePath,
      lineStart,
      evidence: inlineHandlers.slice(0, 2).map((m) => m[0].slice(0, 60)).join("; "),
      suggestion: "Move event handlers to a separate script file and use addEventListener()."
    });
  }

  const inlineScripts = [...content.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of inlineScripts) {
    const scriptLines = (match[1] ?? "").split(/\r?\n/).length;
    if (scriptLines > 50) {
      findings.push({
        title: `Large inline <script> block (${scriptLines} lines)`,
        detail: `An inline <script> block has ${scriptLines} lines. Large inline scripts are hard to test, cache, and maintain.`,
        severity: "medium",
        category: "performance",
        filePath,
        lineStart: charIndexToLine(content, match.index ?? 0),
        evidence: `Inline script of ${scriptLines} lines`,
        suggestion: 'Extract to a separate .js file and load with <script src="...">.'
      });
    }
  }

  const inlineStyles = [...content.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
  for (const match of inlineStyles) {
    const styleLines = (match[1] ?? "").split(/\r?\n/).length;
    if (styleLines > 50) {
      findings.push({
        title: `Large inline <style> block (${styleLines} lines)`,
        detail: `An inline <style> block has ${styleLines} lines. Large inline styles block rendering and are hard to maintain.`,
        severity: "low",
        category: "maintainability",
        filePath,
        lineStart: charIndexToLine(content, match.index ?? 0),
        evidence: `Inline style of ${styleLines} lines`,
        suggestion: 'Extract to a separate .css file and link with <link rel="stylesheet" href="...">.'
      });
    }
  }

  const innerHtmlMatches = [...content.matchAll(/\.innerHTML\s*=|\.outerHTML\s*=/g)];
  if (innerHtmlMatches.length > 0) {
    const lineStart = charIndexToLine(content, innerHtmlMatches[0].index ?? 0);
    findings.push({
      title: "Unsanitized innerHTML/outerHTML assignment in inline script",
      detail: "Direct innerHTML/outerHTML assignment is a common XSS vector when user-controlled data is involved.",
      severity: "high",
      category: "security",
      filePath,
      lineStart,
      evidence: content.slice(Math.max(0, (innerHtmlMatches[0].index ?? 0) - 20), (innerHtmlMatches[0].index ?? 0) + 60).trim(),
      suggestion: "Use textContent for plain text, or a trusted sanitizer (DOMPurify) for HTML output."
    });
  }

  return findings;
}

function analyzeCss(content: string, filePath: string): CodeReviewFinding[] {
  const findings: CodeReviewFinding[] = [];
  const lineCount = content.split(/\r?\n/).length;

  if (lineCount > 300) {
    findings.push({
      title: `Large CSS file (${lineCount} lines)`,
      detail: `This CSS file has ${lineCount} lines. Large CSS files are harder to maintain and can slow initial render.`,
      severity: "medium",
      category: "maintainability",
      filePath,
      evidence: `${lineCount} lines`,
      suggestion: "Split into smaller component-scoped CSS files."
    });
  }

  const importantCount = (content.match(/!important/gi) ?? []).length;
  if (importantCount > 5) {
    findings.push({
      title: `Excessive !important usage (${importantCount} times)`,
      detail: `Found ${importantCount} !important declarations. Overuse breaks cascade predictability and makes debugging harder.`,
      severity: "low",
      category: "maintainability",
      filePath,
      evidence: `${importantCount} !important occurrences`,
      suggestion: "Refactor specificity via proper cascade instead of !important overrides."
    });
  }

  const todoMatches = [...content.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)]
    .filter((m) => /\b(TODO|FIXME)\b/i.test(m[0]));
  if (todoMatches.length > 0) {
    findings.push({
      title: `${todoMatches.length} TODO/FIXME comment(s) in CSS`,
      detail: "Unresolved TODO/FIXME comments indicate incomplete or deferred work.",
      severity: "low",
      category: "maintainability",
      filePath,
      lineStart: charIndexToLine(content, todoMatches[0].index ?? 0),
      evidence: todoMatches[0][0].slice(0, 80),
      suggestion: "Resolve or convert to tracked issues."
    });
  }

  const pxValues = content.match(/\b\d+px\b/g) ?? [];
  const pxCount = new Map<string, number>();
  for (const v of pxValues) pxCount.set(v, (pxCount.get(v) ?? 0) + 1);
  const overused = [...pxCount.entries()].filter(([, c]) => c >= 8).sort((a, b) => b[1] - a[1]);
  if (overused.length > 0) {
    const top = overused[0];
    findings.push({
      title: `Repeated hardcoded pixel values (e.g. ${top[0]} used ${top[1]}×)`,
      detail: "Repeated hardcoded pixel values indicate missing CSS custom properties (design tokens).",
      severity: "low",
      category: "duplication",
      filePath,
      evidence: overused.slice(0, 3).map(([v, c]) => `${v} ×${c}`).join(", "),
      suggestion: "Extract repeated values into CSS custom properties (--spacing-md: 16px) and reference them."
    });
  }

  return findings;
}

function analyzeScript(content: string, filePath: string): CodeReviewFinding[] {
  const findings: CodeReviewFinding[] = [];
  const lineCount = content.split(/\r?\n/).length;

  if (lineCount > 300) {
    findings.push({
      title: `Large script file (${lineCount} lines)`,
      detail: `This file has ${lineCount} lines. Oversized scripts are harder to test and maintain.`,
      severity: "medium",
      category: "maintainability",
      filePath,
      evidence: `${lineCount} lines`,
      suggestion: "Split into smaller single-responsibility modules."
    });
  }

  const responsibilities: string[] = [
    /<[A-Z][A-Za-z0-9]*[\s>]|React|useState|useEffect/.test(content) ? "ui" : "",
    /\b(fetch|axios|XMLHttpRequest)\b/.test(content) ? "network" : "",
    /\b(fs\.|readFile|writeFile|readdir)\b/.test(content) ? "filesystem" : "",
    /\b(exec|spawn|child_process)\b/.test(content) ? "process" : "",
    /\bSELECT\b|\bINSERT\b|\bUPDATE\b/.test(content) ? "database" : "",
    /\bprocess\.env\b/.test(content) ? "configuration" : ""
  ].filter(Boolean);
  if (responsibilities.length >= 3) {
    findings.push({
      title: `Mixed responsibilities: ${responsibilities.join(", ")}`,
      detail: `File combines ${responsibilities.length} concerns (${responsibilities.join(", ")}), making individual behaviors hard to test.`,
      severity: "medium",
      category: "maintainability",
      filePath,
      evidence: `Responsibilities: ${responsibilities.join(", ")}`,
      suggestion: "Split into modules: one per responsibility. Use dependency injection for cross-cutting concerns."
    });
  }

  const innerHtmlMatches = [...content.matchAll(/\.innerHTML\s*=|\.outerHTML\s*=/g)];
  if (innerHtmlMatches.length > 0) {
    findings.push({
      title: `${innerHtmlMatches.length} innerHTML/outerHTML assignment(s)`,
      detail: "Direct innerHTML/outerHTML assignment is a common XSS vector if user-controlled data flows in.",
      severity: "high",
      category: "security",
      filePath,
      lineStart: charIndexToLine(content, innerHtmlMatches[0].index ?? 0),
      evidence: content.slice(Math.max(0, (innerHtmlMatches[0].index ?? 0) - 20), (innerHtmlMatches[0].index ?? 0) + 60).trim(),
      suggestion: "Use textContent for plain text, or a trusted sanitizer (DOMPurify) for HTML output."
    });
  }

  const evalMatches = [...content.matchAll(/\beval\s*\(|new\s+Function\s*\(/g)];
  if (evalMatches.length > 0) {
    findings.push({
      title: "eval() or new Function() detected",
      detail: "Dynamic code execution via eval()/new Function() is a security risk and defeats static analysis.",
      severity: "high",
      category: "security",
      filePath,
      lineStart: charIndexToLine(content, evalMatches[0].index ?? 0),
      evidence: evalMatches[0][0],
      suggestion: "Replace with safe alternatives: JSON.parse() for data, explicit named functions for behavior."
    });
  }

  const todos = content.match(/\/\/\s*(TODO|FIXME)[^\n]*/gi) ?? [];
  if (todos.length > 3) {
    findings.push({
      title: `${todos.length} TODO/FIXME comment(s)`,
      detail: "Many unresolved TODO/FIXME comments indicate accumulated technical debt.",
      severity: "low",
      category: "maintainability",
      filePath,
      evidence: todos.slice(0, 2).join("; ").slice(0, 120),
      suggestion: "Resolve or convert to tracked issues."
    });
  }

  const importCount = (content.match(/^\s*import\s.+from\s/mg) ?? []).length;
  if (importCount >= 20) {
    findings.push({
      title: `High import count (${importCount} imports)`,
      detail: `File imports from ${importCount} modules, suggesting too many responsibilities or a need to split.`,
      severity: "low",
      category: "naming",
      filePath,
      evidence: `${importCount} import statements`,
      suggestion: "Group related imports behind a barrel module or split the file."
    });
  }

  return findings;
}

// ── Report generation ────────────────────────────────────────────────────────

function severityOrder(s: ReviewSeverity): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[s];
}

function severityEmoji(s: ReviewSeverity): string {
  return { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" }[s];
}

function buildMarkdownReport(
  projectId: string,
  findings: CodeReviewFinding[],
  metrics: Record<string, unknown>,
  nextActions: string[],
  validationResult: { ok: boolean; errors: string[]; warnings: string[] } | null
): string {
  const sorted = [...findings].sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));
  const bySeverity: Record<ReviewSeverity, CodeReviewFinding[]> = {
    critical: sorted.filter((f) => f.severity === "critical"),
    high: sorted.filter((f) => f.severity === "high"),
    medium: sorted.filter((f) => f.severity === "medium"),
    low: sorted.filter((f) => f.severity === "low")
  };

  function findingBlock(f: CodeReviewFinding, idx: number): string {
    const loc = f.filePath
      ? `\`${f.filePath}${f.lineStart ? `:${f.lineStart}` : ""}\``
      : "_project-level_";
    return [
      `#### ${idx + 1}. ${f.title}`,
      `- **Location**: ${loc}`,
      `- **Category**: ${f.category}`,
      `- **Evidence**: ${f.evidence}`,
      `- **Suggestion**: ${f.suggestion}`,
      "",
      `> ${f.detail}`
    ].join("\n");
  }

  const sections: string[] = [
    `# Code Review Report`,
    "",
    `- **Project**: \`${projectId}\``,
    `- **Files scanned**: ${metrics.filesScanned}`,
    `- **Total findings**: ${findings.length} (${bySeverity.critical.length} critical, ${bySeverity.high.length} high, ${bySeverity.medium.length} medium, ${bySeverity.low.length} low)`,
    ""
  ];

  if (validationResult && !validationResult.ok) {
    sections.push(
      "## ⚠️ Validation Issues",
      "",
      ...(validationResult.errors.length ? validationResult.errors.map((e) => `- ❌ ${e}`) : []),
      ...(validationResult.warnings.length ? validationResult.warnings.map((w) => `- ⚠️ ${w}`) : []),
      ""
    );
  }

  for (const severity of ["critical", "high", "medium", "low"] as ReviewSeverity[]) {
    const group = bySeverity[severity];
    if (group.length === 0) continue;
    sections.push(`## ${severityEmoji(severity)} ${severity.charAt(0).toUpperCase() + severity.slice(1)} (${group.length})`, "");
    group.forEach((f, i) => sections.push(findingBlock(f, i), ""));
  }

  sections.push(
    "## Metrics",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    ...Object.entries(metrics).map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## Next Actions",
    "",
    ...nextActions.map((a, i) => `${i + 1}. ${a}`)
  );

  return sections.join("\n");
}

function buildNextActions(findings: CodeReviewFinding[], validationOk: boolean): string[] {
  const actions: string[] = [];
  if (!validationOk) actions.push("Fix structural validation errors before other changes.");
  const categories = [...new Set(findings.map((f) => f.category))];
  if (categories.includes("security")) actions.push("Address all security findings first — innerHTML, eval, and XSS risks.");
  if (categories.includes("accessibility")) actions.push("Add missing alt text, lang attribute, title element, and accessible button labels.");
  if (categories.includes("performance")) actions.push("Extract large inline scripts/styles into separate files for better caching.");
  if (categories.includes("maintainability")) actions.push("Break up oversized or mixed-responsibility files into single-purpose modules.");
  if (categories.includes("duplication")) actions.push("Extract repeated values into CSS custom properties or shared constants.");
  if (actions.length === 0) actions.push("No critical actions required. Project passes static review heuristics.");
  return actions;
}

// ── Tool definition ──────────────────────────────────────────────────────────

export const projectCodeReviewTools: ToolModule[] = [
  {
    definition: {
      name: "review_project_code",
      description: "Run a structured static code review on project files. Returns severity-tagged findings covering accessibility, performance, maintainability, security, duplication, and naming. Optionally integrates validate_project results, writes Markdown/JSON reports, and syncs findings as project review comments for use with resolve_project_review_comment and export_project_review_summary.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project to review." },
          entryFile: { type: "string", description: "Entry file override (default: project entryFile)." },
          scopePaths: { type: "array", items: { type: "string" }, description: "Limit scan to these relative file paths. Omit to scan all text files." },
          includeValidation: { type: "boolean", description: "Run validate_project and include results as findings (default: true)." },
          syncComments: { type: "boolean", description: "Write findings as project review comments for the resolve/export workflow (default: true)." },
          outputMarkdownPath: { type: "string", description: "Relative path for the Markdown report (default: review/code-review.md)." },
          outputJsonPath: { type: "string", description: "Relative path for the JSON report (default: review/code-review.json)." }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: reviewProjectCodeSchema,
    handler: async (input, ctx) => {
      const parsed = reviewProjectCodeSchema.parse(input);
      const {
        projectId,
        entryFile: entryFileOverride,
        scopePaths,
        includeValidation,
        syncComments,
        outputMarkdownPath,
        outputJsonPath
      } = parsed;

      const metadata = await getProject(ctx.projectRoot, projectId);
      if (metadata.status === "deleted") {
        return {
          ok: false,
          summary: "Cannot review a deleted project.",
          jobId: projectId,
          artifacts: [],
          logs: [],
          structuredContent: { projectId },
          errors: ["Project is deleted."]
        };
      }

      // Collect files to scan
      const allFiles = await listProjectFiles(ctx.projectRoot, projectId);
      const filesRoot = getProjectFilesDirectory(ctx.projectRoot, projectId);

      const scopeSet = scopePaths ? new Set(scopePaths) : null;
      const filesToScan = allFiles.filter((f) => {
        if (scopeSet && !scopeSet.has(f.path)) return false;
        const ext = path.extname(f.path).toLowerCase();
        return textExtensions.has(ext);
      });

      // Run static analysis per file
      const findings: CodeReviewFinding[] = [];
      let totalBytes = 0;

      for (const file of filesToScan) {
        const absolutePath = path.join(filesRoot, file.path);
        let content: string;
        try {
          const buf = await fs.readFile(absolutePath);
          if (buf.length > maxReadBytes) {
            content = buf.subarray(0, maxReadBytes).toString("utf8");
          } else {
            content = buf.toString("utf8");
          }
          totalBytes += buf.length;
        } catch {
          continue;
        }

        const ext = path.extname(file.path).toLowerCase();
        if (ext === ".html") {
          findings.push(...analyzeHtml(content, file.path));
        } else if (ext === ".css") {
          findings.push(...analyzeCss(content, file.path));
        } else if (scriptExtensions.has(ext)) {
          findings.push(...analyzeScript(content, file.path));
        }
      }

      // Optional: integrate validateProject
      let validationResult: { ok: boolean; errors: string[]; warnings: string[] } | null = null;
      if (includeValidation) {
        try {
          const vr = await validateProject(ctx.projectRoot, projectId, entryFileOverride ?? metadata.entryFile);
          validationResult = { ok: vr.ok, errors: vr.errors, warnings: vr.warnings };
          for (const err of vr.errors) {
            findings.push({
              title: `Validation error: ${err.slice(0, 80)}`,
              detail: err,
              severity: "critical",
              category: "maintainability",
              evidence: err,
              suggestion: "Fix the structural issue reported by validate_project."
            });
          }
          for (const warn of vr.warnings) {
            findings.push({
              title: `Validation warning: ${warn.slice(0, 80)}`,
              detail: warn,
              severity: "low",
              category: "maintainability",
              evidence: warn,
              suggestion: "Review and address the validation warning."
            });
          }
        } catch {
          // Non-fatal; proceed without validation findings
        }
      }

      // Metrics
      const bySeverity: Record<ReviewSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const f of findings) bySeverity[f.severity]++;
      const byCategory: Record<string, number> = {};
      for (const f of findings) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;

      const metrics: Record<string, unknown> = {
        filesScanned: filesToScan.length,
        totalFilesInProject: allFiles.length,
        totalSizeBytes: totalBytes,
        findingsTotal: findings.length,
        findingsCritical: bySeverity.critical,
        findingsHigh: bySeverity.high,
        findingsMedium: bySeverity.medium,
        findingsLow: bySeverity.low
      };

      const nextActions = buildNextActions(findings, validationResult?.ok ?? true);
      const sortedFindings = [...findings].sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));

      // Write Markdown report
      const mdContent = buildMarkdownReport(projectId, sortedFindings, metrics, nextActions, validationResult);
      const mdFile = await writeProjectFile(ctx.projectRoot, projectId, outputMarkdownPath!, mdContent).catch(() => null);

      // Write JSON report
      const jsonPayload = JSON.stringify({ projectId, findings: sortedFindings, metrics, nextActions }, null, 2);
      const jsonFile = await writeProjectFile(ctx.projectRoot, projectId, outputJsonPath!, jsonPayload).catch(() => null);

      const artifacts: string[] = [
        ...(mdFile ? [mdFile.path] : []),
        ...(jsonFile ? [jsonFile.path] : [])
      ];

      // Sync findings as review comments
      let createdCommentIds: string[] = [];
      if (syncComments && sortedFindings.length > 0) {
        const commentInputs: ProjectReviewCommentInput[] = sortedFindings.slice(0, 100).map((f) => ({
          title: f.title,
          body: `**${f.category}**: ${f.detail}\n\n**Evidence**: ${f.evidence}\n\n**Suggestion**: ${f.suggestion}`,
          severity: f.severity,
          targetType: f.filePath ? ("file" as const) : ("project" as const),
          filePath: f.filePath,
          lineStart: f.lineStart,
          lineEnd: f.lineEnd
        }));
        try {
          const { added } = await addProjectReviewComments(ctx.projectRoot, projectId, commentInputs, ctx.clientId);
          createdCommentIds = added.map((c) => c.id);
        } catch {
          // Non-fatal; report proceeds without comment IDs
        }
      }

      const ok = bySeverity.critical === 0 && bySeverity.high === 0;
      const summaryText = findings.length === 0
        ? `review_project_code: ${filesToScan.length} file(s) scanned, no issues found.`
        : `review_project_code: ${filesToScan.length} file(s) scanned, ${findings.length} finding(s) (${bySeverity.critical} critical, ${bySeverity.high} high, ${bySeverity.medium} medium, ${bySeverity.low} low).`;

      return {
        ok,
        summary: summaryText,
        jobId: projectId,
        artifacts,
        structuredContent: {
          projectId,
          summary: summaryText,
          findings: sortedFindings,
          metrics,
          nextActions,
          artifacts: { markdownPath: mdFile?.path ?? null, jsonPath: jsonFile?.path ?? null },
          createdCommentIds
        },
        logs: [
          `filesScanned=${filesToScan.length}`,
          `findings=${findings.length}`,
          `critical=${bySeverity.critical}`,
          `high=${bySeverity.high}`,
          `medium=${bySeverity.medium}`,
          `low=${bySeverity.low}`,
          `syncComments=${syncComments}`,
          `commentsSynced=${createdCommentIds.length}`
        ],
        errors: []
      };
    }
  }
];
