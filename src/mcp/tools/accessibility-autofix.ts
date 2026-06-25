import { z } from "zod";
import { getProjectManifest, readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

const autoFixAccessibilityInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  paths: z.array(z.string().min(1).max(240)).max(100).optional(),
  applyFixes: z.boolean().optional().default(false),
  language: z.string().min(2).max(20).optional().default("en"),
  addReducedMotion: z.boolean().optional().default(true),
  addFocusStyles: z.boolean().optional().default(true),
  outputPath: z.string().min(1).max(240).optional().default("accessibility/autofix-report.json")
});

type FixAction = {
  path: string;
  category: "labels" | "contrast" | "focus" | "keyboard" | "aria" | "landmarks" | "semantic" | "motion" | "metadata";
  severity: "high" | "medium" | "low";
  message: string;
  applied: boolean;
};

function labelFromAttributes(tag: string, fallback: string) {
  const explicit = /\b(?:aria-label|title|placeholder|name|id)=["']([^"']+)["']/i.exec(tag)?.[1];
  return (explicit ?? fallback).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || fallback;
}

function hasVisibleText(tagBody: string) {
  return tagBody.replace(/<[^>]+>/g, "").trim().length > 0;
}

function fixHtml(path: string, source: string, input: z.infer<typeof autoFixAccessibilityInputSchema>) {
  let output = source;
  const actions: FixAction[] = [];
  const add = (category: FixAction["category"], severity: FixAction["severity"], message: string, applied: boolean) => actions.push({ path, category, severity, message, applied });

  if (/<html\b/i.test(output) && !/<html\b[^>]*\blang=/i.test(output)) {
    output = output.replace(/<html\b([^>]*)>/i, `<html$1 lang="${input.language}">`);
    add("metadata", "medium", "Added html lang attribute.", true);
  } else if (!/<html\b/i.test(output)) {
    add("semantic", "medium", "No html root tag found; manual review required.", false);
  }

  if (/<head\b/i.test(output) && !/<title\b/i.test(output)) {
    output = output.replace(/<head\b([^>]*)>/i, `<head$1>\n<title>Generated UI</title>`);
    add("metadata", "medium", "Added missing document title.", true);
  }

  if (/<body\b/i.test(output) && !/<main\b/i.test(output)) {
    output = output.replace(/<body\b([^>]*)>/i, `<body$1>\n<main id="main-content">`);
    output = output.replace(/<\/body>/i, `</main>\n</body>`);
    add("landmarks", "medium", "Wrapped body content in a main landmark.", true);
  }

  output = output.replace(/<img\b(?![^>]*\balt=)([^>]*)>/gi, (match, attrs: string) => {
    add("labels", "high", "Added empty alt text to image missing alt.", true);
    return `<img${attrs} alt="">`;
  });

  output = output.replace(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi, (match, attrs: string, body: string) => {
    if (/\baria-label=|\baria-labelledby=/i.test(attrs) || hasVisibleText(body)) return match;
    const label = labelFromAttributes(attrs, "Button");
    add("labels", "high", `Added aria-label to icon/empty button: ${label}.`, true);
    return `<button${attrs} aria-label="${label}">${body}</button>`;
  });

  output = output.replace(/<(input|select|textarea)\b([^>]*)>/gi, (match, tag: string, attrs: string) => {
    if (/type=["']?hidden/i.test(attrs) || /\baria-label=|\baria-labelledby=|\bid=/i.test(attrs)) return match;
    const label = labelFromAttributes(attrs, tag);
    add("labels", "high", `Added aria-label to unlabeled ${tag}: ${label}.`, true);
    return `<${tag}${attrs} aria-label="${label}">`;
  });

  output = output.replace(/<(button|a|input|select|textarea)\b([^>]*)\saria-hidden=["']true["']([^>]*)>/gi, (match, tag: string, before: string, after: string) => {
    add("aria", "high", `Removed aria-hidden=true from focusable ${tag}.`, true);
    return `<${tag}${before}${after}>`;
  });

  if (/<div\b[^>]*\bonclick=/i.test(output)) {
    add("keyboard", "medium", "Clickable div detected; add button semantics or keyboard handlers manually.", false);
  }
  if (/\brole=["']button["']/i.test(output) && !/\btabindex=/i.test(output)) {
    add("keyboard", "medium", "role=button without tabindex may not be keyboard reachable.", false);
  }

  return { output, actions };
}

function fixCss(path: string, source: string, input: z.infer<typeof autoFixAccessibilityInputSchema>) {
  let output = source;
  const actions: FixAction[] = [];
  const add = (category: FixAction["category"], severity: FixAction["severity"], message: string, applied: boolean) => actions.push({ path, category, severity, message, applied });

  if (input.addFocusStyles && !/:focus-visible|:focus\b/i.test(output)) {
    output = `${output.trim()}\n\n:where(a, button, input, select, textarea, [tabindex]):focus-visible {\n  outline: 3px solid #2563eb;\n  outline-offset: 3px;\n}\n`;
    add("focus", "high", "Added visible keyboard focus styles.", true);
  }

  if (input.addReducedMotion && /@keyframes|animation:|transition:/i.test(output) && !/prefers-reduced-motion/i.test(output)) {
    output = `${output.trim()}\n\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after {\n    animation-duration: 0.01ms !important;\n    animation-iteration-count: 1 !important;\n    scroll-behavior: auto !important;\n    transition-duration: 0.01ms !important;\n  }\n}\n`;
    add("motion", "medium", "Added reduced-motion override for animations/transitions.", true);
  }

  if (/color:\s*#(?:aaa|bbb|ccc|ddd|eee)\b/i.test(output)) {
    add("contrast", "medium", "Potential low-contrast light text color detected; review against the actual background.", false);
  }

  return { output, actions };
}

export const accessibilityAutofixTools: ToolModule[] = [
  {
    definition: {
      name: "auto_fix_accessibility",
      description: "Detect and optionally patch common generated UI accessibility issues: missing labels, document metadata, landmarks, focus styles, reduced motion, invalid aria-hidden on focusable controls, and semantic/keyboard review gaps.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          applyFixes: { type: "boolean" },
          language: { type: "string" },
          addReducedMotion: { type: "boolean" },
          addFocusStyles: { type: "boolean" },
          outputPath: { type: "string" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: autoFixAccessibilityInputSchema,
    handler: async (input, ctx) => {
      const parsed = autoFixAccessibilityInputSchema.parse(input);
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const targetPaths = (parsed.paths?.length ? parsed.paths : manifest.files.map((file) => file.path))
        .filter((filePath) => /\.(html?|css)$/i.test(filePath));
      const actions: FixAction[] = [];
      const changedFiles: string[] = [];
      for (const filePath of targetPaths) {
        const source = await readProjectFile(ctx.projectRoot, parsed.projectId, filePath);
        const result = /\.css$/i.test(filePath) ? fixCss(filePath, source, parsed) : fixHtml(filePath, source, parsed);
        actions.push(...result.actions.map((action) => ({ ...action, applied: parsed.applyFixes && action.applied })));
        if (parsed.applyFixes && result.output !== source) {
          await writeProjectFile(ctx.projectRoot, parsed.projectId, filePath, result.output);
          changedFiles.push(filePath);
        }
      }
      const unapplied = actions.filter((action) => !action.applied);
      const report = {
        projectId: parsed.projectId,
        applyFixes: parsed.applyFixes,
        scannedFiles: targetPaths,
        changedFiles,
        actionCount: actions.length,
        appliedCount: actions.filter((action) => action.applied).length,
        manualReviewCount: unapplied.length,
        actions,
        followUpChecks: ["Run audit_accessibility or run_a11y_audit_detailed.", "Keyboard-tab through interactive controls.", "Verify color contrast against final backgrounds.", "Run validate_project before publishing."]
      };
      const reportFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(report, null, 2)}\n`);
      return { ok: true, summary: `${parsed.applyFixes ? "Applied" : "Planned"} ${report.actionCount} accessibility fix action(s).`, jobId: parsed.projectId, artifacts: [reportFile.path, ...changedFiles], structuredContent: report, logs: actions.map((action) => `${action.applied ? "applied" : "review"} ${action.path}: ${action.message}`), errors: [] };
    }
  }
];
