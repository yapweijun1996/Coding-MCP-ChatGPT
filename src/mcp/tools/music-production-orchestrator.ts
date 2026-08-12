import { z } from "zod";
import type { ToolContext, ToolModule, ToolResult } from "../types.js";
import { throwIfAborted } from "../../shared/abort.js";

const styleAliases: Record<string, MusicProductionStyle> = {
  cafe_jazz: "cafe_jazz",
  jazz: "cafe_jazz",
  jazz_cafe: "cafe_jazz",
  bossa: "bossa_lounge",
  bossa_lounge: "bossa_lounge",
  lo_fi: "lo_fi_study",
  lofi: "lo_fi_study",
  lo_fi_study: "lo_fi_study",
  piano_violin: "piano_violin",
  cinematic: "soft_cinematic",
  cinematic_soft: "soft_cinematic",
  soft_cinematic: "soft_cinematic",
  game: "game_ambience",
  game_ambience: "game_ambience",
  corporate: "corporate_background",
  corporate_background: "corporate_background"
};

const instrumentAliases: Record<string, CanonicalInstrument> = {
  piano: "piano",
  acoustic_piano: "piano",
  grand_piano: "piano",
  realistic_piano: "piano",
  solo_piano: "piano",
  electric_piano: "electric_piano",
  upright_bass: "upright_bass",
  double_bass: "upright_bass",
  acoustic_bass: "acoustic_bass",
  bass: "acoustic_bass",
  violin: "violin",
  cello: "cello",
  drums: "drums",
  drum: "drums",
  percussion: "drums",
  brushes: "brushes",
  brush_drums: "brushes",
  guitar: "guitar",
  strings: "strings",
  string_pad: "strings",
  pads: "pads",
  pad: "pads",
  synth: "synth",
  synthesizer: "synth",
  sax: "sax_like_lead",
  saxophone: "sax_like_lead",
  sax_like_lead: "sax_like_lead"
};

const outputNames = ["manifest", "midi", "wav", "mp3", "score"] as const;
const instrumentPackRoles = [
  "realistic_piano",
  "upright_bass",
  "brush_drums",
  "room_ambience",
  "cello",
  "violin",
  "strings",
  "chamber_ensemble",
  "orchestral_sketch",
  "general_midi"
] as const;

const rawInstrumentPolicySchema = z.object({
  mode: z.enum(["solo", "ensemble"]).optional(),
  allowed: z.array(z.string().min(1).max(80)).min(1).max(16).optional(),
  allowedInstruments: z.array(z.string().min(1).max(80)).min(1).max(16).optional(),
  prohibitedInstruments: z.array(z.string().min(1).max(80)).max(16).optional()
}).strict().optional();

const rawOutputsSchema = z.union([
  z.array(z.enum(outputNames)).min(1).max(outputNames.length),
  z.object({
    manifest: z.boolean().optional(),
    midi: z.boolean().optional(),
    wav: z.boolean().optional(),
    mp3: z.boolean().optional(),
    score: z.boolean().optional()
  }).strict()
]).optional();

const rawInstrumentPackMapSchema = z.object({
  realistic_piano: z.string().min(1).max(80).optional(),
  upright_bass: z.string().min(1).max(80).optional(),
  brush_drums: z.string().min(1).max(80).optional(),
  room_ambience: z.string().min(1).max(80).optional(),
  cello: z.string().min(1).max(80).optional(),
  violin: z.string().min(1).max(80).optional(),
  strings: z.string().min(1).max(80).optional(),
  chamber_ensemble: z.string().min(1).max(80).optional(),
  orchestral_sketch: z.string().min(1).max(80).optional(),
  general_midi: z.string().min(1).max(80).optional()
}).strict().optional().default({});

const createMusicProductionInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  sourceCompositionManifestPath: z.string().min(1).max(240),
  targetDurationSec: z.number().int().min(300).max(900).optional().default(300),
  style: z.string().min(1).max(80).optional().default("soft_cinematic"),
  instrumentPolicy: rawInstrumentPolicySchema,
  development: z.object({
    variationLevel: z.string().min(1).max(40).optional().default("high"),
    preserveMelodicIdentity: z.boolean().optional().default(true)
  }).strict().optional().default({}),
  render: z.object({
    enabled: z.boolean().optional(),
    pack: z.string().min(1).max(80).optional(),
    path: z.string().min(1).max(240).optional(),
    instrumentPackMap: rawInstrumentPackMapSchema,
    stems: z.boolean().optional().default(false),
    normalize: z.boolean().optional().default(true)
  }).strict().optional().default({}),
  outputs: rawOutputsSchema,
  qa: z.object({
    enabled: z.boolean().optional().default(true),
    thresholds: z.object({
      durationToleranceSec: z.number().min(0).max(3600).optional().default(15),
      minMelodyIdentityScore: z.number().min(0).max(1).optional().default(0.6),
      minDevelopmentScore: z.number().min(0).max(1).optional().default(0.55),
      maxRepeatedSectionSimilarity: z.number().min(0).max(1).optional().default(0.92),
      maxSilencePercentage: z.number().min(0).max(100).optional().default(10),
      truePeakCeilingDb: z.number().min(-12).max(0).optional().default(-1),
      targetIntegratedLufs: z.number().min(-30).max(-5).optional().default(-16)
    }).strict().optional().default({})
  }).strict().optional().default({}),
  publish: z.boolean().optional().default(false),
  outputManifestPath: z.string().min(1).max(240).optional().default("music/production-manifest.json")
}).strict();

type RawMusicProductionInput = z.infer<typeof createMusicProductionInputSchema>;
type CanonicalInstrument = "piano" | "electric_piano" | "upright_bass" | "acoustic_bass" | "violin" | "cello" | "drums" | "brushes" | "guitar" | "strings" | "pads" | "synth" | "sax_like_lead";
type InstrumentPackRole = typeof instrumentPackRoles[number];
type MusicProductionStyle = "cafe_jazz" | "bossa_lounge" | "lo_fi_study" | "piano_violin" | "soft_cinematic" | "game_ambience" | "corporate_background";
type VariationLevel = "low" | "medium" | "high";
type OutputName = typeof outputNames[number];
type StageStatus = "passed" | "failed" | "skipped";

export interface MusicProductionCallTool {
  (name: string, input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface NormalizedMusicProductionInput {
  projectId: string;
  sourceCompositionManifestPath: string;
  targetDurationSec: number;
  style: MusicProductionStyle;
  backgroundUse: "coffee_shop" | "study" | "website" | "video" | "game";
  instrumentPolicy: {
    mode: "solo" | "ensemble";
    allowedInstruments: CanonicalInstrument[];
    prohibitedInstruments: CanonicalInstrument[];
  };
  development: {
    variationLevel: VariationLevel;
    preserveMelodicIdentity: boolean;
  };
  render: {
    enabled: boolean;
    pack?: string;
    path?: string;
    instrumentPackMap: Partial<Record<InstrumentPackRole, string>>;
    stems: boolean;
    normalize: boolean;
    tool: "render_production_music" | "render_midi_with_soundfont";
  };
  outputs: Record<OutputName, boolean>;
  qa: {
    enabled: boolean;
    hardGatesAlwaysEnabled: true;
    thresholds: {
      durationToleranceSec: number;
      minMelodyIdentityScore: number;
      minDevelopmentScore: number;
      maxRepeatedSectionSimilarity: number;
      maxSilencePercentage: number;
      truePeakCeilingDb: number;
      targetIntegratedLufs: number;
    };
  };
  publish: boolean;
  outputManifestPath: string;
  normalizedInputs: {
    interpretations: Array<{ field: string; input: string; canonical: string }>;
    effectiveOutputs: Record<OutputName, boolean>;
    mandatoryOutputs: ["manifest", "midi"];
    hardGatesAlwaysEnabled: true;
  };
}

export interface MusicProductionStagePlanItem {
  id: "extend" | "constraints" | "ensemble" | "development" | "render" | "audio_qa" | "final_manifest";
  toolName: string;
  enabled: boolean;
  hardGate: boolean;
}

export interface MusicProductionStageRecord {
  id: MusicProductionStagePlanItem["id"];
  toolName: string;
  status: StageStatus;
  hardGate: boolean;
  summary: string;
  artifacts: string[];
  errors: string[];
  startedAt: string;
  completedAt: string;
  structuredContent?: Record<string, unknown>;
}

interface MusicProductionDependencies {
  callTool?: MusicProductionCallTool;
  now?: () => string;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeStyle(value: string, interpretations: NormalizedMusicProductionInput["normalizedInputs"]["interpretations"]): MusicProductionStyle {
  const token = normalizeToken(value);
  const canonical = styleAliases[token];
  if (!canonical) throw new Error(`Unsupported music style "${value}". Supported human-friendly styles include cinematic, cafe jazz, bossa, lo-fi, piano violin, game, and corporate.`);
  if (token !== canonical) interpretations.push({ field: "style", input: value, canonical });
  return canonical;
}

function normalizeInstrument(value: string, field: string, interpretations: NormalizedMusicProductionInput["normalizedInputs"]["interpretations"]): CanonicalInstrument {
  const token = normalizeToken(value);
  const canonical = instrumentAliases[token];
  if (!canonical) throw new Error(`Unsupported instrument "${value}" in ${field}.`);
  if (token !== canonical) interpretations.push({ field, input: value, canonical });
  return canonical;
}

function normalizeInstrumentList(values: string[], field: string, interpretations: NormalizedMusicProductionInput["normalizedInputs"]["interpretations"]): CanonicalInstrument[] {
  return [...new Set(values.map((value) => normalizeInstrument(value, field, interpretations)))].sort();
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeVariationLevel(value: string, interpretations: NormalizedMusicProductionInput["normalizedInputs"]["interpretations"]): VariationLevel {
  const token = normalizeToken(value);
  const aliases: Record<string, VariationLevel> = { low: "low", subtle: "low", medium: "medium", moderate: "medium", balanced: "medium", high: "high", strong: "high", extensive: "high" };
  const canonical = aliases[token];
  if (!canonical) throw new Error(`Unsupported variationLevel "${value}". Use low, medium, or high.`);
  if (token !== canonical) interpretations.push({ field: "development.variationLevel", input: value, canonical });
  return canonical;
}

function normalizeOutputs(raw: RawMusicProductionInput["outputs"]): Record<OutputName, boolean> {
  const defaults: Record<OutputName, boolean> = { manifest: true, midi: true, wav: true, mp3: true, score: false };
  if (!raw) return defaults;
  if (Array.isArray(raw)) {
    const selected = new Set<OutputName>(raw);
    return Object.fromEntries(outputNames.map((name) => [name, selected.has(name)])) as Record<OutputName, boolean>;
  }
  return {
    manifest: raw.manifest ?? defaults.manifest,
    midi: raw.midi ?? defaults.midi,
    wav: raw.wav ?? false,
    mp3: raw.mp3 ?? false,
    score: raw.score ?? false
  };
}

function backgroundUseForStyle(style: MusicProductionStyle): NormalizedMusicProductionInput["backgroundUse"] {
  if (style === "lo_fi_study") return "study";
  if (style === "soft_cinematic" || style === "piano_violin") return "video";
  if (style === "game_ambience") return "game";
  if (style === "corporate_background") return "website";
  return "coffee_shop";
}

export function normalizeMusicProductionInput(input: unknown): NormalizedMusicProductionInput {
  const parsed = createMusicProductionInputSchema.parse(input);
  const interpretations: NormalizedMusicProductionInput["normalizedInputs"]["interpretations"] = [];
  const style = normalizeStyle(parsed.style, interpretations);
  const policy = parsed.instrumentPolicy;
  const mode = policy?.mode ?? "solo";
  const allowedAlias = policy?.allowed ? normalizeInstrumentList(policy.allowed, "instrumentPolicy.allowed", interpretations) : undefined;
  const allowedCanonical = policy?.allowedInstruments ? normalizeInstrumentList(policy.allowedInstruments, "instrumentPolicy.allowedInstruments", interpretations) : undefined;
  if (allowedAlias && allowedCanonical && !sameValues(allowedAlias, allowedCanonical)) {
    throw new Error("instrumentPolicy.allowed and instrumentPolicy.allowedInstruments conflict after normalization.");
  }
  const allowedInstruments = allowedCanonical ?? allowedAlias ?? ["piano"];
  if (policy?.allowed && !policy.allowedInstruments) {
    interpretations.push({ field: "instrumentPolicy.allowed", input: "allowed", canonical: "allowedInstruments" });
  }
  if (mode === "solo" && allowedInstruments.length !== 1) {
    throw new Error("instrumentPolicy.mode=solo requires exactly one allowed instrument.");
  }
  if (mode === "ensemble" && allowedInstruments.length < 2) {
    throw new Error("instrumentPolicy.mode=ensemble requires at least two allowed instruments.");
  }
  const prohibitedInstruments = normalizeInstrumentList(policy?.prohibitedInstruments ?? [], "instrumentPolicy.prohibitedInstruments", interpretations);
  const overlap = allowedInstruments.filter((instrument) => prohibitedInstruments.includes(instrument));
  if (overlap.length) throw new Error(`Instrument policy cannot both allow and prohibit: ${overlap.join(", ")}.`);

  const requestedOutputs = normalizeOutputs(parsed.outputs);
  const outputs = { ...requestedOutputs, manifest: true, midi: true };
  if (!requestedOutputs.manifest) interpretations.push({ field: "outputs.manifest", input: "false", canonical: "true (mandatory revision state)" });
  if (!requestedOutputs.midi) interpretations.push({ field: "outputs.midi", input: "false", canonical: "true (mandatory arrangement artifact)" });
  const renderEnabled = parsed.render.enabled ?? (outputs.wav || outputs.mp3 || parsed.publish);
  const renderTool = outputs.mp3 || parsed.publish || Object.keys(parsed.render.instrumentPackMap).length > 0
    ? "render_production_music"
    : "render_midi_with_soundfont";

  return {
    projectId: parsed.projectId,
    sourceCompositionManifestPath: parsed.sourceCompositionManifestPath,
    targetDurationSec: parsed.targetDurationSec,
    style,
    backgroundUse: backgroundUseForStyle(style),
    instrumentPolicy: { mode, allowedInstruments, prohibitedInstruments },
    development: {
      variationLevel: normalizeVariationLevel(parsed.development.variationLevel, interpretations),
      preserveMelodicIdentity: parsed.development.preserveMelodicIdentity
    },
    render: {
      enabled: renderEnabled,
      ...(parsed.render.pack ? { pack: parsed.render.pack } : {}),
      ...(parsed.render.path ? { path: parsed.render.path } : {}),
      instrumentPackMap: parsed.render.instrumentPackMap,
      stems: parsed.render.stems,
      normalize: parsed.render.normalize,
      tool: renderTool
    },
    outputs,
    qa: {
      enabled: parsed.qa.enabled,
      hardGatesAlwaysEnabled: true,
      thresholds: parsed.qa.thresholds
    },
    publish: parsed.publish,
    outputManifestPath: parsed.outputManifestPath,
    normalizedInputs: {
      interpretations,
      effectiveOutputs: outputs,
      mandatoryOutputs: ["manifest", "midi"],
      hardGatesAlwaysEnabled: true
    }
  };
}

export function buildMusicProductionStagePlan(input: unknown): MusicProductionStagePlanItem[] {
  const normalized = isNormalizedInput(input) ? input : normalizeMusicProductionInput(input);
  return [
    { id: "extend", toolName: "extend_original_music_arrangement", enabled: true, hardGate: true },
    { id: "constraints", toolName: "validate_music_constraints", enabled: true, hardGate: true },
    { id: "ensemble", toolName: "validate_music_ensemble", enabled: normalized.instrumentPolicy.mode === "ensemble", hardGate: normalized.instrumentPolicy.mode === "ensemble" },
    { id: "development", toolName: "validate_music_development", enabled: true, hardGate: true },
    { id: "render", toolName: normalized.render.tool, enabled: normalized.render.enabled, hardGate: normalized.render.enabled },
    { id: "audio_qa", toolName: "inspect_audio_quality", enabled: normalized.render.enabled && normalized.qa.enabled, hardGate: normalized.render.enabled && normalized.qa.enabled },
    { id: "final_manifest", toolName: "write_project_file", enabled: true, hardGate: true }
  ];
}

function isNormalizedInput(input: unknown): input is NormalizedMusicProductionInput {
  return typeof input === "object" && input !== null && "normalizedInputs" in input && "backgroundUse" in input;
}

function outputDirectory(outputManifestPath: string): string {
  const index = outputManifestPath.lastIndexOf("/");
  return index > 0 ? outputManifestPath.slice(0, index) : "music";
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function parseSourceManifest(result: ToolResult): Record<string, unknown> | undefined {
  const raw = result.logs[0];
  if (!result.ok || !raw) return undefined;
  try {
    return objectValue(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function reusableScorePath(source: Record<string, unknown> | undefined): string | undefined {
  const scoreSource = objectValue(source?.scoreSource);
  const candidate = stringValue(source, ["musicXmlPath", "musicXMLPath", "scorePath", "sourceScorePath", "outputMusicXmlPath"])
    ?? stringValue(scoreSource, ["musicXmlPath", "path", "sourcePath"]);
  return candidate && /\.(?:musicxml|xml|mxl)$/i.test(candidate) ? candidate : undefined;
}

function resultPath(result: ToolResult | undefined, keys: string[], fallback?: string): string | undefined {
  return stringValue(result?.structuredContent, keys) ?? fallback;
}

function nestedString(result: ToolResult | undefined, objectKey: string, keys: string[]): string | undefined {
  return stringValue(objectValue(result?.structuredContent?.[objectKey]), keys);
}

function renderListeningUrl(result: ToolResult | undefined): string | undefined {
  return result?.shareUrl ?? result?.previewUrl ?? stringValue(result?.structuredContent, ["publishedUrl", "listeningUrl", "demoUrl"]);
}

async function defaultCallTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const [{ callTool }, { isToolEffectivelyEnabled }] = await Promise.all([
    import("../router.js"),
    import("../../tool-state.js")
  ]);
  if (!isToolEffectivelyEnabled(name)) {
    return {
      ok: false,
      summary: `Music production stopped because required tool ${name} is disabled.`,
      artifacts: [],
      logs: [],
      errors: [`Tool ${name} is disabled.`]
    };
  }
  return callTool(name, input, ctx);
}

function failureResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, summary: message, artifacts: [], logs: [], errors: [message] };
}

function nextActionFor(stageId: MusicProductionStagePlanItem["id"]): string {
  if (stageId === "extend") return "Revise the source composition or arrangement inputs, then rerun create_music_production.";
  if (stageId === "constraints") return "Remove prohibited/hidden instruments or MIDI channel 10, then rerun from the preserved source state.";
  if (stageId === "ensemble") return "Ensure every declared ensemble instrument has notes and meaningful simultaneous overlap, then rerun from the preserved source state.";
  if (stageId === "development") return "Revise section development so the source melody is transformed meaningfully instead of mechanically repeated.";
  if (stageId === "render") return "Fix the renderer or licensed instrument-pack configuration, then retry rendering from the preserved arrangement MIDI.";
  if (stageId === "audio_qa") return "Revise the render/mix according to the audio QA report, then rerun the render and QA stages.";
  return "Retry writing the final production manifest; prior stage artifacts remain available.";
}

export async function executeMusicProduction(input: unknown, ctx: ToolContext, dependencies: MusicProductionDependencies = {}): Promise<ToolResult> {
  const normalized = normalizeMusicProductionInput(input);
  const callTool = dependencies.callTool ?? defaultCallTool;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const plan = buildMusicProductionStagePlan(normalized);
  const directory = outputDirectory(normalized.outputManifestPath);
  const paths = {
    arrangementManifest: `${directory}/production-arrangement.json`,
    midi: `${directory}/production.mid`,
    constraintReport: `${directory}/constraint-qa.json`,
    developmentReport: `${directory}/development-qa.json`,
    wav: `${directory}/production.wav`,
    mp3: `${directory}/preview.mp3`,
    renderReport: `${directory}/render-report.json`,
    stems: `${directory}/stems`,
    licenses: `${directory}/LICENSES.md`,
    listeningPage: `${directory}/listen.html`,
    audioQaReport: `${directory}/audio-qa.json`
  };
  const stages: MusicProductionStageRecord[] = [];
  const artifacts: string[] = [];
  const warnings: string[] = [];
  const unsupportedOutputs: Array<{ output: "score" | "wav" | "mp3" | "publish"; reason: string }> = [];
  let blocker: MusicProductionStageRecord | undefined;

  const sourceRead = await callTool("read_project_file", {
    projectId: normalized.projectId,
    relativePath: normalized.sourceCompositionManifestPath,
    maxBytes: 1024 * 1024
  }, ctx).catch(failureResult);
  const sourceManifest = parseSourceManifest(sourceRead);
  if (!sourceRead.ok) warnings.push(`Source manifest inspection was unavailable: ${sourceRead.summary}`);
  else if (!sourceManifest) warnings.push("Source manifest was readable but not valid JSON; score-lineage reuse could not be inspected.");
  const scorePath = reusableScorePath(sourceManifest);
  if (normalized.outputs.score && !scorePath) {
    const reason = "Score was requested, but the source manifest has no reusable MusicXML score path. The orchestrator did not generate or claim a score.";
    unsupportedOutputs.push({ output: "score", reason });
    warnings.push(reason);
  }
  if (!normalized.render.enabled) {
    if (normalized.outputs.wav) unsupportedOutputs.push({ output: "wav", reason: "WAV was requested while render.enabled=false; no audio was generated." });
    if (normalized.outputs.mp3) unsupportedOutputs.push({ output: "mp3", reason: "MP3 was requested while render.enabled=false; no audio was generated." });
    if (normalized.publish) unsupportedOutputs.push({ output: "publish", reason: "Publishing requires an enabled production audio render." });
    warnings.push(...unsupportedOutputs.filter((item) => item.output !== "score").map((item) => item.reason));
  }

  async function runStage(item: MusicProductionStagePlanItem, stageInput: Record<string, unknown>): Promise<ToolResult> {
    throwIfAborted(ctx.abortSignal);
    const startedAt = now();
    const result = await callTool(item.toolName, stageInput, ctx).catch(failureResult);
    throwIfAborted(ctx.abortSignal);
    const record: MusicProductionStageRecord = {
      id: item.id,
      toolName: item.toolName,
      status: result.ok ? "passed" : "failed",
      hardGate: item.hardGate,
      summary: result.summary,
      artifacts: [...result.artifacts],
      errors: [...result.errors],
      startedAt,
      completedAt: now(),
      ...(result.structuredContent ? { structuredContent: result.structuredContent } : {})
    };
    stages.push(record);
    artifacts.push(...result.artifacts);
    if (!result.ok && item.hardGate && !blocker) blocker = record;
    return result;
  }

  function skipStage(item: MusicProductionStagePlanItem, reason: string): void {
    const timestamp = now();
    stages.push({
      id: item.id,
      toolName: item.toolName,
      status: "skipped",
      hardGate: item.hardGate,
      summary: reason,
      artifacts: [],
      errors: [],
      startedAt: timestamp,
      completedAt: timestamp
    });
  }

  const extendItem = plan[0];
  const extendResult = await runStage(extendItem, {
    projectId: normalized.projectId,
    sourceManifestPath: normalized.sourceCompositionManifestPath,
    targetDurationSec: normalized.targetDurationSec,
    styleFamily: normalized.style,
    backgroundUse: normalized.backgroundUse,
    variationLevel: normalized.development.variationLevel,
    instrumentPolicy: normalized.instrumentPolicy,
    renderAudio: false,
    outputManifestPath: paths.arrangementManifest,
    outputMidiPath: paths.midi
  });

  const arrangementManifestPath = resultPath(extendResult, ["arrangementManifestPath", "manifestPath"], extendResult.ok ? paths.arrangementManifest : undefined);
  const midiPath = resultPath(extendResult, ["extendedMidiPath", "midiPath"], extendResult.ok ? paths.midi : undefined);
  let constraintResult: ToolResult | undefined;
  let ensembleResult: ToolResult | undefined;
  let developmentResult: ToolResult | undefined;
  let renderResult: ToolResult | undefined;
  let audioQaResult: ToolResult | undefined;

  const constraintsItem = plan[1];
  if (!blocker && arrangementManifestPath) {
    constraintResult = await runStage(constraintsItem, {
      projectId: normalized.projectId,
      compositionManifestPath: arrangementManifestPath,
      instrumentPolicy: normalized.instrumentPolicy,
      targetDurationSec: normalized.targetDurationSec,
      durationToleranceSec: normalized.qa.thresholds.durationToleranceSec,
      outputReportPath: paths.constraintReport
    });
  } else {
    skipStage(constraintsItem, "Skipped because arrangement extension did not pass its hard gate.");
  }

  const ensembleItem = plan[2];
  if (!ensembleItem.enabled) {
    skipStage(ensembleItem, "Solo policy: ensemble hard gate is not required.");
  } else if (!blocker && arrangementManifestPath) {
    ensembleResult = await runStage(ensembleItem, {
      projectId: normalized.projectId,
      compositionManifestPath: arrangementManifestPath,
      requiredInstruments: normalized.instrumentPolicy.allowedInstruments,
      soloInstruments: [],
      maxSingleInstrumentSeconds: 8,
      requireStartWithinBars: 2,
      barBeats: 4
    });
  } else {
    skipStage(ensembleItem, `Skipped because ${blocker?.toolName ?? "a prior hard gate"} failed.`);
  }

  const developmentItem = plan[3];
  if (!blocker && arrangementManifestPath) {
    developmentResult = await runStage(developmentItem, {
      projectId: normalized.projectId,
      sourceCompositionManifestPath: normalized.sourceCompositionManifestPath,
      compositionManifestPath: arrangementManifestPath,
      preserveMelodicIdentity: normalized.development.preserveMelodicIdentity,
      variationLevel: normalized.development.variationLevel,
      thresholds: {
        minMelodyIdentityScore: normalized.qa.thresholds.minMelodyIdentityScore,
        minDevelopmentScore: normalized.qa.thresholds.minDevelopmentScore,
        maxRepeatedSectionSimilarity: normalized.qa.thresholds.maxRepeatedSectionSimilarity
      },
      outputReportPath: paths.developmentReport
    });
  } else {
    skipStage(developmentItem, `Skipped because ${blocker?.toolName ?? "a prior hard gate"} failed.`);
  }

  const renderItem = plan[4];
  if (!renderItem.enabled) {
    skipStage(renderItem, "No-audio mode: render.enabled=false.");
  } else if (blocker || !arrangementManifestPath || !midiPath) {
    skipStage(renderItem, `Rendering stopped because ${blocker?.toolName ?? "a prior hard gate"} failed.`);
  } else if (renderItem.toolName === "render_production_music") {
    renderResult = await runStage(renderItem, {
      projectId: normalized.projectId,
      compositionManifestPath: arrangementManifestPath,
      ...(normalized.render.pack ? { soundfontPackId: normalized.render.pack } : {}),
      ...(normalized.render.path ? { soundfontPath: normalized.render.path } : {}),
      ...(Object.keys(normalized.render.instrumentPackMap).length ? { instrumentPackMap: normalized.render.instrumentPackMap } : {}),
      instrumentPolicy: normalized.instrumentPolicy,
      outputProductionWavPath: paths.wav,
      outputPreviewMp3Path: paths.mp3,
      outputStemDirectory: paths.stems,
      outputLicensesPath: paths.licenses,
      outputReportPath: paths.renderReport,
      outputHtmlPath: paths.listeningPage,
      publish: normalized.publish
    });
  } else {
    renderResult = await runStage(renderItem, {
      projectId: normalized.projectId,
      compositionManifestPath: arrangementManifestPath,
      ...(normalized.render.pack ? { soundfontPackId: normalized.render.pack } : {}),
      ...(normalized.render.path ? { soundfontPath: normalized.render.path } : {}),
      instrumentPolicy: normalized.instrumentPolicy,
      stems: normalized.render.stems,
      normalize: normalized.render.normalize,
      outputAudioPath: paths.wav,
      outputStemDirectory: paths.stems,
      outputReportPath: paths.renderReport
    });
  }

  const audioQaItem = plan[5];
  const renderedAudioPath = resultPath(renderResult, ["productionWavPath", "masteredAudioPath", "fullMixPath"], renderResult?.ok ? paths.wav : undefined);
  const renderReportPath = resultPath(renderResult, ["reportPath", "renderReportPath"], renderResult?.ok ? paths.renderReport : undefined);
  if (!audioQaItem.enabled) {
    skipStage(audioQaItem, normalized.render.enabled ? "Audio QA disabled by qa.enabled=false; hard composition gates still ran." : "No-audio mode has no waveform to inspect.");
  } else if (blocker) {
    skipStage(audioQaItem, `Audio QA stopped because ${blocker.toolName} failed.`);
  } else if (!renderedAudioPath || !arrangementManifestPath) {
    audioQaResult = await runStage(audioQaItem, {
      projectId: normalized.projectId,
      compositionManifestPath: arrangementManifestPath ?? paths.arrangementManifest,
      outputPath: paths.audioQaReport
    });
  } else {
    audioQaResult = await runStage(audioQaItem, {
      projectId: normalized.projectId,
      audioPath: renderedAudioPath,
      compositionManifestPath: arrangementManifestPath,
      renderReportPath,
      targetMood: normalized.style.replaceAll("_", " "),
      outputPath: paths.audioQaReport
    });
  }

  const listeningUrl = renderListeningUrl(renderResult);
  const licenseAttributionPath = resultPath(renderResult, ["licensesPath", "licenseManifestPath", "packLicenseTextPath"])
    ?? nestedString(renderResult, "soundfont", ["licenseTextPath"]);
  const attribution = nestedString(renderResult, "soundfont", ["attribution"]);
  const finalItem = plan[6];
  const finalStartedAt = now();
  const finalCompletedAt = now();
  const finalStage: MusicProductionStageRecord = {
    id: finalItem.id,
    toolName: finalItem.toolName,
    status: "passed",
    hardGate: true,
    summary: `Revision-ready production manifest written to ${normalized.outputManifestPath}.`,
    artifacts: [normalized.outputManifestPath],
    errors: [],
    startedAt: finalStartedAt,
    completedAt: finalCompletedAt
  };
  stages.push(finalStage);
  const failedStage = blocker?.toolName;
  const nextAction = blocker ? nextActionFor(blocker.id) : warnings.length ? "Review disclosed warnings and unsupported outputs; rerun only if those outputs are required." : "Production is complete and ready for review or revision.";
  const status = blocker ? "revision_required" : warnings.length ? "completed_with_warnings" : "completed";
  const finalArtifacts = unique([
    ...artifacts,
    arrangementManifestPath,
    midiPath,
    normalized.outputs.score ? scorePath : undefined,
    normalized.outputManifestPath
  ]);
  const finalManifest = {
    schemaVersion: 1,
    kind: "music_production",
    status,
    compositionReady: !blocker,
    productionReady: !blocker && normalized.render.enabled,
    projectId: normalized.projectId,
    sourceLineage: {
      sourceCompositionManifestPath: normalized.sourceCompositionManifestPath,
      sourceType: "user_melody",
      preserveMelodicIdentity: normalized.development.preserveMelodicIdentity,
      variationLevel: normalized.development.variationLevel,
      reusableScorePath: scorePath
    },
    normalizedInputs: normalized,
    stages,
    requestedOutputs: normalized.outputs,
    deliveredOutputs: {
      manifestPath: normalized.outputManifestPath,
      arrangementManifestPath,
      midiPath,
      wavPath: normalized.outputs.wav ? renderedAudioPath : undefined,
      mp3Path: normalized.outputs.mp3 ? resultPath(renderResult, ["previewMp3Path"]) : undefined,
      score: normalized.outputs.score ? (scorePath ? { status: "reused", path: scorePath, generated: false } : { status: "unsupported", generated: false }) : undefined
    },
    unsupportedOutputs,
    artifacts: finalArtifacts,
    listeningUrl,
    qaResults: {
      constraints: constraintResult?.structuredContent,
      ensemble: ensembleResult?.structuredContent,
      development: developmentResult?.structuredContent,
      audio: audioQaResult?.structuredContent,
      passed: !blocker,
      audioVerified: Boolean(audioQaResult?.ok)
    },
    licenseAttributionPath,
    attribution,
    warnings,
    errors: blocker?.errors ?? [],
    revisionReadyState: {
      ready: true,
      arrangementManifestPath,
      midiPath,
      failedStage,
      nextAction,
      completedStageIds: stages.filter((stage) => stage.status === "passed").map((stage) => stage.id)
    },
    createdAt: finalCompletedAt
  };

  const writeResult = await callTool("write_project_file", {
    projectId: normalized.projectId,
    relativePath: normalized.outputManifestPath,
    content: `${JSON.stringify(finalManifest, null, 2)}\n`
  }, ctx).catch(failureResult);
  if (!writeResult.ok) {
    finalStage.status = "failed";
    finalStage.summary = writeResult.summary;
    finalStage.errors = [...writeResult.errors];
    finalStage.artifacts = [];
    return {
      ok: false,
      summary: `Music production stages completed, but the revision-ready manifest could not be written: ${writeResult.summary}`,
      jobId: normalized.projectId,
      artifacts: unique(artifacts),
      structuredContent: { ...finalManifest, status: "revision_required", productionReady: false, stages, manifestPath: undefined, nextAction: nextActionFor("final_manifest") },
      logs: [JSON.stringify({ stages, warnings }, null, 2)],
      errors: writeResult.errors
    };
  }

  const summary = blocker
    ? `Music production stopped at ${blocker.toolName}; preserved ${finalArtifacts.length} artifact(s) in revision-ready state.`
    : normalized.render.enabled
      ? `Music production completed with ${finalArtifacts.length} artifact(s)${listeningUrl ? " and a listening URL" : ""}.`
      : `No-audio music production completed with arrangement manifest, MIDI, and composition QA reports.`;
  return {
    ok: !blocker,
    summary,
    jobId: normalized.projectId,
    previewUrl: listeningUrl,
    shareUrl: listeningUrl,
    artifacts: finalArtifacts,
    structuredContent: { ...finalManifest, manifestPath: normalized.outputManifestPath, nextAction },
    logs: [JSON.stringify({ status, stages, warnings, unsupportedOutputs }, null, 2)],
    errors: blocker?.errors ?? []
  };
}

export const musicProductionOrchestratorTools: ToolModule[] = [
  {
    definition: {
      name: "create_music_production",
      description: "Create a revision-ready long-form music production by orchestrating arrangement extension, fail-closed instrument and development validation, optional realistic rendering, optional audio QA/publishing, and a truthful final manifest. Binary artifacts stay in project storage.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          sourceCompositionManifestPath: { type: "string" },
          targetDurationSec: { type: "number", minimum: 300, maximum: 900 },
          style: { type: "string", description: "Human-friendly style such as cinematic, soft cinematic, cafe jazz, bossa, lo-fi, game, or corporate." },
          instrumentPolicy: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["solo", "ensemble"] },
              allowed: { type: "array", items: { type: "string" } },
              allowedInstruments: { type: "array", items: { type: "string" } },
              prohibitedInstruments: { type: "array", items: { type: "string" } }
            },
            additionalProperties: false
          },
          development: { type: "object", properties: { variationLevel: { type: "string" }, preserveMelodicIdentity: { type: "boolean" } }, additionalProperties: false },
          render: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              pack: { type: "string" },
              path: { type: "string" },
              instrumentPackMap: {
                type: "object",
                description: "Optional strict per-role pack IDs, for example { realistic_piano: \"salamander_grand_verified\", cello: \"generaluser_gs\" }.",
                properties: Object.fromEntries(instrumentPackRoles.map((role) => [role, { type: "string" }])),
                additionalProperties: false
              },
              stems: { type: "boolean" },
              normalize: { type: "boolean" }
            },
            additionalProperties: false
          },
          outputs: {
            oneOf: [
              { type: "array", items: { type: "string", enum: outputNames } },
              { type: "object", properties: Object.fromEntries(outputNames.map((name) => [name, { type: "boolean" }])), additionalProperties: false }
            ]
          },
          qa: { type: "object", properties: { enabled: { type: "boolean" }, thresholds: { type: "object" } }, additionalProperties: false },
          publish: { type: "boolean" },
          outputManifestPath: { type: "string" }
        },
        required: ["projectId", "sourceCompositionManifestPath"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: createMusicProductionInputSchema,
    handler: (input, ctx) => executeMusicProduction(input, ctx)
  }
];
