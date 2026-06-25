import { z } from "zod";
import { appendProjectTaskHistory, getProjectManifest, readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

type Finding = {
  id: string;
  category: "missing-key" | "hardcoded-text" | "fallback" | "terminology" | "layout-overflow" | "language-persistence";
  severity: "high" | "medium" | "low";
  path: string;
  message: string;
  evidence?: string;
  recommendation: string;
};

const glossaryTermSchema = z.object({
  term: z.string().min(1).max(120),
  translations: z.record(z.string(), z.string())
});

const auditI18nCoverageInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  localePaths: z.array(z.string().min(1).max(240)).max(50).optional(),
  sourcePaths: z.array(z.string().min(1).max(240)).max(200).optional(),
  baseLocale: z.string().min(2).max(20).default("en"),
  expectedLocales: z.array(z.string().min(2).max(20)).max(20).optional(),
  glossary: z.array(glossaryTermSchema).max(200).default([]),
  overflowRatio: z.number().min(1.1).max(5).default(1.6),
  outputJsonPath: z.string().min(1).max(240).default("i18n/i18n-audit.json"),
  outputMarkdownPath: z.string().min(1).max(240).default("i18n/i18n-audit.md")
});

function flattenJson(value: unknown, prefix = ""): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return { [prefix]: String(value) };
  if (Array.isArray(value)) return Object.fromEntries(value.flatMap((entry, index) => Object.entries(flattenJson(entry, `${prefix}.${index}`))));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const next = prefix ? `${prefix}.${key}` : key;
      return Object.entries(flattenJson(child, next));
    }));
  }
  return {};
}

function localeFromPath(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  return name.replace(/\.(json|jsonc)$/i, "");
}

function textSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 160);
}

function findHardcodedHtml(path: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const stripped = source
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
  for (const match of stripped.matchAll(/>([^<>]+)</g)) {
    const text = textSnippet(match[1] ?? "");
    if (text.length < 3 || /^[\s\d.,:;|/()[\]{}#+=-]+$/.test(text)) continue;
    if (/\{\{|\bt\(|data-i18n|i18n/i.test(text)) continue;
    findings.push({ id: "hardcoded-html-text", category: "hardcoded-text", severity: "medium", path, evidence: text, message: "Visible HTML text appears hardcoded outside the translation system.", recommendation: "Move user-facing copy into locale files and render it through i18n keys." });
  }
  return findings.slice(0, 50);
}

function findHardcodedJs(path: string, source: string): Finding[] {
  const findings: Finding[] = [];
  for (const match of source.matchAll(/["'`]([^"'`\n]{4,120})["'`]/g)) {
    const text = textSnippet(match[1] ?? "");
    if (!/[A-Za-z]{3,}/.test(text)) continue;
    if (/^(http|https|#[0-9a-f]|[./#?&=_:-]+$)/i.test(text)) continue;
    if (/\bt\(|i18n|aria-|class|id|querySelector|addEventListener|localStorage|sessionStorage/.test(source.slice(Math.max(0, (match.index ?? 0) - 40), (match.index ?? 0) + 160))) continue;
    findings.push({ id: "hardcoded-js-string", category: "hardcoded-text", severity: "low", path, evidence: text, message: "JavaScript string may be user-facing hardcoded text.", recommendation: "If this appears in UI, replace it with an i18n key." });
  }
  return findings.slice(0, 50);
}

function hasFallbackSignal(source: string): boolean {
  return /fallbackLng|fallbackLocale|defaultLocale|baseLocale|\|\|\s*t\(|\?\?\s*t\(/i.test(source);
}

function hasPersistenceSignal(source: string): boolean {
  return /(localStorage|sessionStorage|document\.cookie|cookieStore)\.(setItem|getItem)?\(?[^;\n]*(lang|locale|i18n)|(?:lang|locale|i18n)[^;\n]*(localStorage|sessionStorage|document\.cookie|cookieStore)/i.test(source);
}

function markdown(report: { projectId: string; localeFiles: string[]; sourceFiles: string[]; findingCount: number; findings: Finding[]; coverage: Record<string, unknown> }) {
  const rows = report.findings.map((finding) => `| ${finding.severity} | ${finding.category} | ${finding.id} | ${finding.path} | ${finding.message.replaceAll("|", "\\|")} | ${finding.evidence?.replaceAll("|", "\\|") ?? ""} |`).join("\n");
  return `# i18n Coverage Audit

- Project: \`${report.projectId}\`
- Locale files: ${report.localeFiles.join(", ") || "none"}
- Source files: ${report.sourceFiles.join(", ") || "none"}
- Findings: ${report.findingCount}

## Coverage

\`\`\`json
${JSON.stringify(report.coverage, null, 2)}
\`\`\`

## Findings

| Severity | Category | ID | Path | Finding | Evidence |
| --- | --- | --- | --- | --- | --- |
${rows || "| low | fallback | none | project | No i18n findings. | - |"}
`;
}

export const i18nAuditTools: ToolModule[] = [
  {
    definition: {
      name: "audit_i18n_coverage",
      description: "Audit project i18n coverage for missing translation keys, hardcoded UI text, fallback/persistence signals, terminology consistency, and translation overflow risk.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          localePaths: { type: "array", items: { type: "string" } },
          sourcePaths: { type: "array", items: { type: "string" } },
          baseLocale: { type: "string" },
          expectedLocales: { type: "array", items: { type: "string" } },
          glossary: { type: "array", items: { type: "object" } },
          overflowRatio: { type: "number" },
          outputJsonPath: { type: "string" },
          outputMarkdownPath: { type: "string" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: auditI18nCoverageInputSchema,
    handler: async (input, ctx) => {
      const parsed = auditI18nCoverageInputSchema.parse(input);
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const allPaths = manifest.files.map((file) => file.path);
      const localePaths = parsed.localePaths ?? allPaths.filter((filePath) => /(^|\/)(locales?|i18n|translations?)\/[^/]+\.json$/i.test(filePath));
      const sourcePaths = parsed.sourcePaths ?? allPaths.filter((filePath) => /\.(html?|jsx?|tsx?)$/i.test(filePath));
      const findings: Finding[] = [];
      const localeMaps: Record<string, Record<string, string>> = {};
      for (const localePath of localePaths) {
        const source = await readProjectFile(ctx.projectRoot, parsed.projectId, localePath).catch(() => "");
        if (!source) continue;
        try {
          localeMaps[localeFromPath(localePath)] = flattenJson(JSON.parse(source));
        } catch {
          findings.push({ id: "invalid-locale-json", category: "missing-key", severity: "high", path: localePath, message: "Locale file is not valid JSON.", recommendation: "Fix the locale JSON before shipping translations." });
        }
      }
      const expectedLocales = parsed.expectedLocales ?? Object.keys(localeMaps);
      const base = localeMaps[parsed.baseLocale] ?? localeMaps[expectedLocales[0] ?? ""];
      const baseKeys = new Set(Object.keys(base ?? {}));
      for (const locale of expectedLocales) {
        const map = localeMaps[locale];
        if (!map) {
          findings.push({ id: "missing-locale-file", category: "missing-key", severity: "high", path: "locales", evidence: locale, message: `Expected locale ${locale} is missing.`, recommendation: "Add the locale file or remove it from expectedLocales." });
          continue;
        }
        for (const key of baseKeys) {
          if (!(key in map)) findings.push({ id: "missing-translation-key", category: "missing-key", severity: "high", path: locale, evidence: key, message: `Locale ${locale} is missing key ${key}.`, recommendation: "Add the missing translation key with reviewed copy." });
        }
        for (const [key, value] of Object.entries(map)) {
          const baseValue = base?.[key];
          if (baseValue && value.length > baseValue.length * parsed.overflowRatio && value.length > 24) {
            findings.push({ id: "translation-overflow-risk", category: "layout-overflow", severity: "medium", path: locale, evidence: `${key}: ${value}`, message: `Locale ${locale} translation is much longer than base copy.`, recommendation: "Check responsive layout, wrapping, and button/container widths for this translation." });
          }
        }
      }
      for (const term of parsed.glossary) {
        for (const [locale, expected] of Object.entries(term.translations)) {
          const values = Object.values(localeMaps[locale] ?? {});
          const hasTerm = values.some((value) => value.includes(expected));
          if (!hasTerm) findings.push({ id: "glossary-term-missing", category: "terminology", severity: "medium", path: locale, evidence: `${term.term} -> ${expected}`, message: `Glossary term ${term.term} is not found with expected ${locale} wording.`, recommendation: "Review terminology consistency against the glossary." });
        }
      }
      let fallbackSignal = false;
      let persistenceSignal = false;
      for (const sourcePath of sourcePaths) {
        const source = await readProjectFile(ctx.projectRoot, parsed.projectId, sourcePath).catch(() => "");
        if (!source) continue;
        fallbackSignal = fallbackSignal || hasFallbackSignal(source);
        persistenceSignal = persistenceSignal || hasPersistenceSignal(source);
        if (/\.html?$/i.test(sourcePath)) findings.push(...findHardcodedHtml(sourcePath, source));
        else findings.push(...findHardcodedJs(sourcePath, source));
      }
      if (localePaths.length && !fallbackSignal) findings.push({ id: "fallback-not-detected", category: "fallback", severity: "medium", path: "project", message: "No explicit fallback locale behavior was detected in source files.", recommendation: "Configure fallback locale/defaultLocale behavior and test missing-key rendering." });
      if (expectedLocales.length > 1 && !persistenceSignal) findings.push({ id: "language-persistence-not-detected", category: "language-persistence", severity: "low", path: "project", message: "No language persistence signal was detected.", recommendation: "Persist selected language in localStorage, sessionStorage, cookie, URL, or server state." });
      const coverage = {
        baseLocale: parsed.baseLocale,
        expectedLocales,
        localeCount: Object.keys(localeMaps).length,
        baseKeyCount: baseKeys.size,
        perLocaleKeyCount: Object.fromEntries(Object.entries(localeMaps).map(([locale, map]) => [locale, Object.keys(map).length])),
        fallbackSignal,
        persistenceSignal
      };
      const report = { projectId: parsed.projectId, localeFiles: localePaths, sourceFiles: sourcePaths, findingCount: findings.length, coverage, findings };
      const jsonFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputJsonPath, `${JSON.stringify(report, null, 2)}\n`);
      const markdownFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputMarkdownPath, markdown(report));
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "audit_i18n_coverage", ok: findings.every((finding) => finding.severity !== "high"), summary: `i18n audit found ${findings.length} finding(s).`, details: { outputJsonPath: jsonFile.path, outputMarkdownPath: markdownFile.path, coverage } });
      return { ok: true, summary: `i18n audit found ${findings.length} finding(s).`, jobId: parsed.projectId, artifacts: [jsonFile.path, markdownFile.path], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  }
];
