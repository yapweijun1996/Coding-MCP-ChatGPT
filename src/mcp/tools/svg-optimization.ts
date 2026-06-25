import { z } from "zod";
import { appendProjectTaskHistory, getProjectManifest, readProjectFile, writeProjectAsset, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

type SvgFinding = {
  id: string;
  severity: "high" | "medium" | "low";
  category: "validity" | "viewBox" | "accessibility" | "cleanup" | "size";
  path: string;
  message: string;
  recommendation: string;
};

type SvgReport = {
  path: string;
  beforeBytes: number;
  afterBytes: number;
  reductionBytes: number;
  reductionPercent: number;
  optimizedPath?: string;
  applied: boolean;
  metrics: {
    hasSvgRoot: boolean;
    viewBox?: string;
    hasValidViewBox: boolean;
    hasTitle: boolean;
    hasDesc: boolean;
    titlePreserved: boolean;
    descPreserved: boolean;
    removedComments: number;
    removedMetadataBlocks: number;
    removedEditorAttributes: number;
    removedEmptyGroups: number;
    collapsedDuplicateGroups: number;
  };
  findings: SvgFinding[];
};

const optimizeProjectSvgsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  paths: z.array(z.string().min(1).max(240)).max(200).optional(),
  applyOptimizations: z.boolean().default(false),
  minify: z.boolean().default(true),
  removeEditorAttributes: z.boolean().default(true),
  cleanupDuplicateGroups: z.boolean().default(true),
  optimizedDirectory: z.string().min(1).max(160).default("optimized-svgs"),
  outputJsonPath: z.string().min(1).max(240).default("svg-optimization/svg-optimization-report.json"),
  outputMarkdownPath: z.string().min(1).max(240).default("svg-optimization/svg-optimization-report.md")
});

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function percent(beforeBytes: number, afterBytes: number): number {
  if (!beforeBytes) return 0;
  return Math.round(((beforeBytes - afterBytes) / beforeBytes) * 10000) / 100;
}

function optimizedPathFor(directory: string, filePath: string): string {
  const cleanDirectory = directory.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const parts = filePath.replaceAll("\\", "/").split("/");
  const filename = parts.pop() ?? "asset.svg";
  const stem = filename.replace(/\.svg$/i, "");
  return `${cleanDirectory}/${parts.length ? `${parts.join("/")}/` : ""}${stem}.optimized.svg`;
}

function viewBoxOf(svg: string): string | undefined {
  return /<svg\b[^>]*\bviewBox=["']([^"']+)["']/i.exec(svg)?.[1]?.trim();
}

function validViewBox(viewBox?: string): boolean {
  if (!viewBox) return false;
  const values = viewBox.split(/[\s,]+/).map(Number);
  return values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0;
}

function extractTagText(svg: string, tag: "title" | "desc"): string | undefined {
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(svg)?.[1]?.trim();
}

function cleanupSvg(svg: string, options: z.infer<typeof optimizeProjectSvgsInputSchema>) {
  const originalTitle = extractTagText(svg, "title");
  const originalDesc = extractTagText(svg, "desc");
  let optimized = svg.trim();
  const count = (pattern: RegExp) => (optimized.match(pattern) ?? []).length;
  const removedComments = count(/<!--[\s\S]*?-->/g);
  optimized = optimized.replace(/<!--[\s\S]*?-->/g, "");
  const removedMetadataBlocks = count(/<metadata\b[\s\S]*?<\/metadata>/gi);
  optimized = optimized.replace(/<metadata\b[\s\S]*?<\/metadata>/gi, "");
  let removedEditorAttributes = 0;
  if (options.removeEditorAttributes) {
    optimized = optimized.replace(/\s(?:inkscape:[\w-]+|sodipodi:[\w-]+|serif:[\w-]+|data-name|data-layer|xml:space)=["'][^"']*["']/gi, () => {
      removedEditorAttributes += 1;
      return "";
    });
  }
  const removedEmptyGroups = count(/<g\b(?:\s[^>]*)?>\s*<\/g>/gi);
  optimized = optimized.replace(/<g\b(?:\s[^>]*)?>\s*<\/g>/gi, "");
  let collapsedDuplicateGroups = 0;
  if (options.cleanupDuplicateGroups) {
    optimized = optimized.replace(/(<g\b[^>]*>[\s\S]*?<\/g>)(\s*\1)+/gi, (match, group) => {
      collapsedDuplicateGroups += Math.max(1, Math.round(match.length / Math.max(group.length, 1)) - 1);
      return group;
    });
  }
  if (options.minify) {
    optimized = optimized
      .replace(/>\s+</g, "><")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+(?=\/?>)/g, "")
      .replace(/;(?=["'])/g, "")
      .trim();
  }
  optimized = `${optimized}\n`;
  const optimizedTitle = extractTagText(optimized, "title");
  const optimizedDesc = extractTagText(optimized, "desc");
  return {
    optimized,
    metrics: {
      hasSvgRoot: /<svg\b/i.test(svg),
      viewBox: viewBoxOf(svg),
      hasValidViewBox: validViewBox(viewBoxOf(svg)),
      hasTitle: !!originalTitle,
      hasDesc: !!originalDesc,
      titlePreserved: originalTitle === optimizedTitle,
      descPreserved: originalDesc === optimizedDesc,
      removedComments,
      removedMetadataBlocks,
      removedEditorAttributes,
      removedEmptyGroups,
      collapsedDuplicateGroups
    }
  };
}

function findingsFor(path: string, beforeBytes: number, afterBytes: number, metrics: SvgReport["metrics"]): SvgFinding[] {
  const findings: SvgFinding[] = [];
  if (!metrics.hasSvgRoot) findings.push({ id: "missing-svg-root", severity: "high", category: "validity", path, message: "File does not contain an <svg> root.", recommendation: "Fix the SVG markup before publishing or optimizing." });
  if (!metrics.hasValidViewBox) findings.push({ id: "invalid-or-missing-viewbox", severity: "high", category: "viewBox", path, message: "SVG is missing a valid four-number viewBox.", recommendation: "Add a viewBox such as viewBox=\"0 0 width height\" matching the artboard." });
  if (!metrics.hasTitle || !metrics.hasDesc) findings.push({ id: "missing-accessibility-labels", severity: "medium", category: "accessibility", path, message: "SVG is missing title or desc accessibility labels.", recommendation: "Add meaningful <title> and <desc> elements, or mark decorative SVGs appropriately where rendered." });
  if (!metrics.titlePreserved || !metrics.descPreserved) findings.push({ id: "accessibility-label-changed", severity: "high", category: "accessibility", path, message: "Optimization changed title or desc text.", recommendation: "Do not ship this optimized SVG until accessibility labels are restored." });
  if (metrics.removedMetadataBlocks || metrics.removedEditorAttributes || metrics.removedEmptyGroups || metrics.collapsedDuplicateGroups) findings.push({ id: "svg-cleanup-available", severity: "low", category: "cleanup", path, message: "SVG contains removable metadata, editor attributes, empty groups, or duplicate groups.", recommendation: "Use the optimized SVG after visual review." });
  if (beforeBytes > 150 * 1024) findings.push({ id: "large-svg", severity: "medium", category: "size", path, message: `SVG is ${beforeBytes} bytes.`, recommendation: "Review path complexity, repeated defs, embedded raster images, and whether splitting symbols/icons would help." });
  if (afterBytes < beforeBytes) findings.push({ id: "svg-size-reduction", severity: "low", category: "size", path, message: `Optimization can save ${beforeBytes - afterBytes} bytes (${percent(beforeBytes, afterBytes)}%).`, recommendation: "Use the optimized output if visual and accessibility QA pass." });
  return findings;
}

function markdown(report: { projectId: string; totalBeforeBytes: number; totalAfterBytes: number; totalReductionBytes: number; totalReductionPercent: number; svgs: SvgReport[]; findings: SvgFinding[] }) {
  const rows = report.svgs.map((svg) => `| ${svg.path} | ${svg.beforeBytes} | ${svg.afterBytes} | ${svg.reductionPercent}% | ${svg.metrics.hasValidViewBox ? "yes" : "no"} | ${svg.metrics.hasTitle && svg.metrics.hasDesc ? "yes" : "no"} | ${svg.optimizedPath ?? "-"} | ${svg.applied ? "yes" : "no"} |`).join("\n");
  const findingRows = report.findings.map((finding) => `| ${finding.severity} | ${finding.category} | ${finding.id} | ${finding.path} | ${finding.message.replaceAll("|", "\\|")} |`).join("\n");
  return `# SVG Optimization Report

- Project: \`${report.projectId}\`
- SVGs scanned: ${report.svgs.length}
- Before bytes: ${report.totalBeforeBytes}
- After bytes: ${report.totalAfterBytes}
- Reduction: ${report.totalReductionBytes} bytes (${report.totalReductionPercent}%)
- Findings: ${report.findings.length}

## SVGs

| Path | Before | After | Reduction | Valid ViewBox | Title+Desc | Optimized Path | Applied |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
${rows || "| - | 0 | 0 | 0% | no | no | - | no |"}

## Findings

| Severity | Category | ID | Path | Finding |
| --- | --- | --- | --- | --- |
${findingRows || "| low | size | none | project | No SVG optimization findings. |"}
`;
}

export const svgOptimizationTools: ToolModule[] = [
  {
    definition: {
      name: "optimize_project_svgs",
      description: "Optimize and validate project SVG files with SVGO-style safe cleanup, viewBox validation, accessibility title/desc preservation, duplicate group cleanup, optional minify, and before/after size reports.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          applyOptimizations: { type: "boolean" },
          minify: { type: "boolean" },
          removeEditorAttributes: { type: "boolean" },
          cleanupDuplicateGroups: { type: "boolean" },
          optimizedDirectory: { type: "string" },
          outputJsonPath: { type: "string" },
          outputMarkdownPath: { type: "string" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: optimizeProjectSvgsInputSchema,
    handler: async (input, ctx) => {
      const parsed = optimizeProjectSvgsInputSchema.parse(input);
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const targetPaths = (parsed.paths?.length ? parsed.paths : manifest.files.map((file) => file.path).filter((filePath) => /\.svg$/i.test(filePath)));
      const svgs: SvgReport[] = [];
      for (const filePath of targetPaths) {
        const source = await readProjectFile(ctx.projectRoot, parsed.projectId, filePath, 10 * 1024 * 1024);
        const beforeBytes = byteLength(source);
        const cleaned = cleanupSvg(source, parsed);
        const afterBytes = byteLength(cleaned.optimized);
        const optimizedPath = afterBytes < beforeBytes ? optimizedPathFor(parsed.optimizedDirectory, filePath) : undefined;
        let applied = false;
        if (optimizedPath && parsed.applyOptimizations) {
          await writeProjectAsset(ctx.projectRoot, parsed.projectId, optimizedPath, Buffer.from(cleaned.optimized, "utf8"), "image/svg+xml");
          applied = true;
        }
        svgs.push({
          path: filePath,
          beforeBytes,
          afterBytes,
          reductionBytes: beforeBytes - afterBytes,
          reductionPercent: percent(beforeBytes, afterBytes),
          optimizedPath,
          applied,
          metrics: cleaned.metrics,
          findings: findingsFor(filePath, beforeBytes, afterBytes, cleaned.metrics)
        });
      }
      const totalBeforeBytes = svgs.reduce((total, svg) => total + svg.beforeBytes, 0);
      const totalAfterBytes = svgs.reduce((total, svg) => total + svg.afterBytes, 0);
      const findings = svgs.flatMap((svg) => svg.findings);
      const report = {
        projectId: parsed.projectId,
        totalBeforeBytes,
        totalAfterBytes,
        totalReductionBytes: totalBeforeBytes - totalAfterBytes,
        totalReductionPercent: percent(totalBeforeBytes, totalAfterBytes),
        svgs,
        findings
      };
      const jsonFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputJsonPath, `${JSON.stringify(report, null, 2)}\n`);
      const markdownFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputMarkdownPath, markdown(report));
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "optimize_project_svgs", ok: findings.every((finding) => finding.severity !== "high"), summary: `SVG optimization scanned ${svgs.length} SVG(s), possible reduction ${report.totalReductionBytes} bytes.`, details: { outputJsonPath: jsonFile.path, outputMarkdownPath: markdownFile.path, totalReductionBytes: report.totalReductionBytes, applied: parsed.applyOptimizations } });
      return { ok: true, summary: `SVG optimization scanned ${svgs.length} SVG(s), possible reduction ${report.totalReductionBytes} bytes.`, jobId: parsed.projectId, artifacts: [jsonFile.path, markdownFile.path, ...svgs.map((svg) => svg.optimizedPath).filter((item): item is string => !!item)], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  }
];
