import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getProjectStoredFilePath, readProjectFile, writeProjectAsset, writeProjectFile } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const vector3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number()
});

const sceneObjectSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.enum(["mesh", "light", "camera", "empty", "terrain", "trigger"]),
  assetPath: z.string().min(1).max(240).optional(),
  position: vector3Schema.optional(),
  rotation: vector3Schema.optional(),
  scale: vector3Schema.optional(),
  collider: z.enum(["none", "box", "sphere", "capsule", "mesh"]).optional().default("none"),
  triangles: z.number().int().min(0).max(10_000_000).optional().default(0)
});

const create3dGameBuildBriefInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160),
  gameType: z.string().min(1).max(160),
  targetPlatform: z.enum(["desktop_web", "mobile_web", "both"]).optional().default("both"),
  artDirection: z.string().min(1).max(1600).optional(),
  mechanics: z.array(z.string().min(1).max(240)).min(1).max(40),
  assets: z.array(z.object({
    name: z.string().min(1).max(120),
    kind: z.enum(["character", "prop", "environment", "vehicle", "weapon", "collectible", "ui", "audio"]),
    format: z.enum(["glb", "gltf", "png", "webp", "svg", "mp3", "wav", "ogg"]).optional(),
    prompt: z.string().min(1).max(1000).optional()
  })).max(80).optional().default([]),
  outputPath: z.string().min(1).max(240).optional().default("three-d-game/build-brief.json")
});

const validateGltfAssetInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  assetPath: z.string().min(1).max(240),
  maxBytes: z.number().int().min(1).max(100 * 1024 * 1024).optional().default(25 * 1024 * 1024)
});

const inspect3dAssetInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  assetPath: z.string().min(1).max(1000),
  source: z.enum(["project", "workspace"]).optional(),
  maxBytes: z.number().int().min(1).max(100 * 1024 * 1024).optional().default(50 * 1024 * 1024),
  writeReportToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("three-d-game/asset-inspection.json")
}).refine((value) => value.source !== "project" || Boolean(value.projectId), {
  message: "projectId is required when source=project."
}).refine((value) => !value.writeReportToProject || Boolean(value.projectId), {
  message: "projectId is required when writeReportToProject=true."
});

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const tuple3Schema = z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]);
const blockyPartNameSchema = z.enum([
  "head", "body", "leftArm", "rightArm", "leftLeg", "rightLeg",
  "eyes", "mouth", "hair", "hat", "helmet", "shirt", "pants", "shoes",
  "weapon", "pickaxe", "sword", "staff", "backpack", "shield", "pet",
  "basePlatform", "namePlate", "tool"
]);
const blockyPartSchema = z.object({
  size: tuple3Schema.optional(),
  position: z.tuple([z.number(), z.number(), z.number()]).optional(),
  color: hexColorSchema.optional(),
  visible: z.boolean().optional().default(true),
  type: z.string().min(1).max(80).optional()
});
const generateBlockyCharacterInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  style: z.enum(["minecraft_collectible", "voxel_toy", "toy_figurine", "mini_rpg_avatar", "robot", "mascot"]).optional().default("minecraft_collectible"),
  name: z.string().min(1).max(120),
  palette: z.record(hexColorSchema).optional().default({}),
  parts: z.record(blockyPartSchema).optional().default({}),
  expression: z.enum(["friendly", "neutral", "determined", "happy", "serious"]).optional().default("friendly"),
  accessories: z.array(z.object({
    name: z.string().min(1).max(80),
    type: z.enum(["hat", "helmet", "hair", "weapon", "pickaxe", "sword", "staff", "backpack", "shield", "pet", "badge"]),
    color: hexColorSchema.optional(),
    attachTo: blockyPartNameSchema.optional()
  })).max(40).optional().default([]),
  base: z.object({
    type: z.enum(["none", "square_platform", "round_pedestal"]).optional().default("round_pedestal"),
    namePlate: z.boolean().optional().default(true),
    color: hexColorSchema.optional()
  }).optional().default({}),
  animationAnchors: z.record(z.tuple([z.number(), z.number(), z.number()])).optional().default({}),
  outputModulePath: z.string().min(1).max(240).optional().default("three-d-game/blocky-character.js"),
  outputManifestPath: z.string().min(1).max(240).optional().default("three-d-game/blocky-character-manifest.json")
});

const vectorTupleSchema = z.tuple([z.number(), z.number(), z.number()]);
const boundingBoxSchema = z.object({
  min: vectorTupleSchema.optional(),
  max: vectorTupleSchema.optional(),
  size: vectorTupleSchema.optional(),
  center: vectorTupleSchema.optional()
});
const compose3dSceneInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  sceneName: z.string().min(1).max(160).optional().default("Composed 3D Scene"),
  assetManifestPath: z.string().min(1).max(240).optional(),
  boundingBox: boundingBoxSchema.optional(),
  style: z.enum(["collectible_toy_showcase", "product_showcase", "hero_select", "minecraft_collectible", "minimal_studio", "night_showcase"]).optional().default("collectible_toy_showcase"),
  devices: z.array(z.enum(["desktop", "mobile", "tablet"])).min(1).max(3).optional().default(["desktop", "mobile"]),
  constraints: z.object({
    allowInteriorView: z.boolean().optional().default(false),
    enablePan: z.boolean().optional().default(false),
    minModelScreenHeightRatio: z.number().min(0.1).max(0.95).optional().default(0.55),
    maxModelScreenHeightRatio: z.number().min(0.1).max(0.98).optional().default(0.82),
    autoRotate: z.boolean().optional().default(false),
    avoidUiPanels: z.array(z.enum(["left", "right", "top", "bottom"])).max(4).optional().default([])
  }).optional().default({}),
  outputConfigPath: z.string().min(1).max(240).optional().default("three-d-game/scene-composer-config.json"),
  outputModulePath: z.string().min(1).max(240).optional().default("three-d-game/scene-composer.js")
}).refine((value) => Boolean(value.assetManifestPath || value.boundingBox), {
  message: "assetManifestPath or boundingBox is required."
});

const forwardAxisSchema = z.enum(["+X", "-X", "+Y", "-Y", "+Z", "-Z"]);
const animationStateSchema = z.enum([
  "idle", "breathing", "walk", "run", "wave", "attack", "jump", "bounce", "talk",
  "turn_left", "turn_right", "happy", "sad", "angry", "surprised", "tool_swing"
]);
const controlActionSchema = z.enum([
  "moveForward", "moveBackward", "strafeLeft", "strafeRight", "turnLeft", "turnRight",
  "jump", "attack", "wave", "interact", "brake", "accelerate", "steerLeft", "steerRight"
]);
const controlContractSchema = z.record(z.string().min(1).max(32), controlActionSchema);
const validate3dAnimationControlsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  assetManifestPath: z.string().min(1).max(240).optional(),
  modelKind: z.enum(["character", "vehicle", "toy", "prop"]).optional().default("character"),
  forwardAxis: forwardAxisSchema.optional().default("-Z"),
  desiredStates: z.array(animationStateSchema).min(1).max(24).optional().default(["idle", "walk"]),
  controlContract: controlContractSchema.optional().default({ W: "moveForward", A: "turnLeft", S: "moveBackward", D: "turnRight" }),
  cameraMode: z.enum(["fixed", "orbit", "third_person", "camera_relative"]).optional().default("third_person"),
  rootRotation: z.object({
    axis: forwardAxisSchema.optional(),
    yawDegrees: z.number().min(-1080).max(1080).optional().default(0),
    accumulates: z.boolean().optional().default(false)
  }).optional().default({}),
  partPivots: z.record(vectorTupleSchema).optional().default({}),
  attachments: z.array(z.object({
    name: z.string().min(1).max(80),
    attachTo: z.string().min(1).max(80),
    anchor: vectorTupleSchema.optional()
  })).max(40).optional().default([]),
  vehicle: z.object({
    steeringAxis: forwardAxisSchema.optional().default("+Y"),
    wheelSpinAxis: forwardAxisSchema.optional().default("+X"),
    wheelNames: z.array(z.string().min(1).max(80)).max(16).optional().default([])
  }).optional(),
  outputConfigPath: z.string().min(1).max(240).optional().default("three-d-game/animation-control-config.json"),
  outputModulePath: z.string().min(1).max(240).optional().default("three-d-game/animation-controller.js"),
  outputReportPath: z.string().min(1).max(240).optional().default("three-d-game/animation-validation-report.json")
});

const create3dSceneManifestInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  sceneName: z.string().min(1).max(160),
  objects: z.array(sceneObjectSchema).min(1).max(500),
  camera: z.object({
    type: z.enum(["perspective", "orthographic"]).optional().default("perspective"),
    position: vector3Schema,
    target: vector3Schema.optional(),
    fov: z.number().min(10).max(140).optional().default(60)
  }),
  controls: z.array(z.enum(["keyboard", "mouse", "touch", "gamepad", "orbit", "pointer_lock"])).min(1).max(6),
  performanceBudget: z.object({
    targetFps: z.number().int().min(15).max(240).optional().default(60),
    maxTriangles: z.number().int().min(1).max(20_000_000).optional().default(250_000),
    maxDrawCalls: z.number().int().min(1).max(100_000).optional().default(500)
  }).optional().default({}),
  outputPath: z.string().min(1).max(240).optional().default("three-d-game/scene-manifest.json")
});

const generateGameMapSpecInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  name: z.string().min(1).max(120),
  width: z.number().int().min(1).max(512),
  height: z.number().int().min(1).max(512),
  layers: z.array(z.object({
    name: z.string().min(1).max(80),
    tile: z.string().min(1).max(20).optional().default(".")
  })).min(1).max(20),
  obstacles: z.array(z.object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().min(1).max(512).optional().default(1),
    height: z.number().int().min(1).max(512).optional().default(1),
    tile: z.string().min(1).max(20).optional().default("#")
  })).max(500).optional().default([]),
  spawn: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }).optional(),
  goals: z.array(z.object({ x: z.number().int().min(0), y: z.number().int().min(0), id: z.string().min(1).max(80).optional() })).max(50).optional().default([]),
  outputPath: z.string().min(1).max(240).optional().default("three-d-game/map-spec.json")
});

const colliderSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.enum(["aabb", "sphere"]),
  position: vector3Schema,
  size: vector3Schema.optional(),
  radius: z.number().min(0).max(100_000).optional()
});

const testCollisionRulesInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  colliders: z.array(colliderSchema).min(2).max(300),
  expectedPairs: z.array(z.tuple([z.string(), z.string()])).max(1000).optional().default([]),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("three-d-game/collision-report.json")
});

const createGameLoopQaPlanInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  entryFile: z.string().min(1).max(240).optional().default("index.html"),
  states: z.array(z.string().min(1).max(80)).min(1).max(40),
  interactions: z.array(z.string().min(1).max(160)).min(1).max(80),
  requiredHooks: z.array(z.enum(["render_game_to_text", "advanceTime", "pause", "restart", "fullscreen"])).optional().default(["render_game_to_text", "advanceTime"]),
  outputPath: z.string().min(1).max(240).optional().default("three-d-game/game-loop-qa-plan.json")
});

const createCameraControlTestPlanInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  controls: z.array(z.enum(["keyboard", "mouse", "touch", "gamepad", "orbit", "pointer_lock"])).min(1).max(6),
  cameraModes: z.array(z.enum(["first_person", "third_person", "top_down", "orbit", "side_scroll", "fixed"])).min(1).max(8),
  viewports: z.array(z.object({ width: z.number().int().min(240).max(7680), height: z.number().int().min(240).max(4320) })).max(20).optional().default([{ width: 390, height: 844 }, { width: 1440, height: 900 }]),
  outputPath: z.string().min(1).max(240).optional().default("three-d-game/camera-control-test-plan.json")
});

const profileGamePerformanceBudgetInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  targetFps: z.number().int().min(15).max(240).optional().default(60),
  triangles: z.number().int().min(0).max(50_000_000),
  drawCalls: z.number().int().min(0).max(200_000),
  textureMegabytes: z.number().min(0).max(20_000).optional().default(0),
  animatedObjects: z.number().int().min(0).max(100_000).optional().default(0),
  maxTriangles: z.number().int().min(1).max(50_000_000).optional().default(250_000),
  maxDrawCalls: z.number().int().min(1).max(200_000).optional().default(500),
  maxTextureMegabytes: z.number().min(1).max(20_000).optional().default(256),
  writeToProject: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("three-d-game/performance-budget-report.json")
});

const optimize3dAssetInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  assetPath: z.string().min(1).max(240),
  targetProfile: z.enum(["mobile_low", "mobile_mid", "mobile_pwa", "desktop"]).optional().default("mobile_pwa"),
  maxTextureSize: z.number().int().min(128).max(8192).optional(),
  preserveAnimations: z.boolean().optional().default(true),
  preserveNamedNodes: z.boolean().optional().default(true),
  removeUnused: z.boolean().optional().default(true),
  mergeCompatibleMaterials: z.boolean().optional().default(true),
  generateLods: z.boolean().optional().default(false),
  simplifyRatio: z.number().min(0.1).max(1).optional(),
  compression: z.array(z.enum(["meshopt", "draco", "texture", "quantization"])).max(4).optional().default(["texture", "meshopt"]),
  outputAssetPath: z.string().min(1).max(240).optional(),
  outputReportPath: z.string().min(1).max(240).optional().default("three-d-game/asset-optimization-report.json")
});

function glbHeader(buffer: Buffer): Record<string, unknown> {
  const warnings: string[] = [];
  if (buffer.length < 12) throw new Error("GLB asset is too small for a valid header.");
  if (buffer.subarray(0, 4).toString("ascii") !== "glTF") throw new Error("GLB asset has invalid magic bytes.");
  const version = buffer.readUInt32LE(4);
  const declaredLength = buffer.readUInt32LE(8);
  if (version !== 2) warnings.push(`Expected GLB version 2, found ${version}.`);
  if (declaredLength !== buffer.length) warnings.push(`Declared GLB length ${declaredLength} does not match file size ${buffer.length}.`);
  return { format: "glb", version, declaredLength, actualLength: buffer.length, warnings };
}

function summarizeGltfJson(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("GLTF JSON must be an object.");
  const doc = parsed as Record<string, unknown>;
  const asset = doc.asset as { version?: unknown } | undefined;
  if (!asset || typeof asset.version !== "string") throw new Error("GLTF asset.version is required.");
  const arrayCount = (key: string) => Array.isArray(doc[key]) ? (doc[key] as unknown[]).length : 0;
  const warnings: string[] = [];
  if (asset.version !== "2.0") warnings.push(`Expected glTF 2.0, found ${asset.version}.`);
  if (arrayCount("scenes") === 0) warnings.push("No scenes declared.");
  if (arrayCount("nodes") === 0) warnings.push("No nodes declared.");
  return {
    format: "gltf",
    version: asset.version,
    scenes: arrayCount("scenes"),
    nodes: arrayCount("nodes"),
    meshes: arrayCount("meshes"),
    materials: arrayCount("materials"),
    animations: arrayCount("animations"),
    cameras: arrayCount("cameras"),
    warnings
  };
}

async function validateAsset(ctx: ToolContext, projectId: string, assetPath: string, maxBytes: number): Promise<Record<string, unknown>> {
  const extension = path.extname(assetPath).toLowerCase();
  if (extension !== ".glb" && extension !== ".gltf") throw new Error("assetPath must end with .glb or .gltf.");
  const absolutePath = await getProjectStoredFilePath(ctx.projectRoot, projectId, assetPath);
  const buffer = await readFile(absolutePath);
  if (buffer.length > maxBytes) throw new Error(`Asset is too large. Size=${buffer.length}, maxBytes=${maxBytes}.`);
  if (extension === ".gltf") {
    return { projectId, assetPath, ...summarizeGltfJson(JSON.parse(buffer.toString("utf8"))) };
  }
  return { projectId, assetPath, ...glbHeader(buffer) };
}

type GltfDoc = Record<string, unknown>;

interface AssetBytes {
  sourceLabel: string;
  baseDirectory: string;
  bytes: Buffer;
  size: number;
}

interface BinarySource {
  uri?: string;
  bytes?: Buffer;
  byteLength?: number;
}

function resolveWorkspaceAssetPath(workspaceRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("workspace assetPath must be relative.");
  const normalized = path.normalize(relativePath);
  const parts = normalized.split(path.sep).filter(Boolean);
  if (!parts.length) throw new Error("workspace assetPath must include a filename.");
  if (parts.some((part) => part === ".." || part.startsWith("."))) throw new Error("Parent traversal and hidden path segments are not allowed.");
  const absolute = path.resolve(workspaceRoot, normalized);
  const root = path.resolve(workspaceRoot);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("workspace assetPath resolves outside workspaceRoot.");
  return absolute;
}

async function load3dAssetBytes(ctx: ToolContext, input: z.infer<typeof inspect3dAssetInputSchema>): Promise<AssetBytes> {
  const source = input.source ?? (input.projectId ? "project" : "workspace");
  const absolutePath = source === "project"
    ? await getProjectStoredFilePath(ctx.projectRoot, input.projectId!, input.assetPath)
    : resolveWorkspaceAssetPath(ctx.workspaceRoot, input.assetPath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error("assetPath must point to a file.");
  if (fileStat.size > input.maxBytes) throw new Error(`Asset is too large. Size=${fileStat.size}, maxBytes=${input.maxBytes}.`);
  return { sourceLabel: source === "project" ? input.assetPath : path.relative(ctx.workspaceRoot, absolutePath), baseDirectory: path.dirname(absolutePath), bytes: await readFile(absolutePath), size: fileStat.size };
}

function parseGlb(buffer: Buffer): { json: GltfDoc; bin?: Buffer; warnings: string[]; chunks: Array<{ type: string; byteLength: number }> } {
  const header = glbHeader(buffer) as { warnings: string[] };
  let offset = 12;
  let json: GltfDoc | undefined;
  let bin: Buffer | undefined;
  const chunks: Array<{ type: string; byteLength: number }> = [];
  while (offset + 8 <= buffer.length) {
    const byteLength = buffer.readUInt32LE(offset);
    const typeCode = buffer.readUInt32LE(offset + 4);
    offset += 8;
    const chunk = buffer.subarray(offset, offset + byteLength);
    offset += byteLength;
    const type = typeCode === 0x4e4f534a ? "JSON" : typeCode === 0x004e4942 ? "BIN" : `0x${typeCode.toString(16)}`;
    chunks.push({ type, byteLength });
    if (type === "JSON") json = JSON.parse(chunk.toString("utf8").trim()) as GltfDoc;
    if (type === "BIN") bin = chunk;
  }
  if (!json) throw new Error("GLB has no JSON chunk.");
  return { json, bin, warnings: header.warnings, chunks };
}

function arrayAt<T = Record<string, unknown>>(doc: GltfDoc, key: string): T[] {
  return Array.isArray(doc[key]) ? doc[key] as T[] : [];
}

function objectAt(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringAt(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function accessorComponentCount(type: unknown): number {
  return type === "VEC2" ? 2 : type === "VEC3" ? 3 : type === "VEC4" || type === "MAT2" ? 4 : type === "MAT3" ? 9 : type === "MAT4" ? 16 : 1;
}

function accessorComponentBytes(componentType: unknown): number {
  return componentType === 5120 || componentType === 5121 ? 1
    : componentType === 5122 || componentType === 5123 ? 2
      : componentType === 5125 || componentType === 5126 ? 4
        : 0;
}

function primitiveTriangleCount(primitive: Record<string, unknown>, accessors: Record<string, unknown>[]): number {
  const mode = numberAt(primitive.mode) ?? 4;
  const indices = numberAt(primitive.indices);
  const attributes = objectAt(primitive.attributes);
  const positionAccessor = typeof attributes?.POSITION === "number" ? accessors[attributes.POSITION] : undefined;
  const indexAccessor = indices !== undefined ? accessors[indices] : undefined;
  const count = numberAt(indexAccessor?.count) ?? numberAt(positionAccessor?.count) ?? 0;
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function mergeBounds(bounds: { min: number[]; max: number[] } | undefined, accessor: Record<string, unknown> | undefined) {
  const min = Array.isArray(accessor?.min) ? accessor.min.filter((item): item is number => typeof item === "number") : undefined;
  const max = Array.isArray(accessor?.max) ? accessor.max.filter((item): item is number => typeof item === "number") : undefined;
  if (!min || !max || min.length < 3 || max.length < 3) return bounds;
  if (!bounds) return { min: min.slice(0, 3), max: max.slice(0, 3) };
  return {
    min: bounds.min.map((value, index) => Math.min(value, min[index])),
    max: bounds.max.map((value, index) => Math.max(value, max[index]))
  };
}

function textureDimensions(bytes: Buffer | undefined): { width?: number; height?: number; format?: string } {
  if (!bytes || bytes.length < 16) return {};
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: "png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5), format: "jpeg" };
      offset += 2 + length;
    }
    return { format: "jpeg" };
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { format: "webp" };
  return {};
}

function dataUriBytes(uri: string | undefined): Buffer | undefined {
  const match = uri?.match(/^data:([^;,]+)?;base64,(.+)$/);
  return match ? Buffer.from(match[2], "base64") : undefined;
}

async function maybeReadExternal(baseDirectory: string, uri: string | undefined, maxBytes: number): Promise<Buffer | undefined> {
  if (!uri || /^(?:https?:|\/\/|data:)/i.test(uri)) return dataUriBytes(uri);
  if (path.isAbsolute(uri) || uri.includes("..") || uri.split(/[\\/]/).some((part) => part.startsWith("."))) return undefined;
  const absolute = path.resolve(baseDirectory, uri);
  const base = path.resolve(baseDirectory);
  if (absolute !== base && !absolute.startsWith(`${base}${path.sep}`)) return undefined;
  const fileStat = await stat(absolute).catch(() => undefined);
  if (!fileStat?.isFile() || fileStat.size > maxBytes) return undefined;
  return readFile(absolute);
}

async function inspectGltfDocument(doc: GltfDoc, asset: AssetBytes, bin: Buffer | undefined, glbWarnings: string[]) {
  const warnings = [...glbWarnings];
  const recommendations: string[] = [];
  const accessors = arrayAt<Record<string, unknown>>(doc, "accessors");
  const bufferViews = arrayAt<Record<string, unknown>>(doc, "bufferViews");
  const buffers = arrayAt<Record<string, unknown>>(doc, "buffers");
  const meshes = arrayAt<Record<string, unknown>>(doc, "meshes");
  const nodes = arrayAt<Record<string, unknown>>(doc, "nodes");
  const materials = arrayAt<Record<string, unknown>>(doc, "materials");
  const images = arrayAt<Record<string, unknown>>(doc, "images");
  const textures = arrayAt<Record<string, unknown>>(doc, "textures");
  const animations = arrayAt<Record<string, unknown>>(doc, "animations");
  const skins = arrayAt<Record<string, unknown>>(doc, "skins");
  const missingExternalAssets: string[] = [];
  const externalAssets: string[] = [];

  const binarySources: BinarySource[] = await Promise.all(buffers.map(async (buffer, index) => {
    const uri = stringAt(buffer.uri);
    if (index === 0 && bin && !uri) return { bytes: bin, byteLength: numberAt(buffer.byteLength) };
    if (uri) {
      const bytes = await maybeReadExternal(asset.baseDirectory, uri, asset.size);
      externalAssets.push(uri);
      if (!bytes) missingExternalAssets.push(uri);
      return { uri, bytes, byteLength: numberAt(buffer.byteLength) };
    }
    return { byteLength: numberAt(buffer.byteLength) };
  }));

  const accessorByteLength = (accessor: Record<string, unknown>) => (numberAt(accessor.count) ?? 0) * accessorComponentCount(accessor.type) * accessorComponentBytes(accessor.componentType);
  const vertexCount = accessors.reduce((sum, accessor) => accessor.type === "VEC3" ? sum + (numberAt(accessor.count) ?? 0) : sum, 0);
  let triangleCount = 0;
  let boundingBox: { min: number[]; max: number[] } | undefined;
  const meshReports = meshes.map((mesh, meshIndex) => {
    const primitives = arrayAt<Record<string, unknown>>(mesh, "primitives");
    const primitiveReports = primitives.map((primitive) => {
      const attributes = objectAt(primitive.attributes);
      const positionIndex = typeof attributes?.POSITION === "number" ? attributes.POSITION : undefined;
      const positionAccessor = positionIndex !== undefined ? accessors[positionIndex] : undefined;
      const triangles = primitiveTriangleCount(primitive, accessors);
      triangleCount += triangles;
      boundingBox = mergeBounds(boundingBox, positionAccessor);
      return {
        material: primitive.material,
        mode: numberAt(primitive.mode) ?? 4,
        triangles,
        attributes: Object.keys(attributes ?? {}),
        vertexCount: numberAt(positionAccessor?.count) ?? 0,
        morphTargets: Array.isArray(primitive.targets) ? primitive.targets.length : 0
      };
    });
    return { index: meshIndex, name: stringAt(mesh.name) ?? `mesh_${meshIndex}`, primitiveCount: primitives.length, primitives: primitiveReports };
  });

  const nodeReports = nodes.map((node, index) => ({
    index,
    name: stringAt(node.name) ?? `node_${index}`,
    mesh: node.mesh,
    camera: node.camera,
    skin: node.skin,
    children: Array.isArray(node.children) ? node.children : [],
    translation: Array.isArray(node.translation) ? node.translation : [0, 0, 0],
    rotation: Array.isArray(node.rotation) ? node.rotation : [0, 0, 0, 1],
    scale: Array.isArray(node.scale) ? node.scale : [1, 1, 1]
  }));

  const materialReports = materials.map((material, index) => {
    const pbr = objectAt(material.pbrMetallicRoughness);
    const alphaMode = stringAt(material.alphaMode) ?? "OPAQUE";
    if (alphaMode !== "OPAQUE") warnings.push(`Material ${stringAt(material.name) ?? index} uses ${alphaMode} transparency.`);
    return { index, name: stringAt(material.name) ?? `material_${index}`, alphaMode, doubleSided: material.doubleSided === true, baseColorTexture: objectAt(pbr?.baseColorTexture)?.index, metallicRoughnessTexture: objectAt(pbr?.metallicRoughnessTexture)?.index, normalTexture: objectAt(material.normalTexture)?.index };
  });

  const textureReports = await Promise.all(textures.map(async (texture, index) => {
    const imageIndex = numberAt(texture.source);
    const image = imageIndex !== undefined ? images[imageIndex] : undefined;
    const imageUri = stringAt(image?.uri);
    let bytes = imageUri ? await maybeReadExternal(asset.baseDirectory, imageUri, asset.size) : dataUriBytes(imageUri);
    if (!bytes && typeof image?.bufferView === "number") {
      const view = bufferViews[image.bufferView];
      const buffer = typeof view?.buffer === "number" ? binarySources[view.buffer] : undefined;
      const offset = numberAt(view?.byteOffset) ?? 0;
      const length = numberAt(view?.byteLength) ?? 0;
      bytes = buffer?.bytes?.subarray(offset, offset + length);
    }
    if (imageUri) {
      externalAssets.push(imageUri);
      if (!bytes) missingExternalAssets.push(imageUri);
    }
    const dimensions = textureDimensions(bytes);
    if ((dimensions.width ?? 0) > 2048 || (dimensions.height ?? 0) > 2048) warnings.push(`Texture ${imageUri ?? index} exceeds 2048px on at least one side.`);
    return { index, name: stringAt(texture.name) ?? `texture_${index}`, image: imageUri ?? imageIndex, byteLength: bytes?.byteLength, ...dimensions };
  }));

  const animationReports = animations.map((animation, index) => {
    let duration = 0;
    for (const sampler of arrayAt<Record<string, unknown>>(animation, "samplers")) {
      const inputAccessor = typeof sampler.input === "number" ? accessors[sampler.input] : undefined;
      const max = Array.isArray(inputAccessor?.max) && typeof inputAccessor.max[0] === "number" ? inputAccessor.max[0] : 0;
      duration = Math.max(duration, max);
    }
    return { index, name: stringAt(animation.name) ?? `animation_${index}`, channelCount: arrayAt(animation, "channels").length, durationSeconds: duration };
  });

  const drawCallsEstimate = meshReports.reduce((sum, mesh) => sum + mesh.primitiveCount, 0);
  const textureMegabytes = textureReports.reduce((sum, texture) => sum + ((texture.byteLength ?? 0) / 1024 / 1024), 0);
  const mobileRiskScore = Math.min(100, Math.round(
    triangleCount / 5000
    + drawCallsEstimate / 4
    + textureMegabytes * 3
    + animationReports.length * 3
    + skins.reduce((sum, skin) => sum + (Array.isArray(skin.joints) ? skin.joints.length : 0), 0) / 10
  ));
  if (triangleCount > 250_000) recommendations.push("Reduce mesh complexity or add LODs for mobile.");
  if (drawCallsEstimate > 500) recommendations.push("Merge static meshes or reduce material splits to lower draw calls.");
  if (textureMegabytes > 128) recommendations.push("Resize or compress textures for mobile PWA delivery.");
  if (!boundingBox) warnings.push("No POSITION accessor bounds found; cannot compute bounding box.");
  const bboxSize = boundingBox ? boundingBox.max.map((value, index) => value - boundingBox!.min[index]) : undefined;
  if (bboxSize && Math.max(...bboxSize) > 100) recommendations.push("Model scale appears large; verify units and camera framing.");
  if (bboxSize && Math.max(...bboxSize) < 0.01) recommendations.push("Model scale appears tiny; verify units and camera near/far planes.");
  if (missingExternalAssets.length) warnings.push(`Missing or unreadable external asset(s): ${[...new Set(missingExternalAssets)].join(", ")}.`);
  if (recommendations.length === 0) recommendations.push("Asset is within default mobile inspection thresholds; still verify in a real browser scene.");

  return {
    format: "gltf",
    fileSizeBytes: asset.size,
    sceneGraph: nodeReports,
    meshReport: meshReports,
    materialReport: materialReports,
    textureReport: textureReports,
    animationClips: animationReports,
    vertexCount,
    triangleCount,
    drawCallsEstimate,
    boundingBox: boundingBox ? { ...boundingBox, size: bboxSize, center: boundingBox.min.map((value, index) => (value + boundingBox!.max[index]) / 2) } : undefined,
    pivot: "origin inferred from node transforms; inspect artist file for exact authored pivot.",
    scaleUnits: "unitless glTF coordinates",
    skeletons: skins.map((skin, index) => ({ index, name: stringAt(skin.name) ?? `skin_${index}`, boneCount: Array.isArray(skin.joints) ? skin.joints.length : 0 })),
    morphTargetCount: meshReports.reduce((sum, mesh) => sum + mesh.primitives.reduce((inner, primitive) => inner + primitive.morphTargets, 0), 0),
    buffers: buffers.map((buffer, index) => ({ index, uri: stringAt(buffer.uri), byteLength: numberAt(buffer.byteLength), loadedBytes: binarySources[index]?.bytes?.byteLength, estimatedAccessorBytes: accessors.filter((accessor) => {
      const view = typeof accessor.bufferView === "number" ? bufferViews[accessor.bufferView] : undefined;
      return view?.buffer === index;
    }).reduce((sum, accessor) => sum + accessorByteLength(accessor), 0) })),
    externalAssets: [...new Set(externalAssets)],
    missingExternalAssets: [...new Set(missingExternalAssets)],
    mobileRiskScore,
    mobileSafe: mobileRiskScore < 60 && triangleCount <= 250_000 && drawCallsEstimate <= 500 && textureMegabytes <= 128,
    warnings,
    recommendations
  };
}

function inspectObj(buffer: Buffer, asset: AssetBytes) {
  const text = buffer.toString("utf8");
  const vertices: number[][] = [];
  let faces = 0;
  const objects: string[] = [];
  const materials = new Set<string>();
  const externalAssets: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("v ")) {
      const nums = trimmed.split(/\s+/).slice(1, 4).map(Number);
      if (nums.every(Number.isFinite)) vertices.push(nums);
    } else if (trimmed.startsWith("f ")) {
      const count = trimmed.split(/\s+/).length - 1;
      faces += Math.max(0, count - 2);
    } else if (trimmed.startsWith("o ") || trimmed.startsWith("g ")) {
      objects.push(trimmed.slice(2).trim());
    } else if (trimmed.startsWith("usemtl ")) {
      materials.add(trimmed.slice(7).trim());
    } else if (trimmed.startsWith("mtllib ")) {
      externalAssets.push(trimmed.slice(7).trim());
    }
  }
  const min = vertices.reduce((acc, value) => acc.map((item, index) => Math.min(item, value[index])), [Infinity, Infinity, Infinity]);
  const max = vertices.reduce((acc, value) => acc.map((item, index) => Math.max(item, value[index])), [-Infinity, -Infinity, -Infinity]);
  const warnings = externalAssets.length ? ["OBJ material libraries are referenced but not parsed by this inspector."] : [];
  const recommendations = faces > 250_000 ? ["Simplify OBJ mesh before mobile use."] : ["Convert OBJ to GLB/GLTF for reliable materials, textures, and browser loading."];
  return {
    format: "obj",
    fileSizeBytes: asset.size,
    sceneGraph: objects.map((name, index) => ({ index, name, mesh: index })),
    meshReport: [{ index: 0, name: path.basename(asset.sourceLabel), primitiveCount: 1, primitives: [{ triangles: faces, attributes: ["POSITION"], vertexCount: vertices.length, morphTargets: 0 }] }],
    materialReport: [...materials].map((name, index) => ({ index, name })),
    textureReport: [],
    animationClips: [],
    vertexCount: vertices.length,
    triangleCount: faces,
    drawCallsEstimate: Math.max(1, materials.size || objects.length || 1),
    boundingBox: vertices.length ? { min, max, size: max.map((value, index) => value - min[index]), center: min.map((value, index) => (value + max[index]) / 2) } : undefined,
    pivot: "OBJ origin inferred from vertex coordinates.",
    scaleUnits: "unitless OBJ coordinates",
    skeletons: [],
    morphTargetCount: 0,
    externalAssets,
    missingExternalAssets: [],
    mobileRiskScore: Math.min(100, Math.round(faces / 5000 + Math.max(1, materials.size) / 4)),
    mobileSafe: faces <= 250_000,
    warnings,
    recommendations
  };
}

async function inspect3dAsset(ctx: ToolContext, input: z.infer<typeof inspect3dAssetInputSchema>) {
  const asset = await load3dAssetBytes(ctx, input);
  const extension = path.extname(asset.sourceLabel).toLowerCase();
  if (extension === ".glb") {
    const parsed = parseGlb(asset.bytes);
    return { source: input.source ?? (input.projectId ? "project" : "workspace"), assetPath: input.assetPath, ...(await inspectGltfDocument(parsed.json, asset, parsed.bin, parsed.warnings)), format: "glb", glbChunks: parsed.chunks };
  }
  if (extension === ".gltf") {
    const json = JSON.parse(asset.bytes.toString("utf8")) as GltfDoc;
    return { source: input.source ?? (input.projectId ? "project" : "workspace"), assetPath: input.assetPath, ...(await inspectGltfDocument(json, asset, undefined, [])) };
  }
  if (extension === ".obj") {
    return { source: input.source ?? "workspace", assetPath: input.assetPath, ...inspectObj(asset.bytes, asset) };
  }
  return {
    source: input.source ?? (input.projectId ? "project" : "workspace"),
    assetPath: input.assetPath,
    format: extension.replace(/^\./, "") || "unknown",
    fileSizeBytes: asset.size,
    warnings: [`Unsupported 3D asset extension ${extension || "(none)"}. Supported inspection: GLB, GLTF, OBJ.`],
    recommendations: ["Convert this asset to GLB/GLTF or OBJ before agent-side inspection."]
  };
}

type BlockyPart = {
  name: string;
  size: [number, number, number];
  position: [number, number, number];
  color: string;
  type?: string;
};

function blockyDefaults(input: z.infer<typeof generateBlockyCharacterInputSchema>): BlockyPart[] {
  const palette = {
    skin: input.palette.skin ?? "#f2c6a0",
    shirt: input.palette.shirt ?? "#2f80ed",
    pants: input.palette.pants ?? "#1b2a41",
    shoes: input.palette.shoes ?? "#222222",
    hair: input.palette.hair ?? "#3a2415",
    accessory: input.palette.accessory ?? "#c99a2e",
    base: input.palette.base ?? input.base.color ?? "#353941",
    eye: input.palette.eye ?? "#111111",
    mouth: input.palette.mouth ?? "#8a3a3a"
  };
  const defaults: Record<string, BlockyPart> = {
    head: { name: "head", size: [1, 1, 1], position: [0, 2.85, 0], color: palette.skin },
    body: { name: "body", size: [1.1, 1.35, 0.55], position: [0, 1.65, 0], color: palette.shirt },
    leftArm: { name: "leftArm", size: [0.35, 1.25, 0.35], position: [-0.78, 1.65, 0], color: palette.skin },
    rightArm: { name: "rightArm", size: [0.35, 1.25, 0.35], position: [0.78, 1.65, 0], color: palette.skin },
    leftLeg: { name: "leftLeg", size: [0.42, 1.2, 0.42], position: [-0.28, 0.42, 0], color: palette.pants },
    rightLeg: { name: "rightLeg", size: [0.42, 1.2, 0.42], position: [0.28, 0.42, 0], color: palette.pants },
    eyes: { name: "eyes", size: [0.62, 0.08, 0.04], position: [0, 2.95, -0.52], color: palette.eye },
    mouth: { name: "mouth", size: [0.38, 0.06, 0.04], position: [0, 2.68, -0.53], color: palette.mouth },
    hair: { name: "hair", size: [1.08, 0.24, 1.08], position: [0, 3.42, 0], color: palette.hair },
    shoes: { name: "shoes", size: [1.02, 0.18, 0.5], position: [0, -0.25, -0.02], color: palette.shoes }
  };
  if (input.base.type !== "none") defaults.basePlatform = { name: "basePlatform", size: input.base.type === "round_pedestal" ? [1.9, 0.25, 1.9] : [2.0, 0.22, 2.0], position: [0, -0.55, 0], color: palette.base, type: input.base.type };
  if (input.base.namePlate) defaults.namePlate = { name: "namePlate", size: [1.3, 0.22, 0.08], position: [0, -0.35, -1.02], color: input.palette.namePlate ?? "#f4d35e" };
  const parts = new Map<string, BlockyPart>(Object.entries(defaults).map(([name, part]) => [name, part]));
  for (const [name, part] of Object.entries(input.parts)) {
    if (!part.visible) {
      parts.delete(name);
      continue;
    }
    const existing = parts.get(name) ?? { name, size: [0.4, 0.4, 0.4] as [number, number, number], position: [0, 0, 0] as [number, number, number], color: palette.accessory };
    parts.set(name, {
      ...existing,
      size: part.size ?? existing.size,
      position: part.position ?? existing.position,
      color: part.color ?? existing.color,
      type: part.type ?? existing.type
    });
  }
  const accessoryPositions: Record<string, [number, number, number]> = {
    hat: [0, 3.62, 0],
    helmet: [0, 3.38, 0],
    hair: [0, 3.42, 0],
    backpack: [0, 1.55, 0.42],
    shield: [-1.05, 1.45, -0.05],
    weapon: [1.08, 1.08, -0.25],
    pickaxe: [1.08, 1.08, -0.25],
    sword: [1.08, 1.08, -0.25],
    staff: [1.08, 1.18, -0.25],
    pet: [1.35, 0.05, 0.45],
    badge: [0, 1.8, -0.31]
  };
  const accessorySizes: Record<string, [number, number, number]> = {
    hat: [1.15, 0.28, 1.15],
    helmet: [1.18, 0.55, 1.18],
    hair: [1.08, 0.24, 1.08],
    backpack: [0.75, 0.9, 0.28],
    shield: [0.45, 0.8, 0.12],
    weapon: [0.18, 1.15, 0.18],
    pickaxe: [0.2, 1.25, 0.2],
    sword: [0.16, 1.35, 0.12],
    staff: [0.16, 1.55, 0.16],
    pet: [0.45, 0.45, 0.45],
    badge: [0.28, 0.28, 0.05]
  };
  for (const accessory of input.accessories) {
    parts.set(accessory.name, {
      name: accessory.name,
      size: accessorySizes[accessory.type] ?? [0.35, 0.35, 0.35],
      position: accessoryPositions[accessory.type] ?? [0, 0, 0],
      color: accessory.color ?? palette.accessory,
      type: accessory.type
    });
  }
  return [...parts.values()];
}

function blockyBounds(parts: BlockyPart[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    for (let index = 0; index < 3; index += 1) {
      min[index] = Math.min(min[index], part.position[index] - part.size[index] / 2);
      max[index] = Math.max(max[index], part.position[index] + part.size[index] / 2);
    }
  }
  return { min, max, size: max.map((value, index) => Number((value - min[index]).toFixed(3))), center: min.map((value, index) => Number(((value + max[index]) / 2).toFixed(3))) };
}

function blockyAnchors(input: z.infer<typeof generateBlockyCharacterInputSchema>, parts: BlockyPart[]) {
  const bounds = blockyBounds(parts);
  return {
    neck: [0, 2.32, 0],
    leftShoulder: [-0.62, 2.08, 0],
    rightShoulder: [0.62, 2.08, 0],
    leftElbow: [-0.78, 1.45, 0],
    rightElbow: [0.78, 1.45, 0],
    hips: [0, 0.95, 0],
    leftKnee: [-0.28, 0.18, 0],
    rightKnee: [0.28, 0.18, 0],
    leftHand: [-0.78, 0.9, -0.05],
    rightHand: [0.78, 0.9, -0.05],
    leftFoot: [-0.28, -0.22, -0.02],
    rightFoot: [0.28, -0.22, -0.02],
    weaponMount: [1.08, 1.08, -0.25],
    forwardMarker: [0, bounds.center[1], bounds.min[2] - 0.25],
    ...input.animationAnchors
  };
}

function renderBlockyCharacterModule(characterName: string, style: string, parts: BlockyPart[], anchors: Record<string, unknown>) {
  const safeName = characterName.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
  return `import * as THREE from "three";

export const blockyCharacterManifest = ${JSON.stringify({ name: characterName, style, forwardDirection: "-Z", anchors }, null, 2)};
export const blockyCharacterParts = ${JSON.stringify(parts, null, 2)};

export function createBlockyCharacter(options = {}) {
  const group = new THREE.Group();
  group.name = options.name || "${safeName}";
  const materialCache = new Map();
  const materialFor = (color) => {
    if (!materialCache.has(color)) {
      materialCache.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.04 }));
    }
    return materialCache.get(color);
  };
  for (const part of blockyCharacterParts) {
    const geometry = new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]);
    const mesh = new THREE.Mesh(geometry, materialFor(part.color));
    mesh.name = part.name;
    mesh.position.set(part.position[0], part.position[1], part.position[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.partType = part.type || part.name;
    group.add(mesh);
  }
  group.userData.animationAnchors = blockyCharacterManifest.anchors;
  group.userData.forwardDirection = blockyCharacterManifest.forwardDirection;
  return group;
}
`;
}

function buildBlockyCharacter(input: z.infer<typeof generateBlockyCharacterInputSchema>) {
  const parts = blockyDefaults(input);
  const partNames = parts.map((part) => part.name);
  const required = ["head", "body", "leftArm", "rightArm", "leftLeg", "rightLeg"];
  const warnings = required.filter((name) => !partNames.includes(name)).map((name) => `Missing recommended body part: ${name}.`);
  const duplicatePartNames = partNames.filter((name, index) => partNames.indexOf(name) !== index);
  if (duplicatePartNames.length) warnings.push(`Duplicate part name(s): ${[...new Set(duplicatePartNames)].join(", ")}.`);
  const boundingBox = blockyBounds(parts);
  const anchors = blockyAnchors(input, parts);
  if (boundingBox.size[1] > 8 || boundingBox.size[1] < 1) warnings.push("Character scale is outside the recommended 1-8 unit height range.");
  const manifest = {
    name: input.name,
    style: input.style,
    expression: input.expression,
    partNames,
    parts,
    palette: input.palette,
    accessories: input.accessories,
    base: input.base,
    boundingBox,
    forwardDirection: "-Z",
    animationAnchors: anchors,
    validation: {
      ok: warnings.length === 0,
      warnings,
      trianglesEstimate: parts.length * 12,
      drawCallsEstimate: new Set(parts.map((part) => part.color)).size
    },
    recommendations: [
      "Use createBlockyCharacter() in a Three.js scene, then run inspect_3d_scene_visuals after rendering.",
      "Attach idle/wave/tool animations to named anchors instead of hard-coded coordinates."
    ],
    createdAt: new Date().toISOString()
  };
  return { manifest, moduleSource: renderBlockyCharacterModule(input.name, input.style, parts, anchors) };
}

function tupleFromUnknown(value: unknown): [number, number, number] | undefined {
  return Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every((item) => typeof item === "number" && Number.isFinite(item))
    ? [value[0], value[1], value[2]]
    : undefined;
}

function boundsFromObject(value: unknown): z.infer<typeof boundingBoxSchema> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    min: tupleFromUnknown(record.min),
    max: tupleFromUnknown(record.max),
    size: tupleFromUnknown(record.size),
    center: tupleFromUnknown(record.center)
  };
}

async function resolveSceneBounds(ctx: ToolContext, input: z.infer<typeof compose3dSceneInputSchema>) {
  if (input.boundingBox) return completeBounds(input.boundingBox);
  const raw = await readProjectFile(ctx.projectRoot, input.projectId, input.assetManifestPath!, 1024 * 1024);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const bounds = boundsFromObject(parsed.boundingBox) ?? boundsFromObject(parsed);
  if (!bounds) throw new Error("Manifest does not contain a usable boundingBox.");
  return completeBounds(bounds);
}

function completeBounds(bounds: z.infer<typeof boundingBoxSchema>) {
  const size = bounds.size ?? (bounds.min && bounds.max ? [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  ] as [number, number, number] : undefined);
  const center = bounds.center ?? (bounds.min && bounds.max ? [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2
  ] as [number, number, number] : [0, 0, 0]);
  if (!size || size.some((item) => item <= 0 || !Number.isFinite(item))) throw new Error("boundingBox.size must contain positive finite dimensions.");
  const min = bounds.min ?? [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2] as [number, number, number];
  const max = bounds.max ?? [center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2] as [number, number, number];
  return { min, max, size, center };
}

function lightingForStyle(style: z.infer<typeof compose3dSceneInputSchema>["style"]) {
  if (style === "night_showcase") {
    return {
      toneMapping: "ACESFilmicToneMapping",
      exposure: 1.25,
      ambient: { color: "#32425f", intensity: 0.55 },
      hemisphere: { skyColor: "#9fb8ff", groundColor: "#10121a", intensity: 0.65 },
      key: { type: "directional", color: "#f4f7ff", intensity: 2.2, position: [4, 6, 5], castShadow: true },
      rim: { type: "spot", color: "#8fd3ff", intensity: 1.1, position: [-4, 4, -3] },
      shadowStrength: 0.38
    };
  }
  if (style === "minimal_studio" || style === "product_showcase") {
    return {
      toneMapping: "ACESFilmicToneMapping",
      exposure: 1.05,
      ambient: { color: "#ffffff", intensity: 0.72 },
      hemisphere: { skyColor: "#f8fbff", groundColor: "#d7dce2", intensity: 0.85 },
      key: { type: "directional", color: "#ffffff", intensity: 1.75, position: [3.5, 5, 4], castShadow: true },
      rim: { type: "directional", color: "#d7e7ff", intensity: 0.65, position: [-3, 3, -4] },
      shadowStrength: 0.28
    };
  }
  return {
    toneMapping: "ACESFilmicToneMapping",
    exposure: 1.12,
    ambient: { color: "#ffffff", intensity: 0.68 },
    hemisphere: { skyColor: "#dff0ff", groundColor: "#d8d1c5", intensity: 0.78 },
    key: { type: "directional", color: "#ffffff", intensity: 1.9, position: [4, 6, 5], castShadow: true },
    rim: { type: "directional", color: "#b7d9ff", intensity: 0.75, position: [-4, 3, -3] },
    shadowStrength: 0.34
  };
}

function environmentForStyle(style: z.infer<typeof compose3dSceneInputSchema>["style"]) {
  const backgrounds: Record<string, string[]> = {
    collectible_toy_showcase: ["#f7f4ea", "#dfe8f4"],
    minecraft_collectible: ["#d9f0c8", "#8fc7ff"],
    product_showcase: ["#f7f8fb", "#d9dde7"],
    hero_select: ["#151a22", "#303846"],
    minimal_studio: ["#f8fafc", "#e5e7eb"],
    night_showcase: ["#0b1020", "#25304a"]
  };
  return {
    backgroundGradient: backgrounds[style] ?? backgrounds.collectible_toy_showcase,
    floor: { enabled: true, size: 12, color: style === "night_showcase" || style === "hero_select" ? "#20242c" : "#eef0ec", roughness: 0.82 },
    pedestal: { enabled: ["collectible_toy_showcase", "minecraft_collectible", "hero_select"].includes(style), radius: 1.25, height: 0.18, color: style === "hero_select" ? "#303846" : "#f3f0e8" },
    contactShadows: { enabled: true, opacity: style === "night_showcase" ? 0.42 : 0.28 },
    fog: { enabled: style === "night_showcase", color: "#0b1020", near: 10, far: 28 }
  };
}

function composeSceneConfig(input: z.infer<typeof compose3dSceneInputSchema>, bounds: ReturnType<typeof completeBounds>) {
  const warnings: string[] = [];
  const radius = Math.max(0.1, Math.hypot(bounds.size[0], bounds.size[1], bounds.size[2]) / 2);
  const maxDimension = Math.max(...bounds.size);
  const target: [number, number, number] = [bounds.center[0], bounds.center[1] + bounds.size[1] * 0.08, bounds.center[2]];
  const requestedRatio = (input.constraints.minModelScreenHeightRatio + input.constraints.maxModelScreenHeightRatio) / 2;
  const fov = input.style === "product_showcase" ? 42 : input.style === "hero_select" ? 48 : 45;
  const distance = Math.max(radius * 2.4, (bounds.size[1] / Math.max(0.2, requestedRatio)) / (2 * Math.tan((fov * Math.PI / 180) / 2)));
  const safeMinDistance = input.constraints.allowInteriorView ? radius * 0.45 : radius * 1.25;
  if (!input.constraints.allowInteriorView && distance <= radius) warnings.push("Computed camera distance is too close to bounding sphere; increased to safe distance.");
  if (maxDimension > 100) warnings.push("Model is very large; normalize scale or verify near/far clipping planes.");
  if (maxDimension < 0.05) warnings.push("Model is very small; normalize scale before visual QA.");
  if (input.constraints.minModelScreenHeightRatio > input.constraints.maxModelScreenHeightRatio) warnings.push("minModelScreenHeightRatio is greater than maxModelScreenHeightRatio.");
  const cameraPosition: [number, number, number] = [
    Number((target[0] + radius * 0.72).toFixed(3)),
    Number((target[1] + radius * 0.55).toFixed(3)),
    Number((target[2] + Math.max(distance, safeMinDistance)).toFixed(3))
  ];
  const portraitDistance = Math.max(distance * 1.18, safeMinDistance * 1.2);
  const landscapeDistance = Math.max(distance * 0.95, safeMinDistance * 1.1);
  const config = {
    sceneName: input.sceneName,
    style: input.style,
    modelBounds: bounds,
    modelRadius: Number(radius.toFixed(3)),
    cameraConfig: {
      type: "perspective",
      fov,
      near: Number(Math.max(0.01, radius / 120).toFixed(3)),
      far: Number(Math.max(100, radius * 18).toFixed(3)),
      position: cameraPosition,
      target,
      resetView: { position: cameraPosition, target }
    },
    controlConfig: {
      type: "OrbitControls",
      enableDamping: true,
      dampingFactor: 0.08,
      enablePan: input.constraints.enablePan,
      enableZoom: true,
      minDistance: Number(safeMinDistance.toFixed(3)),
      maxDistance: Number((radius * 6.5).toFixed(3)),
      minPolarAngle: Number((Math.PI * 0.08).toFixed(3)),
      maxPolarAngle: Number((Math.PI * 0.86).toFixed(3)),
      minAzimuthAngle: Number((-Math.PI * 0.95).toFixed(3)),
      maxAzimuthAngle: Number((Math.PI * 0.95).toFixed(3)),
      autoRotate: input.constraints.autoRotate,
      autoRotateSpeed: input.constraints.autoRotate ? 0.65 : 0
    },
    lightingConfig: lightingForStyle(input.style),
    environmentConfig: environmentForStyle(input.style),
    mobileFraming: {
      portrait: { position: [target[0], Number((target[1] + radius * 0.5).toFixed(3)), Number((target[2] + portraitDistance).toFixed(3))], target, fov: Math.min(58, fov + 6), safeAreaPadding: { top: 72, right: 18, bottom: 72, left: 18 } },
      landscape: { position: [Number((target[0] + radius * 0.55).toFixed(3)), Number((target[1] + radius * 0.42).toFixed(3)), Number((target[2] + landscapeDistance).toFixed(3))], target, fov, safeAreaPadding: { top: 28, right: 96, bottom: 28, left: 96 } },
      avoidUiPanels: input.constraints.avoidUiPanels
    },
    noInteriorConstraint: {
      enabled: !input.constraints.allowInteriorView,
      boundingSphereRadius: Number(radius.toFixed(3)),
      minCameraDistance: Number(safeMinDistance.toFixed(3)),
      nearPlane: Number(Math.max(0.01, radius / 120).toFixed(3))
    },
    warnings
  };
  return config;
}

function renderSceneComposerModule(config: Record<string, unknown>) {
  return `import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export const composedSceneConfig = ${JSON.stringify(config, null, 2)};

export function createComposed3DScene({ canvas, renderer, model } = {}) {
  const scene = new THREE.Scene();
  const [bgTop, bgBottom] = composedSceneConfig.environmentConfig.backgroundGradient;
  scene.background = new THREE.Color(bgTop);
  const camera = new THREE.PerspectiveCamera(
    composedSceneConfig.cameraConfig.fov,
    canvas ? canvas.clientWidth / Math.max(canvas.clientHeight, 1) : 16 / 9,
    composedSceneConfig.cameraConfig.near,
    composedSceneConfig.cameraConfig.far
  );
  camera.position.fromArray(composedSceneConfig.cameraConfig.position);
  const target = new THREE.Vector3().fromArray(composedSceneConfig.cameraConfig.target);
  camera.lookAt(target);
  const activeRenderer = renderer || (canvas ? new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false }) : undefined);
  if (activeRenderer) {
    activeRenderer.shadowMap.enabled = true;
    activeRenderer.toneMapping = THREE[composedSceneConfig.lightingConfig.toneMapping] || THREE.ACESFilmicToneMapping;
    activeRenderer.toneMappingExposure = composedSceneConfig.lightingConfig.exposure;
  }
  const ambient = new THREE.AmbientLight(composedSceneConfig.lightingConfig.ambient.color, composedSceneConfig.lightingConfig.ambient.intensity);
  scene.add(ambient);
  const hemi = new THREE.HemisphereLight(composedSceneConfig.lightingConfig.hemisphere.skyColor, composedSceneConfig.lightingConfig.hemisphere.groundColor, composedSceneConfig.lightingConfig.hemisphere.intensity);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(composedSceneConfig.lightingConfig.key.color, composedSceneConfig.lightingConfig.key.intensity);
  key.position.fromArray(composedSceneConfig.lightingConfig.key.position);
  key.castShadow = Boolean(composedSceneConfig.lightingConfig.key.castShadow);
  scene.add(key);
  const rim = new THREE.DirectionalLight(composedSceneConfig.lightingConfig.rim.color, composedSceneConfig.lightingConfig.rim.intensity);
  rim.position.fromArray(composedSceneConfig.lightingConfig.rim.position);
  scene.add(rim);
  if (composedSceneConfig.environmentConfig.floor.enabled) {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(composedSceneConfig.environmentConfig.floor.size, 96),
      new THREE.MeshStandardMaterial({ color: composedSceneConfig.environmentConfig.floor.color, roughness: composedSceneConfig.environmentConfig.floor.roughness })
    );
    floor.name = "composed-floor";
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = composedSceneConfig.modelBounds.min[1] - 0.02;
    floor.receiveShadow = true;
    scene.add(floor);
  }
  if (model) scene.add(model);
  let controls;
  if (activeRenderer) {
    controls = new OrbitControls(camera, activeRenderer.domElement);
    Object.assign(controls, composedSceneConfig.controlConfig);
    controls.target.copy(target);
    controls.update();
  }
  return { scene, camera, renderer: activeRenderer, controls, config: composedSceneConfig };
}
`;
}

async function compose3dScene(ctx: ToolContext, input: z.infer<typeof compose3dSceneInputSchema>) {
  const bounds = await resolveSceneBounds(ctx, input);
  const config = composeSceneConfig(input, bounds);
  const moduleSource = renderSceneComposerModule(config);
  return { config, moduleSource };
}

async function readAnimationManifest(ctx: ToolContext, input: z.infer<typeof validate3dAnimationControlsInputSchema>) {
  if (!input.assetManifestPath) return {};
  const raw = await readProjectFile(ctx.projectRoot, input.projectId, input.assetManifestPath, 1024 * 1024);
  return JSON.parse(raw) as Record<string, unknown>;
}

function forwardAxisVector(axis: z.infer<typeof forwardAxisSchema>): [number, number, number] {
  const sign = axis.startsWith("-") ? -1 : 1;
  const key = axis.slice(1);
  return key === "X" ? [sign, 0, 0] : key === "Y" ? [0, sign, 0] : [0, 0, sign];
}

function oppositeAxis(axis: z.infer<typeof forwardAxisSchema>): z.infer<typeof forwardAxisSchema> {
  return (axis.startsWith("-") ? `+${axis.slice(1)}` : `-${axis.slice(1)}`) as z.infer<typeof forwardAxisSchema>;
}

function normalizeControlKeys(contract: Record<string, z.infer<typeof controlActionSchema>>) {
  return Object.fromEntries(Object.entries(contract).map(([key, action]) => [key.toUpperCase(), action])) as Record<string, z.infer<typeof controlActionSchema>>;
}

function animationDefinitionForState(state: z.infer<typeof animationStateSchema>, anchors: Record<string, unknown>) {
  const anchorNames = new Set(Object.keys(anchors));
  const needs = (names: string[]) => names.filter((name) => !anchorNames.has(name));
  const common = { durationSeconds: 1, returnsToNeutral: true, warnings: [] as string[] };
  if (state === "walk" || state === "run") {
    return {
      ...common,
      durationSeconds: state === "run" ? 0.55 : 0.9,
      channels: [
        { target: "leftLeg", property: "rotation.x", keyframes: [[0, -0.35], [0.5, 0.35], [1, -0.35]] },
        { target: "rightLeg", property: "rotation.x", keyframes: [[0, 0.35], [0.5, -0.35], [1, 0.35]] },
        { target: "leftArm", property: "rotation.x", keyframes: [[0, 0.25], [0.5, -0.25], [1, 0.25]] },
        { target: "rightArm", property: "rotation.x", keyframes: [[0, -0.25], [0.5, 0.25], [1, -0.25]] }
      ],
      warnings: needs(["leftLeg", "rightLeg", "leftArm", "rightArm"]).map((name) => `State ${state} needs anchor or part ${name}.`)
    };
  }
  if (state === "wave") {
    return {
      ...common,
      durationSeconds: 1.1,
      channels: [{ target: "rightArm", property: "rotation.z", keyframes: [[0, -0.2], [0.5, -1.0], [1, -0.2]] }],
      warnings: needs(["rightShoulder", "rightHand"]).map((name) => `State wave needs ${name} for believable pivoting.`)
    };
  }
  if (state === "attack" || state === "tool_swing") {
    return {
      ...common,
      durationSeconds: 0.7,
      channels: [
        { target: "rightArm", property: "rotation.x", keyframes: [[0, -0.1], [0.45, -1.15], [1, -0.1]] },
        { target: "tool", property: "rotation.x", keyframes: [[0, 0], [0.45, -1.2], [1, 0]] }
      ],
      warnings: needs(["rightShoulder", "weaponMount"]).map((name) => `State ${state} needs ${name}; weapons may detach without it.`)
    };
  }
  if (state === "jump" || state === "bounce") {
    return { ...common, durationSeconds: 0.8, channels: [{ target: "root", property: "position.y", keyframes: [[0, 0], [0.45, 0.45], [1, 0]] }], warnings: [] };
  }
  if (state === "turn_left" || state === "turn_right") {
    const sign = state === "turn_left" ? 1 : -1;
    return { ...common, durationSeconds: 0.45, channels: [{ target: "root", property: "rotation.y", keyframes: [[0, 0], [1, sign * Math.PI / 2]] }], warnings: [] };
  }
  if (state === "talk") {
    return { ...common, durationSeconds: 0.5, channels: [{ target: "mouth", property: "scale.y", keyframes: [[0, 1], [0.5, 1.8], [1, 1]] }], warnings: needs(["mouth"]).map((name) => `State talk needs ${name}.`) };
  }
  return { ...common, durationSeconds: 1.2, channels: [{ target: "root", property: "scale.y", keyframes: [[0, 1], [0.5, 1.02], [1, 1]] }], warnings: [] };
}

function validateAnimationControls(input: z.infer<typeof validate3dAnimationControlsInputSchema>, manifest: Record<string, unknown>) {
  const warnings: string[] = [];
  const suggestedFixes: string[] = [];
  const manifestForward = typeof manifest.forwardDirection === "string" ? manifest.forwardDirection : undefined;
  if (manifestForward && manifestForward !== input.forwardAxis) {
    warnings.push(`Input forwardAxis ${input.forwardAxis} does not match manifest forwardDirection ${manifestForward}.`);
    suggestedFixes.push(`Use forwardAxis=${manifestForward} or rotate the model root once during import.`);
  }
  if (input.rootRotation.axis && input.rootRotation.axis !== input.forwardAxis) warnings.push(`rootRotation.axis ${input.rootRotation.axis} differs from forwardAxis ${input.forwardAxis}.`);
  if (input.rootRotation.accumulates) {
    warnings.push("rootRotation.accumulates=true can cause drift after repeated turn animations.");
    suggestedFixes.push("Store heading as a single yaw value and set root.rotation.y from that value each frame.");
  }
  if (Math.abs(input.rootRotation.yawDegrees) % 360 === 180) warnings.push("Root yaw is 180 degrees; forward movement may face backward.");
  if (Math.abs(input.rootRotation.yawDegrees) % 180 === 90) warnings.push("Root yaw is 90 degrees; avatar may walk sideways unless movement vector is rotated.");

  const controls = normalizeControlKeys(input.controlContract);
  const controlWarnings: string[] = [];
  if (controls.W && controls.W !== "moveForward" && controls.W !== "accelerate") controlWarnings.push(`W maps to ${controls.W}; expected moveForward or accelerate.`);
  if (controls.S && controls.S !== "moveBackward" && controls.S !== "brake") controlWarnings.push(`S maps to ${controls.S}; expected moveBackward or brake.`);
  if (controls.A && !["turnLeft", "strafeLeft", "steerLeft"].includes(controls.A)) controlWarnings.push(`A maps to ${controls.A}; expected a left action.`);
  if (controls.D && !["turnRight", "strafeRight", "steerRight"].includes(controls.D)) controlWarnings.push(`D maps to ${controls.D}; expected a right action.`);
  if (controls.A === "turnRight" || controls.A === "steerRight") controlWarnings.push("A turns right; left/right controls are inverted.");
  if (controls.D === "turnLeft" || controls.D === "steerLeft") controlWarnings.push("D turns left; left/right controls are inverted.");
  warnings.push(...controlWarnings);
  if (input.cameraMode === "camera_relative" && !["strafeLeft", "strafeRight", "moveForward"].some((action) => Object.values(controls).includes(action as z.infer<typeof controlActionSchema>))) warnings.push("camera_relative mode needs movement actions resolved against camera forward/right vectors.");

  const anchors = objectAt(manifest.animationAnchors) ?? objectAt(manifest.anchors) ?? {};
  const partTargets = Array.isArray(manifest.partNames)
    ? Object.fromEntries(manifest.partNames.filter((name): name is string => typeof name === "string").map((name) => [name, true]))
    : {};
  const suppliedPivots = input.partPivots;
  const mergedAnchors = { ...partTargets, ...anchors, ...suppliedPivots };
  const pivotWarnings: string[] = [];
  for (const [name, point] of Object.entries(suppliedPivots)) {
    if (!tupleFromUnknown(point)) pivotWarnings.push(`Pivot ${name} is not a valid [x,y,z] tuple.`);
  }
  for (const attachment of input.attachments) {
    if (!attachment.anchor && !tupleFromUnknown(mergedAnchors[attachment.attachTo])) pivotWarnings.push(`Attachment ${attachment.name} has no anchor for ${attachment.attachTo}; it may detach during animation.`);
  }
  warnings.push(...pivotWarnings);

  const stateValidation = input.desiredStates.map((state) => {
    const definition = animationDefinitionForState(state, mergedAnchors);
    warnings.push(...definition.warnings);
    return { state, ok: definition.warnings.length === 0 && definition.returnsToNeutral, ...definition };
  });
  const nonNeutralStates = stateValidation.filter((state) => !state.returnsToNeutral).map((state) => state.state);
  if (nonNeutralStates.length) warnings.push(`Animation state(s) do not return to neutral pose: ${nonNeutralStates.join(", ")}.`);

  const vehicleWarnings: string[] = [];
  if (input.modelKind === "vehicle") {
    const vehicle = input.vehicle ?? { steeringAxis: "+Y" as const, wheelSpinAxis: "+X" as const, wheelNames: [] };
    if (![oppositeAxis(input.forwardAxis), input.forwardAxis].includes(vehicle.wheelSpinAxis)) vehicleWarnings.push(`wheelSpinAxis ${vehicle.wheelSpinAxis} may not roll along forwardAxis ${input.forwardAxis}.`);
    if (controls.A && controls.A !== "steerLeft") vehicleWarnings.push("Vehicle A key should map to steerLeft.");
    if (controls.D && controls.D !== "steerRight") vehicleWarnings.push("Vehicle D key should map to steerRight.");
    if (vehicle.wheelNames.length === 0) vehicleWarnings.push("Vehicle wheelNames is empty; wheel rotation direction cannot be validated per wheel.");
  }
  warnings.push(...vehicleWarnings);
  if (suggestedFixes.length === 0 && warnings.length) suggestedFixes.push("Align imported model forward axis, root yaw, and keyboard action contract before final browser QA.");
  if (suggestedFixes.length === 0) suggestedFixes.push("Run the generated preview sequence in-browser and verify W/A/D motion against the camera.");

  const animationConfig = {
    modelKind: input.modelKind,
    forwardAxis: input.forwardAxis,
    forwardVector: forwardAxisVector(input.forwardAxis),
    cameraMode: input.cameraMode,
    rootRotation: input.rootRotation,
    controls,
    states: Object.fromEntries(stateValidation.map((state) => [state.state, { durationSeconds: state.durationSeconds, channels: state.channels, returnsToNeutral: state.returnsToNeutral }])),
    attachments: input.attachments,
    vehicle: input.modelKind === "vehicle" ? input.vehicle ?? { steeringAxis: "+Y", wheelSpinAxis: "+X", wheelNames: [] } : undefined
  };
  const previewFrames = input.desiredStates.slice(0, 8).flatMap((state) => [0, 0.5, 1].map((phase) => ({ state, phase, rootForwardVector: forwardAxisVector(input.forwardAxis), neutralExpected: phase === 1 })));
  const report = {
    ok: warnings.length === 0,
    orientationReport: {
      manifestForwardDirection: manifestForward,
      configuredForwardAxis: input.forwardAxis,
      forwardVector: forwardAxisVector(input.forwardAxis),
      rootYawDegrees: input.rootRotation.yawDegrees,
      possibleSidewaysWalk: Math.abs(input.rootRotation.yawDegrees) % 180 === 90,
      possibleBackwardForward: Math.abs(input.rootRotation.yawDegrees) % 360 === 180
    },
    controlMappingReport: { controls, cameraMode: input.cameraMode, warnings: controlWarnings },
    pivotWarnings,
    vehicleReport: input.modelKind === "vehicle" ? { vehicle: animationConfig.vehicle, warnings: vehicleWarnings } : undefined,
    stateValidation,
    previewFrames,
    warnings,
    suggestedFixes
  };
  return { animationConfig, report };
}

function renderAnimationControllerModule(config: Record<string, unknown>) {
  return `import * as THREE from "three";

export const animationControlConfig = ${JSON.stringify(config, null, 2)};

export function createAnimationController(root, options = {}) {
  const clock = options.clock || new THREE.Clock();
  let activeState = options.initialState || "idle";
  let elapsed = 0;
  const parts = new Map();
  root?.traverse?.((node) => {
    if (node.name) parts.set(node.name, node);
  });
  const neutral = new Map();
  for (const [name, node] of parts) {
    neutral.set(name, {
      position: node.position?.clone?.(),
      rotation: node.rotation?.clone?.(),
      scale: node.scale?.clone?.()
    });
  }
  function applyChannel(channel, phase) {
    const node = channel.target === "root" ? root : parts.get(channel.target);
    if (!node) return;
    const keys = channel.keyframes || [];
    const current = keys.reduce((last, key) => key[0] <= phase ? key : last, keys[0] || [0, 0]);
    const value = current[1] || 0;
    const [property, axis] = channel.property.split(".");
    if (node[property] && axis) node[property][axis] = value;
  }
  function resetPose() {
    for (const [name, pose] of neutral) {
      const node = parts.get(name);
      if (!node) continue;
      if (pose.position) node.position.copy(pose.position);
      if (pose.rotation) node.rotation.copy(pose.rotation);
      if (pose.scale) node.scale.copy(pose.scale);
    }
  }
  return {
    get state() { return activeState; },
    setState(state) {
      if (!animationControlConfig.states[state]) throw new Error("Unknown animation state: " + state);
      activeState = state;
      elapsed = 0;
      resetPose();
    },
    update(delta = clock.getDelta()) {
      const state = animationControlConfig.states[activeState] || animationControlConfig.states.idle;
      if (!state) return;
      elapsed += delta;
      const phase = state.durationSeconds > 0 ? (elapsed % state.durationSeconds) / state.durationSeconds : 0;
      resetPose();
      for (const channel of state.channels || []) applyChannel(channel, phase);
    },
    directionVector() {
      return new THREE.Vector3().fromArray(animationControlConfig.forwardVector);
    },
    controls: animationControlConfig.controls,
    resetPose
  };
}
`;
}

async function validate3dAnimationControls(ctx: ToolContext, input: z.infer<typeof validate3dAnimationControlsInputSchema>) {
  const manifest = await readAnimationManifest(ctx, input);
  const { animationConfig, report } = validateAnimationControls(input, manifest);
  return {
    animationConfig,
    report,
    moduleSource: renderAnimationControllerModule(animationConfig)
  };
}

function sceneIssues(objects: Array<z.infer<typeof sceneObjectSchema>>, budget: { targetFps: number; maxTriangles: number; maxDrawCalls: number }): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const object of objects) {
    if (ids.has(object.id)) issues.push(`Duplicate object id: ${object.id}.`);
    ids.add(object.id);
    if (object.type === "mesh" && !object.assetPath) issues.push(`Mesh ${object.id} is missing assetPath.`);
    if (object.collider === "mesh") issues.push(`Object ${object.id} uses mesh collider; prefer primitive colliders for runtime performance.`);
  }
  const triangles = objects.reduce((sum, object) => sum + (object.triangles ?? 0), 0);
  const drawCalls = objects.filter((object) => object.type === "mesh" || object.type === "terrain").length;
  if (triangles > budget.maxTriangles) issues.push(`Triangle estimate ${triangles} exceeds budget ${budget.maxTriangles}.`);
  if (drawCalls > budget.maxDrawCalls) issues.push(`Draw call estimate ${drawCalls} exceeds budget ${budget.maxDrawCalls}.`);
  return issues;
}

function mapRows(width: number, height: number, fill: string, obstacles: Array<z.infer<typeof generateGameMapSpecInputSchema>["obstacles"][number]>, goals: Array<{ x: number; y: number; id?: string }>, spawn?: { x: number; y: number }): string[] {
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => fill));
  const put = (x: number, y: number, tile: string) => {
    if (x >= 0 && x < width && y >= 0 && y < height) grid[y][x] = tile;
  };
  for (const obstacle of obstacles) {
    for (let y = obstacle.y; y < obstacle.y + obstacle.height; y += 1) {
      for (let x = obstacle.x; x < obstacle.x + obstacle.width; x += 1) put(x, y, obstacle.tile);
    }
  }
  for (const goal of goals) put(goal.x, goal.y, "G");
  if (spawn) put(spawn.x, spawn.y, "S");
  return grid.map((row) => row.join(""));
}

function intersects(a: z.infer<typeof colliderSchema>, b: z.infer<typeof colliderSchema>): boolean {
  if (a.type === "sphere" && b.type === "sphere") {
    const radius = (a.radius ?? 0) + (b.radius ?? 0);
    const dx = a.position.x - b.position.x;
    const dy = a.position.y - b.position.y;
    const dz = a.position.z - b.position.z;
    return dx * dx + dy * dy + dz * dz <= radius * radius;
  }
  const box = (item: z.infer<typeof colliderSchema>) => {
    if (item.type === "sphere") {
      const radius = item.radius ?? 0;
      return { min: { x: item.position.x - radius, y: item.position.y - radius, z: item.position.z - radius }, max: { x: item.position.x + radius, y: item.position.y + radius, z: item.position.z + radius } };
    }
    const size = item.size ?? { x: 0, y: 0, z: 0 };
    return { min: item.position, max: { x: item.position.x + size.x, y: item.position.y + size.y, z: item.position.z + size.z } };
  };
  const left = box(a);
  const right = box(b);
  return left.min.x <= right.max.x && left.max.x >= right.min.x
    && left.min.y <= right.max.y && left.max.y >= right.min.y
    && left.min.z <= right.max.z && left.max.z >= right.min.z;
}

function collisionReport(colliders: Array<z.infer<typeof colliderSchema>>, expectedPairs: Array<[string, string]>): Record<string, unknown> {
  const actualPairs: Array<[string, string]> = [];
  for (let i = 0; i < colliders.length; i += 1) {
    for (let j = i + 1; j < colliders.length; j += 1) {
      if (intersects(colliders[i], colliders[j])) actualPairs.push([colliders[i].id, colliders[j].id]);
    }
  }
  const key = ([a, b]: [string, string]) => [a, b].sort().join("::");
  const actual = new Set(actualPairs.map(key));
  const expected = new Set(expectedPairs.map(key));
  const missingExpected = expectedPairs.filter((pair) => !actual.has(key(pair)));
  const unexpected = actualPairs.filter((pair) => !expected.has(key(pair)));
  return { colliderCount: colliders.length, actualPairs, expectedPairs, missingExpected, unexpected, ok: missingExpected.length === 0 && unexpected.length === 0 };
}

function optimizerProfile(input: z.infer<typeof optimize3dAssetInputSchema>) {
  const presets = {
    mobile_low: { maxTextureSize: 512, maxTriangles: 50_000, maxDrawCalls: 80, maxTextureMegabytes: 64, simplifyRatio: 0.45 },
    mobile_mid: { maxTextureSize: 1024, maxTriangles: 120_000, maxDrawCalls: 160, maxTextureMegabytes: 128, simplifyRatio: 0.65 },
    mobile_pwa: { maxTextureSize: 1024, maxTriangles: 90_000, maxDrawCalls: 120, maxTextureMegabytes: 96, simplifyRatio: 0.6 },
    desktop: { maxTextureSize: 2048, maxTriangles: 350_000, maxDrawCalls: 500, maxTextureMegabytes: 256, simplifyRatio: 0.85 }
  } as const;
  const preset = presets[input.targetProfile];
  return {
    ...preset,
    maxTextureSize: input.maxTextureSize ?? preset.maxTextureSize,
    simplifyRatio: input.simplifyRatio ?? preset.simplifyRatio
  };
}

function defaultOptimizedAssetPath(assetPath: string) {
  const extension = path.extname(assetPath);
  const base = path.basename(assetPath, extension);
  const normalizedExtension = extension || ".asset";
  return `three-d-game/optimized/${base}.optimized${normalizedExtension}`;
}

function textureMegabytesFromReport(report: Record<string, unknown>) {
  const textures = Array.isArray(report.textureReport) ? report.textureReport as Array<Record<string, unknown>> : [];
  return Number(textures.reduce((sum, texture) => {
    const width = typeof texture.width === "number" ? texture.width : 0;
    const height = typeof texture.height === "number" ? texture.height : 0;
    const bytes = typeof texture.byteLength === "number" ? texture.byteLength : width * height * 4;
    return sum + bytes / 1024 / 1024;
  }, 0).toFixed(3));
}

function optimizationMetrics(report: Record<string, unknown>, fileSizeBytes: number) {
  return {
    fileSizeBytes,
    triangleCount: typeof report.triangleCount === "number" ? report.triangleCount : 0,
    drawCallsEstimate: typeof report.drawCallsEstimate === "number" ? report.drawCallsEstimate : 0,
    textureMegabytes: textureMegabytesFromReport(report),
    animationClipCount: Array.isArray(report.animationClips) ? report.animationClips.length : 0,
    materialCount: Array.isArray(report.materialReport) ? report.materialReport.length : 0,
    textureCount: Array.isArray(report.textureReport) ? report.textureReport.length : 0
  };
}

function usedMaterialIndices(doc: GltfDoc) {
  const used = new Set<number>();
  for (const mesh of arrayAt<Record<string, unknown>>(doc, "meshes")) {
    for (const primitive of arrayAt<Record<string, unknown>>(mesh, "primitives")) {
      if (typeof primitive.material === "number") used.add(primitive.material);
    }
  }
  return used;
}

function collectMaterialTextureIndices(material: Record<string, unknown>, output: Set<number>) {
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.index === "number") output.add(record.index);
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(material);
}

function remapArray<T extends Record<string, unknown>>(items: T[], keep: Set<number>) {
  const remap = new Map<number, number>();
  const next: T[] = [];
  items.forEach((item, index) => {
    if (keep.has(index)) {
      remap.set(index, next.length);
      next.push(item);
    }
  });
  return { next, remap };
}

function optimizeGltfDocument(doc: GltfDoc, input: z.infer<typeof optimize3dAssetInputSchema>) {
  const optimized = JSON.parse(JSON.stringify(doc)) as GltfDoc;
  const changes: string[] = [];
  const visualRiskNotes: string[] = [];
  const profile = optimizerProfile(input);

  if (input.removeUnused) {
    if (!input.preserveAnimations && Array.isArray(optimized.animations) && optimized.animations.length) {
      changes.push(`Removed ${optimized.animations.length} animation clip(s).`);
      delete optimized.animations;
    }
    const nodes = arrayAt<Record<string, unknown>>(optimized, "nodes");
    if (nodes.length) {
      const keptNodes = nodes.filter((node) => {
        if (input.preserveNamedNodes && typeof node.name === "string" && node.name.length) return true;
        return typeof node.mesh === "number" || Array.isArray(node.children) || (!node.camera && !objectAt(node.extensions)?.KHR_lights_punctual);
      });
      if (keptNodes.length !== nodes.length) {
        optimized.nodes = keptNodes;
        changes.push(`Removed ${nodes.length - keptNodes.length} camera/light/helper node(s).`);
      }
    }
    if (Array.isArray(optimized.cameras) && optimized.cameras.length) {
      changes.push(`Removed ${optimized.cameras.length} camera definition(s).`);
      delete optimized.cameras;
    }
    const extensions = objectAt(optimized.extensions);
    const lights = objectAt(extensions?.KHR_lights_punctual);
    if (Array.isArray(lights?.lights)) {
      changes.push(`Removed ${lights.lights.length} punctual light definition(s).`);
      delete lights.lights;
    }
  }

  const materials = arrayAt<Record<string, unknown>>(optimized, "materials");
  const usedMaterials = usedMaterialIndices(optimized);
  if (input.removeUnused && materials.length) {
    const { next, remap } = remapArray(materials, usedMaterials.size ? usedMaterials : new Set(materials.map((_, index) => index)));
    if (next.length !== materials.length) {
      optimized.materials = next;
      for (const mesh of arrayAt<Record<string, unknown>>(optimized, "meshes")) {
        for (const primitive of arrayAt<Record<string, unknown>>(mesh, "primitives")) {
          if (typeof primitive.material === "number") primitive.material = remap.get(primitive.material) ?? 0;
        }
      }
      changes.push(`Removed ${materials.length - next.length} unused material(s).`);
    }
  }

  if (input.mergeCompatibleMaterials && Array.isArray(optimized.materials)) {
    const seen = new Map<string, number>();
    const remap = new Map<number, number>();
    const merged: Record<string, unknown>[] = [];
    optimized.materials.forEach((material, index) => {
      const key = JSON.stringify({ pbr: material.pbrMetallicRoughness, alphaMode: material.alphaMode ?? "OPAQUE", doubleSided: material.doubleSided === true });
      const existing = seen.get(key);
      if (existing !== undefined) remap.set(index, existing);
      else {
        seen.set(key, merged.length);
        remap.set(index, merged.length);
        merged.push(material);
      }
    });
    if (merged.length !== optimized.materials.length) {
      for (const mesh of arrayAt<Record<string, unknown>>(optimized, "meshes")) {
        for (const primitive of arrayAt<Record<string, unknown>>(mesh, "primitives")) {
          if (typeof primitive.material === "number") primitive.material = remap.get(primitive.material) ?? primitive.material;
        }
      }
      changes.push(`Merged ${optimized.materials.length - merged.length} compatible material(s).`);
      optimized.materials = merged;
    }
  }

  const textureIndices = new Set<number>();
  for (const material of arrayAt<Record<string, unknown>>(optimized, "materials")) collectMaterialTextureIndices(material, textureIndices);
  const textures = arrayAt<Record<string, unknown>>(optimized, "textures");
  if (input.removeUnused && textures.length) {
    const keepTextures = textureIndices.size ? textureIndices : new Set(textures.map((_, index) => index));
    const { next, remap } = remapArray(textures, keepTextures);
    if (next.length !== textures.length) {
      const rewriteTextureIndex = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          for (const item of value) rewriteTextureIndex(item);
          return;
        }
        const record = value as Record<string, unknown>;
        if (typeof record.index === "number") record.index = remap.get(record.index) ?? record.index;
        for (const nested of Object.values(record)) rewriteTextureIndex(nested);
      };
      for (const material of arrayAt<Record<string, unknown>>(optimized, "materials")) rewriteTextureIndex(material);
      optimized.textures = next;
      changes.push(`Removed ${textures.length - next.length} unused texture reference(s).`);
    }
  }

  if (input.compression.includes("quantization")) {
    optimized.extensionsUsed = [...new Set([...(Array.isArray(optimized.extensionsUsed) ? optimized.extensionsUsed : []), "KHR_mesh_quantization"])];
    changes.push("Enabled KHR_mesh_quantization metadata for compatible loaders.");
    visualRiskNotes.push("Quantization may slightly alter normals or vertex precision; compare silhouettes after export.");
  }
  if (input.compression.includes("meshopt")) {
    optimized.extensionsUsed = [...new Set([...(Array.isArray(optimized.extensionsUsed) ? optimized.extensionsUsed : []), "EXT_meshopt_compression"])];
    visualRiskNotes.push("Meshopt metadata was requested; run a meshopt-capable packer for binary buffer compression.");
  }
  if (input.compression.includes("draco")) visualRiskNotes.push("Draco compression requires an external encoder and matching DRACOLoader at runtime.");
  if (input.compression.includes("texture")) visualRiskNotes.push(`Resize/compress textures to ${profile.maxTextureSize}px max edge with KTX2/WebP in the asset pipeline.`);
  if (input.generateLods) changes.push(`Generated LOD plan for ${profile.simplifyRatio} and ${(profile.simplifyRatio * 0.5).toFixed(2)} mesh ratios.`);
  if (changes.length === 0) changes.push("No safe structural GLTF changes were available; report still includes optimization targets.");
  return { optimized, changes, visualRiskNotes };
}

function optimizeObjText(text: string, input: z.infer<typeof optimize3dAssetInputSchema>) {
  const ratio = optimizerProfile(input).simplifyRatio;
  const lines = text.split(/\r?\n/);
  let faceIndex = 0;
  let removedFaces = 0;
  const optimizedLines = lines.filter((line) => {
    if (!line.trim().startsWith("f ")) return true;
    faceIndex += 1;
    const keep = ratio >= 1 || (faceIndex % Math.max(1, Math.round(1 / ratio)) === 0);
    if (!keep) removedFaces += 1;
    return keep;
  });
  return {
    text: `${optimizedLines.join("\n").trimEnd()}\n`,
    changes: removedFaces ? [`Removed ${removedFaces} OBJ face line(s) using deterministic ${ratio} simplify ratio.`] : ["OBJ face count already fits the requested simplify ratio."],
    visualRiskNotes: removedFaces ? ["OBJ simplification is topology-blind; inspect silhouette and UV seams before final delivery."] : []
  };
}

function recommendedLoaderConfig(input: z.infer<typeof optimize3dAssetInputSchema>, optimizedAssetPath: string) {
  return {
    assetPath: optimizedAssetPath,
    profile: input.targetProfile,
    useKtx2Loader: input.compression.includes("texture"),
    useMeshoptDecoder: input.compression.includes("meshopt"),
    useDracoLoader: input.compression.includes("draco"),
    preserveAnimations: input.preserveAnimations,
    loadingStrategy: input.targetProfile.includes("mobile")
      ? "Preload a poster/placeholder, lazy-load the optimized GLTF/GLB, show progress, and defer animation start until first interaction."
      : "Preload optimized asset during route transition and enable animations after first render."
  };
}

async function optimize3dAsset(ctx: ToolContext, input: z.infer<typeof optimize3dAssetInputSchema>) {
  const sourcePath = await getProjectStoredFilePath(ctx.projectRoot, input.projectId, input.assetPath);
  const beforeBytes = await readFile(sourcePath);
  const extension = path.extname(input.assetPath).toLowerCase();
  const outputAssetPath = input.outputAssetPath ?? defaultOptimizedAssetPath(input.assetPath);
  const beforeReport = await inspect3dAsset(ctx, { projectId: input.projectId, assetPath: input.assetPath, source: "project", maxBytes: 100 * 1024 * 1024, writeReportToProject: false, outputPath: "unused.json" });
  let optimizedBytes = beforeBytes;
  let changes: string[] = [];
  let visualRiskNotes: string[] = [];
  let contentType = "application/octet-stream";
  if (extension === ".gltf") {
    const parsed = JSON.parse(beforeBytes.toString("utf8")) as GltfDoc;
    const result = optimizeGltfDocument(parsed, input);
    optimizedBytes = Buffer.from(`${JSON.stringify(result.optimized)}\n`, "utf8");
    changes = result.changes;
    visualRiskNotes = result.visualRiskNotes;
    contentType = "model/gltf+json";
    await writeProjectAsset(ctx.projectRoot, input.projectId, outputAssetPath, optimizedBytes, contentType);
  } else if (extension === ".obj") {
    const result = optimizeObjText(beforeBytes.toString("utf8"), input);
    optimizedBytes = Buffer.from(result.text, "utf8");
    changes = result.changes;
    visualRiskNotes = result.visualRiskNotes;
    contentType = "model/obj";
    await writeProjectAsset(ctx.projectRoot, input.projectId, outputAssetPath, optimizedBytes, contentType);
  } else if (extension === ".glb") {
    changes = ["Copied GLB unchanged; binary mesh/texture compression requires an external GLB optimizer such as gltf-transform or meshoptimizer."];
    visualRiskNotes = ["No destructive binary rewrite was attempted, so visual output is preserved."];
    contentType = "model/gltf-binary";
    await writeProjectAsset(ctx.projectRoot, input.projectId, outputAssetPath, optimizedBytes, contentType);
  } else {
    changes = [`Copied unsupported ${extension || "unknown"} asset unchanged and generated an optimization report.`];
    visualRiskNotes = ["Convert the asset to GLB/GLTF before automated optimization."];
    await writeProjectAsset(ctx.projectRoot, input.projectId, outputAssetPath, optimizedBytes, contentType);
  }
  const afterReport = extension === ".gltf" || extension === ".obj"
    ? await inspect3dAsset(ctx, { projectId: input.projectId, assetPath: outputAssetPath, source: "project", maxBytes: 100 * 1024 * 1024, writeReportToProject: false, outputPath: "unused.json" })
    : beforeReport;
  const beforeMetrics = optimizationMetrics(beforeReport as Record<string, unknown>, beforeBytes.length);
  const afterMetrics = optimizationMetrics(afterReport as Record<string, unknown>, optimizedBytes.length);
  const profile = optimizerProfile(input);
  const performanceWarnings: string[] = [];
  if (afterMetrics.triangleCount > profile.maxTriangles) performanceWarnings.push(`Triangle count ${afterMetrics.triangleCount} exceeds ${input.targetProfile} budget ${profile.maxTriangles}.`);
  if (afterMetrics.drawCallsEstimate > profile.maxDrawCalls) performanceWarnings.push(`Draw calls ${afterMetrics.drawCallsEstimate} exceed ${input.targetProfile} budget ${profile.maxDrawCalls}.`);
  if (afterMetrics.textureMegabytes > profile.maxTextureMegabytes) performanceWarnings.push(`Texture memory ${afterMetrics.textureMegabytes}MB exceeds ${input.targetProfile} budget ${profile.maxTextureMegabytes}MB.`);
  if (extension === ".glb" && input.compression.length) performanceWarnings.push("Requested compression is reported but not applied to binary GLB without an external optimizer.");
  if (input.preserveAnimations && beforeMetrics.animationClipCount !== afterMetrics.animationClipCount) performanceWarnings.push("Animation clip count changed despite preserveAnimations=true.");
  const report = {
    sourceAssetPath: input.assetPath,
    optimizedAssetPath: outputAssetPath,
    targetProfile: input.targetProfile,
    profile,
    beforeReport: beforeMetrics,
    afterReport: afterMetrics,
    sizeReductionPercent: beforeMetrics.fileSizeBytes > 0 ? Number((((beforeMetrics.fileSizeBytes - afterMetrics.fileSizeBytes) / beforeMetrics.fileSizeBytes) * 100).toFixed(2)) : 0,
    changes,
    compressionRequested: input.compression,
    changedMaterials: { before: beforeMetrics.materialCount, after: afterMetrics.materialCount },
    changedTextures: { before: beforeMetrics.textureCount, after: afterMetrics.textureCount, maxTextureSize: profile.maxTextureSize },
    lodPlan: input.generateLods ? [
      { suffix: "lod0", ratio: 1 },
      { suffix: "lod1", ratio: profile.simplifyRatio },
      { suffix: "lod2", ratio: Number((profile.simplifyRatio * 0.5).toFixed(2)) }
    ] : [],
    performanceWarnings,
    visualRisk: visualRiskNotes,
    recommendedLoaderConfig: recommendedLoaderConfig(input, outputAssetPath)
  };
  const reportFile = await writeProjectFile(ctx.projectRoot, input.projectId, input.outputReportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { report, artifacts: [outputAssetPath, reportFile.path], contentType };
}

function performanceReport(input: z.infer<typeof profileGamePerformanceBudgetInputSchema>): Record<string, unknown> {
  const warnings: string[] = [];
  if (input.triangles > input.maxTriangles) warnings.push(`Triangles ${input.triangles} exceed budget ${input.maxTriangles}.`);
  if (input.drawCalls > input.maxDrawCalls) warnings.push(`Draw calls ${input.drawCalls} exceed budget ${input.maxDrawCalls}.`);
  if (input.textureMegabytes > input.maxTextureMegabytes) warnings.push(`Texture memory ${input.textureMegabytes}MB exceeds budget ${input.maxTextureMegabytes}MB.`);
  if (input.animatedObjects > 1000) warnings.push("High animated object count; batch updates or use instancing.");
  return {
    targetFps: input.targetFps,
    metrics: {
      triangles: input.triangles,
      drawCalls: input.drawCalls,
      textureMegabytes: input.textureMegabytes,
      animatedObjects: input.animatedObjects
    },
    budgets: {
      maxTriangles: input.maxTriangles,
      maxDrawCalls: input.maxDrawCalls,
      maxTextureMegabytes: input.maxTextureMegabytes
    },
    status: warnings.length === 0 ? "within_budget" : "over_budget",
    warnings,
    recommendations: warnings.length === 0
      ? ["Keep a measured browser FPS baseline after loading final assets."]
      : ["Reduce triangle count, merge static meshes, use instancing, compress textures, and re-profile in browser."]
  };
}

export const threeDGameTools: ToolModule[] = [
  {
    definition: {
      name: "create_3d_game_build_brief",
      description: "Create a project-local 3D/game build brief covering mechanics, asset generation needs, platform, and QA handoff.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, gameType: { type: "string" }, targetPlatform: { type: "string", enum: ["desktop_web", "mobile_web", "both"] }, artDirection: { type: "string" }, mechanics: { type: "array", items: { type: "string" } }, assets: { type: "array" }, outputPath: { type: "string" } }, required: ["projectId", "title", "gameType", "mechanics"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: create3dGameBuildBriefInputSchema,
    handler: async (input, ctx) => {
      const parsed = create3dGameBuildBriefInputSchema.parse(input);
      const brief = { ...parsed, workflow: ["Generate/import bounded assets.", "Validate GLB/GLTF assets.", "Create scene/map manifests.", "Run collision, controls, and performance QA."], createdAt: new Date().toISOString() };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(brief, null, 2)}\n`);
      return { ok: true, summary: `Created 3D/game build brief with ${parsed.mechanics.length} mechanic(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: brief, logs: [JSON.stringify(brief, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "validate_gltf_asset",
      description: "Validate a project GLB/GLTF asset header or manifest and summarize scene/model metadata.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, assetPath: { type: "string" }, maxBytes: { type: "number" } }, required: ["projectId", "assetPath"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: validateGltfAssetInputSchema,
    handler: async (input, ctx) => {
      const parsed = validateGltfAssetInputSchema.parse(input);
      const report = await validateAsset(ctx, parsed.projectId, parsed.assetPath, parsed.maxBytes);
      const warnings = report.warnings as string[] | undefined;
      return { ok: true, summary: `Validated ${parsed.assetPath}${warnings?.length ? ` with ${warnings.length} warning(s)` : ""}.`, jobId: parsed.projectId, artifacts: [parsed.assetPath], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "inspect_3d_asset",
      description: "Inspect GLB/GLTF/OBJ assets for geometry cost, scene graph, materials, textures, animations, bounds, scale, external assets, and mobile performance risk.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, assetPath: { type: "string" }, source: { type: "string", enum: ["project", "workspace"] }, maxBytes: { type: "number" }, writeReportToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["assetPath"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: inspect3dAssetInputSchema,
    handler: async (input, ctx) => {
      const parsed = inspect3dAssetInputSchema.parse(input);
      const report = await inspect3dAsset(ctx, parsed);
      const warnings = Array.isArray(report.warnings) ? report.warnings as string[] : [];
      const artifacts = [parsed.assetPath];
      if (parsed.writeReportToProject) {
        const file = await writeProjectFile(ctx.projectRoot, parsed.projectId!, parsed.outputPath, `${JSON.stringify(report, null, 2)}\n`);
        artifacts.push(file.path);
      }
      const reportRecord = report as Record<string, unknown>;
      const triangleCount = typeof reportRecord.triangleCount === "number" ? reportRecord.triangleCount : 0;
      const mobileRiskScore = typeof reportRecord.mobileRiskScore === "number" ? reportRecord.mobileRiskScore : undefined;
      return {
        ok: warnings.length === 0 || !warnings.some((warning) => /unsupported|missing|mismatch|invalid/i.test(warning)),
        summary: `Inspected ${parsed.assetPath}: ${String(reportRecord.format ?? "unknown")} ${triangleCount} triangle(s)${mobileRiskScore !== undefined ? `, mobile risk ${mobileRiskScore}/100` : ""}.`,
        jobId: parsed.projectId,
        artifacts,
        structuredContent: report,
        logs: [JSON.stringify(report, null, 2)],
        errors: warnings.filter((warning) => /unsupported|missing|mismatch|invalid/i.test(warning))
      };
    }
  },
  {
    definition: {
      name: "generate_blocky_character",
      description: "Generate a reusable Three.js blocky/voxel character module and manifest from a structured character spec with parts, palette, accessories, anchors, bounds, and validation.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, style: { type: "string" }, name: { type: "string" }, palette: { type: "object" }, parts: { type: "object" }, expression: { type: "string" }, accessories: { type: "array" }, base: { type: "object" }, animationAnchors: { type: "object" }, outputModulePath: { type: "string" }, outputManifestPath: { type: "string" } }, required: ["projectId", "name"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: generateBlockyCharacterInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateBlockyCharacterInputSchema.parse(input);
      const generated = buildBlockyCharacter(parsed);
      const [moduleFile, manifestFile] = await Promise.all([
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputModulePath, generated.moduleSource),
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(generated.manifest, null, 2)}\n`)
      ]);
      const manifest = {
        ...generated.manifest,
        threeJsModulePath: moduleFile.path,
        manifestPath: manifestFile.path
      };
      return {
        ok: generated.manifest.validation.ok,
        summary: `Generated blocky character ${parsed.name} with ${generated.manifest.partNames.length} part(s).`,
        jobId: parsed.projectId,
        artifacts: [moduleFile.path, manifestFile.path],
        structuredContent: manifest,
        logs: [JSON.stringify(manifest, null, 2)],
        errors: generated.manifest.validation.warnings
      };
    }
  },
  {
    definition: {
      name: "compose_3d_scene",
      description: "Compose camera, lighting, orbit controls, environment, mobile framing, and no-interior constraints for a polished WebGL/Three.js scene from model bounds or an asset manifest.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, sceneName: { type: "string" }, assetManifestPath: { type: "string" }, boundingBox: { type: "object" }, style: { type: "string" }, devices: { type: "array", items: { type: "string" } }, constraints: { type: "object" }, outputConfigPath: { type: "string" }, outputModulePath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: compose3dSceneInputSchema,
    handler: async (input, ctx) => {
      const parsed = compose3dSceneInputSchema.parse(input);
      const composed = await compose3dScene(ctx, parsed);
      const [configFile, moduleFile] = await Promise.all([
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputConfigPath, `${JSON.stringify(composed.config, null, 2)}\n`),
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputModulePath, composed.moduleSource)
      ]);
      const warnings = Array.isArray(composed.config.warnings) ? composed.config.warnings as string[] : [];
      return {
        ok: warnings.length === 0,
        summary: `Composed 3D scene ${parsed.sceneName} with ${warnings.length} warning(s).`,
        jobId: parsed.projectId,
        artifacts: [configFile.path, moduleFile.path],
        structuredContent: { ...composed.config, sceneConfigPath: configFile.path, threeJsModulePath: moduleFile.path },
        logs: [JSON.stringify(composed.config, null, 2)],
        errors: warnings
      };
    }
  },
  {
    definition: {
      name: "validate_3d_animation_controls",
      description: "Generate and validate simple Three.js animation/control configuration for characters, vehicles, and toy-like models, including forward axis, keyboard mapping, pivots, neutral pose return, and preview frames.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, assetManifestPath: { type: "string" }, modelKind: { type: "string" }, forwardAxis: { type: "string" }, desiredStates: { type: "array", items: { type: "string" } }, controlContract: { type: "object" }, cameraMode: { type: "string" }, rootRotation: { type: "object" }, partPivots: { type: "object" }, attachments: { type: "array" }, vehicle: { type: "object" }, outputConfigPath: { type: "string" }, outputModulePath: { type: "string" }, outputReportPath: { type: "string" } }, required: ["projectId"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: validate3dAnimationControlsInputSchema,
    handler: async (input, ctx) => {
      const parsed = validate3dAnimationControlsInputSchema.parse(input);
      const validated = await validate3dAnimationControls(ctx, parsed);
      const [configFile, moduleFile, reportFile] = await Promise.all([
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputConfigPath, `${JSON.stringify(validated.animationConfig, null, 2)}\n`),
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputModulePath, validated.moduleSource),
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReportPath, `${JSON.stringify(validated.report, null, 2)}\n`)
      ]);
      const warnings = Array.isArray(validated.report.warnings) ? validated.report.warnings as string[] : [];
      return {
        ok: validated.report.ok,
        summary: `Validated 3D animation controls for ${parsed.modelKind} with ${warnings.length} warning(s).`,
        jobId: parsed.projectId,
        artifacts: [configFile.path, moduleFile.path, reportFile.path],
        structuredContent: {
          animationConfigPath: configFile.path,
          animationModulePath: moduleFile.path,
          validationReportPath: reportFile.path,
          ...validated.report
        },
        logs: [JSON.stringify(validated.report, null, 2)],
        errors: warnings
      };
    }
  },
  {
    definition: {
      name: "create_3d_scene_manifest",
      description: "Create a scene manifest with object inventory, camera/controls, collider hints, and performance budget issues.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, sceneName: { type: "string" }, objects: { type: "array" }, camera: { type: "object" }, controls: { type: "array", items: { type: "string" } }, performanceBudget: { type: "object" }, outputPath: { type: "string" } }, required: ["projectId", "sceneName", "objects", "camera", "controls"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: create3dSceneManifestInputSchema,
    handler: async (input, ctx) => {
      const parsed = create3dSceneManifestInputSchema.parse(input);
      const issues = sceneIssues(parsed.objects, parsed.performanceBudget);
      const manifest = { projectId: parsed.projectId, sceneName: parsed.sceneName, objects: parsed.objects, camera: parsed.camera, controls: parsed.controls, performanceBudget: parsed.performanceBudget, issues, createdAt: new Date().toISOString() };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: true, summary: `Created 3D scene manifest with ${parsed.objects.length} object(s), ${issues.length} issue(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: manifest, logs: [JSON.stringify(manifest, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "generate_game_map_spec",
      description: "Generate a bounded tile-map spec with layers, spawn, goals, obstacle rectangles, and ASCII preview.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, name: { type: "string" }, width: { type: "number" }, height: { type: "number" }, layers: { type: "array" }, obstacles: { type: "array" }, spawn: { type: "object" }, goals: { type: "array" }, outputPath: { type: "string" } }, required: ["projectId", "name", "width", "height", "layers"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: generateGameMapSpecInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateGameMapSpecInputSchema.parse(input);
      const baseTile = parsed.layers[0]?.tile ?? ".";
      const rows = mapRows(parsed.width, parsed.height, baseTile, parsed.obstacles, parsed.goals, parsed.spawn);
      const spec = { projectId: parsed.projectId, name: parsed.name, width: parsed.width, height: parsed.height, layers: parsed.layers, obstacles: parsed.obstacles, spawn: parsed.spawn, goals: parsed.goals, preview: rows };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(spec, null, 2)}\n`);
      return { ok: true, summary: `Generated ${parsed.width}x${parsed.height} map spec with ${parsed.obstacles.length} obstacle(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: spec, logs: rows, errors: [] };
    }
  },
  {
    definition: {
      name: "test_collision_rules",
      description: "Evaluate AABB/sphere collision pairs and compare them with expected collision pairs.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, colliders: { type: "array" }, expectedPairs: { type: "array" }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["colliders"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: testCollisionRulesInputSchema,
    handler: async (input, ctx) => {
      const parsed = testCollisionRulesInputSchema.parse(input);
      const report = collisionReport(parsed.colliders, parsed.expectedPairs);
      const artifacts: string[] = [];
      if (parsed.writeToProject) {
        if (!parsed.projectId) throw new Error("projectId is required when writeToProject is true.");
        const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(report, null, 2)}\n`);
        artifacts.push(file.path);
      }
      return { ok: report.ok as boolean, summary: `Checked ${parsed.colliders.length} collider(s); ${(report.actualPairs as unknown[]).length} collision pair(s).`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: (report.ok as boolean) ? [] : ["Collision pairs did not match expectedPairs."] };
    }
  },
  {
    definition: {
      name: "create_game_loop_qa_plan",
      description: "Create a deterministic game-loop QA plan covering state hooks, interactions, transitions, and browser evidence.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, entryFile: { type: "string" }, states: { type: "array", items: { type: "string" } }, interactions: { type: "array", items: { type: "string" } }, requiredHooks: { type: "array", items: { type: "string" } }, outputPath: { type: "string" } }, required: ["projectId", "states", "interactions"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createGameLoopQaPlanInputSchema,
    handler: async (input, ctx) => {
      const parsed = createGameLoopQaPlanInputSchema.parse(input);
      const plan = { projectId: parsed.projectId, entryFile: parsed.entryFile, states: parsed.states, interactions: parsed.interactions, requiredHooks: parsed.requiredHooks, checks: ["Load without console errors.", "Expose render_game_to_text with visible state.", "Advance deterministic frames via advanceTime.", "Capture nonblank gameplay screenshots.", "Verify win/lose/restart transitions."], createdAt: new Date().toISOString() };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(plan, null, 2)}\n`);
      return { ok: true, summary: `Created game-loop QA plan for ${parsed.interactions.length} interaction(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: plan, logs: [JSON.stringify(plan, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "create_camera_control_test_plan",
      description: "Create a camera/control QA matrix for keyboard, mouse, touch, gamepad, orbit, or pointer-lock games.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, controls: { type: "array", items: { type: "string" } }, cameraModes: { type: "array", items: { type: "string" } }, viewports: { type: "array" }, outputPath: { type: "string" } }, required: ["projectId", "controls", "cameraModes"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: createCameraControlTestPlanInputSchema,
    handler: async (input, ctx) => {
      const parsed = createCameraControlTestPlanInputSchema.parse(input);
      const matrix = parsed.cameraModes.flatMap((mode) => parsed.controls.map((control) => ({ mode, control, checks: ["input maps to intended camera/player movement", "no inverted axes unless configured", "viewport resize preserves framing"] })));
      const plan = { projectId: parsed.projectId, controls: parsed.controls, cameraModes: parsed.cameraModes, viewports: parsed.viewports, matrix, createdAt: new Date().toISOString() };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(plan, null, 2)}\n`);
      return { ok: true, summary: `Created camera/control QA matrix with ${matrix.length} case(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: plan, logs: [JSON.stringify(plan, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "profile_game_performance_budget",
      description: "Compare 3D/game render metrics against a target FPS performance budget and return optimization guidance.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, targetFps: { type: "number" }, triangles: { type: "number" }, drawCalls: { type: "number" }, textureMegabytes: { type: "number" }, animatedObjects: { type: "number" }, maxTriangles: { type: "number" }, maxDrawCalls: { type: "number" }, maxTextureMegabytes: { type: "number" }, writeToProject: { type: "boolean" }, outputPath: { type: "string" } }, required: ["triangles", "drawCalls"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: profileGamePerformanceBudgetInputSchema,
    handler: async (input, ctx) => {
      const parsed = profileGamePerformanceBudgetInputSchema.parse(input);
      const report = performanceReport(parsed);
      const artifacts: string[] = [];
      if (parsed.writeToProject) {
        if (!parsed.projectId) throw new Error("projectId is required when writeToProject is true.");
        const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(report, null, 2)}\n`);
        artifacts.push(file.path);
      }
      return { ok: true, summary: `Performance budget is ${report.status}.`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "optimize_3d_asset",
      description: "Optimize or produce a conservative optimization report for GLB/GLTF/OBJ assets targeting mobile WebGL/PWA delivery, including structural cleanup, OBJ face reduction, size/texture/draw-call metrics, compression guidance, LOD plan, and loader config.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" }, assetPath: { type: "string" }, targetProfile: { type: "string" }, maxTextureSize: { type: "number" }, preserveAnimations: { type: "boolean" }, preserveNamedNodes: { type: "boolean" }, removeUnused: { type: "boolean" }, mergeCompatibleMaterials: { type: "boolean" }, generateLods: { type: "boolean" }, simplifyRatio: { type: "number" }, compression: { type: "array", items: { type: "string" } }, outputAssetPath: { type: "string" }, outputReportPath: { type: "string" } }, required: ["projectId", "assetPath"], additionalProperties: false }
    },
    enabledByDefault: true,
    schema: optimize3dAssetInputSchema,
    handler: async (input, ctx) => {
      const parsed = optimize3dAssetInputSchema.parse(input);
      const optimized = await optimize3dAsset(ctx, parsed);
      const warnings = optimized.report.performanceWarnings as string[];
      return {
        ok: warnings.length === 0 || warnings.every((warning) => warning.includes("external optimizer")),
        summary: `Optimized ${parsed.assetPath} for ${parsed.targetProfile}: ${optimized.report.sizeReductionPercent}% size change, ${warnings.length} warning(s).`,
        jobId: parsed.projectId,
        artifacts: optimized.artifacts,
        structuredContent: optimized.report,
        logs: [JSON.stringify(optimized.report, null, 2)],
        errors: warnings
      };
    }
  }
];
