import { z } from "zod";
import { readProjectFile, writeProjectFile } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const svgThemeSchema = z.object({
  palette: z.array(z.string().min(1).max(40)).max(12).optional().default(["#0f172a", "#2563eb", "#14b8a6", "#f8fafc"]),
  background: z.string().min(1).max(40).optional().default("#ffffff"),
  text: z.string().min(1).max(40).optional().default("#111827"),
  strokeWidth: z.number().min(0.5).max(12).optional().default(2),
  radius: z.number().int().min(0).max(40).optional().default(8),
  fontFamily: z.string().min(1).max(120).optional().default("Inter, Arial, sans-serif")
});

const svgElementSchema = z.object({
  id: z.string().min(1).max(80),
  type: z.enum(["card", "node", "label", "icon", "connector", "callout", "shape"]).optional().default("card"),
  label: z.string().min(1).max(200).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().int().min(8).max(2000).optional(),
  height: z.number().int().min(8).max(2000).optional(),
  fill: z.string().min(1).max(40).optional(),
  stroke: z.string().min(1).max(40).optional()
});

const sceneElementInputSchema = z.union([z.string().min(1).max(120), svgElementSchema]);

const generateSvgSceneInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  prompt: z.string().min(1).max(2000).optional(),
  canvas: z.object({
    width: z.number().int().min(120).max(4096).optional().default(960),
    height: z.number().int().min(120).max(4096).optional().default(540)
  }).optional(),
  title: z.string().min(1).max(160).optional().default("SVG Scene"),
  width: z.number().int().min(120).max(4096).optional().default(960),
  height: z.number().int().min(120).max(4096).optional().default(540),
  style: z.enum(["enterprise_erp_admin", "erp_admin", "enterprise_tech", "playful_product", "minimal_monochrome", "dark_mode", "light_mode"]).optional().default("enterprise_erp_admin"),
  sceneType: z.string().min(1).max(120).optional().default("illustration"),
  elements: z.array(sceneElementInputSchema).max(80).optional().default([]),
  layers: z.array(z.string().min(1).max(80)).max(20).optional().default(["defs", "background", "content", "labels"]),
  theme: svgThemeSchema.optional().default({}),
  outputPath: z.string().min(1).max(240).optional().default("svg-design/scene.svg"),
  outputManifestPath: z.string().min(1).max(240).optional().default("svg-design/scene-manifest.json")
});

const layoutSvgElementsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  sceneManifestPath: z.string().min(1).max(240).optional(),
  elements: z.array(svgElementSchema).max(160).optional(),
  nodes: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(160), group: z.string().min(1).max(80).optional() })).max(160).optional(),
  edges: z.array(z.union([z.object({ from: z.string().min(1).max(80), to: z.string().min(1).max(80), label: z.string().min(1).max(120).optional() }), z.tuple([z.string().min(1).max(80), z.string().min(1).max(80)])])).max(300).optional().default([]),
  layout: z.enum(["flow", "grid", "timeline", "mind_map", "org_chart", "architecture", "process"]).optional(),
  layoutType: z.enum(["flowchart", "workflow", "layered_dag", "tree", "radial_mind_map", "grid", "swimlane", "timeline", "card_dashboard", "architecture_diagram", "process_pipeline", "org_chart"]).optional().default("workflow"),
  direction: z.enum(["left_to_right", "top_to_bottom", "right_to_left", "radial"]).optional().default("left_to_right"),
  canvas: z.object({
    width: z.number().int().min(120).max(4096).optional().default(960),
    height: z.number().int().min(120).max(4096).optional().default(540)
  }).optional(),
  width: z.number().int().min(120).max(4096).optional().default(960),
  spacing: z.number().int().min(8).max(160).optional().default(32),
  constraints: z.object({
    minNodeGap: z.number().int().min(8).max(240).optional().default(32),
    avoidOverlap: z.boolean().optional().default(true),
    routeConnectors: z.boolean().optional().default(true),
    responsive: z.boolean().optional().default(false),
    groupBy: z.string().min(1).max(80).optional()
  }).optional().default({}),
  outputSvgPath: z.string().min(1).max(240).optional().default("svg-design/layout.svg"),
  outputPath: z.string().min(1).max(240).optional().default("svg-design/layout.json")
}).refine((value) => Boolean(value.sceneManifestPath || value.elements?.length || value.nodes?.length), { message: "sceneManifestPath, elements, or nodes is required." });

const fitSvgTypographyInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  svgPath: z.string().min(1).max(240).optional(),
  textBlocks: z.array(z.object({
    id: z.string().min(1).max(80),
    text: z.string().min(1).max(1000),
    width: z.number().int().min(20).max(1600),
    height: z.number().int().min(16).max(1200).optional(),
    maxLines: z.number().int().min(1).max(12).optional().default(3),
    minFontSize: z.number().int().min(8).max(64).optional().default(12),
    maxFontSize: z.number().int().min(8).max(96).optional().default(18),
    language: z.enum(["en", "zh", "mixed"]).optional().default("mixed"),
    hierarchy: z.enum(["title", "subtitle", "body", "label", "badge", "caption"]).optional().default("label")
  })).max(80).optional(),
  textBoxes: z.array(z.object({
    id: z.string().min(1).max(80),
    text: z.string().min(1).max(1000),
    box: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number().int().min(20).max(1600),
      height: z.number().int().min(16).max(1200)
    }),
    minFontSize: z.number().int().min(8).max(64).optional().default(10),
    maxFontSize: z.number().int().min(8).max(96).optional().default(16),
    wrap: z.boolean().optional().default(true),
    truncate: z.boolean().optional().default(false),
    align: z.enum(["start", "middle", "end"]).optional().default("middle"),
    verticalAlign: z.enum(["top", "middle", "bottom"]).optional().default("middle"),
    hierarchy: z.enum(["title", "subtitle", "body", "label", "badge", "caption"]).optional().default("label"),
    language: z.enum(["en", "zh", "mixed"]).optional()
  })).max(120).optional(),
  languageHints: z.array(z.enum(["en", "zh", "mixed"])).max(4).optional().default(["mixed"]),
  style: z.enum(["erp_admin", "enterprise_erp_admin", "technical", "report", "minimal"]).optional().default("erp_admin"),
  outputSvgPath: z.string().min(1).max(240).optional().default("svg-design/typography-fit.svg"),
  outputPath: z.string().min(1).max(240).optional().default("svg-design/typography-fit.json")
}).refine((value) => Boolean(value.textBlocks?.length || value.textBoxes?.length), { message: "textBlocks or textBoxes is required." });

const svgPathInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  svgPath: z.string().min(1).max(240),
  outputPath: z.string().min(1).max(240).optional()
});

const inspectSvgVisualQualityInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  svgPath: z.string().min(1).max(240).optional(),
  svgString: z.string().min(1).max(4 * 1024 * 1024).optional(),
  expectedStyle: z.enum(["enterprise_erp_admin", "erp_admin", "technical", "report", "minimal", "dark_mode", "light_mode"]).optional(),
  previewSizes: z.array(z.object({
    width: z.number().int().min(120).max(4096),
    height: z.number().int().min(120).max(4096)
  })).max(6).optional().default([]),
  designTokens: svgThemeSchema.optional(),
  checkAccessibility: z.boolean().optional().default(false),
  targetViewportWidth: z.number().int().min(240).max(4096).optional().default(390),
  minTextSize: z.number().int().min(8).max(32).optional().default(12),
  outputPath: z.string().min(1).max(240).optional().default("svg-design/visual-quality-report.json")
}).refine((value) => Boolean(value.svgPath || value.svgString), { message: "svgPath or svgString is required." });

const applySvgDesignTokensInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  svgPath: z.string().min(1).max(240).optional(),
  svgString: z.string().min(1).max(4 * 1024 * 1024).optional(),
  tokenProfile: z.enum(["erp_admin_compact", "enterprise_tech", "monochrome", "playful_product", "presentation"]).optional(),
  targetTheme: z.enum(["light", "dark", "enterprise_tech", "erp_admin", "monochrome", "playful_product", "presentation"]).optional(),
  preserveSemanticColors: z.boolean().optional().default(true),
  componentStyleMapping: z.record(z.string()).optional().default({}),
  theme: svgThemeSchema.optional().default({}),
  outputPath: z.string().min(1).max(240).optional().default("svg-design/tokenized.svg"),
  outputTokensPath: z.string().min(1).max(240).optional().default("svg-design/tokens.json")
}).refine((value) => Boolean(value.svgPath || value.svgString), { message: "svgPath or svgString is required." });

const optimizeSvgPathsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  svgPath: z.string().min(1).max(240).optional(),
  svgString: z.string().min(1).max(4 * 1024 * 1024).optional(),
  mode: z.enum(["conservative", "balanced", "aggressive"]).optional().default("balanced"),
  precision: z.number().int().min(0).max(4).optional().default(2),
  removeMetadata: z.boolean().optional().default(true),
  removeUnusedDefs: z.boolean().optional().default(true),
  removeHiddenElements: z.boolean().optional().default(true),
  normalizeStroke: z.boolean().optional().default(true),
  preserveAccessibility: z.boolean().optional().default(true),
  preserveIds: z.array(z.string().min(1).max(120)).max(80).optional().default(["aria", "animation", "interactive"]),
  outputPath: z.string().min(1).max(240).optional().default("svg-design/optimized.svg"),
  outputReportPath: z.string().min(1).max(240).optional().default("svg-design/optimization-report.json")
}).refine((value) => Boolean(value.svgPath || value.svgString), { message: "svgPath or svgString is required." });

const diagramNodeSchema = z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(160), group: z.string().min(1).max(80).optional(), lane: z.string().min(1).max(80).optional(), icon: z.string().min(1).max(80).optional(), kind: z.string().min(1).max(80).optional() });
const diagramEdgeSchema = z.object({ from: z.string().min(1).max(80), to: z.string().min(1).max(80), label: z.string().min(1).max(120).optional(), kind: z.enum(["sync", "async", "data", "control", "dependency"]).optional().default("control") });
const generateSvgDiagramInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160).optional().default("SVG Diagram"),
  prompt: z.string().min(1).max(4000).optional(),
  mermaidSpec: z.string().min(1).max(12000).optional(),
  jsonSpec: z.object({
    nodes: z.array(diagramNodeSchema).max(160).optional(),
    edges: z.array(diagramEdgeSchema).max(300).optional(),
    groups: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(160).optional(), color: z.string().min(1).max(40).optional() })).max(40).optional(),
    swimlanes: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(160).optional() })).max(20).optional(),
    legend: z.array(z.object({ label: z.string().min(1).max(160), color: z.string().min(1).max(40).optional(), shape: z.string().min(1).max(40).optional() })).max(20).optional(),
    callouts: z.array(z.object({ text: z.string().min(1).max(240), nodeId: z.string().min(1).max(80).optional(), x: z.number().optional(), y: z.number().optional() })).max(30).optional()
  }).optional(),
  diagramType: z.enum(["system_architecture", "workflow", "api_flow", "db_relation", "module_dependency", "deployment", "business_process", "sequence_static"]).optional().default("workflow"),
  nodes: z.array(diagramNodeSchema).max(160).optional(),
  edges: z.array(diagramEdgeSchema).max(200).optional().default([]),
  groups: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(160).optional(), color: z.string().min(1).max(40).optional() })).max(40).optional().default([]),
  swimlanes: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(160).optional() })).max(20).optional().default([]),
  legend: z.array(z.object({ label: z.string().min(1).max(160), color: z.string().min(1).max(40).optional(), shape: z.string().min(1).max(40).optional() })).max(20).optional().default([]),
  callouts: z.array(z.object({ text: z.string().min(1).max(240), nodeId: z.string().min(1).max(80).optional(), x: z.number().optional(), y: z.number().optional() })).max(30).optional().default([]),
  direction: z.enum(["left_to_right", "top_to_bottom"]).optional().default("left_to_right"),
  canvas: z.object({ width: z.number().int().min(480).max(4096).optional().default(1200), height: z.number().int().min(320).max(4096).optional().default(720) }).optional(),
  theme: svgThemeSchema.optional().default({}),
  includePngPreview: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("svg-design/diagram.svg"),
  outputManifestPath: z.string().min(1).max(240).optional().default("svg-design/diagram-manifest.json"),
  outputPreviewPath: z.string().min(1).max(240).optional().default("svg-design/diagram-preview.png")
}).refine((value) => Boolean(value.prompt || value.mermaidSpec || value.jsonSpec?.nodes?.length || value.nodes?.length), { message: "prompt, mermaidSpec, jsonSpec.nodes, or nodes is required." });

const generateSvgChartInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160),
  chartType: z.enum(["bar", "line", "area", "stacked_bar", "pie", "donut", "gauge", "treemap", "heatmap", "sankey", "waterfall", "radar", "dashboard_cards"]).optional().default("bar"),
  data: z.array(z.record(z.union([z.string(), z.number(), z.boolean()]))).max(500).optional(),
  jsonData: z.union([z.string().min(1).max(2 * 1024 * 1024), z.array(z.record(z.union([z.string(), z.number(), z.boolean()]))).max(500)]).optional(),
  csvString: z.string().min(1).max(2 * 1024 * 1024).optional(),
  tableData: z.object({
    columns: z.array(z.string().min(1).max(80)).min(1).max(80),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean()])).max(80)).max(500)
  }).optional(),
  xField: z.string().min(1).max(80).optional().default("label"),
  yField: z.string().min(1).max(80).optional().default("value"),
  seriesFields: z.array(z.string().min(1).max(80)).max(20).optional().default([]),
  annotations: z.array(z.object({ label: z.string().min(1).max(160), x: z.string().min(1).max(120).optional(), y: z.number().optional(), note: z.string().min(1).max(240).optional() })).max(30).optional().default([]),
  responsive: z.boolean().optional().default(true),
  includeLegend: z.boolean().optional().default(true),
  includePngPreview: z.boolean().optional().default(false),
  canvas: z.object({ width: z.number().int().min(320).max(4096).optional().default(960), height: z.number().int().min(240).max(4096).optional().default(540) }).optional(),
  theme: svgThemeSchema.optional().default({}),
  outputPath: z.string().min(1).max(240).optional().default("svg-design/chart.svg"),
  outputManifestPath: z.string().min(1).max(240).optional().default("svg-design/chart-manifest.json"),
  outputPreviewPath: z.string().min(1).max(240).optional().default("svg-design/chart-preview.png")
}).refine((value) => Boolean(value.data?.length || value.jsonData || value.csvString || value.tableData), { message: "data, jsonData, csvString, or tableData is required." });

const generateIsometricSvgInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160),
  prompt: z.string().min(1).max(4000).optional(),
  sceneJson: z.object({
    primitives: z.array(z.object({
      type: z.enum(["people", "person", "desk", "warehouse_shelf", "box", "screen", "server", "arrow", "label", "vehicle", "platform", "building", "dashboard", "pipeline"]),
      label: z.string().min(1).max(120).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      scale: z.number().min(0.3).max(3).optional(),
      layer: z.string().min(1).max(80).optional()
    })).max(120).optional(),
    labels: z.array(z.object({ text: z.string().min(1).max(160), x: z.number(), y: z.number() })).max(60).optional(),
    flows: z.array(z.object({ from: z.string().min(1).max(120), to: z.string().min(1).max(120), label: z.string().min(1).max(120).optional() })).max(80).optional()
  }).optional(),
  scene: z.enum(["office", "warehouse", "server_room", "dashboard_workspace", "logistics_flow", "business_process", "erp_operations", "data_pipeline", "customer_service", "inventory_flow", "delivery_flow", "saas_product_explainer"]).optional().default("warehouse"),
  objects: z.array(z.string().min(1).max(80)).max(30).optional().default(["workstation", "dashboard", "workflow"]),
  canvas: z.object({ width: z.number().int().min(480).max(4096).optional().default(960), height: z.number().int().min(320).max(4096).optional().default(540) }).optional(),
  includePngPreview: z.boolean().optional().default(false),
  theme: svgThemeSchema.optional().default({}),
  outputPath: z.string().min(1).max(240).optional().default("svg-design/isometric.svg"),
  outputOptimizedPath: z.string().min(1).max(240).optional().default("svg-design/isometric-optimized.svg"),
  outputManifestPath: z.string().min(1).max(240).optional().default("svg-design/isometric-manifest.json"),
  outputPreviewPath: z.string().min(1).max(240).optional().default("svg-design/isometric-preview.png")
});

const generateSvgIconSetInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  familyName: z.string().min(1).max(120).optional(),
  prompt: z.string().min(1).max(2000).optional(),
  domain: z.enum(["inventory", "finance", "sales", "delivery", "ai_tools", "workflow", "security", "settings", "reporting", "erp_modules", "admin_panel", "product_features"]).optional(),
  icons: z.array(z.object({ name: z.string().min(1).max(80), concept: z.string().min(1).max(160).optional(), label: z.string().min(1).max(160).optional() })).max(120).optional(),
  style: z.enum(["outline", "filled", "duotone", "monochrome", "dark_mode_safe", "admin_panel"]).optional().default("outline"),
  gridSize: z.number().int().min(16).max(128).optional().default(24),
  padding: z.number().int().min(0).max(32).optional().default(3),
  designTokens: z.object({
    strokeWidth: z.number().min(0.5).max(8).optional(),
    radius: z.number().int().min(0).max(32).optional(),
    palette: z.array(z.string().min(1).max(40)).max(12).optional(),
    opticalWeight: z.enum(["light", "regular", "medium", "bold"]).optional()
  }).optional().default({}),
  theme: svgThemeSchema.optional().default({}),
  outputDirectory: z.string().min(1).max(200).optional().default("svg-design/icons"),
  outputManifestPath: z.string().min(1).max(240).optional().default("svg-design/icon-set-manifest.json"),
  outputSpritePath: z.string().min(1).max(240).optional().default("svg-design/icon-sprite.svg"),
  outputPreviewPath: z.string().min(1).max(240).optional().default("svg-design/icon-preview-sheet.svg"),
  outputReadmePath: z.string().min(1).max(240).optional().default("svg-design/icon-set-README.md")
}).refine((value) => Boolean(value.icons?.length || value.domain || value.prompt), { message: "icons, domain, or prompt is required." });

const animateSvgSceneInputSchema = svgPathInputSchema.extend({
  animation: z.enum(["path_draw", "fade", "scale", "pulse", "flow_line", "step_reveal"]).optional().default("fade"),
  durationMs: z.number().int().min(100).max(20000).optional().default(1200),
  outputPath: z.string().min(1).max(240).optional().default("svg-design/animated.svg")
});

const addSvgInteractivityInputSchema = svgPathInputSchema.extend({
  hotspots: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(160), x: z.number(), y: z.number(), width: z.number().min(8), height: z.number().min(8) })).max(80).optional().default([]),
  interaction: z.enum(["hover_tooltip", "click_highlight", "step_reveal"]).optional().default("hover_tooltip"),
  outputPath: z.string().min(1).max(240).optional().default("svg-design/interactive.svg")
});

const animateAndInteractSvgInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  svgPath: z.string().min(1).max(240).optional(),
  svgString: z.string().min(1).max(4 * 1024 * 1024).optional(),
  animations: z.array(z.object({
    id: z.string().min(1).max(80).optional(),
    selector: z.string().min(1).max(200).optional(),
    type: z.enum(["path_draw", "fade", "scale", "rotate", "pulse", "bounce", "flow_line", "loading", "step_reveal"]),
    durationMs: z.number().int().min(100).max(20000).optional().default(1200),
    delayMs: z.number().int().min(0).max(20000).optional().default(0),
    easing: z.string().min(1).max(80).optional().default("ease")
  })).max(80).optional().default([{ type: "fade", durationMs: 1200, delayMs: 0, easing: "ease" }]),
  interactions: z.array(z.object({
    id: z.string().min(1).max(80),
    type: z.enum(["hover", "hotspot", "tooltip", "click", "expand_collapse", "state_switch", "step_reveal"]),
    label: z.string().min(1).max(160),
    selector: z.string().min(1).max(200).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().min(8).optional(),
    height: z.number().min(8).optional(),
    tooltip: z.string().min(1).max(240).optional(),
    targetState: z.string().min(1).max(80).optional()
  })).max(100).optional().default([]),
  reducedMotion: z.boolean().optional().default(true),
  outputPath: z.string().min(1).max(240).optional().default("svg-design/animated-interactive.svg"),
  outputCssPath: z.string().min(1).max(240).optional().default("svg-design/animated-interactive.css"),
  outputWaapiPath: z.string().min(1).max(240).optional().default("svg-design/waapi-config.json"),
  outputManifestPath: z.string().min(1).max(240).optional().default("svg-design/interaction-manifest.json")
}).refine((value) => Boolean(value.svgPath || value.svgString), { message: "svgPath or svgString is required." });

const inspectSvgAccessibilityInputSchema = svgPathInputSchema.extend({
  interactive: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("svg-design/accessibility-report.json")
});

const exportSvgProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  svgPaths: z.array(z.string().min(1).max(240)).min(1).max(120),
  includeOptimized: z.boolean().optional().default(true),
  includeSprite: z.boolean().optional().default(true),
  includeReadme: z.boolean().optional().default(true),
  includePreviewHtml: z.boolean().optional().default(true),
  includePdfReady: z.boolean().optional().default(true),
  includeTokenJson: z.boolean().optional().default(true),
  packageName: z.string().min(1).max(120).optional().default("SVG Export Package"),
  designTokens: z.record(z.unknown()).optional().default({}),
  licenseNotes: z.array(z.string().min(1).max(300)).max(40).optional().default([]),
  themeVariants: z.array(z.string().min(1).max(80)).max(20).optional().default(["light", "dark"]),
  intendedUsage: z.array(z.string().min(1).max(120)).max(40).optional().default(["website", "admin_panel", "presentation"]),
  outputPackageDir: z.string().min(1).max(180).optional().default("svg-design/export-package"),
  outputManifestPath: z.string().min(1).max(240).optional().default("svg-design/export-manifest.json"),
  outputReadmePath: z.string().min(1).max(240).optional().default("svg-design/README.md"),
  outputSpritePath: z.string().min(1).max(240).optional().default("svg-design/export-package/sprite.svg"),
  outputPreviewHtmlPath: z.string().min(1).max(240).optional().default("svg-design/export-package/preview.html"),
  outputTokensPath: z.string().min(1).max(240).optional().default("svg-design/export-package/design-tokens.json"),
  outputAccessibilityPath: z.string().min(1).max(240).optional().default("svg-design/export-package/accessibility-metadata.json")
});

const processSvgRevisionFeedbackInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  feedback: z.string().min(1).max(2000),
  svgPath: z.string().min(1).max(240).optional(),
  svgString: z.string().min(1).max(4 * 1024 * 1024).optional(),
  designTokens: z.record(z.unknown()).optional().default({}),
  screenshotPath: z.string().min(1).max(240).optional(),
  applyPatch: z.boolean().optional().default(true),
  outputPath: z.string().min(1).max(240).optional().default("svg-design/revision-plan.json"),
  outputPatchedSvgPath: z.string().min(1).max(240).optional().default("svg-design/revised.svg"),
  outputPreviewPath: z.string().min(1).max(240).optional().default("svg-design/revision-preview.html"),
  outputQaPath: z.string().min(1).max(240).optional().default("svg-design/revision-qa.json")
});

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

function svgRoot(title: string, width: number, height: number, body: string, desc = "Generated SVG asset") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">\n<title id="title">${xml(title)}</title>\n<desc id="desc">${xml(desc)}</desc>\n${body}\n</svg>\n`;
}

function wrapText(text: string, maxChars: number, maxLines: number) {
  const chars = Array.from(text);
  const lines: string[] = [];
  let line = "";
  for (const ch of chars) {
    if ((line + ch).length > maxChars && lines.length < maxLines - 1) {
      lines.push(line.trim());
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.slice(0, maxLines);
}

function detectTypographyLanguage(text: string, hints: Array<"en" | "zh" | "mixed">) {
  const hasZh = /[\u3400-\u9fff]/.test(text);
  const hasLatin = /[a-z]/i.test(text);
  if (hasZh && hasLatin) return "mixed";
  if (hasZh) return "zh";
  if (hasLatin) return hints.includes("en") ? "en" : "mixed";
  return hints[0] ?? "mixed";
}

function characterWidthRatio(language: "en" | "zh" | "mixed") {
  if (language === "zh") return 1;
  if (language === "en") return 0.58;
  return 0.74;
}

function hierarchyWeight(hierarchy: string) {
  if (hierarchy === "title") return "800";
  if (hierarchy === "subtitle") return "700";
  if (hierarchy === "badge") return "700";
  return "600";
}

function lineLimitForBox(height: number, fontSize: number) {
  return Math.max(1, Math.floor(height / Math.round(fontSize * 1.25)));
}

function fitTextToBox(options: {
  id: string;
  text: string;
  width: number;
  height: number;
  minFontSize: number;
  maxFontSize: number;
  wrap: boolean;
  truncate: boolean;
  language: "en" | "zh" | "mixed";
  hierarchy: string;
}) {
  for (let fontSize = options.maxFontSize; fontSize >= options.minFontSize; fontSize -= 1) {
    const ratio = characterWidthRatio(options.language);
    const maxChars = Math.max(1, Math.floor(options.width / (fontSize * ratio)));
    const maxLines = options.wrap ? lineLimitForBox(options.height, fontSize) : 1;
    const lines = options.wrap ? wrapText(options.text, maxChars, maxLines) : [options.text];
    const overflow = lines.join("").length < Array.from(options.text).join("").length || lines.some((line) => Array.from(line).length > maxChars);
    if (!overflow) {
      const lineHeight = Math.round(fontSize * 1.25);
      return { id: options.id, text: options.text, fontSize, lines, lineHeight, overflow: false, truncated: false, hierarchy: options.hierarchy, language: options.language };
    }
  }
  const ratio = characterWidthRatio(options.language);
  const fontSize = options.minFontSize;
  const maxChars = Math.max(1, Math.floor(options.width / (fontSize * ratio)));
  const maxLines = options.wrap ? lineLimitForBox(options.height, fontSize) : 1;
  let lines = options.wrap ? wrapText(options.text, maxChars, maxLines) : [options.text];
  let truncated = false;
  if (options.truncate && lines.length) {
    const lastIndex = lines.length - 1;
    const last = Array.from(lines[lastIndex]);
    if (last.length >= maxChars) lines[lastIndex] = `${last.slice(0, Math.max(1, maxChars - 3)).join("")}...`;
    else lines[lastIndex] = `${lines[lastIndex]}...`;
    truncated = true;
  }
  const renderedText = lines.join("").replace(/\.\.\.$/, "");
  const overflow = !options.truncate && renderedText.length < Array.from(options.text).join("").length;
  return { id: options.id, text: options.text, fontSize, lines, lineHeight: Math.round(fontSize * 1.25), overflow, truncated, hierarchy: options.hierarchy, language: options.language };
}

function layoutElements(elements: Array<z.infer<typeof svgElementSchema>>, width: number, spacing: number, layout: string) {
  const cardW = 180;
  const cardH = 72;
  const cols = layout === "timeline" ? elements.length : Math.max(1, Math.floor((width - spacing) / (cardW + spacing)));
  return elements.map((element, index) => {
    const col = layout === "timeline" ? index : index % cols;
    const row = layout === "timeline" ? 0 : Math.floor(index / cols);
    return {
      ...element,
      x: element.x ?? spacing + col * (cardW + spacing),
      y: element.y ?? spacing + row * (cardH + spacing),
      width: element.width ?? cardW,
      height: element.height ?? cardH
    };
  });
}

function normalizeLayoutInputs(input: z.infer<typeof layoutSvgElementsInputSchema>, sceneManifest?: Record<string, unknown>) {
  const manifestComponents = Array.isArray(sceneManifest?.componentList)
    ? (sceneManifest.componentList as Array<Record<string, unknown>>).map((component) => ({ id: String(component.id), label: String(component.label ?? component.id), group: String(component.layer ?? "") }))
    : [];
  const nodes = input.nodes?.length
    ? input.nodes
    : input.elements?.length
      ? input.elements.map((element) => ({ id: element.id, label: element.label ?? element.id, group: element.type }))
      : manifestComponents;
  const elements = nodes.map((node) => ({ id: node.id, label: node.label, type: "node" as const, width: 180, height: 72 }));
  const edges = input.edges.map((edge) => Array.isArray(edge) ? { from: edge[0], to: edge[1] } : edge);
  return { nodes, elements, edges };
}

function advancedLayout(input: z.infer<typeof layoutSvgElementsInputSchema>, elements: Array<z.infer<typeof svgElementSchema>>) {
  const canvasWidth = input.canvas?.width ?? input.width;
  const canvasHeight = input.canvas?.height ?? 540;
  const gap = input.constraints.minNodeGap ?? input.spacing;
  const nodeW = 180;
  const nodeH = 72;
  const count = Math.max(1, elements.length);
  const useVertical = input.direction === "top_to_bottom" || input.layoutType === "org_chart" || input.layoutType === "tree";
  const useRadial = input.direction === "radial" || input.layoutType === "radial_mind_map";
  if (useRadial) {
    const cx = canvasWidth / 2;
    const cy = canvasHeight / 2;
    const radius = Math.max(120, Math.min(canvasWidth, canvasHeight) / 2 - nodeW);
    return elements.map((element, index) => {
      const angle = -Math.PI / 2 + index / count * Math.PI * 2;
      return { ...element, x: Math.round(cx + Math.cos(angle) * radius - nodeW / 2), y: Math.round(cy + Math.sin(angle) * radius - nodeH / 2), width: nodeW, height: nodeH };
    });
  }
  if (input.layoutType === "swimlane") {
    const groups = [...new Set(elements.map((element) => element.type ?? "default"))];
    return elements.map((element, index) => {
      const lane = Math.max(0, groups.indexOf(element.type ?? "default"));
      const laneY = 96 + lane * (nodeH + gap + 42);
      return { ...element, x: 64 + (index % Math.max(1, Math.floor((canvasWidth - 128) / (nodeW + gap)))) * (nodeW + gap), y: laneY, width: nodeW, height: nodeH };
    });
  }
  if (useVertical) {
    return elements.map((element, index) => ({ ...element, x: Math.round(canvasWidth / 2 - nodeW / 2), y: 72 + index * (nodeH + gap), width: nodeW, height: nodeH }));
  }
  if (input.layoutType === "card_dashboard" || input.layoutType === "grid") {
    const cols = Math.max(1, Math.floor((canvasWidth - gap) / (nodeW + gap)));
    return elements.map((element, index) => ({ ...element, x: gap + index % cols * (nodeW + gap), y: 72 + Math.floor(index / cols) * (nodeH + gap), width: nodeW, height: nodeH }));
  }
  return elements.map((element, index) => ({ ...element, x: gap + index * (nodeW + gap), y: Math.round(canvasHeight / 2 - nodeH / 2), width: nodeW, height: nodeH }));
}

function rectanglesOverlap(a: z.infer<typeof svgElementSchema>, b: z.infer<typeof svgElementSchema>, gap: number) {
  const ax = a.x ?? 0;
  const ay = a.y ?? 0;
  const aw = a.width ?? 0;
  const ah = a.height ?? 0;
  const bx = b.x ?? 0;
  const by = b.y ?? 0;
  const bw = b.width ?? 0;
  const bh = b.height ?? 0;
  return ax - gap < bx + bw && ax + aw + gap > bx && ay - gap < by + bh && ay + ah + gap > by;
}

function layoutWarnings(positioned: Array<z.infer<typeof svgElementSchema>>, input: z.infer<typeof layoutSvgElementsInputSchema>) {
  const warnings: string[] = [];
  const gap = input.constraints.minNodeGap ?? input.spacing;
  for (let i = 0; i < positioned.length; i += 1) {
    for (let j = i + 1; j < positioned.length; j += 1) {
      if (rectanglesOverlap(positioned[i], positioned[j], input.constraints.avoidOverlap ? Math.min(8, gap / 4) : 0)) warnings.push(`Potential overlap between ${positioned[i].id} and ${positioned[j].id}.`);
    }
  }
  for (const element of positioned) {
    const label = element.label ?? element.id;
    if (label.length > Math.max(12, Math.floor((element.width ?? 180) / 9))) warnings.push(`${element.id}: label may not fit.`);
  }
  if (positioned.length > 24 && (input.canvas?.width ?? input.width) < 1200) warnings.push("Dense layout: consider responsive/mobile simplified layout.");
  return warnings;
}

function routeConnectors(edges: Array<{ from: string; to: string; label?: string }>, positioned: Array<z.infer<typeof svgElementSchema>>, direction: string) {
  return edges.map((edge) => {
    const from = positioned.find((element) => element.id === edge.from);
    const to = positioned.find((element) => element.id === edge.to);
    if (!from || !to) return { ...edge, missingEndpoint: true, points: [] as number[][], route: "missing" };
    const fromPoint = direction === "top_to_bottom"
      ? [(from.x ?? 0) + (from.width ?? 0) / 2, (from.y ?? 0) + (from.height ?? 0)]
      : [(from.x ?? 0) + (from.width ?? 0), (from.y ?? 0) + (from.height ?? 0) / 2];
    const toPoint = direction === "top_to_bottom"
      ? [(to.x ?? 0) + (to.width ?? 0) / 2, to.y ?? 0]
      : [to.x ?? 0, (to.y ?? 0) + (to.height ?? 0) / 2];
    const mid = direction === "top_to_bottom" ? [fromPoint[0], (fromPoint[1] + toPoint[1]) / 2] : [(fromPoint[0] + toPoint[0]) / 2, fromPoint[1]];
    const mid2 = direction === "top_to_bottom" ? [toPoint[0], (fromPoint[1] + toPoint[1]) / 2] : [(fromPoint[0] + toPoint[0]) / 2, toPoint[1]];
    return { ...edge, route: "orthogonal", points: [fromPoint, mid, mid2, toPoint].map((point) => point.map((value) => Math.round(value))) };
  });
}

function renderLayoutSvg(title: string, positioned: Array<z.infer<typeof svgElementSchema>>, routes: Array<{ from: string; to: string; points: number[][]; route: string }>, viewBox: string) {
  const [, , widthText, heightText] = viewBox.split(/\s+/);
  const width = Number(widthText);
  const height = Number(heightText);
  const routeSvg = routes.map((route) => route.points.length ? `<polyline points="${route.points.map((point) => point.join(",")).join(" ")}" fill="none" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>` : "").join("\n");
  const nodes = positioned.map((element) => renderCard({ ...element, fill: "#ffffff", stroke: "#d1d5db" }, { palette: ["#0f172a", "#2563eb", "#14b8a6"], background: "#ffffff", text: "#111827", strokeWidth: 2, radius: 8, fontFamily: "Inter, Arial, sans-serif" })).join("\n");
  return svgRoot(title, width, height, `<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#2563eb"/></marker></defs><rect width="100%" height="100%" fill="#f8fafc"/><text x="32" y="42" font-size="22" font-weight="800" fill="#111827">${xml(title)}</text>${routeSvg}${nodes}`, "Auto-laid out SVG diagram");
}

function renderCard(element: z.infer<typeof svgElementSchema>, theme: z.infer<typeof svgThemeSchema>) {
  const x = element.x ?? 0;
  const y = element.y ?? 0;
  const width = element.width ?? 160;
  const height = element.height ?? 64;
  const fill = element.fill ?? theme.background;
  const stroke = element.stroke ?? theme.palette[1] ?? "#2563eb";
  const label = element.label ?? element.id;
  return `<g id="${xml(element.id)}"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${theme.radius}" fill="${xml(fill)}" stroke="${xml(stroke)}" stroke-width="${theme.strokeWidth}"/><text x="${x + 16}" y="${y + 28}" font-family="${xml(theme.fontFamily)}" font-size="15" font-weight="700" fill="${xml(theme.text)}">${xml(label)}</text></g>`;
}

function diagramId(value: string) {
  return value.trim().replace(/^\W+|\W+$/g, "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "node";
}

function parseMermaidLikeDiagram(spec: string) {
  const nodes = new Map<string, z.infer<typeof diagramNodeSchema>>();
  const edges: Array<z.infer<typeof diagramEdgeSchema>> = [];
  const groups: Array<{ id: string; label?: string; color?: string }> = [];
  const swimlanes: Array<{ id: string; label?: string }> = [];
  let currentGroup: string | undefined;
  let currentLane: string | undefined;
  const lines = spec.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("%%") && !/^(flowchart|graph|sequenceDiagram)\b/i.test(line));
  for (const line of lines) {
    const subgraph = /^subgraph\s+(.+)$/i.exec(line);
    if (subgraph) {
      currentGroup = diagramId(subgraph[1]);
      groups.push({ id: currentGroup, label: subgraph[1].replace(/^\[|\]$/g, "") });
      continue;
    }
    if (/^end$/i.test(line)) {
      currentGroup = undefined;
      currentLane = undefined;
      continue;
    }
    const lane = /^lane\s+(.+)$/i.exec(line);
    if (lane) {
      currentLane = diagramId(lane[1]);
      swimlanes.push({ id: currentLane, label: lane[1] });
      continue;
    }
    const edgeMatch = /^(.+?)\s*(-{1,2}>|={1,2}>|-->|->)\s*(.+?)(?:\s*:\s*(.+))?$/.exec(line);
    if (edgeMatch) {
      const fromRaw = edgeMatch[1].trim();
      const toRaw = edgeMatch[3].trim();
      const from = diagramId(fromRaw.replace(/\[.*\]|\(.*\)|\{.*\}/g, ""));
      const to = diagramId(toRaw.replace(/\[.*\]|\(.*\)|\{.*\}/g, ""));
      const fromLabel = /\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\}/.exec(fromRaw)?.slice(1).find(Boolean) ?? fromRaw;
      const toLabel = /\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\}/.exec(toRaw)?.slice(1).find(Boolean) ?? toRaw;
      if (!nodes.has(from)) nodes.set(from, { id: from, label: fromLabel, group: currentGroup, lane: currentLane });
      if (!nodes.has(to)) nodes.set(to, { id: to, label: toLabel, group: currentGroup, lane: currentLane });
      edges.push({ from, to, label: edgeMatch[4], kind: edgeMatch[2].includes("=") ? "data" : "control" });
      continue;
    }
    const nodeMatch = /^([a-zA-Z0-9_-]+)\s*(?:\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\})?$/.exec(line);
    if (nodeMatch) {
      const id = diagramId(nodeMatch[1]);
      nodes.set(id, { id, label: nodeMatch[2] ?? nodeMatch[3] ?? nodeMatch[4] ?? nodeMatch[1], group: currentGroup, lane: currentLane });
    }
  }
  return { nodes: Array.from(nodes.values()), edges, groups, swimlanes };
}

function promptDiagramSeed(prompt: string, diagramType: string) {
  const base = diagramType === "deployment" ? ["User", "CDN", "Web App", "API", "Database"] : diagramType === "db_relation" ? ["Customer", "Order", "Order Item", "Product", "Payment"] : diagramType === "api_flow" ? ["Client", "API Gateway", "Auth", "Service", "Database"] : diagramType === "business_process" ? ["Request", "Review", "Approval", "Fulfillment", "Report"] : ["Start", "Process", "Decision", "Action", "Done"];
  const words = Array.from(new Set(prompt.match(/[A-Z][A-Za-z0-9_-]{2,}|[a-z][a-z0-9_-]{4,}/g) ?? [])).slice(0, 5);
  const labels = words.length >= 3 ? words : base;
  const nodes = labels.map((label, index) => ({ id: diagramId(label), label, group: index < 2 ? "input" : index < labels.length - 1 ? "processing" : "output" }));
  const edges = nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: nodes[index + 1].id, label: index === 0 ? "request" : undefined, kind: "control" as const }));
  return { nodes, edges, groups: [{ id: "input", label: "Input" }, { id: "processing", label: "Processing" }, { id: "output", label: "Output" }] };
}

function normalizeDiagramInput(input: z.infer<typeof generateSvgDiagramInputSchema>) {
  const parsedMermaid = input.mermaidSpec ? parseMermaidLikeDiagram(input.mermaidSpec) : undefined;
  const promptSeed = !parsedMermaid && !input.nodes?.length && !input.jsonSpec?.nodes?.length && input.prompt ? promptDiagramSeed(input.prompt, input.diagramType) : undefined;
  const nodes = input.jsonSpec?.nodes?.length ? input.jsonSpec.nodes : input.nodes?.length ? input.nodes : parsedMermaid?.nodes.length ? parsedMermaid.nodes : promptSeed?.nodes ?? [];
  const edges = input.jsonSpec?.edges?.length ? input.jsonSpec.edges : input.edges.length ? input.edges : parsedMermaid?.edges.length ? parsedMermaid.edges : promptSeed?.edges ?? [];
  const groups = input.jsonSpec?.groups?.length ? input.jsonSpec.groups : input.groups.length ? input.groups : parsedMermaid?.groups.length ? parsedMermaid.groups : promptSeed?.groups ?? [];
  const swimlanes = input.jsonSpec?.swimlanes?.length ? input.jsonSpec.swimlanes : input.swimlanes.length ? input.swimlanes : parsedMermaid?.swimlanes ?? [];
  const legend = input.jsonSpec?.legend?.length ? input.jsonSpec.legend : input.legend;
  const callouts = input.jsonSpec?.callouts?.length ? input.jsonSpec.callouts : input.callouts;
  return { nodes, edges, groups, swimlanes, legend, callouts, inputSource: input.jsonSpec ? "json" : input.mermaidSpec ? "mermaid_like_spec" : input.prompt ? "prompt" : "nodes_edges" };
}

function layoutDiagramNodes(nodes: Array<z.infer<typeof diagramNodeSchema>>, width: number, height: number, direction: "left_to_right" | "top_to_bottom", swimlanes: Array<{ id: string; label?: string }>) {
  const lanes = swimlanes.length ? swimlanes : Array.from(new Set(nodes.map((node) => node.lane).filter(Boolean))).map((id) => ({ id: String(id), label: String(id) }));
  const laneIds = lanes.map((lane) => lane.id);
  const marginX = 64;
  const marginY = 96;
  const nodeW = 180;
  const nodeH = 72;
  const availableW = Math.max(240, width - marginX * 2);
  const availableH = Math.max(180, height - marginY * 2 - (lanes.length ? 60 : 0));
  return nodes.map((node, index) => {
    const laneIndex = node.lane && laneIds.includes(node.lane) ? laneIds.indexOf(node.lane) : laneIds.length ? index % laneIds.length : 0;
    const laneCount = Math.max(1, lanes.length || 1);
    if (direction === "top_to_bottom") {
      const x = marginX + laneIndex * Math.max(nodeW + 32, availableW / laneCount);
      const y = marginY + Math.floor(index / laneCount) * 120;
      return { ...node, x: Math.round(x), y: Math.round(y), width: nodeW, height: nodeH };
    }
    const row = laneIndex;
    const col = Math.floor(index / laneCount);
    const x = marginX + col * Math.max(nodeW + 48, Math.min(260, availableW / Math.max(1, Math.ceil(nodes.length / laneCount))));
    const y = marginY + row * Math.max(nodeH + 52, availableH / laneCount);
    return { ...node, x: Math.round(x), y: Math.round(y), width: nodeW, height: nodeH };
  });
}

function renderDiagramSvg(input: z.infer<typeof generateSvgDiagramInputSchema>, normalized: ReturnType<typeof normalizeDiagramInput>, positioned: Array<z.infer<typeof diagramNodeSchema> & { x: number; y: number; width: number; height: number }>, routes: ReturnType<typeof routeConnectors>) {
  const width = input.canvas?.width ?? 1200;
  const height = input.canvas?.height ?? 720;
  const groupColors = new Map(normalized.groups.map((group, index) => [group.id, ("color" in group ? group.color : undefined) ?? input.theme.palette[(index + 1) % input.theme.palette.length] ?? "#dbeafe"]));
  const lanes = normalized.swimlanes.length ? normalized.swimlanes : Array.from(new Set(positioned.map((node) => node.lane).filter(Boolean))).map((id) => ({ id: String(id), label: String(id) }));
  const laneSvg = lanes.map((lane, index) => {
    const laneNodes = positioned.filter((node) => node.lane === lane.id || (!node.lane && index === 0));
    if (!laneNodes.length) return "";
    const y = Math.min(...laneNodes.map((node) => node.y)) - 28;
    const h = Math.max(...laneNodes.map((node) => node.y + node.height)) - y + 28;
    return `<g id="lane-${xml(lane.id)}"><rect x="40" y="${y}" width="${width - 80}" height="${h}" rx="12" fill="${index % 2 ? "#f1f5f9" : "#f8fafc"}" stroke="#e2e8f0"/><text x="56" y="${y + 24}" font-size="13" font-weight="800" fill="#475569">${xml(lane.label ?? lane.id)}</text></g>`;
  }).join("\n");
  const routeSvg = routes.map((route) => route.points.length ? `<polyline points="${route.points.map((point) => point.join(",")).join(" ")}" fill="none" stroke="${input.theme.palette[1] ?? "#2563eb"}" stroke-width="2" marker-end="url(#diagram-arrow)"/><text x="${route.points[Math.max(0, Math.floor(route.points.length / 2) - 1)]?.[0] ?? 0}" y="${(route.points[Math.max(0, Math.floor(route.points.length / 2) - 1)]?.[1] ?? 0) - 6}" font-size="11" fill="${xml(input.theme.text)}">${xml(route.label ?? "")}</text>` : "").join("\n");
  const nodeSvg = positioned.map((node) => {
    const fill = node.group ? `${groupColors.get(node.group) ?? "#ffffff"}22` : "#ffffff";
    const stroke = node.group ? groupColors.get(node.group) ?? input.theme.palette[1] ?? "#2563eb" : input.theme.palette[1] ?? "#2563eb";
    const icon = node.icon ? `<text x="${node.x + 16}" y="${node.y + 25}" font-size="16">${xml(node.icon)}</text>` : "";
    const labelX = node.icon ? node.x + 42 : node.x + 16;
    return `<g id="${xml(node.id)}" data-group="${xml(node.group ?? "")}"><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${input.theme.radius}" fill="${fill}" stroke="${stroke}" stroke-width="${input.theme.strokeWidth}"/>${icon}<text x="${labelX}" y="${node.y + 30}" font-family="${xml(input.theme.fontFamily)}" font-size="15" font-weight="800" fill="${xml(input.theme.text)}">${xml(node.label)}</text><text x="${labelX}" y="${node.y + 52}" font-size="11" fill="#64748b">${xml(node.kind ?? node.group ?? input.diagramType)}</text></g>`;
  }).join("\n");
  const legendSvg = normalized.legend.length ? `<g id="diagram-legend">${normalized.legend.map((item, index) => `<rect x="${width - 240}" y="${96 + index * 26}" width="14" height="14" rx="3" fill="${xml(item.color ?? input.theme.palette[index % input.theme.palette.length] ?? "#2563eb")}"/><text x="${width - 220}" y="${108 + index * 26}" font-size="12" fill="${xml(input.theme.text)}">${xml(item.label)}</text>`).join("")}</g>` : "";
  const calloutSvg = normalized.callouts.map((callout, index) => {
    const node = callout.nodeId ? positioned.find((item) => item.id === callout.nodeId) : undefined;
    const x = Math.round(callout.x ?? (node ? node.x + node.width - 16 : width - 280));
    const y = Math.round(callout.y ?? (node ? node.y - 34 : 160 + index * 64));
    return `<g id="callout-${index}"><rect x="${x}" y="${y}" width="220" height="42" rx="8" fill="#fff7ed" stroke="#f59e0b"/><text x="${x + 12}" y="${y + 26}" font-size="12" fill="#9a3412">${xml(callout.text)}</text></g>`;
  }).join("\n");
  const defs = `<defs><marker id="diagram-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${xml(input.theme.palette[1] ?? "#2563eb")}"/></marker></defs>`;
  const body = `${defs}<rect width="100%" height="100%" fill="${xml(input.theme.background)}"/><text x="40" y="52" font-size="26" font-weight="900" fill="${xml(input.theme.text)}">${xml(input.title)}</text><text x="40" y="76" font-size="13" fill="#64748b">${xml(input.diagramType.replaceAll("_", " "))} - ${normalized.inputSource}</text>${laneSvg}${routeSvg}${nodeSvg}${legendSvg}${calloutSvg}`;
  return svgRoot(input.title, width, height, body, `${input.diagramType} diagram with ${positioned.length} nodes and ${routes.length} routed connector(s).`);
}

function parseCsvRows(csv: string) {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const split = (line: string) => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((cell) => cell.trim().replace(/^"|"$/g, "").replaceAll("\"\"", "\""));
  const headers = split(lines[0]);
  return lines.slice(1).map((line) => Object.fromEntries(split(line).map((cell, index) => {
    const numeric = Number(cell);
    return [headers[index] ?? `field_${index + 1}`, cell !== "" && Number.isFinite(numeric) ? numeric : cell];
  })));
}

function normalizeChartData(input: z.infer<typeof generateSvgChartInputSchema>) {
  if (input.csvString) return { rows: parseCsvRows(input.csvString), inputSource: "csv" };
  if (input.jsonData) {
    const rows = typeof input.jsonData === "string" ? JSON.parse(input.jsonData) : input.jsonData;
    return { rows: Array.isArray(rows) ? rows : [], inputSource: "json" };
  }
  if (input.tableData) {
    return {
      rows: input.tableData.rows.map((row) => Object.fromEntries(input.tableData!.columns.map((column, index) => [column, row[index] ?? ""]))),
      inputSource: "table_data"
    };
  }
  return { rows: input.data ?? [], inputSource: "array" };
}

function numericValue(row: Record<string, string | number | boolean>, field: string) {
  const value = Number(row[field] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function polar(cx: number, cy: number, radius: number, angle: number) {
  return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius].map((value) => Number(value.toFixed(2)));
}

function arcPath(cx: number, cy: number, innerRadius: number, outerRadius: number, start: number, end: number) {
  const [sx, sy] = polar(cx, cy, outerRadius, start);
  const [ex, ey] = polar(cx, cy, outerRadius, end);
  const [isx, isy] = polar(cx, cy, innerRadius, end);
  const [iex, iey] = polar(cx, cy, innerRadius, start);
  const large = end - start > Math.PI ? 1 : 0;
  if (innerRadius <= 0) return `M${cx},${cy} L${sx},${sy} A${outerRadius},${outerRadius} 0 ${large} 1 ${ex},${ey} Z`;
  return `M${sx},${sy} A${outerRadius},${outerRadius} 0 ${large} 1 ${ex},${ey} L${isx},${isy} A${innerRadius},${innerRadius} 0 ${large} 0 ${iex},${iey} Z`;
}

function detectChartIssues(input: z.infer<typeof generateSvgChartInputSchema>, rows: Array<Record<string, string | number | boolean>>, values: number[]) {
  const warnings: Array<{ severity: "high" | "medium" | "low"; category: string; message: string; suggestedFix: string }> = [];
  const labels = rows.map((row, index) => String(row[input.xField] ?? index + 1));
  if (labels.some((label) => label.length > 18)) warnings.push({ severity: "medium", category: "label_readability", message: "Some axis labels are long and may be hard to read.", suggestedFix: "Shorten labels, rotate labels, or use annotations." });
  if (rows.length > 24 && ["bar", "stacked_bar", "pie", "donut"].includes(input.chartType)) warnings.push({ severity: "medium", category: "overcrowding", message: `${input.chartType} chart has many categories.`, suggestedFix: "Use a line/heatmap/table or group small categories." });
  if (Math.min(...values) < 0 && ["pie", "donut", "gauge", "treemap", "radar"].includes(input.chartType)) warnings.push({ severity: "high", category: "bad_chart_choice", message: `${input.chartType} charts cannot faithfully show negative values.`, suggestedFix: "Use bar, line, or waterfall instead." });
  if (Math.max(...values) > 0 && Math.min(...values.filter((value) => value > 0)) / Math.max(...values) < 0.03 && ["bar", "stacked_bar"].includes(input.chartType)) warnings.push({ severity: "low", category: "misleading_axes", message: "Large value spread may hide small categories.", suggestedFix: "Consider log scale, split panels, or annotate small values." });
  if (input.theme.palette.length < Math.min(3, rows.length)) warnings.push({ severity: "low", category: "low_contrast", message: "Palette has few distinct colors for the number of series/categories.", suggestedFix: "Provide more theme palette colors." });
  return warnings;
}

function renderSvgChart(input: z.infer<typeof generateSvgChartInputSchema>, rows: Array<Record<string, string | number | boolean>>) {
  const width = input.canvas?.width ?? 960;
  const height = input.canvas?.height ?? 540;
  const plot = { x: 64, y: 92, width: width - 128, height: height - 170 };
  const labels = rows.map((row, index) => String(row[input.xField] ?? index + 1));
  const seriesFields = input.seriesFields.length ? input.seriesFields : [input.yField];
  const values = rows.map((row) => numericValue(row, input.yField));
  const allValues = rows.flatMap((row) => seriesFields.map((field) => numericValue(row, field)));
  const max = Math.max(1, ...allValues);
  const min = Math.min(0, ...allValues);
  const range = Math.max(1, max - min);
  const color = (index: number) => input.theme.palette[index % input.theme.palette.length] ?? "#2563eb";
  const xFor = (index: number) => plot.x + (rows.length <= 1 ? plot.width / 2 : index * (plot.width / Math.max(1, rows.length - 1)));
  const yFor = (value: number) => plot.y + plot.height - ((value - min) / range) * plot.height;
  let marks = "";
  if (input.chartType === "line" || input.chartType === "area") {
    for (const [seriesIndex, field] of seriesFields.entries()) {
      const points = rows.map((row, index) => `${xFor(index)},${yFor(numericValue(row, field)).toFixed(1)}`).join(" ");
      if (input.chartType === "area") marks += `<polygon points="${plot.x},${plot.y + plot.height} ${points} ${plot.x + plot.width},${plot.y + plot.height}" fill="${color(seriesIndex)}" opacity=".18"/>`;
      marks += `<polyline points="${points}" fill="none" stroke="${color(seriesIndex)}" stroke-width="3"/>`;
    }
  } else if (input.chartType === "pie" || input.chartType === "donut") {
    let angle = -Math.PI / 2;
    const total = Math.max(1, values.reduce((sum, value) => sum + Math.max(0, value), 0));
    marks = values.map((value, index) => {
      const slice = Math.max(0, value) / total * Math.PI * 2;
      const path = arcPath(width / 2, height / 2 + 16, input.chartType === "donut" ? 78 : 0, 132, angle, angle + slice);
      angle += slice;
      return `<path d="${path}" fill="${color(index)}"><title>${xml(labels[index])}: ${value}</title></path>`;
    }).join("");
  } else if (input.chartType === "gauge") {
    const value = values[0] ?? 0;
    const pct = Math.max(0, Math.min(1, value / max));
    const end = -Math.PI + pct * Math.PI;
    marks = `<path d="${arcPath(width / 2, height / 2 + 80, 96, 128, -Math.PI, 0)}" fill="#e5e7eb"/><path d="${arcPath(width / 2, height / 2 + 80, 96, 128, -Math.PI, end)}" fill="${color(1)}"/><text x="${width / 2}" y="${height / 2 + 82}" text-anchor="middle" font-size="34" font-weight="900" fill="${xml(input.theme.text)}">${xml(String(value))}</text>`;
  } else if (input.chartType === "heatmap") {
    const cellW = Math.max(18, plot.width / rows.length);
    marks = rows.map((row, index) => {
      const value = numericValue(row, input.yField);
      const opacity = 0.2 + Math.max(0, value - min) / range * 0.75;
      return `<rect x="${plot.x + index * cellW}" y="${plot.y + 40}" width="${cellW - 3}" height="160" fill="${color(1)}" opacity="${opacity.toFixed(2)}"/><text x="${plot.x + index * cellW + cellW / 2}" y="${plot.y + 224}" text-anchor="middle" font-size="11" fill="${xml(input.theme.text)}">${xml(labels[index])}</text>`;
    }).join("");
  } else if (input.chartType === "radar") {
    const cx = width / 2;
    const cy = height / 2 + 20;
    const radius = 150;
    const points = values.map((value, index) => {
      const angle = -Math.PI / 2 + index / values.length * Math.PI * 2;
      const [x, y] = polar(cx, cy, radius * Math.max(0, value) / max, angle);
      return `${x},${y}`;
    }).join(" ");
    marks = `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#e5e7eb"/><polygon points="${points}" fill="${color(1)}" opacity=".25" stroke="${color(1)}" stroke-width="3"/>`;
  } else if (input.chartType === "treemap") {
    const total = Math.max(1, values.reduce((sum, value) => sum + Math.max(0, value), 0));
    let cursor = plot.x;
    marks = values.map((value, index) => {
      const w = Math.max(12, plot.width * Math.max(0, value) / total);
      const rect = `<rect x="${cursor}" y="${plot.y}" width="${w}" height="${plot.height}" fill="${color(index)}" opacity=".86"/><text x="${cursor + 8}" y="${plot.y + 24}" font-size="12" fill="#fff">${xml(labels[index])}</text>`;
      cursor += w;
      return rect;
    }).join("");
  } else if (input.chartType === "sankey") {
    marks = rows.map((row, index) => {
      const x1 = plot.x;
      const y1 = plot.y + 40 + index * 42;
      const x2 = plot.x + plot.width - 180;
      const value = numericValue(row, input.yField);
      const strokeWidth = Math.max(4, Math.min(30, value / max * 30));
      return `<rect x="${x1}" y="${y1 - 16}" width="140" height="32" rx="8" fill="#fff" stroke="${color(index)}"/><text x="${x1 + 10}" y="${y1 + 4}" font-size="12" fill="${xml(input.theme.text)}">${xml(labels[index])}</text><path d="M${x1 + 140},${y1} C${x1 + 320},${y1} ${x2 - 120},${height / 2} ${x2},${height / 2}" fill="none" stroke="${color(index)}" stroke-width="${strokeWidth}" opacity=".55"/>`;
    }).join("");
  } else if (input.chartType === "waterfall") {
    let cumulative = 0;
    const barW = Math.max(18, plot.width / rows.length - 12);
    marks = rows.map((row, index) => {
      const value = numericValue(row, input.yField);
      const start = cumulative;
      cumulative += value;
      const y = yFor(Math.max(start, cumulative));
      const h = Math.max(2, Math.abs(yFor(start) - yFor(cumulative)));
      const x = plot.x + index * (barW + 12);
      return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${value >= 0 ? "#16a34a" : "#dc2626"}"/><text x="${x + barW / 2}" y="${plot.y + plot.height + 22}" text-anchor="middle" font-size="11" fill="${xml(input.theme.text)}">${xml(labels[index])}</text>`;
    }).join("");
  } else {
    const grouped = input.chartType === "stacked_bar";
    const barGap = 12;
    const barW = Math.max(14, plot.width / rows.length - barGap);
    marks = rows.map((row, index) => {
      const x = plot.x + index * (barW + barGap);
      if (grouped) {
        let cursorY = plot.y + plot.height;
        const total = seriesFields.reduce((sum, field) => sum + Math.max(0, numericValue(row, field)), 0) || 1;
        const stack = seriesFields.map((field, seriesIndex) => {
          const h = Math.max(1, Math.max(0, numericValue(row, field)) / total * plot.height);
          cursorY -= h;
          return `<rect x="${x}" y="${cursorY}" width="${barW}" height="${h}" fill="${color(seriesIndex)}"><title>${xml(field)}: ${numericValue(row, field)}</title></rect>`;
        }).join("");
        return `${stack}<text x="${x + barW / 2}" y="${plot.y + plot.height + 22}" text-anchor="middle" font-size="11" fill="${xml(input.theme.text)}">${xml(labels[index])}</text>`;
      }
      const value = numericValue(row, input.yField);
      const h = Math.round(Math.max(0, value) / max * plot.height);
      return `<rect x="${x}" y="${plot.y + plot.height - h}" width="${barW}" height="${h}" rx="6" fill="${color(index)}"/><text x="${x + barW / 2}" y="${plot.y + plot.height + 22}" text-anchor="middle" font-size="11" fill="${xml(input.theme.text)}">${xml(labels[index])}</text>`;
    }).join("");
  }
  const axis = ["pie", "donut", "gauge", "radar", "treemap", "sankey"].includes(input.chartType) ? "" : `<line x1="${plot.x}" y1="${plot.y + plot.height}" x2="${plot.x + plot.width}" y2="${plot.y + plot.height}" stroke="#d1d5db"/><line x1="${plot.x}" y1="${plot.y}" x2="${plot.x}" y2="${plot.y + plot.height}" stroke="#d1d5db"/><text x="${plot.x - 10}" y="${plot.y + 10}" text-anchor="end" font-size="11" fill="#64748b">${max}</text>`;
  const legend = input.includeLegend && seriesFields.length > 1 ? `<g id="chart-legend">${seriesFields.map((field, index) => `<rect x="${width - 220}" y="${92 + index * 24}" width="12" height="12" fill="${color(index)}"/><text x="${width - 202}" y="${103 + index * 24}" font-size="12" fill="${xml(input.theme.text)}">${xml(field)}</text>`).join("")}</g>` : "";
  const annotations = input.annotations.map((annotation, index) => `<g id="chart-annotation-${index}"><text x="${plot.x + 12}" y="${plot.y + 24 + index * 20}" font-size="12" fill="#9a3412">${xml(annotation.label)}${annotation.note ? ` - ${xml(annotation.note)}` : ""}</text></g>`).join("");
  const body = `<rect width="100%" height="100%" fill="${xml(input.theme.background)}"/><text x="48" y="48" font-size="24" font-weight="800" fill="${xml(input.theme.text)}">${xml(input.title)}</text><text x="48" y="70" font-size="12" fill="#64748b">${xml(input.chartType.replaceAll("_", " "))} • ${rows.length} row(s)</text>${axis}${marks}${legend}${annotations}`;
  return { svg: svgRoot(input.title, width, height, body, `${input.chartType} chart with ${rows.length} rows.`), yMax: max, yMin: min, plot, labels, seriesFields };
}

type IsoPrimitive = { type: string; label: string; x: number; y: number; z: number; scale: number; layer: string };

function scenePrimitiveDefaults(scene: string, objects: string[], prompt?: string) {
  const lowered = `${scene} ${prompt ?? ""}`.toLowerCase();
  const base = lowered.includes("server") || lowered.includes("pipeline")
    ? ["platform", "server", "screen", "pipeline", "arrow", "label"]
    : lowered.includes("office") || lowered.includes("customer")
      ? ["platform", "desk", "screen", "people", "box", "label"]
      : lowered.includes("delivery") || lowered.includes("logistics")
        ? ["platform", "vehicle", "box", "warehouse_shelf", "arrow", "label"]
        : ["platform", "warehouse_shelf", "box", "screen", "people", "arrow", "label"];
  const source = objects.length ? objects : base;
  return source.map((item, index) => {
    const lower = item.toLowerCase();
    const type = lower.includes("person") || lower.includes("people") ? "people" : lower.includes("desk") ? "desk" : lower.includes("shelf") || lower.includes("rack") ? "warehouse_shelf" : lower.includes("server") ? "server" : lower.includes("screen") || lower.includes("dashboard") ? "screen" : lower.includes("vehicle") || lower.includes("truck") || lower.includes("delivery") ? "vehicle" : lower.includes("arrow") || lower.includes("flow") || lower.includes("pipeline") ? "arrow" : lower.includes("label") ? "label" : lower.includes("platform") ? "platform" : lower.includes("box") || lower.includes("pallet") ? "box" : base[index % base.length];
    return { type, label: item.replaceAll("_", " "), x: index % 4, y: Math.floor(index / 4), z: 0, scale: 1, layer: type === "platform" ? "base" : type === "arrow" || type === "label" ? "annotation" : "objects" };
  });
}

function normalizeIsometricPrimitives(input: z.infer<typeof generateIsometricSvgInputSchema>) {
  const raw = input.sceneJson?.primitives?.length
    ? input.sceneJson.primitives.map((primitive, index) => ({ type: primitive.type === "person" ? "people" : primitive.type, label: primitive.label ?? primitive.type.replaceAll("_", " "), x: primitive.x ?? index % 4, y: primitive.y ?? Math.floor(index / 4), z: primitive.z ?? 0, scale: primitive.scale ?? 1, layer: primitive.layer ?? (primitive.type === "label" || primitive.type === "arrow" ? "annotation" : "objects") }))
    : scenePrimitiveDefaults(input.scene, input.objects, input.prompt);
  return raw.map((primitive, index) => ({ ...primitive, id: `iso-${index + 1}-${diagramId(primitive.label)}` }));
}

function isoPoint(originX: number, originY: number, gridX: number, gridY: number, z = 0) {
  return { x: originX + (gridX - gridY) * 76, y: originY + (gridX + gridY) * 38 - z * 42 };
}

function isoDiamond(cx: number, cy: number, w: number, h: number) {
  return `${cx},${cy - h / 2} ${cx + w / 2},${cy} ${cx},${cy + h / 2} ${cx - w / 2},${cy}`;
}

function renderIsoBox(cx: number, cy: number, w: number, h: number, d: number, color: string) {
  return `<g><polygon points="${cx},${cy - d} ${cx + w / 2},${cy - d / 2} ${cx},${cy} ${cx - w / 2},${cy - d / 2}" fill="${color}" opacity=".95"/><polygon points="${cx - w / 2},${cy - d / 2} ${cx},${cy} ${cx},${cy + h} ${cx - w / 2},${cy + h - d / 2}" fill="${color}" opacity=".72"/><polygon points="${cx + w / 2},${cy - d / 2} ${cx},${cy} ${cx},${cy + h} ${cx + w / 2},${cy + h - d / 2}" fill="${color}" opacity=".58"/></g>`;
}

function renderIsoPrimitive(primitive: IsoPrimitive & { id: string }, index: number, theme: z.infer<typeof svgThemeSchema>, originX: number, originY: number) {
  const point = isoPoint(originX, originY, primitive.x, primitive.y, primitive.z);
  const scale = primitive.scale;
  const color = theme.palette[index % theme.palette.length] ?? "#2563eb";
  const label = `<text x="${point.x}" y="${point.y + 74 * scale}" text-anchor="middle" font-size="${Math.round(12 * scale)}" fill="${xml(theme.text)}">${xml(primitive.label)}</text>`;
  if (primitive.type === "platform") return `<g id="${xml(primitive.id)}" data-layer="${xml(primitive.layer)}"><polygon points="${isoDiamond(point.x, point.y + 48, 260 * scale, 130 * scale)}" fill="#e2e8f0" stroke="#cbd5e1"/><polygon points="${isoDiamond(point.x, point.y + 42, 236 * scale, 110 * scale)}" fill="#f8fafc" stroke="#d1d5db"/></g>`;
  if (primitive.type === "warehouse_shelf") return `<g id="${xml(primitive.id)}" data-layer="${xml(primitive.layer)}">${renderIsoBox(point.x, point.y, 116 * scale, 74 * scale, 52 * scale, color)}<path d="M${point.x - 48 * scale},${point.y + 18 * scale} L${point.x},${point.y + 44 * scale} L${point.x + 48 * scale},${point.y + 18 * scale}" fill="none" stroke="#fff" stroke-width="2"/>${label}</g>`;
  if (primitive.type === "server") return `<g id="${xml(primitive.id)}" data-layer="${xml(primitive.layer)}">${renderIsoBox(point.x, point.y, 82 * scale, 120 * scale, 44 * scale, color)}<circle cx="${point.x - 14 * scale}" cy="${point.y + 38 * scale}" r="${4 * scale}" fill="#22c55e"/><circle cx="${point.x + 8 * scale}" cy="${point.y + 50 * scale}" r="${4 * scale}" fill="#38bdf8"/>${label}</g>`;
  if (primitive.type === "screen" || primitive.type === "dashboard") return `<g id="${xml(primitive.id)}" data-layer="${xml(primitive.layer)}"><polygon points="${point.x - 58 * scale},${point.y - 34 * scale} ${point.x + 58 * scale},${point.y + 8 * scale} ${point.x + 58 * scale},${point.y + 74 * scale} ${point.x - 58 * scale},${point.y + 32 * scale}" fill="#0f172a"/><polyline points="${point.x - 36 * scale},${point.y + 16 * scale} ${point.x - 8 * scale},${point.y + 4 * scale} ${point.x + 28 * scale},${point.y + 24 * scale}" fill="none" stroke="#38bdf8" stroke-width="3"/>${label}</g>`;
  if (primitive.type === "desk") return `<g id="${xml(primitive.id)}" data-layer="${xml(primitive.layer)}"><polygon points="${isoDiamond(point.x, point.y + 10, 126 * scale, 62 * scale)}" fill="${color}" opacity=".85"/><line x1="${point.x - 42 * scale}" y1="${point.y + 40 * scale}" x2="${point.x - 42 * scale}" y2="${point.y + 82 * scale}" stroke="#64748b" stroke-width="4"/><line x1="${point.x + 42 * scale}" y1="${point.y + 40 * scale}" x2="${point.x + 42 * scale}" y2="${point.y + 82 * scale}" stroke="#64748b" stroke-width="4"/>${label}</g>`;
  if (primitive.type === "people") return `<g id="${xml(primitive.id)}" data-layer="${xml(primitive.layer)}"><circle cx="${point.x}" cy="${point.y - 16 * scale}" r="${14 * scale}" fill="${color}"/><path d="M${point.x - 20 * scale},${point.y + 28 * scale} Q${point.x},${point.y - 2 * scale} ${point.x + 20 * scale},${point.y + 28 * scale} Z" fill="${color}" opacity=".8"/>${label}</g>`;
  if (primitive.type === "vehicle") return `<g id="${xml(primitive.id)}" data-layer="${xml(primitive.layer)}">${renderIsoBox(point.x, point.y + 8 * scale, 120 * scale, 46 * scale, 42 * scale, color)}<circle cx="${point.x - 34 * scale}" cy="${point.y + 54 * scale}" r="${8 * scale}" fill="#111827"/><circle cx="${point.x + 36 * scale}" cy="${point.y + 54 * scale}" r="${8 * scale}" fill="#111827"/>${label}</g>`;
  if (primitive.type === "arrow" || primitive.type === "pipeline") return `<g id="${xml(primitive.id)}" data-layer="${xml(primitive.layer)}"><path d="M${point.x - 80 * scale},${point.y} C${point.x - 20 * scale},${point.y - 42 * scale} ${point.x + 40 * scale},${point.y + 42 * scale} ${point.x + 88 * scale},${point.y}" fill="none" stroke="${color}" stroke-width="${4 * scale}" marker-end="url(#iso-arrow)"/>${label}</g>`;
  if (primitive.type === "label") return `<g id="${xml(primitive.id)}" data-layer="${xml(primitive.layer)}"><rect x="${point.x - 82 * scale}" y="${point.y - 24 * scale}" width="${164 * scale}" height="${38 * scale}" rx="8" fill="#ffffff" stroke="${color}"/><text x="${point.x}" y="${point.y}" text-anchor="middle" font-size="${Math.round(13 * scale)}" fill="${xml(theme.text)}">${xml(primitive.label)}</text></g>`;
  return `<g id="${xml(primitive.id)}" data-layer="${xml(primitive.layer)}">${renderIsoBox(point.x, point.y, 74 * scale, 46 * scale, 38 * scale, color)}${label}</g>`;
}

function renderIsometricScene(input: z.infer<typeof generateIsometricSvgInputSchema>, primitives: ReturnType<typeof normalizeIsometricPrimitives>) {
  const width = input.canvas?.width ?? 960;
  const height = input.canvas?.height ?? 540;
  const originX = width / 2 - 110;
  const originY = 150;
  const layers = Array.from(new Set(primitives.map((primitive) => primitive.layer)));
  const defs = `<defs><marker id="iso-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${xml(input.theme.palette[1] ?? "#2563eb")}"/></marker><filter id="iso-shadow"><feDropShadow dx="0" dy="8" stdDeviation="6" flood-color="#0f172a" flood-opacity=".16"/></filter></defs>`;
  const base = `<rect width="100%" height="100%" fill="${xml(input.theme.background)}"/><text x="48" y="56" font-size="26" font-weight="900" fill="${xml(input.theme.text)}">${xml(input.title)}</text><text x="48" y="80" font-size="13" fill="#64748b">${xml(input.scene.replaceAll("_", " "))} - 2:1 isometric system</text>`;
  const objectSvg = layers.map((layer) => `<g id="layer-${xml(layer)}" filter="${layer === "objects" ? "url(#iso-shadow)" : ""}">${primitives.filter((primitive) => primitive.layer === layer).map((primitive, index) => renderIsoPrimitive(primitive, index, input.theme, originX, originY)).join("\n")}</g>`).join("\n");
  const labels = (input.sceneJson?.labels ?? []).map((label, index) => `<g id="scene-label-${index}"><rect x="${label.x}" y="${label.y - 22}" width="${Math.max(120, label.text.length * 8)}" height="32" rx="8" fill="#ffffff" stroke="#cbd5e1"/><text x="${label.x + 10}" y="${label.y}" font-size="12" fill="${xml(input.theme.text)}">${xml(label.text)}</text></g>`).join("\n");
  return { svg: svgRoot(input.title, width, height, `${defs}${base}${objectSvg}${labels}`, `${input.scene} isometric illustration with ${primitives.length} primitive(s).`), layers, viewBox: `0 0 ${width} ${height}` };
}

function defaultIconsForDomain(domain?: string, prompt?: string) {
  const domainMap: Record<string, Array<{ name: string; concept: string }>> = {
    inventory: [{ name: "inventory", concept: "stacked boxes" }, { name: "warehouse", concept: "warehouse shelf" }, { name: "barcode", concept: "barcode scan" }, { name: "stock-alert", concept: "low stock warning" }, { name: "transfer", concept: "stock movement" }],
    finance: [{ name: "invoice", concept: "document bill" }, { name: "payment", concept: "card payment" }, { name: "ledger", concept: "account ledger" }, { name: "budget", concept: "budget gauge" }, { name: "tax", concept: "tax receipt" }],
    sales: [{ name: "lead", concept: "sales lead" }, { name: "quote", concept: "quote document" }, { name: "order", concept: "order cart" }, { name: "customer", concept: "customer profile" }, { name: "pipeline", concept: "sales pipeline" }],
    delivery: [{ name: "truck", concept: "delivery truck" }, { name: "route", concept: "route path" }, { name: "package", concept: "package box" }, { name: "handoff", concept: "delivery handoff" }, { name: "tracking", concept: "tracking pin" }],
    security: [{ name: "shield", concept: "security shield" }, { name: "lock", concept: "lock" }, { name: "key", concept: "access key" }, { name: "audit", concept: "audit checklist" }, { name: "policy", concept: "policy document" }],
    reporting: [{ name: "chart", concept: "bar chart" }, { name: "dashboard", concept: "dashboard panel" }, { name: "kpi", concept: "KPI gauge" }, { name: "export", concept: "export arrow" }, { name: "trend", concept: "trend line" }],
    erp_modules: [{ name: "inventory", concept: "ERP inventory" }, { name: "finance", concept: "ERP finance" }, { name: "sales", concept: "ERP sales" }, { name: "delivery", concept: "ERP delivery" }, { name: "reporting", concept: "ERP reporting" }],
    ai_tools: [{ name: "assistant", concept: "AI assistant" }, { name: "prompt", concept: "prompt bubble" }, { name: "model", concept: "model chip" }, { name: "automation", concept: "automation loop" }, { name: "review", concept: "AI review" }]
  };
  if (domain && domainMap[domain]) return domainMap[domain];
  const promptWords = Array.from(new Set((prompt ?? "").match(/[a-z][a-z0-9-]{3,}/gi) ?? [])).slice(0, 6);
  return promptWords.length ? promptWords.map((word) => ({ name: diagramId(word).toLowerCase(), concept: word })) : [{ name: "settings", concept: "settings gear" }, { name: "workflow", concept: "workflow path" }, { name: "report", concept: "report document" }];
}

function normalizeIconSetInput(input: z.infer<typeof generateSvgIconSetInputSchema>) {
  const icons = input.icons?.length ? input.icons : defaultIconsForDomain(input.domain, input.prompt);
  const familyName = input.familyName ?? `${(input.domain ?? "product").replaceAll("_", " ")} Icons`;
  const strokeWidth = input.designTokens.strokeWidth ?? input.theme.strokeWidth;
  const radius = input.designTokens.radius ?? input.theme.radius;
  const palette = input.designTokens.palette ?? input.theme.palette;
  return { icons, familyName, tokens: { strokeWidth, radius, palette, opticalWeight: input.designTokens.opticalWeight ?? "regular" } };
}

function iconGlyphPath(name: string, concept: string, grid: number, pad: number) {
  const lower = `${name} ${concept}`.toLowerCase();
  const left = pad + grid * 0.18;
  const right = grid - pad - grid * 0.18;
  const top = pad + grid * 0.18;
  const bottom = grid - pad - grid * 0.18;
  const mid = grid / 2;
  if (/box|inventory|package|warehouse|stock/.test(lower)) return `<path d="M${mid} ${top} L${right} ${mid} L${mid} ${bottom} L${left} ${mid} Z M${left} ${mid} L${mid} ${mid + grid * 0.18} L${right} ${mid} M${mid} ${top} L${mid} ${mid + grid * 0.18}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (/invoice|document|report|quote|policy|ledger/.test(lower)) return `<path d="M${left} ${top} H${right - grid * 0.14} L${right} ${top + grid * 0.14} V${bottom} H${left} Z M${right - grid * 0.14} ${top} V${top + grid * 0.14} H${right} M${left + grid * 0.14} ${mid - grid * 0.08} H${right - grid * 0.14} M${left + grid * 0.14} ${mid + grid * 0.12} H${right - grid * 0.22}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (/truck|delivery|route|tracking|vehicle/.test(lower)) return `<path d="M${left} ${mid} H${mid + grid * 0.08} V${top + grid * 0.16} H${right - grid * 0.16} L${right} ${mid} V${bottom - grid * 0.12} H${left} Z M${left + grid * 0.14} ${bottom - grid * 0.12} A${grid * 0.08} ${grid * 0.08} 0 1 0 ${left + grid * 0.3} ${bottom - grid * 0.12} A${grid * 0.08} ${grid * 0.08} 0 1 0 ${left + grid * 0.14} ${bottom - grid * 0.12} M${right - grid * 0.28} ${bottom - grid * 0.12} A${grid * 0.08} ${grid * 0.08} 0 1 0 ${right - grid * 0.12} ${bottom - grid * 0.12} A${grid * 0.08} ${grid * 0.08} 0 1 0 ${right - grid * 0.28} ${bottom - grid * 0.12}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (/lock|security|shield|audit|key/.test(lower)) return `<path d="M${mid} ${top} L${right} ${top + grid * 0.12} V${mid} C${right} ${bottom - grid * 0.12} ${mid} ${bottom} ${mid} ${bottom} C${mid} ${bottom} ${left} ${bottom - grid * 0.12} ${left} ${mid} V${top + grid * 0.12} Z M${mid} ${mid - grid * 0.05} V${mid + grid * 0.16}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (/chart|kpi|trend|dashboard|budget/.test(lower)) return `<path d="M${left} ${bottom} V${top} M${left} ${bottom} H${right} M${left + grid * 0.16} ${bottom - grid * 0.14} L${mid - grid * 0.06} ${mid} L${mid + grid * 0.12} ${mid + grid * 0.08} L${right - grid * 0.1} ${top + grid * 0.18}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (/settings|gear/.test(lower)) return `<path d="M${mid} ${top} V${top + grid * 0.12} M${mid} ${bottom - grid * 0.12} V${bottom} M${left} ${mid} H${left + grid * 0.12} M${right - grid * 0.12} ${mid} H${right} M${mid - grid * 0.18} ${mid} A${grid * 0.18} ${grid * 0.18} 0 1 0 ${mid + grid * 0.18} ${mid} A${grid * 0.18} ${grid * 0.18} 0 1 0 ${mid - grid * 0.18} ${mid}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<path d="M${left} ${mid} L${mid - grid * 0.05} ${bottom - grid * 0.16} L${right} ${top + grid * 0.16}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function renderIconSvg(icon: { name: string; concept?: string; label?: string }, input: z.infer<typeof generateSvgIconSetInputSchema>, tokens: ReturnType<typeof normalizeIconSetInput>["tokens"]) {
  const grid = input.gridSize;
  const primary = tokens.palette[0] ?? "#0f172a";
  const accent = tokens.palette[1] ?? "#2563eb";
  const label = icon.label ?? icon.name;
  const glyph = iconGlyphPath(icon.name, icon.concept ?? icon.name, grid, input.padding);
  const strokeWidth = tokens.opticalWeight === "bold" ? tokens.strokeWidth * 1.3 : tokens.opticalWeight === "light" ? tokens.strokeWidth * 0.75 : tokens.strokeWidth;
  const fill = input.style === "filled" ? `fill="${accent}" opacity=".14"` : input.style === "duotone" ? `fill="${accent}" opacity=".12"` : `fill="none"`;
  const color = input.style === "dark_mode_safe" ? "#f8fafc" : input.style === "monochrome" ? primary : primary;
  const bg = input.style === "filled" || input.style === "duotone" ? `<rect x="${input.padding}" y="${input.padding}" width="${grid - input.padding * 2}" height="${grid - input.padding * 2}" rx="${Math.max(2, tokens.radius / 2)}" ${fill}/>` : "";
  return svgRoot(label, grid, grid, `<g id="icon-${xml(icon.name)}" color="${xml(color)}" stroke-width="${strokeWidth.toFixed(2)}">${bg}${glyph}</g>`, `${label} icon from ${input.familyName ?? input.domain ?? "SVG icon"} family`);
}

function iconSymbol(svg: string, id: string) {
  const body = svg.replace(/^[\s\S]*?<svg\b[^>]*>/i, "").replace(/<\/svg>\s*$/i, "").replace(/<title\b[\s\S]*?<\/title>\s*/i, "").replace(/<desc\b[\s\S]*?<\/desc>\s*/i, "");
  return `<symbol id="icon-${xml(id)}" viewBox="0 0 24 24">${body}</symbol>`;
}

function buildIconSetQa(icons: Array<{ name: string; path: string; svg: string }>, gridSize: number, strokeWidth: number) {
  const findings: Array<{ severity: "high" | "medium" | "low"; category: string; message: string; suggestedFix: string }> = [];
  const names = new Set<string>();
  for (const icon of icons) {
    if (names.has(icon.name)) findings.push({ severity: "high", category: "naming", message: `Duplicate icon name: ${icon.name}`, suggestedFix: "Rename duplicated icons before export." });
    names.add(icon.name);
    if (!icon.svg.includes(`viewBox="0 0 ${gridSize} ${gridSize}"`)) findings.push({ severity: "medium", category: "grid", message: `${icon.name} does not use the shared grid.`, suggestedFix: "Regenerate with shared gridSize." });
    if (!icon.svg.includes(`stroke-width="${strokeWidth.toFixed(2)}`) && !icon.svg.includes(`stroke-width="${strokeWidth}`)) findings.push({ severity: "low", category: "stroke_consistency", message: `${icon.name} may not use the exact shared stroke width.`, suggestedFix: "Normalize stroke width before delivery." });
  }
  const conceptShapes = icons.map((icon) => icon.svg.replace(/id="[^"]+"/g, "").replace(/<title[\s\S]*?<\/desc>/g, ""));
  if (new Set(conceptShapes).size < icons.length) findings.push({ severity: "medium", category: "duplicated_shapes", message: "Some icons share identical geometry.", suggestedFix: "Vary glyph metaphors for recognizability." });
  if (gridSize < 24) findings.push({ severity: "low", category: "small_size", message: "Grid below 24 may reduce recognizability.", suggestedFix: "Verify at 16px and 20px sizes." });
  return { findings, pass: !findings.some((finding) => finding.severity === "high"), checks: ["visual_weight", "alignment", "stroke_consistency", "duplicated_shapes", "small_size_recognizability"] };
}

function iconSetReadme(manifest: { familyName: string; style: string; gridSize: number; spritePath: string; icons: Array<{ name: string; path: string }> }) {
  return `# ${manifest.familyName}\n\nStyle: ${manifest.style}\nGrid: ${manifest.gridSize}px\nSprite: ${manifest.spritePath}\n\n## Icons\n${manifest.icons.map((icon) => `- ${icon.name}: ${icon.path}`).join("\n")}\n\nUse individual SVG files for direct embeds or the sprite symbols with <use href=\"#icon-name\">.\n`;
}

function svgExportStem(svgPath: string, index: number) {
  const filename = svgPath.split(/[\\/]/).pop() ?? `asset-${index + 1}.svg`;
  const stem = filename.replace(/\.svg$/i, "") || `asset-${index + 1}`;
  return stem.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || `asset-${index + 1}`;
}

function svgInnerMarkup(svg: string) {
  return svg.replace(/^[\s\S]*?<svg\b[^>]*>/i, "").replace(/<\/svg>\s*$/i, "").replace(/<title\b[\s\S]*?<\/title>\s*/i, "").replace(/<desc\b[\s\S]*?<\/desc>\s*/i, "");
}

function exportPackageReadme(manifest: {
  packageName: string;
  assets: Array<{ svgPath: string; optimizedSvgPath?: string; pdfReadySvgPath?: string }>;
  spritePath?: string;
  previewHtmlPath?: string;
  tokenPath?: string;
  licenseNotes: string[];
  intendedUsage: string[];
}) {
  return `# ${manifest.packageName}

Assets: ${manifest.assets.length}
Intended usage: ${manifest.intendedUsage.join(", ")}

## Files
${manifest.assets.map((asset) => `- ${asset.svgPath}${asset.optimizedSvgPath ? ` -> ${asset.optimizedSvgPath}` : ""}${asset.pdfReadySvgPath ? `, PDF-ready: ${asset.pdfReadySvgPath}` : ""}`).join("\n")}
${manifest.spritePath ? `\nSprite sheet: ${manifest.spritePath}` : ""}
${manifest.previewHtmlPath ? `\nPreview/demo HTML: ${manifest.previewHtmlPath}` : ""}
${manifest.tokenPath ? `\nDesign tokens: ${manifest.tokenPath}` : ""}

## Usage
- Use optimized SVG files for production embeds.
- Keep raw SVG paths as editable source references.
- Use the sprite sheet for icon systems or repeated admin/dashboard assets.
- PDF-ready SVG files preserve vector output and strip interaction-only concerns where practical.

## License Notes
${manifest.licenseNotes.length ? manifest.licenseNotes.map((note) => `- ${note}`).join("\n") : "- No third-party license notes were supplied; verify source rights before external distribution."}
`;
}

function exportPackagePreviewHtml(input: z.infer<typeof exportSvgProjectInputSchema>, assets: Array<{ svgPath: string; optimizedSvgPath?: string; dimensions: { width?: number; height?: number; viewBox?: string } }>) {
  const cards = assets.map((asset) => `<article><h2>${xml(asset.svgPath)}</h2><p>${asset.dimensions.width ?? "auto"} x ${asset.dimensions.height ?? "auto"} | viewBox: ${xml(asset.dimensions.viewBox ?? "missing")}</p><img src="../${xml(asset.optimizedSvgPath ?? asset.svgPath).replace(/^svg-design\//, "")}" alt="${xml(asset.svgPath)} preview"/></article>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${xml(input.packageName)}</title>
  <style>
    body{margin:0;font-family:Inter,Arial,sans-serif;background:#f8fafc;color:#0f172a}
    main{max-width:1120px;margin:0 auto;padding:32px}
    header{margin-bottom:24px}
    section{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
    article{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px}
    h1{font-size:28px;margin:0 0 8px} h2{font-size:14px;margin:0 0 8px} p{font-size:13px;color:#475569}
    img{width:100%;height:220px;object-fit:contain;background:#fff;border:1px solid #e5e7eb}
  </style>
</head>
<body><main><header><h1>${xml(input.packageName)}</h1><p>${assets.length} SVG asset(s), variants: ${xml(input.themeVariants.join(", "))}</p></header><section>${cards}</section></main></body>
</html>
`;
}

function animationKeyframes(type: string) {
  if (type === "path_draw" || type === "flow_line") return "@keyframes svgPathDraw{from{stroke-dashoffset:var(--svg-path-length,240)}to{stroke-dashoffset:0}}";
  if (type === "scale") return "@keyframes svgScaleIn{from{opacity:.35;transform:scale(.94)}to{opacity:1;transform:scale(1)}}";
  if (type === "rotate") return "@keyframes svgRotate{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}";
  if (type === "pulse" || type === "loading") return "@keyframes svgPulse{0%,100%{opacity:.55;transform:scale(.98)}50%{opacity:1;transform:scale(1.03)}}";
  if (type === "bounce") return "@keyframes svgBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}";
  if (type === "step_reveal") return "@keyframes svgStepReveal{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}";
  return "@keyframes svgFade{from{opacity:.2}to{opacity:1}}";
}

function animationName(type: string) {
  if (type === "path_draw" || type === "flow_line") return "svgPathDraw";
  if (type === "scale") return "svgScaleIn";
  if (type === "rotate") return "svgRotate";
  if (type === "pulse" || type === "loading") return "svgPulse";
  if (type === "bounce") return "svgBounce";
  if (type === "step_reveal") return "svgStepReveal";
  return "svgFade";
}

function buildSvgAnimationCss(input: z.infer<typeof animateAndInteractSvgInputSchema>) {
  const keyframes = Array.from(new Set(input.animations.map((animation) => animationKeyframes(animation.type))));
  const rules = input.animations.map((animation, index) => {
    const selector = animation.selector ?? `#svg-anim-${animation.id ?? index}`;
    const drawSetup = animation.type === "path_draw" || animation.type === "flow_line" ? "stroke-dasharray:var(--svg-path-length,240);stroke-dashoffset:var(--svg-path-length,240);" : "";
    return `${selector}{${drawSetup}animation:${animationName(animation.type)} ${animation.durationMs}ms ${animation.easing} ${animation.delayMs}ms both;transform-box:fill-box;transform-origin:center;}`;
  });
  const interactionRules = [
    ".svg-hotspot{cursor:pointer;outline:none;}",
    ".svg-hotspot:focus-visible rect,.svg-hotspot:hover rect{fill:rgba(37,99,235,.12);stroke:#2563eb;}",
    ".svg-tooltip{opacity:0;pointer-events:none;transition:opacity .16s ease;}",
    ".svg-hotspot:focus-visible .svg-tooltip,.svg-hotspot:hover .svg-tooltip{opacity:1;}",
    ".svg-step[data-step-hidden=\"true\"]{opacity:.18;}",
    ".svg-state[data-active=\"false\"]{display:none;}"
  ];
  const reduced = input.reducedMotion ? "@media (prefers-reduced-motion: reduce){*{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important}.svg-flow-line{stroke-dashoffset:0!important}}" : "";
  return `${keyframes.join("\n")}\n${rules.join("\n")}\n${interactionRules.join("\n")}\n${reduced}\n`;
}

function injectSvgAnimationAndInteractions(svg: string, input: z.infer<typeof animateAndInteractSvgInputSchema>, css: string) {
  const styleTag = `<style id="svg-animation-interaction-css">\n${css}\n</style>`;
  const hotspots = input.interactions.map((interaction, index) => {
    const x = interaction.x ?? 24 + index * 36;
    const y = interaction.y ?? 24 + index * 28;
    const width = interaction.width ?? 96;
    const height = interaction.height ?? 44;
    const tooltip = interaction.tooltip ?? interaction.label;
    return `<g id="${xml(interaction.id)}" class="svg-hotspot" role="button" tabindex="0" aria-label="${xml(interaction.label)}" data-interaction="${xml(interaction.type)}" data-target-state="${xml(interaction.targetState ?? "")}"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="transparent" stroke="transparent"/><g class="svg-tooltip"><rect x="${x}" y="${y - 34}" width="${Math.max(120, tooltip.length * 7)}" height="28" rx="6" fill="#0f172a"/><text x="${x + 8}" y="${y - 15}" font-size="12" fill="#ffffff">${xml(tooltip)}</text></g><title>${xml(interaction.label)}</title></g>`;
  }).join("\n");
  let output = svg.replace(/<svg\b([^>]*)>/i, `<svg$1>\n${styleTag}`);
  output = output.replace(/<(path|polyline|line)\b(?![^>]*\bclass=)([^>]*)>/i, `<$1$2 class="svg-flow-line">`);
  output = output.replace(/<\/svg>\s*$/i, `${hotspots}\n</svg>\n`);
  return output;
}

function svgInteractionQa(input: z.infer<typeof animateAndInteractSvgInputSchema>, svg: string) {
  const findings: Array<{ severity: "high" | "medium" | "low"; category: string; message: string; suggestedFix: string }> = [];
  const totalDuration = input.animations.reduce((max, animation) => Math.max(max, animation.durationMs + animation.delayMs), 0);
  if (totalDuration > 8000 || input.animations.length > 12) findings.push({ severity: "medium", category: "performance", message: "Animation set may be too long or dense for dashboard use.", suggestedFix: "Shorten durations or reduce animated elements." });
  if (input.reducedMotion && !/prefers-reduced-motion/.test(svg)) findings.push({ severity: "high", category: "reduced_motion", message: "Reduced-motion CSS missing.", suggestedFix: "Include prefers-reduced-motion fallback." });
  if (input.interactions.some((interaction) => (interaction.width ?? 96) < 44 || (interaction.height ?? 44) < 44)) findings.push({ severity: "medium", category: "touch_usability", message: "Some hotspots are smaller than 44px touch target guidance.", suggestedFix: "Increase hotspot width/height." });
  if (input.interactions.length && !/tabindex="0"/.test(svg)) findings.push({ severity: "high", category: "keyboard_focus", message: "Interactive hotspots are not keyboard focusable.", suggestedFix: "Add tabindex and focus-visible states." });
  if (input.interactions.some((interaction) => (interaction.tooltip ?? interaction.label).length > 80)) findings.push({ severity: "low", category: "tooltip_readability", message: "Some tooltips are long.", suggestedFix: "Shorten tooltip text or wrap it in a wider callout." });
  return { pass: !findings.some((finding) => finding.severity === "high"), findings, checks: ["performance", "reduced_motion", "mobile_touch_targets", "keyboard_focus", "tooltip_readability"] };
}

function svgRevisionIntents(feedback: string) {
  const lower = feedback.toLowerCase();
  return {
    crowded: /crowded|too much|dense|overlap|拥挤|太满/.test(lower),
    text: /text|font|small|readable|mobile|字|阅读/.test(lower),
    dark: /dark|night|深色|暗色/.test(lower),
    erp: /erp|admin|dashboard|enterprise|后台|管理/.test(lower),
    arrows: /arrow|connector|flow|line|unclear|箭头|连线/.test(lower),
    addNode: /add .*node|one more node|new node|新增|添加/.test(lower),
    reduceColors: /reduce colors|too many colors|simplify color|less color|减少颜色/.test(lower),
    align: /align|alignment|grid|对齐/.test(lower),
    icon: /icon|icons|图标/.test(lower),
    isometric: /isometric|3d|立体|等距/.test(lower),
    animation: /animation|motion|animate|动效|动画/.test(lower)
  };
}

function buildSvgRevisionActions(feedback: string) {
  const intents = svgRevisionIntents(feedback);
  const actions: Array<{ tool: string; action: string; target: string; patchSafe: boolean }> = [];
  if (intents.crowded || intents.align) actions.push({ tool: "layout_svg_elements", action: "increase spacing, align nodes to a clearer grid, and reduce visible density", target: "layout", patchSafe: false });
  if (intents.text) actions.push({ tool: "fit_svg_typography", action: "raise minimum font size, improve label wrapping, and check mobile readability", target: "typography", patchSafe: true });
  if (intents.dark || intents.erp || intents.reduceColors) actions.push({ tool: "apply_svg_design_tokens", action: intents.dark ? "apply dark ERP/admin design tokens with fewer colors" : "apply restrained ERP/admin tokens and reduce palette noise", target: "style", patchSafe: true });
  if (intents.arrows) actions.push({ tool: "optimize_svg_paths", action: "make connector strokes clearer and preserve marker/animation hooks", target: "paths", patchSafe: true });
  if (intents.icon) actions.push({ tool: "generate_svg_icon_set", action: "normalize icon grid, stroke width, radius, and small-size recognizability", target: "icons", patchSafe: false });
  if (intents.isometric) actions.push({ tool: "generate_isometric_svg", action: "convert the visual direction into an isometric scene specification", target: "style_conversion", patchSafe: false });
  if (intents.animation) actions.push({ tool: "animate_and_interact_svg", action: "preserve animation hooks and revise motion only with reduced-motion support", target: "animation", patchSafe: false });
  if (intents.addNode) actions.push({ tool: "generate_svg_diagram", action: "add the requested node through diagram data and rerender connectors", target: "structure", patchSafe: false });
  if (!actions.length) actions.push({ tool: "inspect_svg_visual_quality", action: "run visual QA and convert findings into targeted layout/style/typography revisions", target: "qa", patchSafe: false });
  return actions;
}

function applySafeSvgRevisionPatch(svg: string, feedback: string, designTokens: Record<string, unknown>) {
  const intents = svgRevisionIntents(feedback);
  const patches: string[] = [];
  let patched = svg;
  if (intents.text) {
    patched = patched.replace(/font-size=(["']?)(\d+(?:\.\d+)?)(["']?)/gi, (_match, open, size, close) => {
      const next = Math.max(Number(size), 15);
      return `font-size=${open}${trimNumber(next, 1)}${close}`;
    });
    patches.push("raised-minimum-font-size");
  }
  if (intents.arrows) {
    patched = patched.replace(/stroke-width=(["']?)(\d+(?:\.\d+)?)(["']?)/gi, (_match, open, width, close) => {
      const next = Math.max(Number(width), 2.5);
      return `stroke-width=${open}${trimNumber(next, 1)}${close}`;
    });
    if (!/marker-end=/.test(patched)) patched = patched.replace(/<path\b(?![^>]*marker-end=)([^>]*fill=["']none["'][^>]*)>/i, `<path$1 marker-end="url(#arrow)">`);
    patches.push("clarified-connector-strokes");
  }
  if (intents.dark || intents.erp || intents.reduceColors || Object.keys(designTokens).length) {
    const background = typeof designTokens.background === "string" ? designTokens.background : intents.dark ? "#0f172a" : "#ffffff";
    const text = typeof designTokens.text === "string" ? designTokens.text : intents.dark ? "#f8fafc" : "#0f172a";
    const primary = typeof designTokens.primary === "string" ? designTokens.primary : "#2563eb";
    const revisionStyle = `<style id="svg-revision-tokens">:root{--svg-bg:${xml(background)};--svg-text:${xml(text)};--svg-primary:${xml(primary)}} text{fill:var(--svg-text)} .revision-emphasis{stroke:var(--svg-primary)}</style>`;
    patched = /<style id="svg-revision-tokens">/.test(patched) ? patched : patched.replace(/<svg\b([^>]*)>/i, `<svg$1>\n${revisionStyle}`);
    if (intents.dark) patched = patched.replace(/<rect\b([^>]*width=["']100%["'][^>]*)fill=(["'])#[^"']+\2/i, `<rect$1fill="${background}"`);
    patches.push("applied-revision-design-tokens");
  }
  if (intents.crowded || intents.align) {
    patched = patched.replace(/<svg\b([^>]*)>/i, `<svg$1 data-revision-layout="spacing-review-required">`);
    patches.push("marked-layout-spacing-review");
  }
  if (!/<metadata\b/i.test(patched)) {
    patched = patched.replace(/<svg\b([^>]*)>/i, `<svg$1>\n<metadata id="svg-revision-metadata">${xml(JSON.stringify({ feedback, patches }))}</metadata>`);
  }
  return { patchedSvg: patched, patches };
}

function svgRevisionQa(originalSvg: string | undefined, patchedSvg: string | undefined, actions: Array<{ patchSafe: boolean }>, designTokens: Record<string, unknown>) {
  const findings: Array<{ severity: "high" | "medium" | "low"; category: string; message: string; suggestedFix: string }> = [];
  const original = originalSvg ? svgMetrics(originalSvg) : undefined;
  const patched = patchedSvg ? svgMetrics(patchedSvg) : undefined;
  if (patchedSvg && !/<title\b/i.test(patchedSvg)) findings.push({ severity: "medium", category: "accessibility", message: "Patched SVG lacks a title.", suggestedFix: "Preserve or add a concise title." });
  if (patchedSvg && !/<desc\b/i.test(patchedSvg)) findings.push({ severity: "low", category: "accessibility", message: "Patched SVG lacks a description.", suggestedFix: "Add a description for complex visuals." });
  if (originalSvg && patchedSvg) {
    const originalIds = new Set(Array.from(originalSvg.matchAll(/\bid=(["'])([^"']+)\1/g)).map((match) => match[2]));
    const patchedIds = new Set(Array.from(patchedSvg.matchAll(/\bid=(["'])([^"']+)\1/g)).map((match) => match[2]));
    const missingIds = Array.from(originalIds).filter((id) => !patchedIds.has(id));
    if (missingIds.length) findings.push({ severity: "high", category: "id_preservation", message: `Patched SVG lost ${missingIds.length} id(s).`, suggestedFix: "Preserve IDs so CSS, animation, and interaction hooks keep working." });
    const originalHooks = (originalSvg.match(/svg-animation|data-interaction|tabindex=|aria-label=/g) ?? []).length;
    const patchedHooks = (patchedSvg.match(/svg-animation|data-interaction|tabindex=|aria-label=/g) ?? []).length;
    if (patchedHooks < originalHooks) findings.push({ severity: "high", category: "hook_preservation", message: "Patched SVG lost animation or interaction hooks.", suggestedFix: "Keep data attributes, tabindex, aria labels, and animation CSS hooks." });
  }
  if (patched && patched.textSizes.length && Math.min(...patched.textSizes) < 12) findings.push({ severity: "medium", category: "mobile_readability", message: "Some text remains below 12px.", suggestedFix: "Increase small labels or create a mobile variant." });
  if (!actions.some((action) => action.patchSafe) && patchedSvg) findings.push({ severity: "low", category: "manual_review", message: "Feedback primarily requires rerendering from structured data.", suggestedFix: "Use the planned follow-up tools for geometry-level changes." });
  return {
    pass: !findings.some((finding) => finding.severity === "high"),
    findings,
    checks: ["accessibility_metadata", "id_preservation", "animation_hook_preservation", "design_token_preservation", "mobile_readability", "safe_patch_scope"],
    before: original,
    after: patched,
    designTokenKeys: Object.keys(designTokens)
  };
}

function svgRevisionPreviewHtml(feedback: string, beforeSvg: string, afterSvg: string) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>SVG Revision Preview</title><style>body{margin:0;font-family:Inter,Arial,sans-serif;background:#f8fafc;color:#0f172a}main{max-width:1200px;margin:0 auto;padding:24px}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}article{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px}svg{max-width:100%;height:auto;border:1px solid #e5e7eb;background:#fff}p{color:#475569}</style></head>
<body><main><h1>SVG Revision Preview</h1><p>${xml(feedback)}</p><section><article><h2>Before</h2>${beforeSvg}</article><article><h2>After</h2>${afterSvg}</article></section></main></body>
</html>
`;
}

function normalizeSceneElements(elements: Array<z.infer<typeof sceneElementInputSchema>>, sceneType: string): Array<z.infer<typeof svgElementSchema>> {
  const fallback = sceneType.includes("warehouse")
    ? ["dashboard_screen", "warehouse_boxes", "workflow_arrows", "module_cards", "status_badges"]
    : ["dashboard_screen", "module_cards", "workflow_arrows"];
  const source = elements.length ? elements : fallback;
  return source.map((element, index) => {
    if (typeof element !== "string") return element;
    const id = element.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `component_${index + 1}`;
    return { id, label: element.replaceAll("_", " "), type: element.includes("arrow") || element.includes("connector") ? "connector" : element.includes("badge") ? "label" : "card" };
  });
}

function validateSvgText(svg: string, viewBox: string) {
  const warnings = [];
  if (!/<svg\b/i.test(svg)) warnings.push("Missing <svg> root.");
  if (!svg.includes(`viewBox="${viewBox}"`)) warnings.push("viewBox does not match manifest.");
  const tags = ["svg", "defs", "symbol", "clipPath", "mask", "pattern", "filter", "linearGradient"];
  for (const tag of tags) {
    const opens = (svg.match(new RegExp(`<${tag}\\b`, "gi")) ?? []).length;
    const closes = (svg.match(new RegExp(`</${tag}>`, "gi")) ?? []).length;
    if (opens && closes !== opens) warnings.push(`${tag} tag count mismatch.`);
  }
  if (!/<title\b/i.test(svg) || !/<desc\b/i.test(svg)) warnings.push("Missing title or desc for accessibility.");
  return { validXmlLikely: warnings.length === 0, warnings };
}

function renderScene(input: z.infer<typeof generateSvgSceneInputSchema>) {
  const width = input.canvas?.width ?? input.width;
  const height = input.canvas?.height ?? input.height;
  const prompt = input.prompt ?? `${input.style} ${input.sceneType} SVG scene`;
  const normalizedElements = normalizeSceneElements(input.elements, input.sceneType);
  const elements = layoutElements(normalizedElements, width, 36, "flow");
  const styleBackground = input.style === "dark_mode" ? "#111827" : input.theme.background;
  const textColor = input.style === "dark_mode" ? "#f8fafc" : input.theme.text;
  const body = [
    `<defs><linearGradient id="hero" x1="0" x2="1"><stop offset="0" stop-color="${xml(input.theme.palette[1] ?? "#2563eb")}"/><stop offset="1" stop-color="${xml(input.theme.palette[2] ?? "#14b8a6")}"/></linearGradient><radialGradient id="glow"><stop offset="0" stop-color="${xml(input.theme.palette[2] ?? "#14b8a6")}" stop-opacity=".28"/><stop offset="1" stop-color="${xml(input.theme.palette[2] ?? "#14b8a6")}" stop-opacity="0"/></radialGradient><pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M 24 0 H 0 V 24" fill="none" stroke="#e5e7eb" stroke-width="1"/></pattern><clipPath id="canvasClip"><rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="18"/></clipPath><mask id="softMask"><rect width="100%" height="100%" fill="white"/><circle cx="${width - 120}" cy="96" r="72" fill="black" opacity=".16"/></mask><filter id="shadow"><feDropShadow dx="0" dy="8" stdDeviation="8" flood-opacity="0.14"/></filter><symbol id="moduleNode" viewBox="0 0 180 72"><rect width="180" height="72" rx="${input.theme.radius}" fill="#fff" stroke="#d1d5db"/><circle cx="24" cy="24" r="8" fill="url(#hero)"/></symbol></defs>`,
    `<g id="background-layer" clip-path="url(#canvasClip)"><rect width="100%" height="100%" fill="${xml(styleBackground)}"/><rect width="100%" height="100%" fill="url(#grid)" opacity=".45"/><circle cx="${width - 130}" cy="96" r="110" fill="url(#glow)"/></g>`,
    `<rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="18" fill="none" stroke="#e5e7eb" mask="url(#softMask)"/>`,
    `<text x="48" y="66" font-family="${xml(input.theme.fontFamily)}" font-size="26" font-weight="800" fill="${xml(textColor)}">${xml(input.title)}</text>`,
    `<g id="component-layer" filter="url(#shadow)">${elements.map((element, index) => `<use href="#moduleNode" x="${element.x}" y="${element.y}"/>${renderCard({ ...element, fill: index === 0 ? "url(#hero)" : "#ffffff", stroke: "#d1d5db" }, input.theme)}`).join("\n")}</g>`
  ].join("\n");
  const viewBox = `0 0 ${width} ${height}`;
  const svg = svgRoot(input.title, width, height, body, prompt);
  const validation = validateSvgText(svg, viewBox);
  const componentList = elements.map((element) => ({ id: element.id, type: element.type, label: element.label ?? element.id, layer: element.type === "connector" ? "connectors" : "content" }));
  return { svg, elements, viewBox, validation, componentList, prompt, width, height };
}

function svgMetrics(svg: string) {
  const viewBox = /viewBox=["']([^"']+)["']/i.exec(svg)?.[1];
  const textSizes = [...svg.matchAll(/font-size=["']?([\d.]+)/gi)].map((match) => Number(match[1]));
  const rectCount = (svg.match(/<rect\b/gi) ?? []).length;
  const pathCount = (svg.match(/<path\b/gi) ?? []).length;
  const title = /<title\b[^>]*>(.*?)<\/title>/is.exec(svg)?.[1];
  const desc = /<desc\b[^>]*>(.*?)<\/desc>/is.exec(svg)?.[1];
  const strokeWidths = [...svg.matchAll(/stroke-width=["']?([\d.]+)/gi)].map((match) => Number(match[1]));
  const radii = [...svg.matchAll(/\brx=["']?([\d.]+)/gi)].map((match) => Number(match[1]));
  const defsCount = (svg.match(/<defs\b/gi) ?? []).length;
  return { viewBox, textSizes, rectCount, pathCount, title, desc, bytes: Buffer.byteLength(svg), strokeWidths, radii, defsCount };
}

async function readSvg(ctx: ToolContext, projectId: string, svgPath: string) {
  return readProjectFile(ctx.projectRoot, projectId, svgPath, 4 * 1024 * 1024);
}

function trimNumber(value: number, precision: number) {
  return Number(value.toFixed(precision)).toString();
}

function roundSvgNumbers(value: string, precision: number) {
  return value.replace(/-?\d*\.\d+|-?\d+\.\d*/g, (match) => trimNumber(Number(match), precision));
}

function optimizePathData(svg: string, precision: number) {
  let changed = 0;
  const optimized = svg.replace(/\sd=(["'])([\s\S]*?)\1/gi, (_match, quote: string, pathData: string) => {
    changed += 1;
    const next = roundSvgNumbers(pathData, precision)
      .replace(/\s*,\s*/g, ",")
      .replace(/\s+/g, " ")
      .replace(/\s*([MmZzLlHhVvCcSsQqTtAa])\s*/g, "$1")
      .replace(/,?([MmZzLlHhVvCcSsQqTtAa])/g, "$1")
      .trim();
    return ` d=${quote}${next}${quote}`;
  });
  return { svg: optimized, changed };
}

function usedSvgIds(svg: string) {
  const used = new Set<string>();
  for (const match of svg.matchAll(/url\(#([^)]+)\)|href=["']#([^"']+)["']|xlink:href=["']#([^"']+)["']|aria-labelledby=["']([^"']+)["']|aria-describedby=["']([^"']+)["']/gi)) {
    for (const group of match.slice(1)) {
      if (!group) continue;
      for (const id of group.split(/\s+/)) if (id) used.add(id);
    }
  }
  return used;
}

function shouldPreserveSvgId(id: string, preserveIds: string[]) {
  const lower = id.toLowerCase();
  return preserveIds.some((rule) => {
    const normalized = rule.toLowerCase();
    if (normalized === id.toLowerCase()) return true;
    if (normalized === "aria" && /title|desc|aria|label|a11y/.test(lower)) return true;
    if (normalized === "animation" && /anim|motion|keyframe|pathdraw|flow/.test(lower)) return true;
    if (normalized === "interactive" && /hotspot|interactive|button|link|target|step/.test(lower)) return true;
    return false;
  });
}

function cleanSvgDefs(svg: string, preserveIds: string[], removeUnused: boolean) {
  const used = usedSvgIds(svg);
  const changedElements: string[] = [];
  const riskWarnings: string[] = [];
  const preservedIds = new Set<string>();
  const referenceReplacements: Array<{ from: string; to: string }> = [];
  let optimized = svg.replace(/<defs\b[^>]*>([\s\S]*?)<\/defs>/gi, (defsMatch, body: string) => {
    const seenBodies = new Map<string, string>();
    let nextBody = body.replace(/<([a-z][\w:-]*)\b([^>]*)\bid=(["'])([^"']+)\3([^>]*)>([\s\S]*?)<\/\1>/gi, (match: string, tag: string, attrsBefore: string, quote: string, id: string, attrsAfter: string, inner: string) => {
      const preserve = shouldPreserveSvgId(id, preserveIds);
      if (preserve) preservedIds.add(id);
      if (removeUnused && !used.has(id) && !preserve) {
        changedElements.push(`removed-unused-def:${id}`);
        return "";
      }
      const comparable = `${tag}${attrsBefore.replace(/\bid=(["'])[^"']+\1/i, "")}${attrsAfter}${inner}`.replace(/\s+/g, " ").trim();
      const duplicateOf = seenBodies.get(comparable);
      if (duplicateOf && !preserve) {
        referenceReplacements.push({ from: id, to: duplicateOf });
        changedElements.push(`deduplicated-def:${id}->${duplicateOf}`);
        return "";
      }
      seenBodies.set(comparable, id);
      return match;
    });
    nextBody = nextBody.replace(/\s+/g, " ").trim();
    if (!nextBody) {
      changedElements.push("removed-empty-defs");
      return "";
    }
    return defsMatch.replace(body, nextBody);
  });
  for (const replacement of referenceReplacements) optimized = optimized.replaceAll(`#${replacement.from}`, `#${replacement.to}`);
  for (const id of used) if (shouldPreserveSvgId(id, preserveIds)) preservedIds.add(id);
  if (/<defs\b/i.test(svg) && !/<defs\b/i.test(optimized)) riskWarnings.push("Removed an empty or unused <defs> block; compare visuals if the SVG uses external CSS references.");
  return { svg: optimized, changedElements, riskWarnings, preservedIds: Array.from(preservedIds) };
}

function normalizeSvgStroke(svg: string) {
  let changed = 0;
  const optimized = svg
    .replace(/\sstroke-linecap=(["'])(butt|square)\1/gi, () => {
      changed += 1;
      return " stroke-linecap=\"round\"";
    })
    .replace(/\sstroke-linejoin=(["'])(miter|bevel)\1/gi, () => {
      changed += 1;
      return " stroke-linejoin=\"round\"";
    })
    .replace(/\sstroke-miterlimit=(["'])(\d+(?:\.\d+)?)\1/gi, (_match, _quote, value) => {
      const numeric = Number(value);
      if (numeric <= 4) return ` stroke-miterlimit="${trimNumber(numeric, 2)}"`;
      changed += 1;
      return " stroke-miterlimit=\"4\"";
    });
  return { svg: optimized, changed };
}

function optimizeSvgMarkup(svg: string, options: z.infer<typeof optimizeSvgPathsInputSchema>) {
  const beforeSize = Buffer.byteLength(svg);
  const changedElements: string[] = [];
  const riskWarnings: string[] = [];
  let optimized = svg;
  const preserveTitle = options.preserveAccessibility ? /<title\b[\s\S]*?<\/title>/i.exec(optimized)?.[0] : undefined;
  const preserveDesc = options.preserveAccessibility ? /<desc\b[\s\S]*?<\/desc>/i.exec(optimized)?.[0] : undefined;
  const commentCount = optimized.match(/<!--[\s\S]*?-->/g)?.length ?? 0;
  if (commentCount) changedElements.push(`removed-comments:${commentCount}`);
  optimized = optimized.replace(/<!--[\s\S]*?-->/g, "");
  if (options.removeMetadata && /<metadata\b/i.test(optimized)) {
    changedElements.push("removed-metadata");
    optimized = optimized.replace(/<metadata[\s\S]*?<\/metadata>/gi, "");
  }
  if (options.removeHiddenElements) {
    const beforeHidden = optimized;
    optimized = optimized
      .replace(/<([a-z][\w:-]*)\b(?=[^>]*(?:display\s*:\s*none|display=(["'])none\2|visibility\s*:\s*hidden|visibility=(["'])hidden\3))[^>]*(?:\/>|>[\s\S]*?<\/\1>)/gi, "")
      .replace(/<([a-z][\w:-]*)\b(?=[^>]*\bopacity=(["'])0(?:\.0+)?\2)[^>]*(?:\/>|>[\s\S]*?<\/\1>)/gi, "");
    if (beforeHidden !== optimized) changedElements.push("removed-hidden-elements");
  }
  optimized = optimized.replace(/<g\b[^>]*>\s*<\/g>/gi, () => {
    changedElements.push("removed-empty-group");
    return "";
  });
  if (options.removeUnusedDefs) {
    const cleaned = cleanSvgDefs(optimized, options.preserveIds, true);
    optimized = cleaned.svg;
    changedElements.push(...cleaned.changedElements);
    riskWarnings.push(...cleaned.riskWarnings);
  }
  const pathResult = optimizePathData(optimized, options.precision);
  optimized = pathResult.svg;
  if (pathResult.changed) changedElements.push(`optimized-path-data:${pathResult.changed}`);
  if (options.mode !== "conservative") {
    const beforeNumeric = optimized;
    optimized = optimized.replace(/\s(x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|width|height|stroke-width|font-size)=(["'])(-?\d*\.\d+|-?\d+\.\d*)\2/gi, (_match, attr, quote, value) => ` ${attr}=${quote}${trimNumber(Number(value), options.precision)}${quote}`);
    if (beforeNumeric !== optimized) changedElements.push("reduced-numeric-attribute-precision");
  }
  if (options.normalizeStroke) {
    const stroke = normalizeSvgStroke(optimized);
    optimized = stroke.svg;
    if (stroke.changed) changedElements.push(`normalized-stroke-style:${stroke.changed}`);
  }
  if (options.mode === "aggressive") {
    optimized = optimized.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").trim();
    changedElements.push("aggressive-whitespace-collapse");
    riskWarnings.push("Aggressive mode may change formatting-sensitive inline text or externally styled SVGs; visually compare the result.");
  } else {
    optimized = optimized.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").trim();
    changedElements.push("Collapsed whitespace");
  }
  if (options.preserveAccessibility) {
    if (preserveTitle && !/<title\b/i.test(optimized)) optimized = optimized.replace(/<svg\b([^>]*)>/i, `<svg$1>${preserveTitle}`);
    if (preserveDesc && !/<desc\b/i.test(optimized)) optimized = optimized.replace(/<title\b[\s\S]*?<\/title>/i, (title) => `${title}${preserveDesc}`);
  }
  for (const match of optimized.matchAll(/<path\b(?=[^>]*\bfill=(["'])(?!none)[^"']+\1)(?![^>]*\bd=["'][^"']*[zZ]\s*["'])[^>]*\bd=(["'])([^"']+)\2[^>]*>/gi)) {
    riskWarnings.push(`Filled path may be open and was not auto-closed: ${match[0].slice(0, 120)}`);
  }
  if (options.mode === "conservative") riskWarnings.push("Conservative mode avoids geometric path simplification; remaining path complexity may be intentional.");
  return {
    optimized,
    changedElements: Array.from(new Set(changedElements)),
    riskWarnings: Array.from(new Set(riskWarnings)),
    preservedIds: cleanSvgDefs(optimized, options.preserveIds, false).preservedIds,
    beforeSize,
    afterSize: Buffer.byteLength(optimized)
  };
}

function parseViewBox(viewBox?: string) {
  if (!viewBox) return undefined;
  const values = viewBox.trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return undefined;
  const [x, y, width, height] = values;
  return { x, y, width, height };
}

function parseNumericAttrs(tag: string) {
  const attrs: Record<string, number> = {};
  for (const attr of ["x", "y", "width", "height", "cx", "cy", "r", "font-size", "rx"]) {
    const match = new RegExp(`${attr}=["']?(-?[\\d.]+)`, "i").exec(tag);
    if (match) attrs[attr] = Number(match[1]);
  }
  return attrs;
}

function collectSvgBoxes(svg: string) {
  const boxes: Array<{ kind: string; x: number; y: number; width: number; height: number }> = [];
  for (const match of svg.matchAll(/<(rect|image|foreignObject)\b[^>]*>/gi)) {
    const attrs = parseNumericAttrs(match[0]);
    if (Number.isFinite(attrs.x) && Number.isFinite(attrs.y) && Number.isFinite(attrs.width) && Number.isFinite(attrs.height)) {
      boxes.push({ kind: match[1].toLowerCase(), x: attrs.x, y: attrs.y, width: attrs.width, height: attrs.height });
    }
  }
  for (const match of svg.matchAll(/<circle\b[^>]*>/gi)) {
    const attrs = parseNumericAttrs(match[0]);
    if (Number.isFinite(attrs.cx) && Number.isFinite(attrs.cy) && Number.isFinite(attrs.r)) boxes.push({ kind: "circle", x: attrs.cx - attrs.r, y: attrs.cy - attrs.r, width: attrs.r * 2, height: attrs.r * 2 });
  }
  for (const match of svg.matchAll(/<text\b[^>]*>(.*?)<\/text>/gis)) {
    const attrs = parseNumericAttrs(match[0]);
    const text = match[1].replace(/<[^>]+>/g, "").trim();
    const fontSize = attrs["font-size"] || 14;
    if (Number.isFinite(attrs.x) && Number.isFinite(attrs.y)) {
      boxes.push({ kind: "text", x: attrs.x, y: attrs.y - fontSize, width: Math.max(8, Array.from(text).length * fontSize * 0.62), height: fontSize * 1.25 });
    }
  }
  return boxes;
}

function contrastRatio(hexA: string, hexB: string) {
  const toRgb = (hex: string) => {
    const clean = hex.replace("#", "");
    if (!/^[\da-f]{6}$/i.test(clean)) return undefined;
    return [0, 2, 4].map((index) => parseInt(clean.slice(index, index + 2), 16) / 255).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  };
  const a = toRgb(hexA);
  const b = toRgb(hexB);
  if (!a || !b) return undefined;
  const lumA = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  const lumB = 0.2126 * b[0] + 0.7152 * b[1] + 0.0722 * b[2];
  const light = Math.max(lumA, lumB);
  const dark = Math.min(lumA, lumB);
  return Number(((light + 0.05) / (dark + 0.05)).toFixed(2));
}

function svgVisualQa(svg: string, input: z.infer<typeof inspectSvgVisualQualityInputSchema>) {
  const metrics = svgMetrics(svg);
  const viewBox = parseViewBox(metrics.viewBox);
  const boxes = collectSvgBoxes(svg);
  const findings: Array<{ severity: "high" | "medium" | "low"; category: string; message: string; suggestedFix: string }> = [];
  if (!metrics.viewBox || !viewBox || viewBox.width <= 0 || viewBox.height <= 0) findings.push({ severity: "high", category: "viewBox", message: "SVG is missing or has an invalid viewBox.", suggestedFix: "Add a valid viewBox matching the intended canvas." });
  if (viewBox) {
    const clipped = boxes.filter((box) => box.kind !== "circle" && (box.x < viewBox.x || box.y < viewBox.y || box.x + box.width > viewBox.x + viewBox.width || box.y + box.height > viewBox.y + viewBox.height));
    if (clipped.length) findings.push({ severity: "high", category: "clipping", message: `${clipped.length} element(s) may be outside the canvas.`, suggestedFix: "Adjust viewBox, resize elements, or move clipped elements inside the canvas." });
  }
  const textTooSmall = metrics.textSizes.filter((size) => size < input.minTextSize);
  if (textTooSmall.length) findings.push({ severity: "medium", category: "typography", message: `${textTooSmall.length} text node(s) are below the readable minimum.`, suggestedFix: "Run fit_svg_typography or increase font-size tokens." });
  const strokeSpread = metrics.strokeWidths.length ? Math.max(...metrics.strokeWidths) - Math.min(...metrics.strokeWidths) : 0;
  if (strokeSpread > 3) findings.push({ severity: "medium", category: "style", message: "Stroke widths are inconsistent.", suggestedFix: "Apply SVG design tokens and normalize stroke-width values." });
  const radiusSpread = metrics.radii.length ? Math.max(...metrics.radii) - Math.min(...metrics.radii) : 0;
  if (radiusSpread > 18) findings.push({ severity: "low", category: "style", message: "Corner radii vary widely across components.", suggestedFix: "Normalize component corner radius with apply_svg_design_tokens." });
  if (input.checkAccessibility && (!metrics.title || !metrics.desc)) findings.push({ severity: "medium", category: "accessibility", message: "Meaningful SVG is missing title or desc.", suggestedFix: "Add descriptive <title> and <desc> elements." });
  if (metrics.bytes > 500_000 || metrics.defsCount > 3) findings.push({ severity: "medium", category: "size", message: "SVG may be bloated for inline or mobile use.", suggestedFix: "Run optimize_svg_paths and remove unused or repeated defs." });

  const rects = boxes.filter((box) => box.kind === "rect");
  const xValues = rects.map((box) => Math.round(box.x));
  const yValues = rects.map((box) => Math.round(box.y));
  const alignmentReport = {
    checkedElements: rects.length,
    uniqueX: new Set(xValues).size,
    uniqueY: new Set(yValues).size,
    likelyAligned: rects.length < 4 || new Set(xValues).size <= Math.ceil(rects.length * 0.75) || new Set(yValues).size <= Math.ceil(rects.length * 0.75)
  };
  if (!alignmentReport.likelyAligned && rects.length >= 6) findings.push({ severity: "low", category: "alignment", message: "Component positions do not share many x/y alignment anchors.", suggestedFix: "Run layout_svg_elements to snap cards and labels to a consistent grid." });

  const fillColors = [...svg.matchAll(/\bfill=["'](#[\da-f]{6})["']/gi)].map((match) => match[1]);
  const textColors = [...svg.matchAll(/<text\b[^>]*\bfill=["'](#[\da-f]{6})["'][^>]*>/gi)].map((match) => match[1]);
  const background = input.designTokens?.background ?? fillColors[0] ?? "#ffffff";
  const contrastPairs = textColors.map((color) => ({ foreground: color, background, ratio: contrastRatio(color, background) })).filter((pair) => pair.ratio !== undefined);
  const lowContrast = contrastPairs.filter((pair) => (pair.ratio ?? 0) < 4.5);
  if (lowContrast.length) findings.push({ severity: "medium", category: "contrast", message: `${lowContrast.length} text color pair(s) may fail contrast guidance.`, suggestedFix: "Improve contrast by darkening text or lightening the background token." });
  const contrastReport = { checkedPairs: contrastPairs.length, lowContrastPairs: lowContrast, minimumRatio: contrastPairs.length ? Math.min(...contrastPairs.map((pair) => pair.ratio ?? 0)) : undefined };
  const smallestPreviewWidth = Math.min(input.targetViewportWidth, ...input.previewSizes.map((size) => size.width));
  const mobileScale = viewBox ? smallestPreviewWidth / viewBox.width : 1;
  const mobileMinimumText = metrics.textSizes.length ? Math.min(...metrics.textSizes) * mobileScale : undefined;
  const mobileDetailCount = metrics.rectCount + metrics.pathCount + (svg.match(/<use\b/gi) ?? []).length;
  const mobileReadabilityScore = Math.max(0, Math.min(100, 100 - (mobileMinimumText !== undefined && mobileMinimumText < 7 ? 20 : 0) - Math.max(0, mobileDetailCount - 80)));
  if (mobileReadabilityScore < 80) findings.push({ severity: "medium", category: "mobile", message: "SVG may have too many tiny details or small labels for mobile preview.", suggestedFix: "Simplify detail, increase font sizes, or generate a mobileVariant layout." });
  const styleConsistencyReport = {
    expectedStyle: input.expectedStyle,
    strokeWidths: [...new Set(metrics.strokeWidths)].sort((a, b) => a - b),
    cornerRadii: [...new Set(metrics.radii)].sort((a, b) => a - b),
    defsCount: metrics.defsCount,
    componentWeight: metrics.pathCount > metrics.rectCount * 4 ? "path-heavy" : "balanced"
  };
  const qualityScore = Math.max(0, Math.min(100, 100 - findings.reduce((total, finding) => total + (finding.severity === "high" ? 28 : finding.severity === "medium" ? 14 : 6), 0)));
  return { metrics, findings, suggestedFixes: [...new Set(findings.map((finding) => finding.suggestedFix))], qualityScore, mobileReadabilityScore, contrastReport, alignmentReport, styleConsistencyReport };
}

function buildTokenTheme(input: z.infer<typeof applySvgDesignTokensInputSchema>) {
  const profiles: Record<string, z.infer<typeof svgThemeSchema> & { semantic: Record<string, string>; spacing: number[]; typography: Record<string, number>; shadow: string; iconGrid: number; connector: string; gradient: string[] }> = {
    erp_admin_compact: { palette: ["#111827", "#2563eb", "#14b8a6", "#f8fafc"], background: "#ffffff", text: "#111827", strokeWidth: 2, radius: 8, fontFamily: "Inter, Arial, sans-serif", semantic: { primary: "#2563eb", success: "#16a34a", warning: "#d97706", danger: "#dc2626", info: "#0891b2", neutral: "#64748b" }, spacing: [4, 8, 12, 16, 24, 32], typography: { title: 26, subtitle: 18, body: 14, caption: 12 }, shadow: "0 8px 20px rgba(15,23,42,.12)", iconGrid: 24, connector: "2px solid #2563eb", gradient: ["#2563eb", "#14b8a6"] },
    enterprise_tech: { palette: ["#0f172a", "#2563eb", "#06b6d4", "#e0f2fe"], background: "#f8fafc", text: "#0f172a", strokeWidth: 2, radius: 6, fontFamily: "Inter, Arial, sans-serif", semantic: { primary: "#2563eb", success: "#059669", warning: "#ca8a04", danger: "#dc2626", info: "#0284c7", neutral: "#475569" }, spacing: [4, 8, 12, 20, 28, 40], typography: { title: 28, subtitle: 18, body: 14, caption: 12 }, shadow: "0 10px 24px rgba(2,6,23,.14)", iconGrid: 24, connector: "2px solid #2563eb", gradient: ["#2563eb", "#06b6d4"] },
    monochrome: { palette: ["#111827", "#4b5563", "#9ca3af", "#ffffff"], background: "#ffffff", text: "#111827", strokeWidth: 2, radius: 4, fontFamily: "Arial, sans-serif", semantic: { primary: "#111827", success: "#374151", warning: "#4b5563", danger: "#1f2937", info: "#6b7280", neutral: "#9ca3af" }, spacing: [4, 8, 12, 16, 24, 32], typography: { title: 24, subtitle: 18, body: 14, caption: 12 }, shadow: "none", iconGrid: 24, connector: "2px solid #111827", gradient: ["#111827", "#6b7280"] },
    playful_product: { palette: ["#1f2937", "#7c3aed", "#f97316", "#fef3c7"], background: "#fff7ed", text: "#1f2937", strokeWidth: 2, radius: 12, fontFamily: "Inter, Arial, sans-serif", semantic: { primary: "#7c3aed", success: "#22c55e", warning: "#f59e0b", danger: "#ef4444", info: "#0ea5e9", neutral: "#64748b" }, spacing: [4, 10, 16, 24, 32, 48], typography: { title: 30, subtitle: 20, body: 15, caption: 12 }, shadow: "0 12px 28px rgba(124,58,237,.16)", iconGrid: 32, connector: "3px solid #7c3aed", gradient: ["#7c3aed", "#f97316"] },
    presentation: { palette: ["#0f172a", "#4f46e5", "#10b981", "#eef2ff"], background: "#ffffff", text: "#0f172a", strokeWidth: 2, radius: 10, fontFamily: "Inter, Arial, sans-serif", semantic: { primary: "#4f46e5", success: "#10b981", warning: "#f59e0b", danger: "#ef4444", info: "#0ea5e9", neutral: "#64748b" }, spacing: [6, 12, 18, 28, 40, 56], typography: { title: 32, subtitle: 22, body: 16, caption: 13 }, shadow: "0 16px 32px rgba(15,23,42,.14)", iconGrid: 32, connector: "2px solid #4f46e5", gradient: ["#4f46e5", "#10b981"] }
  };
  const profile = profiles[input.tokenProfile ?? "erp_admin_compact"];
  const theme = { ...profile, ...input.theme, semantic: { ...profile.semantic } };
  if (input.targetTheme === "dark") {
    theme.background = "#0f172a";
    theme.text = "#f8fafc";
    theme.palette = ["#f8fafc", "#60a5fa", "#2dd4bf", "#1e293b"];
    theme.semantic = { primary: "#60a5fa", success: "#22c55e", warning: "#fbbf24", danger: "#f87171", info: "#38bdf8", neutral: "#94a3b8" };
    theme.shadow = "0 12px 28px rgba(0,0,0,.34)";
  } else if (input.targetTheme && profiles[input.targetTheme]) {
    return profiles[input.targetTheme];
  }
  return theme;
}

function classifySemanticColor(hex: string) {
  const clean = hex.toLowerCase();
  const value = parseInt(clean.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  if (r > 180 && g < 120 && b < 120) return "danger";
  if (g > 140 && r < 140) return "success";
  if (r > 180 && g > 120 && b < 80) return "warning";
  if (b > 150 && r < 120) return "info";
  if (Math.abs(r - g) < 18 && Math.abs(g - b) < 18) return r > 220 ? "background" : r < 60 ? "text" : "neutral";
  return "primary";
}

function applyTokenThemeToSvg(svg: string, theme: ReturnType<typeof buildTokenTheme>, preserveSemanticColors: boolean) {
  const colorMap = new Map<string, { to: string; role: string }>();
  const unmappedStyles = [...svg.matchAll(/\b(?:style|class)=["'][^"']*(?:#[\da-f]{3}|rgba?\(|hsl\()[^"']*["']/gi)].map((match) => match[0]);
  const replaceColor = (match: string, attr: string, color: string) => {
    const normalized = color.length === 4 ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`.toLowerCase() : color.toLowerCase();
    const role = preserveSemanticColors ? classifySemanticColor(normalized) : "primary";
    const mapped = role === "background" ? theme.background : role === "text" ? theme.text : theme.semantic[role] ?? theme.palette[1] ?? normalized;
    colorMap.set(normalized, { to: mapped, role });
    return `${attr}="${mapped}"`;
  };
  let transformed = svg.replace(/\b(fill|stroke)=["'](#[\da-f]{3,6})["']/gi, replaceColor);
  transformed = transformed
    .replace(/\bstroke-width=["'][\d.]+["']/gi, `stroke-width="${theme.strokeWidth}"`)
    .replace(/\brx=["'][\d.]+["']/gi, `rx="${theme.radius}"`)
    .replace(/\bfont-family=["'][^"']+["']/gi, `font-family="${xml(theme.fontFamily)}"`);
  const tokenStyle = `<style id="svg-design-tokens">:root{--svg-bg:${theme.background};--svg-text:${theme.text};--svg-primary:${theme.semantic.primary};--svg-success:${theme.semantic.success};--svg-warning:${theme.semantic.warning};--svg-danger:${theme.semantic.danger};--svg-info:${theme.semantic.info};--svg-neutral:${theme.semantic.neutral};--svg-radius:${theme.radius}px;--svg-stroke:${theme.strokeWidth};--svg-shadow:${theme.shadow};--svg-icon-grid:${theme.iconGrid}px;} text{font-family:${xml(theme.fontFamily)};} .token-shadow{filter:drop-shadow(${theme.shadow});}</style>`;
  transformed = transformed.replace(/<svg\b([^>]*)>/i, `<svg$1>\n${tokenStyle}`);
  return {
    transformed,
    tokenMappingReport: {
      colors: [...colorMap.entries()].map(([from, mapping]) => ({ from, to: mapping.to, role: mapping.role })),
      strokeWidth: theme.strokeWidth,
      cornerRadius: theme.radius,
      spacingScale: theme.spacing,
      typographyScale: theme.typography,
      shadow: theme.shadow,
      iconGrid: theme.iconGrid,
      connectorStyle: theme.connector,
      gradientStyle: theme.gradient
    },
    unmappedStyles
  };
}

export const svgDesignStudioTools: ToolModule[] = [
  {
    definition: { name: "generate_svg_scene", description: "Generate structured complex SVG scenes from prompt, JSON, or schema with layers, reusable symbols, defs, gradients, masks, clip paths, patterns, filters, components, validation, and scene manifest.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, prompt: { type: "string" }, canvas: { type: "object" }, title: { type: "string" }, width: { type: "number" }, height: { type: "number" }, style: { type: "string" }, sceneType: { type: "string" }, elements: { type: "array" }, layers: { type: "array", items: { type: "string" } }, theme: { type: "object" }, outputPath: { type: "string" }, outputManifestPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: generateSvgSceneInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateSvgSceneInputSchema.parse(input);
      const scene = renderScene(parsed);
      const svgFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, scene.svg);
      const manifest = { svgPath: svgFile.path, title: parsed.title, sceneType: parsed.sceneType, style: parsed.style, viewBox: scene.viewBox, layers: parsed.layers, elementCount: scene.elements.length, componentList: scene.componentList, designTokens: parsed.theme, advancedFeatures: ["defs", "linearGradient", "radialGradient", "pattern", "clipPath", "mask", "filter", "symbol", "use"], validation: scene.validation };
      const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const structuredContent = { svgPath: svgFile.path, svgText: scene.svg, sceneManifest: manifest, componentList: scene.componentList, viewBox: scene.viewBox, warnings: scene.validation.warnings };
      return { ok: scene.validation.warnings.length === 0, summary: `Generated SVG scene with ${scene.elements.length} component(s).`, jobId: parsed.projectId, artifacts: [svgFile.path, manifestFile.path], structuredContent, logs: [JSON.stringify(manifest, null, 2)], errors: scene.validation.warnings };
    }
  },
  {
    definition: { name: "layout_svg_elements", description: "Auto-layout SVG nodes, labels, cards, groups, swimlanes, connectors, diagrams, timelines, mind maps, org charts, dashboards, and process pipelines with overlap avoidance, routing, viewBox sizing, mobile variants, and layout reports.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, sceneManifestPath: { type: "string" }, elements: { type: "array" }, nodes: { type: "array" }, edges: { type: "array" }, layout: { type: "string" }, layoutType: { type: "string" }, direction: { type: "string" }, canvas: { type: "object" }, width: { type: "number" }, spacing: { type: "number" }, constraints: { type: "object" }, outputSvgPath: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: layoutSvgElementsInputSchema,
    handler: async (input, ctx) => {
      const parsed = layoutSvgElementsInputSchema.parse(input);
      const sceneManifest = parsed.sceneManifestPath ? JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.sceneManifestPath, 2 * 1024 * 1024)) as Record<string, unknown> : undefined;
      const normalized = normalizeLayoutInputs(parsed, sceneManifest);
      const positionedElements = advancedLayout(parsed, normalized.elements);
      const canvasWidth = parsed.canvas?.width ?? parsed.width;
      const canvasHeight = Math.max(parsed.canvas?.height ?? 540, Math.max(...positionedElements.map((element) => (element.y ?? 0) + (element.height ?? 72))) + parsed.spacing);
      const viewBox = `0 0 ${canvasWidth} ${canvasHeight}`;
      const connectorRoutes = parsed.constraints.routeConnectors ? routeConnectors(normalized.edges, positionedElements, parsed.direction) : [];
      const warnings = layoutWarnings(positionedElements, parsed);
      const mobileVariant = parsed.constraints.responsive || positionedElements.length > 8
        ? { layoutType: "mobile_stack", width: 390, positions: positionedElements.map((element, index) => ({ id: element.id, x: 24, y: 32 + index * 96, width: 342, height: element.height ?? 72 })) }
        : undefined;
      const layoutScore = Math.max(0, Math.min(100, 100 - warnings.length * 12 - Math.max(0, positionedElements.length - 24)));
      const svg = renderLayoutSvg("SVG Layout", positionedElements, connectorRoutes.filter((route) => route.points.length > 0), viewBox);
      const svgFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputSvgPath, svg);
      const result = {
        layout: parsed.layout ?? parsed.layoutType,
        layoutType: parsed.layoutType,
        direction: parsed.direction,
        viewBox,
        updatedSvgPath: svgFile.path,
        positions: Object.fromEntries(positionedElements.map((element) => [element.id, { x: element.x, y: element.y, width: element.width, height: element.height }])),
        positionedElements,
        connectors: connectorRoutes,
        connectorRoutes,
        layoutScore,
        groups: [...new Set(normalized.nodes.map((node) => node.group).filter(Boolean))],
        mobileVariant,
        warnings
      };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(result, null, 2)}\n`);
      return { ok: warnings.length === 0, summary: `Laid out ${positionedElements.length} SVG element(s) with score ${layoutScore}.`, jobId: parsed.projectId, artifacts: [svgFile.path, file.path], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: warnings };
    }
  },
  {
    definition: { name: "fit_svg_typography", description: "Measure, wrap, resize, align, truncate, and report SVG typography for labels, cards, diagrams, English/Chinese/mixed copy, and readable font sizes.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, svgPath: { type: "string" }, textBlocks: { type: "array" }, textBoxes: { type: "array" }, languageHints: { type: "array" }, style: { type: "string" }, outputSvgPath: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: fitSvgTypographyInputSchema,
    handler: async (input, ctx) => {
      const parsed = fitSvgTypographyInputSchema.parse(input);
      const blockRequests = (parsed.textBlocks ?? []).map((block, index) => ({
        id: block.id,
        text: block.text,
        box: { x: 24, y: 24 + index * ((block.height ?? 72) + 16), width: block.width, height: block.height ?? Math.max(40, block.maxLines * block.maxFontSize * 1.35) },
        minFontSize: block.minFontSize,
        maxFontSize: block.maxFontSize,
        wrap: true,
        truncate: false,
        align: "start" as const,
        verticalAlign: "middle" as const,
        hierarchy: block.hierarchy,
        language: block.language
      }));
      const textBoxes = [...blockRequests, ...(parsed.textBoxes ?? []).map((box) => ({
        ...box,
        language: box.language ?? detectTypographyLanguage(box.text, parsed.languageHints)
      }))];
      const textLayoutReport = textBoxes.map((box) => {
        const language = box.language ?? detectTypographyLanguage(box.text, parsed.languageHints);
        const fitted = fitTextToBox({ ...box, width: box.box.width, height: box.box.height, language });
        const linesHeight = fitted.lines.length * fitted.lineHeight;
        const startY = box.verticalAlign === "top"
          ? box.box.y + fitted.fontSize
          : box.verticalAlign === "bottom"
            ? box.box.y + box.box.height - linesHeight + fitted.fontSize
            : box.box.y + (box.box.height - linesHeight) / 2 + fitted.fontSize;
        const textAnchor = box.align === "middle" ? "middle" : box.align === "end" ? "end" : "start";
        const x = box.align === "middle" ? box.box.x + box.box.width / 2 : box.align === "end" ? box.box.x + box.box.width - 8 : box.box.x + 8;
        return {
          ...fitted,
          box: box.box,
          align: box.align,
          verticalAlign: box.verticalAlign,
          textAnchor,
          x: Math.round(x),
          startY: Math.round(startY),
          lineCount: fitted.lines.length,
          fitsSafely: !fitted.overflow
        };
      });
      const fittedBlocks = textLayoutReport.map((block) => ({ id: block.id, fontSize: block.fontSize, lines: block.lines, lineHeight: block.lineHeight, overflow: block.overflow }));
      const overflowWarnings = textLayoutReport.filter((block) => block.overflow).map((block) => `${block.id}: text cannot fit safely inside ${block.box.width}x${block.box.height}.`);
      const fontSizeAdjustments = textLayoutReport
        .filter((block) => {
          const source = textBoxes.find((box) => box.id === block.id);
          return source ? block.fontSize !== source.maxFontSize : false;
        })
        .map((block) => {
          const source = textBoxes.find((box) => box.id === block.id);
          return { id: block.id, from: source?.maxFontSize, to: block.fontSize };
        });
      const unfitLabels = textLayoutReport.filter((block) => block.overflow).map((block) => block.id);
      const baseSvg = parsed.svgPath ? await readSvg(ctx, parsed.projectId, parsed.svgPath) : "";
      const width = Math.max(320, ...textBoxes.map((box) => box.box.x + box.box.width + 24));
      const height = Math.max(160, ...textBoxes.map((box) => box.box.y + box.box.height + 24));
      const textLayer = textLayoutReport.map((block) => {
        const tspans = block.lines.map((line, index) => `<tspan x="${block.x}" dy="${index === 0 ? 0 : block.lineHeight}">${xml(line)}</tspan>`).join("");
        return `<g id="${xml(block.id)}" data-typography-fit="true"><rect x="${block.box.x}" y="${block.box.y}" width="${block.box.width}" height="${block.box.height}" rx="6" fill="none" stroke="#cbd5e1" stroke-dasharray="4 4"/><text x="${block.x}" y="${block.startY}" font-family="Inter, Arial, sans-serif" font-size="${block.fontSize}" font-weight="${hierarchyWeight(block.hierarchy)}" text-anchor="${block.textAnchor}" fill="#111827">${tspans}</text></g>`;
      }).join("\n");
      const svg = baseSvg.includes("</svg>")
        ? baseSvg.replace("</svg>", `<g id="typography-fit-layer">\n${textLayer}\n</g>\n</svg>`)
        : svgRoot("SVG Typography Fit", width, height, `<rect width="100%" height="100%" fill="#ffffff"/>\n${textLayer}`, `Typography fit report for ${parsed.style}`);
      const svgFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputSvgPath, svg);
      const result = { updatedSvgPath: svgFile.path, textLayoutReport, overflowWarnings, fontSizeAdjustments, unfitLabels, fittedBlocks, warnings: overflowWarnings };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(result, null, 2)}\n`);
      return { ok: result.warnings.length === 0, summary: `Fit ${fittedBlocks.length} SVG text block(s).`, jobId: parsed.projectId, artifacts: [svgFile.path, file.path], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: result.warnings };
    }
  },
  {
    definition: { name: "inspect_svg_visual_quality", description: "Inspect SVG visual quality for viewBox, clipping, overlap risk, alignment, spacing, typography, contrast, stroke consistency, hierarchy, mobile readability, accessibility, bloat, and suggested fixes.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, svgPath: { type: "string" }, svgString: { type: "string" }, expectedStyle: { type: "string" }, previewSizes: { type: "array" }, designTokens: { type: "object" }, checkAccessibility: { type: "boolean" }, targetViewportWidth: { type: "number" }, minTextSize: { type: "number" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: inspectSvgVisualQualityInputSchema,
    handler: async (input, ctx) => {
      const parsed = inspectSvgVisualQualityInputSchema.parse(input);
      const svg = parsed.svgString ?? await readSvg(ctx, parsed.projectId, parsed.svgPath!);
      const qa = svgVisualQa(svg, parsed);
      const result = {
        svgPath: parsed.svgPath,
        expectedStyle: parsed.expectedStyle,
        previewSizes: parsed.previewSizes.length ? parsed.previewSizes : [{ width: parsed.targetViewportWidth, height: Math.round(parsed.targetViewportWidth * 1.4) }],
        targetViewportWidth: parsed.targetViewportWidth,
        ...qa,
        severity: qa.findings.some((finding) => finding.severity === "high") ? "high" : qa.findings.some((finding) => finding.severity === "medium") ? "medium" : qa.findings.some((finding) => finding.severity === "low") ? "low" : "none"
      };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(result, null, 2)}\n`);
      return { ok: result.findings.length === 0, summary: `SVG visual QA found ${result.findings.length} finding(s), quality score ${result.qualityScore}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: result.findings.map((finding) => finding.message) };
    }
  },
  {
    definition: { name: "apply_svg_design_tokens", description: "Apply SVG design tokens and transform themes for colors, semantic status colors, stroke widths, radius, spacing, typography, shadows, icon grid, connectors, gradients, contrast, and style reports.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, svgPath: { type: "string" }, svgString: { type: "string" }, tokenProfile: { type: "string" }, targetTheme: { type: "string" }, preserveSemanticColors: { type: "boolean" }, componentStyleMapping: { type: "object" }, theme: { type: "object" }, outputPath: { type: "string" }, outputTokensPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: applySvgDesignTokensInputSchema,
    handler: async (input, ctx) => {
      const parsed = applySvgDesignTokensInputSchema.parse(input);
      const svg = parsed.svgString ?? await readSvg(ctx, parsed.projectId, parsed.svgPath!);
      const tokenTheme = buildTokenTheme(parsed);
      const applied = applyTokenThemeToSvg(svg, tokenTheme, parsed.preserveSemanticColors);
      const contrastPairs = applied.tokenMappingReport.colors.map((mapping) => ({
        role: mapping.role,
        foreground: mapping.to,
        background: tokenTheme.background,
        ratio: contrastRatio(mapping.to, tokenTheme.background)
      })).filter((pair) => pair.ratio !== undefined);
      const lowContrastPairs = contrastPairs.filter((pair) => (pair.ratio ?? 0) < 3 && pair.role !== "background");
      const warnings = [
        ...applied.unmappedStyles.map((style) => `Unmapped hardcoded style requires review: ${style.slice(0, 120)}`),
        ...lowContrastPairs.map((pair) => `${pair.role} color ${pair.foreground} has low contrast against ${pair.background}.`)
      ];
      const result = {
        updatedSvgPath: parsed.outputPath,
        svgPath: parsed.outputPath,
        tokensPath: parsed.outputTokensPath,
        tokenProfile: parsed.tokenProfile ?? "custom",
        targetTheme: parsed.targetTheme ?? "custom",
        preserveSemanticColors: parsed.preserveSemanticColors,
        theme: tokenTheme,
        tokenMappingReport: applied.tokenMappingReport,
        contrastReport: {
          checkedPairs: contrastPairs.length,
          lowContrastPairs,
          minimumRatio: contrastPairs.length ? Math.min(...contrastPairs.map((pair) => pair.ratio ?? 0)) : undefined
        },
        unmappedStyles: applied.unmappedStyles,
        warnings
      };
      const svgFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, applied.transformed);
      const tokenFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputTokensPath, `${JSON.stringify({ theme: tokenTheme, tokenMappingReport: applied.tokenMappingReport }, null, 2)}\n`);
      return { ok: warnings.length === 0, summary: `Applied SVG design tokens for ${result.targetTheme} theme with ${applied.tokenMappingReport.colors.length} color mapping(s).`, jobId: parsed.projectId, artifacts: [svgFile.path, tokenFile.path], structuredContent: { ...result, updatedSvgPath: svgFile.path, svgPath: svgFile.path, tokensPath: tokenFile.path }, logs: [JSON.stringify(result, null, 2)], errors: warnings };
    }
  },
  {
    definition: { name: "optimize_svg_paths", description: "Optimize and clean SVG paths/structure with conservative, balanced, or aggressive safe modes while preserving selected IDs and accessibility metadata.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, svgPath: { type: "string" }, svgString: { type: "string" }, mode: { type: "string" }, precision: { type: "number" }, removeMetadata: { type: "boolean" }, removeUnusedDefs: { type: "boolean" }, removeHiddenElements: { type: "boolean" }, normalizeStroke: { type: "boolean" }, preserveAccessibility: { type: "boolean" }, preserveIds: { type: "array", items: { type: "string" } }, outputPath: { type: "string" }, outputReportPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: optimizeSvgPathsInputSchema,
    handler: async (input, ctx) => {
      const parsed = optimizeSvgPathsInputSchema.parse(input);
      const before = parsed.svgString ?? await readSvg(ctx, parsed.projectId, parsed.svgPath!);
      const result = optimizeSvgMarkup(before, parsed);
      const svgFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, result.optimized);
      const reductionPercent = Number(((1 - result.afterSize / Math.max(1, result.beforeSize)) * 100).toFixed(2));
      const report = {
        sourcePath: parsed.svgPath,
        optimizedPath: svgFile.path,
        optimizedSvgPath: svgFile.path,
        mode: parsed.mode,
        precision: parsed.precision,
        beforeBytes: result.beforeSize,
        afterBytes: result.afterSize,
        beforeSizeBytes: result.beforeSize,
        afterSizeBytes: result.afterSize,
        sizeReductionPercent: reductionPercent,
        reductionPercent,
        changes: result.changedElements,
        changedElements: result.changedElements,
        visualRiskNotes: result.riskWarnings,
        riskWarnings: result.riskWarnings,
        preservedIds: result.preservedIds,
        preservationRules: {
          preserveAccessibility: parsed.preserveAccessibility,
          preserveIds: parsed.preserveIds
        },
        checks: {
          removedMetadata: result.changedElements.includes("removed-metadata"),
          removedHiddenElements: result.changedElements.includes("removed-hidden-elements"),
          optimizedPathData: result.changedElements.some((change) => change.startsWith("optimized-path-data")),
          normalizedStroke: result.changedElements.some((change) => change.startsWith("normalized-stroke-style")),
          removedUnusedDefs: result.changedElements.some((change) => change.startsWith("removed-unused-def"))
        }
      };
      const reportFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReportPath, `${JSON.stringify(report, null, 2)}\n`);
      return { ok: result.riskWarnings.length === 0 || parsed.mode !== "aggressive", summary: `Optimized SVG by ${report.sizeReductionPercent}% in ${parsed.mode} mode.`, jobId: parsed.projectId, artifacts: [svgFile.path, reportFile.path], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: result.riskWarnings };
    }
  },
  {
    definition: { name: "generate_svg_diagram", description: "Generate accessible SVG diagrams from prompt, JSON, Mermaid-like specs, or explicit nodes/edges with auto layout, routed connectors, groups, swimlanes, legend, callouts, and manifest output.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, prompt: { type: "string" }, mermaidSpec: { type: "string" }, jsonSpec: { type: "object" }, diagramType: { type: "string" }, nodes: { type: "array" }, edges: { type: "array" }, groups: { type: "array" }, swimlanes: { type: "array" }, legend: { type: "array" }, callouts: { type: "array" }, direction: { type: "string" }, canvas: { type: "object" }, theme: { type: "object" }, includePngPreview: { type: "boolean" }, outputPath: { type: "string" }, outputManifestPath: { type: "string" }, outputPreviewPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: generateSvgDiagramInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateSvgDiagramInputSchema.parse(input);
      const normalized = normalizeDiagramInput(parsed);
      const width = parsed.canvas?.width ?? 1200;
      const height = parsed.canvas?.height ?? 720;
      const positioned = layoutDiagramNodes(normalized.nodes, width, height, parsed.direction, normalized.swimlanes);
      const routeInput = positioned.map((node) => ({ id: node.id, label: node.label, type: "node" as const, x: node.x, y: node.y, width: node.width, height: node.height }));
      const connectorRoutes = routeConnectors(normalized.edges, routeInput, parsed.direction);
      const svg = renderDiagramSvg(parsed, normalized, positioned, connectorRoutes);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, svg);
      const missingEndpoints = connectorRoutes.filter((route) => route.route === "missing").map((route) => `${route.from}->${route.to}`);
      const manifest = {
        title: parsed.title,
        diagramType: parsed.diagramType,
        inputSource: normalized.inputSource,
        svgPath: file.path,
        pngPreviewPath: parsed.includePngPreview ? parsed.outputPreviewPath : undefined,
        previewPlan: parsed.includePngPreview ? { status: "planned", outputPath: parsed.outputPreviewPath, note: "PNG preview requires a renderer/export step; SVG and manifest are ready." } : undefined,
        viewBox: `0 0 ${width} ${height}`,
        nodeCount: normalized.nodes.length,
        edgeCount: normalized.edges.length,
        groups: normalized.groups,
        swimlanes: normalized.swimlanes,
        legend: normalized.legend,
        callouts: normalized.callouts,
        positionedNodes: positioned,
        connectorRoutes,
        layout: parsed.direction === "top_to_bottom" ? "layered_vertical" : "flow",
        accessibility: { title: parsed.title, desc: `${parsed.diagramType} diagram with ${normalized.nodes.length} nodes and ${normalized.edges.length} edges.`, hasTitleDesc: /<title\b/i.test(svg) && /<desc\b/i.test(svg) },
        warnings: missingEndpoints.length ? [`Missing connector endpoint(s): ${missingEndpoints.join(", ")}`] : []
      };
      const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: manifest.warnings.length === 0, summary: `Generated ${parsed.diagramType} SVG diagram with ${normalized.nodes.length} node(s) and ${normalized.edges.length} edge(s).`, jobId: parsed.projectId, artifacts: [file.path, manifestFile.path], structuredContent: { ...manifest, diagramManifestPath: manifestFile.path }, logs: [JSON.stringify({ svgPath: file.path, nodeCount: normalized.nodes.length, edgeCount: normalized.edges.length }, null, 2)], errors: manifest.warnings };
    }
  },
  {
    definition: { name: "generate_svg_chart", description: "Convert CSV, JSON, or table-like data into export-ready SVG charts with responsive sizing, labels, legends, annotations, accessibility metadata, chart issue checks, and manifest output.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, chartType: { type: "string" }, data: { type: "array" }, jsonData: {}, csvString: { type: "string" }, tableData: { type: "object" }, xField: { type: "string" }, yField: { type: "string" }, seriesFields: { type: "array", items: { type: "string" } }, annotations: { type: "array" }, responsive: { type: "boolean" }, includeLegend: { type: "boolean" }, includePngPreview: { type: "boolean" }, canvas: { type: "object" }, theme: { type: "object" }, outputPath: { type: "string" }, outputManifestPath: { type: "string" }, outputPreviewPath: { type: "string" } }, required: ["projectId", "title"], additionalProperties: false } },
    enabledByDefault: true,
    schema: generateSvgChartInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateSvgChartInputSchema.parse(input);
      const normalized = normalizeChartData(parsed);
      const rows = normalized.rows as Array<Record<string, string | number | boolean>>;
      const render = renderSvgChart(parsed, rows);
      const values = rows.map((row) => numericValue(row, parsed.yField));
      const chartIssues = detectChartIssues(parsed, rows, values);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, render.svg);
      const manifest = {
        title: parsed.title,
        chartType: parsed.chartType,
        inputSource: normalized.inputSource,
        svgPath: file.path,
        chartManifestPath: parsed.outputManifestPath,
        pngPreviewPath: parsed.includePngPreview ? parsed.outputPreviewPath : undefined,
        previewPlan: parsed.includePngPreview ? { status: "planned", outputPath: parsed.outputPreviewPath, note: "PNG preview requires a renderer/export step; SVG and manifest are ready." } : undefined,
        rowCount: rows.length,
        xField: parsed.xField,
        yField: parsed.yField,
        seriesFields: render.seriesFields,
        yMax: render.yMax,
        yMin: render.yMin,
        viewBox: `0 0 ${parsed.canvas?.width ?? 960} ${parsed.canvas?.height ?? 540}`,
        responsive: parsed.responsive,
        legend: parsed.includeLegend,
        annotations: parsed.annotations,
        accessibility: { title: parsed.title, desc: `${parsed.chartType} chart with ${rows.length} rows.`, hasTitleDesc: /<title\b/i.test(render.svg) && /<desc\b/i.test(render.svg) },
        chartIssues,
        warnings: chartIssues.filter((issue) => issue.severity !== "low").map((issue) => issue.message)
      };
      const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: !chartIssues.some((issue) => issue.severity === "high"), summary: `Generated ${parsed.chartType} SVG chart with ${rows.length} row(s).`, jobId: parsed.projectId, artifacts: [file.path, manifestFile.path], structuredContent: { ...manifest, chartManifestPath: manifestFile.path }, logs: [JSON.stringify({ svgPath: file.path, chartType: parsed.chartType, rowCount: rows.length }, null, 2)], errors: manifest.warnings };
    }
  },
  {
    definition: { name: "generate_isometric_svg", description: "Generate clean isometric SVG illustrations from prompt or structured scene specs with reusable primitives, consistent perspective/style, optimized SVG, layer metadata, and preview plan.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, prompt: { type: "string" }, sceneJson: { type: "object" }, scene: { type: "string" }, objects: { type: "array" }, canvas: { type: "object" }, includePngPreview: { type: "boolean" }, theme: { type: "object" }, outputPath: { type: "string" }, outputOptimizedPath: { type: "string" }, outputManifestPath: { type: "string" }, outputPreviewPath: { type: "string" } }, required: ["projectId", "title"], additionalProperties: false } },
    enabledByDefault: true,
    schema: generateIsometricSvgInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateIsometricSvgInputSchema.parse(input);
      const primitives = normalizeIsometricPrimitives(parsed);
      const rendered = renderIsometricScene(parsed, primitives);
      const optimized = optimizeSvgMarkup(rendered.svg, { projectId: parsed.projectId, svgString: rendered.svg, mode: "balanced", precision: 2, removeMetadata: true, removeUnusedDefs: false, removeHiddenElements: true, normalizeStroke: true, preserveAccessibility: true, preserveIds: ["aria", "animation", "interactive"], outputPath: parsed.outputOptimizedPath, outputReportPath: "unused.json" });
      const svgFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, rendered.svg);
      const optimizedFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputOptimizedPath, optimized.optimized);
      const layerMetadata = rendered.layers.map((layer) => ({ id: layer, primitiveCount: primitives.filter((primitive) => primitive.layer === layer).length, order: layer === "base" ? 0 : layer === "objects" ? 1 : 2 }));
      const manifest = {
        title: parsed.title,
        scene: parsed.scene,
        prompt: parsed.prompt,
        svgPath: svgFile.path,
        optimizedSvgPath: optimizedFile.path,
        sceneManifestPath: parsed.outputManifestPath,
        pngPreviewPath: parsed.includePngPreview ? parsed.outputPreviewPath : undefined,
        previewPlan: parsed.includePngPreview ? { status: "planned", outputPath: parsed.outputPreviewPath, note: "PNG preview requires a renderer/export step; optimized SVG and manifest are ready." } : undefined,
        viewBox: rendered.viewBox,
        perspective: "2:1 isometric",
        primitiveCount: primitives.length,
        primitives,
        scenePrimitives: Array.from(new Set(primitives.map((primitive) => primitive.type))),
        layerMetadata,
        themeTokens: { palette: parsed.theme.palette, background: parsed.theme.background, strokeWidth: parsed.theme.strokeWidth, radius: parsed.theme.radius, fontFamily: parsed.theme.fontFamily },
        styleConsistency: { perspective: "consistent", scale: "grid-based", shadows: "iso-shadow filter", strokeStyle: "theme stroke tokens" },
        optimization: { beforeSizeBytes: optimized.beforeSize, afterSizeBytes: optimized.afterSize, changedElements: optimized.changedElements, riskWarnings: optimized.riskWarnings }
      };
      const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: optimized.riskWarnings.length === 0, summary: `Generated isometric ${parsed.scene} SVG with ${primitives.length} primitive(s).`, jobId: parsed.projectId, artifacts: [svgFile.path, optimizedFile.path, manifestFile.path], structuredContent: { ...manifest, sceneManifestPath: manifestFile.path }, logs: [JSON.stringify({ svgPath: svgFile.path, optimizedSvgPath: optimizedFile.path, primitiveCount: primitives.length }, null, 2)], errors: optimized.riskWarnings };
    }
  },
  {
    definition: { name: "generate_svg_icon_set", description: "Generate a consistent SVG icon family from prompt, domain, icon JSON, or design tokens with individual SVGs, sprite, preview sheet, metadata, README, and QA checks.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, familyName: { type: "string" }, prompt: { type: "string" }, domain: { type: "string" }, icons: { type: "array" }, style: { type: "string" }, gridSize: { type: "number" }, padding: { type: "number" }, designTokens: { type: "object" }, theme: { type: "object" }, outputDirectory: { type: "string" }, outputManifestPath: { type: "string" }, outputSpritePath: { type: "string" }, outputPreviewPath: { type: "string" }, outputReadmePath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: generateSvgIconSetInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateSvgIconSetInputSchema.parse(input);
      const normalized = normalizeIconSetInput(parsed);
      const artifacts: string[] = [];
      const icons = [];
      for (const icon of normalized.icons) {
        const iconSvg = renderIconSvg(icon, { ...parsed, familyName: normalized.familyName }, normalized.tokens);
        const path = `${parsed.outputDirectory}/${icon.name}.svg`;
        artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, path, iconSvg)).path);
        icons.push({ name: icon.name, path, gridSize: parsed.gridSize, concept: icon.concept, label: ("label" in icon ? icon.label : undefined) ?? icon.name, svg: iconSvg });
      }
      const sprite = svgRoot(`${normalized.familyName} Sprite`, parsed.gridSize, parsed.gridSize, `<defs>${icons.map((icon) => iconSymbol(icon.svg, icon.name)).join("\n")}</defs>`, `${normalized.familyName} SVG sprite`);
      const spriteFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputSpritePath, sprite);
      artifacts.push(spriteFile.path);
      const cols = Math.min(6, Math.max(1, icons.length));
      const cell = parsed.gridSize + 72;
      const previewWidth = Math.max(360, cols * cell);
      const previewHeight = Math.ceil(icons.length / cols) * (cell + 34) + 96;
      const previewItems = icons.map((icon, index) => {
        const x = 48 + (index % cols) * cell;
        const y = 92 + Math.floor(index / cols) * (cell + 34);
        return `<g><rect x="${x - 12}" y="${y - 18}" width="${cell - 18}" height="${cell + 12}" rx="10" fill="#ffffff" stroke="#e5e7eb"/><svg x="${x}" y="${y}" width="${parsed.gridSize}" height="${parsed.gridSize}" viewBox="0 0 ${parsed.gridSize} ${parsed.gridSize}">${icon.svg.replace(/^[\s\S]*?<svg\b[^>]*>/i, "").replace(/<\/svg>\s*$/i, "").replace(/<title\b[\s\S]*?<\/desc>\s*/i, "")}</svg><text x="${x + parsed.gridSize / 2}" y="${y + parsed.gridSize + 24}" text-anchor="middle" font-size="12" fill="${xml(parsed.theme.text)}">${xml(icon.name)}</text></g>`;
      }).join("\n");
      const preview = svgRoot(`${normalized.familyName} Preview`, previewWidth, previewHeight, `<rect width="100%" height="100%" fill="${xml(parsed.theme.background)}"/><text x="40" y="48" font-size="24" font-weight="900" fill="${xml(parsed.theme.text)}">${xml(normalized.familyName)}</text>${previewItems}`, `${icons.length} icon preview sheet`);
      const previewFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPreviewPath, preview);
      artifacts.push(previewFile.path);
      const qaReport = buildIconSetQa(icons, parsed.gridSize, normalized.tokens.strokeWidth);
      const publicIcons = icons.map(({ svg: _svg, ...icon }) => icon);
      const manifest = { familyName: normalized.familyName, prompt: parsed.prompt, domain: parsed.domain, style: parsed.style, gridSize: parsed.gridSize, padding: parsed.padding, icons: publicIcons, spritePath: spriteFile.path, previewSheetPath: previewFile.path, readmePath: parsed.outputReadmePath, sharedStyle: { strokeWidth: normalized.tokens.strokeWidth, radius: normalized.tokens.radius, palette: normalized.tokens.palette, opticalWeight: normalized.tokens.opticalWeight, cornerRadius: normalized.tokens.radius, padding: parsed.padding }, exportStructure: { individualSvgDirectory: parsed.outputDirectory, sprite: spriteFile.path, previewSheet: previewFile.path, metadataJson: parsed.outputManifestPath, readme: parsed.outputReadmePath }, qaReport };
      const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      artifacts.push(manifestFile.path);
      const readmeFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReadmePath, iconSetReadme({ familyName: normalized.familyName, style: parsed.style, gridSize: parsed.gridSize, spritePath: spriteFile.path, icons: publicIcons }));
      artifacts.push(readmeFile.path);
      return { ok: qaReport.pass, summary: `Generated ${icons.length} SVG icon(s) for ${normalized.familyName}.`, jobId: parsed.projectId, artifacts, structuredContent: { ...manifest, manifestPath: manifestFile.path, readmePath: readmeFile.path }, logs: [JSON.stringify({ familyName: normalized.familyName, iconCount: icons.length, qaPass: qaReport.pass }, null, 2)], errors: qaReport.findings.filter((finding) => finding.severity !== "low").map((finding) => finding.message) };
    }
  },
  {
    definition: { name: "animate_svg_scene", description: "Add CSS-safe SVG animation such as path draw, fade, scale, pulse, flow-line, and step reveal.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, svgPath: { type: "string" }, animation: { type: "string" }, durationMs: { type: "number" }, outputPath: { type: "string" } }, required: ["projectId", "svgPath"], additionalProperties: false } },
    enabledByDefault: true,
    schema: animateSvgSceneInputSchema,
    handler: async (input, ctx) => {
      const parsed = animateSvgSceneInputSchema.parse(input);
      const svg = await readSvg(ctx, parsed.projectId, parsed.svgPath);
      const style = `<style>@keyframes svgStudioFade{from{opacity:.2;transform:scale(.98)}to{opacity:1;transform:scale(1)}} svg>*:not(style):not(title):not(desc){animation:svgStudioFade ${parsed.durationMs}ms ease both;transform-origin:center;}</style>`;
      const animated = svg.replace(/<svg\b([^>]*)>/i, `<svg$1>\n${style}`);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, animated);
      return { ok: true, summary: `Added ${parsed.animation} animation.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { svgPath: file.path, animation: parsed.animation, durationMs: parsed.durationMs }, logs: [], errors: [] };
    }
  },
  {
    definition: { name: "add_svg_interactivity", description: "Add SVG hover tooltip, click highlight, hotspot, and step reveal interactivity using safe inline SVG/CSS primitives.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, svgPath: { type: "string" }, hotspots: { type: "array" }, interaction: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "svgPath"], additionalProperties: false } },
    enabledByDefault: true,
    schema: addSvgInteractivityInputSchema,
    handler: async (input, ctx) => {
      const parsed = addSvgInteractivityInputSchema.parse(input);
      const svg = await readSvg(ctx, parsed.projectId, parsed.svgPath);
      const hotspotSvg = parsed.hotspots.map((hotspot) => `<a href="#" aria-label="${xml(hotspot.label)}"><rect id="${xml(hotspot.id)}" x="${hotspot.x}" y="${hotspot.y}" width="${hotspot.width}" height="${hotspot.height}" fill="transparent" stroke="#f59e0b" stroke-dasharray="4 4"><title>${xml(hotspot.label)}</title></rect></a>`).join("\n");
      const interactive = svg.replace(/<\/svg>\s*$/i, `<style>a:focus rect,a:hover rect{fill:rgba(245,158,11,.12);}</style>${hotspotSvg}</svg>\n`);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, interactive);
      return { ok: true, summary: `Added ${parsed.hotspots.length} SVG hotspot(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { svgPath: file.path, interaction: parsed.interaction, hotspotCount: parsed.hotspots.length }, logs: [], errors: [] };
    }
  },
  {
    definition: { name: "animate_and_interact_svg", description: "Add production-safe SVG animation and interaction with CSS, inline SVG, WAAPI config, interaction manifest, reduced-motion handling, and QA checks.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, svgPath: { type: "string" }, svgString: { type: "string" }, animations: { type: "array" }, interactions: { type: "array" }, reducedMotion: { type: "boolean" }, outputPath: { type: "string" }, outputCssPath: { type: "string" }, outputWaapiPath: { type: "string" }, outputManifestPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: animateAndInteractSvgInputSchema,
    handler: async (input, ctx) => {
      const parsed = animateAndInteractSvgInputSchema.parse(input);
      const source = parsed.svgString ?? await readSvg(ctx, parsed.projectId, parsed.svgPath!);
      const css = buildSvgAnimationCss(parsed);
      const animatedSvg = injectSvgAnimationAndInteractions(source, parsed, css);
      const qaReport = svgInteractionQa(parsed, animatedSvg);
      const svgFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, animatedSvg);
      const cssFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputCssPath, css);
      const waapiConfig = {
        animations: parsed.animations.map((animation, index) => ({
          id: animation.id ?? `animation_${index + 1}`,
          selector: animation.selector ?? `#svg-anim-${animation.id ?? index}`,
          keyframes: animation.type === "path_draw" || animation.type === "flow_line" ? [{ strokeDashoffset: "var(--svg-path-length,240)" }, { strokeDashoffset: 0 }] : animation.type === "rotate" ? [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }] : [{ opacity: 0.2, transform: "scale(.98)" }, { opacity: 1, transform: "scale(1)" }],
          options: { duration: animation.durationMs, delay: animation.delayMs, easing: animation.easing, fill: "both" }
        })),
        reducedMotion: parsed.reducedMotion
      };
      const waapiFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputWaapiPath, `${JSON.stringify(waapiConfig, null, 2)}\n`);
      const manifest = {
        sourcePath: parsed.svgPath,
        animatedSvgPath: svgFile.path,
        cssPath: cssFile.path,
        waapiConfigPath: waapiFile.path,
        animationCount: parsed.animations.length,
        interactionCount: parsed.interactions.length,
        features: Array.from(new Set([...parsed.animations.map((animation) => animation.type), ...parsed.interactions.map((interaction) => interaction.type), parsed.reducedMotion ? "reduced_motion" : "motion_allowed"])),
        accessibility: { reducedMotion: parsed.reducedMotion, keyboardFocusable: /tabindex="0"/.test(animatedSvg), ariaLabels: (animatedSvg.match(/aria-label=/g) ?? []).length },
        qaReport
      };
      const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: qaReport.pass, summary: `Created animated/interactive SVG with ${parsed.animations.length} animation(s) and ${parsed.interactions.length} interaction(s).`, jobId: parsed.projectId, artifacts: [svgFile.path, cssFile.path, waapiFile.path, manifestFile.path], structuredContent: { ...manifest, interactionManifestPath: manifestFile.path }, logs: [JSON.stringify({ animatedSvgPath: svgFile.path, animationCount: parsed.animations.length, interactionCount: parsed.interactions.length }, null, 2)], errors: qaReport.findings.filter((finding) => finding.severity !== "low").map((finding) => finding.message) };
    }
  },
  {
    definition: { name: "inspect_svg_accessibility", description: "Check SVG title/desc, aria labeling, decorative vs semantic roles, focusability, keyboard support, contrast hints, and interactive semantics.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, svgPath: { type: "string" }, interactive: { type: "boolean" }, outputPath: { type: "string" } }, required: ["projectId", "svgPath"], additionalProperties: false } },
    enabledByDefault: true,
    schema: inspectSvgAccessibilityInputSchema,
    handler: async (input, ctx) => {
      const parsed = inspectSvgAccessibilityInputSchema.parse(input);
      const svg = await readSvg(ctx, parsed.projectId, parsed.svgPath);
      const metrics = svgMetrics(svg);
      const findings = [];
      if (!metrics.title) findings.push({ severity: "high", message: "Missing <title>.", suggestedFix: "Add a concise title or mark decorative SVG aria-hidden." });
      if (!metrics.desc) findings.push({ severity: "medium", message: "Missing <desc>.", suggestedFix: "Add a description for complex diagrams and illustrations." });
      if (parsed.interactive && !/<a\b|tabindex=|role=["']button/i.test(svg)) findings.push({ severity: "medium", message: "Interactive SVG lacks focusable controls.", suggestedFix: "Add focusable hotspots with aria-labels." });
      const result = { svgPath: parsed.svgPath, findings, pass: findings.length === 0 };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(result, null, 2)}\n`);
      return { ok: findings.length === 0, summary: `SVG accessibility check found ${findings.length} finding(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: result, logs: [JSON.stringify(result, null, 2)], errors: findings.map((finding) => finding.message) };
    }
  },
  {
    definition: { name: "export_svg_project", description: "Export SVG project assets with raw/optimized SVG references, PDF-ready variants, preview/demo HTML, sprite/icon pack manifest, token JSON, accessibility metadata, README, and usage manifest.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, svgPaths: { type: "array", items: { type: "string" } }, includeOptimized: { type: "boolean" }, includeSprite: { type: "boolean" }, includeReadme: { type: "boolean" }, includePreviewHtml: { type: "boolean" }, includePdfReady: { type: "boolean" }, includeTokenJson: { type: "boolean" }, packageName: { type: "string" }, designTokens: { type: "object" }, licenseNotes: { type: "array" }, themeVariants: { type: "array" }, intendedUsage: { type: "array" }, outputPackageDir: { type: "string" }, outputManifestPath: { type: "string" }, outputReadmePath: { type: "string" }, outputSpritePath: { type: "string" }, outputPreviewHtmlPath: { type: "string" }, outputTokensPath: { type: "string" }, outputAccessibilityPath: { type: "string" } }, required: ["projectId", "svgPaths"], additionalProperties: false } },
    enabledByDefault: true,
    schema: exportSvgProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportSvgProjectInputSchema.parse(input);
      const artifacts: string[] = [];
      const exportedAssets = [];
      const accessibilityAssets = [];
      for (const [index, svgPath] of parsed.svgPaths.entries()) {
        const rawSvg = await readSvg(ctx, parsed.projectId, svgPath);
        const stem = svgExportStem(svgPath, index);
        const metrics = svgMetrics(rawSvg);
        const viewBox = parseViewBox(metrics.viewBox);
        let optimizedSvgPath: string | undefined;
        let optimizedSizeBytes: number | undefined;
        if (parsed.includeOptimized) {
          const optimized = optimizeSvgMarkup(rawSvg, {
            projectId: parsed.projectId,
            svgPath,
            svgString: rawSvg,
            mode: "balanced",
            precision: 2,
            removeMetadata: true,
            removeUnusedDefs: true,
            removeHiddenElements: true,
            normalizeStroke: true,
            preserveAccessibility: true,
            preserveIds: ["aria", "animation", "interactive"],
            outputPath: `${parsed.outputPackageDir}/optimized/${stem}.svg`,
            outputReportPath: `${parsed.outputPackageDir}/optimized/${stem}.report.json`
          });
          optimizedSvgPath = `${parsed.outputPackageDir}/optimized/${stem}.svg`;
          optimizedSizeBytes = optimized.afterSize;
          artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, optimizedSvgPath, `${optimized.optimized}\n`)).path);
        }
        const pdfReadySvgPath = parsed.includePdfReady ? `${parsed.outputPackageDir}/pdf-ready/${stem}.svg` : undefined;
        if (pdfReadySvgPath) {
          const pdfReadySvg = rawSvg.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/\s(?:on[a-z]+)=("[^"]*"|'[^']*')/gi, "");
          artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, pdfReadySvgPath, pdfReadySvg)).path);
        }
        exportedAssets.push({
          id: stem,
          svgPath,
          rawSvgPath: svgPath,
          optimizedSvgPath,
          pdfReadySvgPath,
          previewPlan: { png: `${parsed.outputPackageDir}/previews/${stem}.png`, webp: `${parsed.outputPackageDir}/previews/${stem}.webp`, status: "planned" },
          dimensions: { width: viewBox?.width, height: viewBox?.height, viewBox: metrics.viewBox },
          sizeBytes: Buffer.byteLength(rawSvg),
          optimizedSizeBytes,
          layerHints: Array.from(rawSvg.matchAll(/\bid=(["'])([^"']+)\1/g)).slice(0, 40).map((match) => match[2]),
          dependencies: Array.from(new Set(Array.from(rawSvg.matchAll(/url\(#([^)]+)\)/g)).map((match) => match[1]))),
          licenseNotes: parsed.licenseNotes,
          themeVariants: parsed.themeVariants,
          intendedUsage: parsed.intendedUsage
        });
        accessibilityAssets.push({
          svgPath,
          hasTitle: metrics.title,
          hasDesc: metrics.desc,
          hasAriaLabel: /aria-label=|aria-labelledby=/i.test(rawSvg),
          focusableElements: (rawSvg.match(/tabindex=|<a\b|role=["']button/gi) ?? []).length,
          recommendedAlt: metrics.title ? undefined : `Add a concise title for ${stem}.`
        });
      }
      let spritePath: string | undefined;
      if (parsed.includeSprite) {
        const symbols = await Promise.all(parsed.svgPaths.map(async (svgPath, index) => {
          const svg = await readSvg(ctx, parsed.projectId, svgPath);
          return `<symbol id="${xml(svgExportStem(svgPath, index))}" viewBox="${xml(svgMetrics(svg).viewBox ?? "0 0 24 24")}">${svgInnerMarkup(svg)}</symbol>`;
        }));
        spritePath = parsed.outputSpritePath;
        artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, spritePath, `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n${symbols.join("\n")}\n</svg>\n`)).path);
      }
      let tokenPath: string | undefined;
      if (parsed.includeTokenJson) {
        tokenPath = parsed.outputTokensPath;
        const tokenPayload = { packageName: parsed.packageName, themeVariants: parsed.themeVariants, designTokens: parsed.designTokens, generatedFromSvgCount: parsed.svgPaths.length };
        artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, tokenPath, `${JSON.stringify(tokenPayload, null, 2)}\n`)).path);
      }
      const accessibilityFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputAccessibilityPath, `${JSON.stringify({ assets: accessibilityAssets, checks: ["title", "desc", "aria_label", "focusable_interactions"] }, null, 2)}\n`);
      artifacts.push(accessibilityFile.path);
      let previewHtmlPath: string | undefined;
      if (parsed.includePreviewHtml) {
        previewHtmlPath = parsed.outputPreviewHtmlPath;
        artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, previewHtmlPath, exportPackagePreviewHtml(parsed, exportedAssets))).path);
      }
      const manifest = {
        packageName: parsed.packageName,
        assets: exportedAssets,
        previewFormats: ["png", "webp"],
        previewPlan: { status: "planned", note: "PNG/WebP previews require a renderer step; paths are reserved in this manifest." },
        spritePath,
        tokenPath,
        accessibilityMetadataPath: parsed.outputAccessibilityPath,
        previewHtmlPath,
        readmePath: parsed.includeReadme ? parsed.outputReadmePath : undefined,
        themeVariants: parsed.themeVariants,
        intendedUsage: parsed.intendedUsage,
        licenseNotes: parsed.licenseNotes,
        notes: ["Raw SVG references are preserved for editing.", "Optimized SVG and PDF-ready variants are written when enabled.", "Preview raster paths are planned for downstream renderers."]
      };
      artifacts.unshift((await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`)).path);
      if (parsed.includeReadme) {
        artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReadmePath, exportPackageReadme({ packageName: parsed.packageName, assets: exportedAssets, spritePath, previewHtmlPath, tokenPath, licenseNotes: parsed.licenseNotes, intendedUsage: parsed.intendedUsage }))).path);
      }
      return { ok: true, summary: `Exported production SVG package for ${exportedAssets.length} asset(s).`, jobId: parsed.projectId, artifacts, structuredContent: { ...manifest, manifestPath: parsed.outputManifestPath, readmePath: parsed.includeReadme ? parsed.outputReadmePath : undefined }, logs: [JSON.stringify(manifest, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "process_svg_revision_feedback", description: "Convert human SVG feedback into a structured revision plan, safe SVG patch, before/after preview, and QA report while preserving IDs, accessibility metadata, animation hooks, and design tokens.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, feedback: { type: "string" }, svgPath: { type: "string" }, svgString: { type: "string" }, designTokens: { type: "object" }, screenshotPath: { type: "string" }, applyPatch: { type: "boolean" }, outputPath: { type: "string" }, outputPatchedSvgPath: { type: "string" }, outputPreviewPath: { type: "string" }, outputQaPath: { type: "string" } }, required: ["projectId", "feedback"], additionalProperties: false } },
    enabledByDefault: true,
    schema: processSvgRevisionFeedbackInputSchema,
    handler: async (input, ctx) => {
      const parsed = processSvgRevisionFeedbackInputSchema.parse(input);
      const sourceSvg = parsed.svgString ?? (parsed.svgPath ? await readSvg(ctx, parsed.projectId, parsed.svgPath) : undefined);
      const actions = buildSvgRevisionActions(parsed.feedback);
      const safePatch = sourceSvg && parsed.applyPatch ? applySafeSvgRevisionPatch(sourceSvg, parsed.feedback, parsed.designTokens) : undefined;
      const patchedSvg = safePatch?.patchedSvg;
      const qaReport = svgRevisionQa(sourceSvg, patchedSvg, actions, parsed.designTokens);
      const artifacts: string[] = [];
      const plan = {
        svgPath: parsed.svgPath,
        screenshotPath: parsed.screenshotPath,
        feedback: parsed.feedback,
        actions,
        safePatches: safePatch?.patches ?? [],
        patchedSvgPath: patchedSvg ? parsed.outputPatchedSvgPath : undefined,
        beforeAfterPreviewPath: patchedSvg ? parsed.outputPreviewPath : undefined,
        qaReportPath: parsed.outputQaPath,
        preservation: {
          preserveIds: true,
          preserveAccessibilityMetadata: true,
          preserveAnimationHooks: true,
          designTokenKeys: Object.keys(parsed.designTokens)
        },
        acceptanceChecks: ["No text overflow", "No overlapping primary elements", "IDs and animation/interaction hooks preserved", "Pass accessibility and visual QA", "Before/after preview generated when source SVG is provided"]
      };
      artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(plan, null, 2)}\n`)).path);
      if (patchedSvg && sourceSvg) {
        artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPatchedSvgPath, patchedSvg)).path);
        artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPreviewPath, svgRevisionPreviewHtml(parsed.feedback, sourceSvg, patchedSvg))).path);
      }
      artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputQaPath, `${JSON.stringify(qaReport, null, 2)}\n`)).path);
      return { ok: qaReport.pass, summary: `Created ${actions.length} SVG revision action(s) and ${safePatch?.patches.length ?? 0} safe patch(es).`, jobId: parsed.projectId, artifacts, structuredContent: { ...plan, qaReport }, logs: [JSON.stringify(plan, null, 2)], errors: qaReport.findings.filter((finding) => finding.severity !== "low").map((finding) => finding.message) };
    }
  }
];
