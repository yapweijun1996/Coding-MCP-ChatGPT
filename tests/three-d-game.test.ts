import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, getProjectStoredFilePath, readProjectFile, writeProjectAsset, writeProjectFile } from "../src/projects/store.js";
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
    clientId: "three-d-game-test"
  };
}

function minimalGlb(): Buffer {
  const buffer = Buffer.alloc(12);
  buffer.write("glTF", 0, "ascii");
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt32LE(12, 8);
  return buffer;
}

const oneByOnePng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3eUQAAAABJRU5ErkJggg==";

function inspectableGltf(): Record<string, unknown> {
  return {
    asset: { version: "2.0" },
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "ShipRoot", mesh: 0, translation: [0, 1, 0], scale: [1, 1, 1] }],
    meshes: [{
      name: "ShipMesh",
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1 },
        indices: 2,
        material: 0,
        targets: [{ POSITION: 0 }]
      }]
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, 0, -1], max: [1, 2, 1] },
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 0, componentType: 5123, count: 3, type: "SCALAR" },
      { bufferView: 0, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1.5] }
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 128 }],
    buffers: [{ uri: "data:application/octet-stream;base64,AAAA", byteLength: 4 }],
    materials: [{
      name: "Paint",
      alphaMode: "BLEND",
      pbrMetallicRoughness: { baseColorTexture: { index: 0 } }
    }],
    images: [{ uri: `data:image/png;base64,${oneByOnePng}` }],
    textures: [{ name: "PaintTexture", source: 0 }],
    animations: [{ name: "Idle", samplers: [{ input: 3, output: 0 }], channels: [{ sampler: 0, target: { node: 0, path: "translation" } }] }],
    skins: [{ name: "Rig", joints: [0] }]
  };
}

test("3D/game tools validate assets and create build, scene, map, QA, collision, and performance artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "three-d-game-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "3D game", createdByClientId: "game-dev" });
    await writeProjectAsset(ctx.projectRoot, project.id, "assets/ship.gltf", Buffer.from(JSON.stringify({
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [] }],
      materials: [],
      animations: []
    }), "utf8"), "model/gltf+json");
    await writeProjectAsset(ctx.projectRoot, project.id, "assets/ship.glb", minimalGlb(), "model/gltf-binary");

    const brief = getToolModule("create_3d_game_build_brief");
    const validate = getToolModule("validate_gltf_asset");
    const inspect = getToolModule("inspect_3d_asset");
    const blocky = getToolModule("generate_blocky_character");
    const composer = getToolModule("compose_3d_scene");
    const animation = getToolModule("validate_3d_animation_controls");
    const scene = getToolModule("create_3d_scene_manifest");
    const map = getToolModule("generate_game_map_spec");
    const collision = getToolModule("test_collision_rules");
    const loopQa = getToolModule("create_game_loop_qa_plan");
    const controls = getToolModule("create_camera_control_test_plan");
    const performance = getToolModule("profile_game_performance_budget");
    const visualQa = getToolModule("create_3d_visual_qa_plan");
    const critique = getToolModule("critique_3d_scene_design");
    const assetSearch = getToolModule("search_3d_asset_library");
    const showcaseExport = getToolModule("export_3d_showcase_package");
    const optimizer = getToolModule("optimize_3d_asset");
    for (const [name, tool] of Object.entries({ brief, validate, inspect, blocky, composer, animation, scene, map, collision, loopQa, controls, performance, visualQa, critique, assetSearch, showcaseExport, optimizer })) assert.ok(tool, `${name} registered`);

    const briefResult = await brief!.handler({
      projectId: project.id,
      title: "Asteroid runner",
      gameType: "arcade 3D runner",
      mechanics: ["steer ship", "collect fuel", "avoid asteroids"],
      assets: [{ name: "Ship", kind: "vehicle", format: "glb", prompt: "low-poly player ship" }]
    }, ctx);
    assert.equal(briefResult.ok, true);
    assert.ok(briefResult.artifacts.includes("three-d-game/build-brief.json"));

    const gltfResult = await validate!.handler({ projectId: project.id, assetPath: "assets/ship.gltf" }, ctx);
    const gltfPayload = gltfResult.structuredContent as { format: string; version: string; meshes: number };
    assert.equal(gltfPayload.format, "gltf");
    assert.equal(gltfPayload.version, "2.0");
    assert.equal(gltfPayload.meshes, 1);

    const glbResult = await validate!.handler({ projectId: project.id, assetPath: "assets/ship.glb" }, ctx);
    const glbPayload = glbResult.structuredContent as { format: string; version: number; warnings: string[] };
    assert.equal(glbPayload.format, "glb");
    assert.equal(glbPayload.version, 2);
    assert.deepEqual(glbPayload.warnings, []);

    await writeProjectAsset(ctx.projectRoot, project.id, "assets/inspected.gltf", Buffer.from(JSON.stringify(inspectableGltf()), "utf8"), "model/gltf+json");
    const inspectResult = await inspect!.handler({ projectId: project.id, assetPath: "assets/inspected.gltf", writeReportToProject: true }, ctx);
    assert.equal(inspectResult.ok, true);
    assert.ok(inspectResult.artifacts.includes("three-d-game/asset-inspection.json"));
    const inspectPayload = inspectResult.structuredContent as {
      format: string;
      triangleCount: number;
      vertexCount: number;
      drawCallsEstimate: number;
      materialReport: Array<{ name: string; alphaMode: string }>;
      textureReport: Array<{ width?: number; height?: number }>;
      animationClips: Array<{ name: string; durationSeconds: number }>;
      boundingBox: { size: number[]; center: number[] };
      mobileRiskScore: number;
      warnings: string[];
      recommendations: string[];
    };
    assert.equal(inspectPayload.format, "gltf");
    assert.equal(inspectPayload.triangleCount, 1);
    assert.equal(inspectPayload.vertexCount, 6);
    assert.equal(inspectPayload.drawCallsEstimate, 1);
    assert.equal(inspectPayload.materialReport[0].name, "Paint");
    assert.equal(inspectPayload.materialReport[0].alphaMode, "BLEND");
    assert.deepEqual([inspectPayload.textureReport[0].width, inspectPayload.textureReport[0].height], [1, 1]);
    assert.deepEqual(inspectPayload.boundingBox.size, [2, 2, 2]);
    assert.equal(inspectPayload.animationClips[0].durationSeconds, 1.5);
    assert.equal(inspectPayload.mobileRiskScore >= 0, true);
    assert.equal(inspectPayload.warnings.some((warning) => warning.includes("BLEND")), true);
    assert.equal(inspectPayload.recommendations.length > 0, true);
    const inspectionReport = await readProjectFile(ctx.projectRoot, project.id, "three-d-game/asset-inspection.json");
    assert.match(inspectionReport, /ShipMesh/);

    await writeFile(path.join(ctx.workspaceRoot, "model.obj"), "o Cube\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl Matte\nf 1 2 3\n", "utf8");
    const objResult = await inspect!.handler({ source: "workspace", assetPath: "model.obj" }, ctx);
    assert.equal(objResult.ok, true);
    const objPayload = objResult.structuredContent as { format: string; triangleCount: number; vertexCount: number; materialReport: Array<{ name: string }> };
    assert.equal(objPayload.format, "obj");
    assert.equal(objPayload.triangleCount, 1);
    assert.equal(objPayload.vertexCount, 3);
    assert.equal(objPayload.materialReport[0].name, "Matte");

    const blockyResult = await blocky!.handler({
      projectId: project.id,
      style: "minecraft_collectible",
      name: "Crystal Miner",
      palette: { skin: "#f2c6a0", shirt: "#2f80ed", pants: "#1b2a41", accessory: "#d6a22a" },
      parts: { head: { size: [1, 1, 1] }, body: { size: [1.1, 1.4, 0.55] }, tool: { type: "pickaxe", color: "#d6a22a" } },
      expression: "friendly",
      accessories: [{ name: "pickaxe", type: "pickaxe", color: "#d6a22a", attachTo: "rightArm" }],
      base: { type: "round_pedestal", namePlate: true }
    }, ctx);
    assert.equal(blockyResult.ok, true);
    assert.deepEqual(blockyResult.artifacts.sort(), ["three-d-game/blocky-character-manifest.json", "three-d-game/blocky-character.js"].sort());
    const blockyPayload = blockyResult.structuredContent as {
      name: string;
      threeJsModulePath: string;
      manifestPath: string;
      partNames: string[];
      boundingBox: { size: number[] };
      forwardDirection: string;
      animationAnchors: { neck: number[]; weaponMount: number[] };
      validation: { ok: boolean; trianglesEstimate: number; drawCallsEstimate: number; warnings: string[] };
    };
    assert.equal(blockyPayload.name, "Crystal Miner");
    assert.equal(blockyPayload.threeJsModulePath, "three-d-game/blocky-character.js");
    assert.equal(blockyPayload.manifestPath, "three-d-game/blocky-character-manifest.json");
    assert.ok(blockyPayload.partNames.includes("head"));
    assert.ok(blockyPayload.partNames.includes("pickaxe"));
    assert.equal(blockyPayload.forwardDirection, "-Z");
    assert.equal(blockyPayload.animationAnchors.neck.length, 3);
    assert.equal(blockyPayload.animationAnchors.weaponMount.length, 3);
    assert.equal(blockyPayload.boundingBox.size.length, 3);
    assert.equal(blockyPayload.validation.ok, true);
    assert.ok(blockyPayload.validation.trianglesEstimate >= blockyPayload.partNames.length * 12);
    assert.ok(blockyPayload.validation.drawCallsEstimate > 0);
    const blockyModule = await readProjectFile(ctx.projectRoot, project.id, "three-d-game/blocky-character.js");
    assert.match(blockyModule, /createBlockyCharacter/);
    assert.match(blockyModule, /Crystal Miner/);
    const blockyManifest = await readProjectFile(ctx.projectRoot, project.id, "three-d-game/blocky-character-manifest.json");
    assert.match(blockyManifest, /weaponMount/);

    const composerResult = await composer!.handler({
      projectId: project.id,
      sceneName: "Crystal Miner Showcase",
      assetManifestPath: "three-d-game/blocky-character-manifest.json",
      style: "collectible_toy_showcase",
      devices: ["desktop", "mobile"],
      constraints: {
        allowInteriorView: false,
        enablePan: false,
        minModelScreenHeightRatio: 0.55,
        maxModelScreenHeightRatio: 0.82,
        avoidUiPanels: ["right"]
      }
    }, ctx);
    assert.equal(composerResult.ok, true);
    assert.deepEqual(composerResult.artifacts.sort(), ["three-d-game/scene-composer-config.json", "three-d-game/scene-composer.js"].sort());
    const composerPayload = composerResult.structuredContent as {
      sceneConfigPath: string;
      threeJsModulePath: string;
      cameraConfig: { fov: number; position: number[]; target: number[]; near: number; far: number };
      controlConfig: { enablePan: boolean; minDistance: number; maxDistance: number; maxPolarAngle: number };
      lightingConfig: { exposure: number; key: { intensity: number } };
      environmentConfig: { floor: { enabled: boolean }; pedestal: { enabled: boolean } };
      mobileFraming: { portrait: { position: number[]; safeAreaPadding: { top: number } }; avoidUiPanels: string[] };
      noInteriorConstraint: { enabled: boolean; minCameraDistance: number };
      warnings: string[];
    };
    assert.equal(composerPayload.sceneConfigPath, "three-d-game/scene-composer-config.json");
    assert.equal(composerPayload.threeJsModulePath, "three-d-game/scene-composer.js");
    assert.equal(composerPayload.cameraConfig.fov, 45);
    assert.equal(composerPayload.cameraConfig.position.length, 3);
    assert.equal(composerPayload.cameraConfig.target.length, 3);
    assert.ok(composerPayload.cameraConfig.near > 0);
    assert.ok(composerPayload.cameraConfig.far > composerPayload.controlConfig.maxDistance);
    assert.equal(composerPayload.controlConfig.enablePan, false);
    assert.ok(composerPayload.controlConfig.minDistance >= composerPayload.noInteriorConstraint.minCameraDistance);
    assert.ok(composerPayload.controlConfig.maxPolarAngle > 2);
    assert.ok(composerPayload.lightingConfig.exposure > 1);
    assert.ok(composerPayload.lightingConfig.key.intensity > 1);
    assert.equal(composerPayload.environmentConfig.floor.enabled, true);
    assert.equal(composerPayload.environmentConfig.pedestal.enabled, true);
    assert.equal(composerPayload.mobileFraming.portrait.position.length, 3);
    assert.equal(composerPayload.mobileFraming.portrait.safeAreaPadding.top, 72);
    assert.deepEqual(composerPayload.mobileFraming.avoidUiPanels, ["right"]);
    assert.equal(composerPayload.noInteriorConstraint.enabled, true);
    assert.deepEqual(composerPayload.warnings, []);
    const composerModule = await readProjectFile(ctx.projectRoot, project.id, "three-d-game/scene-composer.js");
    assert.match(composerModule, /createComposed3DScene/);
    assert.match(composerModule, /OrbitControls/);

    const animationResult = await animation!.handler({
      projectId: project.id,
      assetManifestPath: "three-d-game/blocky-character-manifest.json",
      modelKind: "character",
      forwardAxis: "-Z",
      desiredStates: ["idle", "walk", "wave", "attack", "jump", "talk"],
      controlContract: { W: "moveForward", A: "turnLeft", S: "moveBackward", D: "turnRight", Space: "jump" },
      cameraMode: "third_person",
      attachments: [{ name: "pickaxe", attachTo: "weaponMount" }]
    }, ctx);
    assert.equal(animationResult.ok, true);
    assert.deepEqual(animationResult.artifacts.sort(), ["three-d-game/animation-control-config.json", "three-d-game/animation-controller.js", "three-d-game/animation-validation-report.json"].sort());
    const animationPayload = animationResult.structuredContent as {
      animationConfigPath: string;
      animationModulePath: string;
      validationReportPath: string;
      orientationReport: { configuredForwardAxis: string; forwardVector: number[]; possibleSidewaysWalk: boolean };
      controlMappingReport: { controls: Record<string, string>; warnings: string[] };
      stateValidation: Array<{ state: string; ok: boolean; returnsToNeutral: boolean }>;
      previewFrames: Array<{ state: string; phase: number }>;
      warnings: string[];
      suggestedFixes: string[];
    };
    assert.equal(animationPayload.animationConfigPath, "three-d-game/animation-control-config.json");
    assert.equal(animationPayload.animationModulePath, "three-d-game/animation-controller.js");
    assert.equal(animationPayload.validationReportPath, "three-d-game/animation-validation-report.json");
    assert.equal(animationPayload.orientationReport.configuredForwardAxis, "-Z");
    assert.deepEqual(animationPayload.orientationReport.forwardVector, [0, 0, -1]);
    assert.equal(animationPayload.orientationReport.possibleSidewaysWalk, false);
    assert.equal(animationPayload.controlMappingReport.controls.A, "turnLeft");
    assert.deepEqual(animationPayload.controlMappingReport.warnings, []);
    assert.equal(animationPayload.stateValidation.every((state) => state.ok && state.returnsToNeutral), true);
    assert.equal(animationPayload.previewFrames.length, 18);
    assert.deepEqual(animationPayload.warnings, []);
    assert.ok(animationPayload.suggestedFixes.some((fix) => fix.includes("preview sequence")));
    const animationModule = await readProjectFile(ctx.projectRoot, project.id, "three-d-game/animation-controller.js");
    assert.match(animationModule, /createAnimationController/);
    assert.match(animationModule, /directionVector/);

    const invertedAnimationResult = await animation!.handler({
      projectId: project.id,
      assetManifestPath: "three-d-game/blocky-character-manifest.json",
      modelKind: "vehicle",
      forwardAxis: "+Z",
      desiredStates: ["walk", "turn_left"],
      controlContract: { W: "moveForward", A: "turnRight", D: "turnLeft" },
      rootRotation: { yawDegrees: 180, accumulates: true },
      vehicle: { steeringAxis: "+Y", wheelSpinAxis: "+Y", wheelNames: [] }
    }, ctx);
    assert.equal(invertedAnimationResult.ok, false);
    const invertedPayload = invertedAnimationResult.structuredContent as { warnings: string[]; suggestedFixes: string[]; orientationReport: { possibleBackwardForward: boolean }; vehicleReport: { warnings: string[] } };
    assert.equal(invertedPayload.orientationReport.possibleBackwardForward, true);
    assert.ok(invertedPayload.warnings.some((warning) => warning.includes("does not match manifest forwardDirection")));
    assert.ok(invertedPayload.warnings.some((warning) => warning.includes("A turns right")));
    assert.ok(invertedPayload.warnings.some((warning) => warning.includes("Root yaw is 180")));
    assert.ok(invertedPayload.vehicleReport.warnings.some((warning) => warning.includes("wheelSpinAxis")));
    assert.ok(invertedPayload.suggestedFixes.length >= 1);

    const sceneResult = await scene!.handler({
      projectId: project.id,
      sceneName: "Level 1",
      objects: [
        { id: "ship", type: "mesh", assetPath: "assets/ship.glb", position: { x: 0, y: 0, z: 0 }, collider: "box", triangles: 5000 },
        { id: "sun", type: "light", position: { x: 5, y: 8, z: 2 } }
      ],
      camera: { position: { x: 0, y: 3, z: 8 }, target: { x: 0, y: 0, z: 0 } },
      controls: ["keyboard", "touch"],
      performanceBudget: { targetFps: 60, maxTriangles: 10000, maxDrawCalls: 10 }
    }, ctx);
    const scenePayload = sceneResult.structuredContent as { issues: string[]; objects: unknown[] };
    assert.equal(scenePayload.objects.length, 2);
    assert.deepEqual(scenePayload.issues, []);

    const mapResult = await map!.handler({
      projectId: project.id,
      name: "Arena",
      width: 6,
      height: 4,
      layers: [{ name: "ground", tile: "." }],
      obstacles: [{ x: 1, y: 1, width: 2, height: 1, tile: "#" }],
      spawn: { x: 0, y: 0 },
      goals: [{ x: 5, y: 3, id: "exit" }]
    }, ctx);
    const mapPayload = mapResult.structuredContent as { preview: string[] };
    assert.deepEqual(mapPayload.preview, ["S.....", ".##...", "......", ".....G"]);

    const collisionResult = await collision!.handler({
      projectId: project.id,
      colliders: [
        { id: "player", type: "aabb", position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
        { id: "wall", type: "aabb", position: { x: 0.5, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
        { id: "coin", type: "sphere", position: { x: 5, y: 0, z: 0 }, radius: 0.5 }
      ],
      expectedPairs: [["player", "wall"]],
      writeToProject: true
    }, ctx);
    assert.equal(collisionResult.ok, true);
    assert.ok(collisionResult.artifacts.includes("three-d-game/collision-report.json"));

    const qaResult = await loopQa!.handler({
      projectId: project.id,
      states: ["menu", "playing", "game_over"],
      interactions: ["start", "steer left", "collect fuel", "restart"]
    }, ctx);
    assert.equal(qaResult.ok, true);

    const controlsResult = await controls!.handler({
      projectId: project.id,
      controls: ["keyboard", "touch"],
      cameraModes: ["third_person", "top_down"]
    }, ctx);
    const controlsPayload = controlsResult.structuredContent as { matrix: unknown[] };
    assert.equal(controlsPayload.matrix.length, 4);

    const performanceResult = await performance!.handler({
      projectId: project.id,
      triangles: 300000,
      drawCalls: 700,
      textureMegabytes: 128,
      writeToProject: true
    }, ctx);
    const performancePayload = performanceResult.structuredContent as { status: string; warnings: string[] };
    assert.equal(performancePayload.status, "over_budget");
    assert.equal(performancePayload.warnings.length >= 2, true);
    const report = await readProjectFile(ctx.projectRoot, project.id, "three-d-game/performance-budget-report.json");
    assert.match(report, /over_budget/);

    const visualQaResult = await visualQa!.handler({
      projectId: project.id,
      styleTarget: "minecraft_collectible",
      sceneConfigPath: "three-d-game/scene-composer-config.json",
      assetManifestPath: "three-d-game/blocky-character-manifest.json",
      views: ["front", "back", "left", "right", "top", "mobile_portrait"]
    }, ctx);
    assert.equal(visualQaResult.ok, true);
    assert.deepEqual(visualQaResult.artifacts, ["three-d-game/visual-qa-plan.json"]);
    const visualQaPayload = visualQaResult.structuredContent as { captures: Array<{ view: string; viewport: { width: number; height: number }; checks: string[] }>; thresholds: { minModelCoverage: number }; passCriteria: string[] };
    assert.equal(visualQaPayload.captures.length, 6);
    assert.equal(visualQaPayload.captures.some((capture) => capture.view === "mobile_portrait" && capture.viewport.width === 390), true);
    assert.equal(visualQaPayload.captures[0].checks.includes("camera_inside_mesh"), true);
    assert.ok(visualQaPayload.thresholds.minModelCoverage > 0);
    assert.ok(visualQaPayload.passCriteria.some((item) => item.includes("model_too_dark")));

    const critiqueResult = await critique!.handler({
      projectId: project.id,
      styleTarget: "minecraft_collectible",
      desiredFacing: "three_quarter",
      screenshotEvidence: [
        { view: "front", path: "three-d-game/screenshots/front.png", brightness: 0.18, contrast: 0.3, modelCoverage: 0.25, clipped: false, facing: "back", uiReadable: false },
        { view: "mobile_portrait", path: "three-d-game/screenshots/mobile.png", brightness: 0.4, contrast: 0.45, modelCoverage: 0.86, clipped: true, facing: "front", uiReadable: true }
      ]
    }, ctx);
    assert.equal(critiqueResult.ok, false);
    assert.ok(critiqueResult.artifacts.includes("three-d-game/design-critique-report.json"));
    const critiquePayload = critiqueResult.structuredContent as { status: string; score: number; findings: Array<{ issue: string; severity: string }>; styleGuidance: string[]; nextActions: string[] };
    assert.equal(critiquePayload.status, "needs_revision");
    assert.ok(critiquePayload.score < 100);
    assert.equal(critiquePayload.findings.some((finding) => finding.issue === "model_too_dark" && finding.severity === "high"), true);
    assert.equal(critiquePayload.findings.some((finding) => finding.issue === "wrong_facing"), true);
    assert.ok(critiquePayload.styleGuidance.some((item) => item.includes("chunky")));
    assert.ok(critiquePayload.nextActions.length > 0);

    const assetSearchResult = await assetSearch!.handler({
      projectId: project.id,
      query: "blocky character",
      assetType: "model",
      styleTarget: "minecraft_collectible",
      commercialUseRequired: true,
      writeToProject: true
    }, ctx);
    assert.equal(assetSearchResult.ok, true);
    assert.deepEqual(assetSearchResult.artifacts, ["three-d-game/asset-library-search.json"]);
    const assetSearchPayload = assetSearchResult.structuredContent as { results: Array<{ source: string; license: string; businessDemoSuitability: string; commercialUse: boolean }> };
    assert.ok(assetSearchPayload.results.length >= 1);
    assert.equal(assetSearchPayload.results.every((item) => item.commercialUse), true);
    assert.equal(assetSearchPayload.results.some((item) => item.license === "CC0" && item.businessDemoSuitability === "high"), true);

    const showcaseResult = await showcaseExport!.handler({
      projectId: project.id,
      title: "Crystal Miner Showcase",
      assetPaths: ["three-d-game/blocky-character.js", "assets/heavy.gltf"],
      screenshotPaths: ["three-d-game/screenshots/front.png", "three-d-game/screenshots/mobile.png"],
      reportPaths: ["three-d-game/design-critique-report.json", "three-d-game/asset-inspection.json"]
    }, ctx);
    assert.equal(showcaseResult.ok, true);
    assert.deepEqual(showcaseResult.artifacts.sort(), ["three-d-game/showcase-export-package.json", "three-d-game/showcase-export-readme.md"].sort());
    const showcasePayload = showcaseResult.structuredContent as { turntablePlan: { frames: number; output: string }; pwaChecklist: string[]; packagePath: string; readmePath: string; checklist: string[] };
    assert.equal(showcasePayload.turntablePlan.frames, 72);
    assert.equal(showcasePayload.turntablePlan.output, "three-d-game/exports/turntable.webm");
    assert.ok(showcasePayload.pwaChecklist.includes("touch drag"));
    assert.equal(showcasePayload.packagePath, "three-d-game/showcase-export-package.json");
    assert.equal(showcasePayload.readmePath, "three-d-game/showcase-export-readme.md");
    assert.ok(showcasePayload.checklist.some((item) => item.includes("visual QA")));

    await writeProjectAsset(ctx.projectRoot, project.id, "assets/heavy.gltf", Buffer.from(JSON.stringify({
      asset: { version: "2.0" },
      scenes: [{ nodes: [0, 1, 2] }],
      nodes: [
        { name: "KeepRoot", mesh: 0 },
        { name: "PreviewCamera", camera: 0 },
        { extensions: { KHR_lights_punctual: { light: 0 } } }
      ],
      cameras: [{ type: "perspective" }],
      extensions: { KHR_lights_punctual: { lights: [{ type: "point" }] } },
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
      accessors: [
        { componentType: 5126, count: 300, type: "VEC3", min: [-1, -1, -1], max: [1, 1, 1] },
        { componentType: 5123, count: 900, type: "SCALAR" }
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 128 }],
      buffers: [{ uri: "data:application/octet-stream;base64,AAAA", byteLength: 4 }],
      materials: [
        { name: "Used", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
        { name: "Unused", pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }
      ],
      images: [{ uri: `data:image/png;base64,${oneByOnePng}` }, { uri: `data:image/png;base64,${oneByOnePng}` }],
      textures: [{ source: 0 }, { source: 1 }],
      animations: [{ name: "Idle", samplers: [], channels: [] }]
    }), "utf8"), "model/gltf+json");
    const optimizeResult = await optimizer!.handler({
      projectId: project.id,
      assetPath: "assets/heavy.gltf",
      targetProfile: "mobile_pwa",
      preserveAnimations: true,
      compression: ["texture", "meshopt", "quantization"],
      generateLods: true
    }, ctx);
    assert.equal(optimizeResult.ok, true);
    assert.deepEqual(optimizeResult.artifacts.sort(), ["three-d-game/asset-optimization-report.json", "three-d-game/optimized/heavy.optimized.gltf"].sort());
    const optimizePayload = optimizeResult.structuredContent as {
      optimizedAssetPath: string;
      beforeReport: { fileSizeBytes: number; materialCount: number; textureCount: number; animationClipCount: number };
      afterReport: { fileSizeBytes: number; materialCount: number; textureCount: number; animationClipCount: number };
      sizeReductionPercent: number;
      changes: string[];
      changedMaterials: { before: number; after: number };
      changedTextures: { before: number; after: number; maxTextureSize: number };
      lodPlan: Array<{ suffix: string; ratio: number }>;
      visualRisk: string[];
      recommendedLoaderConfig: { useKtx2Loader: boolean; useMeshoptDecoder: boolean; assetPath: string };
    };
    assert.equal(optimizePayload.optimizedAssetPath, "three-d-game/optimized/heavy.optimized.gltf");
    assert.equal(optimizePayload.beforeReport.animationClipCount, 1);
    assert.equal(optimizePayload.afterReport.animationClipCount, 1);
    assert.equal(optimizePayload.changedMaterials.before, 2);
    assert.equal(optimizePayload.changedMaterials.after, 1);
    assert.equal(optimizePayload.changedTextures.before, 2);
    assert.equal(optimizePayload.changedTextures.after, 1);
    assert.equal(optimizePayload.changedTextures.maxTextureSize, 1024);
    assert.ok(optimizePayload.sizeReductionPercent > 0);
    assert.ok(optimizePayload.changes.some((change) => change.includes("Removed 1 unused material")));
    assert.ok(optimizePayload.lodPlan.length >= 3);
    assert.equal(optimizePayload.recommendedLoaderConfig.useKtx2Loader, true);
    assert.equal(optimizePayload.recommendedLoaderConfig.useMeshoptDecoder, true);
    assert.equal(optimizePayload.recommendedLoaderConfig.assetPath, "three-d-game/optimized/heavy.optimized.gltf");
    assert.ok(optimizePayload.visualRisk.some((note) => note.includes("Meshopt")));
    const optimizedGltfPath = await getProjectStoredFilePath(ctx.projectRoot, project.id, "three-d-game/optimized/heavy.optimized.gltf");
    const optimizedGltf = await readFile(optimizedGltfPath, "utf8");
    assert.match(optimizedGltf, /KHR_mesh_quantization/);
    assert.doesNotMatch(optimizedGltf, /Unused/);
    const optimizationReport = await readProjectFile(ctx.projectRoot, project.id, "three-d-game/asset-optimization-report.json");
    assert.match(optimizationReport, /recommendedLoaderConfig/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("three-d-game skill exposes 3D/game tools through dedicated, coding, and debug skills", () => {
  const toolNames = [
    "create_3d_game_build_brief",
    "validate_gltf_asset",
    "inspect_3d_asset",
    "generate_blocky_character",
    "compose_3d_scene",
    "validate_3d_animation_controls",
    "create_3d_scene_manifest",
    "generate_game_map_spec",
    "test_collision_rules",
    "create_game_loop_qa_plan",
    "create_camera_control_test_plan",
    "profile_game_performance_budget",
    "create_3d_visual_qa_plan",
    "critique_3d_scene_design",
    "search_3d_asset_library",
    "export_3d_showcase_package",
    "optimize_3d_asset"
  ];
  const threeDGame = skillRegistry.find((entry) => entry.id === "three-d-game");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(threeDGame);
  for (const toolName of toolNames) {
    assert.ok(threeDGame!.toolNames.includes(toolName), `${toolName} exposed in three-d-game`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
