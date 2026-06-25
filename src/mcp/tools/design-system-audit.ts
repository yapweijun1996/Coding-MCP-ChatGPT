import { z } from "zod";
import { appendProjectTaskHistory, getProjectManifest, readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

type Finding = {
  id: string;
  category: "tokens" | "color" | "typography" | "spacing" | "radius" | "button" | "table";
  severity: "high" | "medium" | "low";
  message: string;
  evidence: string[];
  recommendation: string;
};

const auditDesignSystemInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  paths: z.array(z.string().min(1).max(240)).max(200).optional(),
  maxColors: z.number().int().min(3).max(40).default(10),
  maxFontSizes: z.number().int().min(3).max(30).default(7),
  maxSpacingValues: z.number().int().min(4).max(60).default(12),
  maxRadiusValues: z.number().int().min(2).max(30).default(5),
  outputJsonPath: z.string().min(1).max(240).default("design-system/design-system-audit.json"),
  outputMarkdownPath: z.string().min(1).max(240).default("design-system/design-system-audit.md")
});

const cssBlockRegex = /([^{}]+)\{([^{}]+)\}/g;
const colorRegex = /(?:#[0-9a-f]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\))/gi;
const cssVarColorRegex = /var\(--[^)]+\)/gi;
const fontSizeRegex = /font-size\s*:\s*([^;]+);?/gi;
const spacingRegex = /(?:margin|padding|gap|row-gap|column-gap)(?:-[a-z]+)?\s*:\s*([^;]+);?/gi;
const radiusRegex = /border-radius\s*:\s*([^;]+);?/gi;

function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/;$/, "");
}

function normalizeColor(value: string): string {
  return normalizeValue(value).toLowerCase();
}

function uniqueMatches(source: string, regex: RegExp, normalizer = normalizeValue): string[] {
  const values = new Set<string>();
  for (const match of source.matchAll(regex)) values.add(normalizer(match[1] ?? match[0]));
  return [...values].sort();
}

function extractHtmlStyles(source: string): string {
  return [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1] ?? "").join("\n");
}

function extractCssBlocks(css: string): Array<{ selector: string; body: string }> {
  return [...css.matchAll(cssBlockRegex)].map((match) => ({ selector: normalizeValue(match[1] ?? ""), body: match[2] ?? "" }));
}

function numericPx(value: string): number | undefined {
  const match = /(-?\d+(?:\.\d+)?)px/.exec(value);
  return match ? Number(match[1]) : undefined;
}

function tokenSuggestions(colors: string[], fontSizes: string[], spacing: string[], radii: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  colors.slice(0, 6).forEach((color, index) => { output[`--color-${index + 1}`] = color; });
  fontSizes.slice(0, 5).forEach((fontSize, index) => { output[`--font-size-${index + 1}`] = fontSize; });
  spacing.slice(0, 8).forEach((space, index) => { output[`--space-${index + 1}`] = space; });
  radii.slice(0, 4).forEach((radius, index) => { output[`--radius-${index + 1}`] = radius; });
  return output;
}

function audit(cssSources: Array<{ path: string; css: string }>, options: z.infer<typeof auditDesignSystemInputSchema>) {
  const allCss = cssSources.map((source) => `/* ${source.path} */\n${source.css}`).join("\n");
  const colors = [...new Set([...uniqueMatches(allCss, colorRegex, normalizeColor), ...uniqueMatches(allCss, cssVarColorRegex, normalizeColor)])].sort();
  const fontSizes = uniqueMatches(allCss, fontSizeRegex);
  const spacing = uniqueMatches(allCss, spacingRegex);
  const radii = uniqueMatches(allCss, radiusRegex);
  const blocks = extractCssBlocks(allCss);
  const findings: Finding[] = [];

  if (!/--[a-z0-9-]+\s*:/i.test(allCss)) {
    findings.push({ id: "missing-css-tokens", category: "tokens", severity: "medium", message: "No CSS custom property tokens were found.", evidence: [], recommendation: "Define :root tokens for color, spacing, typography, radius, and component sizing." });
  }
  if (colors.length > options.maxColors) {
    findings.push({ id: "color-drift", category: "color", severity: "medium", message: `${colors.length} distinct color values found.`, evidence: colors.slice(0, 20), recommendation: "Consolidate colors into semantic tokens such as --color-bg, --color-text, --color-primary, --color-border, --color-danger, and --color-success." });
  }
  if (fontSizes.length > options.maxFontSizes) {
    findings.push({ id: "font-size-drift", category: "typography", severity: "medium", message: `${fontSizes.length} distinct font-size values found.`, evidence: fontSizes, recommendation: "Use a small type scale such as --text-xs, --text-sm, --text-base, --text-lg, --text-xl, and --text-display." });
  }
  if (spacing.length > options.maxSpacingValues) {
    findings.push({ id: "spacing-drift", category: "spacing", severity: "medium", message: `${spacing.length} distinct margin/padding/gap values found.`, evidence: spacing.slice(0, 30), recommendation: "Use a spacing scale such as 4, 8, 12, 16, 24, 32px and reference it through CSS variables." });
  }
  if (radii.length > options.maxRadiusValues) {
    findings.push({ id: "radius-drift", category: "radius", severity: "low", message: `${radii.length} distinct border-radius values found.`, evidence: radii, recommendation: "Normalize component radii into tokens such as --radius-sm, --radius-md, and --radius-lg." });
  }

  const buttonBlocks = blocks.filter((block) => /\b(button|btn|cta)\b/i.test(block.selector));
  const buttonBackgrounds = uniqueMatches(buttonBlocks.map((block) => block.body).join("\n"), /background(?:-color)?\s*:\s*([^;]+);?/gi, normalizeColor);
  const buttonRadii = uniqueMatches(buttonBlocks.map((block) => block.body).join("\n"), radiusRegex);
  const buttonPadding = uniqueMatches(buttonBlocks.map((block) => block.body).join("\n"), /padding\s*:\s*([^;]+);?/gi);
  if (buttonBlocks.length > 1 && (buttonBackgrounds.length > 4 || buttonRadii.length > 3 || buttonPadding.length > 5)) {
    findings.push({ id: "button-variant-drift", category: "button", severity: "medium", message: "Button-like selectors use too many background, radius, or padding variants.", evidence: [...buttonBackgrounds, ...buttonRadii, ...buttonPadding].slice(0, 20), recommendation: "Define primary, secondary, danger, ghost, and icon button variants with shared height, radius, padding, and focus styles." });
  }

  const tableBlocks = blocks.filter((block) => /\b(table|thead|tbody|tr|td|th)\b/i.test(block.selector));
  const tablePadding = uniqueMatches(tableBlocks.map((block) => block.body).join("\n"), /padding\s*:\s*([^;]+);?/gi);
  const pxValues = tablePadding.map(numericPx).filter((value): value is number => typeof value === "number");
  if (tablePadding.length > 4 || (pxValues.length >= 2 && Math.max(...pxValues) - Math.min(...pxValues) > 14)) {
    findings.push({ id: "table-density-drift", category: "table", severity: "medium", message: "Table cell padding suggests inconsistent density.", evidence: tablePadding, recommendation: "Define compact, regular, and spacious table density tokens and use one density per table surface." });
  }

  return {
    cssFiles: cssSources.map((source) => source.path),
    metrics: {
      colorCount: colors.length,
      fontSizeCount: fontSizes.length,
      spacingValueCount: spacing.length,
      radiusValueCount: radii.length,
      buttonSelectorCount: buttonBlocks.length,
      tableSelectorCount: tableBlocks.length
    },
    tokens: { colors, fontSizes, spacing, radii },
    suggestedCssVariables: tokenSuggestions(colors, fontSizes, spacing, radii),
    findings
  };
}

function markdown(report: ReturnType<typeof audit> & { projectId: string }) {
  const rows = report.findings.map((finding) => `| ${finding.severity} | ${finding.category} | ${finding.id} | ${finding.message.replaceAll("|", "\\|")} | ${finding.recommendation.replaceAll("|", "\\|")} |`).join("\n");
  const variables = Object.entries(report.suggestedCssVariables).map(([key, value]) => `  ${key}: ${value};`).join("\n");
  return `# Design System Consistency Audit

- Project: \`${report.projectId}\`
- CSS sources: ${report.cssFiles.join(", ") || "none"}
- Findings: ${report.findings.length}

## Metrics

\`\`\`json
${JSON.stringify(report.metrics, null, 2)}
\`\`\`

## Suggested CSS Variables

\`\`\`css
:root {
${variables || "  /* No raw values found. */"}
}
\`\`\`

## Findings

| Severity | Category | ID | Finding | Recommendation |
| --- | --- | --- | --- | --- |
${rows || "| low | tokens | none | No drift findings. | Keep using shared design tokens. |"}
`;
}

export const designSystemAuditTools: ToolModule[] = [
  {
    definition: {
      name: "audit_design_system_consistency",
      description: "Audit project HTML/CSS for design-system drift across color tokens, spacing, typography, radius, button variants, and table density; writes JSON and Markdown reports.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          maxColors: { type: "number" },
          maxFontSizes: { type: "number" },
          maxSpacingValues: { type: "number" },
          maxRadiusValues: { type: "number" },
          outputJsonPath: { type: "string" },
          outputMarkdownPath: { type: "string" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: auditDesignSystemInputSchema,
    handler: async (input, ctx) => {
      const parsed = auditDesignSystemInputSchema.parse(input);
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const targetPaths = (parsed.paths?.length ? parsed.paths : manifest.files.map((file) => file.path))
        .filter((filePath) => /\.(html?|css)$/i.test(filePath));
      const cssSources = [];
      for (const filePath of targetPaths) {
        const source = await readProjectFile(ctx.projectRoot, parsed.projectId, filePath);
        const css = /\.css$/i.test(filePath) ? source : extractHtmlStyles(source);
        if (css.trim()) cssSources.push({ path: filePath, css });
      }
      const result = audit(cssSources, parsed);
      const report = { projectId: parsed.projectId, ...result };
      const jsonFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputJsonPath, `${JSON.stringify(report, null, 2)}\n`);
      const markdownFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputMarkdownPath, markdown(report));
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "audit_design_system_consistency", ok: result.findings.every((finding) => finding.severity !== "high"), summary: `Design system audit found ${result.findings.length} finding(s).`, details: { outputJsonPath: jsonFile.path, outputMarkdownPath: markdownFile.path, metrics: result.metrics } });
      return { ok: true, summary: `Design system audit found ${result.findings.length} finding(s).`, jobId: parsed.projectId, artifacts: [jsonFile.path, markdownFile.path], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  }
];
