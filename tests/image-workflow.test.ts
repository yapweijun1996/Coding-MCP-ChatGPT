import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, readProjectFile, writeProjectFile } from "../src/projects/store.js";
import { skillRegistry } from "../src/skills/registry.js";
import type { ToolContext } from "../src/mcp/types.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "image-workflow-test"
  };
}

test("image workflow tools create briefs, specs, QA reports, and placeholder SVG assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "image-workflow-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Image project", createdByClientId: "designer" });
    await writeProjectFile(ctx.projectRoot, project.id, "assets/logo.svg", [
      "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"128\" height=\"64\" viewBox=\"0 0 128 64\">",
      "<title>Logo</title>",
      "<rect width=\"128\" height=\"64\" fill=\"#0f172a\"/>",
      "</svg>"
    ].join("\n"));

    const brief = getToolModule("create_image_workflow_brief");
    const inspect = getToolModule("inspect_project_image_assets");
    const sprite = getToolModule("create_sprite_sheet_spec");
    const icons = getToolModule("create_icon_manifest");
    const style = getToolModule("check_image_style_consistency");
    const placeholder = getToolModule("create_placeholder_svg_asset");
    for (const [name, tool] of Object.entries({ brief, inspect, sprite, icons, style, placeholder })) assert.ok(tool, `${name} registered`);

    const briefResult = await brief!.handler({
      projectId: project.id,
      title: "Launch visuals",
      purpose: "Prepare hero, icon, sprite, and background-removal handoff assets.",
      style: "Crisp product UI with high contrast.",
      targetAssets: [
        { name: "Hero", kind: "hero", operation: "generate", width: 1440, height: 900, prompt: "Abstract dashboard scene" },
        { name: "Logo cutout", kind: "logo", operation: "remove_background", referencePaths: ["assets/logo.svg"] }
      ]
    }, ctx);
    assert.equal(briefResult.ok, true);
    assert.ok(briefResult.artifacts.includes("image-workflow/brief.json"));
    const briefFile = await readProjectFile(ctx.projectRoot, project.id, "image-workflow/brief.json");
    assert.match(briefFile, /remove_background/);

    const placeholderResult = await placeholder!.handler({
      projectId: project.id,
      outputPath: "assets/app-icon.svg",
      label: "AI",
      width: 192,
      height: 192,
      foreground: "#2563eb",
      background: "#ffffff",
      shape: "circle"
    }, ctx);
    assert.equal(placeholderResult.ok, true);
    const svg = await readProjectFile(ctx.projectRoot, project.id, "assets/app-icon.svg");
    assert.match(svg, /<svg/);
    assert.match(svg, /AI/);

    const inspected = await inspect!.handler({ projectId: project.id, paths: ["assets/logo.svg", "assets/app-icon.svg", "assets/missing.png"] }, ctx);
    const inspectedPayload = inspected.structuredContent as { imageCount: number; missing: string[]; assets: Array<{ path: string; dimensions: { width?: number; height?: number } }> };
    assert.equal(inspectedPayload.imageCount, 2);
    assert.deepEqual(inspectedPayload.missing, ["assets/missing.png"]);
    assert.equal(inspectedPayload.assets.some((asset) => asset.path === "assets/logo.svg" && asset.dimensions.width === 128 && asset.dimensions.height === 64), true);

    const spriteResult = await sprite!.handler({
      projectId: project.id,
      padding: 2,
      frames: [
        { name: "idle", sourcePath: "assets/app-icon.svg", width: 32, height: 32 },
        { name: "active", sourcePath: "assets/logo.svg", width: 32, height: 32 }
      ]
    }, ctx);
    const spritePayload = spriteResult.structuredContent as { width: number; height: number; frames: Array<{ x: number; y: number }> };
    assert.equal(spritePayload.width, 66);
    assert.equal(spritePayload.height, 32);
    assert.equal(spritePayload.frames[1].x, 34);
    assert.ok(spriteResult.artifacts.includes("image-workflow/sprite-sheet.json"));

    const iconResult = await icons!.handler({
      projectId: project.id,
      appName: "Image Demo",
      icons: [{ path: "assets/app-icon.svg", size: 192, purpose: "app" }]
    }, ctx);
    const iconPayload = iconResult.structuredContent as { recommendations: string[] };
    assert.equal(iconPayload.recommendations.some((item) => item.includes("512x512")), true);
    assert.equal(iconPayload.recommendations.some((item) => item.includes("maskable")), true);

    const styleResult = await style!.handler({
      projectId: project.id,
      assetPaths: ["assets/logo.svg", "assets/app-icon.svg"],
      styleTokens: { palette: ["#0f172a", "#2563eb"], stroke: "solid" },
      writeToProject: true
    }, ctx);
    assert.equal(styleResult.ok, true);
    assert.ok(styleResult.artifacts.includes("image-workflow/style-consistency-report.json"));
    const report = await readProjectFile(ctx.projectRoot, project.id, "image-workflow/style-consistency-report.json");
    assert.match(report, /palette/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SVG design studio tools generate, QA, optimize, animate, interact, and export SVG assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "svg-design-studio-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "SVG Studio", createdByClientId: "designer" });
    const scene = getToolModule("generate_svg_scene");
    const layout = getToolModule("layout_svg_elements");
    const typography = getToolModule("fit_svg_typography");
    const visualQa = getToolModule("inspect_svg_visual_quality");
    const tokens = getToolModule("apply_svg_design_tokens");
    const optimize = getToolModule("optimize_svg_paths");
    const diagram = getToolModule("generate_svg_diagram");
    const chart = getToolModule("generate_svg_chart");
    const iso = getToolModule("generate_isometric_svg");
    const icons = getToolModule("generate_svg_icon_set");
    const animate = getToolModule("animate_svg_scene");
    const interact = getToolModule("add_svg_interactivity");
    const animateInteract = getToolModule("animate_and_interact_svg");
    const a11y = getToolModule("inspect_svg_accessibility");
    const exportProject = getToolModule("export_svg_project");
    const revision = getToolModule("process_svg_revision_feedback");
    for (const [name, tool] of Object.entries({ scene, layout, typography, visualQa, tokens, optimize, diagram, chart, iso, icons, animate, interact, animateInteract, a11y, exportProject, revision })) assert.ok(tool, `${name} registered`);

    const sceneResult = await scene!.handler({
      projectId: project.id,
      title: "ERP Workflow",
      canvas: { width: 1200, height: 800 },
      style: "enterprise_erp_admin",
      sceneType: "warehouse_process_illustration",
      elements: [
        "dashboard_screen",
        "warehouse_boxes",
        "workflow_arrows",
        "module_cards",
        "status_badges"
      ]
    }, ctx);
    assert.equal(sceneResult.ok, true);
    const scenePayload = sceneResult.structuredContent as { svgPath: string; svgText: string; sceneManifest: { elementCount: number; layers: string[]; advancedFeatures: string[]; validation: { validXmlLikely: boolean }; style: string; sceneType: string }; componentList: Array<{ id: string; type: string }>; viewBox: string; warnings: string[] };
    assert.equal(scenePayload.svgPath, "svg-design/scene.svg");
    assert.equal(scenePayload.sceneManifest.elementCount, 5);
    assert.equal(scenePayload.sceneManifest.style, "enterprise_erp_admin");
    assert.equal(scenePayload.sceneManifest.sceneType, "warehouse_process_illustration");
    assert.equal(scenePayload.viewBox, "0 0 1200 800");
    assert.ok(scenePayload.sceneManifest.layers.includes("defs"));
    assert.ok(scenePayload.sceneManifest.advancedFeatures.includes("symbol"));
    assert.ok(scenePayload.sceneManifest.advancedFeatures.includes("clipPath"));
    assert.ok(scenePayload.sceneManifest.validation.validXmlLikely);
    assert.ok(scenePayload.componentList.some((component) => component.id === "dashboard_screen"));
    assert.deepEqual(scenePayload.warnings, []);
    const generatedSceneSvg = await readProjectFile(ctx.projectRoot, project.id, "svg-design/scene.svg");
    assert.match(generatedSceneSvg, /<svg/);
    assert.match(generatedSceneSvg, /<symbol id="moduleNode"/);
    assert.match(generatedSceneSvg, /<clipPath id="canvasClip"/);
    assert.match(generatedSceneSvg, /<mask id="softMask"/);
    assert.match(generatedSceneSvg, /<pattern id="grid"/);
    assert.match(scenePayload.svgText, /warehouse boxes/i);

    const layoutResult = await layout!.handler({
      projectId: project.id,
      layoutType: "workflow",
      canvas: { width: 1400, height: 900 },
      direction: "left_to_right",
      nodes: [
        { id: "sales_order", label: "Sales Order", group: "sales" },
        { id: "inventory", label: "Inventory Check", group: "warehouse" },
        { id: "delivery", label: "Delivery Order", group: "warehouse" }
      ],
      edges: [["sales_order", "inventory"], ["inventory", "delivery"]],
      constraints: { minNodeGap: 32, avoidOverlap: true, routeConnectors: true, responsive: true }
    }, ctx);
    assert.equal(layoutResult.ok, true);
    const layoutPayload = layoutResult.structuredContent as { updatedSvgPath: string; positions: Record<string, { x: number; y: number; width: number; height: number }>; positionedElements: unknown[]; connectors: unknown[]; connectorRoutes: Array<{ route: string; points: number[][] }>; viewBox: string; layoutScore: number; mobileVariant: { layoutType: string; width: number; positions: unknown[] }; warnings: string[]; groups: string[] };
    assert.equal(layoutPayload.updatedSvgPath, "svg-design/layout.svg");
    assert.equal(layoutPayload.positionedElements.length, 3);
    assert.equal(layoutPayload.connectors.length, 2);
    assert.equal(layoutPayload.connectorRoutes.length, 2);
    assert.equal(layoutPayload.connectorRoutes[0].route, "orthogonal");
    assert.equal(layoutPayload.connectorRoutes[0].points.length, 4);
    assert.equal(layoutPayload.positions.sales_order.x, 32);
    assert.ok(layoutPayload.positions.inventory.x > layoutPayload.positions.sales_order.x);
    assert.equal(layoutPayload.viewBox, "0 0 1400 900");
    assert.ok(layoutPayload.layoutScore >= 90);
    assert.equal(layoutPayload.mobileVariant.layoutType, "mobile_stack");
    assert.equal(layoutPayload.mobileVariant.width, 390);
    assert.deepEqual(layoutPayload.warnings, []);
    assert.ok(layoutPayload.groups.includes("warehouse"));
    assert.match(await readProjectFile(ctx.projectRoot, project.id, "svg-design/layout.svg"), /<polyline/);

    const typographyResult = await typography!.handler({
      projectId: project.id,
      svgPath: "svg-design/layout.svg",
      textBoxes: [{
        id: "node_sales",
        text: "Sales Order / 销售订单",
        box: { x: 100, y: 80, width: 180, height: 72 },
        minFontSize: 10,
        maxFontSize: 16,
        wrap: true
      }],
      languageHints: ["en", "zh"],
      style: "erp_admin"
    }, ctx);
    assert.equal(typographyResult.ok, true);
    const typographyPayload = typographyResult.structuredContent as { updatedSvgPath: string; textLayoutReport: Array<{ id: string; lines: string[]; fontSize: number; fitsSafely: boolean; startY: number }>; overflowWarnings: string[]; fontSizeAdjustments: Array<{ id: string; from: number; to: number }>; unfitLabels: string[]; fittedBlocks: Array<{ lines: string[]; fontSize: number }> };
    assert.equal(typographyPayload.updatedSvgPath, "svg-design/typography-fit.svg");
    assert.equal(typographyPayload.textLayoutReport[0].id, "node_sales");
    assert.equal(typographyPayload.textLayoutReport[0].fitsSafely, true);
    assert.ok(typographyPayload.textLayoutReport[0].startY > 80);
    assert.deepEqual(typographyPayload.overflowWarnings, []);
    assert.deepEqual(typographyPayload.unfitLabels, []);
    assert.ok(typographyPayload.fittedBlocks[0].fontSize >= 12);
    assert.ok(typographyPayload.fittedBlocks[0].lines.length <= 2);
    assert.match(await readProjectFile(ctx.projectRoot, project.id, "svg-design/typography-fit.svg"), /typography-fit-layer/);

    const visualResult = await visualQa!.handler({
      projectId: project.id,
      svgPath: "svg-design/scene.svg",
      expectedStyle: "enterprise_erp_admin",
      previewSizes: [{ width: 1200, height: 800 }, { width: 390, height: 844 }],
      checkAccessibility: true
    }, ctx);
    assert.equal(visualResult.ok, true);
    const visualPayload = visualResult.structuredContent as { metrics: { viewBox?: string }; findings: unknown[]; qualityScore: number; mobileReadabilityScore: number; contrastReport: { checkedPairs: number }; alignmentReport: { checkedElements: number }; styleConsistencyReport: { expectedStyle?: string }; suggestedFixes: string[]; severity: string };
    assert.equal(visualPayload.metrics.viewBox, "0 0 1200 800");
    assert.deepEqual(visualPayload.findings, []);
    assert.equal(visualPayload.severity, "none");
    assert.equal(visualPayload.qualityScore, 100);
    assert.ok(visualPayload.mobileReadabilityScore >= 80);
    assert.ok(visualPayload.contrastReport.checkedPairs >= 1);
    assert.ok(visualPayload.alignmentReport.checkedElements >= 1);
    assert.equal(visualPayload.styleConsistencyReport.expectedStyle, "enterprise_erp_admin");
    assert.deepEqual(visualPayload.suggestedFixes, []);

    const badVisualResult = await visualQa!.handler({
      projectId: project.id,
      svgString: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120"><rect x="180" y="90" width="80" height="60" fill="#ffffff" stroke="#111111" stroke-width="1" rx="2"/><rect x="15" y="18" width="60" height="24" fill="#ffffff" stroke="#111111" stroke-width="8" rx="28"/><text x="20" y="36" font-size="7" fill="#eeeeee">Tiny low contrast label</text></svg>`,
      expectedStyle: "enterprise_erp_admin",
      previewSizes: [{ width: 200, height: 120 }, { width: 390, height: 844 }],
      checkAccessibility: true
    }, ctx);
    assert.equal(badVisualResult.ok, false);
    const badVisualPayload = badVisualResult.structuredContent as { qualityScore: number; findings: Array<{ category: string; severity: string }>; severity: string; suggestedFixes: string[]; contrastReport: { lowContrastPairs: unknown[] }; styleConsistencyReport: { strokeWidths: number[]; cornerRadii: number[] } };
    assert.equal(badVisualPayload.severity, "high");
    assert.ok(badVisualPayload.qualityScore < 100);
    assert.ok(badVisualPayload.findings.some((finding) => finding.category === "clipping" && finding.severity === "high"));
    assert.ok(badVisualPayload.findings.some((finding) => finding.category === "typography"));
    assert.ok(badVisualPayload.findings.some((finding) => finding.category === "accessibility"));
    assert.ok(badVisualPayload.contrastReport.lowContrastPairs.length >= 1);
    assert.ok(badVisualPayload.styleConsistencyReport.strokeWidths.includes(8));
    assert.ok(badVisualPayload.styleConsistencyReport.cornerRadii.includes(28));
    assert.ok(badVisualPayload.suggestedFixes.some((fix) => fix.includes("fit_svg_typography")));

    const tokenResult = await tokens!.handler({
      projectId: project.id,
      svgPath: "svg-design/scene.svg",
      tokenProfile: "erp_admin_compact",
      targetTheme: "dark",
      preserveSemanticColors: true,
      theme: { palette: ["#111827", "#2563eb", "#14b8a6"], background: "#ffffff", text: "#111827", strokeWidth: 2, radius: 8, fontFamily: "Inter" }
    }, ctx);
    assert.equal(tokenResult.ok, true);
    assert.ok(tokenResult.artifacts.includes("svg-design/tokenized.svg"));
    assert.ok(tokenResult.artifacts.includes("svg-design/tokens.json"));
    const tokenPayload = tokenResult.structuredContent as { updatedSvgPath: string; tokenProfile: string; targetTheme: string; tokenMappingReport: { colors: Array<{ from: string; to: string; role: string }>; strokeWidth: number; cornerRadius: number; spacingScale: number[]; typographyScale: Record<string, number>; shadow: string; iconGrid: number; connectorStyle: string; gradientStyle: string[] }; contrastReport: { checkedPairs: number; lowContrastPairs: unknown[] }; unmappedStyles: string[]; warnings: string[] };
    assert.equal(tokenPayload.updatedSvgPath, "svg-design/tokenized.svg");
    assert.equal(tokenPayload.tokenProfile, "erp_admin_compact");
    assert.equal(tokenPayload.targetTheme, "dark");
    assert.ok(tokenPayload.tokenMappingReport.colors.some((mapping) => mapping.role === "text"));
    assert.equal(tokenPayload.tokenMappingReport.strokeWidth, 2);
    assert.equal(tokenPayload.tokenMappingReport.cornerRadius, 8);
    assert.ok(tokenPayload.tokenMappingReport.spacingScale.includes(16));
    assert.equal(tokenPayload.tokenMappingReport.typographyScale.body, 14);
    assert.ok(tokenPayload.tokenMappingReport.shadow.includes("rgba"));
    assert.equal(tokenPayload.tokenMappingReport.iconGrid, 24);
    assert.ok(tokenPayload.tokenMappingReport.connectorStyle.includes("#"));
    assert.equal(tokenPayload.tokenMappingReport.gradientStyle.length, 2);
    assert.ok(tokenPayload.contrastReport.checkedPairs >= 1);
    assert.deepEqual(tokenPayload.contrastReport.lowContrastPairs, []);
    assert.deepEqual(tokenPayload.unmappedStyles, []);
    assert.deepEqual(tokenPayload.warnings, []);
    const tokenizedSvg = await readProjectFile(ctx.projectRoot, project.id, "svg-design/tokenized.svg");
    assert.match(tokenizedSvg, /id="svg-design-tokens"/);
    assert.match(tokenizedSvg, /--svg-bg:#0f172a/);
    assert.match(tokenizedSvg, /--svg-success:#22c55e/);

    const optimizeResult = await optimize!.handler({ projectId: project.id, svgPath: "svg-design/tokenized.svg" }, ctx);
    assert.equal(optimizeResult.ok, true);
    const optimizePayload = optimizeResult.structuredContent as { optimizedPath: string; beforeBytes: number; afterBytes: number; changes: string[] };
    assert.equal(optimizePayload.optimizedPath, "svg-design/optimized.svg");
    assert.ok(optimizePayload.afterBytes <= optimizePayload.beforeBytes);
    assert.ok(optimizePayload.changes.includes("Collapsed whitespace"));

    await writeProjectFile(ctx.projectRoot, project.id, "svg-design/messy.svg", [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100.0000 100.0000" aria-labelledby="title-main desc-main">`,
      `<!-- remove me --><title id="title-main">Messy Icon</title><desc id="desc-main">Keeps accessibility text.</desc>`,
      `<metadata>{"tool":"design-export"}</metadata>`,
      `<defs><linearGradient id="keep-animation-flow"><stop offset="0%" stop-color="#fff"/></linearGradient><linearGradient id="unusedGrad"><stop offset="0%" stop-color="#000"/></linearGradient><linearGradient id="dupA"><stop offset="100%" stop-color="#fff"/></linearGradient><linearGradient id="dupB"><stop offset="100%" stop-color="#fff"/></linearGradient></defs>`,
      `<g></g><rect id="hidden-rect" display="none" x="1" y="1" width="8" height="8"/>`,
      `<path d="M 5.12345 5.98765 L 12.55555 12.44444" fill="none" stroke="url(#dupA)"/>`,
      `<path id="interactive-path" d="M 10.12345,10.98765   L 80.55555,10.44444 L 80.11111,80.99999" fill="none" stroke="url(#dupB)" stroke-linecap="square" stroke-linejoin="miter" stroke-miterlimit="10.5"/>`,
      `<path d="M 20.12345 20.6789 L 40.98765 20.12345 L 40.22222 40.99999" fill="#2563eb"/>`,
      `</svg>`
    ].join("\n"));
    const messyOptimizeResult = await optimize!.handler({
      projectId: project.id,
      svgPath: "svg-design/messy.svg",
      mode: "balanced",
      precision: 2,
      preserveIds: ["aria", "animation", "interactive"]
    }, ctx);
    assert.equal(messyOptimizeResult.ok, true);
    const messyPayload = messyOptimizeResult.structuredContent as {
      optimizedSvgPath: string;
      beforeSizeBytes: number;
      afterSizeBytes: number;
      reductionPercent: number;
      changedElements: string[];
      riskWarnings: string[];
      preservedIds: string[];
      checks: { removedMetadata: boolean; removedHiddenElements: boolean; optimizedPathData: boolean; normalizedStroke: boolean; removedUnusedDefs: boolean };
    };
    assert.equal(messyPayload.optimizedSvgPath, "svg-design/optimized.svg");
    assert.ok(messyPayload.afterSizeBytes < messyPayload.beforeSizeBytes);
    assert.ok(messyPayload.reductionPercent > 0);
    assert.ok(messyPayload.changedElements.some((change) => change.startsWith("removed-unused-def:unusedGrad")));
    assert.ok(messyPayload.changedElements.some((change) => change.startsWith("deduplicated-def:dupB->dupA")));
    assert.equal(messyPayload.checks.removedMetadata, true);
    assert.equal(messyPayload.checks.removedHiddenElements, true);
    assert.equal(messyPayload.checks.optimizedPathData, true);
    assert.equal(messyPayload.checks.normalizedStroke, true);
    assert.equal(messyPayload.checks.removedUnusedDefs, true);
    assert.ok(messyPayload.riskWarnings.some((warning) => warning.includes("Filled path may be open")));
    assert.ok(messyPayload.preservedIds.includes("title-main"));
    assert.ok(messyPayload.preservedIds.includes("desc-main"));
    assert.ok(messyPayload.preservedIds.includes("keep-animation-flow"));
    const messySvg = await readProjectFile(ctx.projectRoot, project.id, messyPayload.optimizedSvgPath);
    assert.doesNotMatch(messySvg, /metadata|remove me|unusedGrad|hidden-rect|dupB/);
    assert.match(messySvg, /stroke-linecap="round"/);
    assert.match(messySvg, /M10\.12,10\.99L80\.56,10\.44L80\.11,81/);

    const diagramResult = await diagram!.handler({
      projectId: project.id,
      title: "API Flow",
      diagramType: "api_flow",
      nodes: [{ id: "ui", label: "Admin UI" }, { id: "api", label: "API" }, { id: "db", label: "DB" }],
      edges: [{ from: "ui", to: "api" }, { from: "api", to: "db" }]
    }, ctx);
    assert.equal(diagramResult.ok, true);
    assert.ok(diagramResult.artifacts.includes("svg-design/diagram.svg"));

    const richDiagramResult = await diagram!.handler({
      projectId: project.id,
      title: "ERP Order Flow",
      diagramType: "business_process",
      mermaidSpec: [
        "flowchart LR",
        "lane Sales",
        "sales[Sales Order] --> inventory[Inventory Check]: reserve stock",
        "lane Warehouse",
        "inventory --> pick[Pick Pack Ship]: release",
        "pick --> invoice[Invoice]: confirm"
      ].join("\n"),
      swimlanes: [{ id: "Sales", label: "Sales" }, { id: "Warehouse", label: "Warehouse" }],
      legend: [{ label: "Process step", color: "#2563eb" }],
      callouts: [{ nodeId: "inventory", text: "Stock gate" }],
      canvas: { width: 1280, height: 720 },
      includePngPreview: true
    }, ctx);
    assert.equal(richDiagramResult.ok, true);
    const richDiagramPayload = richDiagramResult.structuredContent as {
      svgPath: string;
      diagramManifestPath: string;
      previewPlan: { status: string; outputPath: string };
      viewBox: string;
      nodeCount: number;
      edgeCount: number;
      inputSource: string;
      swimlanes: Array<{ id: string }>;
      legend: unknown[];
      callouts: unknown[];
      connectorRoutes: Array<{ route: string; points: number[][] }>;
      accessibility: { hasTitleDesc: boolean };
      warnings: string[];
    };
    assert.equal(richDiagramPayload.svgPath, "svg-design/diagram.svg");
    assert.equal(richDiagramPayload.diagramManifestPath, "svg-design/diagram-manifest.json");
    assert.equal(richDiagramPayload.previewPlan.status, "planned");
    assert.equal(richDiagramPayload.previewPlan.outputPath, "svg-design/diagram-preview.png");
    assert.equal(richDiagramPayload.viewBox, "0 0 1280 720");
    assert.equal(richDiagramPayload.inputSource, "mermaid_like_spec");
    assert.equal(richDiagramPayload.nodeCount, 4);
    assert.equal(richDiagramPayload.edgeCount, 3);
    assert.ok(richDiagramPayload.swimlanes.some((lane) => lane.id === "Sales"));
    assert.equal(richDiagramPayload.legend.length, 1);
    assert.equal(richDiagramPayload.callouts.length, 1);
    assert.ok(richDiagramPayload.connectorRoutes.every((route) => route.route === "orthogonal"));
    assert.ok(richDiagramPayload.connectorRoutes.every((route) => route.points.length === 4));
    assert.equal(richDiagramPayload.accessibility.hasTitleDesc, true);
    assert.deepEqual(richDiagramPayload.warnings, []);
    const richDiagramSvg = await readProjectFile(ctx.projectRoot, project.id, richDiagramPayload.svgPath);
    assert.match(richDiagramSvg, /aria-labelledby="title desc"/);
    assert.match(richDiagramSvg, /lane-Sales/);
    assert.match(richDiagramSvg, /diagram-legend/);
    assert.match(richDiagramSvg, /Stock gate/);
    const richDiagramManifest = await readProjectFile(ctx.projectRoot, project.id, richDiagramPayload.diagramManifestPath);
    assert.match(richDiagramManifest, /connectorRoutes/);

    const chartResult = await chart!.handler({
      projectId: project.id,
      title: "Orders",
      chartType: "bar",
      data: [{ label: "Jan", value: 10 }, { label: "Feb", value: 18 }]
    }, ctx);
    assert.equal(chartResult.ok, true);
    const chartPayload = chartResult.structuredContent as { rowCount: number; yMax: number };
    assert.equal(chartPayload.rowCount, 2);
    assert.equal(chartPayload.yMax, 18);

    const richChartResult = await chart!.handler({
      projectId: project.id,
      title: "Quarterly Revenue",
      chartType: "stacked_bar",
      csvString: "quarter,software,services,hardware\nQ1,120,40,20\nQ2,140,55,30\nQ3,160,65,38\nQ4 with a very long label,210,80,45\n",
      xField: "quarter",
      yField: "software",
      seriesFields: ["software", "services", "hardware"],
      annotations: [{ label: "Q4 acceleration", x: "Q4", note: "services expanded" }],
      includeLegend: true,
      includePngPreview: true,
      canvas: { width: 1100, height: 620 }
    }, ctx);
    assert.equal(richChartResult.ok, true);
    const richChartPayload = richChartResult.structuredContent as {
      svgPath: string;
      chartManifestPath: string;
      previewPlan: { status: string; outputPath: string };
      inputSource: string;
      chartType: string;
      rowCount: number;
      seriesFields: string[];
      viewBox: string;
      accessibility: { hasTitleDesc: boolean };
      chartIssues: Array<{ category: string; severity: string }>;
      warnings: string[];
    };
    assert.equal(richChartPayload.svgPath, "svg-design/chart.svg");
    assert.equal(richChartPayload.chartManifestPath, "svg-design/chart-manifest.json");
    assert.equal(richChartPayload.previewPlan.status, "planned");
    assert.equal(richChartPayload.previewPlan.outputPath, "svg-design/chart-preview.png");
    assert.equal(richChartPayload.inputSource, "csv");
    assert.equal(richChartPayload.chartType, "stacked_bar");
    assert.equal(richChartPayload.rowCount, 4);
    assert.deepEqual(richChartPayload.seriesFields, ["software", "services", "hardware"]);
    assert.equal(richChartPayload.viewBox, "0 0 1100 620");
    assert.equal(richChartPayload.accessibility.hasTitleDesc, true);
    assert.ok(richChartPayload.chartIssues.some((issue) => issue.category === "label_readability"));
    assert.ok(richChartPayload.warnings.some((warning) => warning.includes("axis labels")));
    const richChartSvg = await readProjectFile(ctx.projectRoot, project.id, richChartPayload.svgPath);
    assert.match(richChartSvg, /aria-labelledby="title desc"/);
    assert.match(richChartSvg, /chart-legend/);
    assert.match(richChartSvg, /Q4 acceleration/);
    const richChartManifest = await readProjectFile(ctx.projectRoot, project.id, richChartPayload.chartManifestPath);
    assert.match(richChartManifest, /chartIssues/);

    const badChartResult = await chart!.handler({
      projectId: project.id,
      title: "Bad Donut",
      chartType: "donut",
      jsonData: [{ label: "loss", value: -5 }, { label: "gain", value: 10 }],
      xField: "label",
      yField: "value"
    }, ctx);
    assert.equal(badChartResult.ok, false);
    const badChartPayload = badChartResult.structuredContent as { chartIssues: Array<{ category: string; severity: string }> };
    assert.ok(badChartPayload.chartIssues.some((issue) => issue.category === "bad_chart_choice" && issue.severity === "high"));

    const isoResult = await iso!.handler({ projectId: project.id, title: "Warehouse", scene: "warehouse", objects: ["dock", "scanner", "pallet"] }, ctx);
    assert.equal(isoResult.ok, true);
    assert.ok(isoResult.artifacts.includes("svg-design/isometric.svg"));
    assert.ok(isoResult.artifacts.includes("svg-design/isometric-optimized.svg"));
    assert.ok(isoResult.artifacts.includes("svg-design/isometric-manifest.json"));

    const richIsoResult = await iso!.handler({
      projectId: project.id,
      title: "ERP Warehouse Operations",
      prompt: "ERP warehouse inventory flow with people, shelves, boxes, vehicle, dashboard and arrows",
      scene: "inventory_flow",
      sceneJson: {
        primitives: [
          { type: "platform", label: "Operations floor", x: 1, y: 1, layer: "base" },
          { type: "warehouse_shelf", label: "Stock shelf", x: 0, y: 1, layer: "objects" },
          { type: "box", label: "Inventory boxes", x: 1, y: 1, layer: "objects" },
          { type: "screen", label: "ERP dashboard", x: 2, y: 0, layer: "objects" },
          { type: "people", label: "Operator", x: 2, y: 1, layer: "objects" },
          { type: "vehicle", label: "Delivery cart", x: 3, y: 1, layer: "objects" },
          { type: "arrow", label: "Inventory flow", x: 2, y: 2, layer: "annotation" }
        ],
        labels: [{ text: "Real-time stock movement", x: 52, y: 112 }]
      },
      canvas: { width: 1280, height: 760 },
      includePngPreview: true
    }, ctx);
    assert.equal(richIsoResult.ok, true);
    const richIsoPayload = richIsoResult.structuredContent as {
      svgPath: string;
      optimizedSvgPath: string;
      sceneManifestPath: string;
      previewPlan: { status: string; outputPath: string };
      viewBox: string;
      perspective: string;
      primitiveCount: number;
      scenePrimitives: string[];
      layerMetadata: Array<{ id: string; primitiveCount: number }>;
      themeTokens: { palette: string[] };
      styleConsistency: { perspective: string; shadows: string };
      optimization: { afterSizeBytes: number; beforeSizeBytes: number };
    };
    assert.equal(richIsoPayload.svgPath, "svg-design/isometric.svg");
    assert.equal(richIsoPayload.optimizedSvgPath, "svg-design/isometric-optimized.svg");
    assert.equal(richIsoPayload.sceneManifestPath, "svg-design/isometric-manifest.json");
    assert.equal(richIsoPayload.previewPlan.status, "planned");
    assert.equal(richIsoPayload.previewPlan.outputPath, "svg-design/isometric-preview.png");
    assert.equal(richIsoPayload.viewBox, "0 0 1280 760");
    assert.equal(richIsoPayload.perspective, "2:1 isometric");
    assert.equal(richIsoPayload.primitiveCount, 7);
    assert.ok(richIsoPayload.scenePrimitives.includes("warehouse_shelf"));
    assert.ok(richIsoPayload.scenePrimitives.includes("vehicle"));
    assert.ok(richIsoPayload.layerMetadata.some((layer) => layer.id === "objects" && layer.primitiveCount >= 5));
    assert.ok(richIsoPayload.themeTokens.palette.length >= 1);
    assert.equal(richIsoPayload.styleConsistency.perspective, "consistent");
    assert.ok(richIsoPayload.styleConsistency.shadows.includes("iso-shadow"));
    assert.ok(richIsoPayload.optimization.afterSizeBytes <= richIsoPayload.optimization.beforeSizeBytes);
    const richIsoSvg = await readProjectFile(ctx.projectRoot, project.id, richIsoPayload.svgPath);
    assert.match(richIsoSvg, /aria-labelledby="title desc"/);
    assert.match(richIsoSvg, /layer-objects/);
    assert.match(richIsoSvg, /iso-arrow/);
    assert.match(richIsoSvg, /Real-time stock movement/);
    const richIsoManifest = await readProjectFile(ctx.projectRoot, project.id, richIsoPayload.sceneManifestPath);
    assert.match(richIsoManifest, /layerMetadata/);

    const iconResult = await icons!.handler({
      projectId: project.id,
      familyName: "ERP",
      icons: [{ name: "inventory", concept: "Boxes" }, { name: "invoice", concept: "Document" }]
    }, ctx);
    assert.equal(iconResult.ok, true);
    const iconPayload = iconResult.structuredContent as { icons: Array<{ path: string }>; sharedStyle: { strokeWidth: number } };
    assert.equal(iconPayload.icons.length, 2);
    assert.equal(iconPayload.sharedStyle.strokeWidth, 2);
    assert.ok(iconResult.artifacts.includes("svg-design/icons/inventory.svg"));
    assert.ok(iconResult.artifacts.includes("svg-design/icon-sprite.svg"));
    assert.ok(iconResult.artifacts.includes("svg-design/icon-preview-sheet.svg"));
    assert.ok(iconResult.artifacts.includes("svg-design/icon-set-README.md"));

    const richIconResult = await icons!.handler({
      projectId: project.id,
      domain: "erp_modules",
      prompt: "ERP sidebar icons for inventory finance sales delivery reporting",
      style: "duotone",
      gridSize: 32,
      padding: 4,
      designTokens: { strokeWidth: 2.25, radius: 8, palette: ["#0f172a", "#2563eb", "#14b8a6"], opticalWeight: "medium" },
      outputDirectory: "svg-design/erp-icons"
    }, ctx);
    assert.equal(richIconResult.ok, true);
    const richIconPayload = richIconResult.structuredContent as {
      familyName: string;
      style: string;
      icons: Array<{ name: string; path: string; gridSize: number }>;
      spritePath: string;
      previewSheetPath: string;
      manifestPath: string;
      readmePath: string;
      sharedStyle: { strokeWidth: number; cornerRadius: number; padding: number; opticalWeight: string };
      exportStructure: { individualSvgDirectory: string; sprite: string; previewSheet: string; metadataJson: string; readme: string };
      qaReport: { pass: boolean; checks: string[]; findings: unknown[] };
    };
    assert.equal(richIconPayload.familyName, "erp modules Icons");
    assert.equal(richIconPayload.style, "duotone");
    assert.equal(richIconPayload.icons.length, 5);
    assert.ok(richIconPayload.icons.some((icon) => icon.name === "inventory" && icon.path === "svg-design/erp-icons/inventory.svg" && icon.gridSize === 32));
    assert.equal(richIconPayload.spritePath, "svg-design/icon-sprite.svg");
    assert.equal(richIconPayload.previewSheetPath, "svg-design/icon-preview-sheet.svg");
    assert.equal(richIconPayload.manifestPath, "svg-design/icon-set-manifest.json");
    assert.equal(richIconPayload.readmePath, "svg-design/icon-set-README.md");
    assert.equal(richIconPayload.sharedStyle.strokeWidth, 2.25);
    assert.equal(richIconPayload.sharedStyle.cornerRadius, 8);
    assert.equal(richIconPayload.sharedStyle.padding, 4);
    assert.equal(richIconPayload.sharedStyle.opticalWeight, "medium");
    assert.equal(richIconPayload.exportStructure.individualSvgDirectory, "svg-design/erp-icons");
    assert.equal(richIconPayload.qaReport.pass, true);
    assert.ok(richIconPayload.qaReport.checks.includes("stroke_consistency"));
    const spriteSvg = await readProjectFile(ctx.projectRoot, project.id, richIconPayload.spritePath);
    assert.match(spriteSvg, /<symbol id="icon-inventory"/);
    const previewSvg = await readProjectFile(ctx.projectRoot, project.id, richIconPayload.previewSheetPath);
    assert.match(previewSvg, /erp modules Icons/);
    const readme = await readProjectFile(ctx.projectRoot, project.id, richIconPayload.readmePath);
    assert.match(readme, /Use individual SVG files/);

    const animatedResult = await animate!.handler({ projectId: project.id, svgPath: "svg-design/optimized.svg", animation: "fade" }, ctx);
    assert.equal(animatedResult.ok, true);
    assert.match(await readProjectFile(ctx.projectRoot, project.id, "svg-design/animated.svg"), /@keyframes/);

    const interactiveResult = await interact!.handler({
      projectId: project.id,
      svgPath: "svg-design/animated.svg",
      hotspots: [{ id: "order-hotspot", label: "Order details", x: 40, y: 80, width: 120, height: 60 }]
    }, ctx);
    assert.equal(interactiveResult.ok, true);
    assert.match(await readProjectFile(ctx.projectRoot, project.id, "svg-design/interactive.svg"), /aria-label="Order details"/);

    const combinedInteractionResult = await animateInteract!.handler({
      projectId: project.id,
      svgPath: "svg-design/diagram.svg",
      animations: [
        { id: "draw", selector: ".svg-flow-line", type: "flow_line", durationMs: 900 },
        { id: "reveal", selector: "g[id^='ui']", type: "step_reveal", durationMs: 600, delayMs: 120 }
      ],
      interactions: [
        { id: "api-hotspot", type: "tooltip", label: "API details", tooltip: "Open API contract", x: 120, y: 120, width: 120, height: 52 },
        { id: "toggle-state", type: "state_switch", label: "Toggle state", targetState: "expanded", x: 280, y: 120, width: 118, height: 52 }
      ],
      reducedMotion: true
    }, ctx);
    assert.equal(combinedInteractionResult.ok, true);
    assert.ok(combinedInteractionResult.artifacts.includes("svg-design/animated-interactive.svg"));
    assert.ok(combinedInteractionResult.artifacts.includes("svg-design/animated-interactive.css"));
    assert.ok(combinedInteractionResult.artifacts.includes("svg-design/waapi-config.json"));
    assert.ok(combinedInteractionResult.artifacts.includes("svg-design/interaction-manifest.json"));
    const combinedPayload = combinedInteractionResult.structuredContent as {
      animatedSvgPath: string;
      cssPath: string;
      waapiConfigPath: string;
      interactionManifestPath: string;
      animationCount: number;
      interactionCount: number;
      features: string[];
      accessibility: { reducedMotion: boolean; keyboardFocusable: boolean; ariaLabels: number };
      qaReport: { pass: boolean; checks: string[]; findings: unknown[] };
    };
    assert.equal(combinedPayload.animationCount, 2);
    assert.equal(combinedPayload.interactionCount, 2);
    assert.ok(combinedPayload.features.includes("flow_line"));
    assert.ok(combinedPayload.features.includes("tooltip"));
    assert.ok(combinedPayload.features.includes("reduced_motion"));
    assert.equal(combinedPayload.accessibility.reducedMotion, true);
    assert.equal(combinedPayload.accessibility.keyboardFocusable, true);
    assert.ok(combinedPayload.accessibility.ariaLabels >= 2);
    assert.equal(combinedPayload.qaReport.pass, true);
    assert.ok(combinedPayload.qaReport.checks.includes("keyboard_focus"));
    const combinedSvg = await readProjectFile(ctx.projectRoot, project.id, combinedPayload.animatedSvgPath);
    assert.match(combinedSvg, /prefers-reduced-motion/);
    assert.match(combinedSvg, /class="svg-hotspot"/);
    assert.match(combinedSvg, /aria-label="API details"/);
    const combinedCss = await readProjectFile(ctx.projectRoot, project.id, combinedPayload.cssPath);
    assert.match(combinedCss, /@keyframes svgPathDraw/);
    assert.match(combinedCss, /prefers-reduced-motion/);
    const waapi = await readProjectFile(ctx.projectRoot, project.id, combinedPayload.waapiConfigPath);
    assert.match(waapi, /strokeDashoffset/);

    const a11yResult = await a11y!.handler({ projectId: project.id, svgPath: "svg-design/interactive.svg", interactive: true }, ctx);
    assert.equal(a11yResult.ok, true);
    const a11yPayload = a11yResult.structuredContent as { pass: boolean; findings: unknown[] };
    assert.equal(a11yPayload.pass, true);
    assert.deepEqual(a11yPayload.findings, []);

    const exportResult = await exportProject!.handler({
      projectId: project.id,
      svgPaths: ["svg-design/scene.svg", "svg-design/diagram.svg", "svg-design/chart.svg"],
      packageName: "ERP SVG Asset Pack",
      designTokens: { colorPrimary: "#2563eb", radius: 8 },
      licenseNotes: ["Internal generated assets"],
      intendedUsage: ["admin_panel", "presentation"]
    }, ctx);
    assert.equal(exportResult.ok, true);
    const exportPayload = exportResult.structuredContent as {
      manifestPath: string;
      readmePath: string;
      assets: Array<{ optimizedSvgPath: string; pdfReadySvgPath: string; previewPlan: { png: string; webp: string }; dimensions: { viewBox?: string }; layerHints: string[]; licenseNotes: string[] }>;
      previewFormats: string[];
      spritePath: string;
      tokenPath: string;
      previewHtmlPath: string;
      accessibilityMetadataPath: string;
      intendedUsage: string[];
    };
    assert.equal(exportPayload.manifestPath, "svg-design/export-manifest.json");
    assert.equal(exportPayload.readmePath, "svg-design/README.md");
    assert.equal(exportPayload.assets.length, 3);
    assert.ok(exportPayload.previewFormats.includes("png"));
    assert.ok(exportPayload.previewFormats.includes("webp"));
    assert.equal(exportPayload.spritePath, "svg-design/export-package/sprite.svg");
    assert.equal(exportPayload.tokenPath, "svg-design/export-package/design-tokens.json");
    assert.equal(exportPayload.previewHtmlPath, "svg-design/export-package/preview.html");
    assert.equal(exportPayload.accessibilityMetadataPath, "svg-design/export-package/accessibility-metadata.json");
    assert.ok(exportPayload.intendedUsage.includes("admin_panel"));
    assert.ok(exportPayload.assets.every((asset) => asset.optimizedSvgPath.startsWith("svg-design/export-package/optimized/")));
    assert.ok(exportPayload.assets.every((asset) => asset.pdfReadySvgPath.startsWith("svg-design/export-package/pdf-ready/")));
    assert.ok(exportPayload.assets.every((asset) => asset.previewPlan.png.endsWith(".png") && asset.previewPlan.webp.endsWith(".webp")));
    assert.ok(exportPayload.assets.some((asset) => asset.layerHints.length > 0));
    assert.ok(exportPayload.assets.every((asset) => asset.licenseNotes.includes("Internal generated assets")));
    const exportManifest = await readProjectFile(ctx.projectRoot, project.id, exportPayload.manifestPath);
    assert.match(exportManifest, /ERP SVG Asset Pack/);
    assert.match(exportManifest, /accessibilityMetadataPath/);
    assert.match(exportManifest, /pdfReadySvgPath/);
    const exportSprite = await readProjectFile(ctx.projectRoot, project.id, exportPayload.spritePath);
    assert.match(exportSprite, /<symbol id="scene"/);
    const exportTokens = await readProjectFile(ctx.projectRoot, project.id, exportPayload.tokenPath);
    assert.match(exportTokens, /colorPrimary/);
    const exportA11y = await readProjectFile(ctx.projectRoot, project.id, exportPayload.accessibilityMetadataPath);
    assert.match(exportA11y, /focusable_interactions/);
    const exportPreview = await readProjectFile(ctx.projectRoot, project.id, exportPayload.previewHtmlPath);
    assert.match(exportPreview, /ERP SVG Asset Pack/);
    const exportReadme = await readProjectFile(ctx.projectRoot, project.id, exportPayload.readmePath);
    assert.match(exportReadme, /Preview\/demo HTML/);

    const revisionResult = await revision!.handler({
      projectId: project.id,
      svgPath: "svg-design/scene.svg",
      feedback: "too crowded, text too small, make ERP/admin style and mobile readable, arrows unclear, add one more node",
      designTokens: { background: "#0f172a", text: "#f8fafc", primary: "#38bdf8" },
      screenshotPath: "svg-design/review.png"
    }, ctx);
    assert.equal(revisionResult.ok, true);
    const revisionPayload = revisionResult.structuredContent as {
      actions: Array<{ tool: string; target: string; patchSafe: boolean }>;
      acceptanceChecks: string[];
      safePatches: string[];
      patchedSvgPath: string;
      beforeAfterPreviewPath: string;
      qaReportPath: string;
      preservation: { preserveIds: boolean; preserveAccessibilityMetadata: boolean; preserveAnimationHooks: boolean; designTokenKeys: string[] };
      qaReport: { pass: boolean; checks: string[]; findings: unknown[]; designTokenKeys: string[] };
    };
    assert.ok(revisionPayload.actions.some((action) => action.tool === "layout_svg_elements"));
    assert.ok(revisionPayload.actions.some((action) => action.tool === "fit_svg_typography"));
    assert.ok(revisionPayload.actions.some((action) => action.tool === "apply_svg_design_tokens"));
    assert.ok(revisionPayload.actions.some((action) => action.tool === "optimize_svg_paths"));
    assert.ok(revisionPayload.actions.some((action) => action.tool === "generate_svg_diagram"));
    assert.ok(revisionPayload.safePatches.includes("raised-minimum-font-size"));
    assert.ok(revisionPayload.safePatches.includes("applied-revision-design-tokens"));
    assert.ok(revisionPayload.safePatches.includes("marked-layout-spacing-review"));
    assert.equal(revisionPayload.preservation.preserveIds, true);
    assert.equal(revisionPayload.preservation.preserveAccessibilityMetadata, true);
    assert.equal(revisionPayload.preservation.preserveAnimationHooks, true);
    assert.ok(revisionPayload.preservation.designTokenKeys.includes("primary"));
    assert.ok(revisionPayload.qaReport.checks.includes("id_preservation"));
    assert.ok(revisionPayload.qaReport.designTokenKeys.includes("background"));
    assert.ok(revisionPayload.acceptanceChecks.includes("No text overflow"));
    assert.ok(revisionResult.artifacts.includes("svg-design/revised.svg"));
    assert.ok(revisionResult.artifacts.includes("svg-design/revision-preview.html"));
    assert.ok(revisionResult.artifacts.includes("svg-design/revision-qa.json"));
    const revisedSvg = await readProjectFile(ctx.projectRoot, project.id, revisionPayload.patchedSvgPath);
    assert.match(revisedSvg, /svg-revision-metadata/);
    assert.match(revisedSvg, /svg-revision-tokens/);
    assert.match(revisedSvg, /data-revision-layout="spacing-review-required"/);
    assert.match(revisedSvg, /font-size="15"/);
    const revisionPreview = await readProjectFile(ctx.projectRoot, project.id, revisionPayload.beforeAfterPreviewPath);
    assert.match(revisionPreview, /Before/);
    assert.match(revisionPreview, /After/);
    const revisionQa = await readProjectFile(ctx.projectRoot, project.id, revisionPayload.qaReportPath);
    assert.match(revisionQa, /animation_hook_preservation/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image-workflow skill exposes image tools through dedicated, coding, and debug skills", () => {
  const toolNames = [
    "create_image_workflow_brief",
    "inspect_project_image_assets",
    "create_sprite_sheet_spec",
    "create_icon_manifest",
    "check_image_style_consistency",
    "create_placeholder_svg_asset",
    "generate_svg_scene",
    "layout_svg_elements",
    "fit_svg_typography",
    "inspect_svg_visual_quality",
    "apply_svg_design_tokens",
    "optimize_svg_paths",
    "generate_svg_diagram",
    "generate_svg_chart",
    "generate_isometric_svg",
    "generate_svg_icon_set",
    "animate_svg_scene",
    "add_svg_interactivity",
    "animate_and_interact_svg",
    "inspect_svg_accessibility",
    "export_svg_project",
    "process_svg_revision_feedback"
  ];
  const imageWorkflow = skillRegistry.find((entry) => entry.id === "image-workflow");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(imageWorkflow);
  for (const toolName of toolNames) {
    assert.ok(imageWorkflow!.toolNames.includes(toolName), `${toolName} exposed in image-workflow`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
