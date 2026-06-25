import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { appendProjectTaskHistory, getProjectFileContentType, getProjectManifest, getProjectStoredFilePath, readProjectFile, writeProjectAsset, writeProjectFile } from "../../projects/store.js";
import type { ToolModule } from "../types.js";

type AssetFinding = {
  id: string;
  severity: "high" | "medium" | "low";
  category: "oversized" | "format" | "metadata" | "svg" | "embedded" | "media";
  path: string;
  message: string;
  recommendation: string;
};

type AssetReport = {
  path: string;
  kind: "png" | "jpeg" | "webp" | "gif" | "svg" | "media" | "other";
  beforeBytes: number;
  afterBytes?: number;
  reductionBytes: number;
  reductionPercent: number;
  optimizedPath?: string;
  applied: boolean;
  safeLossless: boolean;
  suggestions: string[];
  findings: AssetFinding[];
};

const optimizeProjectAssetsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  paths: z.array(z.string().min(1).max(240)).max(200).optional(),
  applyOptimizations: z.boolean().default(false),
  losslessOnly: z.boolean().default(true),
  largeAssetBytes: z.number().int().min(1024).max(100 * 1024 * 1024).default(250 * 1024),
  optimizedDirectory: z.string().min(1).max(160).default("optimized-assets"),
  outputJsonPath: z.string().min(1).max(240).default("asset-optimization/asset-optimization-report.json"),
  outputMarkdownPath: z.string().min(1).max(240).default("asset-optimization/asset-optimization-report.md")
});

const assetExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".mp3", ".wav", ".ogg", ".mp4", ".webm"]);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);

function kindFor(filePath: string): AssetReport["kind"] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "png";
  if (ext === ".jpg" || ext === ".jpeg") return "jpeg";
  if (ext === ".webp") return "webp";
  if (ext === ".gif") return "gif";
  if (ext === ".svg") return "svg";
  if ([".mp3", ".wav", ".ogg", ".mp4", ".webm"].includes(ext)) return "media";
  return "other";
}

function percent(beforeBytes: number, afterBytes: number): number {
  if (!beforeBytes) return 0;
  return Math.round(((beforeBytes - afterBytes) / beforeBytes) * 10000) / 100;
}

function optimizedPathFor(directory: string, filePath: string): string {
  const cleanDirectory = directory.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const parsed = path.posix.parse(filePath.replaceAll("\\", "/"));
  return `${cleanDirectory}/${parsed.dir ? `${parsed.dir}/` : ""}${parsed.name}.optimized${parsed.ext}`;
}

function optimizeSvg(buffer: Buffer): Buffer {
  const source = buffer.toString("utf8");
  const minified = source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+(?=\/?>)/g, "")
    .trim();
  return Buffer.from(`${minified}\n`, "utf8");
}

function optimizePng(buffer: Buffer): Buffer | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 12 || !buffer.subarray(0, 8).equals(signature)) return undefined;
  const chunks: Buffer[] = [buffer.subarray(0, 8)];
  let offset = 8;
  let removed = false;
  const removable = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) return undefined;
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const chunk = buffer.subarray(offset, end);
    if (removable.has(type)) removed = true;
    else chunks.push(chunk);
    offset = end;
    if (type === "IEND") break;
  }
  if (!removed) return undefined;
  return Buffer.concat(chunks);
}

function suggestionsFor(kind: AssetReport["kind"], filePath: string, beforeBytes: number): string[] {
  const suggestions: string[] = [];
  if (kind === "png") suggestions.push("Strip PNG text/EXIF/time metadata losslessly; consider WebP/AVIF for photographic PNGs after visual QA.");
  if (kind === "jpeg") suggestions.push("Consider WebP/AVIF for large JPEGs; keep JPEG when broad compatibility or original photo quality is required.");
  if (kind === "webp") suggestions.push("WebP is already a delivery-friendly format; verify dimensions and quality target.");
  if (kind === "gif") suggestions.push("For animated GIFs, consider MP4/WebM; for static GIFs, convert to PNG/WebP.");
  if (kind === "svg") suggestions.push("Minify safe SVG markup, remove comments/extra whitespace, and keep title/desc accessibility labels.");
  if (kind === "media") suggestions.push("Use an approved media encoder for bitrate/resolution compression and verify playback quality.");
  if (imageExtensions.has(path.extname(filePath).toLowerCase()) && beforeBytes > 500 * 1024) suggestions.push("Check rendered dimensions; oversized source images should be resized to their maximum displayed size.");
  return suggestions;
}

function findingsFor(filePath: string, kind: AssetReport["kind"], beforeBytes: number, afterBytes: number | undefined, largeAssetBytes: number): AssetFinding[] {
  const findings: AssetFinding[] = [];
  if (beforeBytes >= largeAssetBytes) {
    findings.push({ id: "oversized-asset", severity: "medium", category: "oversized", path: filePath, message: `Asset is ${beforeBytes} bytes, above the ${largeAssetBytes} byte threshold.`, recommendation: "Compress, resize, or replace this asset before publishing if visual quality allows." });
  }
  if (kind === "png" && afterBytes && afterBytes < beforeBytes) {
    findings.push({ id: "png-metadata-removable", severity: "low", category: "metadata", path: filePath, message: "PNG metadata can be removed losslessly.", recommendation: "Use the optimized output or rerun with applyOptimizations=true." });
  }
  if (kind === "svg" && afterBytes && afterBytes < beforeBytes) {
    findings.push({ id: "svg-minify-available", severity: "low", category: "svg", path: filePath, message: "SVG markup can be minified safely.", recommendation: "Use the optimized output after checking accessibility labels are preserved." });
  }
  if (kind === "jpeg" && beforeBytes >= largeAssetBytes) {
    findings.push({ id: "jpeg-modern-format-candidate", severity: "low", category: "format", path: filePath, message: "Large JPEG may benefit from WebP/AVIF conversion.", recommendation: "Create a WebP/AVIF derivative with visual QA and keep JPEG fallback if needed." });
  }
  if (kind === "gif" && beforeBytes >= largeAssetBytes) {
    findings.push({ id: "gif-video-format-candidate", severity: "medium", category: "format", path: filePath, message: "Large GIFs are often inefficient for published demos.", recommendation: "Convert animated GIFs to MP4/WebM or static GIFs to PNG/WebP." });
  }
  if (kind === "media" && beforeBytes >= largeAssetBytes) {
    findings.push({ id: "large-media-asset", severity: "medium", category: "media", path: filePath, message: "Large media asset may slow published demos.", recommendation: "Review bitrate, resolution, duration, and lazy-loading strategy." });
  }
  return findings;
}

async function scanEmbeddedDataUris(projectRoot: string, projectId: string, htmlAndCssPaths: string[]): Promise<AssetFinding[]> {
  const findings: AssetFinding[] = [];
  for (const filePath of htmlAndCssPaths) {
    const source = await readProjectFile(projectRoot, projectId, filePath, 2 * 1024 * 1024).catch(() => "");
    for (const match of source.matchAll(/data:(image|font)\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/gi)) {
      const bytes = Math.floor((match[2]?.length ?? 0) * 0.75);
      if (bytes > 8 * 1024) {
        findings.push({ id: "large-embedded-data-uri", severity: "medium", category: "embedded", path: filePath, message: `Embedded ${match[1]} data URI is approximately ${bytes} bytes.`, recommendation: "Move large embedded assets into project files so they can be cached, compressed, and audited separately." });
      }
    }
  }
  return findings.slice(0, 50);
}

function markdown(report: { projectId: string; applyOptimizations: boolean; totalBeforeBytes: number; totalAfterBytes: number; totalReductionBytes: number; totalReductionPercent: number; assets: AssetReport[]; findings: AssetFinding[] }) {
  const rows = report.assets.map((asset) => `| ${asset.path} | ${asset.kind} | ${asset.beforeBytes} | ${asset.afterBytes ?? asset.beforeBytes} | ${asset.reductionPercent}% | ${asset.optimizedPath ?? "-"} | ${asset.applied ? "yes" : "no"} |`).join("\n");
  const findingRows = report.findings.map((finding) => `| ${finding.severity} | ${finding.category} | ${finding.id} | ${finding.path} | ${finding.message.replaceAll("|", "\\|")} |`).join("\n");
  return `# Asset Optimization Report

- Project: \`${report.projectId}\`
- Apply optimizations: ${report.applyOptimizations}
- Assets scanned: ${report.assets.length}
- Before bytes: ${report.totalBeforeBytes}
- After bytes: ${report.totalAfterBytes}
- Reduction: ${report.totalReductionBytes} bytes (${report.totalReductionPercent}%)
- Findings: ${report.findings.length}

## Assets

| Path | Kind | Before | After | Reduction | Optimized Path | Applied |
| --- | --- | ---: | ---: | ---: | --- | --- |
${rows || "| - | other | 0 | 0 | 0% | - | no |"}

## Findings

| Severity | Category | ID | Path | Finding |
| --- | --- | --- | --- | --- |
${findingRows || "| low | metadata | none | project | No asset optimization findings. |"}
`;
}

export const assetOptimizationTools: ToolModule[] = [
  {
    definition: {
      name: "optimize_project_assets",
      description: "Audit and safely optimize project images/assets for published demos, including oversized asset detection, lossless PNG metadata stripping, SVG minification, format suggestions, embedded data URI warnings, and before/after reports.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
          applyOptimizations: { type: "boolean" },
          losslessOnly: { type: "boolean" },
          largeAssetBytes: { type: "number" },
          optimizedDirectory: { type: "string" },
          outputJsonPath: { type: "string" },
          outputMarkdownPath: { type: "string" }
        },
        required: ["projectId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: optimizeProjectAssetsInputSchema,
    handler: async (input, ctx) => {
      const parsed = optimizeProjectAssetsInputSchema.parse(input);
      const manifest = await getProjectManifest(ctx.projectRoot, parsed.projectId);
      const allPaths = manifest.files.map((file) => file.path);
      const targetPaths = (parsed.paths?.length ? parsed.paths : allPaths.filter((filePath) => assetExtensions.has(path.extname(filePath).toLowerCase())));
      const assets: AssetReport[] = [];
      for (const filePath of targetPaths) {
        const absolutePath = await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, filePath);
        const buffer = await readFile(absolutePath);
        const kind = kindFor(filePath);
        const suggestions = suggestionsFor(kind, filePath, buffer.length);
        const optimized = kind === "png" ? optimizePng(buffer) : kind === "svg" ? optimizeSvg(buffer) : undefined;
        const smaller = optimized && optimized.length < buffer.length ? optimized : undefined;
        const optimizedPath = smaller ? optimizedPathFor(parsed.optimizedDirectory, filePath) : undefined;
        let applied = false;
        if (smaller && parsed.applyOptimizations) {
          await writeProjectAsset(ctx.projectRoot, parsed.projectId, optimizedPath!, smaller, getProjectFileContentType(filePath));
          applied = true;
        }
        const afterBytes = smaller ? smaller.length : buffer.length;
        const report: AssetReport = {
          path: filePath,
          kind,
          beforeBytes: buffer.length,
          afterBytes,
          reductionBytes: buffer.length - afterBytes,
          reductionPercent: percent(buffer.length, afterBytes),
          optimizedPath,
          applied,
          safeLossless: kind === "png" || kind === "svg",
          suggestions,
          findings: findingsFor(filePath, kind, buffer.length, smaller?.length, parsed.largeAssetBytes)
        };
        assets.push(report);
      }
      const embeddedFindings = await scanEmbeddedDataUris(ctx.projectRoot, parsed.projectId, allPaths.filter((filePath) => /\.(html?|css)$/i.test(filePath)));
      const totalBeforeBytes = assets.reduce((total, asset) => total + asset.beforeBytes, 0);
      const totalAfterBytes = assets.reduce((total, asset) => total + (asset.afterBytes ?? asset.beforeBytes), 0);
      const findings = [...assets.flatMap((asset) => asset.findings), ...embeddedFindings];
      const report = {
        projectId: parsed.projectId,
        applyOptimizations: parsed.applyOptimizations,
        losslessOnly: parsed.losslessOnly,
        totalBeforeBytes,
        totalAfterBytes,
        totalReductionBytes: totalBeforeBytes - totalAfterBytes,
        totalReductionPercent: percent(totalBeforeBytes, totalAfterBytes),
        assets,
        findings
      };
      const jsonFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputJsonPath, `${JSON.stringify(report, null, 2)}\n`);
      const markdownFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputMarkdownPath, markdown(report));
      await appendProjectTaskHistory(ctx.projectRoot, parsed.projectId, { toolName: "optimize_project_assets", ok: findings.every((finding) => finding.severity !== "high"), summary: `Asset optimization scanned ${assets.length} asset(s), possible reduction ${report.totalReductionBytes} bytes.`, details: { outputJsonPath: jsonFile.path, outputMarkdownPath: markdownFile.path, totalReductionBytes: report.totalReductionBytes, applied: parsed.applyOptimizations } });
      return { ok: true, summary: `Asset optimization scanned ${assets.length} asset(s), possible reduction ${report.totalReductionBytes} bytes.`, jobId: parsed.projectId, artifacts: [jsonFile.path, markdownFile.path, ...assets.map((asset) => asset.optimizedPath).filter((item): item is string => !!item)], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  }
];
