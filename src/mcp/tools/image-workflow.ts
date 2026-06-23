import path from "node:path";
import { z } from "zod";
import { getProjectManifest, readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ProjectFileInfo } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".ico"]);
const imageRoleSchema = z.enum(["hero", "background", "icon", "sprite", "logo", "illustration", "ui_asset", "texture"]);
const imageOperationSchema = z.enum(["generate", "edit", "remove_background", "sprite", "icon", "qa"]);

const targetAssetSchema = z.object({
  name: z.string().min(1).max(120),
  kind: imageRoleSchema,
  operation: imageOperationSchema.optional().default("generate"),
  width: z.number().int().min(1).max(8192).optional(),
  height: z.number().int().min(1).max(8192).optional(),
  transparentBackground: z.boolean().optional(),
  prompt: z.string().min(1).max(2000).optional(),
  referencePaths: z.array(z.string().min(1).max(240)).max(20).optional().default([])
});

const createImageWorkflowBriefInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160),
  purpose: z.string().min(1).max(1200),
  style: z.string().min(1).max(1600).optional(),
  constraints: z.array(z.string().min(1).max(300)).max(30).optional().default([]),
  targetAssets: z.array(targetAssetSchema).min(1).max(50),
  writeToProject: z.boolean().optional().default(true),
  outputPath: z.string().min(1).max(240).optional().default("image-workflow/brief.json")
});

const inspectProjectImageAssetsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  paths: z.array(z.string().min(1).max(240)).max(200).optional(),
  includeSvgDimensions: z.boolean().optional().default(true),
  maxBytesWarning: z.number().int().min(1).max(10 * 1024 * 1024).optional().default(1024 * 1024)
});

const spriteFrameSchema = z.object({
  name: z.string().min(1).max(120),
  sourcePath: z.string().min(1).max(240).optional(),
  width: z.number().int().min(1).max(4096),
  height: z.number().int().min(1).max(4096),
  x: z.number().int().min(0).optional(),
  y: z.number().int().min(0).optional()
});

const createSpriteSheetSpecInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  frames: z.array(spriteFrameSchema).min(1).max(200),
  columns: z.number().int().min(1).max(40).optional(),
  padding: z.number().int().min(0).max(128).optional().default(0),
  outputImagePath: z.string().min(1).max(240).optional().default("assets/sprite-sheet.png"),
  outputPath: z.string().min(1).max(240).optional().default("image-workflow/sprite-sheet.json")
});

const iconEntrySchema = z.object({
  path: z.string().min(1).max(240).optional(),
  purpose: z.enum(["app", "maskable", "favicon", "toolbar", "social", "inline"]).optional().default("app"),
  size: z.number().int().min(1).max(2048).optional(),
  transparentBackground: z.boolean().optional()
});

const createIconManifestInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  appName: z.string().min(1).max(120).optional(),
  icons: z.array(iconEntrySchema).max(100).optional().default([]),
  requiredSizes: z.array(z.number().int().min(1).max(2048)).max(30).optional().default([16, 32, 180, 192, 512]),
  outputPath: z.string().min(1).max(240).optional().default("image-workflow/icon-manifest.json")
});

const styleTokensSchema = z.object({
  palette: z.array(z.string().min(1).max(80)).max(20).optional().default([]),
  stroke: z.string().min(1).max(120).optional(),
  cornerRadius: z.string().min(1).max(120).optional(),
  lighting: z.string().min(1).max(160).optional(),
  perspective: z.string().min(1).max(160).optional(),
  texture: z.string().min(1).max(160).optional()
});

const checkImageStyleConsistencyInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  assetPaths: z.array(z.string().min(1).max(240)).min(1).max(200),
  styleTokens: styleTokensSchema.optional().default({}),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("image-workflow/style-consistency-report.json")
});

const createPlaceholderSvgAssetInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  outputPath: z.string().min(1).max(240),
  label: z.string().min(1).max(24),
  width: z.number().int().min(16).max(2048).optional().default(512),
  height: z.number().int().min(16).max(2048).optional().default(512),
  background: z.string().min(1).max(80).optional().default("#f8fafc"),
  foreground: z.string().min(1).max(80).optional().default("#0f172a"),
  shape: z.enum(["circle", "square", "rounded", "diamond"]).optional().default("rounded")
});

function isImagePath(filePath: string): boolean {
  return imageExtensions.has(path.extname(filePath).toLowerCase());
}

function inferRole(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.includes("sprite")) return "sprite";
  if (lower.includes("icon") || lower.includes("favicon")) return "icon";
  if (lower.includes("logo")) return "logo";
  if (lower.includes("hero")) return "hero";
  if (lower.includes("background") || lower.includes("bg")) return "background";
  if (lower.includes("texture")) return "texture";
  if (lower.includes("illustration")) return "illustration";
  return "image";
}

function parseSvgDimensions(svg: string): { width?: number; height?: number; viewBox?: string } {
  const root = /<svg\b([^>]*)>/i.exec(svg)?.[1] ?? "";
  const width = /(?:^|\s)width=["']?([\d.]+)/i.exec(root)?.[1];
  const height = /(?:^|\s)height=["']?([\d.]+)/i.exec(root)?.[1];
  const viewBox = /(?:^|\s)viewBox=["']([^"']+)["']/i.exec(root)?.[1];
  return {
    width: width ? Number(width) : undefined,
    height: height ? Number(height) : undefined,
    viewBox
  };
}

function assetIssues(file: ProjectFileInfo, dimensions: { width?: number; height?: number; viewBox?: string }, maxBytesWarning: number): string[] {
  const issues: string[] = [];
  const role = inferRole(file.path);
  if (file.size > maxBytesWarning) issues.push(`Asset is larger than ${maxBytesWarning} bytes.`);
  if (role === "icon" && path.extname(file.path).toLowerCase() !== ".svg" && !/\b(16|32|180|192|512)\b/.test(file.path)) {
    issues.push("Icon filename does not expose a common target size.");
  }
  if (path.extname(file.path).toLowerCase() === ".svg" && (!dimensions.width || !dimensions.height) && !dimensions.viewBox) {
    issues.push("SVG does not declare width/height or viewBox.");
  }
  return issues;
}

async function inspectImages(ctx: ToolContext, projectId: string, paths: string[] | undefined, includeSvgDimensions: boolean, maxBytesWarning: number) {
  const manifest = await getProjectManifest(ctx.projectRoot, projectId);
  const wanted = paths ? new Set(paths) : undefined;
  const imageFiles = manifest.files.filter((file) => isImagePath(file.path) && (!wanted || wanted.has(file.path)));
  const assets = await Promise.all(imageFiles.map(async (file) => {
    const extension = path.extname(file.path).toLowerCase();
    const dimensions = extension === ".svg" && includeSvgDimensions
      ? parseSvgDimensions(await readProjectFile(ctx.projectRoot, projectId, file.path, 1024 * 1024))
      : {};
    return {
      path: file.path,
      extension,
      size: file.size,
      modifiedAt: file.modifiedAt,
      role: inferRole(file.path),
      dimensions,
      issues: assetIssues(file, dimensions, maxBytesWarning)
    };
  }));
  const missing = paths?.filter((item) => !imageFiles.some((file) => file.path === item)) ?? [];
  return { projectId, assets, missing, imageCount: assets.length, issueCount: assets.reduce((sum, asset) => sum + asset.issues.length, 0) };
}

function spriteLayout(frames: Array<z.infer<typeof spriteFrameSchema>>, columns: number, padding: number) {
  const cellWidth = Math.max(...frames.map((frame) => frame.width));
  const cellHeight = Math.max(...frames.map((frame) => frame.height));
  const rows = Math.ceil(frames.length / columns);
  return {
    columns,
    rows,
    cellWidth,
    cellHeight,
    width: columns * cellWidth + Math.max(0, columns - 1) * padding,
    height: rows * cellHeight + Math.max(0, rows - 1) * padding,
    frames: frames.map((frame, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      return {
        ...frame,
        x: frame.x ?? col * (cellWidth + padding),
        y: frame.y ?? row * (cellHeight + padding)
      };
    })
  };
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

function placeholderSvg(input: z.infer<typeof createPlaceholderSvgAssetInputSchema>): string {
  const size = Math.min(input.width, input.height);
  const inset = Math.round(size * 0.14);
  const label = escapeXml(input.label.trim().slice(0, 3).toUpperCase());
  const centerX = input.width / 2;
  const centerY = input.height / 2;
  const shape = {
    circle: `<circle cx="${centerX}" cy="${centerY}" r="${Math.max(1, size / 2 - inset)}" fill="${escapeXml(input.foreground)}"/>`,
    square: `<rect x="${centerX - size / 2 + inset}" y="${centerY - size / 2 + inset}" width="${size - inset * 2}" height="${size - inset * 2}" fill="${escapeXml(input.foreground)}"/>`,
    rounded: `<rect x="${centerX - size / 2 + inset}" y="${centerY - size / 2 + inset}" width="${size - inset * 2}" height="${size - inset * 2}" rx="${Math.round(size * 0.1)}" fill="${escapeXml(input.foreground)}"/>`,
    diamond: `<path d="M ${centerX} ${centerY - size / 2 + inset} L ${centerX + size / 2 - inset} ${centerY} L ${centerX} ${centerY + size / 2 - inset} L ${centerX - size / 2 + inset} ${centerY} Z" fill="${escapeXml(input.foreground)}"/>`
  }[input.shape];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}" role="img" aria-labelledby="title">`,
    `<title id="title">${escapeXml(input.label)} placeholder icon</title>`,
    `<rect width="100%" height="100%" fill="${escapeXml(input.background)}"/>`,
    shape,
    `<text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(size * 0.22)}" font-weight="700" fill="${escapeXml(input.background)}">${label}</text>`,
    "</svg>",
    ""
  ].join("\n");
}

function iconRecommendations(icons: Array<z.infer<typeof iconEntrySchema>>, requiredSizes: number[]): string[] {
  const existingSizes = new Set(icons.map((icon) => icon.size).filter((size): size is number => typeof size === "number"));
  const recommendations = requiredSizes.filter((size) => !existingSizes.has(size)).map((size) => `Add a ${size}x${size} icon.`);
  if (!icons.some((icon) => icon.purpose === "maskable")) recommendations.push("Add at least one maskable app icon for PWA installs.");
  if (!icons.some((icon) => icon.purpose === "favicon" || icon.size === 16 || icon.size === 32)) recommendations.push("Add favicon-sized icons for browser tabs.");
  return recommendations;
}

function styleConsistencyReport(assetPaths: string[], styleTokens: z.infer<typeof styleTokensSchema>) {
  const extensions = [...new Set(assetPaths.map((assetPath) => path.extname(assetPath).toLowerCase()))].filter(Boolean);
  const roles = assetPaths.map((assetPath) => ({ path: assetPath, role: inferRole(assetPath) }));
  const warnings: string[] = [];
  if (extensions.length > 3) warnings.push("Many image formats are mixed; confirm this is intentional for caching and rendering.");
  if (styleTokens.palette.length === 0) warnings.push("No palette tokens supplied for style consistency checks.");
  if (!styleTokens.stroke && assetPaths.some((assetPath) => inferRole(assetPath) === "icon")) warnings.push("Icon assets have no stroke/fill token to check against.");
  if (assetPaths.some((assetPath) => inferRole(assetPath) === "sprite") && extensions.some((extension) => extension !== ".png" && extension !== ".webp" && extension !== ".svg")) {
    warnings.push("Sprite assets should normally use PNG, WebP, or SVG.");
  }
  return {
    assetCount: assetPaths.length,
    extensions,
    roles,
    styleTokens,
    warnings,
    checks: [
      "Review dimensions and transparent backgrounds for icons, sprites, and overlays.",
      "Compare generated assets against palette, stroke, lighting, perspective, and texture tokens.",
      "Run browser visual QA after assets are placed in the page."
    ]
  };
}

export const imageWorkflowTools: ToolModule[] = [
  {
    definition: {
      name: "create_image_workflow_brief",
      description: "Create a durable image generation/editing/background-removal brief for project assets.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, purpose: { type: "string" }, style: { type: "string" }, constraints: { type: "array", items: { type: "string" } }, targetAssets: { type: "array" }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["projectId", "title", "purpose", "targetAssets"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createImageWorkflowBriefInputSchema,
    handler: async (input, ctx) => {
      const parsed = createImageWorkflowBriefInputSchema.parse(input);
      const brief = {
        projectId: parsed.projectId,
        title: parsed.title,
        purpose: parsed.purpose,
        style: parsed.style,
        constraints: parsed.constraints,
        targetAssets: parsed.targetAssets,
        workflow: ["Generate or edit assets from this brief.", "Import final assets with write_project_asset/import_project_asset_from_url.", "Run inspect_project_image_assets and check_image_style_consistency before publishing."],
        createdAt: new Date().toISOString()
      };
      const artifacts: string[] = [];
      if (parsed.writeToProject) {
        const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(brief, null, 2)}\n`);
        artifacts.push(file.path);
      }
      return { ok: true, summary: `Created image workflow brief for ${parsed.targetAssets.length} asset(s).`, jobId: parsed.projectId, artifacts, structuredContent: brief, logs: [JSON.stringify(brief, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "inspect_project_image_assets",
      description: "List project image assets with inferred roles, SVG dimensions, file-size warnings, and missing requested paths.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, paths: { type: "array", items: { type: "string" } }, includeSvgDimensions: { type: "boolean" }, maxBytesWarning: { type: "number" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: inspectProjectImageAssetsInputSchema,
    handler: async (input, ctx) => {
      const parsed = inspectProjectImageAssetsInputSchema.parse(input);
      const result = await inspectImages(ctx, parsed.projectId, parsed.paths, parsed.includeSvgDimensions, parsed.maxBytesWarning);
      return { ok: true, summary: `Inspected ${result.imageCount} image asset(s), found ${result.issueCount} issue(s).`, jobId: parsed.projectId, artifacts: result.assets.map((asset) => asset.path), structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "create_sprite_sheet_spec",
      description: "Create a deterministic sprite-sheet layout spec for project sprites without mutating source images.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, frames: { type: "array" }, columns: { type: "number" }, padding: { type: "number" }, outputImagePath: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "frames"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createSpriteSheetSpecInputSchema,
    handler: async (input, ctx) => {
      const parsed = createSpriteSheetSpecInputSchema.parse(input);
      const columns = parsed.columns ?? Math.ceil(Math.sqrt(parsed.frames.length));
      const layout = spriteLayout(parsed.frames, columns, parsed.padding);
      const spec = { projectId: parsed.projectId, outputImagePath: parsed.outputImagePath, padding: parsed.padding, ...layout };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(spec, null, 2)}\n`);
      return { ok: true, summary: `Created sprite sheet spec with ${parsed.frames.length} frame(s), ${layout.width}x${layout.height}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: spec, logs: [JSON.stringify(spec, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "create_icon_manifest",
      description: "Create a project icon manifest with required-size coverage and PWA/favicon recommendations.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, appName: { type: "string" }, icons: { type: "array" }, requiredSizes: { type: "array", items: { type: "number" } }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createIconManifestInputSchema,
    handler: async (input, ctx) => {
      const parsed = createIconManifestInputSchema.parse(input);
      const manifest = { projectId: parsed.projectId, appName: parsed.appName, icons: parsed.icons, requiredSizes: parsed.requiredSizes, recommendations: iconRecommendations(parsed.icons, parsed.requiredSizes), createdAt: new Date().toISOString() };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: true, summary: `Created icon manifest with ${manifest.recommendations.length} recommendation(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: manifest, logs: [JSON.stringify(manifest, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "check_image_style_consistency",
      description: "Run a bounded heuristic style-consistency checklist over project image asset paths.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, assetPaths: { type: "array", items: { type: "string" } }, styleTokens: { type: "object" }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["projectId", "assetPaths"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: checkImageStyleConsistencyInputSchema,
    handler: async (input, ctx) => {
      const parsed = checkImageStyleConsistencyInputSchema.parse(input);
      const report = styleConsistencyReport(parsed.assetPaths, parsed.styleTokens);
      const artifacts = parsed.assetPaths.slice();
      if (parsed.writeToProject) {
        const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(report, null, 2)}\n`);
        artifacts.push(file.path);
      }
      return { ok: true, summary: `Checked ${report.assetCount} image path(s), found ${report.warnings.length} warning(s).`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "create_placeholder_svg_asset",
      description: "Generate a safe SVG placeholder icon/asset inside a project for early visual workflows.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, outputPath: { type: "string" }, label: { type: "string" }, width: { type: "number" }, height: { type: "number" }, background: { type: "string" }, foreground: { type: "string" }, shape: { type: "string", enum: ["circle", "square", "rounded", "diamond"] } }, required: ["projectId", "outputPath", "label"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createPlaceholderSvgAssetInputSchema,
    handler: async (input, ctx) => {
      const parsed = createPlaceholderSvgAssetInputSchema.parse(input);
      if (path.extname(parsed.outputPath).toLowerCase() !== ".svg") throw new Error("outputPath must end with .svg.");
      const svg = placeholderSvg(parsed);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, svg);
      return { ok: true, summary: `Created placeholder SVG asset at ${file.path}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { path: file.path, width: parsed.width, height: parsed.height, shape: parsed.shape, svg }, logs: [svg], errors: [] };
    }
  }
];
