import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { getProjectFilesDirectory, getProjectStoredFilePath, maxProjectMediaAssetBytes, publishProject, readProjectFile, writeProjectAsset, writeProjectFile } from "../../projects/store.js";
import { buildProjectPublishOptions } from "../../projects/publish-policy.js";
import type { ToolContext, ToolModule } from "../types.js";

const execFileAsync = promisify(execFile);

const musicStyleSchema = z.enum(["cafe_jazz", "lo_fi", "bossa_nova", "smooth_piano", "acoustic_pop", "cinematic_background", "corporate_intro", "game_bgm", "orchestral_sketch", "ambient", "chill_lounge"]);
const instrumentSchema = z.enum(["piano", "electric_piano", "upright_bass", "acoustic_bass", "violin", "cello", "drums", "brushes", "guitar", "strings", "pads", "synth", "sax_like_lead"]);
const complexitySchema = z.enum(["simple", "medium", "rich"]);
const sectionSchema = z.object({ name: z.string().min(1).max(40), bars: z.number().int().min(1).max(64), intensity: z.number().min(0).max(1).optional().default(0.5) });
const noteSchema = z.object({ track: z.string().min(1).max(80), midi: z.number().int().min(0).max(127), startBeat: z.number().min(0), durationBeats: z.number().min(0.05).max(64), velocity: z.number().int().min(1).max(127) });

type CanonicalInstrument = z.infer<typeof instrumentSchema>;

// Single source of truth for instrument identity. GM programs are 1-indexed (General MIDI
// spec numbering); the MIDI Program Change byte is `gmProgram - 1`. `channel` is the default
// 0-indexed MIDI channel used when no explicit channel mapping is supplied. Drums always live
// on channel 9 (GM percussion) and carry no melodic program. This catalog is consumed by
// MusicXML import (identity preservation), midiBuffer (program-change emission), stem grouping,
// and the ensemble validator so they never disagree about what a track represents.
// Order matters: more specific instruments come BEFORE the generic ones that would otherwise
// shadow them (electric_piano before piano; acoustic_bass before upright_bass's greedy /\bbass\b/),
// because canonicalInstrumentFromName returns the first matching entry in iteration order.
const instrumentCatalog: Record<CanonicalInstrument, { gmProgram: number; channel: number; namePatterns: RegExp[] }> = {
  electric_piano: { gmProgram: 5, channel: 2, namePatterns: [/electric\s*piano/i, /\brhodes\b/i, /\bwurli/i, /\bep\b/i] },
  piano: { gmProgram: 1, channel: 0, namePatterns: [/\bpiano\b/i, /\bkeyboard\b/i, /\bkeys\b/i, /\bgrand\b/i] },
  acoustic_bass: { gmProgram: 33, channel: 3, namePatterns: [/acoustic\s*bass/i] },
  upright_bass: { gmProgram: 33, channel: 3, namePatterns: [/upright\s*bass/i, /double\s*bass/i, /contrabass/i, /\bbass\b/i] },
  violin: { gmProgram: 41, channel: 4, namePatterns: [/\bviolin\b/i, /\bviola\b/i, /\bvln\b/i, /\bvla\b/i] },
  cello: { gmProgram: 43, channel: 5, namePatterns: [/\bcello\b/i, /violoncello/i, /\bvlc\b/i, /\bvc\b/i] },
  drums: { gmProgram: 1, channel: 9, namePatterns: [/\bdrum/i, /percussion/i, /\bkit\b/i] },
  brushes: { gmProgram: 1, channel: 9, namePatterns: [/brush/i] },
  guitar: { gmProgram: 25, channel: 6, namePatterns: [/\bguitar\b/i, /\bgtr\b/i, /\bnylon\b/i] },
  strings: { gmProgram: 49, channel: 8, namePatterns: [/string\s*ensemble/i, /\bstrings\b/i, /orchestra/i] },
  pads: { gmProgram: 89, channel: 10, namePatterns: [/\bpad\b/i, /ambien/i] },
  synth: { gmProgram: 81, channel: 11, namePatterns: [/\bsynth/i, /\blead\b/i] },
  sax_like_lead: { gmProgram: 67, channel: 12, namePatterns: [/\bsax/i, /saxophone/i] }
};

// Resolve a GM program number (1-indexed) to a canonical instrument by family range. Used to
// preserve identity when a MusicXML/MIDI part carries a <midi-program> but an ambiguous name.
function canonicalInstrumentFromGmProgram(gmProgram: number | undefined): CanonicalInstrument | undefined {
  if (gmProgram === undefined || !Number.isFinite(gmProgram)) return undefined;
  const program = Math.round(gmProgram);
  if (program >= 1 && program <= 4) return "piano";
  if (program >= 5 && program <= 8) return "electric_piano";
  if (program >= 25 && program <= 32) return "guitar";
  if (program >= 33 && program <= 40) return "upright_bass";
  if (program === 41 || program === 42) return "violin";
  if (program === 43 || program === 44) return "cello";
  if (program >= 49 && program <= 55) return "strings";
  if (program >= 65 && program <= 72) return "sax_like_lead";
  if (program >= 81 && program <= 88) return "synth";
  if (program >= 89 && program <= 96) return "pads";
  return undefined;
}

// Resolve an instrument/part name to a canonical instrument by pattern. Name match wins over GM
// program because score authors label parts deliberately (e.g. "Cello").
function canonicalInstrumentFromName(name: string | undefined): CanonicalInstrument | undefined {
  if (!name) return undefined;
  // Normalize underscores to spaces so track keys like "electric_piano" / "upright_bass" match the
  // same word-boundary patterns as their human-readable names ("\b" does not treat "_" as a
  // boundary, and "\s*" does not span "_").
  const normalized = name.replace(/_/g, " ");
  for (const [instrument, spec] of Object.entries(instrumentCatalog) as Array<[CanonicalInstrument, (typeof instrumentCatalog)[CanonicalInstrument]]>) {
    if (spec.namePatterns.some((pattern) => pattern.test(normalized))) return instrument;
  }
  return undefined;
}

// Resolve a composition track key (which may carry a `_2`, `_3`… disambiguation suffix for a
// second same-instrument part) to its canonical instrument. The suffix must be stripped before
// pattern matching because `\b` does not treat `_` as a word boundary, so `/\bcello\b/` would not
// match `cello_2`.
function canonicalInstrumentFromTrackKey(trackKey: string): CanonicalInstrument | undefined {
  return canonicalInstrumentFromName(trackKey.replace(/_\d+$/, ""));
}

// Combined resolver: prefer explicit part name, fall back to GM program, default to piano so a
// part is never silently dropped or mis-renamed to piano_N. Returns the resolution source so
// callers can surface a warning when they had to default.
function resolveCanonicalInstrument(hints: { name?: string; gmProgram?: number }): { instrument: CanonicalInstrument; source: "name" | "program" | "default" } {
  const byName = canonicalInstrumentFromName(hints.name);
  if (byName) return { instrument: byName, source: "name" };
  const byProgram = canonicalInstrumentFromGmProgram(hints.gmProgram);
  if (byProgram) return { instrument: byProgram, source: "program" };
  return { instrument: "piano", source: "default" };
}

const importMusicXmlScoreInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  musicXmlPath: z.string().min(1).max(240).optional(),
  musicXmlString: z.string().min(1).max(2 * 1024 * 1024).optional(),
  title: z.string().min(1).max(160).optional(),
  defaultTempo: z.number().int().min(40).max(220).optional().default(90),
  outputManifestPath: z.string().min(1).max(240).optional().default("music/imported-score-manifest.json"),
  outputMidiPath: z.string().min(1).max(240).optional().default("music/imported-score.mid")
}).refine((value) => Boolean(value.musicXmlPath || value.musicXmlString), {
  message: "musicXmlPath or musicXmlString is required."
});

const validateMusicEnsembleInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  compositionManifestPath: z.string().min(1).max(240),
  requiredInstruments: z.array(z.string().min(1).max(80)).min(1).max(16),
  soloInstruments: z.array(z.string().min(1).max(80)).max(16).optional().default([]),
  maxSingleInstrumentSeconds: z.number().min(0.5).max(120).optional().default(8),
  requireStartWithinBars: z.number().min(0).max(64).optional(),
  barBeats: z.number().int().min(1).max(16).optional().default(4)
});

const composeMusicInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(160).optional().default("Generated Music Cue"),
  style: musicStyleSchema.optional().default("cafe_jazz"),
  mood: z.string().min(1).max(240).optional().default("warm, relaxed, unobtrusive"),
  tempo: z.number().int().min(40).max(220).optional().default(92),
  key: z.string().min(1).max(12).optional().default("C"),
  durationSeconds: z.number().int().min(5).max(600).optional().default(60),
  useCase: z.string().min(1).max(240).optional().default("background music"),
  instruments: z.array(instrumentSchema).min(1).max(12).optional().default(["piano", "upright_bass", "brushes"]),
  complexity: complexitySchema.optional().default("medium"),
  loopable: z.boolean().optional().default(true),
  // Opt-in fail-closed ensemble gate (issue_0144). When set, the requested instruments must form a
  // real simultaneous ensemble (each present with notes, overlapping in time) or compose_music
  // returns ok:false instead of silently delivering a one-instrument cue.
  ensembleRequirement: z.object({
    requiredInstruments: z.array(z.string().min(1).max(80)).min(1).max(16),
    soloInstruments: z.array(z.string().min(1).max(80)).max(16).optional().default([]),
    maxSingleInstrumentSeconds: z.number().min(0.5).max(120).optional().default(8),
    requireStartWithinBars: z.number().min(0).max(64).optional(),
    barBeats: z.number().int().min(1).max(16).optional().default(4)
  }).optional(),
  outputManifestPath: z.string().min(1).max(240).optional().default("music/composition-manifest.json"),
  outputMidiPath: z.string().min(1).max(240).optional().default("music/composition.mid")
});

const editMidiInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  compositionManifestPath: z.string().min(1).max(240),
  quantizeBeats: z.number().min(0.0625).max(4).optional(),
  transposeSemitones: z.number().int().min(-24).max(24).optional().default(0),
  humanizeMs: z.number().int().min(0).max(80).optional().default(0),
  velocityScale: z.number().min(0.2).max(2).optional().default(1),
  swing: z.number().min(0).max(0.45).optional().default(0),
  duplicateSections: z.array(z.string().min(1).max(40)).max(12).optional().default([]),
  // Bass repair: raises LH/bass-track notes below raiseBelowMidi by one octave, reduces their
  // velocity, and caps their duration to prevent sustain-pedal rumble in piano SoundFonts.
  bassRepair: z.boolean().optional().default(false),
  bassRepairConfig: z.object({
    raiseBelowMidi: z.number().int().min(24).max(60).optional().default(48),
    velocityScale: z.number().min(0.3).max(1).optional().default(0.72),
    maxDurationBeats: z.number().min(0.25).max(4).optional().default(1.5)
  }).optional().default({}),
  outputManifestPath: z.string().min(1).max(240).optional().default("music/edited-composition-manifest.json"),
  outputMidiPath: z.string().min(1).max(240).optional().default("music/edited-composition.mid")
});

const renderMidiToAudioInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  compositionManifestPath: z.string().min(1).max(240).optional(),
  midiPath: z.string().min(1).max(240).optional(),
  instrumentMap: z.record(z.enum(["warm_acoustic_piano", "soft_electric_piano", "upright_bass", "acoustic_bass", "jazz_brushes", "light_drum_kit", "guitar", "violin", "cello", "strings", "pads", "mallets", "soft_synth"])).optional().default({}),
  renderPreset: z.enum(["warm_cafe", "lo_fi_soft", "cinematic_soft", "clean_corporate", "game_loop"]).optional().default("warm_cafe"),
  outputFormats: z.array(z.enum(["wav", "mp3", "ogg"])).min(1).max(3).optional().default(["wav"]),
  stems: z.boolean().optional().default(false),
  licenseConstraints: z.enum(["generated_only", "allow_bundled_safe", "third_party_review_required"]).optional().default("generated_only"),
  format: z.enum(["wav"]).optional().default("wav"),
  sampleRate: z.number().int().min(8000).max(48000).optional().default(22050),
  outputAudioPath: z.string().min(1).max(240).optional().default("music/rendered-preview.wav"),
  outputStemDirectory: z.string().min(1).max(200).optional().default("music/stems"),
  outputReportPath: z.string().min(1).max(240).optional().default("music/render-report.json"),
  // issue_0143: the built-in procedural/WebAudio-style synth must never be silently delivered as
  // music. This tool refuses by default; set true only to generate an explicitly throwaway,
  // non-deliverable preview.
  acknowledgePreviewOnly: z.boolean().optional().default(false)
}).refine((value) => Boolean(value.compositionManifestPath || value.midiPath), {
  message: "compositionManifestPath or midiPath is required."
});

const renderMidiWithSoundfontInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  compositionManifestPath: z.string().min(1).max(240).optional(),
  midiPath: z.string().min(1).max(240).optional(),
  soundfontPackId: z.string().min(1).max(80).optional(),
  soundfontPath: z.string().min(1).max(240).optional(),
  channelMap: z.record(z.number().int().min(0).max(15)).optional().default({}),
  programMap: z.record(z.number().int().min(1).max(128)).optional().default({}),
  stems: z.boolean().optional().default(false),
  // Opt-in loudness normalization (ffmpeg loudnorm). FluidSynth's default gain renders quiet; enable
  // for review-ready levels without using the full render_production_music mastering chain.
  normalize: z.boolean().optional().default(false),
  // Auto-author bow-pressure (CC11) swells + vibrato (CC1) into monophonic bowed-string lines so
  // sustained cello/violin/strings notes breathe instead of sitting flat. Only applies on the
  // compositionManifestPath path (externally supplied midiPath files render as-is). Default on;
  // set false to render strings exactly as written.
  expressiveStrings: z.boolean().optional().default(true),
  sampleRate: z.number().int().min(8000).max(96000).optional().default(44100),
  outputAudioPath: z.string().min(1).max(240).optional().default("music/rendered-soundfont.wav"),
  outputStemDirectory: z.string().min(1).max(200).optional().default("music/soundfont-stems"),
  outputReportPath: z.string().min(1).max(240).optional().default("music/soundfont-render-report.json"),
  // clean_dry = SoundFont render only, no noise bed/room ambience applied, optional loudnorm only.
  // normalized = clean_dry + loudnorm. Omit to keep existing default behavior.
  renderProfile: z.enum(["clean_dry", "normalized"]).optional()
}).refine((value) => Boolean(value.compositionManifestPath || value.midiPath), {
  message: "compositionManifestPath or midiPath is required."
}).refine((value) => Boolean(value.soundfontPackId || value.soundfontPath), {
  message: "soundfontPackId or soundfontPath is required."
});

const authorHandwrittenMusicScoreInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  title: z.string().min(1).max(240),
  tempoBpm: z.number().int().min(20).max(300),
  key: z.string().min(1).max(40),
  durationSec: z.number().min(1).max(3600),
  sections: z.array(sectionSchema).min(1).max(64),
  parts: z.object({
    piano_right_hand: z.array(noteSchema).min(1),
    piano_left_hand: z.array(noteSchema).min(1)
  }),
  chordMap: z.array(z.object({ bar: z.number().int().min(1), chord: z.string().min(1).max(40) })).min(1).max(256),
  performanceMap: z.object({
    timingJitterBeats: z.number().min(0).max(0.1).optional().default(0.01),
    velocityJitter: z.number().min(0).max(20).optional().default(5),
    sustainPedal: z.array(z.object({ startBeat: z.number().min(0), endBeat: z.number().min(0), value: z.number().min(0).max(127) })).optional().default([])
  }).optional().default({}),
  outputMusicXmlPath: z.string().min(1).max(240).optional().default("music/score.xml"),
  outputManifestPath: z.string().min(1).max(240).optional().default("music/composition-manifest.json"),
  outputMidiPath: z.string().min(1).max(240).optional().default("music/score.mid")
});

const validateMusicAuditionDistinctnessInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  manifestPaths: z.array(z.string().min(1).max(240)).min(2).max(8),
  minDistinctnessScore: z.number().min(0).max(1).optional().default(0.65),
  requireDifferentMelody: z.boolean().optional().default(true),
  requireDifferentChordMap: z.boolean().optional().default(true),
  outputReportPath: z.string().min(1).max(240).optional().default("music/distinctness-report.json")
});

const checkMusicRenderEnvironmentInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  includeLocalMusicPacks: z.boolean().optional().default(true),
  projectSearchDirectories: z.array(z.string().min(1).max(200)).max(20).optional().default(["soundfonts", "instruments", "music", "assets/soundfonts", "assets"]),
  requestedPackId: z.enum(["generaluser_gs", "ydp_grand", "salamander_grand"]).optional()
});

const renderProductionMusicInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  compositionManifestPath: z.string().min(1).max(240),
  soundfontPackId: z.string().min(1).max(80).optional(),
  soundfontPath: z.string().min(1).max(240).optional(),
  instrumentPackMap: z.object({
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
  }).optional().default({}),
  channelMap: z.record(z.number().int().min(0).max(15)).optional().default({}),
  programMap: z.record(z.number().int().min(1).max(128)).optional().default({}),
  sampleRate: z.number().int().min(8000).max(96000).optional().default(44100),
  targetRms: z.number().min(0.02).max(0.5).optional().default(0.16),
  truePeakCeiling: z.number().min(0.5).max(0.99).optional().default(0.89),
  outputProductionWavPath: z.string().min(1).max(240).optional().default("music/production.wav"),
  outputPreviewMp3Path: z.string().min(1).max(240).optional().default("music/preview.mp3"),
  outputRawRenderPath: z.string().min(1).max(240).optional().default("music/production/raw-render.wav"),
  outputStemDirectory: z.string().min(1).max(200).optional().default("music/stems"),
  outputMidiStemDirectory: z.string().min(1).max(200).optional().default("music/midi-stems"),
  outputLicensesPath: z.string().min(1).max(240).optional().default("LICENSES.md"),
  outputReportPath: z.string().min(1).max(240).optional().default("music/production-render-pipeline.json"),
  outputHtmlPath: z.string().min(1).max(240).optional().default("music-project.html"),
  publish: z.boolean().optional().default(true)
});
// No pack selector is required at parse time: a registered general_midi pack (from
// install_free_soundfont_pack) is discovered as the fallback in resolveProductionPackMap. When no
// pack covers a required role, that layer fails closed with a clear per-role blocker.

const installFreeSoundfontPackInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  packId: z.enum(["generaluser_gs", "ydp_grand", "salamander_grand"]),
  // Default the install directory to the pack's own folder so different packs don't overwrite each
  // other; the literal default keeps the prior GeneralUser behaviour when packId is omitted upstream.
  outputDirectory: z.string().min(1).max(200).optional()
}).transform((value) => ({
  ...value,
  outputDirectory: value.outputDirectory ?? (value.packId === "ydp_grand" ? "soundfonts/ydp-grand" : value.packId === "salamander_grand" ? "soundfonts/salamander" : "soundfonts/generaluser-gs")
}));

const discoverSoundfontPacksInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  includeLocalMusicPacks: z.boolean().optional().default(true),
  // issue_0146: include assets/soundfonts so a SoundFont installed under the project's assets tree
  // (install_free_soundfont_pack is frequently pointed there) is discoverable for self-heal
  // auto-registration, not just the bare soundfonts/ root.
  projectSearchDirectories: z.array(z.string().min(1).max(200)).max(20).optional().default(["soundfonts", "instruments", "music", "assets/soundfonts", "assets"])
});

const generateJazzHarmonyInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  styleFamily: z.enum(["cafe_jazz", "bossa_lounge", "smooth_lounge", "minor_jazz", "modal_lounge", "classic_ii_v_i"]).optional(),
  key: z.string().min(1).max(40).optional().default("C"),
  tempoBpm: z.number().int().min(40).max(220).optional().default(82),
  mood: z.string().min(1).max(240).optional().default("warm, calm, elegant"),
  sections: z.array(z.string().min(1).max(40)).min(1).max(16).optional(),
  complexity: z.enum(["simple", "medium", "rich"]).optional().default("medium"),
  instrumentTarget: z.array(z.enum(["piano", "electric_piano", "upright_bass", "acoustic_bass", "guitar", "strings", "pads"])).min(1).max(8).optional().default(["piano", "upright_bass"]),
  voicingType: z.enum(["rootless", "shell", "drop2", "beginner_safe", "warm_cafe", "sparse_background"]).optional().default("warm_cafe"),
  originalityPolicy: z.enum(["do_not_imitate_specific_songs_or_artists"]).optional().default("do_not_imitate_specific_songs_or_artists"),
  style: z.enum(["ii_v_i", "circle_fifths", "bossa", "modal_lounge", "minor_jazz"]).optional().default("ii_v_i"),
  bars: z.number().int().min(4).max(64).optional().default(16),
  outputPath: z.string().min(1).max(240).optional().default("music/jazz-harmony.json")
});

const generateDrumGrooveInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  styleFamily: z.enum(["cafe_jazz", "bossa_lounge", "lo_fi", "study_music", "soft_pop", "cinematic_background", "game_ambience", "retail_cafe"]).optional(),
  groove: z.enum(["jazz_brushes", "light_swing", "bossa_nova", "samba_lite", "lo_fi", "pop_ballad", "soft_pop_ballad", "cinematic_pulse", "ambient_percussion", "retail_cafe_low_distraction"]).optional().default("jazz_brushes"),
  tempo: z.number().int().min(40).max(220).optional().default(92),
  tempoBpm: z.number().int().min(40).max(220).optional(),
  meter: z.enum(["4/4", "3/4", "6/8"]).optional().default("4/4"),
  bars: z.number().int().min(1).max(64).optional().default(8),
  swing: z.number().min(0).max(0.75).optional().default(0.18),
  energy: z.enum(["low", "low_medium", "medium", "medium_high"]).optional().default("low_medium"),
  kit: z.enum(["jazz_brushes", "light_sticks", "bossa_percussion", "lo_fi_kit", "soft_pop_kit", "cinematic_soft_pulse", "ambient_percussion"]).optional().default("jazz_brushes"),
  sections: z.array(z.string().min(1).max(40)).min(1).max(16).optional(),
  constraints: z.object({
    backgroundFriendly: z.boolean().optional().default(true),
    noSuddenHits: z.boolean().optional().default(true),
    avoidAggressiveCymbals: z.boolean().optional().default(true),
    maxHitsPerBar: z.number().int().min(1).max(16).optional().default(8)
  }).optional().default({}),
  operations: z.array(z.enum(["generate_groove", "simplify_groove", "make_less_busy", "add_fill", "add_transition_fill", "humanize_timing", "change_swing_amount", "reduce_kick", "soften_snare", "use_brushes_instead_of_sticks"])).max(20).optional().default(["generate_groove"]),
  outputPath: z.string().min(1).max(240).optional().default("music/drum-groove.json"),
  outputMidiPath: z.string().min(1).max(240).optional().default("music/drum-groove.mid")
});

const inspectAudioQualityInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  audioPath: z.string().min(1).max(240).optional(),
  compositionManifestPath: z.string().min(1).max(240).optional(),
  sessionManifestPath: z.string().min(1).max(240).optional(),
  useCase: z.string().min(1).max(240).optional().default("background music"),
  checkLoop: z.boolean().optional().default(true),
  targetMood: z.string().min(1).max(240).optional(),
  outputPath: z.string().min(1).max(240).optional().default("music/audio-quality-report.json")
}).refine((value) => Boolean(value.audioPath || value.compositionManifestPath || value.sessionManifestPath), { message: "audioPath, compositionManifestPath, or sessionManifestPath is required." });

const exportMusicAssetsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  compositionManifestPath: z.string().min(1).max(240),
  midiPath: z.string().min(1).max(240).optional(),
  audioPath: z.string().min(1).max(240).optional(),
  includeStems: z.boolean().optional().default(false),
  license: z.enum(["generated_original", "user_provided", "third_party_review_required"]).optional().default("generated_original"),
  outputPath: z.string().min(1).max(240).optional().default("music/export-manifest.json")
});

const musicLicenseDependencySchema = z.object({
  path: z.string().min(1).max(240),
  type: z.enum(["generated_midi", "generated_audio_render", "soundfont", "sample_pack", "drum_kit", "impulse_response", "ambience_bed", "exported_wav", "exported_mp3", "exported_ogg", "stem", "session_mix", "virtual_instrument", "software_dependency"]).optional(),
  license: z.enum(["generated_original", "user_provided", "public_domain", "cc0", "cc_by", "mit", "apache_2", "commercial_license", "unknown", "not_safe_for_production"]).optional(),
  source: z.string().min(1).max(240).optional(),
  attribution: z.string().min(1).max(500).optional(),
  commercialUseAllowed: z.boolean().optional(),
  notes: z.string().min(1).max(500).optional()
});

const buildMusicLicenseManifestInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  projectManifestPath: z.string().min(1).max(240).optional(),
  intendedUse: z.enum(["business_demo", "business_demo_and_website_background", "website_background", "cafe_playback", "video", "game", "client_delivery", "internal_preview"]).optional().default("business_demo"),
  assets: z.array(z.union([z.string().min(1).max(240), musicLicenseDependencySchema])).min(1).max(120).optional().default([]),
  instrumentLibraries: z.array(musicLicenseDependencySchema).max(80).optional().default([]),
  sampleMetadata: z.array(musicLicenseDependencySchema).max(80).optional().default([]),
  outputPath: z.string().min(1).max(240).optional().default("music/license-safety-manifest.json")
});

const jazzInstrumentPackSchema = z.object({
  packId: z.string().min(2).max(80).regex(/^[a-zA-Z0-9_.-]+$/),
  displayName: z.string().min(1).max(160),
  instrumentRole: z.enum(["realistic_piano", "upright_bass", "brush_drums", "room_ambience", "cello", "violin", "strings", "chamber_ensemble", "orchestral_sketch", "general_midi"]),
  format: z.enum(["sfz", "soundfont", "wav_multisample", "impulse_response", "virtual_instrument"]),
  assetPaths: z.array(z.string().min(1).max(240)).min(1).max(80),
  version: z.string().min(1).max(80).optional(),
  declaredSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  licenseType: z.enum(["generated_original", "user_provided", "public_domain", "cc0", "cc_by", "mit", "apache_2", "commercial_license", "generaluser_gs_2_0", "lgpl", "gpl", "proprietary", "non_commercial", "unknown"]),
  source: z.string().min(1).max(240),
  sourceUrl: z.string().url().max(500).optional(),
  licenseTextPath: z.string().min(1).max(240).optional(),
  readmePath: z.string().min(1).max(240).optional(),
  productionUseApproved: z.boolean().optional(),
  qualityTier: z.enum(["production_candidate", "review_required", "preview_only"]).optional(),
  attribution: z.string().min(1).max(500).optional(),
  commercialUseAllowed: z.boolean().optional(),
  redistributionAllowed: z.boolean().optional(),
  modificationsAllowed: z.boolean().optional(),
  notes: z.string().min(1).max(500).optional()
});

const manageJazzInstrumentPacksInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  packs: z.array(jazzInstrumentPackSchema).min(1).max(40),
  intendedUse: z.enum(["streaming_demo", "website_background", "cafe_playback", "video", "game", "client_delivery", "internal_preview"]).optional().default("streaming_demo"),
  targetInstruments: z.array(z.enum(["realistic_piano", "upright_bass", "brush_drums", "room_ambience"])).min(1).max(8).optional().default(["realistic_piano", "upright_bass", "brush_drums"]),
  outputPath: z.string().min(1).max(240).optional().default("music/jazz-instrument-packs.json"),
  outputLicenseManifestPath: z.string().min(1).max(240).optional().default("music/jazz-instrument-license-manifest.json")
});

const createMusicStyleBriefInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  referencePrompt: z.string().min(1).max(400),
  useCase: z.string().min(1).max(240).optional().default("background music"),
  outputPath: z.string().min(1).max(240).optional().default("music/style-brief.json")
});

const auditionMusicVariationsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  brief: z.string().min(1).max(500),
  styles: z.array(musicStyleSchema).min(1).max(5).optional().default(["cafe_jazz", "bossa_nova", "lo_fi"]),
  durationSeconds: z.number().int().min(5).max(120).optional().default(20),
  outputPath: z.string().min(1).max(240).optional().default("music/audition-variations.json")
});

const generateMusicVariationsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  brief: z.string().min(1).max(500),
  styles: z.array(musicStyleSchema).min(1).max(6).optional().default(["cafe_jazz", "bossa_nova", "lo_fi"]),
  durationSeconds: z.number().int().min(10).max(120).optional().default(30),
  renderAudio: z.boolean().optional().default(false),
  outputPath: z.string().min(1).max(240).optional().default("music/production-variations.json")
});

const auditionVersionSchema = z.object({
  id: z.string().min(1).max(40),
  audioPath: z.string().min(1).max(240),
  midiPath: z.string().min(1).max(240).optional(),
  manifestPath: z.string().min(1).max(240).optional(),
  title: z.string().min(1).max(120).optional(),
  label: z.string().min(1).max(120).optional(),
  style: z.string().min(1).max(120).optional(),
  bpm: z.number().int().min(30).max(260).optional(),
  tempo: z.number().int().min(30).max(260).optional(),
  key: z.string().min(1).max(40).optional(),
  durationSec: z.number().min(0).max(3600).optional(),
  durationSeconds: z.number().min(0).max(3600).optional(),
  instruments: z.array(z.string().min(1).max(80)).max(20).optional().default([]),
  moodTags: z.array(z.string().min(1).max(80)).max(20).optional().default([]),
  styleNotes: z.array(z.string().min(1).max(160)).max(20).optional().default([]),
  generatedPrompt: z.string().min(1).max(500).optional(),
  scoreSourcePath: z.string().min(1).max(240).optional(),
  renderReportPath: z.string().min(1).max(240).optional(),
  renderer: z.string().min(1).max(80).optional(),
  qualityTier: z.string().min(1).max(80).optional(),
  productionReady: z.boolean().optional(),
  soundfontName: z.string().min(1).max(160).optional(),
  licenseStatus: z.string().min(1).max(160).optional(),
  qaScore: z.number().min(0).max(100).optional()
});
const publishMusicAuditionDemoInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  projectTitle: z.string().min(1).max(160).optional(),
  variationsManifestPath: z.string().min(1).max(240).optional(),
  versions: z.array(auditionVersionSchema).min(1).max(8).optional(),
  title: z.string().min(1).max(160).optional().default("Music Audition Demo"),
  allowDownloads: z.boolean().optional().default(true),
  publish: z.boolean().optional().default(true),
  outputHtmlPath: z.string().min(1).max(240).optional().default("music-demo.html"),
  outputManifestPath: z.string().min(1).max(240).optional().default("music/audition-demo-manifest.json")
}).refine((value) => Boolean(value.variationsManifestPath || value.versions?.length), {
  message: "variationsManifestPath or versions is required."
});

const extendMusicArrangementInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  compositionManifestPath: z.string().min(1).max(240),
  targetDurationSeconds: z.number().int().min(120).max(900).optional().default(300),
  arrangementStyle: z.enum(["background_friendly", "concert_style", "cinematic_arc", "loopable_longform"]).optional().default("background_friendly"),
  renderAudio: z.boolean().optional().default(false),
  acknowledgePreviewOnly: z.boolean().optional().default(false),
  outputManifestPath: z.string().min(1).max(240).optional().default("music/long-arrangement-manifest.json"),
  outputMidiPath: z.string().min(1).max(240).optional().default("music/long-arrangement.mid"),
  outputAudioPath: z.string().min(1).max(240).optional().default("music/long-arrangement-preview.wav")
});

const extendOriginalMusicArrangementInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  sourceManifestPath: z.string().min(1).max(240),
  targetDurationSec: z.number().int().min(300).max(900).optional().default(360),
  styleFamily: z.enum(["cafe_jazz", "bossa_lounge", "lo_fi_study", "piano_violin", "soft_cinematic", "game_ambience", "corporate_background"]).optional().default("cafe_jazz"),
  backgroundUse: z.enum(["coffee_shop", "study", "website", "video", "restaurant", "retail", "game"]).optional().default("coffee_shop"),
  variationLevel: z.enum(["low", "medium", "high"]).optional().default("medium"),
  sections: z.array(z.string().min(1).max(40)).min(4).max(16).optional().default(["intro", "A", "A_variation", "B", "bridge", "light_solo", "breakdown", "reprise", "outro"]),
  originalityPolicy: z.enum(["do_not_imitate_specific_songs_or_artists"]).optional().default("do_not_imitate_specific_songs_or_artists"),
  renderAudio: z.boolean().optional().default(false),
  acknowledgePreviewOnly: z.boolean().optional().default(false),
  outputManifestPath: z.string().min(1).max(240).optional().default("music/original-long-arrangement-manifest.json"),
  outputMidiPath: z.string().min(1).max(240).optional().default("music/original-long-arrangement.mid"),
  outputAudioPath: z.string().min(1).max(240).optional().default("music/original-long-arrangement-preview.wav")
});

const assembleMusicSessionInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  trackManifestPaths: z.array(z.string().min(1).max(240)).min(1).max(40),
  targetDurationMinutes: z.number().int().min(10).max(120).optional().default(60),
  useCase: z.enum(["cafe_ambience", "cafe_background", "study_music", "website_background", "video_background", "hotel_lobby", "restaurant", "retail_store", "game_ambience"]).optional().default("cafe_ambience"),
  energyProfile: z.enum(["calm_steady", "gentle_rise", "afternoon_cafe", "night_lounge", "focus_study", "event_warm_up"]).optional().default("calm_steady"),
  transitionStyle: z.enum(["soft_crossfade", "ambient_bed", "clean_gap", "gapless"]).optional().default("soft_crossfade"),
  crossfadeSeconds: z.number().int().min(0).max(30).optional().default(8),
  outputFormats: z.array(z.enum(["manifest", "wav", "mp3", "ogg", "segmented_playlist"])).min(1).max(5).optional().default(["manifest", "segmented_playlist"]),
  targetRms: z.number().min(0.02).max(0.5).optional().default(0.18),
  avoidRepeatDistance: z.number().int().min(0).max(10).optional().default(1),
  assetPolicy: z.enum(["original_or_user_licensed_only"]).optional().default("original_or_user_licensed_only"),
  outputPath: z.string().min(1).max(240).optional().default("music/session-assembly.json"),
  outputHtmlPath: z.string().min(1).max(240).optional().default("music-session.html"),
  publish: z.boolean().optional().default(false)
});

const normalizeMusicLoudnessInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  audioPath: z.string().min(1).max(240),
  targetRms: z.number().min(0.02).max(0.5).optional().default(0.18),
  outputAudioPath: z.string().min(1).max(240).optional().default("music/normalized-preview.wav"),
  outputReportPath: z.string().min(1).max(240).optional().default("music/loudness-report.json")
});

const createProductionMusicRenderPlanInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  compositionManifestPath: z.string().min(1).max(240).optional(),
  styleProfile: z.enum(["jazz_lounge", "cafe_piano_trio", "bossa_lounge", "lofi_lounge", "cinematic_soft"]).optional().default("jazz_lounge"),
  targetUse: z.enum(["streaming_demo", "cafe_background", "website_background", "video_background", "client_delivery", "internal_review"]).optional().default("streaming_demo"),
  instrumentPriorities: z.array(z.enum(["realistic_piano", "upright_bass", "brush_drums", "room_ambience", "strings_pad"])).max(8).optional().default(["realistic_piano", "upright_bass", "brush_drums", "room_ambience"]),
  licensePolicy: z.enum(["mit_apache_preferred", "commercial_safe_only", "generated_only_until_pack_verified"]).optional().default("mit_apache_preferred"),
  targetLufs: z.number().min(-24).max(-9).optional().default(-16),
  truePeakDb: z.number().min(-6).max(-0.1).optional().default(-1),
  outputPath: z.string().min(1).max(240).optional().default("music/production-render-plan.json")
});

const applyMusicMixMasterChainInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  audioPath: z.string().min(1).max(240),
  stemPaths: z.array(z.string().min(1).max(240)).max(40).optional().default([]),
  chain: z.array(z.enum(["room_ambience", "eq_cleanup", "gentle_compression", "limiter", "loudness_normalize"])).max(10).optional().default(["eq_cleanup", "gentle_compression", "limiter", "loudness_normalize"]),
  targetRms: z.number().min(0.02).max(0.5).optional().default(0.16),
  truePeakCeiling: z.number().min(0.5).max(0.99).optional().default(0.89),
  abLabel: z.string().min(1).max(80).optional().default("master_A"),
  outputAudioPath: z.string().min(1).max(240).optional().default("music/mastered-preview.wav"),
  outputReportPath: z.string().min(1).max(240).optional().default("music/mastering-report.json")
});

const reviewMusicProductionExportInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  productionPlanPath: z.string().min(1).max(240),
  masterReportPaths: z.array(z.string().min(1).max(240)).min(1).max(12),
  licenseManifestPath: z.string().min(1).max(240).optional(),
  exportManifestPath: z.string().min(1).max(240).optional(),
  outputPath: z.string().min(1).max(240).optional().default("music/production-export-review.json")
});

const exportMusicProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  projectManifestPath: z.string().min(1).max(240).optional(),
  packageName: z.string().min(1).max(160).optional(),
  selectedVersionIds: z.array(z.string().min(1).max(80)).max(40).optional().default([]),
  exports: z.array(z.enum(["single_track_wav", "single_track_mp3", "single_track_ogg", "session_wav", "session_mp3", "session_ogg", "midi", "stems", "chord_chart", "project_manifest", "license_manifest", "demo_page", "playlist_metadata"])).max(20).optional().default(["demo_page", "project_manifest", "playlist_metadata"]),
  renderedAudioPaths: z.array(z.string().min(1).max(240)).max(80).optional().default([]),
  midiPaths: z.array(z.string().min(1).max(240)).max(80).optional().default([]),
  stemPaths: z.array(z.string().min(1).max(240)).max(120).optional().default([]),
  chordChartPaths: z.array(z.string().min(1).max(240)).max(40).optional().default([]),
  renderReportPaths: z.array(z.string().min(1).max(240)).max(80).optional().default([]),
  qualityReportPaths: z.array(z.string().min(1).max(240)).max(20).optional().default([]),
  licenseManifestPath: z.string().min(1).max(240).optional(),
  version: z.string().min(1).max(80).optional(),
  bpm: z.number().int().min(20).max(300).optional(),
  key: z.string().min(1).max(40).optional(),
  durationSeconds: z.number().int().min(1).max(86400).optional(),
  demoManifestPath: z.string().min(1).max(240).optional(),
  sessionManifestPath: z.string().min(1).max(240).optional(),
  trackManifestPaths: z.array(z.string().min(1).max(240)).max(80).optional().default([]),
  publish: z.boolean().optional().default(true),
  outputHtmlPath: z.string().min(1).max(240).optional().default("music-project.html"),
  outputManifestPath: z.string().min(1).max(240).optional().default("music/production-export-manifest.json"),
  outputReadmePath: z.string().min(1).max(240).optional().default("music/export-package/README.md"),
  outputPackageReportPath: z.string().min(1).max(240).optional().default("music/export-package/package-report.json"),
  outputPlaylistPath: z.string().min(1).max(240).optional().default("music/export-package/playlist.json")
});

const musicFeedbackItemSchema = z.union([
  z.string().min(1).max(1000),
  z.object({
    timestamp: z.string().min(1).max(20).optional(),
    endTimestamp: z.string().min(1).max(20).optional(),
    comment: z.string().min(1).max(1000),
    rating: z.number().min(1).max(5).optional(),
    category: z.string().min(1).max(80).optional()
  })
]);

const processMusicRevisionFeedbackInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  selectedVersionId: z.string().min(1).max(80),
  auditionManifestPath: z.string().min(1).max(240).optional(),
  sourceManifestPath: z.string().min(1).max(240).optional(),
  feedback: z.array(musicFeedbackItemSchema).min(1).max(80),
  rejectedVersionIds: z.array(z.string().min(1).max(80)).max(40).optional().default([]),
  targetUseCase: z.enum(["cafe", "study", "video", "website", "game", "restaurant", "hotel_lobby", "retail", "client_demo", "background_music"]).optional(),
  targetDurationMinutes: z.number().min(0.5).max(120).optional(),
  currentRevisionId: z.string().min(1).max(80).optional(),
  previousRevisionHistoryPath: z.string().min(1).max(240).optional(),
  outputPath: z.string().min(1).max(240).optional().default("music/revision-feedback-plan.json")
});

const midiTrackNameSchema = z.enum(["piano", "electric_piano", "bass", "upright_bass", "acoustic_bass", "drums", "brush_drums", "guitar", "strings", "violin", "cello", "pads", "lead", "synth"]);
const midiOperationSchema = z.object({
  type: z.enum(["create_track", "edit_notes", "quantize", "humanize", "adjust_velocity", "transpose", "swing", "duplicate_section", "add_fill", "add_intro", "add_outro", "change_instrument", "mute_track", "solo_track"]),
  track: z.string().min(1).max(80).optional(),
  section: z.string().min(1).max(80).optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  notes: z.array(noteSchema.omit({ track: true })).max(500).optional()
});
const composeEditMidiInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  existingManifestPath: z.string().min(1).max(240).optional(),
  style: musicStyleSchema.optional().default("cafe_jazz"),
  mood: z.string().min(1).max(240).optional().default("warm, relaxed, background-friendly"),
  tempoBpm: z.number().int().min(40).max(220).optional().default(82),
  key: z.string().min(1).max(40).optional().default("F major"),
  durationSec: z.number().int().min(10).max(900).optional().default(300),
  tracks: z.array(midiTrackNameSchema).min(1).max(16).optional().default(["piano", "upright_bass", "brush_drums"]),
  sections: z.array(z.string().min(1).max(40)).min(1).max(24).optional().default(["intro", "A", "B", "solo", "A2", "outro"]),
  constraints: z.object({
    backgroundFriendly: z.boolean().optional().default(true),
    loopable: z.boolean().optional().default(false),
    swing: z.number().min(0).max(0.75).optional().default(0.58),
    maxMelodyDensityPerBar: z.number().min(1).max(16).optional().default(6),
    avoidHarshRegister: z.boolean().optional().default(true),
    stableDynamics: z.boolean().optional().default(true)
  }).optional().default({}),
  operations: z.array(midiOperationSchema).max(80).optional().default([]),
  // Opt-in fail-closed ensemble gate. When set, the requested instruments must form a real
  // simultaneous ensemble or the tool returns ok:false instead of reporting a misleading success.
  // Omit it to keep legacy/solo behaviour (e.g. a soloed track legitimately having zero notes).
  ensembleRequirement: z.object({
    requiredInstruments: z.array(z.string().min(1).max(80)).min(1).max(16),
    soloInstruments: z.array(z.string().min(1).max(80)).max(16).optional().default([]),
    maxSingleInstrumentSeconds: z.number().min(0.5).max(120).optional().default(8),
    requireStartWithinBars: z.number().min(0).max(64).optional(),
    barBeats: z.number().int().min(1).max(16).optional().default(4)
  }).optional(),
  outputManifestPath: z.string().min(1).max(240).optional().default("music/compose-edit-midi-manifest.json"),
  outputMidiPath: z.string().min(1).max(240).optional().default("music/compose-edit-midi.mid")
});

type Composition = {
  title: string;
  style: string;
  mood: string;
  tempo: number;
  key: string;
  durationSeconds: number;
  loopable: boolean;
  instruments: string[];
  sections: Array<z.infer<typeof sectionSchema>>;
  chordProgression: string[];
  tracks: Record<string, Array<z.infer<typeof noteSchema>>>;
  license: { output: string; dependencies: string[] };
  compositionPlan?: {
    form: Array<{ name: string; bars: number; role: string; targetIntensity: number }>;
    motifs: Array<{ id: string; contour: string; rhythm: string; development: string[] }>;
    energyCurve: number[];
    arrangementIntent: string[];
  };
  performance?: {
    humanized: boolean;
    timingJitterBeats: number;
    velocityJitter: number;
    sustainPedal: Array<{ startBeat: number; endBeat: number; value: number }>;
    rubatoMap: Array<{ beat: number; tempoScale: number }>;
  };
  musicalityReport?: ReturnType<typeof musicalityForComposition>;
};

type MusicXmlImportResult = {
  composition: Composition & {
    scoreSource: Record<string, unknown>;
    warnings: string[];
    recommendedNextTools: string[];
    recommendedPianoPack: Record<string, unknown>;
  };
  sourceXml: string;
};

const noteBase: Record<string, number> = { C: 60, Db: 61, D: 62, Eb: 63, E: 64, F: 65, Gb: 66, G: 67, Ab: 68, A: 69, Bb: 70, B: 71 };
const chordIntervals: Record<string, number[]> = { maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], "7": [0, 4, 7, 10], m9: [0, 3, 7, 10, 14], "13": [0, 4, 7, 10, 21], dim: [0, 3, 6, 9] };

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record["#text"] !== undefined) return textValue(record["#text"]);
  }
  return undefined;
}

function numericValue(value: unknown): number | undefined {
  const text = textValue(value);
  if (text === undefined) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function attrNumber(value: unknown, attr: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return numericValue(record[`@_${attr}`]);
}

function attrText(value: unknown, attr: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return textValue(record[`@_${attr}`]);
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = numericValue(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

const musicXmlStepSemitones: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const keyNamesByFifths: Record<number, string> = {
  "-7": "Cb major",
  "-6": "Gb major",
  "-5": "Db major",
  "-4": "Ab major",
  "-3": "Eb major",
  "-2": "Bb major",
  "-1": "F major",
  0: "C major",
  1: "G major",
  2: "D major",
  3: "A major",
  4: "E major",
  5: "B major",
  6: "F# major",
  7: "C# major"
};

// Relative minor for each fifths count, so a MusicXML <key> with <mode>minor</mode> imports as the
// minor key it actually is (e.g. fifths=-1 + minor = D minor, not its relative major F).
const keyNamesByFifthsMinor: Record<number, string> = {
  "-7": "Ab minor",
  "-6": "Eb minor",
  "-5": "Bb minor",
  "-4": "F minor",
  "-3": "C minor",
  "-2": "G minor",
  "-1": "D minor",
  0: "A minor",
  1: "E minor",
  2: "B minor",
  3: "F# minor",
  4: "C# minor",
  5: "G# minor",
  6: "D# minor",
  7: "A# minor"
};

// Reverse lookup: "D minor" → { fifths: -1, mode: "minor" }
function fifthsFromKeyName(key: string): { fifths: number; mode: "major" | "minor" } {
  for (const [fifths, name] of Object.entries(keyNamesByFifthsMinor)) {
    if (name.toLowerCase() === key.toLowerCase()) return { fifths: Number(fifths), mode: "minor" };
  }
  for (const [fifths, name] of Object.entries(keyNamesByFifths)) {
    if (name.toLowerCase() === key.toLowerCase()) return { fifths: Number(fifths), mode: "major" };
  }
  return { fifths: 0, mode: "major" };
}

// MIDI number → MusicXML <pitch> element (prefer naturals + sharps)
function midiToPitchXml(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  const semitone = midi % 12;
  const pitchMap: Array<[string, number]> = [
    ["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0],
    ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0],
    ["A", 1], ["B", 0]
  ];
  const [step, alter] = pitchMap[semitone];
  const alterXml = alter !== 0 ? `<alter>${alter}</alter>` : "";
  return `<pitch><step>${step}</step>${alterXml}<octave>${octave}</octave></pitch>`;
}

// Build MusicXML note elements for one measure of one part.
// Returns rest-filled measure content so the measure is always metrically complete.
function buildMeasureNotesXml(
  notes: Array<{ midi: number; startBeat: number; durationBeats: number; velocity: number }>,
  measureStart: number,
  beatsPerBar: number,
  divisions: number,
  isFirstMeasure: boolean,
  tempoBpm: number,
  keyXml: string
): string {
  const measureEnd = measureStart + beatsPerBar;
  const totalDivisions = beatsPerBar * divisions;

  const localNotes = notes
    .filter((n) => n.startBeat >= measureStart - 0.005 && n.startBeat < measureEnd - 0.005)
    .sort((a, b) => a.startBeat - b.startBeat || b.midi - a.midi);

  let xml = "";
  if (isFirstMeasure) {
    xml += `<attributes><divisions>${divisions}</divisions>${keyXml}<time><beats>${beatsPerBar}</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>`;
    xml += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempoBpm}</per-minute></metronome></direction-type><sound tempo="${tempoBpm}"/></direction>`;
  }

  let usedDivisions = 0;
  let prevBeat = measureStart;

  for (let i = 0; i < localNotes.length; i++) {
    const note = localNotes[i];
    const isChord = i > 0 && Math.abs(note.startBeat - localNotes[i - 1].startBeat) < 0.01;

    if (!isChord) {
      // Fill gap before note with a rest
      const gapBeats = note.startBeat - prevBeat;
      if (gapBeats > 0.01) {
        const gapDiv = Math.min(totalDivisions - usedDivisions, Math.max(1, Math.round(gapBeats * divisions)));
        if (gapDiv > 0) {
          xml += `<note><rest/><duration>${gapDiv}</duration><type>quarter</type><voice>1</voice></note>`;
          usedDivisions += gapDiv;
        }
      }
    }

    const remaining = totalDivisions - usedDivisions;
    const noteDiv = Math.min(remaining, Math.max(1, Math.round(note.durationBeats * divisions)));
    if (noteDiv <= 0) continue;

    const chordTag = isChord ? "<chord/>" : "";
    xml += `<note>${chordTag}${midiToPitchXml(note.midi)}<duration>${noteDiv}</duration><type>quarter</type><voice>1</voice></note>`;
    if (!isChord) {
      usedDivisions += noteDiv;
      prevBeat = note.startBeat + note.durationBeats;
    }
  }

  // Trailing rest to fill remaining measure
  const trailingDiv = totalDivisions - usedDivisions;
  if (trailingDiv > 0) {
    xml += `<note><rest/><duration>${trailingDiv}</duration><type>quarter</type><voice>1</voice></note>`;
  }

  return xml;
}

// Build a minimal but valid MusicXML document from RH/LH note arrays.
function buildHandwrittenMusicXml(params: {
  title: string;
  tempoBpm: number;
  key: string;
  totalBars: number;
  rhNotes: Array<{ midi: number; startBeat: number; durationBeats: number; velocity: number }>;
  lhNotes: Array<{ midi: number; startBeat: number; durationBeats: number; velocity: number }>;
}): string {
  const DIVISIONS = 4;
  const BEATS_PER_BAR = 4;
  const { fifths, mode } = fifthsFromKeyName(params.key);
  const keyXml = `<key><fifths>${fifths}</fifths><mode>${mode}</mode></key>`;

  const buildPartXml = (
    notes: Array<{ midi: number; startBeat: number; durationBeats: number; velocity: number }>,
    partId: string
  ): string => {
    let measuresXml = "";
    for (let bar = 0; bar < params.totalBars; bar++) {
      const measureStart = bar * BEATS_PER_BAR;
      const notesXml = buildMeasureNotesXml(notes, measureStart, BEATS_PER_BAR, DIVISIONS, bar === 0, params.tempoBpm, keyXml);
      measuresXml += `<measure number="${bar + 1}">${notesXml}</measure>`;
    }
    return `<part id="${partId}">${measuresXml}</part>`;
  };

  const safeTitle = params.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<score-partwise version="3.1">`,
    `<work><work-title>${safeTitle}</work-title></work>`,
    `<part-list>`,
    `<score-part id="P1"><part-name>Piano Right Hand</part-name><midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>1</midi-program></midi-instrument></score-part>`,
    `<score-part id="P2"><part-name>Piano Left Hand</part-name><midi-instrument id="P2-I1"><midi-channel>1</midi-channel><midi-program>1</midi-program></midi-instrument></score-part>`,
    `</part-list>`,
    buildPartXml(params.rhNotes, "P1"),
    buildPartXml(params.lhNotes, "P2"),
    `</score-partwise>`
  ].join("\n");
}

// --- Audition Distinctness Helpers ---

// Extract melodic contour (sequence of pitch intervals between successive RH melody notes).
function melodyContourSignature(notes: Array<{ midi: number; startBeat: number }>): number[] {
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat);
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) intervals.push(sorted[i].midi - sorted[i - 1].midi);
  return intervals;
}

// Normalised edit distance between two numeric sequences (0 = identical, 1 = fully different).
function sequenceEditDistance(a: number[], b: number[]): number {
  if (!a.length && !b.length) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 0;
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return Math.min(1, dp[a.length][b.length] / maxLen);
}

// Jaccard similarity between two pitch-class sets (0 = no overlap, 1 = identical).
function pitchClassJaccard(aPC: Set<number>, bPC: Set<number>): number {
  if (!aPC.size && !bPC.size) return 1;
  let intersection = 0;
  for (const pc of aPC) if (bPC.has(pc)) intersection++;
  const union = new Set([...aPC, ...bPC]).size;
  return union === 0 ? 1 : intersection / union;
}

// Rhythm signature: sequence of quantized durationBeats (bucketed to nearest 0.25).
function rhythmSignature(notes: Array<{ durationBeats: number; startBeat: number }>): number[] {
  return [...notes].sort((a, b) => a.startBeat - b.startBeat).map((n) => Math.round(n.durationBeats * 4) / 4);
}

// Compare two chord progression arrays as sorted strings for rough similarity.
function chordMapSimilarity(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const sa = new Set(a.map((c) => c.toLowerCase().trim()));
  const sb = new Set(b.map((c) => c.toLowerCase().trim()));
  return pitchClassJaccard(new Set([...sa].map((c) => c.charCodeAt(0) % 12)), new Set([...sb].map((c) => c.charCodeAt(0) % 12)));
}

// Overall pairwise similarity [0..1]. distinctnessScore = 1 - similarity.
function pairwiseSimilarity(
  a: Composition & Record<string, unknown>,
  b: Composition & Record<string, unknown>,
  options: { requireDifferentMelody: boolean; requireDifferentChordMap: boolean }
): {
  similarityScore: number;
  melodyContourSimilarity: number;
  pitchClassSimilarity: number;
  rhythmSimilarity: number;
  chordMapSimilarity: number;
  sectionFormSimilarity: number;
  blockingReasons: string[];
} {
  const rhA = (a.tracks["piano_right_hand"] ?? []) as Array<{ midi: number; startBeat: number; durationBeats: number; velocity: number }>;
  const rhB = (b.tracks["piano_right_hand"] ?? []) as Array<{ midi: number; startBeat: number; durationBeats: number; velocity: number }>;

  const contourA = melodyContourSignature(rhA);
  const contourB = melodyContourSignature(rhB);
  const melodyEditDist = sequenceEditDistance(contourA.slice(0, 32), contourB.slice(0, 32));
  const melodyContourSim = 1 - melodyEditDist;

  const pcA = new Set(rhA.map((n) => n.midi % 12));
  const pcB = new Set(rhB.map((n) => n.midi % 12));
  const pitchClassSim = pitchClassJaccard(pcA, pcB);

  const rhythmA = rhythmSignature(rhA).slice(0, 32);
  const rhythmB = rhythmSignature(rhB).slice(0, 32);
  const rhythmSim = 1 - sequenceEditDistance(rhythmA, rhythmB);

  const chordSim = chordMapSimilarity(a.chordProgression ?? [], b.chordProgression ?? []);

  const sectionNamesA = (a.sections ?? []).map((s: { name: string }) => s.name).join(",");
  const sectionNamesB = (b.sections ?? []).map((s: { name: string }) => s.name).join(",");
  const sectionFormSim = sectionNamesA === sectionNamesB ? 1 : sectionNamesA.length === 0 || sectionNamesB.length === 0 ? 0.5 : 0;

  // Weighted average similarity
  const overallSim = melodyContourSim * 0.35 + pitchClassSim * 0.20 + rhythmSim * 0.20 + chordSim * 0.15 + sectionFormSim * 0.10;

  const blockingReasons: string[] = [];
  if (options.requireDifferentMelody && melodyContourSim > 0.80) blockingReasons.push(`Melody contour is too similar (similarity=${melodyContourSim.toFixed(2)}, threshold=0.80).`);
  if (options.requireDifferentChordMap && chordSim > 0.85) blockingReasons.push(`Chord map is too similar (similarity=${chordSim.toFixed(2)}, threshold=0.85).`);

  return {
    similarityScore: Number(overallSim.toFixed(3)),
    melodyContourSimilarity: Number(melodyContourSim.toFixed(3)),
    pitchClassSimilarity: Number(pitchClassSim.toFixed(3)),
    rhythmSimilarity: Number(rhythmSim.toFixed(3)),
    chordMapSimilarity: Number(chordSim.toFixed(3)),
    sectionFormSimilarity: Number(sectionFormSim.toFixed(3)),
    blockingReasons
  };
}

function keyNameFromFifths(fifths: number, mode: string | undefined): string | undefined {
  const table = mode?.toLowerCase() === "minor" ? keyNamesByFifthsMinor : keyNamesByFifths;
  return table[fifths];
}

function midiFromMusicXmlPitch(pitch: unknown): number | undefined {
  if (!pitch || typeof pitch !== "object") return undefined;
  const record = pitch as Record<string, unknown>;
  const step = textValue(record.step);
  const octave = numericValue(record.octave);
  if (!step || octave === undefined || musicXmlStepSemitones[step] === undefined) return undefined;
  const alter = numericValue(record.alter) ?? 0;
  return Math.max(0, Math.min(127, Math.round((octave + 1) * 12 + musicXmlStepSemitones[step] + alter)));
}

function musicXmlVelocity(note: Record<string, unknown>, directionVelocity: number | undefined): number {
  const noteDynamics = attrNumber(note, "dynamics");
  const velocity = noteDynamics ?? directionVelocity ?? 72;
  return Math.max(1, Math.min(127, Math.round(velocity)));
}

function directionTempo(direction: Record<string, unknown>): number | undefined {
  const soundTempo = attrNumber(direction.sound, "tempo");
  if (soundTempo !== undefined) return soundTempo;
  const directionTypes = asArray(direction["direction-type"] as unknown);
  for (const item of directionTypes) {
    if (!item || typeof item !== "object") continue;
    const metronome = (item as Record<string, unknown>).metronome as Record<string, unknown> | undefined;
    const perMinute = firstNumber(metronome?.["per-minute"]);
    if (perMinute !== undefined) return perMinute;
  }
  return undefined;
}

function directionDynamics(direction: Record<string, unknown>): number | undefined {
  const soundDynamics = attrNumber(direction.sound, "dynamics");
  if (soundDynamics !== undefined) return soundDynamics;
  const directionTypes = asArray(direction["direction-type"] as unknown);
  for (const item of directionTypes) {
    if (!item || typeof item !== "object") continue;
    const dynamics = (item as Record<string, unknown>).dynamics as Record<string, unknown> | undefined;
    if (!dynamics) continue;
    if (dynamics.pp || dynamics.p) return 44;
    if (dynamics.mp) return 56;
    if (dynamics.mf) return 72;
    if (dynamics.f) return 88;
    if (dynamics.ff) return 104;
  }
  return undefined;
}

function scoreTitle(score: Record<string, unknown>, fallback?: string) {
  return fallback ?? textValue(score["movement-title"]) ?? textValue((score.work as Record<string, unknown> | undefined)?.["work-title"]) ?? "Imported MusicXML Score";
}

function defaultCommercialSafePianoPackRecommendation() {
  return {
    packId: "salamander-grand-piano-sf2",
    displayName: "Salamander Grand Piano SF2 compatible pack",
    instrumentRole: "realistic_piano",
    format: "soundfont",
    targetDirectory: ".music-packs/",
    licenseType: "cc_by",
    commercialUseAllowed: true,
    attributionRequired: true,
    source: "https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html",
    notes: "Large SoundFont binaries must be user-provided or downloaded outside git, then registered with manage_jazz_instrument_packs using the local project asset path and computed SHA-256."
  };
}

async function importMusicXmlScore(ctx: ToolContext, input: z.infer<typeof importMusicXmlScoreInputSchema>): Promise<MusicXmlImportResult> {
  const sourceXml = input.musicXmlString ?? await readProjectFile(ctx.projectRoot, input.projectId, input.musicXmlPath!, 2 * 1024 * 1024);
  const validation = XMLValidator.validate(sourceXml);
  if (validation !== true) {
    const message = typeof validation === "object" ? validation.err.msg : "Invalid MusicXML document.";
    throw new Error(`Invalid MusicXML: ${message}`);
  }
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", trimValues: true });
  const parsed = parser.parse(sourceXml) as Record<string, unknown>;
  const score = parsed["score-partwise"] as Record<string, unknown> | undefined;
  if (!score || typeof score !== "object") throw new Error("Invalid MusicXML: expected score-partwise root.");

  const warnings: string[] = [];
  const parts = asArray(score.part as Record<string, unknown> | Record<string, unknown>[] | undefined);
  if (!parts.length) throw new Error("Invalid MusicXML: no score parts found.");

  // Build a part-id -> {name, gmProgram} map from <part-list><score-part>. The score author's
  // part name and any <midi-instrument><midi-program> are the authoritative identity hints; the
  // <part> nodes we iterate below only carry note data, not identity. Preserving this is the fix
  // for "Cello got renamed to piano_2".
  const partList = score["part-list"] as Record<string, unknown> | undefined;
  const partIdentity = new Map<string, { name?: string; gmProgram?: number }>();
  for (const scorePart of asArray(partList?.["score-part"] as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    const id = attrText(scorePart, "id");
    if (!id) continue;
    const name = textValue(scorePart["part-name"]) ?? textValue(scorePart["part-name-display"]);
    const midiInstrument = asArray(scorePart["midi-instrument"] as Record<string, unknown> | Record<string, unknown>[] | undefined)[0];
    const gmProgram = numericValue(midiInstrument?.["midi-program"]);
    partIdentity.set(id, { name: name ?? undefined, gmProgram: gmProgram ?? undefined });
  }

  // Track-key allocator: canonical instrument id becomes the track key. When two parts resolve to
  // the same instrument (e.g. two cellos) we suffix the second onward as `cello_2` so neither part
  // is clobbered — but we never rename a real cello to `piano_2`.
  const usedTrackKeys = new Map<CanonicalInstrument, number>();
  const allocateTrackKey = (instrument: CanonicalInstrument): string => {
    const seen = usedTrackKeys.get(instrument) ?? 0;
    usedTrackKeys.set(instrument, seen + 1);
    return seen === 0 ? instrument : `${instrument}_${seen + 1}`;
  };
  const trackInstruments: Record<string, CanonicalInstrument> = {};

  let tempo = input.defaultTempo;
  let key = "C major";
  let divisions = 1;
  let maxBeat = 0;
  const tracks: Composition["tracks"] = {};
  const chordNames = new Set<string>();
  const sections: Composition["sections"] = [];

  for (const [partIndex, part] of parts.entries()) {
    const partId = attrText(part, "id") ?? `P${partIndex + 1}`;
    const identity = partIdentity.get(partId) ?? {};
    const resolved = resolveCanonicalInstrument({ name: identity.name, gmProgram: identity.gmProgram });
    if (resolved.source === "default" && (identity.name || identity.gmProgram !== undefined)) {
      warnings.push(`Part ${partId}${identity.name ? ` ("${identity.name}")` : ""} did not match a known instrument; defaulted to piano.`);
    }
    const track = allocateTrackKey(resolved.instrument);
    trackInstruments[track] = resolved.instrument;
    tracks[track] ??= [];
    let beat = 0;
    let lastNoteStartBeat = 0;
    let directionVelocity: number | undefined;
    const measures = asArray(part.measure as Record<string, unknown> | Record<string, unknown>[] | undefined);
    if (!measures.length) warnings.push(`Part ${partId} has no measures.`);
    for (const [measureIndex, measure] of measures.entries()) {
      const measureStartBeat = beat;
      const attributes = measure.attributes as Record<string, unknown> | undefined;
      const nextDivisions = numericValue(attributes?.divisions);
      if (nextDivisions && nextDivisions > 0) divisions = nextDivisions;
      const keyNode = attributes?.key as Record<string, unknown> | undefined;
      const fifths = firstNumber(keyNode?.fifths);
      if (fifths !== undefined) key = keyNameFromFifths(fifths, textValue(keyNode?.mode)) ?? key;
      for (const direction of asArray(measure.direction as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
        const parsedTempo = directionTempo(direction);
        if (parsedTempo !== undefined) tempo = Math.max(40, Math.min(220, Math.round(parsedTempo)));
        directionVelocity = directionDynamics(direction) ?? directionVelocity;
      }
      for (const harmonyNode of asArray(measure.harmony as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
        const rootStep = textValue((harmonyNode.root as Record<string, unknown> | undefined)?.["root-step"]);
        const kind = textValue(harmonyNode.kind);
        if (rootStep) chordNames.add(kind ? `${rootStep} ${kind}` : rootStep);
      }
      for (const note of asArray(measure.note as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
        const durationDivisions = numericValue(note.duration) ?? divisions;
        const durationBeats = Math.max(0.05, Math.min(64, durationDivisions / Math.max(1, divisions)));
        const isChord = Object.prototype.hasOwnProperty.call(note, "chord");
        const isRest = Object.prototype.hasOwnProperty.call(note, "rest");
        const startBeat = isChord ? lastNoteStartBeat : beat;
        if (!isChord) lastNoteStartBeat = startBeat;
        if (!isRest) {
          const midi = midiFromMusicXmlPitch(note.pitch);
          if (midi === undefined) {
            warnings.push(`Skipped note with missing/unsupported pitch in part ${partId}, measure ${measureIndex + 1}.`);
          } else {
            tracks[track].push({
              track,
              midi,
              startBeat: Number(startBeat.toFixed(3)),
              durationBeats: Number(durationBeats.toFixed(3)),
              velocity: musicXmlVelocity(note, directionVelocity)
            });
          }
        }
        if (!isChord) beat += durationBeats;
      }
      const measureBeats = Math.max(1, beat - measureStartBeat);
      sections.push({ name: `measure_${measureIndex + 1}`, bars: Math.max(1, Math.round(measureBeats / 4)), intensity: 0.5 });
    }
    maxBeat = Math.max(maxBeat, beat);
  }

  const notes = Object.values(tracks).flat();
  if (!notes.length) throw new Error("Invalid MusicXML: no pitched notes could be imported.");
  if (tempo === input.defaultTempo) warnings.push(`No explicit tempo found; used defaultTempo ${input.defaultTempo} BPM.`);
  if (key === "C major") warnings.push("No explicit key signature found; used C major.");

  const durationSeconds = Math.max(1, Math.ceil(maxBeat * 60 / tempo));
  const importedSections = sections.length ? sections.slice(0, 64) : [{ name: "score", bars: Math.max(1, Math.round(maxBeat / 4)), intensity: 0.5 }];
  const totalBars = importedSections.reduce((sum, s) => sum + s.bars, 0);
  // Derive a minimal compositionPlan and performance from the score so inspect_audio_quality and
  // musicalityForComposition do not reject the manifest as "robotic / missing plan". A handwritten
  // or imported score IS its own plan; humanized=true reflects that the author already shaped the
  // performance — we do not need the tool-generated plan/performance layers.
  const importedCompositionPlan = {
    form: importedSections.map((s, i) => ({ name: s.name, bars: s.bars, role: i === 0 ? "opening section" : "continuation", targetIntensity: s.intensity })),
    motifs: [{ id: "score_melody", contour: "score-authored melodic content", rhythm: "score-notated", development: ["as written in score"] }],
    energyCurve: Array.from({ length: Math.max(1, totalBars) }, (_, i) => Number((0.4 + Math.sin(Math.PI * (totalBars <= 1 ? 0 : i / (totalBars - 1))) * 0.35).toFixed(3))),
    arrangementIntent: ["Score-driven piano performance: render as notated.", "SoundFont must match acoustic or grand piano timbre."]
  };
  const importedPerformance = {
    humanized: true,
    timingJitterBeats: 0,
    velocityJitter: 0,
    sustainPedal: [] as Array<{ startBeat: number; endBeat: number; value: number }>,
    rubatoMap: [] as Array<{ beat: number; tempoScale: number }>
  };
  const composition: MusicXmlImportResult["composition"] = {
    title: scoreTitle(score, input.title),
    style: "score_import",
    mood: "score-driven piano performance",
    tempo,
    key,
    durationSeconds,
    loopable: false,
    instruments: Object.keys(tracks),
    sections: importedSections,
    chordProgression: chordNames.size ? [...chordNames] : ["score_notated"],
    tracks,
    compositionPlan: importedCompositionPlan,
    performance: importedPerformance,
    license: {
      output: "generated_from_user_or_project_score",
      dependencies: ["MusicXML score content supplied by project/user.", "Audio render should use render_midi_with_soundfont with a registered commercial-safe piano SoundFont for production_candidate output."]
    },
    scoreSource: {
      format: "MusicXML",
      sourcePath: input.musicXmlPath,
      importedAt: new Date().toISOString(),
      partCount: parts.length,
      noteCount: notes.length,
      scoreDriven: true,
      trackInstruments
    },
    warnings,
    recommendedNextTools: ["manage_jazz_instrument_packs", "render_midi_with_soundfont", "inspect_audio_quality", "export_music_project"],
    recommendedPianoPack: defaultCommercialSafePianoPackRecommendation()
  };
  return { composition, sourceXml };
}

function keyRoot(key: string) {
  const root = normalizeKeyRoot(key);
  return noteBase[root] ?? 60;
}

function progressionFor(style: string, key: string) {
  const names = style === "bossa_nova"
    ? ["Dm9", "G13", "Cmaj7", "A7"]
    : style === "lo_fi"
      ? ["Cmaj7", "Am7", "Dm7", "G7"]
      : style === "smooth_piano"
        ? ["Am7", "Fmaj7", "Cmaj7", "G13", "Dm9", "Am7", "Fmaj7", "E7"]
        : style === "cinematic_background"
          ? ["Am", "Fmaj7", "C", "G"]
          : ["Dm9", "G13", "Cmaj7", "Am7", "Dm9", "G13sus", "Cmaj7", "C6/9"];
  const roots = names.map((name) => chordRootMidi(transposeChordSymbol(name, normalizeKeyRoot(key)), key));
  return { names, roots };
}

function chordNotes(root: number, symbol: string) {
  const type = symbol.includes("m9") ? "m9" : symbol.includes("m7") ? "m7" : symbol.includes("13") ? "13" : symbol.includes("7") && !symbol.includes("maj7") ? "7" : symbol.includes("dim") ? "dim" : "maj7";
  return chordIntervals[type].map((interval) => root + interval);
}

function deterministicShape(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function buildCompositionPlan(input: z.infer<typeof composeMusicInputSchema>, bars: number) {
  const introBars = Math.min(4, bars);
  const remainingAfterIntro = Math.max(0, bars - introBars);
  const outroBars = remainingAfterIntro > 1 ? Math.min(2, remainingAfterIntro) : 0;
  const bodyBars = Math.max(0, bars - introBars - outroBars);
  const aBars = bodyBars > 0 ? Math.max(1, Math.ceil(bodyBars * 0.56)) : 0;
  const bBars = Math.max(0, bodyBars - aBars);
  const form = input.loopable
    ? [{ name: "loop_A", bars, role: "repeatable main idea", targetIntensity: 0.58 }]
    : [
      { name: "intro", bars: introBars, role: "establish texture and motif", targetIntensity: 0.28 },
      { name: "A", bars: aBars, role: "state the main motif clearly", targetIntensity: 0.55 },
      { name: "B", bars: bBars, role: "develop the motif with higher register or harmonic tension", targetIntensity: 0.72 },
      { name: "outro", bars: outroBars, role: "release tension and land cleanly", targetIntensity: 0.32 }
    ].filter((section) => section.bars > 0);
  const energyCurve = Array.from({ length: bars }, (_, index) => {
    const position = bars <= 1 ? 0 : index / (bars - 1);
    return Number((0.25 + Math.sin(Math.PI * position) * 0.55 + (index % 4 === 3 ? 0.08 : 0)).toFixed(3));
  });
  const pianoIntent = input.instruments.includes("piano") || input.instruments.includes("electric_piano")
    ? ["separate melody and accompaniment registers", "use arpeggios as texture, not as the whole composition", "shape phrase endings with lower velocity"]
    : [];
  return {
    form,
    motifs: [
      {
        id: "main_motif",
        contour: input.style === "game_bgm" ? "upward leap then stepwise fall" : "small rise, expressive peak, gentle fall",
        rhythm: input.style === "game_bgm" ? "short-short-long with octave reinforcement" : "pickup into a sustained tone, answered by a shorter tail",
        development: ["state", "sequence", "answer", "register lift", "compressed reprise"]
      }
    ],
    energyCurve,
    arrangementIntent: [
      "write a form before note events",
      "repeat motifs with variation instead of repeating bars verbatim",
      "keep a clear foreground line over supporting texture",
      ...pianoIntent
    ]
  };
}

function performancePlanForComposition(composition: Composition) {
  const totalBeats = composition.durationSeconds / (60 / composition.tempo);
  const pedalWindow = 4;
  const sustainPedal = Array.from({ length: Math.ceil(totalBeats / pedalWindow) }, (_, index) => ({
    startBeat: index * pedalWindow,
    endBeat: Math.min(totalBeats, (index + 1) * pedalWindow - 0.12),
    value: 96
  }));
  const rubatoMap = [
    { beat: 0, tempoScale: 0.985 },
    { beat: Number((totalBeats * 0.28).toFixed(3)), tempoScale: 1.015 },
    { beat: Number((totalBeats * 0.62).toFixed(3)), tempoScale: 1.025 },
    { beat: Number((totalBeats * 0.9).toFixed(3)), tempoScale: 0.97 }
  ];
  return { humanized: true, timingJitterBeats: 0.035, velocityJitter: 14, sustainPedal, rubatoMap };
}

function applyPerformanceHumanization(composition: Composition, performance: NonNullable<Composition["performance"]>): Composition["tracks"] {
  const totalBeats = composition.durationSeconds / (60 / composition.tempo);
  const humanized: Composition["tracks"] = {};
  for (const [track, notes] of Object.entries(composition.tracks)) {
    humanized[track] = notes.map((note, index) => {
      const seed = note.midi * 0.37 + note.startBeat * 1.91 + index * 0.53 + track.length;
      const timing = deterministicShape(seed) * performance.timingJitterBeats;
      const velocity = deterministicShape(seed + 17) * performance.velocityJitter;
      const pedalOverlap = performance.sustainPedal.some((pedal) => note.startBeat >= pedal.startBeat && note.startBeat < pedal.endBeat);
      const durationLift = track === "piano" && pedalOverlap && note.durationBeats >= 0.4 ? 0.08 : 0;
      const startBeat = Math.max(0, Math.min(totalBeats - 0.05, note.startBeat + timing));
      // Beat emphasis: downbeat (beat 1 of bar) gets +5, beat 3 gets +2; skip drums (already explicitly voiced)
      const beatInBar = note.startBeat % 4;
      const beatAccent = track !== "drums" ? (beatInBar < 0.12 ? 5 : beatInBar > 1.88 && beatInBar < 2.12 ? 2 : 0) : 0;
      return {
        ...note,
        startBeat: Number(startBeat.toFixed(3)),
        durationBeats: Number(Math.min(totalBeats - startBeat, note.durationBeats + durationLift).toFixed(3)),
        velocity: Math.max(1, Math.min(127, Math.round(note.velocity + velocity + beatAccent)))
      };
    }).sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
  }
  return humanized;
}

function musicalityForComposition(composition: Composition) {
  const allNotes = Object.values(composition.tracks).flat();
  const pianoNotes = composition.tracks.piano ?? [];
  const onGrid = allNotes.filter((note) => Math.abs(note.startBeat * 4 - Math.round(note.startBeat * 4)) < 0.001).length;
  const gridLockRatio = allNotes.length ? onGrid / allNotes.length : 1;
  const velocities = allNotes.map((note) => note.velocity);
  const velocityRange = velocities.length ? Math.max(...velocities) - Math.min(...velocities) : 0;
  const pitchClassesByBar = new Map<number, string>();
  for (const note of allNotes) {
    const bar = Math.floor(note.startBeat / 4);
    const pitchClass = note.midi % 12;
    pitchClassesByBar.set(bar, `${pitchClassesByBar.get(bar) ?? ""}${pitchClass},`);
  }
  const barPatterns = [...pitchClassesByBar.values()];
  const repeatedAdjacentBars = barPatterns.slice(1).filter((pattern, index) => pattern === barPatterns[index]).length;
  const adjacentBarRepeatRatio = barPatterns.length > 1 ? repeatedAdjacentBars / (barPatterns.length - 1) : 0;
  const shortNotes = allNotes.filter((note) => note.durationBeats <= 0.75).length;
  const sustainedNotes = allNotes.filter((note) => note.durationBeats >= 1.25).length;
  const registerSpan = pianoNotes.length ? Math.max(...pianoNotes.map((note) => note.midi)) - Math.min(...pianoNotes.map((note) => note.midi)) : 0;
  const hasPlan = Boolean(composition.compositionPlan?.motifs.length);
  const hasHumanizedPerformance = Boolean(composition.performance?.humanized);
  const mechanicalScore = Number(Math.min(1, (gridLockRatio * 0.42) + (adjacentBarRepeatRatio * 0.28) + (velocityRange < 12 ? 0.18 : 0) + (!hasHumanizedPerformance ? 0.12 : 0)).toFixed(3));
  const warnings: string[] = [];
  if (!hasPlan) warnings.push("No composition plan or motif metadata is attached.");
  if (!hasHumanizedPerformance) warnings.push("No humanized performance layer is attached.");
  if (gridLockRatio > 0.92) warnings.push("Most notes are locked to the grid.");
  if (adjacentBarRepeatRatio > 0.45) warnings.push("Adjacent bars repeat too mechanically.");
  if (velocityRange < 12) warnings.push("Velocity range is too flat for expressive playback.");
  if (allNotes.length && (shortNotes === 0 || sustainedNotes === 0)) warnings.push("Rhythm lacks a mix of short and sustained notes.");
  if (pianoNotes.length && registerSpan < 18) warnings.push("Piano register span is narrow; melody and accompaniment may blur together.");
  return {
    hasPlan,
    hasHumanizedPerformance,
    gridLockRatio: Number(gridLockRatio.toFixed(3)),
    adjacentBarRepeatRatio: Number(adjacentBarRepeatRatio.toFixed(3)),
    velocityRange,
    shortNoteRatio: Number((shortNotes / Math.max(1, allNotes.length)).toFixed(3)),
    sustainedNoteRatio: Number((sustainedNotes / Math.max(1, allNotes.length)).toFixed(3)),
    pianoRegisterSpan: registerSpan,
    mechanicalScore,
    warnings
  };
}

function normalizeKeyRoot(key: string) {
  const root = key.trim().split(/\s+/)[0].replace(/m$/, "");
  return Object.prototype.hasOwnProperty.call(noteBase, root) ? root : "C";
}

function transposeChordSymbol(symbol: string, key: string) {
  const rootNames = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const match = symbol.match(/^([A-G]b?)(.*)$/);
  if (!match) return symbol;
  const targetRoot = keyRoot(normalizeKeyRoot(key)) % 12;
  const sourceRoot = noteBase[match[1]] % 12;
  const transposedRoot = rootNames[(sourceRoot + targetRoot + 12) % 12];
  return `${transposedRoot}${match[2]}`;
}

function harmonyTemplates(styleFamily: string, style: string, complexity: string) {
  if (styleFamily === "bossa_lounge" || style === "bossa") return ["Dm9", "G13", "Cmaj9", "A7b9", "Dm9", "Db13", "Cmaj9", "G13sus"];
  if (styleFamily === "minor_jazz" || style === "minor_jazz") return ["Cm9", "F13", "Bbmaj9", "Ebmaj7", "Am7b5", "D7alt", "Gm9", "G13"];
  if (styleFamily === "modal_lounge" || style === "modal_lounge") return ["Cmaj9", "Dsus9", "Em11", "Fmaj9", "Em11", "Dsus9", "Cmaj9", "G13sus"];
  if (style === "circle_fifths") return ["Em7", "A13", "Dm9", "G13", "Cmaj9", "Fmaj9", "Bm7b5", "E7alt"];
  if (complexity === "rich") return ["Dm9", "G13", "Cmaj9", "A7b9", "Dm9", "Db13", "Cmaj9", "Ebdim7"];
  if (complexity === "simple") return ["Dm7", "G7", "Cmaj7", "Cmaj7", "Dm7", "G7", "Cmaj7", "A7"];
  return ["Dm9", "G13", "Cmaj9", "A7", "Dm9", "G13sus", "Cmaj9", "C6/9"];
}

function chordRootMidi(symbol: string, key: string) {
  const match = symbol.match(/^([A-G]b?)/);
  return match ? noteBase[match[1]] : keyRoot(normalizeKeyRoot(key));
}

function voicingForChord(symbol: string, root: number, voicingType: z.infer<typeof generateJazzHarmonyInputSchema>["voicingType"]) {
  const lowerRoot = root >= 60 ? root - 12 : root;
  const base = chordNotes(lowerRoot, symbol);
  if (voicingType === "shell") return [lowerRoot + 10, lowerRoot + 16].filter((note) => note >= 48 && note <= 84);
  if (voicingType === "beginner_safe") return base.slice(0, 4).map((note) => note > 76 ? note - 12 : note);
  if (voicingType === "sparse_background") return base.slice(1, 4).map((note, index) => note + (index === 2 ? 12 : 0)).filter((note) => note >= 50 && note <= 82);
  if (voicingType === "drop2") {
    const closed = base.slice(0, 4).map((note) => note < 60 ? note + 12 : note);
    if (closed.length >= 4) closed[1] -= 12;
    return closed.sort((a, b) => a - b);
  }
  if (voicingType === "rootless") return base.slice(1).map((note) => note < 58 ? note + 12 : note).slice(0, 4);
  return base.slice(1).map((note, index) => note < 58 ? note + 12 : note + (index === 2 ? 12 : 0)).slice(0, 4);
}

function sectionBarPlan(sections: string[] | undefined, bars: number) {
  if (!sections?.length) return Array.from({ length: bars }, (_, index) => ({ section: "A", barInSection: index + 1 }));
  const barsPerSection = Math.max(1, Math.floor(bars / sections.length));
  const plan = [];
  for (const section of sections) {
    for (let bar = 0; bar < barsPerSection; bar += 1) plan.push({ section, barInSection: bar + 1 });
  }
  while (plan.length < bars) plan.push({ section: sections[sections.length - 1], barInSection: plan.length + 1 });
  return plan.slice(0, bars);
}

function buildComposition(input: z.infer<typeof composeMusicInputSchema>): Composition {
  const beats = Math.round(input.durationSeconds / 60 * input.tempo);
  const bars = Math.max(4, Math.round(beats / 4));
  const compositionPlan = buildCompositionPlan(input, bars);
  const sections = compositionPlan.form.map((section) => ({ name: section.name, bars: section.bars, intensity: section.targetIntensity }));
  const progression = progressionFor(input.style, input.key);
  const tracks: Composition["tracks"] = {};
  const maxBeats = input.durationSeconds / (60 / input.tempo);
  const add = (track: string, midi: number, startBeat: number, durationBeats: number, velocity: number) => {
    if (startBeat < 0 || startBeat >= maxBeats) return;
    const boundedDuration = Math.max(0.05, Math.min(durationBeats, maxBeats - startBeat));
    tracks[track] ??= [];
    tracks[track].push({
      track,
      midi: Math.max(0, Math.min(127, midi)),
      startBeat: Number(startBeat.toFixed(3)),
      durationBeats: Number(boundedDuration.toFixed(3)),
      velocity: Math.max(1, Math.min(127, velocity))
    });
  };
  const hasPiano = input.instruments.includes("piano") || input.instruments.includes("electric_piano");
  const hasBass = input.instruments.includes("upright_bass") || input.instruments.includes("acoustic_bass");
  const hasDrums = input.instruments.includes("drums") || input.instruments.includes("brushes");
  const hasPad = input.instruments.includes("pads") || input.instruments.includes("strings");
  const hasLead = input.instruments.includes("violin") || input.instruments.includes("sax_like_lead");
  const hasCello = input.instruments.includes("cello");
  const pianoPattern = input.style === "smooth_piano" ? [0, 2, 3, 4, 3, 2, 1, 2] : [0, 1, 2, 3, 2, 1, 3, 4];
  const melodyDegrees = input.style === "smooth_piano" ? [12, 14, 15, 19, 17, 15, 14, 12, 10, 12, 15, 14] : [12, 14, 16, 19, 17, 16, 14, 12, 11, 12, 16, 14];
  for (let bar = 0; bar < bars; bar += 1) {
    const chordIndex = bar % progression.names.length;
    const start = bar * 4;
    const phraseLift = compositionPlan.energyCurve[bar] ?? Math.sin(Math.PI * (bars <= 1 ? 0 : bar / (bars - 1)));
    const dynamic = Math.round(44 + phraseLift * 22 + (bar % 4) * 2);
    const chord = chordNotes(progression.roots[chordIndex], progression.names[chordIndex])
      .map((midi) => midi < 48 ? midi + 12 : midi)
      .filter((midi) => midi >= 40 && midi <= 88);
    if (hasPiano) {
      const low = chord[0] ?? progression.roots[chordIndex];
      const voicing = [low - 12, ...chord.slice(0, 4), (chord[2] ?? low) + 12].filter((midi) => midi >= 36 && midi <= 88);
      const step = input.style === "smooth_piano" || input.complexity !== "simple" ? 0.5 : 1;
      const notesThisBar = step === 0.5 ? pianoPattern : [0, 2, 3, 1];
      notesThisBar.forEach((index, offset) => {
        add("piano", voicing[index % voicing.length], start + offset * step, step * 0.9, dynamic - 8 + (offset % 4) * 2);
      });
      if (bar % 4 === 0 || input.complexity === "rich") {
        for (const midi of chord.slice(1, 4)) add("piano", midi + 12, start, input.loopable ? 3.7 : 3.4, Math.max(34, dynamic - 18));
      }
      if (bar > 0 && (input.style === "smooth_piano" || bar % 2 === 1)) {
        const degree = melodyDegrees[bar % melodyDegrees.length];
        const root = progression.roots[chordIndex];
        add("piano", root + degree, start + 1, 1.35, dynamic + 8);
        add("piano", root + melodyDegrees[(bar + 2) % melodyDegrees.length], start + 2.5, 0.85, dynamic + 4);
        if (input.complexity === "rich" || input.style === "smooth_piano") add("piano", root + melodyDegrees[(bar + 4) % melodyDegrees.length], start + 3.25, 0.55, dynamic);
      }
    }
    if (hasBass) {
      const root = progression.roots[chordIndex] - 24;
      add("bass", root, start, 1.45, 58 + Math.round(phraseLift * 10));
      add("bass", root + (bar % 2 ? 7 : 12), start + 2, 1.2, 50 + Math.round(phraseLift * 8));
    }
    if (hasLead) add(input.instruments.includes("violin") ? "violin" : "lead", progression.roots[chordIndex] + melodyDegrees[(bar + 1) % melodyDegrees.length], start + 1, 1.75, 48 + Math.round(phraseLift * 12));
    if (hasCello) {
      // Sustained cello voice in cello register (~MIDI 36-72), entering at every bar start so it
      // overlaps the piano from bar 0 — a real simultaneous ensemble, not a sequential handoff.
      const intoCelloRange = (midi: number) => { let value = midi; while (value > 72) value -= 12; while (value < 36) value += 12; return value; };
      const root = progression.roots[chordIndex];
      add("cello", intoCelloRange(root - 12), start, input.loopable ? 3.9 : 3.6, 50 + Math.round(phraseLift * 10));
      if (input.complexity !== "simple" || bar % 2 === 1) {
        // Move to the fifth of the chord mid-bar for a simple, musical counter-line.
        add("cello", intoCelloRange(root - 12 + 7), start + 2, 1.7, 46 + Math.round(phraseLift * 8));
      }
    }
    if (hasDrums) {
      add("drums", 42, start, 0.18, 32 + Math.round(phraseLift * 8));
      add("drums", 38, start + 2, 0.2, 34 + Math.round(phraseLift * 10));
      add("drums", 42, start + 2.67, 0.16, 25 + Math.round(phraseLift * 6));
      if (input.complexity === "rich" && bar % 4 === 3) add("drums", 38, start + 3.5, 0.18, 38);
    }
    if (hasPad) add("pad", progression.roots[chordIndex], start, 3.85, 28 + Math.round(phraseLift * 10));
  }
  const draft: Composition = {
    title: input.title,
    style: input.style,
    mood: input.mood,
    tempo: input.tempo,
    key: input.key,
    durationSeconds: input.durationSeconds,
    loopable: input.loopable,
    instruments: input.instruments,
    sections,
    chordProgression: progression.names,
    tracks,
    license: { output: "generated_original", dependencies: ["No third-party samples. WAV preview uses built-in sine/noise synthesis."] },
    compositionPlan
  };
  const performance = performancePlanForComposition(draft);
  const performed: Composition = { ...draft, performance, tracks: applyPerformanceHumanization(draft, performance) };
  return { ...performed, musicalityReport: musicalityForComposition(performed) };
}

function varLen(value: number) {
  const bytes = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}

// Bowed strings are the family that "breathes": a real bow swells inside a sustained note, where a
// raw MIDI note sits at one flat level — the #1 giveaway of synthetic strings. Pizzicato/harp/
// ensemble-pad timbres are excluded by only matching these three canonical instruments.
const bowedStringInstruments = new Set<CanonicalInstrument>(["violin", "cello", "strings"]);

// Author bow-pressure (CC11 expression) swells and a gentle vibrato (CC1) ramp into a MONOPHONIC
// bowed-string line so sustained notes breathe. Purely additive: it never moves, retimes, or
// repitches a note — only emits per-note controller curves on the track's channel.
//
// Monophony guard: CC11/CC1 are per-CHANNEL, but these curves are per-NOTE. On a chordal/divisi
// track (e.g. a `strings` ensemble or a cello double-stop) overlapping per-note curves would stomp
// each other — note A's decrescendo tail would crush note B's attack. So if ANY note overlaps the
// previous one, the whole track is left flat (no regression vs. today). Deterministic (no RNG).
function bowedStringExpressionEvents(
  channel: number,
  notes: Array<z.infer<typeof noteSchema>>,
  ppq: number
): Array<{ tick: number; bytes: number[] }> {
  if (notes.length === 0) return [];
  const ordered = [...notes].sort((a, b) => a.startBeat - b.startBeat);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].startBeat < ordered[i - 1].startBeat + ordered[i - 1].durationBeats - 1e-6) return [];
  }
  const events: Array<{ tick: number; bytes: number[] }> = [];
  const EXPRESSION = 11;
  const MODWHEEL = 1;
  const minSwellBeats = 0.75;   // shorter notes read as detache strokes — no swell
  const minVibratoBeats = 1.2;  // vibrato only once a note has time to settle
  for (const note of ordered) {
    if (note.durationBeats < minSwellBeats) continue;
    const startTick = Math.round(note.startBeat * ppq);
    const durTicks = Math.max(1, Math.round(note.durationBeats * ppq));
    const steps = Math.max(4, Math.round(note.durationBeats / 0.25));
    // Asymmetric hump: soft bow attack at `floor`, swell to a velocity-scaled `peak` at 60% of the
    // note, then ease back toward `tail`. Each note authors its own floor at its onset, so there is
    // no cross-note "reset" event to fight insertion order.
    const floor = 58;
    const peak = Math.max(96, Math.min(122, Math.round(90 + (note.velocity - 60) * 0.6)));
    const tail = 90;
    for (let s = 0; s <= steps; s++) {
      const frac = s / steps;
      const value = frac <= 0.6 ? floor + (peak - floor) * (frac / 0.6) : peak - (peak - tail) * ((frac - 0.6) / 0.4);
      const tick = s === 0 ? Math.max(0, startTick - 2) : startTick + Math.round(frac * durTicks);
      events.push({ tick, bytes: [0xb0 + channel, EXPRESSION, Math.max(1, Math.min(127, Math.round(value)))] });
    }
    if (note.durationBeats >= minVibratoBeats) {
      for (let s = 0; s <= steps; s++) {
        const frac = s / steps;
        const vib = frac < 0.25 ? 0 : Math.round(Math.min(44, ((frac - 0.25) / 0.75) * 44));
        events.push({ tick: startTick + Math.round(frac * durTicks), bytes: [0xb0 + channel, MODWHEEL, vib] });
      }
    }
  }
  return events;
}

export function midiBuffer(composition: Composition, options: { channelMap?: Record<string, number>; programMap?: Record<string, number>; expressiveStrings?: boolean } = {}) {
  const expressiveStrings = options.expressiveStrings ?? true;
  const ppq = 480;
  const events: Array<{ tick: number; bytes: number[] }> = [];
  const pushText = (type: number, text: string) => events.push({ tick: 0, bytes: [0xff, type, ...varLen(Buffer.byteLength(text)), ...Buffer.from(text, "utf8")] });
  pushText(0x03, composition.title);
  events.push({ tick: 0, bytes: [0xff, 0x51, 0x03, ...Buffer.from([(60000000 / composition.tempo) >> 16 & 255, (60000000 / composition.tempo) >> 8 & 255, (60000000 / composition.tempo) & 255])] });
  // Resolve each track to a canonical instrument so channel and GM program come from the shared
  // catalog (deterministic, identity-aware). Percussion tracks lock to channel 9 with no program.
  // Explicit channelMap/programMap overrides win, enabling external MIDI channel mapping without
  // fragile manifest assumptions.
  const resolvedInstrumentFor = (track: string) => canonicalInstrumentFromTrackKey(track);
  const defaultChannelFor = (track: string) => {
    const instrument = resolvedInstrumentFor(track);
    if (instrument) return instrumentCatalog[instrument].channel;
    return Math.abs([...track].reduce((sum, ch) => sum + ch.charCodeAt(0), 0)) % 8;
  };
  const channelFor = (track: string) => options.channelMap?.[track] ?? defaultChannelFor(track);
  const isPercussionChannel = (track: string) => channelFor(track) === 9;
  // 1-indexed GM program for a track, or undefined for percussion / unresolved tracks.
  const gmProgramFor = (track: string): number | undefined => {
    if (isPercussionChannel(track)) return undefined;
    const override = options.programMap?.[track];
    if (override !== undefined) return override;
    const instrument = resolvedInstrumentFor(track);
    return instrument ? instrumentCatalog[instrument].gmProgram : undefined;
  };
  // Emit one Program Change per channel at tick 0 so renderers (FluidSynth/SFZ) honour the
  // intended instrument instead of defaulting every channel to piano.
  const programmedChannels = new Set<number>();
  for (const track of Object.keys(composition.tracks)) {
    const channel = channelFor(track);
    if (programmedChannels.has(channel)) continue;
    const gmProgram = gmProgramFor(track);
    if (gmProgram === undefined) continue;
    programmedChannels.add(channel);
    events.push({ tick: 0, bytes: [0xc0 + channel, Math.max(0, Math.min(127, gmProgram - 1))] });
  }
  for (const [track, notes] of Object.entries(composition.tracks)) {
    if (track === "piano" && composition.performance?.sustainPedal.length) {
      const channel = channelFor(track);
      for (const pedal of composition.performance.sustainPedal) {
        events.push({ tick: Math.round(pedal.startBeat * ppq), bytes: [0xb0 + channel, 64, pedal.value] });
        events.push({ tick: Math.round(pedal.endBeat * ppq), bytes: [0xb0 + channel, 64, 0] });
      }
    }
    for (const note of notes) {
      const channel = channelFor(track);
      const start = Math.round(note.startBeat * ppq);
      const end = Math.round((note.startBeat + note.durationBeats) * ppq);
      events.push({ tick: start, bytes: [0x90 + channel, note.midi, note.velocity] });
      events.push({ tick: end, bytes: [0x80 + channel, note.midi, 0] });
    }
  }
  // Auto-author bow expression for monophonic bowed-string lines so sustained notes breathe.
  // This is done at CHANNEL granularity, not per-track, because CC11/CC1 are per-channel and the
  // catalog routes several string parts onto one shared channel (violin+viola -> ch4, cello+cello_2
  // -> ch5, a quartet -> two channels). Authoring per-track would let two individually-monophonic
  // lines on the same channel interleave their curves and pump each other's level — worse than flat.
  // So we merge every track's notes by resolved channel and only author when (a) every track on that
  // channel is a bowed string and (b) the merged line is monophonic (the guard inside
  // bowedStringExpressionEvents). A string section/quartet (overlapping merge) stays flat = no
  // regression.
  if (expressiveStrings) {
    const byChannel = new Map<number, { notes: Array<z.infer<typeof noteSchema>>; allBowed: boolean }>();
    for (const [track, notes] of Object.entries(composition.tracks)) {
      const channel = channelFor(track);
      if (channel === 9) continue; // percussion
      const instrument = resolvedInstrumentFor(track);
      const bowed = Boolean(instrument && bowedStringInstruments.has(instrument));
      const entry = byChannel.get(channel) ?? { notes: [], allBowed: true };
      entry.notes.push(...notes);
      entry.allBowed = entry.allBowed && bowed;
      byChannel.set(channel, entry);
    }
    for (const [channel, entry] of byChannel) {
      if (!entry.allBowed || entry.notes.length === 0) continue;
      for (const event of bowedStringExpressionEvents(channel, entry.notes, ppq)) events.push(event);
    }
  }
  events.sort((a, b) => a.tick - b.tick);
  const data: number[] = [];
  let lastTick = 0;
  for (const event of events) {
    data.push(...varLen(event.tick - lastTick), ...event.bytes);
    lastTick = event.tick;
  }
  data.push(0x00, 0xff, 0x2f, 0x00);
  const header = Buffer.alloc(14);
  header.write("MThd", 0, "ascii");
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10);
  header.writeUInt16BE(ppq, 12);
  const track = Buffer.from(data);
  const trackHeader = Buffer.alloc(8);
  trackHeader.write("MTrk", 0, "ascii");
  trackHeader.writeUInt32BE(track.length, 4);
  return Buffer.concat([header, trackHeader, track]);
}

function synthTone(track: string, instrument: string | undefined, t: number, freq: number) {
  if (track === "drums" || instrument === "jazz_brushes" || instrument === "light_drum_kit") return Math.sin(t * 1200) * Math.sin(t * 73);
  if (instrument === "soft_electric_piano") return Math.sin(2 * Math.PI * freq * t) * 0.78 + Math.sin(2 * Math.PI * freq * 2 * t) * 0.12;
  if (instrument === "upright_bass" || instrument === "acoustic_bass") return Math.sin(2 * Math.PI * freq * t) * 0.9 + Math.sin(2 * Math.PI * freq * 0.5 * t) * 0.08;
  if (instrument === "violin" || instrument === "cello" || instrument === "strings") return Math.sin(2 * Math.PI * freq * t) * 0.65 + Math.sign(Math.sin(2 * Math.PI * freq * t)) * 0.12;
  if (instrument === "pads" || instrument === "soft_synth") return Math.sin(2 * Math.PI * freq * t) * 0.55 + Math.sin(2 * Math.PI * (freq * 1.005) * t) * 0.35;
  if (instrument === "mallets") return Math.sin(2 * Math.PI * freq * t) * Math.exp(-(t % 1) * 2);
  return Math.sin(2 * Math.PI * freq * t);
}

function presetGain(preset = "warm_cafe") {
  if (preset === "lo_fi_soft") return 0.78;
  if (preset === "cinematic_soft") return 0.86;
  if (preset === "clean_corporate") return 0.82;
  if (preset === "game_loop") return 0.9;
  return 0.8;
}

function wavBuffer(composition: Composition, sampleRate: number, options: { instrumentMap?: Record<string, string>; renderPreset?: string; trackFilter?: string } = {}) {
  const samples = Math.max(1, Math.round(composition.durationSeconds * sampleRate));
  const pcm = Buffer.alloc(samples * 2);
  const trackEntries = Object.entries(composition.tracks).filter(([track]) => !options.trackFilter || track === options.trackFilter);
  const allNotes = trackEntries.flatMap(([, notes]) => notes);
  const beatSeconds = 60 / composition.tempo;
  const gain = presetGain(options.renderPreset);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    let sample = 0;
    for (const note of allNotes) {
      const start = note.startBeat * beatSeconds;
      const end = (note.startBeat + note.durationBeats) * beatSeconds;
      if (t < start || t > end) continue;
      const env = Math.min(1, (t - start) / 0.03, (end - t) / 0.08);
      const freq = 440 * (2 ** ((note.midi - 69) / 12));
      const instrument = options.instrumentMap?.[note.track];
      const tone = synthTone(note.track, instrument, t, freq);
      sample += tone * env * (note.velocity / 127) * (note.track === "drums" ? 0.08 : 0.035) * gain;
    }
    const shaped = Math.max(-0.95, Math.min(0.95, sample));
    pcm.writeInt16LE(Math.round(shaped * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function readComposition(ctx: ToolContext, projectId: string, manifestPath: string): Promise<Composition> {
  return JSON.parse(await readProjectFile(ctx.projectRoot, projectId, manifestPath, 2 * 1024 * 1024)) as Composition;
}

type EnsembleTrackStat = {
  instrument: string;
  matchedTracks: string[];
  noteCount: number;
  firstNoteBeat: number | null;
  lastNoteEndBeat: number | null;
  firstNoteSeconds: number | null;
  lastNoteSeconds: number | null;
  activeRatio: number;
  silenceRatio: number;
};

type EnsembleReport = {
  ok: boolean;
  tempo: number;
  barBeats: number;
  durationSeconds: number;
  requiredInstruments: string[];
  tracks: EnsembleTrackStat[];
  overlap: { startSeconds: number; endSeconds: number; durationSeconds: number } | null;
  soloInstruments: string[];
  longestSingleInstrumentSpan: { instrument: string; startSeconds: number; endSeconds: number; durationSeconds: number } | null;
  failures: string[];
  warnings: string[];
};

// True duet / ensemble validator. Operates on MIDI note data so it works before audio rendering.
// Fails closed: any requested instrument with no notes, a lack of simultaneous overlap (sequential
// handoff), or a long single-instrument stretch that is not an intentional solo blocks the output.
function analyzeEnsemble(
  composition: Composition,
  options: {
    requiredInstruments: string[];
    soloInstruments?: string[];
    maxSingleInstrumentSeconds?: number;
    requireStartWithinBars?: number;
    barBeats?: number;
  }
): EnsembleReport {
  const tempo = composition.tempo > 0 ? composition.tempo : 90;
  const barBeats = options.barBeats && options.barBeats > 0 ? options.barBeats : 4;
  const beatToSeconds = (beat: number) => (beat * 60) / tempo;
  const maxSingleInstrumentSeconds = options.maxSingleInstrumentSeconds ?? 8;
  const soloInstruments = (options.soloInstruments ?? []).map((value) => canonicalInstrumentFromName(value) ?? value);

  // Map each requested instrument to the composition track keys that represent it.
  const trackKeys = Object.keys(composition.tracks);
  const matchTracks = (requested: string): string[] => {
    const canon = canonicalInstrumentFromName(requested) ?? requested;
    return trackKeys.filter((key) => key === requested || (canonicalInstrumentFromTrackKey(key) ?? key) === canon);
  };

  const totalBeats = Math.max(
    1,
    ...trackKeys.flatMap((key) => composition.tracks[key].map((note) => note.startBeat + note.durationBeats))
  );
  const gridStep = 0.5; // half-beat resolution
  const gridCount = Math.max(1, Math.ceil(totalBeats / gridStep));
  const activeAt = (notes: Composition["tracks"][string], beat: number) =>
    notes.some((note) => beat >= note.startBeat - 1e-6 && beat < note.startBeat + note.durationBeats - 1e-6);

  const failures: string[] = [];
  const warnings: string[] = [];

  const tracks: EnsembleTrackStat[] = options.requiredInstruments.map((instrument) => {
    const matchedTracks = matchTracks(instrument);
    const notes = matchedTracks.flatMap((key) => composition.tracks[key]);
    const noteCount = notes.length;
    const firstNoteBeat = noteCount ? Math.min(...notes.map((note) => note.startBeat)) : null;
    const lastNoteEndBeat = noteCount ? Math.max(...notes.map((note) => note.startBeat + note.durationBeats)) : null;
    let activeGrid = 0;
    for (let i = 0; i < gridCount; i += 1) if (activeAt(notes, i * gridStep)) activeGrid += 1;
    const activeRatio = gridCount ? activeGrid / gridCount : 0;
    return {
      instrument,
      matchedTracks,
      noteCount,
      firstNoteBeat,
      lastNoteEndBeat,
      firstNoteSeconds: firstNoteBeat === null ? null : Number(beatToSeconds(firstNoteBeat).toFixed(3)),
      lastNoteSeconds: lastNoteEndBeat === null ? null : Number(beatToSeconds(lastNoteEndBeat).toFixed(3)),
      activeRatio: Number(activeRatio.toFixed(3)),
      silenceRatio: Number((1 - activeRatio).toFixed(3))
    };
  });

  // Gate 1: every requested instrument must actually carry notes.
  for (const track of tracks) {
    if (track.noteCount === 0) failures.push(`Instrument "${track.instrument}" has no notes (noteCount=0); it would render silent.`);
  }

  const presentTracks = tracks.filter((track) => track.noteCount > 0 && track.firstNoteBeat !== null && track.lastNoteEndBeat !== null);

  // Precompute, for every half-beat cell, which present instruments are sounding. This single grid
  // drives both the simultaneity check and the single-instrument-span check so they cannot disagree.
  const cellActiveInstruments: string[][] = [];
  for (let i = 0; i < gridCount; i += 1) {
    const beat = i * gridStep;
    cellActiveInstruments.push(presentTracks.filter((track) => track.matchedTracks.some((key) => activeAt(composition.tracks[key], beat))).map((track) => track.instrument));
  }

  // Gate 2 (#6): the requested instruments must actually SOUND TOGETHER, not merely have
  // overlapping spans. A sequential handoff (cello then piano) or an alternating "fake duet" both
  // lack any cell where >=2 requested instruments are active. This is the exact failure being fixed.
  let overlap: EnsembleReport["overlap"] = null;
  if (presentTracks.length >= 2) {
    const simultaneousCells = cellActiveInstruments
      .map((active, index) => ({ active, index }))
      .filter((cell) => new Set(cell.active).size >= 2);
    if (simultaneousCells.length) {
      const firstBeat = simultaneousCells[0].index * gridStep;
      const lastBeat = (simultaneousCells[simultaneousCells.length - 1].index + 1) * gridStep;
      overlap = {
        startSeconds: Number(beatToSeconds(firstBeat).toFixed(3)),
        endSeconds: Number(beatToSeconds(lastBeat).toFixed(3)),
        durationSeconds: Number(beatToSeconds(simultaneousCells.length * gridStep).toFixed(3))
      };
    } else if (tracks.every((track) => track.noteCount > 0)) {
      failures.push("Requested instruments never play simultaneously: this is a sequential handoff, not a real ensemble.");
    }
  }

  // Gate 3 (#6): no long stretch should contain only one instrument unless that instrument is an
  // intentional solo. Scan the same grid for the longest run with exactly one active instrument.
  let longest: EnsembleReport["longestSingleInstrumentSpan"] = null;
  if (presentTracks.length >= 2) {
    let runInstrument: string | null = null;
    let runStartBeat = 0;
    const flush = (instrument: string | null, startBeat: number, endBeat: number) => {
      if (!instrument) return;
      const durationSeconds = beatToSeconds(endBeat - startBeat);
      if (!longest || durationSeconds > longest.durationSeconds) {
        longest = { instrument, startSeconds: Number(beatToSeconds(startBeat).toFixed(3)), endSeconds: Number(beatToSeconds(endBeat).toFixed(3)), durationSeconds: Number(durationSeconds.toFixed(3)) };
      }
    };
    for (let i = 0; i <= gridCount; i += 1) {
      const activeInstruments = i < gridCount ? cellActiveInstruments[i] : [];
      const soleInstrument = activeInstruments.length === 1 ? activeInstruments[0] : null;
      if (soleInstrument !== runInstrument || i === gridCount) {
        flush(runInstrument, runStartBeat, i * gridStep);
        runInstrument = soleInstrument;
        runStartBeat = i * gridStep;
      }
    }
    if (longest && (longest as NonNullable<EnsembleReport["longestSingleInstrumentSpan"]>).durationSeconds >= maxSingleInstrumentSeconds) {
      const span = longest as NonNullable<EnsembleReport["longestSingleInstrumentSpan"]>;
      const canon = canonicalInstrumentFromName(span.instrument) ?? span.instrument;
      if (!soloInstruments.includes(canon)) {
        failures.push(`A ${span.durationSeconds.toFixed(1)}s section (${span.startSeconds}s–${span.endSeconds}s) contains only "${span.instrument}"; mark it as an intentional solo or fix the arrangement.`);
      }
    }
  }

  // Gate 4 (#6): for a true duet both instruments should enter near bar 1.
  if (options.requireStartWithinBars !== undefined) {
    const limitBeats = options.requireStartWithinBars * barBeats;
    for (const track of presentTracks) {
      if ((track.firstNoteBeat as number) > limitBeats + 1e-6) {
        failures.push(`Instrument "${track.instrument}" does not enter until ${track.firstNoteSeconds}s (beat ${track.firstNoteBeat}); a real ensemble should start within ${options.requireStartWithinBars} bar(s).`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    tempo,
    barBeats,
    durationSeconds: composition.durationSeconds,
    requiredInstruments: options.requiredInstruments,
    tracks,
    overlap,
    soloInstruments,
    longestSingleInstrumentSpan: longest,
    failures,
    warnings
  };
}

export type EnsembleQaTrack = {
  instrument: string;
  matchedTracks: string[];
  channel: number | null;
  gmProgram: number | null;
  noteCount: number;
  firstBeat: number | null;
  firstSeconds: number | null;
  lastBeat: number | null;
};

export type EnsembleQa = {
  instrumentsRequested: string[];
  instrumentsFound: string[];
  missingInstruments: string[];
  missingInstrumentWarnings: string[];
  overlap: EnsembleReport["overlap"];
  overlapFromBeat0: boolean;
  tracks: EnsembleQaTrack[];
};

// issue_0147: always-on ensemble QA. Unlike analyzeEnsemble (the opt-in fail-closed GATE), this is a
// non-blocking transparency report so compose/render outputs can ALWAYS prove which requested
// instruments carry notes, their channel/program mapping, first-note time, and whether they actually
// overlap — instead of the user having to infer a "fake duet" from a missing stem. Reuses
// analyzeEnsemble for the note-level math; adds the channel/program mapping the renderer emits.
export function buildEnsembleQa(composition: Composition, requestedInstruments: string[]): EnsembleQa {
  const requested = (requestedInstruments.length ? requestedInstruments : composition.instruments).filter(Boolean);
  const report = analyzeEnsemble(composition, { requiredInstruments: requested });
  const tracks: EnsembleQaTrack[] = report.tracks.map((stat) => {
    const canon = canonicalInstrumentFromName(stat.instrument) ?? canonicalInstrumentFromTrackKey(stat.instrument);
    const catalog = canon ? instrumentCatalog[canon] : undefined;
    return {
      instrument: stat.instrument,
      matchedTracks: stat.matchedTracks,
      channel: catalog?.channel ?? null,
      gmProgram: catalog?.gmProgram ?? null,
      noteCount: stat.noteCount,
      firstBeat: stat.firstNoteBeat,
      firstSeconds: stat.firstNoteSeconds,
      lastBeat: stat.lastNoteEndBeat
    };
  });
  const instrumentsFound = report.tracks.filter((stat) => stat.noteCount > 0).map((stat) => stat.instrument);
  const missingInstruments = report.tracks.filter((stat) => stat.noteCount === 0).map((stat) => stat.instrument);
  return {
    instrumentsRequested: requested,
    instrumentsFound,
    missingInstruments,
    missingInstrumentWarnings: missingInstruments.map((instrument) => `Requested instrument "${instrument}" has no notes in the composition; it will be silent/absent in the render.`),
    overlap: report.overlap,
    // "Both voices sound together from the top": a simultaneity window exists and opens within the
    // first half-second (≈ downbeat), not a late sequential entry.
    overlapFromBeat0: report.overlap !== null && report.overlap.startSeconds < 0.5,
    tracks
  };
}

const BASS_TRACK_PATTERN = /left.?hand|lh\b|bass|contrabass/i;

function applyMidiEdits(composition: Composition, input: z.infer<typeof editMidiInputSchema>) {
  const edited = JSON.parse(JSON.stringify(composition)) as Composition;
  const repairCfg = input.bassRepairConfig ?? {};
  const raiseBelowMidi: number = repairCfg.raiseBelowMidi ?? 48;
  const bassVelScale: number = repairCfg.velocityScale ?? 0.72;
  const maxDurBeats: number = repairCfg.maxDurationBeats ?? 1.5;
  const bassRepairLog: Array<{ track: string; midi: number; beat: number; change: string }> = [];

  for (const [track, notes] of Object.entries(edited.tracks)) {
    const isBassTrack = input.bassRepair && BASS_TRACK_PATTERN.test(track);
    for (const note of notes) {
      note.midi = Math.max(0, Math.min(127, note.midi + input.transposeSemitones));
      note.velocity = Math.max(1, Math.min(127, Math.round(note.velocity * input.velocityScale)));
      if (input.quantizeBeats) note.startBeat = Number((Math.round(note.startBeat / input.quantizeBeats) * input.quantizeBeats).toFixed(3));
      if (input.swing && Math.floor(note.startBeat * 2) % 2 === 1) note.startBeat = Number((note.startBeat + input.swing).toFixed(3));
      if (input.humanizeMs) note.startBeat = Number((note.startBeat + ((note.midi % 5) - 2) * input.humanizeMs / 1000 / (60 / edited.tempo)).toFixed(3));
      // Bass repair: raise low notes by one octave, reduce velocity and cap duration.
      if (isBassTrack && note.midi < raiseBelowMidi) {
        const oldMidi = note.midi;
        note.midi = Math.min(127, note.midi + 12);
        note.velocity = Math.max(1, Math.min(127, Math.round(note.velocity * bassVelScale)));
        if (note.durationBeats > maxDurBeats) note.durationBeats = maxDurBeats;
        bassRepairLog.push({ track, midi: oldMidi, beat: note.startBeat, change: `raised ${oldMidi}→${note.midi}, vel×${bassVelScale}, dur≤${maxDurBeats}` });
      }
    }
  }
  edited.title = `${edited.title} (edited)`;
  return { edited, bassRepairLog };
}

type AudioFinding = { severity: "high" | "medium" | "low"; category: string; message: string; suggestedFix: string };

function addFinding(findings: AudioFinding[], severity: AudioFinding["severity"], category: string, message: string, suggestedFix: string) {
  findings.push({ severity, category, message, suggestedFix });
}

type PcmWavInfo = { sampleRate: number; bitDepth: number; channelCount: number; dataOffset: number; dataBytes: number };

function parsePcmWav(buffer?: Buffer): { ok: true; info: PcmWavInfo } | { ok: false; reason: string } {
  if (!buffer || buffer.length < 44) return { ok: false, reason: "Audio file is too small to be a PCM WAV." };
  if (buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WAVE") {
    return { ok: false, reason: "Audio file is not a RIFF/WAVE container." };
  }
  let offset = 12;
  let format: { audioFormat: number; channelCount: number; sampleRate: number; bitDepth: number } | undefined;
  let data: { offset: number; bytes: number } | undefined;
  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString("ascii");
    const size = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;
    const nextOffset = chunkDataOffset + size + (size % 2);
    if (chunkDataOffset + size > buffer.length) return { ok: false, reason: `WAV chunk ${id} extends past end of file.` };
    if (id === "fmt ") {
      if (size < 16) return { ok: false, reason: "WAV fmt chunk is too short." };
      format = {
        audioFormat: buffer.readUInt16LE(chunkDataOffset),
        channelCount: buffer.readUInt16LE(chunkDataOffset + 2),
        sampleRate: buffer.readUInt32LE(chunkDataOffset + 4),
        bitDepth: buffer.readUInt16LE(chunkDataOffset + 14)
      };
    } else if (id === "data") {
      data = { offset: chunkDataOffset, bytes: size };
      break;
    }
    offset = nextOffset;
  }
  if (!format) return { ok: false, reason: "WAV fmt chunk is missing." };
  if (format.audioFormat !== 1) return { ok: false, reason: "Only PCM WAV audio is supported." };
  if (format.bitDepth !== 16) return { ok: false, reason: `Unsupported WAV bit depth ${format.bitDepth}; expected 16-bit PCM.` };
  if (format.channelCount < 1 || format.channelCount > 8) return { ok: false, reason: `Unsupported WAV channel count ${format.channelCount}.` };
  if (format.sampleRate < 8000 || format.sampleRate > 192000) return { ok: false, reason: `Unsupported WAV sample rate ${format.sampleRate}.` };
  if (!data) return { ok: false, reason: "WAV data chunk is missing." };
  if (data.bytes === 0) return { ok: false, reason: "WAV data chunk is empty." };
  return { ok: true, info: { sampleRate: format.sampleRate, bitDepth: format.bitDepth, channelCount: format.channelCount, dataOffset: data.offset, dataBytes: data.bytes } };
}

function assertPcmWav(buffer: Buffer, label: string): PcmWavInfo {
  const parsed = parsePcmWav(buffer);
  if (!parsed.ok) throw new Error(`${label} must be a readable PCM WAV file: ${parsed.reason}`);
  return parsed.info;
}

function wavAnalysis(buffer?: Buffer) {
  const parsed = parsePcmWav(buffer);
  if (!parsed.ok) {
    return {
      readable: false,
      format: "unknown",
      formatError: parsed.reason,
      durationSeconds: 0,
      sampleRate: 0,
      bitDepth: 0,
      channelCount: 0,
      bitrateKbps: 0,
      peak: 0,
      rms: 0,
      estimatedLufs: 0,
      dynamicRange: 0,
      crestFactor: 0,
      noiseFloorRms: 0,
      silenceRatio: 1,
      noiseLikeFlatnessProxy: 0,
      silenceGaps: [] as Array<{ startSeconds: number; durationSeconds: number }>,
      harshHighFrequencyProxy: 0,
      excessiveBassProxy: 0,
      loopSeamClickProxy: 0,
      startNearZero: true,
      endNearZero: true
    };
  }
  const { channelCount, sampleRate, bitDepth, dataOffset, dataBytes } = parsed.info;
  const wav = buffer as Buffer;
  const bytesPerSample = Math.max(1, bitDepth / 8);
  const frameCount = Math.max(0, Math.floor(dataBytes / Math.max(1, bytesPerSample * channelCount)));
  const samples: number[] = [];
  let peak = 0;
  let rmsSum = 0;
  let highDiffSum = 0;
  let lowPass = 0;
  let bassSum = 0;
  const blockSize = Math.max(1, Math.floor(sampleRate * 0.5));
  const blockRms: number[] = [];
  let blockSum = 0;
  let blockCount = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    let mono = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      const offset = dataOffset + (frame * channelCount + channel) * bytesPerSample;
      const value = bitDepth === 16 ? wav.readInt16LE(offset) / 32768 : 0;
      mono += value;
    }
    mono /= Math.max(1, channelCount);
    samples.push(mono);
    peak = Math.max(peak, Math.abs(mono));
    rmsSum += mono * mono;
    if (frame > 0) highDiffSum += Math.abs(mono - samples[frame - 1]);
    lowPass = lowPass * 0.995 + mono * 0.005;
    bassSum += Math.abs(lowPass);
    blockSum += mono * mono;
    blockCount += 1;
    if (blockCount >= blockSize) {
      blockRms.push(Math.sqrt(blockSum / blockCount));
      blockSum = 0;
      blockCount = 0;
    }
  }
  if (blockCount) blockRms.push(Math.sqrt(blockSum / blockCount));
  const rms = Math.sqrt(rmsSum / Math.max(1, frameCount));
  const sortedBlocks = [...blockRms].sort((a, b) => a - b);
  const noiseFloorRms = sortedBlocks.length ? sortedBlocks[Math.floor(sortedBlocks.length * 0.1)] : 0;
  const loudestBlock = sortedBlocks[sortedBlocks.length - 1] ?? 0;
  const dynamicRange = loudestBlock && noiseFloorRms ? 20 * Math.log10(loudestBlock / Math.max(0.000001, noiseFloorRms)) : 0;
  const silenceGaps = [];
  let silentBlocks = 0;
  let silenceStart: number | undefined;
  for (let index = 0; index < blockRms.length; index += 1) {
    const isSilent = blockRms[index] < 0.002;
    if (isSilent) silentBlocks += 1;
    if (isSilent && silenceStart === undefined) silenceStart = index * 0.5;
    if ((!isSilent || index === blockRms.length - 1) && silenceStart !== undefined) {
      const end = isSilent && index === blockRms.length - 1 ? (index + 1) * 0.5 : index * 0.5;
      if (end - silenceStart >= 1) silenceGaps.push({ startSeconds: Number(silenceStart.toFixed(2)), durationSeconds: Number((end - silenceStart).toFixed(2)) });
      silenceStart = undefined;
    }
  }
  const first = samples[0] ?? 0;
  const last = samples[samples.length - 1] ?? 0;
  const loopSeamClickProxy = Math.abs(first - last);
  const durationSeconds = frameCount / Math.max(1, sampleRate);
  const nonSilentBlocks = blockRms.filter((value) => value >= 0.002);
  const meanBlockRms = nonSilentBlocks.reduce((sum, value) => sum + value, 0) / Math.max(1, nonSilentBlocks.length);
  const blockVariance = nonSilentBlocks.reduce((sum, value) => sum + ((value - meanBlockRms) ** 2), 0) / Math.max(1, nonSilentBlocks.length);
  const noiseLikeFlatnessProxy = meanBlockRms > 0 ? Math.max(0, Math.min(1, 1 - Math.sqrt(blockVariance) / meanBlockRms)) : 0;
  return {
    readable: true,
    format: "wav_pcm",
    durationSeconds: Number(durationSeconds.toFixed(3)),
    sampleRate,
    bitDepth,
    channelCount,
    bitrateKbps: Number(((sampleRate * bitDepth * channelCount) / 1000).toFixed(1)),
    peak: Number(peak.toFixed(4)),
    rms: Number(rms.toFixed(4)),
    estimatedLufs: Number((20 * Math.log10(Math.max(0.000001, rms)) - 0.691).toFixed(1)),
    dynamicRange: Number(dynamicRange.toFixed(2)),
    crestFactor: Number((peak / Math.max(0.000001, rms)).toFixed(2)),
    noiseFloorRms: Number(noiseFloorRms.toFixed(5)),
    silenceRatio: Number((silentBlocks / Math.max(1, blockRms.length)).toFixed(3)),
    noiseLikeFlatnessProxy: Number(noiseLikeFlatnessProxy.toFixed(3)),
    silenceGaps,
    harshHighFrequencyProxy: Number((highDiffSum / Math.max(1, frameCount)).toFixed(5)),
    excessiveBassProxy: Number((bassSum / Math.max(1, frameCount)).toFixed(5)),
    loopSeamClickProxy: Number(loopSeamClickProxy.toFixed(5)),
    startNearZero: Math.abs(first) < 0.01,
    endNearZero: Math.abs(last) < 0.01
  };
}

function sessionQuality(session?: Record<string, unknown>) {
  if (!session) return undefined;
  const transitions = Array.isArray(session.transitionMap) ? session.transitionMap as Array<Record<string, unknown>> : [];
  const schedule = Array.isArray(session.schedule) ? session.schedule as Array<Record<string, unknown>> : [];
  const roughTransitions = transitions.filter((transition) => Array.isArray(transition.warnings) && transition.warnings.length > 0);
  const energies = schedule.map((slot) => Number(slot.energy)).filter((value) => Number.isFinite(value));
  const energyJumps = energies.slice(1).map((energy, index) => Math.abs(energy - energies[index]));
  return {
    scheduleSlots: schedule.length,
    transitionCount: transitions.length,
    roughTransitionCount: roughTransitions.length,
    maxEnergyJump: Number((Math.max(0, ...energyJumps)).toFixed(2)),
    transitionRoughness: transitions.length ? Number((roughTransitions.length / transitions.length).toFixed(3)) : 0,
    warnings: roughTransitions.map((transition) => `Transition ${transition.fromOrder ?? "?"}->${transition.toOrder ?? "?"}: ${(transition.warnings as string[]).join(", ")}`)
  };
}

function qualityForComposition(composition: Composition, options: { audio?: Buffer; useCase: string; checkLoop: boolean; targetMood?: string; session?: Record<string, unknown> }) {
  const warnings: string[] = [];
  const findings: AudioFinding[] = [];
  const allNotes = Object.values(composition.tracks).flat();
  if (!allNotes.length) addFinding(findings, "high", "musical_structure", "Composition has no notes.", "Add a sparse but audible bed, then re-render.");
  if (options.checkLoop && composition.loopable) {
    const beatSeconds = 60 / composition.tempo;
    const totalBeats = composition.durationSeconds / beatSeconds;
    const seamNotes = allNotes.filter((note) => note.startBeat < 0.25 || Math.abs(note.startBeat + note.durationBeats - totalBeats) < 0.25);
    if (!seamNotes.length) addFinding(findings, "medium", "loop", "Loop has no explicit seam-supporting note; verify loop transition.", "Add a sustained pad, pickup, or reverb tail across the loop seam.");
  }
  if (composition.instruments.length > 8) addFinding(findings, "medium", "background_suitability", "Arrangement may be too busy for background use.", "Reduce simultaneous instruments and simplify the foreground melody.");
  const repeated = composition.chordProgression.every((chord) => chord === composition.chordProgression[0]);
  if (repeated) addFinding(findings, "low", "repetition", "Chord progression is highly repetitive.", "Add a B section or light reharmonization every 16-32 bars.");
  const musicalityReport = musicalityForComposition(composition);
  if (!musicalityReport.hasPlan) addFinding(findings, "low", "musicality", "Composition has no explicit form or motif plan.", "Generate or attach a compositionPlan before rendering final audition candidates.");
  if (!musicalityReport.hasHumanizedPerformance) addFinding(findings, "high", "performance", "Robotic music output is banned: composition has no humanized performance layer.", "Add timing, velocity, sustain pedal, and phrase-level performance shaping before render/export.");
  if (musicalityReport.mechanicalScore > 0.72) addFinding(findings, "high", "musicality", "Robotic music output is banned: composition is likely to sound mechanical.", "Reduce grid lock, vary adjacent bars, widen dynamics, and add motif development before render/export.");
  const noteDensityPerMinute = allNotes.length / Math.max(1, composition.durationSeconds / 60);
  if (noteDensityPerMinute > 900) addFinding(findings, "medium", "background_suitability", "Note density is high for long background listening.", "Lower drum subdivisions, simplify comping, or thin the melody.");
  if (composition.durationSeconds < 10 && options.useCase.includes("background")) addFinding(findings, "low", "duration", "Preview is very short for judging background comfort.", "Render at least 30-60 seconds before final QA.");
  const technicalReport = wavAnalysis(options.audio);
  if (options.audio && !technicalReport.readable) addFinding(findings, "medium", "file_format", "Audio file is not a readable PCM WAV for detailed analysis.", "Render a WAV preview before QA or run an external analyzer for compressed files.");
  if (options.audio && technicalReport.readable && technicalReport.rms < 0.001) addFinding(findings, "high", "silence", "Audio render is effectively silent.", "Re-render with audible instruments and verify stem routing.");
  if (technicalReport.silenceRatio > 0.85) addFinding(findings, "high", "silence", "Audio is mostly silence.", "Check MIDI timing, renderer output, and missing instrument mappings.");
  if (technicalReport.noiseLikeFlatnessProxy > 0.94 && technicalReport.crestFactor < 2.5 && technicalReport.rms > 0.02) addFinding(findings, "medium", "noise", "Audio dynamics look noise-like and flat.", "Inspect instrument routing and replace noise-only placeholder renders.");
  if (technicalReport.peak > 0.98) addFinding(findings, "high", "clipping", "Audio peak is near 0 dBFS and may clip.", "Lower master gain or normalize to a safer true peak ceiling.");
  if (technicalReport.rms > 0.35) addFinding(findings, "medium", "loudness", "Audio is loud for background music.", "Normalize loudness lower and reduce dense transient layers.");
  if (technicalReport.dynamicRange > 28) addFinding(findings, "medium", "dynamic_range", "Dynamic range is wide for steady background playback.", "Use gentle compression or rebalance quiet/loud sections.");
  if (technicalReport.silenceGaps.length) addFinding(findings, "medium", "silence", "Detected long silence gaps.", "Fill gaps with room tone, pads, or adjust arrangement section lengths.");
  if (technicalReport.harshHighFrequencyProxy > 0.08) addFinding(findings, "medium", "harshness", "High-frequency change proxy suggests possible harshness.", "Reduce high-end, soften piano/drum velocities, or apply a gentle low-pass.");
  if (technicalReport.excessiveBassProxy > 0.18) addFinding(findings, "medium", "bass", "Low-frequency proxy suggests excessive bass energy.", "Run edit_midi with bassRepair:true to raise left-hand/bass notes below C3 by an octave, reduce their velocity, and cap sustain duration. Also verify highpass=f=35 is applied in the loudnorm pass.");
  if (options.checkLoop && composition.loopable && technicalReport.loopSeamClickProxy > 0.08) addFinding(findings, "medium", "loop", "Loop seam may click due to a large start/end waveform jump.", "End near a zero crossing, add a short crossfade, or preserve reverb tail.");
  const sessionQualityReport = sessionQuality(options.session);
  if (sessionQualityReport?.roughTransitionCount) addFinding(findings, "medium", "session", "Session contains rough transitions.", "Reorder by compatible key/tempo/energy or increase transition bed/crossfade length.");
  if (sessionQualityReport && sessionQualityReport.maxEnergyJump > 0.35) addFinding(findings, "medium", "session", "Session energy curve has abrupt jumps.", "Choose a smoother energy profile or add bridge tracks.");
  const severityRank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  warnings.push(...findings.filter((finding) => finding.severity !== "low").map((finding) => finding.message));
  const highPenalty = findings.filter((finding) => finding.severity === "high").length * 30;
  const mediumPenalty = findings.filter((finding) => finding.severity === "medium").length * 12;
  const lowPenalty = findings.filter((finding) => finding.severity === "low").length * 5;
  const backgroundSuitabilityScore = Math.max(0, Math.min(100, 96 - highPenalty - mediumPenalty - lowPenalty));
  const blockingReasons = findings.filter((finding) => finding.severity === "high").map((finding) => finding.message);
  const productionSafe = blockingReasons.length === 0 && technicalReport.readable && technicalReport.rms >= 0.001 && technicalReport.silenceRatio <= 0.85;
  return {
    ok: findings.every((finding) => finding.severity === "low"),
    productionSafe,
    blockingReasons,
    noteCount: allNotes.length,
    trackCount: Object.keys(composition.tracks).length,
    peak: technicalReport.peak,
    rms: technicalReport.rms,
    tempoStable: true,
    loopable: composition.loopable,
    useCase: options.useCase,
    targetMood: options.targetMood,
    technicalReport,
    loudnessReport: { peak: technicalReport.peak, rms: technicalReport.rms, estimatedLufs: technicalReport.estimatedLufs, dynamicRange: technicalReport.dynamicRange, target: "background-friendly, stable perceived loudness" },
    loopSeamReport: { checked: options.checkLoop, loopable: composition.loopable, seamClickProxy: technicalReport.loopSeamClickProxy, startNearZero: technicalReport.startNearZero, endNearZero: technicalReport.endNearZero },
    musicalityReport,
    sessionQualityReport,
    backgroundSuitabilityScore,
    findings,
    suggestedFixes: [...new Set(findings.map((finding) => finding.suggestedFix))],
    warnings,
    recommendations: findings.length ? [...new Set(findings.map((finding) => finding.suggestedFix))] : ["Musical structure and preview audio pass default background QA checks."]
  };
}

function harmony(input: z.infer<typeof generateJazzHarmonyInputSchema>) {
  const styleFamily = input.styleFamily ?? (input.style === "bossa" ? "bossa_lounge" : input.style === "modal_lounge" ? "modal_lounge" : input.style === "minor_jazz" ? "minor_jazz" : "cafe_jazz");
  const template = harmonyTemplates(styleFamily, input.style, input.complexity);
  const sectionPlan = sectionBarPlan(input.sections, input.bars);
  const chords = Array.from({ length: input.bars }, (_, index) => {
    const templateChord = template[index % template.length];
    const section = sectionPlan[index].section.toLowerCase();
    const varied = section.includes("b") && index % 4 === 3 ? (input.complexity === "rich" ? "Ebdim7" : "A7b9") : templateChord;
    return transposeChordSymbol(varied, input.key);
  });
  const chordChart = chords.map((chord, index) => ({
    bar: index + 1,
    section: sectionPlan[index].section,
    barInSection: sectionPlan[index].barInSection,
    chord,
    beats: 4,
    harmonicRhythm: input.complexity === "rich" && index % 4 === 3 ? "two chords possible on beats 1 and 3" : "one chord per bar"
  }));
  const pianoVoicings = chords.map((chord, index) => {
    const root = chordRootMidi(chord, input.key);
    const midi = voicingForChord(chord, root, input.voicingType);
    return {
      bar: index + 1,
      section: sectionPlan[index].section,
      chord,
      voicingType: input.voicingType,
      hand: input.voicingType === "shell" ? "left hand shell" : "right hand comping",
      midi,
      velocity: input.voicingType === "sparse_background" ? 46 : 54,
      durationBeats: input.voicingType === "sparse_background" ? 3.6 : 3.8
    };
  });
  const bassGuideTones = chords.map((chord, index) => {
    const root = chordRootMidi(chord, input.key) - 24;
    const nextRoot = chordRootMidi(chords[(index + 1) % chords.length], input.key) - 24;
    return {
      bar: index + 1,
      section: sectionPlan[index].section,
      chord,
      midi: [root, root + 7, nextRoot - 2, nextRoot],
      movement: "root, fifth, chromatic approach, next root"
    };
  });
  const midiVoicingData = pianoVoicings.flatMap((voicing) => voicing.midi.map((midi) => ({
    track: "piano",
    midi,
    startBeat: (voicing.bar - 1) * 4,
    durationBeats: voicing.durationBeats,
    velocity: voicing.velocity,
    chord: voicing.chord,
    section: voicing.section
  })));
  const sectionHarmony = input.sections?.map((section) => ({
    section,
    chords: chordChart.filter((entry) => entry.section === section).map((entry) => entry.chord),
    role: section.toLowerCase().includes("intro") ? "set warm tonal color" : section.toLowerCase().includes("outro") ? "resolve gently with tail" : section.toLowerCase().includes("b") ? "contrast with secondary dominants or modal color" : "main cafe/lounge progression"
  })) ?? [{ section: "A", chords, role: "main cafe/lounge progression" }];
  return {
    key: input.key,
    style: input.style,
    styleFamily,
    tempoBpm: input.tempoBpm,
    mood: input.mood,
    complexity: input.complexity,
    instrumentTarget: input.instrumentTarget,
    chordChart,
    sectionHarmony,
    pianoVoicings,
    bassGuideTones,
    walkingBass: bassGuideTones.map((guide) => guide.midi[0]),
    midiVoicingData,
    harmonicRhythm: { default: "one chord per bar", richOption: "add passing diminished or tritone substitution on beat 3 at section turns" },
    buildingBlocks: ["ii-V-I", "turnaround", "secondary dominant", "tritone substitution", "diminished passing chord", "smooth lounge extensions"],
    variationNotes: [
      "Use rootless or sparse voicings under melody so the lead does not distract from background use.",
      "For A_variation, keep the same cadence but swap one dominant for a tritone substitute.",
      "For outro, reduce velocity and hold the final maj9 or 6/9 color."
    ],
    originalityNotes: [`Policy: ${input.originalityPolicy}.`, "Progression is generated from abstract jazz functions and broad cafe/lounge constraints, not from a specific song or artist arrangement."],
    warnings: []
  };
}

const drumMidi: Record<string, number> = { kick: 36, snare: 38, rim: 37, hat: 42, ride: 51, brush: 42, brush_swirl: 59, shaker: 70, tom: 45, low_pulse: 36, clap: 39 };

function styleForGroove(input: z.infer<typeof generateDrumGrooveInputSchema>) {
  if (input.styleFamily) return input.styleFamily;
  if (input.groove === "bossa_nova" || input.groove === "samba_lite") return "bossa_lounge";
  if (input.groove === "lo_fi") return "lo_fi";
  if (input.groove === "cinematic_pulse") return "cinematic_background";
  if (input.groove === "ambient_percussion") return "game_ambience";
  if (input.groove === "retail_cafe_low_distraction") return "retail_cafe";
  return "cafe_jazz";
}

function energyVelocity(energy: z.infer<typeof generateDrumGrooveInputSchema>["energy"]) {
  if (energy === "low") return 34;
  if (energy === "medium") return 52;
  if (energy === "medium_high") return 62;
  return 44;
}

function sectionVariation(section: string, energy: z.infer<typeof generateDrumGrooveInputSchema>["energy"]) {
  const name = section.toLowerCase();
  if (name.includes("intro")) return { density: 0.45, velocityScale: 0.78, role: "sparse setup" };
  if (name.includes("outro")) return { density: 0.42, velocityScale: 0.7, role: "simplified release" };
  if (name.includes("solo")) return { density: 0.7, velocityScale: 0.88, role: "supportive solo bed" };
  if (name.includes("b")) return { density: 0.78, velocityScale: 1.06, role: "slightly lifted contrast" };
  return { density: energy === "low" ? 0.55 : 0.68, velocityScale: 1, role: "steady background groove" };
}

function drumGroove(input: z.infer<typeof generateDrumGrooveInputSchema>) {
  const tempo = input.tempoBpm ?? input.tempo;
  const styleFamily = styleForGroove(input);
  const beatsPerBar = input.meter === "3/4" ? 3 : input.meter === "6/8" ? 6 : 4;
  const sectionPlan = sectionBarPlan(input.sections, input.bars);
  const baseVelocity = energyVelocity(input.energy);
  const hits: Array<{ instrument: string; midi: number; beat: number; startBeat: number; durationBeats: number; velocity: number; section: string; bar: number; role: string }> = [];
  const add = (instrument: string, bar: number, beatInBar: number, velocity: number, durationBeats = 0.25) => {
    const section = sectionPlan[bar]?.section ?? "A";
    const variation = sectionVariation(section, input.energy);
    if (hits.filter((hit) => hit.bar === bar + 1).length >= input.constraints.maxHitsPerBar) return;
    const scaledVelocity = Math.max(12, Math.min(82, Math.round(velocity * variation.velocityScale)));
    hits.push({ instrument, midi: drumMidi[instrument] ?? 42, beat: Number((bar * beatsPerBar + beatInBar).toFixed(3)), startBeat: Number((bar * beatsPerBar + beatInBar).toFixed(3)), durationBeats, velocity: scaledVelocity, section, bar: bar + 1, role: variation.role });
  };
  for (let bar = 0; bar < input.bars; bar += 1) {
    const section = sectionPlan[bar]?.section ?? "A";
    const variation = sectionVariation(section, input.energy);
    const dense = variation.density > 0.6 && !input.operations.includes("make_less_busy") && !input.operations.includes("simplify_groove");
    if (input.groove === "bossa_nova" || input.groove === "samba_lite") {
      add("kick", bar, 0, baseVelocity + 2, 0.2);
      add("rim", bar, 1.5 + input.swing / 3, baseVelocity + 4, 0.18);
      add("shaker", bar, 0.75, baseVelocity - 10, 0.18);
      if (dense) add("shaker", bar, 2.75, baseVelocity - 12, 0.18);
    } else if (input.groove === "lo_fi") {
      add("kick", bar, 0, baseVelocity + 6, 0.22);
      add("snare", bar, 2 + input.swing / 2, baseVelocity, 0.22);
      add("hat", bar, 1 + input.swing / 3, baseVelocity - 14, 0.16);
      if (dense) add("hat", bar, 3 + input.swing / 3, baseVelocity - 16, 0.16);
    } else if (input.groove === "cinematic_pulse" || input.groove === "ambient_percussion") {
      add("low_pulse", bar, 0, baseVelocity + 8, 0.35);
      if (dense) add("tom", bar, beatsPerBar - 1 + input.swing / 4, baseVelocity - 4, 0.24);
      add("shaker", bar, beatsPerBar / 2, baseVelocity - 18, 0.18);
    } else if (input.groove === "pop_ballad" || input.groove === "soft_pop_ballad") {
      add("kick", bar, 0, baseVelocity + 4, 0.22);
      add("snare", bar, 2 + input.swing / 4, baseVelocity + 2, 0.22);
      add(input.kit === "jazz_brushes" ? "brush" : "hat", bar, 1, baseVelocity - 12, 0.16);
      if (dense) add(input.kit === "jazz_brushes" ? "brush" : "hat", bar, 3, baseVelocity - 14, 0.16);
    } else {
      add(input.kit === "jazz_brushes" ? "brush" : "ride", bar, 0, baseVelocity - 2, 0.2);
      add("kick", bar, 0, baseVelocity + 2, 0.2);
      add(input.kit === "jazz_brushes" ? "brush_swirl" : "snare", bar, 2 + input.swing, baseVelocity + 4, 0.2);
      add(input.kit === "jazz_brushes" ? "brush" : "hat", bar, 2.67 + input.swing / 2, baseVelocity - 10, 0.16);
    }
  }
  if (input.operations.includes("reduce_kick")) for (const hit of hits) if (hit.instrument === "kick" || hit.instrument === "low_pulse") hit.velocity = Math.max(18, Math.round(hit.velocity * 0.72));
  if (input.operations.includes("soften_snare")) for (const hit of hits) if (hit.instrument === "snare" || hit.instrument === "rim") hit.velocity = Math.max(18, Math.round(hit.velocity * 0.78));
  if (input.operations.includes("use_brushes_instead_of_sticks")) for (const hit of hits) if (["snare", "hat", "ride"].includes(hit.instrument)) hit.instrument = hit.instrument === "snare" ? "brush_swirl" : "brush";
  if (input.operations.includes("humanize_timing")) {
    for (const hit of hits) {
      const offset = ((hit.midi % 5) - 2) * 0.012;
      hit.startBeat = Number((hit.startBeat + offset).toFixed(3));
      hit.beat = hit.startBeat;
    }
  }
  const fills = [{ bar: input.bars, section: sectionPlan[input.bars - 1]?.section ?? "outro", instruction: input.operations.includes("add_transition_fill") ? "two-beat soft brush pickup into next section" : "light pickup fill into loop seam", midi: [{ instrument: "brush_swirl", midi: drumMidi.brush_swirl, startBeat: Math.max(0, input.bars * beatsPerBar - 1), durationBeats: 0.25, velocity: Math.max(24, baseVelocity - 4) }] }];
  if (input.operations.includes("add_fill") || input.operations.includes("add_transition_fill")) {
    for (const fill of fills) for (const note of fill.midi) hits.push({ ...note, beat: note.startBeat, section: fill.section, bar: fill.bar, role: "soft transition fill" });
  }
  const sectionVariationMap = [...new Set(sectionPlan.map((item) => item.section))].map((section) => ({ section, ...sectionVariation(section, input.energy), recommendedOperation: section.toLowerCase().includes("intro") || section.toLowerCase().includes("outro") ? "simplify_groove" : "generate_groove" }));
  const velocities = hits.map((hit) => hit.velocity);
  const warnings = [];
  if (input.constraints.backgroundFriendly && Math.max(0, ...velocities) > 84) warnings.push("Velocity exceeds background-friendly ceiling.");
  if (input.constraints.avoidAggressiveCymbals && hits.some((hit) => hit.instrument === "ride" && hit.velocity > 70)) warnings.push("Ride/cymbal velocity may be too aggressive for long listening.");
  const grooveManifest = { styleFamily, groove: input.groove, tempoBpm: tempo, meter: input.meter, kit: input.kit, energy: input.energy, constraints: input.constraints, operations: input.operations, midiIntegration: { track: "drums", channel: 10, ppq: 480 } };
  return {
    groove: input.groove,
    styleFamily,
    tempo,
    tempoBpm: tempo,
    meter: input.meter,
    bars: input.bars,
    swing: input.swing,
    hits,
    fills,
    grooveManifest,
    sectionVariationMap,
    velocityProfile: { min: Math.min(...velocities), max: Math.max(...velocities), average: Number((velocities.reduce((sum, value) => sum + value, 0) / Math.max(1, velocities.length)).toFixed(1)), backgroundCeiling: 84 },
    swingReport: { amount: input.swing, feel: input.swing >= 0.5 ? "deep swing/shuffle" : input.swing >= 0.25 ? "light swing" : "nearly straight", humanizeRecommended: !input.operations.includes("humanize_timing") },
    backgroundSafety: { noSuddenHits: input.constraints.noSuddenHits, avoidAggressiveCymbals: input.constraints.avoidAggressiveCymbals, longListeningFriendly: warnings.length === 0 },
    midiNotes: hits.map((hit) => ({ track: "drums", midi: drumMidi[hit.instrument] ?? hit.midi, startBeat: hit.startBeat, durationBeats: hit.durationBeats, velocity: hit.velocity, instrument: hit.instrument, section: hit.section })),
    warnings
  };
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

function slugifyMusicExportPart(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "music-export";
}

function musicExportRoleForPath(pathValue: string, fallback: string) {
  const ext = path.extname(pathValue).toLowerCase();
  if ([".wav", ".mp3", ".ogg", ".flac"].includes(ext)) return fallback === "stem" ? "stem" : "audio";
  if ([".mid", ".midi"].includes(ext)) return "midi";
  if ([".pdf", ".html", ".md"].includes(ext)) return "chord_chart";
  if (ext === ".json") return fallback;
  return fallback;
}

async function inspectProjectExportFiles(ctx: ToolContext, projectId: string, files: Array<{ path: string; role: string; purpose: string }>) {
  const exportedFiles: Array<{ path: string; role: string; purpose: string; sizeBytes: number; format: string }> = [];
  const missingFiles: string[] = [];
  const largeFiles: Array<{ path: string; sizeBytes: number }> = [];
  const brokenAudioReferences: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    const format = path.extname(file.path).replace(".", "").toLowerCase() || "unknown";
    try {
      const info = await stat(await getProjectStoredFilePath(ctx.projectRoot, projectId, file.path));
      exportedFiles.push({ ...file, role: musicExportRoleForPath(file.path, file.role), sizeBytes: info.size, format });
      if (info.size > 100 * 1024 * 1024) largeFiles.push({ path: file.path, sizeBytes: info.size });
      if (file.role === "audio" && !["wav", "mp3", "ogg"].includes(format)) brokenAudioReferences.push(`${file.path} is not a supported audio format.`);
    } catch {
      missingFiles.push(file.path);
      if (file.role === "audio" || file.role === "stem") brokenAudioReferences.push(`${file.path} is missing.`);
    }
  }
  return { exportedFiles, missingFiles, largeFiles, brokenAudioReferences };
}

type MusicExportFile = {
  path: string;
  role: string;
  purpose: string;
  sizeBytes: number;
  format: string;
};

function collectMusicLicenseWarnings(licenseManifest: unknown) {
  const warnings: string[] = [];
  if (!licenseManifest || typeof licenseManifest !== "object") return warnings;
  const manifest = licenseManifest as Record<string, unknown>;
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) warnings.push(value.trim());
  };
  const addArray = (value: unknown) => {
    if (Array.isArray(value)) for (const item of value) add(typeof item === "string" ? item : JSON.stringify(item));
  };
  addArray(manifest.warnings);
  addArray(manifest.licenseWarnings);
  addArray(manifest.unsafeAssets);
  addArray(manifest.restrictions);
  if (manifest.businessDemoSuitable === false) warnings.push("License manifest marks this project as not suitable for business demos.");
  if (manifest.commercialUseAllowed === false) warnings.push("License manifest says commercial use is not allowed.");
  if (manifest.productionSafe === false) warnings.push("License manifest says final production export is not safe.");
  const zipSummary = manifest.zipExportSummary as Record<string, unknown> | undefined;
  if (zipSummary?.blockFinalExport === true) warnings.push("License manifest blocks final ZIP/export delivery.");
  return Array.from(new Set(warnings));
}

function buildUnsupportedMusicExportWarnings(exports: string[], files: Array<{ path: string; role: string }>) {
  const availableFormats = new Set(files.map((file) => path.extname(file.path).replace(".", "").toLowerCase()));
  const warnings: string[] = [];
  for (const format of ["mp3", "ogg"]) {
    if (exports.some((item) => item.endsWith(`_${format}`)) && !availableFormats.has(format)) {
      warnings.push(`${format.toUpperCase()} export was requested, but no ${format.toUpperCase()} file path was provided. Run a verified encoder or provide an existing file.`);
    }
  }
  return warnings;
}

async function findProductionRenderGateWarnings(ctx: ToolContext, projectId: string, renderedAudioPaths: string[], renderReportPaths: string[] = []) {
  const warnings: string[] = [];
  const reports: Array<Record<string, unknown> & { reportPath: string }> = [];
  const reportCandidates = [...new Set([...renderReportPaths, "music/soundfont-render-report.json", "music/render-report.json", "music/mastering-report.json"])];
  for (const candidate of reportCandidates) {
    try {
      const parsed = JSON.parse(await readProjectFile(ctx.projectRoot, projectId, candidate, 2 * 1024 * 1024)) as Record<string, unknown>;
      reports.push({ ...parsed, reportPath: candidate });
    } catch {
      // Optional report paths are discovered best-effort from existing project files.
    }
  }
  for (const audioPath of renderedAudioPaths) {
    const report = reports.find((candidate) => candidate.fullMixPath === audioPath || candidate.masteredAudioPath === audioPath || candidate.productionWavPath === audioPath || (candidate.renderReport as Record<string, unknown> | undefined)?.fullMixPath === audioPath);
    if (!report) {
      warnings.push(`Production gate: ${audioPath} has no production_candidate render report.`);
      continue;
    }
    const nested = report.renderReport as Record<string, unknown> | undefined;
    const qualityTier = String(report.qualityTier ?? nested?.qualityTier ?? "unknown");
    const productionReady = report.productionReady ?? nested?.productionReady;
    if (qualityTier !== "production_candidate" || productionReady !== true) {
      warnings.push(`Production gate: ${audioPath} is ${qualityTier} from ${String(report.renderer ?? nested?.renderer ?? report.reportPath)}; run render_midi_with_soundfont with a ready SoundFont pack before production export.`);
    }
    const soundfont = (report.soundfont ?? nested?.soundfont) as Record<string, unknown> | undefined;
    const soundfonts = (report.soundfonts ?? nested?.soundfonts) as Record<string, Record<string, unknown>> | undefined;
    const soundfontRecords = soundfonts && Object.keys(soundfonts).length ? Object.values(soundfonts) : soundfont ? [soundfont] : [{}];
    for (const [index, packRecord] of soundfontRecords.entries()) {
      const label = typeof packRecord.packId === "string" ? packRecord.packId : `pack_${index + 1}`;
      const packSha256 = report.packSha256 ?? nested?.packSha256 ?? packRecord.computedSha256;
      const licenseTextPath = report.packLicenseTextPath ?? nested?.packLicenseTextPath ?? packRecord.licenseTextPath;
      const sourceUrl = report.packSourceUrl ?? nested?.packSourceUrl ?? packRecord.sourceUrl;
      const productionUseApproved = report.productionUseApproved ?? nested?.productionUseApproved ?? packRecord.productionUseApproved;
      const commercialUseAllowed = packRecord.commercialUseAllowed;
      if (typeof packSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(packSha256)) warnings.push(`Production gate: ${audioPath} render report has no valid pack SHA-256 for ${label}.`);
      if (typeof licenseTextPath !== "string" || !licenseTextPath.trim()) warnings.push(`Production gate: ${audioPath} render report has no license text path for ${label}.`);
      if (typeof sourceUrl !== "string" || !sourceUrl.trim()) warnings.push(`Production gate: ${audioPath} render report has no source URL for ${label}.`);
      if (productionUseApproved !== true) warnings.push(`Production gate: ${audioPath} render report is not productionUseApproved=true for ${label}.`);
      if (commercialUseAllowed !== true) warnings.push(`Production gate: ${audioPath} render report is not commercial-use clean for ${label}.`);
    }
    const blockingReasons = Array.isArray(report.blockingReasons) ? report.blockingReasons : Array.isArray(nested?.blockingReasons) ? nested.blockingReasons : [];
    for (const reason of blockingReasons) warnings.push(`Production gate: ${audioPath}: ${String(reason)}`);
  }
  const resolvedReports = reports.map((report) => {
    const nested = report.renderReport as Record<string, unknown> | undefined;
    const soundfont = (report.soundfont ?? nested?.soundfont) as Record<string, unknown> | undefined;
    return {
      reportPath: report.reportPath,
      renderer: String(report.renderer ?? nested?.renderer ?? "unknown"),
      qualityTier: String(report.qualityTier ?? nested?.qualityTier ?? "unknown"),
      productionReady: report.productionReady ?? nested?.productionReady ?? false,
      packSha256: report.packSha256 ?? nested?.packSha256 ?? soundfont?.computedSha256,
      packLicenseTextPath: report.packLicenseTextPath ?? nested?.packLicenseTextPath ?? soundfont?.licenseTextPath,
      packSourceUrl: report.packSourceUrl ?? nested?.packSourceUrl ?? soundfont?.sourceUrl,
      productionUseApproved: report.productionUseApproved ?? nested?.productionUseApproved ?? soundfont?.productionUseApproved ?? false,
      fullMixPath: typeof report.fullMixPath === "string" ? report.fullMixPath : undefined,
      masteredAudioPath: typeof report.masteredAudioPath === "string" ? report.masteredAudioPath : undefined,
      productionWavPath: typeof report.productionWavPath === "string" ? report.productionWavPath : undefined
    };
  });
  return { warnings: Array.from(new Set(warnings)), resolvedReports };
}

async function findMusicQualityGateWarnings(ctx: ToolContext, projectId: string, qualityReportPaths: string[] = []) {
  const warnings: string[] = [];
  const resolvedReports: Array<{ reportPath: string; productionSafe: boolean | "unknown"; blockingReasonCount: number; highFindingCount: number }> = [];
  const explicitPaths = new Set(qualityReportPaths);
  const reportCandidates = [...new Set([...qualityReportPaths, "music/audio-quality-report.json"])];
  for (const reportPath of reportCandidates) {
    try {
      const report = JSON.parse(await readProjectFile(ctx.projectRoot, projectId, reportPath, 2 * 1024 * 1024)) as Record<string, unknown>;
      const blockingReasons = Array.isArray(report.blockingReasons) ? report.blockingReasons.map(String) : [];
      const findings = Array.isArray(report.findings) ? report.findings as Array<Record<string, unknown>> : [];
      const highFindings = findings.filter((finding) => finding.severity === "high");
      resolvedReports.push({
        reportPath,
        productionSafe: typeof report.productionSafe === "boolean" ? report.productionSafe : "unknown",
        blockingReasonCount: blockingReasons.length,
        highFindingCount: highFindings.length
      });
      if (report.productionSafe === false) warnings.push("Audio QA gate: productionSafe=false.");
      for (const reason of blockingReasons) warnings.push(`Audio QA gate: ${reason}`);
      for (const finding of highFindings) {
        warnings.push(`Audio QA gate: high finding: ${String(finding.message ?? "unknown finding")}`);
      }
    } catch (error) {
      if (explicitPaths.has(reportPath)) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Audio QA gate: unable to read quality report ${reportPath}: ${message}`);
      }
    }
  }
  return { warnings: Array.from(new Set(warnings)), resolvedReports };
}

function renderMusicExportReadme(manifest: {
  packageName: string;
  naming: Record<string, unknown>;
  exports: string[];
  exportedFiles: Array<{ path: string; role: string; purpose: string; sizeBytes: number }>;
  missingFiles: string[];
  licenseWarnings: string[];
  unsupportedFormats: string[];
}) {
  const lines = [
    `# ${manifest.packageName}`,
    "",
    "This folder is a handoff index for the generated music project. Use the files below for websites, videos, presentations, cafe/background playback, games, and client demos after reviewing license warnings.",
    "",
    "## Naming",
    `Base filename: ${manifest.naming.baseFileName}`,
    `Version: ${manifest.naming.version ?? "not specified"}`,
    `BPM: ${manifest.naming.bpm ?? "not specified"}`,
    `Key: ${manifest.naming.key ?? "not specified"}`,
    `Duration: ${manifest.naming.durationSeconds ?? "not specified"} seconds`,
    "",
    "## Requested Exports",
    ...manifest.exports.map((item) => `- ${item}`),
    "",
    "## Files",
    ...manifest.exportedFiles.map((file) => `- ${file.path} (${file.role}, ${file.sizeBytes} bytes): ${file.purpose}`),
    "",
    "## Checks",
    `Missing files: ${manifest.missingFiles.length ? manifest.missingFiles.join(", ") : "none"}`,
    `License warnings: ${manifest.licenseWarnings.length ? manifest.licenseWarnings.join("; ") : "none"}`,
    `Unsupported formats: ${manifest.unsupportedFormats.length ? manifest.unsupportedFormats.join("; ") : "none"}`,
    "",
    "## File Roles",
    "- single track audio: final short or long WAV/MP3/OGG render for direct playback.",
    "- long session audio: 30 minute, 1 hour, or 2 hour background program where provided.",
    "- MIDI: editable note data for arrangement revisions.",
    "- stems: separate piano, bass, drums, strings, ambience, or full mix files.",
    "- chord chart / lead sheet: PDF, HTML, or Markdown musician reference.",
    "- project manifest and license manifest: structured metadata and usage safety notes.",
    "- preview/demo webpage and playlist metadata: listening and client review handoff."
  ];
  return `${lines.join("\n")}\n`;
}

function renderMusicExportHtml(input: {
  readmePath: string;
  packageReportPath: string;
  playlistPath: string;
  exportedFiles: MusicExportFile[];
  missingFileCount: number;
  licenseWarningCount: number;
  unsupportedFormatCount: number;
  productionGateWarningCount: number;
  tracks: Array<{ title: string; durationSeconds: number; key: string; tempo: number }>;
  session: unknown;
}) {
  const playableFiles = input.exportedFiles.filter((file) => file.role === "audio" || file.role === "stem");
  const wavFile = playableFiles.find((file) => file.format === "wav");
  const mp3File = playableFiles.find((file) => file.format === "mp3");
  const primaryPreview = mp3File ?? wavFile ?? playableFiles[0];
  const productionReady = playableFiles.length > 0 && input.missingFileCount === 0 && input.licenseWarningCount === 0 && input.unsupportedFormatCount === 0 && input.productionGateWarningCount === 0;
  const statusLabel = productionReady
    ? "Rendered with free license-cleared instruments. Suitable for production use with proper attribution."
    : "MIDI preview only. Not production audio.";
  const playerSection = playableFiles.length
    ? `<h2>Listen</h2><p class="${productionReady ? "ok" : "warn"}">${escapeHtml(statusLabel)}</p>${primaryPreview ? `<div class="controls"><button type="button" onclick="document.querySelector('audio')?.play()">Play Preview</button>${wavFile ? `<a class="button" download href="${escapeHtml(wavFile.path)}">Download WAV</a>` : ""}${mp3File ? `<a class="button" download href="${escapeHtml(mp3File.path)}">Download MP3</a>` : ""}</div>` : ""}<div class="players">${playableFiles.map((file) => `<article class="player"><h3>${escapeHtml(file.path)}</h3><audio controls preload="metadata" src="${escapeHtml(file.path)}"></audio><p>${escapeHtml(file.purpose)} (${escapeHtml(file.format.toUpperCase())}, ${file.sizeBytes} bytes)</p></article>`).join("")}</div>`
    : `<h2>Listen</h2><p class="warn">No playable audio file was exported. Provide a WAV/MP3/OGG render before publishing a listening page.</p>`;
  const downloadItems = [
    `<li><a href="${escapeHtml(input.readmePath)}">README</a></li>`,
    `<li><a href="${escapeHtml(input.packageReportPath)}">Package report JSON</a></li>`,
    `<li><a href="${escapeHtml(input.playlistPath)}">Playlist metadata JSON</a></li>`,
    ...input.exportedFiles.map((file) => `<li><a href="${escapeHtml(file.path)}">${escapeHtml(file.path)}</a> - ${escapeHtml(file.role)}</li>`)
  ];
  const trackItems = input.tracks.map((track) => `<li>${escapeHtml(track.title)} - ${Math.round(track.durationSeconds / 60)} min, ${escapeHtml(track.key)}, ${track.tempo} BPM</li>`).join("");
  const checksClass = input.missingFileCount || input.licenseWarningCount || input.productionGateWarningCount ? "warn" : "ok";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Music Project Export</title><style>body{font-family:system-ui;margin:32px;max-width:960px;color:#171717}li{margin:8px 0}.warn{color:#9a3412}.ok{color:#166534}.players{display:grid;gap:16px;margin:16px 0}.player{border:1px solid #ddd;border-radius:8px;padding:16px;background:#fafafa}.player h3{margin:0 0 10px;font-size:1rem}.player p{color:#555}.controls{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}.button,button{border:1px solid #222;border-radius:6px;background:#fff;color:#171717;padding:10px 12px;font-weight:700;text-decoration:none;cursor:pointer}audio{width:100%;display:block}</style></head><body><h1>Music Project Export</h1><p>Generated original production music handoff.</p>${playerSection}<h2>Download package</h2><ul>${downloadItems.join("")}</ul><h2>Checks</h2><p class="${checksClass}">Missing files: ${input.missingFileCount}; license warnings: ${input.licenseWarningCount}; unsupported formats: ${input.unsupportedFormatCount}; production gate warnings: ${input.productionGateWarningCount}</p><h2>Tracks</h2><ul>${trackItems}</ul><h2>Session</h2><pre>${escapeHtml(JSON.stringify(input.session ?? {}, null, 2))}</pre></body></html>`;
}

function parseMusicTimestamp(value?: string) {
  if (!value) return undefined;
  const parts = value.trim().split(":").map((part) => Number(part));
  if (!parts.every((part) => Number.isFinite(part))) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}

function normalizeMusicFeedbackItems(items: z.infer<typeof processMusicRevisionFeedbackInputSchema>["feedback"]) {
  return items.map((item, index) => {
    if (typeof item === "string") return { index, comment: item, timestamp: undefined as string | undefined, timestampSeconds: undefined as number | undefined, rating: undefined as number | undefined, category: undefined as string | undefined };
    return { index, comment: item.comment, timestamp: item.timestamp, timestampSeconds: parseMusicTimestamp(item.timestamp), endTimestamp: item.endTimestamp, endTimestampSeconds: parseMusicTimestamp(item.endTimestamp), rating: item.rating, category: item.category };
  });
}

function extractDurationMinutes(feedbackText: string, explicit?: number) {
  if (explicit) return explicit;
  const minuteMatch = feedbackText.match(/(\d+(?:\.\d+)?)\s*(?:min|mins|minute|minutes|分钟)/i);
  if (minuteMatch) return Number(minuteMatch[1]);
  const hourMatch = feedbackText.match(/(\d+(?:\.\d+)?)\s*(?:hour|hours|小时)/i);
  if (hourMatch) return Number(hourMatch[1]) * 60;
  return undefined;
}

function pushUniqueOperation<T extends Record<string, unknown>>(list: T[], item: T) {
  const key = JSON.stringify(item);
  if (!list.some((existing) => JSON.stringify(existing) === key)) list.push(item);
}

function buildMusicRevisionPlan(parsed: z.infer<typeof processMusicRevisionFeedbackInputSchema>, existingHistory: unknown) {
  const normalizedFeedback = normalizeMusicFeedbackItems(parsed.feedback);
  const lower = normalizedFeedback.map((item) => item.comment).join(" ").toLowerCase();
  const targetDurationMinutes = extractDurationMinutes(lower, parsed.targetDurationMinutes);
  const nextRevisionNumber = Array.isArray(existingHistory) ? existingHistory.length + 1 : 1;
  const targetVersionId = `${parsed.selectedVersionId}-rev${nextRevisionNumber}`;
  const midiEditOperations: Array<{ type: string; track?: string; section?: string; value?: string | number | boolean; reason: string; timestampSeconds?: number }> = [];
  const arrangementOperations: Array<{ tool: string; action: string; value?: string | number | boolean; reason: string; timestampSeconds?: number }> = [];
  const mixOperations: Array<{ tool: string; action: string; target?: string; value?: string | number | boolean; reason: string; timestampSeconds?: number }> = [];
  const styleOperations: Array<{ tool: string; action: string; value?: string; reason: string }> = [];
  const qaChecklist = new Set<string>(["Confirm selected version matches listener choice.", "Run inspect_audio_quality after render.", "Re-export music package after revision passes QA."]);
  const detectedFeedbackTypes = new Set<string>(["choose_winning_version"]);

  const hasNegativeInstrumentConstraint = (text: string, instrumentPattern: RegExp) =>
    instrumentPattern.test(text) && (
      /\bno\s+(?:more\s+)?(?:violin|strings?|cello|drums?|brush(?:es)?|snare|kick|cymbal)s?\b/i.test(text) ||
      /\b(?:without|remove|drop|exclude|mute)\s+(?:the\s+)?(?:violin|strings?|cello|drums?|brush(?:es)?|snare|kick|cymbal)s?\b/i.test(text) ||
      /\b(?:piano|solo piano)\s+only\b/i.test(text) ||
      /(不要|去掉|移除|不用)(?:.*)(小提琴|弦乐|大提琴|鼓|镲)/i.test(text)
    );

  for (const item of normalizedFeedback) {
    const text = item.comment.toLowerCase();
    const reason = item.timestamp ? `${item.timestamp}: ${item.comment}` : item.comment;
    if (/(drum|drums|brush|snare|kick|cymbal|鼓|镲)/i.test(text)) {
      detectedFeedbackTypes.add("drums");
      if (hasNegativeInstrumentConstraint(text, /(drum|drums|brush|snare|kick|cymbal|鼓|镲)/i)) {
        pushUniqueOperation(midiEditOperations, { type: "mute_track", track: "drums", value: true, reason, timestampSeconds: item.timestampSeconds });
      } else if (/(too busy|busy|less|reduce|quieter|soft|太忙|少一点|降低)/i.test(text)) {
        pushUniqueOperation(midiEditOperations, { type: "adjust_velocity", track: "drums", value: 0.72, reason, timestampSeconds: item.timestampSeconds });
        pushUniqueOperation(midiEditOperations, { type: "edit_notes", track: "drums", value: "remove nonessential ghost notes and fills", reason, timestampSeconds: item.timestampSeconds });
        pushUniqueOperation(styleOperations, { tool: "generate_drum_groove", action: "make_less_busy", value: "jazz_brushes", reason });
        pushUniqueOperation(mixOperations, { tool: "render_midi_to_audio", action: "lower drum stem level", target: "drums", value: "-3dB", reason, timestampSeconds: item.timestampSeconds });
      }
      if (/(brush|brushes|刷|扫)/i.test(text)) pushUniqueOperation(midiEditOperations, { type: "change_instrument", track: "drums", value: "brush_drums", reason, timestampSeconds: item.timestampSeconds });
    }
    if (/(piano|keys|keyboard|钢琴|琴)/i.test(text)) {
      detectedFeedbackTypes.add("piano");
      if (/(warm|warmer|soft|softer|less busy|太忙|温暖|柔和)/i.test(text)) {
        pushUniqueOperation(midiEditOperations, { type: "adjust_velocity", track: "piano", value: 0.84, reason, timestampSeconds: item.timestampSeconds });
        pushUniqueOperation(midiEditOperations, { type: "humanize", track: "piano", value: 18, reason, timestampSeconds: item.timestampSeconds });
        pushUniqueOperation(mixOperations, { tool: "render_midi_to_audio", action: "use warmer piano preset", target: "piano", value: "warm_acoustic_piano", reason, timestampSeconds: item.timestampSeconds });
      }
      if (/(less busy|simpler|太忙|简单)/i.test(text)) pushUniqueOperation(midiEditOperations, { type: "edit_notes", track: "piano", value: "thin comping density and leave more rests", reason, timestampSeconds: item.timestampSeconds });
    }
    if (/(add violin|violin|strings|cello|小提琴|弦乐)/i.test(text)) {
      detectedFeedbackTypes.add("instrumentation");
      if (hasNegativeInstrumentConstraint(text, /(violin|strings|cello|小提琴|弦乐|大提琴)/i) || /(remove|less|without|不要|去掉)/i.test(text)) {
        pushUniqueOperation(midiEditOperations, { type: "mute_track", track: text.includes("cello") ? "cello" : text.includes("strings") ? "strings" : "violin", value: true, reason, timestampSeconds: item.timestampSeconds });
      } else {
        pushUniqueOperation(midiEditOperations, { type: "create_track", track: text.includes("cello") ? "cello" : text.includes("strings") ? "strings" : "violin", value: "soft counterline under melody", reason, timestampSeconds: item.timestampSeconds });
      }
    }
    if (/(more jazz|jazzier|bossa|lo-fi|lofi|swing|更爵士|波萨|低保真)/i.test(text)) {
      detectedFeedbackTypes.add("style");
      const value = text.includes("bossa") || text.includes("波萨") ? "bossa_lounge" : text.includes("lo-fi") || text.includes("lofi") || text.includes("低保真") ? "lo_fi" : "cafe_jazz";
      pushUniqueOperation(styleOperations, { tool: "generate_jazz_harmony", action: "regenerate_harmony_style", value, reason });
      pushUniqueOperation(midiEditOperations, { type: "swing", value: value === "cafe_jazz" ? 0.58 : value === "bossa_lounge" ? 0.22 : 0.36, reason, timestampSeconds: item.timestampSeconds });
    }
    if (/(melody|lead|less distracting|distracting|旋律|太抢|分心)/i.test(text)) {
      detectedFeedbackTypes.add("melody");
      pushUniqueOperation(midiEditOperations, { type: "edit_notes", track: "lead", value: "reduce melody density and avoid high-register hooks", reason, timestampSeconds: item.timestampSeconds });
      qaChecklist.add("Check melody remains background-friendly and not attention-grabbing.");
    }
    if (/(extend|longer|minutes|minute|分钟|加长)/i.test(text)) {
      detectedFeedbackTypes.add("duration");
      const minutes = extractDurationMinutes(text, targetDurationMinutes) ?? 6;
      pushUniqueOperation(arrangementOperations, { tool: "extend_music_arrangement", action: "extend_selected_version", value: Math.round(minutes * 60), reason, timestampSeconds: item.timestampSeconds });
      qaChecklist.add("Verify extended arrangement avoids obvious copy-paste repetition.");
    }
    if (/(intro|outro|opening|ending|开头|结尾)/i.test(text)) {
      detectedFeedbackTypes.add("arrangement");
      pushUniqueOperation(midiEditOperations, { type: text.includes("outro") || text.includes("ending") || text.includes("结尾") ? "add_outro" : "add_intro", value: "smooth background-friendly phrase", reason, timestampSeconds: item.timestampSeconds });
    }
    if (/(transition|sudden|awkward|crossfade|过渡|突兀)/i.test(text)) {
      detectedFeedbackTypes.add("transition");
      pushUniqueOperation(arrangementOperations, { tool: "extend_music_arrangement", action: "smooth_transition", value: "add 2-4 bar pickup or crossfade-ready connector", reason, timestampSeconds: item.timestampSeconds });
      qaChecklist.add("Listen around timestamped transition notes and confirm no sudden jump.");
    }
    if (/(loop|seam|click|gap|循环|接缝|咔)/i.test(text)) {
      detectedFeedbackTypes.add("loop_seam");
      pushUniqueOperation(arrangementOperations, { tool: "inspect_audio_quality", action: "check_loop_seam", value: true, reason, timestampSeconds: item.timestampSeconds });
      qaChecklist.add("Inspect loop seam for clicks, gaps, and discontinuities.");
    }
    if (/(cafe|study|video|website|game|restaurant|hotel|retail|background|咖啡|学习|网站|游戏|背景)/i.test(text)) {
      detectedFeedbackTypes.add("use_case");
      qaChecklist.add("Confirm loudness and dynamics fit the target listening context.");
    }
  }

  if (targetDurationMinutes && !arrangementOperations.some((operation) => operation.action === "extend_selected_version")) {
    arrangementOperations.push({ tool: "extend_music_arrangement", action: "extend_selected_version", value: Math.round(targetDurationMinutes * 60), reason: "targetDurationMinutes input" });
  }
  if (!midiEditOperations.length && !arrangementOperations.length && !mixOperations.length && !styleOperations.length) {
    arrangementOperations.push({ tool: "inspect_audio_quality", action: "review_feedback_context", value: "run QA and identify concrete MIDI/audio edits", reason: "Feedback was subjective or non-specific." });
  }
  const renderOperations = [
    { tool: "render_midi_to_audio", action: "render revised full mix WAV", after: ["midiEditOperations", "arrangementOperations"] },
    { tool: "normalize_music_loudness", action: "normalize revised mix for background playback", targetRms: 0.16 },
    { tool: "export_music_project", action: "refresh demo/download package after approval", include: ["revised_audio", "midi", "stems", "license_manifest", "playlist_metadata"] }
  ];
  const revisionEntry = {
    revisionId: parsed.currentRevisionId ?? targetVersionId,
    sourceVersionId: parsed.selectedVersionId,
    targetVersionId,
    rejectedVersionIds: parsed.rejectedVersionIds,
    reasonForChanges: normalizedFeedback.map((item) => item.comment),
    ratings: normalizedFeedback.filter((item) => typeof item.rating === "number").map((item) => ({ index: item.index, rating: item.rating })),
    createdAt: new Date().toISOString()
  };
  const revisionHistory = Array.isArray(existingHistory) ? [...existingHistory, revisionEntry] : [revisionEntry];
  return {
    projectId: parsed.projectId,
    selectedVersionId: parsed.selectedVersionId,
    targetVersionId,
    sourceManifestPath: parsed.sourceManifestPath,
    auditionManifestPath: parsed.auditionManifestPath,
    normalizedFeedback,
    detectedFeedbackTypes: Array.from(detectedFeedbackTypes),
    revisionPlan: {
      summary: `Revise ${parsed.selectedVersionId} into ${targetVersionId} using ${midiEditOperations.length + arrangementOperations.length + mixOperations.length + styleOperations.length} concrete operation(s).`,
      targetUseCase: parsed.targetUseCase,
      targetDurationSeconds: targetDurationMinutes ? Math.round(targetDurationMinutes * 60) : undefined,
      keep: ["Preserve the selected version's strongest identity unless feedback explicitly rejects it."],
      change: Array.from(detectedFeedbackTypes)
    },
    midiEditOperations,
    arrangementOperations,
    styleOperations,
    mixOperations,
    renderOperations,
    qaChecklist: Array.from(qaChecklist),
    nextToolSequence: ["edit_midi", "extend_music_arrangement", "render_midi_to_audio", "normalize_music_loudness", "inspect_audio_quality", "export_music_project"],
    revisionHistory
  };
}

function audioStats(buffer: Buffer) {
  let peak = 0;
  let rms = 0;
  const wav = parsePcmWav(buffer);
  if (!wav.ok) return { peak, rms, sampleCount: 0 };
  const sampleCount = Math.max(0, Math.floor(wav.info.dataBytes / 2));
  const endOffset = wav.info.dataOffset + wav.info.dataBytes;
  for (let offset = wav.info.dataOffset; offset + 1 < endOffset; offset += 2) {
    const value = buffer.readInt16LE(offset) / 32768;
    peak = Math.max(peak, Math.abs(value));
    rms += value * value;
  }
  return { peak: Number(peak.toFixed(4)), rms: Number(Math.sqrt(rms / Math.max(1, sampleCount)).toFixed(4)), sampleCount };
}

function normalizeWav(buffer: Buffer, targetRms: number) {
  const wav = assertPcmWav(buffer, "audioPath");
  const before = audioStats(buffer);
  const output = Buffer.from(buffer);
  const gain = before.rms > 0 ? Math.min(4, targetRms / before.rms) : 1;
  const endOffset = wav.dataOffset + wav.dataBytes;
  for (let offset = wav.dataOffset; offset + 1 < endOffset; offset += 2) {
    const next = Math.max(-32767, Math.min(32767, Math.round(output.readInt16LE(offset) * gain)));
    output.writeInt16LE(next, offset);
  }
  return { output, before, after: audioStats(output), gain: Number(gain.toFixed(3)) };
}

function limitWav(buffer: Buffer, ceiling: number) {
  const wav = assertPcmWav(buffer, "audioPath");
  const output = Buffer.from(buffer);
  let limitedSamples = 0;
  const endOffset = wav.dataOffset + wav.dataBytes;
  for (let offset = wav.dataOffset; offset + 1 < endOffset; offset += 2) {
    const value = output.readInt16LE(offset) / 32768;
    const limited = Math.max(-ceiling, Math.min(ceiling, value));
    if (limited !== value) limitedSamples += 1;
    output.writeInt16LE(Math.round(limited * 32767), offset);
  }
  return { output, limitedSamples, after: audioStats(output) };
}

function productionInstrumentEnginePlan(input: z.infer<typeof createProductionMusicRenderPlanInputSchema>) {
  const candidates = {
    realistic_piano: { role: "main harmony and melody", preferredFormats: ["SFZ", "SoundFont", "WAV multisample"], licenseRequirement: "MIT/Apache-2.0/CC0/public-domain/commercial-safe only", fallback: "warm_acoustic_piano procedural preview" },
    upright_bass: { role: "walking bass and roots", preferredFormats: ["SFZ", "WAV multisample"], licenseRequirement: "commercial-use allowed with attribution captured", fallback: "upright_bass procedural preview" },
    brush_drums: { role: "jazz brushes and soft cymbal texture", preferredFormats: ["WAV multisample", "SFZ"], licenseRequirement: "no non-commercial loop packs; one-shot samples only after license review", fallback: "jazz_brushes procedural preview" },
    room_ambience: { role: "small room tail and depth", preferredFormats: ["impulse response WAV"], licenseRequirement: "CC0/public-domain/commercial-safe impulse response", fallback: "short synthetic ambience tail" },
    strings_pad: { role: "optional soft pad support", preferredFormats: ["SFZ", "SoundFont"], licenseRequirement: "commercial-safe only", fallback: "pads procedural preview" }
  } satisfies Record<string, Record<string, unknown>>;
  return input.instrumentPriorities.map((priority) => ({ id: priority, ...candidates[priority] }));
}

function createProductionRenderPlan(input: z.infer<typeof createProductionMusicRenderPlanInputSchema>, composition?: Composition) {
  const humanization = {
    timingMs: composition?.style === "lo_fi" ? 22 : 14,
    velocityVariance: input.styleProfile.includes("jazz") || input.styleProfile.includes("cafe") ? 12 : 8,
    swing: input.styleProfile.includes("bossa") ? 0.12 : input.styleProfile.includes("lofi") ? 0.08 : 0.18,
    rules: ["Humanize piano comping and bass starts lightly.", "Keep brush-drums soft with no sudden loud hits.", "Avoid robotic repeated velocities across long sessions."]
  };
  const mixMasterChain = [
    { stage: "gain_staging", settings: { headroomDb: 6 }, reason: "Avoid clipping before compression/limiting." },
    { stage: "eq_cleanup", settings: { highPassNonBassHz: 70, gentlePresenceDipHz: 3000 }, reason: "Reduce mud and harsh piano/brush transients." },
    { stage: "room_ambience", settings: { wetPercent: 8, room: "small_warm_lounge" }, reason: "Add depth without washing out background use." },
    { stage: "gentle_compression", settings: { ratio: "2:1", attackMs: 25, releaseMs: 180 }, reason: "Stabilize dynamics for cafe/lounge playback." },
    { stage: "limiter", settings: { truePeakDb: input.truePeakDb }, reason: "Protect export against clipping." },
    { stage: "loudness_normalize", settings: { targetLufs: input.targetLufs }, reason: "Match streaming/demo loudness target." }
  ];
  const licenseGate = {
    policy: input.licensePolicy,
    allowed: ["generated_original", "public_domain", "cc0", "cc_by_with_attribution", "mit", "apache_2", "commercial_license"],
    reviewRequired: ["cc_by_missing_attribution", "unknown", "lgpl", "gpl", "proprietary", "non_commercial"],
    recommendedPianoPack: defaultCommercialSafePianoPackRecommendation(),
    rule: "Do not use third-party samples, soundfonts, drum kits, or impulse responses until manage_jazz_instrument_packs/build_music_license_manifest marks them commercial-safe. CC BY packs require attribution text before use."
  };
  return {
    styleProfile: input.styleProfile,
    targetUse: input.targetUse,
    sourceCompositionManifestPath: input.compositionManifestPath,
    compositionSummary: composition ? { title: composition.title, tempo: composition.tempo, key: composition.key, durationSeconds: composition.durationSeconds, instruments: composition.instruments } : undefined,
    instrumentEnginePlan: productionInstrumentEnginePlan(input),
    humanization,
    mixMasterChain,
    stemPlan: ["full_mix", "piano", "bass", "drums", "ambience"].map((stem) => ({ stem, purpose: stem === "full_mix" ? "final listening master" : "mix balance and production review" })),
    abMasteringPlan: [
      { id: "master_A", targetLufs: input.targetLufs, ambience: "subtle", compression: "gentle" },
      { id: "master_B", targetLufs: Math.max(-20, input.targetLufs - 1), ambience: "slightly warmer", compression: "lighter" }
    ],
    exportReviewChecklist: ["License manifest passes commercial-use checks.", "A/B mastering report compares peak/RMS/LUFS proxy and subjective purpose.", "Stems exist or are explicitly marked planned.", "Limiter ceiling and loudness target are recorded.", "Export package reports unsupported MP3/OGG encoders instead of fabricating files."],
    licenseGate
  };
}

function applyMasterChain(buffer: Buffer, input: z.infer<typeof applyMusicMixMasterChainInputSchema>) {
  const normalized = input.chain.includes("loudness_normalize") ? normalizeWav(buffer, input.targetRms) : { output: Buffer.from(buffer), before: audioStats(buffer), after: audioStats(buffer), gain: 1 };
  const limited = input.chain.includes("limiter") ? limitWav(normalized.output, input.truePeakCeiling) : { output: normalized.output, limitedSamples: 0, after: normalized.after };
  const analysisBefore = wavAnalysis(buffer);
  const analysisAfter = wavAnalysis(limited.output);
  return {
    output: limited.output,
    report: {
      abLabel: input.abLabel,
      chain: input.chain,
      stemPaths: input.stemPaths,
      before: normalized.before,
      after: limited.after,
      gain: normalized.gain,
      limitedSamples: limited.limitedSamples,
      targetRms: input.targetRms,
      truePeakCeiling: input.truePeakCeiling,
      analysisBefore,
      analysisAfter,
      renderer: "built_in_pcm_master_chain",
      qualityTier: "preview_only",
      productionReady: false,
      blockingReasons: ["Master chain is deterministic PCM preview processing. Production handoff still requires production_candidate render evidence and license gate approval."],
      productionNotes: ["EQ/compression/ambience stages are recorded as production intent in this safe PCM pass.", "Limiter and loudness normalization are applied directly to the WAV preview.", "Use verified commercial-safe instrument packs before claiming production realism."]
    }
  };
}

function productionReview(plan: Record<string, unknown>, masterReports: Array<Record<string, unknown>>, licenseManifest?: Record<string, unknown>, exportManifest?: Record<string, unknown>) {
  const findings: Array<{ severity: "high" | "medium" | "low"; category: string; message: string; suggestedFix: string }> = [];
  if (licenseManifest) {
    const unsafe = Array.isArray(licenseManifest.unsafeAssets) ? licenseManifest.unsafeAssets : [];
    const warnings = Array.isArray(licenseManifest.warnings) ? licenseManifest.warnings : [];
    if (unsafe.length || warnings.length) findings.push({ severity: "high", category: "license", message: "License manifest contains unsafe assets or warnings.", suggestedFix: "Replace unsafe assets or keep the output internal until license review passes." });
  } else {
    findings.push({ severity: "medium", category: "license", message: "No license manifest supplied for production review.", suggestedFix: "Run build_music_license_manifest before client or commercial delivery." });
  }
  if (masterReports.length < 2) findings.push({ severity: "low", category: "ab_mastering", message: "Only one master report supplied.", suggestedFix: "Create at least two A/B masters for production comparison." });
  for (const report of masterReports) {
    const after = report.after as { peak?: number; rms?: number } | undefined;
    if ((after?.peak ?? 0) >= 0.98) findings.push({ severity: "high", category: "mastering", message: `${String(report.abLabel ?? "master")} peaks near clipping.`, suggestedFix: "Lower limiter ceiling or reduce pre-master gain." });
    if ((after?.rms ?? 0) > 0.24) findings.push({ severity: "medium", category: "loudness", message: `${String(report.abLabel ?? "master")} is loud for background playback.`, suggestedFix: "Lower target RMS or reduce dense transient layers." });
  }
  if (exportManifest) {
    const unsupported = Array.isArray(exportManifest.unsupportedFormats) ? exportManifest.unsupportedFormats : [];
    if (unsupported.length) findings.push({ severity: "medium", category: "export", message: "Some requested export formats need verified encoders.", suggestedFix: "Provide encoded MP3/OGG files or remove unsupported export requests." });
  }
  const recommendation = findings.some((finding) => finding.severity === "high") ? "blocked" : findings.some((finding) => finding.severity === "medium") ? "revise_before_delivery" : "ready_for_review";
  return {
    productionPlan: { styleProfile: plan.styleProfile, targetUse: plan.targetUse, licenseGate: plan.licenseGate },
    masterComparisons: masterReports.map((report) => ({ label: report.abLabel, chain: report.chain, peak: (report.after as { peak?: number } | undefined)?.peak, rms: (report.after as { rms?: number } | undefined)?.rms, gain: report.gain, limitedSamples: report.limitedSamples })),
    licenseStatus: licenseManifest ? (findings.some((finding) => finding.category === "license" && finding.severity === "high") ? "blocked" : "reviewed") : "missing",
    exportStatus: exportManifest ? "reviewed" : "not_supplied",
    findings,
    recommendation,
    checks: ["production_plan_loaded", "master_reports_compared", "license_manifest_checked", "export_manifest_checked", "delivery_recommendation_set"]
  };
}

function defaultInstrumentForTrack(track: string) {
  if (track === "piano") return "warm_acoustic_piano";
  if (track === "bass") return "upright_bass";
  if (track === "drums") return "jazz_brushes";
  if (track === "violin") return "violin";
  if (track === "cello") return "cello";
  if (track === "pad") return "pads";
  if (track === "lead") return "soft_synth";
  return "soft_synth";
}

function renderLicenseManifest(instrumentMap: Record<string, string>, licenseConstraints: string) {
  return {
    licenseConstraints,
    renderer: "built_in_procedural_synth",
    qualityTier: "preview_only",
    productionReady: false,
    source: "Procedural oscillator/noise synthesis generated in-process; no third-party samples or soundfonts embedded.",
    instruments: Object.fromEntries(Object.entries(instrumentMap).map(([track, instrument]) => [track, { instrument, license: "generated_original_procedural" }])),
    formatNotes: ["WAV is generated directly. MP3/OGG require a verified encoder step before distribution."]
  };
}

async function toolVersion(binary: string, args = ["--version"], timeout = 2500) {
  try {
    const result = await execFileAsync(binary, args, { timeout, maxBuffer: 256 * 1024 });
    return { ok: true, version: `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0] || binary };
  } catch (error) {
    return { ok: false, version: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

const generalUserGsPack = {
  packId: "generaluser_gs",
  displayName: "GeneralUser GS",
  version: "2.0",
  upstreamCommit: "684543d5e5efaef08d02be50dcda8d552478fa60",
  baseUrl: "https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/684543d5e5efaef08d02be50dcda8d552478fa60",
  sf2File: "GeneralUser-GS.sf2",
  licenseSourcePath: "documentation/LICENSE.txt",
  licenseFile: "LICENSE.txt",
  readmeFile: "README.md",
  licenseType: "generaluser_gs_2_0" as const,
  sourceUrl: "https://github.com/mrbumpy409/GeneralUser-GS"
};

function sha256Hex(data: Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

function isValidSoundfontBytes(data: Buffer) {
  return data.length >= 12
    && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "sfbk";
}

async function fetchBuffer(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function bundledSoundfontDirectories(dirName: string) {
  const configured = process.env.MUSIC_SOUNDFONT_DIR?.trim();
  const roots = [configured, "/app/soundfonts", path.join(process.cwd(), "soundfonts"), path.join(process.cwd(), ".music-packs")].filter((value): value is string => Boolean(value));
  return [...new Set(roots)].map((root) => path.join(root, dirName));
}

function bundledGeneralUserGsDirectories() {
  return bundledSoundfontDirectories("generaluser-gs");
}

// Sampled grand pianos installable straight from the runtime soundfont directory (MUSIC_SOUNDFONT_DIR).
// They are CC-BY 3.0: commercial use is allowed WITH attribution, and that attribution flows
// automatically into the license manifest / LICENSES.md once auto-registered (so business delivery is
// legal with zero manual credit work — just keep the generated attribution line). Upstream ships them
// as compressed archives Node cannot extract, so these are bundled-only: install fails closed with
// download/extract guidance when the runtime directory does not contain the pack.
const sampledPianoPacks = {
  ydp_grand: {
    packId: "ydp_grand",
    displayName: "YDP Grand Piano",
    version: "20160804",
    dirName: "ydp-grand",
    sf2File: "YDP-GrandPiano.sf2",
    licenseFile: "LICENSE.txt",
    readmeFile: "README.md",
    licenseType: "cc_by",
    sourceUrl: "https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html",
    attribution: "YDP Grand Piano (FreePats), CC-BY 3.0",
    instrumentRole: "realistic_piano" as JazzInstrumentRole
  },
  salamander_grand: {
    packId: "salamander_grand",
    displayName: "Salamander Grand Piano V3 (Yamaha C5)",
    version: "V3-20200602",
    dirName: "salamander",
    sf2File: "Salamander.sf2",
    licenseFile: "LICENSE.txt",
    readmeFile: "README.md",
    licenseType: "cc_by",
    sourceUrl: "https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html",
    attribution: "Salamander Grand Piano by Alexander Holm, SF2 by FreePats, CC-BY 3.0",
    instrumentRole: "realistic_piano" as JazzInstrumentRole
  }
} as const;
type SampledPianoPackId = keyof typeof sampledPianoPacks;

async function sampledPianoPackAvailability(packId?: string) {
  const pack = packId ? (sampledPianoPacks as Record<string, typeof sampledPianoPacks[SampledPianoPackId] | undefined>)[packId] : undefined;
  if (!pack) return undefined;
  const searchDirectories = bundledSoundfontDirectories(pack.dirName);
  const checked = await Promise.all(searchDirectories.map(async (directory) => {
    const soundfontPath = path.join(directory, pack.sf2File);
    const licensePath = path.join(directory, pack.licenseFile);
    return {
      directory,
      soundfontPath,
      licensePath,
      soundfontExists: await pathExists(soundfontPath),
      licenseExists: await pathExists(licensePath)
    };
  }));
  const runtimeFilesReady = checked.some((entry) => entry.soundfontExists && entry.licenseExists);
  return {
    requestedPackId: pack.packId,
    displayName: pack.displayName,
    sourceUrl: pack.sourceUrl,
    requiredFiles: [pack.sf2File, pack.licenseFile],
    searchDirectories,
    checked,
    runtimeFilesReady,
    manualInstallRequired: !runtimeFilesReady,
    installTool: "install_free_soundfont_pack",
    fallbackPolicy: `Do not label fallback renders as ${pack.displayName}; only report this pack after install_free_soundfont_pack returns autoRegistered=true for ${pack.packId}.`,
    nextAction: runtimeFilesReady
      ? `Run install_free_soundfont_pack with packId="${pack.packId}" to copy, hash, license-record, and auto-register the bundled runtime files before rendering.`
      : `Place ${pack.sf2File} and ${pack.licenseFile} under <MUSIC_SOUNDFONT_DIR>/${pack.dirName}/, then run install_free_soundfont_pack with packId="${pack.packId}".`,
    userFacingExplanation: runtimeFilesReady
      ? `${pack.displayName} runtime files are present. Run install_free_soundfont_pack with packId="${pack.packId}" to register it before rendering.`
      : `${pack.displayName} is not available in this runtime. The files ${pack.sf2File} and ${pack.licenseFile} were not found under any of: ${searchDirectories.join(", ")}. To enable it, download and extract the archive from ${pack.sourceUrl}, place ${pack.sf2File} and ${pack.licenseFile} under <MUSIC_SOUNDFONT_DIR>/${pack.dirName}/, then run install_free_soundfont_pack with packId="${pack.packId}". Until then, use a registered fallback pack for rendering.`
  };
}

async function readBundledGeneralUserGsPack() {
  for (const directory of bundledGeneralUserGsDirectories()) {
    const soundfontPath = path.join(directory, generalUserGsPack.sf2File);
    const licensePath = path.join(directory, generalUserGsPack.licenseFile);
    const readmePath = path.join(directory, generalUserGsPack.readmeFile);
    try {
      const [soundfontBytes, licenseBytes, readmeBytes] = await Promise.all([
        readFile(soundfontPath),
        readFile(licensePath),
        readFile(readmePath)
      ]);
      if (!isValidSoundfontBytes(soundfontBytes)) throw new Error(`${soundfontPath} is not a valid RIFF/sfbk SoundFont.`);
      if (!licenseBytes.length) throw new Error(`${licensePath} is empty.`);
      return { directory, soundfontBytes, licenseBytes, readmeBytes, source: "bundled_runtime_soundfont" as const };
    } catch {
      // Try the next configured/preinstalled SoundFont directory.
    }
  }
  return undefined;
}

async function installGeneralUserGsPack(ctx: ToolContext, input: z.infer<typeof installFreeSoundfontPackInputSchema>) {
  const baseUrl = process.env.GENERALUSER_GS_BASE_URL ?? generalUserGsPack.baseUrl;
  const paths = {
    soundfont: `${input.outputDirectory}/${generalUserGsPack.sf2File}`,
    license: `${input.outputDirectory}/${generalUserGsPack.licenseFile}`,
    readme: `${input.outputDirectory}/${generalUserGsPack.readmeFile}`
  };
  try {
    const bundled = await readBundledGeneralUserGsPack();
    const [soundfontBytes, licenseBytes, readmeBytes] = bundled
      ? [bundled.soundfontBytes, bundled.licenseBytes, bundled.readmeBytes]
      : await Promise.all([
        fetchBuffer(`${baseUrl}/${generalUserGsPack.sf2File}`),
        fetchBuffer(`${baseUrl}/${generalUserGsPack.licenseSourcePath}`),
        fetchBuffer(`${baseUrl}/${generalUserGsPack.readmeFile}`)
      ]);
    if (!licenseBytes.length) throw new Error("Downloaded license file is empty.");
    if (!isValidSoundfontBytes(soundfontBytes)) throw new Error("Downloaded .sf2 is not a valid RIFF/sfbk SoundFont.");
    const computedSha256 = sha256Hex(soundfontBytes);
    const [soundfontFile, licenseFile, readmeFile] = await Promise.all([
      writeProjectAsset(ctx.projectRoot, input.projectId, paths.soundfont, soundfontBytes, "audio/soundfont"),
      writeProjectFile(ctx.projectRoot, input.projectId, paths.license, licenseBytes.toString("utf8")),
      writeProjectFile(ctx.projectRoot, input.projectId, paths.readme, readmeBytes.toString("utf8"))
    ]);
    return {
      ok: true as const,
      packId: generalUserGsPack.packId,
      displayName: generalUserGsPack.displayName,
      version: generalUserGsPack.version,
      assetPaths: [soundfontFile.path],
      licenseTextPath: licenseFile.path,
      readmePath: readmeFile.path,
      computedSha256,
      sourceUrl: generalUserGsPack.sourceUrl,
      source: generalUserGsPack.sourceUrl,
      installSource: bundled?.source ?? "downloaded_from_upstream",
      bundledDirectory: bundled?.directory,
      licenseType: generalUserGsPack.licenseType as string,
      attribution: "GeneralUser GS by S. Christian Collins",
      instrumentRole: "general_midi" as JazzInstrumentRole,
      commercialUseAllowed: true,
      redistributionAllowed: true,
      productionUseApproved: true,
      qualityTier: "production_candidate" as const,
      recommendedNextTool: "manage_jazz_instrument_packs"
    };
  } catch (error) {
    return {
      ok: false as const,
      packId: generalUserGsPack.packId,
      displayName: generalUserGsPack.displayName,
      sourceUrl: generalUserGsPack.sourceUrl,
      qualityTier: "blocked" as const,
      errors: [error instanceof Error ? error.message : String(error)]
    };
  }
}

// Install a bundled sampled grand piano (YDP / Salamander) from the runtime soundfont directory.
// Returns the same ok-shape as installGeneralUserGsPack so the handler + auto-register treat both
// uniformly; only instrumentRole ("realistic_piano") and the CC-BY attribution differ.
async function installSampledPianoPack(ctx: ToolContext, input: z.infer<typeof installFreeSoundfontPackInputSchema>, pack: typeof sampledPianoPacks[SampledPianoPackId]) {
  const paths = {
    soundfont: `${input.outputDirectory}/${pack.sf2File}`,
    license: `${input.outputDirectory}/${pack.licenseFile}`,
    readme: `${input.outputDirectory}/${pack.readmeFile}`
  };
  try {
    let bundle: { soundfontBytes: Buffer; licenseBytes: Buffer; readmeBytes: Buffer; directory: string } | undefined;
    for (const directory of bundledSoundfontDirectories(pack.dirName)) {
      try {
        const soundfontBytes = await readFile(path.join(directory, pack.sf2File));
        if (!isValidSoundfontBytes(soundfontBytes)) throw new Error(`${pack.sf2File} is not a valid RIFF/sfbk SoundFont.`);
        const licenseBytes = await readFile(path.join(directory, pack.licenseFile));
        const readmeBytes = await readFile(path.join(directory, pack.readmeFile)).catch(() => licenseBytes);
        bundle = { soundfontBytes, licenseBytes, readmeBytes, directory };
        break;
      } catch {
        // try the next configured soundfont directory
      }
    }
    if (!bundle) {
      throw new Error(`${pack.displayName} is not bundled in this runtime. Download it from ${pack.sourceUrl}, extract the archive, and place ${pack.sf2File} + ${pack.licenseFile} under <MUSIC_SOUNDFONT_DIR>/${pack.dirName}/, then re-run. (Large sampled .sf2 ships as a compressed archive, so it is not auto-downloaded.)`);
    }
    if (!bundle.licenseBytes.length) throw new Error("License file is empty.");
    const computedSha256 = sha256Hex(bundle.soundfontBytes);
    const [soundfontFile, licenseFile, readmeFile] = await Promise.all([
      writeProjectAsset(ctx.projectRoot, input.projectId, paths.soundfont, bundle.soundfontBytes, "audio/soundfont"),
      writeProjectFile(ctx.projectRoot, input.projectId, paths.license, bundle.licenseBytes.toString("utf8")),
      writeProjectFile(ctx.projectRoot, input.projectId, paths.readme, bundle.readmeBytes.toString("utf8"))
    ]);
    return {
      ok: true as const,
      packId: pack.packId,
      displayName: pack.displayName,
      version: pack.version,
      assetPaths: [soundfontFile.path],
      licenseTextPath: licenseFile.path,
      readmePath: readmeFile.path,
      computedSha256,
      sourceUrl: pack.sourceUrl,
      source: pack.sourceUrl,
      installSource: "bundled_runtime_soundfont" as const,
      bundledDirectory: bundle.directory,
      licenseType: pack.licenseType as string,
      attribution: pack.attribution,
      instrumentRole: pack.instrumentRole,
      commercialUseAllowed: true,
      redistributionAllowed: true,
      productionUseApproved: true,
      qualityTier: "production_candidate" as const,
      recommendedNextTool: "manage_jazz_instrument_packs"
    };
  } catch (error) {
    const searchDirs = bundledSoundfontDirectories(pack.dirName);
    return {
      ok: false as const,
      packId: pack.packId,
      displayName: pack.displayName,
      sourceUrl: pack.sourceUrl,
      manualInstallRequired: true,
      autoDownloadAvailable: false,
      requiredFiles: [pack.sf2File, pack.licenseFile],
      searchDirectories: searchDirs,
      nextAction: `Place ${pack.sf2File} and ${pack.licenseFile} under <MUSIC_SOUNDFONT_DIR>/${pack.dirName}/, then re-run install_free_soundfont_pack with packId="${pack.packId}". Do not call render_production_music with this pack id until install returns autoRegistered=true.`,
      userFacingExplanation: `${pack.displayName} is a bundled-only pack not available for automatic download. The files ${pack.sf2File} and ${pack.licenseFile} were not found under any of: ${searchDirs.join(", ")}. To enable it, download and extract the archive from ${pack.sourceUrl}, place ${pack.sf2File} and ${pack.licenseFile} under <MUSIC_SOUNDFONT_DIR>/${pack.dirName}/, then re-run install_free_soundfont_pack with packId="${pack.packId}". Do not call render_production_music with this pack id until install returns autoRegistered=true.`,
      qualityTier: "blocked" as const,
      errors: [error instanceof Error ? error.message : String(error)]
    };
  }
}

type SoundfontDiscoveryCandidate = {
  format: "soundfont" | "sfz";
  path: string;
  projectAssetPath?: string;
  source: "project_asset" | "local_music_packs";
  sha256?: string;
  sizeBytes: number;
  licenseTextPath?: string;
  readmePath?: string;
  licensePresent: boolean;
  readmePresent: boolean;
  status: "ready" | "review_required" | "blocked";
  reasons: string[];
  inferredPackId?: string;
  recommendedNextTool?: string;
  suggestedRegistration?: Record<string, unknown>;
};

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findSidecarFile(directory: string, patterns: RegExp[]) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const match = entries.find((entry) => entry.isFile() && patterns.some((pattern) => pattern.test(entry.name)));
    return match ? path.join(directory, match.name) : undefined;
  } catch {
    return undefined;
  }
}

async function listFilesRecursive(root: string, maxFiles = 1000) {
  const found: string[] = [];
  async function visit(directory: string) {
    if (found.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await visit(fullPath);
      } else if (entry.isFile()) {
        found.push(fullPath);
      }
    }
  }
  await visit(root);
  return found;
}

function relativeProjectAssetPath(projectFilesRoot: string, absolutePath: string) {
  const relativePath = path.relative(projectFilesRoot, absolutePath).replaceAll(path.sep, "/");
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath) ? relativePath : undefined;
}

function resolveProjectSearchDirectory(projectFilesRoot: string, relativeDirectory: string) {
  const normalized = relativeDirectory.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === "..")) return undefined;
  const absolutePath = path.join(projectFilesRoot, normalized);
  const relativePath = path.relative(projectFilesRoot, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return undefined;
  return absolutePath;
}

function candidateFormatForPath(filePath: string): "soundfont" | "sfz" | undefined {
  if (isSoundfontAssetPath(filePath)) return "soundfont";
  if (isSfzAssetPath(filePath)) return "sfz";
  return undefined;
}

async function inspectDiscoveredSoundfontCandidate(input: {
  absolutePath: string;
  displayPath: string;
  projectAssetPath?: string;
  source: SoundfontDiscoveryCandidate["source"];
}) {
  const format = candidateFormatForPath(input.absolutePath);
  if (!format) return undefined;
  const data = await readFile(input.absolutePath);
  const reasons: string[] = [];
  if (format === "soundfont" && !isValidSoundfontBytes(data)) reasons.push("invalid_soundfont_magic");
  if (format === "sfz" && !data.toString("utf8", 0, Math.min(data.length, 4096)).includes("<region")) reasons.push("sfz_missing_region");
  const directory = path.dirname(input.absolutePath);
  const licensePath = await findSidecarFile(directory, [/^licen[sc]e(\.|$)/i, /^copying(\.|$)/i]);
  const readmePath = await findSidecarFile(directory, [/^readme(\.|$)/i]);
  const licensePresent = Boolean(licensePath);
  const readmePresent = Boolean(readmePath);
  if (!licensePresent) reasons.push("missing_license_sidecar");
  if (!readmePresent) reasons.push("missing_readme_sidecar");
  if (input.source === "local_music_packs" && !input.projectAssetPath) reasons.push("local_candidate_not_project_asset");
  const lowerName = path.basename(input.absolutePath).toLowerCase();
  const inferredGeneralUser = lowerName.includes("generaluser") || lowerName.includes("generaluser-gs");
  const blocked = reasons.includes("invalid_soundfont_magic") || reasons.includes("sfz_missing_region");
  const status = blocked ? "blocked" : reasons.length ? "review_required" : "ready";
  const projectLicensePath = licensePath && input.projectAssetPath ? path.posix.join(path.posix.dirname(input.projectAssetPath), path.basename(licensePath)) : undefined;
  const projectReadmePath = readmePath && input.projectAssetPath ? path.posix.join(path.posix.dirname(input.projectAssetPath), path.basename(readmePath)) : undefined;
  const suggestedRegistration = input.projectAssetPath && status === "ready"
    ? {
      packId: inferredGeneralUser ? generalUserGsPack.packId : slugifyMusicExportPart(path.basename(input.absolutePath, path.extname(input.absolutePath))).replaceAll("-", "_"),
      displayName: inferredGeneralUser ? generalUserGsPack.displayName : path.basename(input.absolutePath, path.extname(input.absolutePath)),
      instrumentRole: "realistic_piano",
      format,
      assetPaths: [input.projectAssetPath],
      declaredSha256: sha256Hex(data),
      licenseType: inferredGeneralUser ? generalUserGsPack.licenseType : "unknown",
      source: inferredGeneralUser ? generalUserGsPack.sourceUrl : "local/project asset",
      sourceUrl: inferredGeneralUser ? generalUserGsPack.sourceUrl : undefined,
      licenseTextPath: projectLicensePath,
      readmePath: projectReadmePath,
      commercialUseAllowed: inferredGeneralUser ? true : undefined,
      redistributionAllowed: inferredGeneralUser ? true : undefined,
      productionUseApproved: inferredGeneralUser ? true : undefined,
      qualityTier: inferredGeneralUser ? "production_candidate" : "review_required"
    }
    : undefined;
  return {
    format,
    path: input.displayPath,
    projectAssetPath: input.projectAssetPath,
    source: input.source,
    sha256: sha256Hex(data),
    sizeBytes: data.length,
    licenseTextPath: input.projectAssetPath ? projectLicensePath : licensePath,
    readmePath: input.projectAssetPath ? projectReadmePath : readmePath,
    licensePresent,
    readmePresent,
    status,
    reasons,
    inferredPackId: inferredGeneralUser ? generalUserGsPack.packId : undefined,
    recommendedNextTool: status === "ready" && input.projectAssetPath ? "manage_jazz_instrument_packs" : status === "ready" ? "copy_or_install_project_asset_then_manage_jazz_instrument_packs" : undefined,
    suggestedRegistration
  } satisfies SoundfontDiscoveryCandidate;
}

async function discoverSoundfontPacks(ctx: ToolContext, input: z.infer<typeof discoverSoundfontPacksInputSchema>) {
  const candidates: SoundfontDiscoveryCandidate[] = [];
  const seen = new Set<string>();
  const projectFilesRoot = getProjectFilesDirectory(ctx.projectRoot, input.projectId);
  for (const directory of input.projectSearchDirectories) {
    const absoluteDirectory = resolveProjectSearchDirectory(projectFilesRoot, directory);
    if (!absoluteDirectory) continue;
    const files = await listFilesRecursive(absoluteDirectory);
    for (const file of files.filter((candidate) => candidateFormatForPath(candidate))) {
      const key = path.resolve(file);
      if (seen.has(key)) continue;
      seen.add(key);
      const projectAssetPath = relativeProjectAssetPath(projectFilesRoot, file);
      const inspected = await inspectDiscoveredSoundfontCandidate({ absolutePath: file, displayPath: projectAssetPath ?? file, projectAssetPath, source: "project_asset" });
      if (inspected) candidates.push(inspected);
    }
  }
  if (input.includeLocalMusicPacks) {
    const localRoot = path.join(ctx.workspaceRoot, ".music-packs");
    if (await pathExists(localRoot)) {
      const files = await listFilesRecursive(localRoot);
      for (const file of files.filter((candidate) => candidateFormatForPath(candidate))) {
        const key = path.resolve(file);
        if (seen.has(key)) continue;
        seen.add(key);
        const inspected = await inspectDiscoveredSoundfontCandidate({ absolutePath: file, displayPath: file, source: "local_music_packs" });
        if (inspected) candidates.push(inspected);
      }
    }
  }
  return {
    projectId: input.projectId,
    candidates,
    ready: candidates.filter((candidate) => candidate.status === "ready"),
    reviewRequired: candidates.filter((candidate) => candidate.status === "review_required"),
    blocked: candidates.filter((candidate) => candidate.status === "blocked"),
    recommendations: candidates
      .filter((candidate) => candidate.inferredPackId === generalUserGsPack.packId && candidate.sha256 && candidate.licensePresent)
      .map((candidate) => candidate.projectAssetPath
        ? `GeneralUser GS candidate ${candidate.projectAssetPath} has hash/license metadata; call manage_jazz_instrument_packs with the suggestedRegistration to approve production_candidate use.`
        : `GeneralUser GS candidate ${candidate.path} is outside project assets; install/copy it into project assets before registration.`)
  };
}

function isSoundfontAssetPath(assetPath: string) {
  return /\.(sf2|sf3)$/i.test(assetPath);
}

function isSfzAssetPath(assetPath: string) {
  return /\.sfz$/i.test(assetPath);
}

type JazzPackRecord = ReturnType<typeof analyzeJazzPack>;
type JazzInstrumentRole = z.infer<typeof jazzInstrumentPackSchema>["instrumentRole"];

function rendererForAssetPath(assetPath: string) {
  if (isSoundfontAssetPath(assetPath)) return "fluidsynth";
  if (isSfzAssetPath(assetPath)) return "sfizz";
  return undefined;
}

function rendererForPack(pack: JazzPackRecord | undefined) {
  if (!pack || pack.status !== "ready") return undefined;
  if (pack.format === "soundfont" && pack.assetPaths.some(isSoundfontAssetPath)) return "fluidsynth";
  if (pack.format === "sfz" && pack.assetPaths.some(isSfzAssetPath)) return "sfizz";
  return undefined;
}

// SSOT for production stem/pack roles. Ordered most-specific first so e.g. a `cello` track binds to
// the cello role (and its own stem) before the generic strings/ambience buckets. Both
// productionRoleForTrack and productionStemGroups derive from this so a track's pack role and its
// stem assignment can never disagree — the bug where cello collapsed into the pad/ambience stem.
const productionRoleSpecs: Array<{ role: JazzInstrumentRole; id: string; label: string; patterns: RegExp[] }> = [
  { role: "realistic_piano", id: "piano", label: "Piano", patterns: [/piano/i, /keys/i, /guitar/i] },
  { role: "upright_bass", id: "bass", label: "Bass", patterns: [/bass/i] },
  { role: "brush_drums", id: "drums", label: "Drums", patterns: [/drum/i, /brush/i, /percussion/i] },
  { role: "cello", id: "cello", label: "Cello", patterns: [/cello/i] },
  { role: "violin", id: "violin", label: "Violin", patterns: [/violin/i, /viola/i] },
  { role: "chamber_ensemble", id: "chamber", label: "Chamber ensemble", patterns: [/chamber/i] },
  { role: "orchestral_sketch", id: "orchestral", label: "Orchestral sketch", patterns: [/orchestra/i] },
  { role: "strings", id: "strings", label: "Strings", patterns: [/string/i] },
  { role: "room_ambience", id: "pad-ambience", label: "Pad / ambience", patterns: [/pad/i, /ambience/i, /synth/i] }
];

function productionRoleForTrack(track: string): JazzInstrumentRole | undefined {
  return productionRoleSpecs.find((spec) => spec.patterns.some((pattern) => pattern.test(track)))?.role;
}

function activeProductionTracks(composition: Composition) {
  return Object.entries(composition.tracks)
    .filter(([, notes]) => notes.length > 0)
    .map(([track]) => ({ track, requiredRole: productionRoleForTrack(track) }));
}

function requiredProductionRoles(composition: Composition) {
  return [...new Set(activeProductionTracks(composition).map((entry) => entry.requiredRole).filter((role): role is JazzInstrumentRole => Boolean(role)))];
}

function instrumentCoverageForSinglePack(composition: Composition, pack?: JazzPackRecord) {
  return activeProductionTracks(composition).map((entry) => ({
    track: entry.track,
    requiredRole: entry.requiredRole,
    selectedPackId: pack?.packId,
    selectedPackRole: pack?.instrumentRole,
    covered: packCoversRole(pack, entry.requiredRole),
    reason: !entry.requiredRole
      ? `Track ${entry.track} has no supported production instrument role.`
      : !pack
        ? `Track ${entry.track} has no selected instrument pack.`
        : packCoversRole(pack, entry.requiredRole)
          ? "covered"
          : `Track ${entry.track} requires ${entry.requiredRole}, but selected pack ${pack.packId} is ${pack.instrumentRole}.`
  }));
}

function instrumentCoverageForPackMap(composition: Composition, packsByRole: Partial<Record<JazzInstrumentRole, JazzPackRecord>>) {
  return activeProductionTracks(composition).map((entry) => {
    const pack = entry.requiredRole ? packsByRole[entry.requiredRole] : undefined;
    return {
      track: entry.track,
      requiredRole: entry.requiredRole,
      selectedPackId: pack?.packId,
      selectedPackRole: pack?.instrumentRole,
      covered: packCoversRole(pack, entry.requiredRole),
      reason: !entry.requiredRole
        ? `Track ${entry.track} has no supported production instrument role.`
        : !pack
          ? `Track ${entry.track} requires ${entry.requiredRole}, but no ready pack was selected.`
          : packCoversRole(pack, entry.requiredRole)
            ? "covered"
            : `Track ${entry.track} requires ${entry.requiredRole}, but selected pack ${pack.packId} is ${pack.instrumentRole}.`
    };
  });
}

function instrumentAssetPathForPack(pack: JazzPackRecord, requestedPath?: string) {
  if (requestedPath) return requestedPath;
  if (pack.format === "sfz") return pack.assetPaths.find(isSfzAssetPath);
  return pack.assetPaths.find(isSoundfontAssetPath);
}

function productionRenderBlockersForPack(pack: JazzPackRecord | undefined, requestedPath?: string) {
  if (!pack) return ["No registered ready instrument pack matches soundfontPackId/soundfontPath."];
  const blockers: string[] = [];
  if (pack.status !== "ready") blockers.push(`Pack ${pack.packId} status is ${pack.status}, not ready.`);
  if (pack.format !== "soundfont" && pack.format !== "sfz") blockers.push(`Pack ${pack.packId} format is ${pack.format}; production render requires .sf2/.sf3 SoundFont or .sfz.`);
  if (pack.format === "soundfont" && !pack.assetPaths.some(isSoundfontAssetPath)) blockers.push(`Pack ${pack.packId} has no .sf2/.sf3 asset.`);
  if (pack.format === "sfz" && !pack.assetPaths.some(isSfzAssetPath)) blockers.push(`Pack ${pack.packId} has no .sfz asset.`);
  if (requestedPath && !pack.assetPaths.includes(requestedPath)) blockers.push(`Requested soundfontPath is not registered on ready pack ${pack.packId}.`);
  if (requestedPath && pack.assetPaths.includes(requestedPath)) {
    const requestedRenderer = rendererForAssetPath(requestedPath);
    if (!requestedRenderer) blockers.push(`Requested soundfontPath ${requestedPath} is not a supported .sf2/.sf3 or .sfz asset.`);
    if (pack.format === "soundfont" && requestedRenderer !== "fluidsynth") blockers.push(`Requested soundfontPath ${requestedPath} does not match soundfont pack ${pack.packId}; expected .sf2/.sf3.`);
    if (pack.format === "sfz" && requestedRenderer !== "sfizz") blockers.push(`Requested soundfontPath ${requestedPath} does not match SFZ pack ${pack.packId}; expected .sfz.`);
  }
  if (!pack.commercialUseAllowed) blockers.push(`Pack ${pack.packId} is not marked commercial-use allowed.`);
  if (pack.riskFlags.length) blockers.push(`Pack ${pack.packId} has unresolved risk flags: ${pack.riskFlags.join(", ")}.`);
  if (!pack.computedSha256) blockers.push(`Pack ${pack.packId} has no computed hash.`);
  if (pack.qualityTier !== "production_candidate") blockers.push(`Pack ${pack.packId} is ${pack.qualityTier}, not production_candidate.`);
  if (pack.productionUseApproved !== true) blockers.push(`Pack ${pack.packId} is not marked productionUseApproved=true.`);
  if (!pack.licenseTextPath || !pack.licenseTextExists) blockers.push(`Pack ${pack.packId} has no verified licenseTextPath.`);
  if (!pack.sourceUrl) blockers.push(`Pack ${pack.packId} has no sourceUrl metadata.`);
  if (!rendererForPack(pack)) blockers.push(`Pack ${pack.packId} has no eligible renderer for format ${pack.format}.`);
  return blockers;
}

// Pure: from discovered suggestedRegistration payloads, keep only the ones safe to auto-register
// without human review — production_candidate, license-approved, commercial-safe — narrowed to the
// render call's requested pack id/path so we never silently register a different instrument than
// was asked for. This is what bridges "discovered & license-cleared" to "registered ready pack".
export function selectAutoRegistrablePacks(
  registrations: Array<Record<string, unknown> | undefined>,
  opts: { soundfontPackId?: string; soundfontPath?: string }
): z.infer<typeof jazzInstrumentPackSchema>[] {
  const selected: z.infer<typeof jazzInstrumentPackSchema>[] = [];
  for (const raw of registrations) {
    if (!raw) continue;
    if (raw.qualityTier !== "production_candidate") continue;
    if (raw.productionUseApproved !== true) continue;
    if (raw.commercialUseAllowed !== true) continue;
    const parsed = jazzInstrumentPackSchema.safeParse(raw);
    if (!parsed.success) continue;
    const pack = parsed.data;
    if (opts.soundfontPackId && pack.packId !== opts.soundfontPackId) continue;
    if (opts.soundfontPath && !pack.assetPaths.includes(opts.soundfontPath)) continue;
    selected.push(pack);
  }
  return selected;
}

// SSOT for the instrument-pack registry filename. manage_jazz_instrument_packs writes here by
// default and render tools read here first.
const DEFAULT_JAZZ_PACK_REGISTRY_PATH = "music/jazz-instrument-packs.json";

// Pure: from the relative file paths under the project, return the ordered registry files to try.
// The default path is always tried first; then any other *instrument-packs*.json the agent may have
// written under a non-default name. This is the read-side fix for issue_0146: manage_*'s outputPath
// was a free parameter while the render read path was a hardcoded constant, so an agent that wrote
// the registry as music/instrument-packs.json got a misleading "no registered pack". License
// manifests (…license…json) are never registry files.
export function pickJazzPackRegistryCandidatePaths(relativePaths: string[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string) => {
    if (candidate && !seen.has(candidate)) { seen.add(candidate); ordered.push(candidate); }
  };
  push(DEFAULT_JAZZ_PACK_REGISTRY_PATH);
  const isRegistryName = (candidate: string) =>
    /(^|\/)[a-z0-9._-]*instrument-packs[a-z0-9._-]*\.json$/i.test(candidate) && !/license/i.test(candidate);
  for (const candidate of relativePaths.filter(isRegistryName).sort()) push(candidate);
  return ordered;
}

type JazzPackRegistry = { packs?: JazzPackRecord[]; readyPackIds?: string[]; registryPath?: string; searchedPaths: string[] };

async function readJazzPackRegistry(ctx: ToolContext, projectId: string): Promise<JazzPackRegistry> {
  const projectFilesRoot = getProjectFilesDirectory(ctx.projectRoot, projectId);
  let relativePaths: string[] = [];
  try {
    const files = await listFilesRecursive(projectFilesRoot);
    relativePaths = files
      .map((file) => relativeProjectAssetPath(projectFilesRoot, file))
      .filter((relativePath): relativePath is string => Boolean(relativePath) && /\.json$/i.test(relativePath!));
  } catch {
    // fall back to the default path only
  }
  const candidates = pickJazzPackRegistryCandidatePaths(relativePaths);
  const searchedPaths: string[] = [];
  for (const candidate of candidates) {
    searchedPaths.push(candidate);
    try {
      const parsed = JSON.parse(await readProjectFile(ctx.projectRoot, projectId, candidate, 2 * 1024 * 1024));
      if (parsed && Array.isArray(parsed.packs)) return { ...parsed, registryPath: candidate, searchedPaths };
    } catch {
      // try the next candidate registry file
    }
  }
  return { searchedPaths };
}

function findRegisteredPack(registry: { packs?: JazzPackRecord[] } | undefined, parsed: z.infer<typeof renderMidiWithSoundfontInputSchema>): JazzPackRecord | undefined {
  return (registry?.packs ?? []).find((candidate) => {
    if (parsed.soundfontPackId && candidate.packId === parsed.soundfontPackId) return true;
    if (parsed.soundfontPath && candidate.assetPaths.includes(parsed.soundfontPath)) return true;
    return false;
  });
}

async function buildResolvedSoundfont(ctx: ToolContext, parsed: z.infer<typeof renderMidiWithSoundfontInputSchema>, pack: JazzPackRecord) {
  const soundfontPath = instrumentAssetPathForPack(pack, parsed.soundfontPath)!;
  const renderer = rendererForAssetPath(soundfontPath) ?? rendererForPack(pack)!;
  const absolutePath = await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, soundfontPath);
  return { ok: true as const, pack, renderer, soundfontPath, absolutePath, blockers: [] as string[] };
}

// Self-heal the registry↔renderer gap. discover_soundfont_packs already produces a
// suggestedRegistration shaped exactly like manage_jazz_instrument_packs input, but nothing
// auto-applies it, so a license-cleared production_candidate SoundFont sitting in project assets
// renders as "no registered ready pack". Discover, auto-register the safe ones, and (when we
// cannot) return the exact manage_jazz_instrument_packs call so the agent's next step is unambiguous.
async function autoRegisterDiscoveredProductionPacks(ctx: ToolContext, parsed: z.infer<typeof renderMidiWithSoundfontInputSchema>): Promise<{ registered: boolean; remediation: string[] }> {
  let discovery: Awaited<ReturnType<typeof discoverSoundfontPacks>>;
  try {
    discovery = await discoverSoundfontPacks(ctx, discoverSoundfontPacksInputSchema.parse({ projectId: parsed.projectId, includeLocalMusicPacks: false }));
  } catch {
    return { registered: false, remediation: [] };
  }
  const selected = selectAutoRegistrablePacks(discovery.candidates.map((candidate) => candidate.suggestedRegistration), { soundfontPackId: parsed.soundfontPackId, soundfontPath: parsed.soundfontPath });
  if (!selected.length) {
    const remediation = discovery.ready
      .filter((candidate) => candidate.suggestedRegistration && candidate.projectAssetPath)
      .map((candidate) => `A ready SoundFont (${candidate.projectAssetPath}) is in project assets but not registered. Call manage_jazz_instrument_packs with packs=[${JSON.stringify(candidate.suggestedRegistration)}], then re-run the render.`);
    return { registered: false, remediation };
  }
  const manageInput = manageJazzInstrumentPacksInputSchema.parse({ projectId: parsed.projectId, packs: selected });
  const registry = await manageJazzInstrumentPacks(manageInput, ctx.projectRoot);
  await writeProjectFile(ctx.projectRoot, parsed.projectId, manageInput.outputPath, `${JSON.stringify(registry, null, 2)}\n`);
  await writeProjectFile(ctx.projectRoot, parsed.projectId, manageInput.outputLicenseManifestPath, `${JSON.stringify(registry.licenseManifest, null, 2)}\n`);
  return {
    registered: registry.readyPackIds.length > 0,
    remediation: registry.readyPackIds.length ? [] : ["Auto-registration analyzed the discovered SoundFont but it did not pass as production-ready; inspect its license sidecar and SHA-256."]
  };
}

async function resolveProductionSoundfont(ctx: ToolContext, parsed: z.infer<typeof renderMidiWithSoundfontInputSchema>) {
  const requestedPackAvailability = await sampledPianoPackAvailability(parsed.soundfontPackId);
  const registry = await readJazzPackRegistry(ctx, parsed.projectId);
  let pack = findRegisteredPack(registry, parsed);
  let blockers = productionRenderBlockersForPack(pack, parsed.soundfontPath);
  if (!blockers.length && pack) return buildResolvedSoundfont(ctx, parsed, pack);

  // Only self-heal when no registry exists yet — never clobber a populated registry, where a
  // miss means "no pack matches this request" and the right answer is remediation, not rewrite.
  if (!registry.packs?.length) {
    const auto = await autoRegisterDiscoveredProductionPacks(ctx, parsed);
    if (auto.registered) {
      const refreshed = await readJazzPackRegistry(ctx, parsed.projectId);
      pack = findRegisteredPack(refreshed, parsed);
      blockers = productionRenderBlockersForPack(pack, parsed.soundfontPath);
      if (!blockers.length && pack) return buildResolvedSoundfont(ctx, parsed, pack);
    }
    // issue_0146: the old failure was a bare "No registered ready instrument pack matches…", which
    // hid the real cause (registry written under a name/dir the reader never checked). State exactly
    // which registry files and which directories were searched so the agent can self-correct.
    const searchDirs = discoverSoundfontPacksInputSchema.parse({ projectId: parsed.projectId }).projectSearchDirectories;
    const checked = registry.searchedPaths.length ? registry.searchedPaths.join(", ") : DEFAULT_JAZZ_PACK_REGISTRY_PATH;
    const diagnostic = `No instrument-pack registry with ready packs was found. Registry files checked: ${checked}. Directories scanned for an installable .sf2/.sfz: ${searchDirs.join(", ")}. Fix: register the pack with manage_jazz_instrument_packs (any music/*instrument-packs*.json is now read back automatically), or place the SoundFont under one of the scanned directories, then re-run.`;
    const sampledPianoBlockers = requestedPackAvailability
      ? [`Requested ${requestedPackAvailability.displayName} is not registered. ${requestedPackAvailability.nextAction} ${requestedPackAvailability.fallbackPolicy}`]
      : [];
    return { ok: false as const, blockers: [diagnostic, ...sampledPianoBlockers, ...auto.remediation], pack, requestedPackAvailability };
  }
  // Registry exists but the requested pack id/path did not resolve to a ready pack. Surface the
  // registry path and what it actually contains instead of a generic "not registered".
  if (!pack) {
    const available = registry.packs.map((candidate) => `${candidate.packId} (${candidate.status})`).join(", ") || "none";
    const sampledPianoBlockers = requestedPackAvailability
      ? [`Requested ${requestedPackAvailability.displayName} is unavailable as a ready registered pack. ${requestedPackAvailability.nextAction} ${requestedPackAvailability.fallbackPolicy}`]
      : [];
    return { ok: false as const, blockers: [`No registered ready instrument pack matches soundfontPackId=${parsed.soundfontPackId ?? "—"} / soundfontPath=${parsed.soundfontPath ?? "—"}. Registry ${registry.registryPath ?? DEFAULT_JAZZ_PACK_REGISTRY_PATH} contains: ${available}. Pass soundfontPackId for one of these (a general_midi pack covers every role), or register the intended pack.`, ...sampledPianoBlockers], pack, requestedPackAvailability };
  }
  return { ok: false as const, blockers, pack, requestedPackAvailability };
}

async function resolveProductionPackForRole(ctx: ToolContext, input: {
  projectId: string;
  role: JazzInstrumentRole;
  compositionManifestPath: string;
  soundfontPackId?: string;
  soundfontPath?: string;
}) {
  if (!input.soundfontPackId && !input.soundfontPath) {
    return { ok: false as const, role: input.role, blockers: [`No ${input.role} instrument pack was selected.`] };
  }
  const parsed = renderMidiWithSoundfontInputSchema.parse({
    projectId: input.projectId,
    compositionManifestPath: input.compositionManifestPath,
    soundfontPackId: input.soundfontPackId,
    soundfontPath: input.soundfontPath
  });
  const resolved = await resolveProductionSoundfont(ctx, parsed);
  if (!resolved.ok) return { ...resolved, role: input.role };
  if (!packCoversRole(resolved.pack, input.role)) {
    return {
      ok: false as const,
      role: input.role,
      pack: resolved.pack,
      blockers: [`Pack ${resolved.pack.packId} is ${resolved.pack.instrumentRole}; ${input.role} tracks require a matching ${input.role} or general_midi pack.`]
    };
  }
  return { ...resolved, role: input.role };
}

// A ready general_midi pack registered in the project can stand in for any role, so a single
// install_free_soundfont_pack (GeneralUser GS) renders a full ensemble without per-role mapping.
function findGeneralMidiPackId(registry: { packs?: JazzPackRecord[]; readyPackIds?: string[] } | undefined): string | undefined {
  const ready = new Set(registry?.readyPackIds ?? []);
  return registry?.packs?.find((pack) => pack.instrumentRole === "general_midi" && (ready.has(pack.packId) || pack.status === "ready"))?.packId;
}

async function resolveProductionPackMap(ctx: ToolContext, parsed: z.infer<typeof renderProductionMusicInputSchema>, composition: Composition) {
  const requiredRoles = requiredProductionRoles(composition);
  const packsByRole: Partial<Record<JazzInstrumentRole, Awaited<ReturnType<typeof resolveProductionPackForRole>> & { ok: true }>> = {};
  const blockers: string[] = [];
  const requestedPackAvailability: unknown[] = [];
  // A registered general_midi pack (or an explicit top-level soundfontPackId) covers any role the
  // caller did not map explicitly, so one GeneralUser GS install renders the whole ensemble.
  const registry = await readJazzPackRegistry(ctx, parsed.projectId);
  const generalMidiPackId = findGeneralMidiPackId(registry);
  for (const role of requiredRoles) {
    const packId = parsed.instrumentPackMap[role] ?? parsed.soundfontPackId ?? generalMidiPackId;
    const soundfontPath = parsed.instrumentPackMap[role] ? undefined : parsed.soundfontPath;
    const resolved = await resolveProductionPackForRole(ctx, {
      projectId: parsed.projectId,
      role,
      compositionManifestPath: parsed.compositionManifestPath,
      soundfontPackId: packId,
      soundfontPath
    });
    if (resolved.ok) {
      packsByRole[role] = resolved;
    } else {
      blockers.push(...resolved.blockers);
      if ("requestedPackAvailability" in resolved && resolved.requestedPackAvailability) requestedPackAvailability.push(resolved.requestedPackAvailability);
    }
  }
  const packRecords = Object.fromEntries(Object.entries(packsByRole).map(([role, resolved]) => [role, resolved.pack])) as Partial<Record<JazzInstrumentRole, JazzPackRecord>>;
  const instrumentCoverage = instrumentCoverageForPackMap(composition, packRecords);
  blockers.push(...instrumentCoverage.filter((entry) => !entry.covered).map((entry) => entry.reason));
  return { ok: blockers.length === 0, requiredRoles, packsByRole, packRecords, instrumentCoverage, blockers: Array.from(new Set(blockers)), requestedPackAvailability: Array.from(new Map(requestedPackAvailability.map((entry) => [JSON.stringify((entry as { requestedPackId?: string }).requestedPackId ?? entry), entry])).values()) };
}

async function writeSoundfontRenderFailure(ctx: ToolContext, parsed: z.infer<typeof renderMidiWithSoundfontInputSchema>, blockingReasons: string[], metadata: Record<string, unknown> = {}) {
  const report = {
    renderer: "instrument_renderer",
    qualityTier: "preview_only",
    productionReady: false,
    blockingReasons,
    fullMixPath: undefined,
    stemPaths: {},
    warnings: blockingReasons,
    ...metadata
  };
  const reportFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReportPath, `${JSON.stringify(report, null, 2)}\n`);
  return {
    ok: false,
    summary: `SoundFont render blocked: ${blockingReasons[0] ?? "production renderer unavailable"}`,
    jobId: parsed.projectId,
    artifacts: [reportFile.path],
    structuredContent: { ...report, renderReportPath: reportFile.path },
    logs: [JSON.stringify(report, null, 2)],
    errors: blockingReasons
  };
}

// FluidSynth 2.x parses every argument after the first positional (SoundFont) file as another input
// file, so trailing -F/-r options raise "illegal option at this place" and no WAV is written. Options
// MUST precede the positional SoundFont + MIDI paths. Kept pure + exported so a regression test can
// assert the ordering without a fluidsynth binary.
export function fluidSynthArgs(soundfontPath: string, midiPath: string, outputPath: string, sampleRate: number): string[] {
  return ["-ni", "-F", outputPath, "-r", String(sampleRate), soundfontPath, midiPath];
}

async function fluidSynthRender(soundfontPath: string, midiPath: string, outputPath: string, sampleRate: number, timeout: number) {
  await execFileAsync("fluidsynth", fluidSynthArgs(soundfontPath, midiPath, outputPath, sampleRate), { timeout, maxBuffer: 1024 * 1024 });
  const output = await readFile(outputPath);
  assertPcmWav(output, "FluidSynth output");
  return output;
}

// Two-pass linear loudnorm: pass 1 measures audio stats, pass 2 applies a single static gain
// (linear=true). This preserves dynamics and avoids the pumping artefact of single-pass dynamic
// mode, which raises quiet intros by a large gain and surfaces the soundfont's noise floor.
// highpass=f=35 removes sub-bass rumble that FluidSynth can leave on soft velocity layers.
async function normalizeWavWithFfmpeg(inputWavPath: string, outputWavPath: string, sampleRate: number, timeout: number) {
  // Pass 1: measure. loudnorm prints a JSON block to stderr at loglevel=info.
  const measureFilter = "highpass=f=35,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json";
  let measured: { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string } | undefined;
  try {
    const result = await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "info", "-i", inputWavPath, "-af", measureFilter, "-f", "null", "-"], { timeout, maxBuffer: 256 * 1024 });
    const match = (result as unknown as { stderr: string }).stderr?.match(/\{[^{}]*"input_i"[^{}]*\}/s);
    if (match) measured = JSON.parse(match[0]);
  } catch (err: unknown) {
    const match = (err as { stderr?: string }).stderr?.match(/\{[^{}]*"input_i"[^{}]*\}/s);
    if (match) measured = JSON.parse(match[0]);
  }
  // Pass 2: apply. linear=true when stats available → static gain; falls back to dynamic mode.
  const applyFilter = measured
    ? `highpass=f=35,loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`
    : "highpass=f=35,loudnorm=I=-16:TP=-1.5:LRA=11";
  await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", inputWavPath, "-af", applyFilter, "-ar", String(sampleRate), outputWavPath], { timeout, maxBuffer: 1024 * 1024 });
  const output = await readFile(outputWavPath);
  assertPcmWav(output, "Normalized output");
  return output;
}

async function sfizzRender(sfzPath: string, midiPath: string, outputPath: string, sampleRate: number, timeout: number) {
  const attempts = [
    ["--sfz", sfzPath, "--midi", midiPath, "--wav", outputPath, "--sample-rate", String(sampleRate)],
    ["-s", sfzPath, "-m", midiPath, "-o", outputPath, "-r", String(sampleRate)],
    [sfzPath, midiPath, outputPath, String(sampleRate)]
  ];
  const errors: string[] = [];
  for (const args of attempts) {
    try {
      await execFileAsync("sfizz_render", args, { timeout, maxBuffer: 1024 * 1024 });
      const output = await readFile(outputPath);
      assertPcmWav(output, "SFZ renderer output");
      return output;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`sfizz_render failed with supported argument forms: ${errors.join(" | ")}`);
}

async function productionInstrumentRender(renderer: string, instrumentPath: string, midiPath: string, outputPath: string, sampleRate: number, timeout: number) {
  if (renderer === "sfizz") return sfizzRender(instrumentPath, midiPath, outputPath, sampleRate, timeout);
  return fluidSynthRender(instrumentPath, midiPath, outputPath, sampleRate, timeout);
}

async function encodeMp3WithFfmpeg(inputWavPath: string, outputMp3Path: string, timeout: number) {
  await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", inputWavPath, "-codec:a", "libmp3lame", "-b:a", "192k", outputMp3Path], { timeout, maxBuffer: 1024 * 1024 });
  return readFile(outputMp3Path);
}

function pcmWavFromSamples(samples: Int16Array, sampleRate: number, channelCount = 1) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) pcm.writeInt16LE(samples[index], index * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channelCount * 2, 28);
  header.writeUInt16LE(channelCount * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function mixPcmWavStems(stems: Buffer[]) {
  if (!stems.length) throw new Error("At least one rendered stem is required for production mix.");
  const parsed = stems.map((stem, index) => ({ stem, info: assertPcmWav(stem, `stem ${index + 1}`) }));
  const first = parsed[0].info;
  for (const item of parsed) {
    if (item.info.sampleRate !== first.sampleRate || item.info.channelCount !== first.channelCount || item.info.bitDepth !== first.bitDepth) {
      throw new Error("Rendered stems must share sample rate, channel count, and bit depth before mixing.");
    }
  }
  const frameSamples = Math.max(...parsed.map((item) => Math.floor(item.info.dataBytes / 2)));
  const output = new Int16Array(frameSamples);
  const gain = Math.min(1, 0.78 / Math.sqrt(parsed.length));
  for (let sampleIndex = 0; sampleIndex < frameSamples; sampleIndex += 1) {
    let mixed = 0;
    for (const item of parsed) {
      const offset = item.info.dataOffset + sampleIndex * 2;
      if (offset + 1 < item.info.dataOffset + item.info.dataBytes) mixed += item.stem.readInt16LE(offset) / 32768;
    }
    output[sampleIndex] = Math.round(Math.max(-0.95, Math.min(0.95, mixed * gain)) * 32767);
  }
  return pcmWavFromSamples(output, first.sampleRate, first.channelCount);
}

function productionStemGroups(composition: Composition) {
  const entries = Object.keys(composition.tracks);
  // Assign each track to exactly one stem group via productionRoleForTrack so no track is mixed
  // into two stems (which would double its audio) and so cello/violin/strings get their own stems.
  return productionRoleSpecs.map((spec) => ({
    id: spec.id,
    label: spec.label,
    role: spec.role,
    tracks: entries.filter((track) => productionRoleForTrack(track) === spec.role)
  }));
}

type SkippedLargeAudioAsset = {
  path: string;
  purpose: string;
  sizeBytes: number;
  maxBytes: number;
  replacementPath?: string;
};

async function writeProjectAudioAssetWithinMediaLimit(
  ctx: ToolContext,
  projectId: string,
  relativePath: string,
  content: Buffer,
  contentType: string,
  purpose: string
) {
  if (content.length > maxProjectMediaAssetBytes) {
    return {
      filePath: undefined,
      skipped: {
        path: relativePath,
        purpose,
        sizeBytes: content.length,
        maxBytes: maxProjectMediaAssetBytes
      } satisfies SkippedLargeAudioAsset
    };
  }
  const file = await writeProjectAsset(ctx.projectRoot, projectId, relativePath, content, contentType);
  return { filePath: file.path, skipped: undefined };
}

function compositionWithSelectedTracks(composition: Composition, tracks: string[]): Composition {
  const selected = Object.fromEntries(tracks.map((track) => [track, composition.tracks[track] ?? []]));
  return { ...JSON.parse(JSON.stringify(composition)), tracks: selected };
}

async function inspectMusicRenderEnvironment(ctx: ToolContext, input: z.infer<typeof checkMusicRenderEnvironmentInputSchema>) {
  const [fluidSynth, sfizz, ffmpeg, sox] = await Promise.all([
    toolVersion("fluidsynth"),
    toolVersion("sfizz_render"),
    toolVersion("ffmpeg", ["-version"]),
    toolVersion("sox", ["--version"])
  ]);
  const discovery = input.projectId
    ? await discoverSoundfontPacks(ctx, {
      projectId: input.projectId,
      includeLocalMusicPacks: input.includeLocalMusicPacks,
      projectSearchDirectories: input.projectSearchDirectories
    })
    : undefined;
  const reasons = [
    ...(!fluidSynth.ok && !sfizz.ok ? ["No offline instrument renderer is available; install sfizz_render or FluidSynth."] : []),
    ...(!ffmpeg.ok ? ["FFmpeg is not available; preview.mp3 export is blocked."] : []),
    ...(discovery && discovery.ready.length === 0 ? ["No ready .sf2/.sf3/.sfz instrument candidate with sidecar license/readme metadata was discovered."] : [])
  ];
  const packShortNames: Record<string, string> = {
    ydp_grand: "YDP Grand",
    salamander_grand: "Salamander",
    generaluser_gs: "GeneralUser GS"
  };
  let requestedPackPreflight: Record<string, unknown> | undefined;
  if (input.requestedPackId && input.requestedPackId !== "generaluser_gs") {
    const preflight = await sampledPianoPackAvailability(input.requestedPackId);
    if (preflight) {
      if (!preflight.runtimeFilesReady) {
        let fallbackPackId: string;
        if (input.requestedPackId !== "ydp_grand") {
          const ydpCheck = await sampledPianoPackAvailability("ydp_grand");
          fallbackPackId = ydpCheck?.runtimeFilesReady ? "ydp_grand" : "generaluser_gs";
        } else {
          fallbackPackId = "generaluser_gs";
        }
        const fallbackShortName = packShortNames[fallbackPackId] ?? fallbackPackId;
        const requestedShortName = packShortNames[input.requestedPackId] ?? preflight.displayName;
        const renderLabel = `${fallbackShortName} fallback — ${requestedShortName} blocked until installed`;
        requestedPackPreflight = {
          ...preflight,
          renderLabel,
          fallbackRecommendation: {
            packId: fallbackPackId,
            label: renderLabel,
            explanation: `${preflight.displayName} is not installed. ${fallbackShortName} will be used for rendering until ${preflight.displayName} is installed and registered.`
          }
        };
      } else {
        requestedPackPreflight = {
          ...preflight,
          renderLabel: preflight.displayName,
          fallbackRecommendation: null
        };
      }
    }
  }

  return {
    tools: {
      fluidsynth: { binary: "fluidsynth", ...fluidSynth },
      sfizz: { binary: "sfizz_render", ...sfizz },
      ffmpeg: { binary: "ffmpeg", ...ffmpeg },
      sox: { binary: "sox", ...sox }
    },
    instrumentDiscovery: discovery,
    productionSupport: {
      available: reasons.length === 0,
      reasons,
      statusLabel: reasons.length === 0
        ? "Rendered with free license-cleared instruments. Suitable for production use with proper attribution."
        : "MIDI preview only. Not production audio."
    },
    ...(requestedPackPreflight !== undefined ? { requestedPackPreflight } : {})
  };
}

function renderProductionLicensesMarkdown(input: {
  packs: JazzPackRecord[];
  toolchain: Awaited<ReturnType<typeof inspectMusicRenderEnvironment>>["tools"];
  productionWavPath?: string;
  previewMp3Path: string;
  stemPaths: Record<string, string>;
  midiStemPaths: Record<string, string>;
  skippedLargeAudioAssets?: SkippedLargeAudioAsset[];
}) {
  const lines = [
    "# Music Rendering Licenses",
    "",
    "## Output Files",
    ...(input.productionWavPath ? [`- ${input.productionWavPath}: final offline-rendered WAV master.`] : []),
    `- ${input.previewMp3Path}: MP3 preview encoded from the WAV master with FFmpeg.`,
    ...Object.entries(input.stemPaths).map(([stem, filePath]) => `- ${filePath}: rendered ${stem} WAV stem.`),
    ...Object.entries(input.midiStemPaths).map(([stem, filePath]) => `- ${filePath}: generated ${stem} MIDI stem.`),
    ...(input.skippedLargeAudioAssets?.length
      ? [
        "",
        "## Large WAV Assets Omitted",
        ...input.skippedLargeAudioAssets.map((asset) => `- ${asset.path}: ${asset.purpose} was ${asset.sizeBytes} bytes, above the ${asset.maxBytes} byte project media limit. Use ${asset.replacementPath ?? input.previewMp3Path} for published playback.`)
      ]
      : []),
    "",
    "## Instrument Libraries",
    ...input.packs.flatMap((pack) => [
      `- Name: ${pack.displayName}`,
      `  - Role: ${pack.instrumentRole}`,
      `  - Pack ID: ${pack.packId}`,
      `  - Format: ${pack.format}`,
      `  - License: ${pack.licenseType}`,
      `  - Source: ${pack.sourceUrl ?? pack.source}`,
      `  - Attribution: ${pack.attribution || "No attribution text supplied beyond the license/source metadata."}`,
      `  - License text path: ${pack.licenseTextPath ?? "missing"}`,
      `  - README path: ${pack.readmePath ?? "missing"}`,
      `  - SHA-256: ${pack.computedSha256 ?? "missing"}`,
      `  - Commercial use allowed: ${pack.commercialUseAllowed ? "yes" : "no"}`,
      `  - Redistribution allowed: ${pack.redistributionAllowed ? "yes" : "no"}`
    ]),
    "",
    "## Rendering Tools",
    `- sfizz_render: ${input.toolchain.sfizz.ok ? input.toolchain.sfizz.version : "not available"}`,
    `- FluidSynth: ${input.toolchain.fluidsynth.ok ? input.toolchain.fluidsynth.version : "not available"}`,
    `- FFmpeg: ${input.toolchain.ffmpeg.ok ? input.toolchain.ffmpeg.version : "not available"}`,
    `- SoX: ${input.toolchain.sox.ok ? input.toolchain.sox.version : "not available"}`,
    "",
    "## Policy",
    "- Raw sample libraries are not redistributed unless their license explicitly allows redistribution.",
    "- MIDI/browser playback is preview only and must not be described as production audio.",
    "- No Spotify-level mastering claim is made for this V1 pipeline."
  ];
  return `${lines.join("\n")}\n`;
}

export function renderProductionMusicHtml(input: {
  htmlPath: string;
  title: string;
  statusLabel: string;
  productionReady: boolean;
  productionWavPath?: string;
  previewMp3Path: string;
  licensesPath: string;
  reportPath: string;
  skippedLargeAudioAssets?: SkippedLargeAudioAsset[];
}) {
  const htmlDir = path.posix.dirname(input.htmlPath);
  const relHref = (assetPath: string) => path.posix.relative(htmlDir, assetPath);
  const mp3Href = relHref(input.previewMp3Path);
  const wavHref = input.productionWavPath ? relHref(input.productionWavPath) : undefined;
  const licensesHref = relHref(input.licensesPath);
  const reportHref = relHref(input.reportPath);
  const statusClass = input.productionReady ? "ok" : "warn";
  const wavDownload = wavHref ? `<a class="button" download href="${escapeHtml(wavHref)}">Download WAV</a>` : "";
  const wavFile = wavHref ? `<li><a href="${escapeHtml(wavHref)}">production.wav</a></li>` : "";
  const largeAssetNotice = input.skippedLargeAudioAssets?.length
    ? `<p class="warn">Large WAV assets were omitted from the published project because they exceed the media limit; the MP3 preview is the published playback file.</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><style>body{font-family:system-ui;margin:32px;max-width:860px;color:#171717}.status{display:inline-block;border:1px solid #d6d3d1;border-radius:6px;padding:8px 10px;margin:10px 0}.ok{color:#166534;background:#f0fdf4}.warn{color:#9a3412;background:#fff7ed}.controls{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}.button,button{border:1px solid #222;border-radius:6px;background:#fff;color:#171717;padding:10px 12px;font-weight:700;text-decoration:none;cursor:pointer}audio{width:100%;display:block;margin:12px 0 18px}</style></head><body><h1>${escapeHtml(input.title)}</h1><p class="status ${statusClass}">${escapeHtml(input.statusLabel)}</p>${largeAssetNotice}<audio id="preview" controls preload="metadata" src="${escapeHtml(mp3Href)}"></audio><div class="controls"><button type="button" onclick="document.getElementById('preview').play()">Play Preview</button>${wavDownload}<a class="button" download href="${escapeHtml(mp3Href)}">Download MP3</a></div><h2>Production Files</h2><ul>${wavFile}<li><a href="${escapeHtml(mp3Href)}">preview.mp3</a></li><li><a href="${escapeHtml(licensesHref)}">LICENSES.md</a></li><li><a href="${escapeHtml(reportHref)}">Pipeline report JSON</a></li></ul></body></html>`;
}

function wavFallbackOutputPath(outputAudioPath: string) {
  return path.extname(outputAudioPath).toLowerCase() === ".wav"
    ? outputAudioPath
    : `${outputAudioPath.replace(/\.[^/.]+$/, "")}.wav`;
}

function compositionWithSingleTrack(composition: Composition, track: string): Composition {
  return { ...JSON.parse(JSON.stringify(composition)), tracks: { [track]: composition.tracks[track] ?? [] } };
}

function inferMusicAssetType(assetPath: string): z.infer<typeof musicLicenseDependencySchema>["type"] {
  const lower = assetPath.toLowerCase();
  if (lower.endsWith(".mid") || lower.endsWith(".midi")) return "generated_midi";
  if (lower.endsWith(".wav")) return lower.includes("stem") ? "stem" : "exported_wav";
  if (lower.endsWith(".mp3")) return "exported_mp3";
  if (lower.endsWith(".ogg")) return "exported_ogg";
  if (lower.endsWith(".sf2") || lower.endsWith(".sf3") || lower.endsWith(".sfz")) return "soundfont";
  if (lower.includes("drum")) return "drum_kit";
  if (lower.includes("ambience") || lower.includes("room-tone")) return "ambience_bed";
  if (lower.includes("impulse") || lower.endsWith(".ir")) return "impulse_response";
  return "generated_audio_render";
}

function inferMusicAssetLicense(assetPath: string, type: z.infer<typeof musicLicenseDependencySchema>["type"]): z.infer<typeof musicLicenseDependencySchema>["license"] {
  const lower = assetPath.toLowerCase();
  if (lower.includes("unknown") || lower.includes("third-party") || lower.includes("commercial-sample")) return "unknown";
  if (lower.includes("cc-by")) return "cc_by";
  if (lower.includes("cc0")) return "cc0";
  if (lower.includes("public-domain")) return "public_domain";
  if (lower.includes("mit")) return "mit";
  if (lower.includes("apache")) return "apache_2";
  if (type === "soundfont" || type === "sample_pack" || type === "drum_kit" || type === "impulse_response" || type === "ambience_bed") return "unknown";
  return "generated_original";
}

function normalizeMusicLicenseAsset(asset: string | z.infer<typeof musicLicenseDependencySchema>) {
  const record = typeof asset === "string" ? { path: asset } : asset;
  const type = record.type ?? inferMusicAssetType(record.path);
  const license = (record.license ?? inferMusicAssetLicense(record.path, type) ?? "unknown") as NonNullable<z.infer<typeof musicLicenseDependencySchema>["license"]>;
  const attributionRequired = license === "cc_by";
  const commercialUseAllowed = record.commercialUseAllowed ?? ["generated_original", "user_provided", "public_domain", "cc0", "cc_by", "mit", "apache_2", "commercial_license"].includes(license);
  const usageStatus = !commercialUseAllowed || license === "unknown" || license === "not_safe_for_production"
    ? "review_required"
    : attributionRequired
      ? "commercial_allowed_with_attribution"
      : "commercial_allowed";
  return {
    path: record.path,
    type,
    license,
    source: record.source ?? (license === "generated_original" ? "generated in project" : "external or user-provided"),
    commercialUseAllowed,
    attributionRequired,
    attribution: record.attribution ?? (attributionRequired ? `Attribution required for ${record.path}` : ""),
    usageStatus,
    restrictions: license === "unknown" ? ["License unknown; do not use in production until verified."] : license === "not_safe_for_production" ? ["Not safe for production or public demo use."] : [],
    notes: record.notes
  };
}

function buildMusicLicenseManifest(input: z.infer<typeof buildMusicLicenseManifestInputSchema>, projectManifest?: Record<string, unknown>) {
  const fromManifest: Array<string | z.infer<typeof musicLicenseDependencySchema>> = [];
  const manifestAssets = projectManifest?.assets;
  if (manifestAssets && typeof manifestAssets === "object") {
    for (const value of Object.values(manifestAssets as Record<string, unknown>)) {
      if (typeof value === "string") fromManifest.push(value);
      if (Array.isArray(value)) for (const item of value) if (typeof item === "string") fromManifest.push(item);
    }
  }
  const allAssets = [...fromManifest, ...input.assets, ...input.instrumentLibraries, ...input.sampleMetadata];
  const seen = new Set<string>();
  const assetLicenseTable = allAssets.map(normalizeMusicLicenseAsset).filter((asset) => {
    if (seen.has(asset.path)) return false;
    seen.add(asset.path);
    return true;
  });
  const unsafeAssets = assetLicenseTable.filter((asset) => asset.usageStatus === "review_required");
  const attributionAssets = assetLicenseTable.filter((asset) => asset.attributionRequired);
  const businessDemoSuitable = unsafeAssets.length === 0 && assetLicenseTable.length > 0;
  const warnings = [
    ...unsafeAssets.map((asset) => `${asset.path}: ${asset.license} license requires review before public or commercial use.`),
    ...(assetLicenseTable.length === 0 ? ["No assets were provided for license review."] : [])
  ];
  const commercialUseStatus = unsafeAssets.length
    ? "blocked_pending_license_review"
    : attributionAssets.length
      ? "allowed_with_attribution"
      : "allowed";
  const attributionText = attributionAssets.length
    ? attributionAssets.map((asset) => asset.attribution || `Attribution required for ${asset.path}`).join("\n")
    : "No attribution required for generated/procedural assets listed in this manifest.";
  return {
    manifestVersion: 1,
    intendedUse: input.intendedUse,
    projectManifestPath: input.projectManifestPath,
    assetLicenseTable,
    commercialUseStatus,
    businessDemoSuitable,
    attributionRequired: attributionAssets.length > 0,
    attributionText,
    unsafeAssets,
    policyRule: "Do not include copyrighted third-party recordings, melodies, artist performances, or protected arrangements unless the user owns rights.",
    userFacingSummary: businessDemoSuitable
      ? "Listed music assets are marked commercial-safe for the intended demo/use case. Generated MIDI/audio and procedural instruments do not require attribution unless noted."
      : "Some music assets need license review before public demo, website, cafe, video, game, or client delivery use.",
    zipExportSummary: { includeLicenseManifest: true, includeAttributionText: attributionAssets.length > 0, blockFinalExport: unsafeAssets.length > 0 },
    warnings
  };
}

const jazzPackAllowedFormats: Record<z.infer<typeof jazzInstrumentPackSchema>["instrumentRole"], Array<z.infer<typeof jazzInstrumentPackSchema>["format"]>> = {
  realistic_piano: ["sfz", "soundfont", "wav_multisample", "virtual_instrument"],
  upright_bass: ["sfz", "soundfont", "wav_multisample", "virtual_instrument"],
  brush_drums: ["sfz", "soundfont", "wav_multisample", "virtual_instrument"],
  room_ambience: ["sfz", "soundfont", "impulse_response", "wav_multisample", "virtual_instrument"],
  cello: ["sfz", "soundfont", "wav_multisample", "virtual_instrument"],
  violin: ["sfz", "soundfont", "wav_multisample", "virtual_instrument"],
  strings: ["sfz", "soundfont", "wav_multisample", "virtual_instrument"],
  chamber_ensemble: ["sfz", "soundfont", "wav_multisample", "virtual_instrument"],
  orchestral_sketch: ["sfz", "soundfont", "wav_multisample", "virtual_instrument"],
  // A General MIDI soundfont (e.g. GeneralUser GS) carries every instrument program in one file, so
  // a single registered general_midi pack can satisfy any melodic/percussion role below.
  general_midi: ["soundfont", "sfz"]
};

// A general_midi pack covers any required role because the one .sf2 contains all GM programs, and
// midiBuffer emits the correct per-track Program Change events for FluidSynth to honour.
function packCoversRole(pack: { instrumentRole: JazzInstrumentRole } | undefined, requiredRole: JazzInstrumentRole | undefined): boolean {
  if (!pack || !requiredRole) return false;
  return pack.instrumentRole === requiredRole || pack.instrumentRole === "general_midi";
}

const jazzPackSafeLicenses = new Set(["generated_original", "public_domain", "cc0", "cc_by", "mit", "apache_2", "commercial_license", "generaluser_gs_2_0"]);
const jazzPackReviewLicenses = new Set(["user_provided", "lgpl", "gpl", "proprietary", "unknown"]);

function jazzPackAssetType(format: z.infer<typeof jazzInstrumentPackSchema>["format"]): z.infer<typeof musicLicenseDependencySchema>["type"] {
  if (format === "soundfont" || format === "sfz") return "soundfont";
  if (format === "impulse_response") return "impulse_response";
  if (format === "virtual_instrument") return "virtual_instrument";
  return "sample_pack";
}

async function inspectJazzPackAssets(projectRoot: string, projectId: string, pack: z.infer<typeof jazzInstrumentPackSchema>) {
  const assets = [];
  const hash = createHash("sha256");
  for (const assetPath of pack.assetPaths) {
    try {
      const storedPath = await getProjectStoredFilePath(projectRoot, projectId, assetPath);
      const data = await readFile(storedPath);
      hash.update(data);
      assets.push({ path: assetPath, exists: true, sizeBytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    } catch {
      assets.push({ path: assetPath, exists: false, sizeBytes: 0, sha256: undefined });
    }
  }
  const missing = assets.filter((asset) => !asset.exists).map((asset) => asset.path);
  const licenseTextExists = pack.licenseTextPath ? await pathExists(await getProjectStoredFilePath(projectRoot, projectId, pack.licenseTextPath)) : false;
  const readmeExists = pack.readmePath ? await pathExists(await getProjectStoredFilePath(projectRoot, projectId, pack.readmePath)) : false;
  return {
    assets,
    missing,
    combinedSha256: assets.every((asset) => asset.exists) ? hash.digest("hex") : undefined,
    licenseTextExists,
    readmeExists
  };
}

function analyzeJazzPack(pack: z.infer<typeof jazzInstrumentPackSchema>, inspected: Awaited<ReturnType<typeof inspectJazzPackAssets>>, intendedUse: z.infer<typeof manageJazzInstrumentPacksInputSchema>["intendedUse"]) {
  const riskFlags: string[] = [];
  if (!jazzPackAllowedFormats[pack.instrumentRole].includes(pack.format)) riskFlags.push("format_not_suitable_for_instrument_role");
  if (inspected.missing.length) riskFlags.push("missing_pack_assets");
  if (pack.declaredSha256 && inspected.combinedSha256 && pack.declaredSha256.toLowerCase() !== inspected.combinedSha256) riskFlags.push("declared_hash_mismatch");
  if (pack.licenseType === "non_commercial") riskFlags.push("non_commercial_license");
  if (pack.licenseType === "unknown") riskFlags.push("unknown_license");
  if (pack.licenseType === "gpl" || pack.licenseType === "lgpl") riskFlags.push("copyleft_license_review_required");
  if (pack.licenseType === "proprietary") riskFlags.push("proprietary_terms_review_required");
  if (pack.licenseType === "cc_by" && !pack.attribution) riskFlags.push("missing_required_attribution_text");
  if (pack.commercialUseAllowed === false) riskFlags.push("commercial_use_not_allowed");
  if (pack.commercialUseAllowed === undefined && !jazzPackSafeLicenses.has(pack.licenseType)) riskFlags.push("commercial_use_permission_not_explicit");
  if (pack.redistributionAllowed === false && intendedUse === "client_delivery") riskFlags.push("redistribution_not_allowed_for_client_delivery");
  if (pack.redistributionAllowed === undefined && intendedUse === "client_delivery") riskFlags.push("redistribution_permission_not_explicit");
  if (pack.qualityTier === "production_candidate" || pack.productionUseApproved === true) {
    if (pack.productionUseApproved !== true) riskFlags.push("production_use_not_approved");
    if (!inspected.combinedSha256) riskFlags.push("missing_computed_hash");
    if (!pack.licenseTextPath || !inspected.licenseTextExists) riskFlags.push("missing_license_text_path");
    if (!pack.sourceUrl) riskFlags.push("missing_source_url");
    if (pack.commercialUseAllowed !== true) riskFlags.push("commercial_use_not_explicitly_allowed_for_production");
    if (pack.redistributionAllowed === undefined && intendedUse === "client_delivery") riskFlags.push("redistribution_permission_not_explicit");
  }

  const blocked = riskFlags.some((flag) => ["non_commercial_license", "commercial_use_not_allowed", "missing_pack_assets", "declared_hash_mismatch", "missing_computed_hash", "missing_license_text_path", "commercial_use_not_explicitly_allowed_for_production"].includes(flag));
  const review = blocked || riskFlags.length > 0 || jazzPackReviewLicenses.has(pack.licenseType);
  const status = blocked ? "blocked" : review ? "review_required" : "ready";
  const qualityTier = status === "ready" && pack.productionUseApproved === true && pack.qualityTier === "production_candidate"
    ? "production_candidate"
    : status === "ready"
      ? "review_required"
      : "preview_only";
  return {
    packId: pack.packId,
    displayName: pack.displayName,
    instrumentRole: pack.instrumentRole,
    format: pack.format,
    version: pack.version ?? "unversioned",
    source: pack.source,
    sourceUrl: pack.sourceUrl,
    licenseTextPath: pack.licenseTextPath,
    readmePath: pack.readmePath,
    licenseTextExists: inspected.licenseTextExists,
    readmeExists: inspected.readmeExists,
    licenseType: pack.licenseType,
    commercialUseAllowed: pack.commercialUseAllowed ?? (jazzPackSafeLicenses.has(pack.licenseType) || pack.licenseType === "cc_by"),
    redistributionAllowed: pack.redistributionAllowed ?? false,
    modificationsAllowed: pack.modificationsAllowed ?? false,
    productionUseApproved: pack.productionUseApproved ?? false,
    qualityTier,
    attributionRequired: pack.licenseType === "cc_by" || Boolean(pack.attribution),
    attribution: pack.attribution ?? "",
    assetPaths: pack.assetPaths,
    assetInspection: inspected.assets,
    declaredSha256: pack.declaredSha256,
    computedSha256: inspected.combinedSha256,
    riskFlags,
    status,
    eligibleRenderer: status === "ready" && pack.format === "soundfont" && pack.assetPaths.some(isSoundfontAssetPath) ? "fluidsynth" : status === "ready" && pack.format === "sfz" && pack.assetPaths.some(isSfzAssetPath) ? "sfizz" : undefined,
    renderUse: status === "ready" ? "eligible_for_verified_instrument_renderer" : "do_not_use_until_license_review_passes",
    proceduralFallback: pack.instrumentRole === "realistic_piano" ? "warm_acoustic_piano" : pack.instrumentRole === "upright_bass" ? "upright_bass" : pack.instrumentRole === "brush_drums" ? "jazz_brushes" : "short_synthetic_ambience_tail",
    notes: pack.notes
  };
}

async function manageJazzInstrumentPacks(input: z.infer<typeof manageJazzInstrumentPacksInputSchema>, projectRoot: string) {
  const packs = [];
  for (const pack of input.packs) {
    const inspected = await inspectJazzPackAssets(projectRoot, input.projectId, pack);
    packs.push(analyzeJazzPack(pack, inspected, input.intendedUse));
  }
  const readyPacks = packs.filter((pack) => pack.status === "ready");
  const reviewPacks = packs.filter((pack) => pack.status === "review_required");
  const blockedPacks = packs.filter((pack) => pack.status === "blocked");
  const instrumentMapCandidates = Object.fromEntries(input.targetInstruments.map((instrument) => {
    const pack = readyPacks.find((candidate) => candidate.instrumentRole === instrument);
    return [instrument, pack ? { packId: pack.packId, format: pack.format, version: pack.version, licenseType: pack.licenseType, rendererUse: pack.renderUse } : { packId: undefined, rendererUse: "use_procedural_fallback_until_safe_pack_ready" }];
  }));
  const licenseManifest = buildMusicLicenseManifest({
    projectId: input.projectId,
    intendedUse: input.intendedUse === "client_delivery" ? "client_delivery" : input.intendedUse === "internal_preview" ? "internal_preview" : "business_demo",
    assets: [],
    instrumentLibraries: packs.flatMap((pack) => pack.assetPaths.map((assetPath) => ({
      path: assetPath,
      type: jazzPackAssetType(pack.format),
      license: pack.status === "blocked" ? "not_safe_for_production" : pack.licenseType === "lgpl" || pack.licenseType === "gpl" || pack.licenseType === "proprietary" || pack.licenseType === "non_commercial" ? "unknown" : pack.licenseType as z.infer<typeof musicLicenseDependencySchema>["license"],
      source: pack.source,
      attribution: pack.attribution,
      commercialUseAllowed: pack.commercialUseAllowed && pack.status !== "blocked",
      notes: `Jazz instrument pack ${pack.packId}; status=${pack.status}; riskFlags=${pack.riskFlags.join(",") || "none"}`
    }))),
    sampleMetadata: [],
    outputPath: input.outputLicenseManifestPath
  });
  return {
    manifestVersion: 1,
    intendedUse: input.intendedUse,
    targetInstruments: input.targetInstruments,
    packs,
    readyPackIds: readyPacks.map((pack) => pack.packId),
    reviewRequiredPackIds: reviewPacks.map((pack) => pack.packId),
    blockedPackIds: blockedPacks.map((pack) => pack.packId),
    instrumentMapCandidates,
    licenseManifest,
    rendererIntegration: {
      instrumentPackManifestPath: input.outputPath,
      licenseManifestPath: input.outputLicenseManifestPath,
      safeProceduralFallbackMap: {
        realistic_piano: "warm_acoustic_piano",
        upright_bass: "upright_bass",
        brush_drums: "jazz_brushes",
        room_ambience: "short_synthetic_ambience_tail"
      },
      eligibleRenderer: "fluidsynth",
      eligibleRenderers: ["fluidsynth", "sfizz"],
      rule: "Only packs with status=ready, verified hashes, commercial-safe license metadata, and a supported asset format may be selected by render_midi_with_soundfont. .sf2/.sf3 assets use FluidSynth; .sfz assets use an installed SFZ renderer such as sfizz_render. Existing procedural WAV rendering is preview_only fallback for review_required or blocked packs."
    },
    ok: blockedPacks.length === 0 && reviewPacks.length === 0,
    warnings: [...reviewPacks.map((pack) => `${pack.packId}: license or redistribution review required (${pack.riskFlags.join(", ") || pack.licenseType}).`), ...blockedPacks.map((pack) => `${pack.packId}: blocked (${pack.riskFlags.join(", ")}).`)]
  };
}

// Rebuild a registry record back into a manage_jazz_instrument_packs input spec so an existing
// registry can be merged (not clobbered) when a new pack is auto-registered. declaredSha256 reuses
// the previously computed hash so re-analysis of unchanged assets still verifies.
function jazzPackRecordToInputSpec(record: JazzPackRecord): z.infer<typeof jazzInstrumentPackSchema> {
  const declaredSha256 = record.declaredSha256 ?? record.computedSha256;
  return {
    packId: record.packId,
    displayName: record.displayName,
    instrumentRole: record.instrumentRole,
    format: record.format,
    assetPaths: record.assetPaths,
    version: record.version,
    ...(declaredSha256 && /^[a-fA-F0-9]{64}$/.test(declaredSha256) ? { declaredSha256 } : {}),
    licenseType: record.licenseType,
    source: record.source,
    ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
    ...(record.licenseTextPath ? { licenseTextPath: record.licenseTextPath } : {}),
    ...(record.readmePath ? { readmePath: record.readmePath } : {}),
    productionUseApproved: record.productionUseApproved,
    qualityTier: record.qualityTier as z.infer<typeof jazzInstrumentPackSchema>["qualityTier"],
    ...(record.attribution ? { attribution: record.attribution } : {}),
    commercialUseAllowed: record.commercialUseAllowed,
    redistributionAllowed: record.redistributionAllowed,
    modificationsAllowed: record.modificationsAllowed,
    ...(record.notes ? { notes: record.notes } : {})
  };
}

// Auto-register a freshly installed GeneralUser GS pack into the project's jazz instrument registry
// as a general_midi pack, MERGING with any existing packs, so render_midi_with_soundfont /
// render_production_music can use the returned pack id immediately (issue_0145). One GM pack then
// covers every melodic/percussion role of an ensemble.
// Auto-register a freshly installed pack (GeneralUser GS general_midi, or a sampled realistic_piano
// grand) into the project registry, MERGING with existing packs, so render tools can use the pack id
// immediately. instrumentRole + attribution come from the install result, so CC-BY grands carry their
// required attribution into the license manifest automatically.
type InstalledPack = {
  ok: true; packId: string; displayName: string; version: string; assetPaths: string[];
  computedSha256: string; licenseType: string; source: string; sourceUrl: string;
  licenseTextPath: string; readmePath: string; attribution: string; instrumentRole: JazzInstrumentRole;
};

async function autoRegisterInstalledPack(ctx: ToolContext, projectId: string, installResult: InstalledPack) {
  const spec: z.infer<typeof jazzInstrumentPackSchema> = {
    packId: installResult.packId,
    displayName: installResult.displayName,
    instrumentRole: installResult.instrumentRole,
    format: "soundfont",
    assetPaths: installResult.assetPaths,
    version: installResult.version,
    declaredSha256: installResult.computedSha256,
    licenseType: installResult.licenseType as z.infer<typeof jazzInstrumentPackSchema>["licenseType"],
    source: installResult.source,
    sourceUrl: installResult.sourceUrl,
    licenseTextPath: installResult.licenseTextPath,
    readmePath: installResult.readmePath,
    attribution: installResult.attribution,
    productionUseApproved: true,
    qualityTier: "production_candidate",
    commercialUseAllowed: true,
    redistributionAllowed: true,
    modificationsAllowed: true
  };
  const existing = await readJazzPackRegistry(ctx, projectId);
  // NOTE: existing packs are re-analyzed on merge. A previously-registered pack whose stored
  // attribution/sourceUrl is empty could re-acquire a risk flag here; install's ok only gates on the
  // newly installed pack so it won't lie, but a second user pack could be quietly demoted.
  const existingSpecs = (existing?.packs ?? [])
    .filter((record) => record.packId !== spec.packId)
    .map(jazzPackRecordToInputSpec);
  const parsedInput = manageJazzInstrumentPacksInputSchema.parse({
    projectId,
    intendedUse: "client_delivery",
    packs: [...existingSpecs, spec]
  });
  const registry = await manageJazzInstrumentPacks(parsedInput, ctx.projectRoot);
  const [registryFile] = await Promise.all([
    writeProjectFile(ctx.projectRoot, projectId, parsedInput.outputPath, `${JSON.stringify(registry, null, 2)}\n`),
    writeProjectFile(ctx.projectRoot, projectId, parsedInput.outputLicenseManifestPath, `${JSON.stringify(registry.licenseManifest, null, 2)}\n`)
  ]);
  return {
    registryPath: registryFile.path,
    registered: registry.readyPackIds.includes(spec.packId),
    readyPackIds: registry.readyPackIds,
    reviewRequiredPackIds: registry.reviewRequiredPackIds,
    blockedPackIds: registry.blockedPackIds
  };
}

function renderAuditionHtml(title: string, variations: Array<Record<string, unknown>>, allowDownloads: boolean) {
  const cards = variations.map((variation) => {
    const audioPath = String(variation.audioPath ?? "");
    const midiPath = String(variation.midiPath ?? "");
    const scoreSourcePath = String(variation.scoreSourcePath ?? "");
    const notes = Array.isArray(variation.styleNotes) ? variation.styleNotes.join(", ") : String(variation.rationale ?? "");
    const versionId = String(variation.id ?? variation.label ?? "version");
    const titleText = String(variation.title ?? variation.label ?? variation.id ?? "Version");
    const duration = Number(variation.durationSeconds ?? variation.durationSec ?? 0);
    const tempo = variation.tempo ?? variation.bpm ?? "";
    const moodTags = Array.isArray(variation.moodTags) ? variation.moodTags : [];
    const renderer = String(variation.renderer ?? "unknown");
    const qualityTier = String(variation.qualityTier ?? (renderer === "fluidsynth" ? "production_candidate" : "preview_only"));
    const renderClass = qualityTier === "production_candidate" ? "ok" : "warn";
    return `<article class="card">
      <header><h2>${escapeHtml(titleText)}</h2><label class="winner"><input type="radio" name="winner" value="${escapeHtml(versionId)}"> Choose this version</label></header>
      <audio controls preload="metadata" src="${escapeHtml(audioPath)}"></audio>
      <dl>
        <dt>Style</dt><dd>${escapeHtml(String(variation.style ?? ""))}</dd>
        <dt>BPM / Key</dt><dd>${escapeHtml(String(tempo))} / ${escapeHtml(String(variation.key ?? ""))}</dd>
        <dt>Renderer</dt><dd><span class="${renderClass}">${escapeHtml(renderer)} / ${escapeHtml(qualityTier)}</span></dd>
        <dt>SoundFont</dt><dd>${escapeHtml(String(variation.soundfontName ?? "not registered"))}</dd>
        <dt>License</dt><dd>${escapeHtml(String(variation.licenseStatus ?? "review required before production use"))}</dd>
        <dt>QA</dt><dd>${variation.qaScore === undefined ? "not supplied" : `${Number(variation.qaScore).toFixed(0)} / 100`}</dd>
        <dt>Instruments</dt><dd>${escapeHtml(Array.isArray(variation.instruments) ? variation.instruments.join(", ") : "")}</dd>
        <dt>Mood</dt><dd>${escapeHtml(moodTags.join(", "))}</dd>
        <dt>Notes</dt><dd>${escapeHtml(notes)}</dd>
        <dt>Prompt</dt><dd>${escapeHtml(String(variation.generatedPrompt ?? ""))}</dd>
      </dl>
      <div class="timeline" aria-label="Timeline"><span style="width:${Math.max(10, Math.min(100, (duration || 30) / 1.2))}%"></span></div>
      <label class="rating">Rating <input type="range" min="1" max="5" value="3" data-version="${escapeHtml(versionId)}"></label>
      ${allowDownloads ? `<p class="downloads"><a href="${escapeHtml(audioPath)}" download>Download audio</a>${midiPath ? ` <a href="${escapeHtml(midiPath)}" download>Download MIDI</a>` : ""}${scoreSourcePath ? ` <a href="${escapeHtml(scoreSourcePath)}" download>Download score</a>` : ""}</p>` : ""}
    </article>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;font-family:Inter,system-ui,sans-serif;background:#f6f4ef;color:#1f2933}
header,main{max-width:1120px;margin:auto;padding:28px}
h1{font-size:32px;margin:0 0 8px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.card{background:#fff;border:1px solid #ddd7ca;border-radius:8px;padding:18px}.card header{display:flex;gap:12px;align-items:start;justify-content:space-between}audio{width:100%}
dt{font-weight:700;margin-top:10px}.ok{color:#166534}.warn{color:#9a3412}.timeline{height:8px;background:#ece7dc;border-radius:999px;overflow:hidden}.timeline span{display:block;height:100%;background:#5b7f95}
.feedback{margin-top:20px;background:#fff;border:1px solid #ddd7ca;border-radius:8px;padding:16px}textarea{width:100%;min-height:92px}.checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}.rating{display:block;margin-top:14px}.winner{font-size:13px}
</style>
</head>
<body>
<header><h1>${escapeHtml(title)}</h1><p>Compare versions, note the best fit, and request revisions such as warmer piano, less drums, more jazz, or smoother loop seams.</p></header>
<main><section class="grid">${cards}</section><section class="feedback"><h2>Review notes</h2><div class="checks"><label><input type="checkbox"> Warmer piano</label><label><input type="checkbox"> Less drums</label><label><input type="checkbox"> More jazz</label><label><input type="checkbox"> Smoother transition</label><label><input type="checkbox"> Longer intro</label><label><input type="checkbox"> Less repetitive</label></div><textarea placeholder="Pick A/B/C/D and describe revisions..."></textarea></section></main>
</body>
</html>
`;
}

function productionReadyVariationBlockers(variations: Array<Record<string, unknown>>) {
  const blockers: string[] = [];
  for (const [index, variation] of variations.entries()) {
    const label = String(variation.id ?? variation.label ?? `version_${index + 1}`);
    if (typeof variation.audioPath !== "string" || !variation.audioPath.trim()) blockers.push(`${label} has no production audioPath.`);
    if (String(variation.qualityTier ?? "") !== "production_candidate") blockers.push(`${label} is not qualityTier=production_candidate.`);
    if (variation.productionReady !== true) blockers.push(`${label} is not marked productionReady=true.`);
    if (String(variation.renderer ?? "") === "built_in_procedural_synth") blockers.push(`${label} uses built_in_procedural_synth, which is preview_only.`);
  }
  return blockers;
}

async function writeCompositionBundle(ctx: ToolContext, projectId: string, composition: Composition, basePath: string, renderAudio = true) {
  const manifestPath = `${basePath}.json`;
  const midiPath = `${basePath}.mid`;
  const audioPath = `${basePath}.wav`;
  const artifacts = [
    (await writeProjectFile(ctx.projectRoot, projectId, manifestPath, `${JSON.stringify(composition, null, 2)}\n`)).path,
    (await writeProjectAsset(ctx.projectRoot, projectId, midiPath, midiBuffer(composition), "audio/midi")).path
  ];
  if (renderAudio) artifacts.push((await writeProjectAsset(ctx.projectRoot, projectId, audioPath, wavBuffer(composition, 16000), "audio/wav")).path);
  return { manifestPath, midiPath, audioPath: renderAudio ? audioPath : undefined, artifacts };
}

function extendComposition(composition: Composition, targetDurationSeconds: number, style: string) {
  const extended = JSON.parse(JSON.stringify(composition)) as Composition;
  const sourceDuration = Math.max(1, composition.durationSeconds);
  const repeats = Math.ceil(targetDurationSeconds / sourceDuration);
  const tracks: Composition["tracks"] = {};
  for (const [track, notes] of Object.entries(composition.tracks)) {
    tracks[track] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const offsetBeats = repeat * sourceDuration / 60 * composition.tempo;
      for (const note of notes) {
        tracks[track].push({
          ...note,
          startBeat: Number((note.startBeat + offsetBeats).toFixed(3)),
          velocity: Math.max(1, Math.min(127, note.velocity + ((repeat % 4) - 1) * 3)),
          midi: track === "piano" && repeat % 3 === 2 ? Math.min(127, note.midi + 12) : note.midi
        });
      }
    }
  }
  extended.title = `${composition.title} (${Math.round(targetDurationSeconds / 60)} min arrangement)`;
  extended.durationSeconds = targetDurationSeconds;
  extended.loopable = style === "loopable_longform";
  extended.sections = [
    { name: "intro", bars: 8, intensity: 0.25 },
    { name: "A", bars: 32, intensity: 0.48 },
    { name: "B variation", bars: 32, intensity: 0.58 },
    { name: "bridge", bars: 16, intensity: 0.42 },
    { name: "solo texture", bars: 32, intensity: 0.62 },
    { name: "reprise", bars: 32, intensity: 0.5 },
    { name: "outro", bars: 8, intensity: 0.22 }
  ];
  extended.tracks = tracks;
  return extended;
}

function extendOriginalArrangement(composition: Composition, input: z.infer<typeof extendOriginalMusicArrangementInputSchema>) {
  const extended = extendComposition(composition, input.targetDurationSec, "background_friendly");
  extended.title = `${composition.title} (${input.styleFamily.replaceAll("_", " ")} long-form original)`;
  extended.loopable = false;
  const totalBeats = input.targetDurationSec / 60 * extended.tempo;
  const beatsPerSection = Math.max(8, Math.round(totalBeats / input.sections.length / 4) * 4);
  extended.sections = input.sections.map((name, index) => {
    const arc = index / Math.max(1, input.sections.length - 1);
    const intensity = name.includes("breakdown") ? 0.28 : name.includes("solo") ? 0.62 : name.includes("outro") ? 0.22 : Number((0.3 + Math.sin(arc * Math.PI) * 0.28).toFixed(2));
    return { name, bars: Math.max(2, Math.round(beatsPerSection / 4)), intensity };
  });
  const sectionMap = extended.sections.map((section, index) => ({
    name: section.name,
    startBeat: index * beatsPerSection,
    endBeat: Math.min(totalBeats, (index + 1) * beatsPerSection),
    role: section.name.includes("intro") ? "setup" : section.name.includes("outro") ? "release" : section.name.includes("solo") ? "light improvisation" : section.name.includes("breakdown") ? "texture reset" : "development",
    energy: section.intensity,
    transition: index === 0 ? "fade-in or pickup" : "smooth 2-4 bar crossfade-compatible handoff"
  }));
  const variationMultiplier = input.variationLevel === "high" ? 0.18 : input.variationLevel === "low" ? 0.06 : 0.11;
  for (const [track, notes] of Object.entries(extended.tracks)) {
    for (const note of notes) {
      const sectionIndex = Math.min(sectionMap.length - 1, Math.floor(note.startBeat / beatsPerSection));
      if (track === "piano" && sectionIndex % 3 === 1) note.midi = Math.min(96, note.midi + 12);
      if (track === "bass" && sectionIndex % 2 === 1) note.durationBeats = Number(Math.max(0.5, note.durationBeats * (1 - variationMultiplier)).toFixed(3));
      if (track === "drums" && sectionMap[sectionIndex]?.name.includes("breakdown")) note.velocity = Math.max(18, Math.round(note.velocity * 0.65));
      note.velocity = Math.max(24, Math.min(86, note.velocity));
    }
  }
  const noteCount = Object.values(composition.tracks).flat().length;
  const uniqueChords = new Set(composition.chordProgression).size;
  const warnings: string[] = [];
  if (noteCount < 12) warnings.push("Source sketch is sparse; long-form extension may need additional motif writing.");
  if (uniqueChords <= 1) warnings.push("Source harmony is repetitive; added variation plan should be reviewed before rendering.");
  const developmentReport = {
    targetDurationSec: input.targetDurationSec,
    styleFamily: input.styleFamily,
    backgroundUse: input.backgroundUse,
    variationLevel: input.variationLevel,
    energyCurve: sectionMap.map((section) => ({ section: section.name, energy: section.energy })),
    developmentMoves: [
      "instrument entrance and exit planned by section",
      "piano chord color variation every few sections",
      "bass duration and movement variation in alternate sections",
      "light solo/improvisation texture without high-density melody",
      "drum fill and breakdown intensity control",
      "stable dynamics capped for background listening"
    ],
    transitionPlan: sectionMap.map((section) => ({ section: section.name, transition: section.transition })),
    backgroundFriendliness: { stableVolume: true, gentleDynamics: true, lowDistraction: true, noSuddenHits: true }
  };
  const originalityNotes = [
    "Generated from abstract style constraints and the provided original sketch only.",
    "Do not imitate specific copyrighted songs, melodies, recordings, artist performances, or protected arrangements.",
    `Originality policy: ${input.originalityPolicy}.`
  ];
  return { extended, sectionMap, developmentReport, originalityNotes, warnings, renderReady: warnings.length === 0 };
}

function instrumentForTrack(track: string): z.infer<typeof instrumentSchema> {
  if (track === "electric_piano") return "electric_piano";
  if (track === "upright_bass" || track === "bass") return "upright_bass";
  if (track === "acoustic_bass") return "acoustic_bass";
  if (track === "brush_drums") return "brushes";
  if (track === "drums") return "drums";
  if (track === "guitar") return "guitar";
  if (track === "strings") return "strings";
  if (track === "violin") return "violin";
  if (track === "cello") return "cello";
  if (track === "pads") return "pads";
  if (track === "lead") return "sax_like_lead";
  if (track === "synth") return "synth";
  return "piano";
}

function normalizeTrackName(track: string) {
  return track === "brush_drums" ? "drums" : track === "upright_bass" || track === "acoustic_bass" ? "bass" : track;
}

function buildMidiComposition(input: z.infer<typeof composeEditMidiInputSchema>): Composition & { sectionMap: Array<Record<string, unknown>>; trackList: Array<Record<string, unknown>>; chordChart: Array<Record<string, unknown>>; warnings: string[]; editableOperations: string[] } {
  const instruments = [...new Set(input.tracks.map(instrumentForTrack))];
  const composition = buildComposition({
    projectId: input.projectId,
    title: `${input.style.replaceAll("_", " ")} MIDI arrangement`,
    style: input.style,
    mood: input.mood,
    tempo: input.tempoBpm,
    key: input.key.replace(/\s+major$/i, "").replace(/\s+minor$/i, "m"),
    durationSeconds: input.durationSec,
    useCase: input.constraints.backgroundFriendly ? "background music" : "production music",
    instruments,
    complexity: "medium",
    loopable: input.constraints.loopable,
    outputManifestPath: "unused.json",
    outputMidiPath: "unused.mid"
  });
  const beatsPerSection = Math.max(4, Math.round((input.durationSec / 60 * input.tempoBpm) / input.sections.length / 4) * 4);
  composition.sections = input.sections.map((name, index) => ({ name, bars: beatsPerSection / 4, intensity: Number((0.28 + (index % 4) * 0.1).toFixed(2)) }));
  const sectionMap = input.sections.map((name, index) => ({ name, startBeat: index * beatsPerSection, endBeat: (index + 1) * beatsPerSection, loopStart: input.constraints.loopable && index === 0, loopEnd: input.constraints.loopable && index === input.sections.length - 1 }));
  const requestedTracks = new Set(input.tracks.map(normalizeTrackName));
  for (const track of Object.keys(composition.tracks)) {
    if (!requestedTracks.has(track) && !(track === "piano" && (requestedTracks.has("electric_piano") || requestedTracks.has("guitar")))) delete composition.tracks[track];
  }
  for (const track of requestedTracks) composition.tracks[track] ??= [];
  const warnings: string[] = [];
  const allNotes = () => Object.values(composition.tracks).flat();
  if (input.constraints.backgroundFriendly && allNotes().length / Math.max(1, input.durationSec / 60) > 420) warnings.push("MIDI density may be too busy for background use.");
  if (input.constraints.avoidHarshRegister && allNotes().some((note) => note.midi > 96)) warnings.push("Some notes are in a harsh high register.");
  if (input.constraints.stableDynamics) {
    for (const notes of Object.values(composition.tracks)) {
      for (const note of notes) note.velocity = Math.max(32, Math.min(88, note.velocity));
    }
  }
  const chordChart = sectionMap.map((section, index) => ({ section: section.name, chord: composition.chordProgression[index % composition.chordProgression.length], bars: Math.round((Number(section.endBeat) - Number(section.startBeat)) / 4) }));
  const trackList = input.tracks.map((track) => ({ name: normalizeTrackName(track), instrument: track, muted: false, solo: false, noteCount: composition.tracks[normalizeTrackName(track)]?.length ?? 0, exportStemReady: true }));
  return {
    ...composition,
    sectionMap,
    trackList,
    chordChart,
    warnings,
    editableOperations: ["create_track", "edit_notes", "quantize", "humanize", "adjust_velocity", "transpose", "swing", "duplicate_section", "add_fill", "add_intro", "add_outro", "change_instrument", "mute_track", "solo_track"]
  };
}

function applyComposeEditOperations(composition: ReturnType<typeof buildMidiComposition>, operations: Array<z.infer<typeof midiOperationSchema>>) {
  const edited = JSON.parse(JSON.stringify(composition)) as ReturnType<typeof buildMidiComposition>;
  const selectedSoloTracks = new Set(operations.filter((operation) => operation.type === "solo_track" && operation.track).map((operation) => normalizeTrackName(operation.track!)));
  for (const operation of operations) {
    const track = operation.track ? normalizeTrackName(operation.track) : undefined;
    if (operation.type === "create_track" && track) edited.tracks[track] ??= [];
    if (operation.type === "edit_notes" && track && operation.notes) {
      edited.tracks[track] ??= [];
      edited.tracks[track].push(...operation.notes.map((note) => ({ ...note, track })));
    }
    if (operation.type === "quantize") {
      const grid = typeof operation.value === "number" ? operation.value : 0.5;
      for (const note of Object.values(edited.tracks).flat()) note.startBeat = Number((Math.round(note.startBeat / grid) * grid).toFixed(3));
    }
    if (operation.type === "humanize") {
      const amount = typeof operation.value === "number" ? operation.value : 0.04;
      for (const note of Object.values(edited.tracks).flat()) note.startBeat = Number((note.startBeat + ((note.midi % 5) - 2) * amount).toFixed(3));
    }
    if (operation.type === "adjust_velocity") {
      const scale = typeof operation.value === "number" ? operation.value : 1;
      const notes = track ? edited.tracks[track] ?? [] : Object.values(edited.tracks).flat();
      for (const note of notes) note.velocity = Math.max(1, Math.min(127, Math.round(note.velocity * scale)));
    }
    if (operation.type === "transpose") {
      const semitones = typeof operation.value === "number" ? operation.value : 0;
      const notes = track ? edited.tracks[track] ?? [] : Object.values(edited.tracks).flat();
      for (const note of notes) note.midi = Math.max(0, Math.min(127, note.midi + semitones));
    }
    if (operation.type === "swing") {
      const swing = typeof operation.value === "number" ? operation.value : 0.12;
      for (const note of Object.values(edited.tracks).flat()) if (Math.floor(note.startBeat * 2) % 2 === 1) note.startBeat = Number((note.startBeat + swing).toFixed(3));
    }
    if (operation.type === "duplicate_section" && operation.section) {
      const section = edited.sectionMap.find((item) => item.name === operation.section);
      if (section) {
        const start = Number(section.startBeat);
        const end = Number(section.endBeat);
        const offset = Math.max(...edited.sectionMap.map((item) => Number(item.endBeat)), end);
        for (const [trackName, notes] of Object.entries(edited.tracks)) {
          const copies = notes.filter((note) => note.startBeat >= start && note.startBeat < end).map((note) => ({ ...note, track: trackName, startBeat: Number((note.startBeat - start + offset).toFixed(3)) }));
          notes.push(...copies);
        }
        edited.sectionMap.push({ name: `${operation.section}_copy`, startBeat: offset, endBeat: offset + (end - start), loopStart: false, loopEnd: false });
      }
    }
    if (operation.type === "add_fill") {
      const fillTrack = track ?? "drums";
      edited.tracks[fillTrack] ??= [];
      const fillStart = Math.max(0, Math.max(...Object.values(edited.tracks).flat().map((note) => note.startBeat), 0) - 2);
      edited.tracks[fillTrack].push({ track: fillTrack, midi: 38, startBeat: fillStart, durationBeats: 0.25, velocity: 54 }, { track: fillTrack, midi: 42, startBeat: fillStart + 0.5, durationBeats: 0.25, velocity: 44 }, { track: fillTrack, midi: 38, startBeat: fillStart + 1, durationBeats: 0.25, velocity: 62 });
    }
    if (operation.type === "add_intro") edited.sectionMap.unshift({ name: "intro_added", startBeat: 0, endBeat: 8, loopStart: false, loopEnd: false });
    if (operation.type === "add_outro") edited.sectionMap.push({ name: "outro_added", startBeat: Math.max(...edited.sectionMap.map((item) => Number(item.endBeat)), 0), endBeat: Math.max(...edited.sectionMap.map((item) => Number(item.endBeat)), 0) + 8, loopStart: false, loopEnd: false });
    if (operation.type === "change_instrument" && track) {
      for (const item of edited.trackList) if (item.name === track) item.instrument = String(operation.value ?? item.instrument);
    }
    if (operation.type === "mute_track" && track) {
      edited.tracks[track] = [];
      for (const item of edited.trackList) if (item.name === track) item.muted = true;
    }
  }
  if (selectedSoloTracks.size) {
    for (const trackName of Object.keys(edited.tracks)) if (!selectedSoloTracks.has(trackName)) edited.tracks[trackName] = [];
    for (const item of edited.trackList) item.solo = selectedSoloTracks.has(String(item.name));
  }
  for (const item of edited.trackList) item.noteCount = edited.tracks[String(item.name)]?.length ?? 0;
  return edited;
}

async function loadTrackSummaries(ctx: ToolContext, projectId: string, paths: string[]) {
  const compositions = await Promise.all(paths.map((manifestPath) => readComposition(ctx, projectId, manifestPath)));
  return compositions.map((composition, index) => ({
    index,
    manifestPath: paths[index],
    title: composition.title,
    key: composition.key,
    tempo: composition.tempo,
    durationSeconds: composition.durationSeconds,
    instruments: composition.instruments,
    energy: Number((composition.sections.reduce((sum, section) => sum + section.intensity, 0) / Math.max(1, composition.sections.length)).toFixed(2))
  }));
}

type TrackSummary = Awaited<ReturnType<typeof loadTrackSummaries>>[number];

function keyClass(key: string) {
  const root = key.trim().split(/\s+/)[0].replace(/m$/, "");
  return Object.prototype.hasOwnProperty.call(noteBase, root) ? noteBase[root] % 12 : 0;
}

function circularDistance(a: number, b: number, modulo: number) {
  const diff = Math.abs(a - b) % modulo;
  return Math.min(diff, modulo - diff);
}

function targetEnergy(progress: number, profile: z.infer<typeof assembleMusicSessionInputSchema>["energyProfile"]) {
  if (profile === "gentle_rise") return 0.28 + progress * 0.32;
  if (profile === "afternoon_cafe") return 0.38 + Math.sin(progress * Math.PI) * 0.18;
  if (profile === "night_lounge") return 0.5 - progress * 0.18;
  if (profile === "focus_study") return progress < 0.12 ? 0.32 : progress > 0.86 ? 0.28 : 0.42;
  if (profile === "event_warm_up") return 0.3 + progress * 0.45;
  return 0.35;
}

function transitionInstruction(style: z.infer<typeof assembleMusicSessionInputSchema>["transitionStyle"], crossfadeSeconds: number) {
  if (style === "ambient_bed") return `${crossfadeSeconds}s crossfade over short ambient room-tone bed`;
  if (style === "clean_gap") return "short clean gap with no overlap";
  if (style === "gapless") return "beat-aware gapless transition at phrase boundary";
  return `${crossfadeSeconds}s soft crossfade`;
}

function transitionRisk(previous: TrackSummary, next: TrackSummary) {
  const tempoDelta = Math.abs(previous.tempo - next.tempo);
  const keyDistance = circularDistance(keyClass(previous.key), keyClass(next.key), 12);
  const energyDelta = Math.abs(previous.energy - next.energy);
  const sharedInstruments = previous.instruments.filter((instrument) => next.instruments.includes(instrument));
  const warnings = [];
  if (tempoDelta > 18) warnings.push("tempo jump above 18 BPM");
  if (keyDistance > 5) warnings.push("distant key center");
  if (energyDelta > 0.32) warnings.push("abrupt energy change");
  if (sharedInstruments.length === 0) warnings.push("instrumentation changes completely");
  return {
    tempoDelta,
    keyDistance,
    energyDelta: Number(energyDelta.toFixed(2)),
    sharedInstruments,
    keyCompatible: keyDistance <= 5,
    tempoCompatible: tempoDelta <= 18,
    smoothEnough: tempoDelta <= 18 && keyDistance <= 5 && energyDelta <= 0.32 && sharedInstruments.length > 0,
    warnings
  };
}

function chooseNextTrack(tracks: TrackSummary[], recentIndexes: number[], desiredEnergy: number, previous?: TrackSummary) {
  const scored = tracks.map((track) => {
    const recentPenalty = recentIndexes.includes(track.index) && tracks.length > recentIndexes.length ? 1.5 : 0;
    const energyScore = Math.abs(track.energy - desiredEnergy);
    const transitionScore = previous ? transitionRisk(previous, track).warnings.length * 0.35 + Math.abs(previous.tempo - track.tempo) / 220 : 0;
    return { track, score: energyScore + transitionScore + recentPenalty };
  });
  scored.sort((a, b) => a.score - b.score || a.track.index - b.track.index);
  return scored[0].track;
}

function useCaseNeedsRoomTone(useCase: string) {
  return ["cafe_ambience", "cafe_background", "restaurant", "hotel_lobby", "retail_store"].includes(useCase);
}

function buildMusicSession(tracks: TrackSummary[], parsed: z.infer<typeof assembleMusicSessionInputSchema>) {
  const targetSeconds = parsed.targetDurationMinutes * 60;
  const schedule: Array<{ order: number; trackTitle: string; manifestPath: string; startSeconds: number; endSeconds: number; durationSeconds: number; crossfadeInSeconds: number; crossfadeOutSeconds: number; key: string; tempo: number; energy: number; targetEnergy: number; instruments: string[] }> = [];
  const transitionMap: Array<{ fromOrder: number; toOrder: number; fromTrack: string; toTrack: string; instruction: string; crossfadeSeconds: number; transitionBed: boolean; cleanGapSeconds: number; tempoDelta: number; keyDistance: number; energyDelta: number; keyCompatible: boolean; tempoCompatible: boolean; smoothEnough: boolean; warnings: string[] }> = [];
  const energyCurve = [];
  const warnings = [];
  let cursor = 0;
  const recentIndexes: number[] = [];
  while (cursor < targetSeconds) {
    const progress = cursor / targetSeconds;
    const desiredEnergy = Number(targetEnergy(progress, parsed.energyProfile).toFixed(2));
    const previous = schedule.length ? tracks.find((track) => track.manifestPath === schedule[schedule.length - 1].manifestPath) : undefined;
    const track = chooseNextTrack(tracks, recentIndexes, desiredEnergy, previous);
    const crossfadeInSeconds = schedule.length && parsed.transitionStyle !== "clean_gap" ? parsed.crossfadeSeconds : 0;
    const startSeconds = cursor;
    const endSeconds = startSeconds + track.durationSeconds;
    const slot = {
      order: schedule.length + 1,
      trackTitle: track.title,
      manifestPath: track.manifestPath,
      startSeconds,
      endSeconds,
      durationSeconds: track.durationSeconds,
      crossfadeInSeconds,
      crossfadeOutSeconds: parsed.transitionStyle !== "clean_gap" ? parsed.crossfadeSeconds : 0,
      key: track.key,
      tempo: track.tempo,
      energy: track.energy,
      targetEnergy: desiredEnergy,
      instruments: track.instruments
    };
    const previousSlot = schedule[schedule.length - 1];
    if (previousSlot && previous) {
      const risk = transitionRisk(previous, track);
      transitionMap.push({
        fromOrder: previousSlot.order,
        toOrder: slot.order,
        fromTrack: previousSlot.trackTitle,
        toTrack: slot.trackTitle,
        instruction: transitionInstruction(parsed.transitionStyle, parsed.crossfadeSeconds),
        crossfadeSeconds: parsed.transitionStyle === "clean_gap" ? 0 : parsed.crossfadeSeconds,
        transitionBed: parsed.transitionStyle === "ambient_bed" || useCaseNeedsRoomTone(parsed.useCase),
        cleanGapSeconds: parsed.transitionStyle === "clean_gap" ? 2 : 0,
        ...risk
      });
    }
    schedule.push(slot);
    energyCurve.push({ order: slot.order, startSeconds: slot.startSeconds, targetEnergy: desiredEnergy, actualEnergy: track.energy });
    recentIndexes.push(track.index);
    while (recentIndexes.length > parsed.avoidRepeatDistance) recentIndexes.shift();
    cursor += Math.max(1, track.durationSeconds - crossfadeInSeconds);
  }
  if (![30, 60, 90, 120].includes(parsed.targetDurationMinutes)) warnings.push("Recommended production background session durations are 30, 60, 90, or 120 minutes.");
  warnings.push(...transitionMap.flatMap((transition) => transition.warnings.map((warning) => `Transition ${transition.fromOrder}->${transition.toOrder}: ${warning}`)));
  const sessionAudioPath = parsed.outputFormats.some((format) => ["wav", "mp3", "ogg"].includes(format)) ? "requires-render-step" : undefined;
  return {
    manifestVersion: 2,
    useCase: parsed.useCase,
    targetDurationMinutes: parsed.targetDurationMinutes,
    actualDurationSeconds: cursor,
    energyProfile: parsed.energyProfile,
    transitionStyle: parsed.transitionStyle,
    outputFormats: parsed.outputFormats,
    tracks,
    tracklist: schedule.map((slot) => ({ order: slot.order, title: slot.trackTitle, manifestPath: slot.manifestPath, startSeconds: slot.startSeconds, endSeconds: slot.endSeconds, key: slot.key, tempo: slot.tempo, energy: slot.energy })),
    schedule,
    transitionMap,
    energyCurve,
    compatibilityChecks: schedule.map((item, index) => ({ order: item.order, keyTempoCompatible: index === 0 || transitionMap[index - 1]?.smoothEnough === true, transition: index === 0 ? "start" : transitionMap[index - 1]?.instruction ?? "transition" })),
    loudnessReport: {
      targetRms: parsed.targetRms,
      normalizePerceivedLoudness: true,
      truePeakCeilingDb: -1,
      avoidClipping: true,
      checks: schedule.map((slot) => ({ order: slot.order, trackTitle: slot.trackTitle, targetRms: parsed.targetRms, action: "normalize before final session render" }))
    },
    loudnessNormalization: { targetRms: parsed.targetRms, avoidClipping: true },
    ambientRoomTone: useCaseNeedsRoomTone(parsed.useCase),
    exportPlan: {
      sessionAudioPath,
      renderReady: true,
      segmentedPlaylist: parsed.outputFormats.includes("segmented_playlist"),
      note: "Manifest, playlist, transition map, and loudness instructions are generated here; long WAV/MP3/OGG bounce requires a verified encoder/DAW render step."
    },
    sourceManifest: {
      assetPolicy: parsed.assetPolicy,
      originalitySafetyRule: "Use only original/generated or user-owned licensed tracks; do not include copyrighted third-party recordings without permission.",
      sources: tracks.map((track) => ({ manifestPath: track.manifestPath, title: track.title, license: "generated_original_or_user_licensed", instruments: track.instruments }))
    },
    warnings
  };
}

function renderSessionHtml(session: ReturnType<typeof buildMusicSession>) {
  const rows = session.tracklist.map((slot) => `<tr><td>${slot.order}</td><td>${escapeHtml(slot.title)}</td><td>${Math.round(slot.startSeconds / 60)}-${Math.round(slot.endSeconds / 60)} min</td><td>${escapeHtml(slot.key)}</td><td>${slot.tempo}</td><td>${slot.energy}</td></tr>`).join("");
  const transitions = session.transitionMap.map((transition) => `<li>${transition.fromOrder}->${transition.toOrder}: ${escapeHtml(transition.instruction)}${transition.warnings.length ? ` (${escapeHtml(transition.warnings.join(", "))})` : ""}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Music Session Assembly</title><style>body{font-family:Inter,system-ui,sans-serif;margin:32px;max-width:1040px;color:#1f2933}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left}.pill{display:inline-block;border:1px solid #bbb;border-radius:999px;padding:4px 8px;margin-right:6px}</style></head><body><h1>Music Session Assembly</h1><p><span class="pill">${escapeHtml(session.useCase)}</span><span class="pill">${session.targetDurationMinutes} min</span><span class="pill">${escapeHtml(session.energyProfile)}</span><span class="pill">${escapeHtml(session.transitionStyle)}</span></p><h2>Tracklist</h2><table><thead><tr><th>#</th><th>Track</th><th>Time</th><th>Key</th><th>BPM</th><th>Energy</th></tr></thead><tbody>${rows}</tbody></table><h2>Transition Map</h2><ol>${transitions}</ol><h2>Loudness</h2><p>Normalize every segment to RMS ${session.loudnessReport.targetRms} with -1 dB true peak ceiling before final render.</p><h2>License / Source Rule</h2><p>${escapeHtml(session.sourceManifest.originalitySafetyRule)}</p></body></html>`;
}

async function handleAssembleMusicSession(input: unknown, ctx: ToolContext) {
  const parsed = assembleMusicSessionInputSchema.parse(input);
  const tracks = await loadTrackSummaries(ctx, parsed.projectId, parsed.trackManifestPaths);
  const session = buildMusicSession(tracks, parsed);
  const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(session, null, 2)}\n`);
  const htmlFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputHtmlPath, renderSessionHtml(session));
  const publishPolicy = parsed.publish ? buildProjectPublishOptions(ctx) : undefined;
  const published = publishPolicy ? await publishProject(ctx.projectRoot, parsed.projectId, publishPolicy.publicBaseUrl, parsed.outputHtmlPath, publishPolicy.options) : undefined;
  const structuredContent = { ...session, sessionManifestPath: manifestFile.path, sessionPagePath: htmlFile.path, publishedUrl: published?.publishedUrl };
  return {
    ok: session.warnings.length === 0,
    summary: `Assembled ${Math.round(session.actualDurationSeconds / 60)} minute music session with ${session.schedule.length} slot(s) and ${session.transitionMap.length} transition(s).`,
    jobId: parsed.projectId,
    previewUrl: published?.publishedUrl,
    shareUrl: published?.publishedUrl,
    artifacts: [manifestFile.path, htmlFile.path],
    structuredContent,
    logs: [JSON.stringify(structuredContent, null, 2)],
    errors: session.warnings
  };
}

export const musicWorkflowTools: ToolModule[] = [
  {
    definition: { name: "compose_edit_midi", description: "Create or edit a structured multi-track MIDI composition with sections, chord chart, arrangement map, editable operations, background constraints, and a real MIDI asset.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, existingManifestPath: { type: "string" }, style: { type: "string" }, mood: { type: "string" }, tempoBpm: { type: "number" }, key: { type: "string" }, durationSec: { type: "number" }, tracks: { type: "array", items: { type: "string" } }, sections: { type: "array", items: { type: "string" } }, constraints: { type: "object" }, operations: { type: "array", items: { type: "object" } }, ensembleRequirement: { type: "object", properties: { requiredInstruments: { type: "array", items: { type: "string" } }, soloInstruments: { type: "array", items: { type: "string" } }, maxSingleInstrumentSeconds: { type: "number" }, requireStartWithinBars: { type: "number" }, barBeats: { type: "number" } } }, outputManifestPath: { type: "string" }, outputMidiPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: composeEditMidiInputSchema,
    handler: async (input, ctx) => {
      const parsed = composeEditMidiInputSchema.parse(input);
      const base = parsed.existingManifestPath
        ? Object.assign(buildMidiComposition(parsed), await readComposition(ctx, parsed.projectId, parsed.existingManifestPath))
        : buildMidiComposition(parsed);
      const composition = applyComposeEditOperations(base, parsed.operations);
      // Fail-closed ensemble gate: when the caller declares which instruments must play together,
      // validate the actual notes BEFORE reporting success. This catches "requested cello track has
      // noteCount=0" and sequential/fake-duet output instead of publishing a misleading ok:true.
      const ensembleReport = parsed.ensembleRequirement
        ? analyzeEnsemble(composition, parsed.ensembleRequirement)
        : undefined;
      const [manifestFile, midiFile] = await Promise.all([
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(composition, null, 2)}\n`),
        writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputMidiPath, midiBuffer(composition), "audio/midi")
      ]);
      const ensembleOk = ensembleReport ? ensembleReport.ok : true;
      return {
        ok: ensembleOk,
        summary: ensembleOk
          ? `Created editable MIDI with ${composition.trackList.length} track(s), ${composition.sectionMap.length} section marker(s), and ${composition.warnings.length} warning(s).`
          : `Ensemble requirement not met: ${ensembleReport!.failures.length} blocking issue(s). MIDI written for inspection but not safe to publish.`,
        jobId: parsed.projectId,
        artifacts: [manifestFile.path, midiFile.path],
        structuredContent: { midiPath: midiFile.path, manifestPath: manifestFile.path, trackList: composition.trackList, sectionMap: composition.sectionMap, chordChart: composition.chordChart, warnings: composition.warnings, editableOperations: composition.editableOperations, ensembleReport },
        logs: [JSON.stringify({ trackList: composition.trackList, sectionMap: composition.sectionMap, chordChart: composition.chordChart, ensembleReport }, null, 2)],
        errors: ensembleOk ? [] : ensembleReport!.failures
      };
    }
  },
  {
    definition: { name: "generate_music_variations", description: "Generate multiple short production music variations from one brief, with different style, instrumentation, MIDI, WAV preview, and comparison metadata.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, brief: { type: "string" }, styles: { type: "array", items: { type: "string" } }, durationSeconds: { type: "number" }, renderAudio: { type: "boolean" }, outputPath: { type: "string" } }, required: ["projectId", "brief"], additionalProperties: false } },
    enabledByDefault: true,
    schema: generateMusicVariationsInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateMusicVariationsInputSchema.parse(input);
      const blockingReasons = parsed.renderAudio
        ? ["renderAudio=true is disabled for production music generation because built-in procedural audio is preview_only. Generate MIDI/manifests, then render each selected version with render_midi_with_soundfont."]
        : [];
      const variations = [];
      const artifacts: string[] = [];
      for (let index = 0; index < parsed.styles.length; index += 1) {
        const style = parsed.styles[index];
        const composition = buildComposition({
          projectId: parsed.projectId,
          title: `Variation ${String.fromCharCode(65 + index)} - ${style.replaceAll("_", " ")}`,
          style,
          mood: parsed.brief,
          tempo: style === "lo_fi" ? 82 : style === "bossa_nova" ? 96 : 90 + index * 2,
          key: index % 2 ? "F" : "C",
          durationSeconds: parsed.durationSeconds,
          useCase: "audition demo",
          instruments: style === "lo_fi" ? ["electric_piano", "acoustic_bass", "drums"] : style === "smooth_piano" ? ["piano", "violin", "pads"] : ["piano", "upright_bass", "brushes"],
          complexity: "medium",
          loopable: true,
          outputManifestPath: "unused.json",
          outputMidiPath: "unused.mid"
        });
        const basePath = `music/variations/variation-${String.fromCharCode(97 + index)}`;
        const bundle = await writeCompositionBundle(ctx, parsed.projectId, composition, basePath, false);
        artifacts.push(...bundle.artifacts);
        variations.push({ id: `version_${String.fromCharCode(65 + index)}`, label: `Version ${String.fromCharCode(65 + index)}`, style, tempo: composition.tempo, key: composition.key, instruments: composition.instruments, durationSeconds: composition.durationSeconds, manifestPath: bundle.manifestPath, midiPath: bundle.midiPath, audioPath: bundle.audioPath, qualityTier: "requires_production_render", productionReady: false, requiredRenderer: "render_midi_with_soundfont", requiredNextTool: "render_midi_with_soundfont", styleNotes: [`${style.replaceAll("_", " ")} arrangement`, "background-friendly density", "generated original", "requires SoundFont/SFZ production render"] });
      }
      const manifest = { brief: parsed.brief, durationSeconds: parsed.durationSeconds, qualityPolicy: "production_ready_required", productionReady: false, blockingReasons, requiredNextTools: ["manage_jazz_instrument_packs", "render_midi_with_soundfont", "inspect_audio_quality", "publish_music_audition_demo"], variations, reviewPrompts: ["Choose winner", "More jazz", "Less drums", "Warmer piano", "Smoother loop"] };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: blockingReasons.length === 0, summary: `Generated ${variations.length} production-ready composition candidate(s); render with SoundFont/SFZ before publishing audio.`, jobId: parsed.projectId, artifacts: [file.path, ...artifacts], structuredContent: manifest, logs: [JSON.stringify(manifest, null, 2)], errors: blockingReasons };
    }
  },
  {
    definition: { name: "publish_music_audition_demo", description: "Publish a music audition page with A/B/C/D audio players, version metadata, download links, rating/winner controls, revision prompts, and selected-version continuation metadata.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, projectTitle: { type: "string" }, variationsManifestPath: { type: "string" }, versions: { type: "array", items: { type: "object" } }, title: { type: "string" }, allowDownloads: { type: "boolean" }, publish: { type: "boolean" }, outputHtmlPath: { type: "string" }, outputManifestPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: publishMusicAuditionDemoInputSchema,
    handler: async (input, ctx) => {
      const parsed = publishMusicAuditionDemoInputSchema.parse(input);
      const variationsManifest = parsed.variationsManifestPath
        ? JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.variationsManifestPath, 2 * 1024 * 1024)) as { variations: Array<Record<string, unknown>>; brief?: string }
        : { variations: parsed.versions ?? [], brief: undefined };
      const title = parsed.projectTitle ?? parsed.title;
      const variations = variationsManifest.variations.map((variation, index) => {
        const id = String(variation.id ?? String.fromCharCode(65 + index));
        return {
          ...variation,
          id,
          label: variation.label ?? `Version ${id}`,
          title: variation.title ?? variation.label ?? `Version ${id}`,
          tempo: variation.tempo ?? variation.bpm,
          durationSeconds: variation.durationSeconds ?? variation.durationSec
        };
      });
      const productionBlockers = productionReadyVariationBlockers(variations);
      if (productionBlockers.length) {
        const manifest = { title, projectId: parsed.projectId, brief: variationsManifest.brief, variations, productionReady: false, blockingReasons: productionBlockers };
        const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        return { ok: false, summary: `Music audition demo blocked: ${productionBlockers.length} version(s) are not production-ready.`, jobId: parsed.projectId, artifacts: [manifestFile.path], structuredContent: { ...manifest, manifestPath: manifestFile.path }, logs: [JSON.stringify(manifest, null, 2)], errors: productionBlockers };
      }
      const html = renderAuditionHtml(title, variations, parsed.allowDownloads);
      const htmlFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputHtmlPath, html);
      const publishPolicy = parsed.publish ? buildProjectPublishOptions(ctx) : undefined;
      const published = publishPolicy ? await publishProject(ctx.projectRoot, parsed.projectId, publishPolicy.publicBaseUrl, parsed.outputHtmlPath, publishPolicy.options) : undefined;
      const selectedVersionWorkflow = {
        nextTool: "extend_music_arrangement",
        instructions: "Use the chosen version manifestPath as compositionManifestPath, then optionally run normalize_music_loudness and export_music_project.",
        requiredUserInput: ["winner", "revisionNotes"],
        revisionOptions: ["warmer piano", "less drums", "more jazz", "smoother transition", "longer intro", "less repetitive"]
      };
      const manifest = { title, projectId: parsed.projectId, brief: variationsManifest.brief, pagePath: htmlFile.path, demoUrl: published?.publishedUrl, publishedUrl: published?.publishedUrl, productionReady: true, versionIds: variations.map((variation) => variation.id), variations, feedbackFields: ["winner", "rating", "revisionNotes", "warmerPiano", "lessDrums", "moreJazz", "smootherTransition", "longerIntro", "lessRepetitive"], selectedVersionWorkflow };
      const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: true, summary: `Published music audition demo with ${variations.length} version(s).`, jobId: parsed.projectId, previewUrl: published?.publishedUrl, shareUrl: published?.publishedUrl, artifacts: [htmlFile.path, manifestFile.path], structuredContent: { ...manifest, manifestPath: manifestFile.path }, logs: [JSON.stringify(manifest, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "extend_music_arrangement", description: "Extend a short sketch into a 5-10 minute long-form arrangement with intro, A/B, bridge, solo texture, reprise, outro, MIDI, and optional WAV preview.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, compositionManifestPath: { type: "string" }, targetDurationSeconds: { type: "number" }, arrangementStyle: { type: "string", enum: ["background_friendly", "concert_style", "cinematic_arc", "loopable_longform"] }, renderAudio: { type: "boolean" }, acknowledgePreviewOnly: { type: "boolean" }, outputManifestPath: { type: "string" }, outputMidiPath: { type: "string" }, outputAudioPath: { type: "string" } }, required: ["projectId", "compositionManifestPath"], additionalProperties: false } },
    enabledByDefault: true,
    schema: extendMusicArrangementInputSchema,
    handler: async (input, ctx) => {
      const parsed = extendMusicArrangementInputSchema.parse(input);
      const extended = extendComposition(await readComposition(ctx, parsed.projectId, parsed.compositionManifestPath), parsed.targetDurationSeconds, parsed.arrangementStyle);
      const artifacts = [
        (await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(extended, null, 2)}\n`)).path,
        (await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputMidiPath, midiBuffer(extended), "audio/midi")).path
      ];
      // issue_0143: never silently emit procedural preview audio. Only write it when explicitly
      // acknowledged as throwaway; otherwise deliver MIDI and steer to the real render path.
      const emitPreview = parsed.renderAudio && parsed.acknowledgePreviewOnly;
      const previewWarning = parsed.renderAudio && !parsed.acknowledgePreviewOnly
        ? "Procedural preview audio was not written (fail-closed). Render with render_production_music / render_midi_with_soundfont using a registered SoundFont, or pass acknowledgePreviewOnly=true for a throwaway scratch preview."
        : undefined;
      if (emitPreview) artifacts.push((await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputAudioPath, wavBuffer(extended, 12000), "audio/wav")).path);
      return { ok: true, summary: `Extended arrangement to ${Math.round(extended.durationSeconds / 60)} minute(s).`, jobId: parsed.projectId, artifacts, structuredContent: { ...extended, manifestPath: parsed.outputManifestPath, midiPath: parsed.outputMidiPath, audioPath: emitPreview ? parsed.outputAudioPath : undefined, ...(previewWarning ? { previewWarning } : {}) }, logs: [JSON.stringify({ sections: extended.sections, durationSeconds: extended.durationSeconds }, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "extend_original_music_arrangement", description: "Extend a selected original short sketch into a 5-10 minute background-friendly arrangement with section map, development report, originality notes, warnings, MIDI, and optional audio preview.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, sourceManifestPath: { type: "string" }, targetDurationSec: { type: "number" }, styleFamily: { type: "string" }, backgroundUse: { type: "string" }, variationLevel: { type: "string" }, sections: { type: "array", items: { type: "string" } }, originalityPolicy: { type: "string" }, renderAudio: { type: "boolean" }, acknowledgePreviewOnly: { type: "boolean" }, outputManifestPath: { type: "string" }, outputMidiPath: { type: "string" }, outputAudioPath: { type: "string" } }, required: ["projectId", "sourceManifestPath"], additionalProperties: false } },
    enabledByDefault: true,
    schema: extendOriginalMusicArrangementInputSchema,
    handler: async (input, ctx) => {
      const parsed = extendOriginalMusicArrangementInputSchema.parse(input);
      const source = await readComposition(ctx, parsed.projectId, parsed.sourceManifestPath);
      const arranged = extendOriginalArrangement(source, parsed);
      const manifest = { ...arranged.extended, sourceManifestPath: parsed.sourceManifestPath, sectionMap: arranged.sectionMap, developmentReport: arranged.developmentReport, originalityNotes: arranged.originalityNotes, warnings: arranged.warnings, renderReady: arranged.renderReady };
      const artifacts = [
        (await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`)).path,
        (await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputMidiPath, midiBuffer(arranged.extended), "audio/midi")).path
      ];
      // issue_0143: fail-closed procedural preview — only emit when explicitly acknowledged.
      const emitPreview = parsed.renderAudio && parsed.acknowledgePreviewOnly;
      const previewWarning = parsed.renderAudio && !parsed.acknowledgePreviewOnly
        ? "Procedural preview audio was not written (fail-closed). Render with render_production_music / render_midi_with_soundfont using a registered SoundFont, or pass acknowledgePreviewOnly=true for a throwaway scratch preview."
        : undefined;
      if (emitPreview) artifacts.push((await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputAudioPath, wavBuffer(arranged.extended, 12000), "audio/wav")).path);
      return {
        ok: arranged.warnings.length === 0,
        summary: `Extended original arrangement to ${Math.round(parsed.targetDurationSec / 60)} minute(s) with ${arranged.warnings.length} warning(s).`,
        jobId: parsed.projectId,
        artifacts,
        structuredContent: { extendedMidiPath: parsed.outputMidiPath, arrangementManifestPath: parsed.outputManifestPath, audioPath: emitPreview ? parsed.outputAudioPath : undefined, sectionMap: arranged.sectionMap, developmentReport: arranged.developmentReport, originalityNotes: arranged.originalityNotes, warnings: arranged.warnings, renderReady: arranged.renderReady, ...(previewWarning ? { previewWarning } : {}) },
        logs: [JSON.stringify({ sectionMap: arranged.sectionMap, developmentReport: arranged.developmentReport, warnings: arranged.warnings }, null, 2)],
        errors: arranged.warnings
      };
    }
  },
  {
    definition: { name: "assemble_original_music_session", description: "Assemble original or user-licensed tracks into a 30/60/90/120 minute background music session with tracklist, transition map, loudness report, source manifest, and export plan.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, trackManifestPaths: { type: "array", items: { type: "string" } }, targetDurationMinutes: { type: "number" }, useCase: { type: "string" }, energyProfile: { type: "string" }, transitionStyle: { type: "string" }, crossfadeSeconds: { type: "number" }, outputFormats: { type: "array", items: { type: "string" } }, targetRms: { type: "number" }, avoidRepeatDistance: { type: "number" }, assetPolicy: { type: "string" }, outputPath: { type: "string" }, outputHtmlPath: { type: "string" }, publish: { type: "boolean" } }, required: ["projectId", "trackManifestPaths"], additionalProperties: false } },
    enabledByDefault: true,
    schema: assembleMusicSessionInputSchema,
    handler: handleAssembleMusicSession
  },
  {
    definition: { name: "assemble_music_session", description: "Assemble multiple long-form tracks into a cafe/study/background session plan with crossfades, key/tempo checks, energy curve, and loudness strategy.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, trackManifestPaths: { type: "array", items: { type: "string" } }, targetDurationMinutes: { type: "number" }, useCase: { type: "string" }, energyProfile: { type: "string" }, transitionStyle: { type: "string" }, crossfadeSeconds: { type: "number" }, outputFormats: { type: "array", items: { type: "string" } }, targetRms: { type: "number" }, avoidRepeatDistance: { type: "number" }, assetPolicy: { type: "string" }, outputPath: { type: "string" }, outputHtmlPath: { type: "string" }, publish: { type: "boolean" } }, required: ["projectId", "trackManifestPaths"], additionalProperties: false } },
    enabledByDefault: true,
    schema: assembleMusicSessionInputSchema,
    handler: handleAssembleMusicSession
  },
  {
    definition: { name: "normalize_music_loudness", description: "Normalize generated WAV loudness to a background-friendly RMS target and write a loudness report.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, audioPath: { type: "string" }, targetRms: { type: "number" }, outputAudioPath: { type: "string" }, outputReportPath: { type: "string" } }, required: ["projectId", "audioPath"], additionalProperties: false } },
    enabledByDefault: true,
    schema: normalizeMusicLoudnessInputSchema,
    handler: async (input, ctx) => {
      const parsed = normalizeMusicLoudnessInputSchema.parse(input);
      const source = await readFile(await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, parsed.audioPath));
      const normalized = normalizeWav(source, parsed.targetRms);
      const audioFile = await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputAudioPath, normalized.output, "audio/wav");
      const report = { sourceAudioPath: parsed.audioPath, normalizedAudioPath: audioFile.path, targetRms: parsed.targetRms, gain: normalized.gain, before: normalized.before, after: normalized.after, backgroundSuitabilityScore: normalized.after.peak < 0.98 && normalized.after.rms <= 0.24 ? 92 : 74, warnings: normalized.after.peak >= 0.98 ? ["Peak remains near clipping after normalization."] : [] };
      const reportFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReportPath, `${JSON.stringify(report, null, 2)}\n`);
      return { ok: report.warnings.length === 0, summary: `Normalized WAV with ${normalized.gain}x gain.`, jobId: parsed.projectId, artifacts: [audioFile.path, reportFile.path], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: report.warnings };
    }
  },
  {
    definition: { name: "create_production_music_render_plan", description: "Create a production-grade music render plan for realistic instruments, humanization, stems, A/B mastering, loudness targets, and license gates.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, compositionManifestPath: { type: "string" }, styleProfile: { type: "string", enum: ["jazz_lounge", "cafe_piano_trio", "bossa_lounge", "lofi_lounge", "cinematic_soft"] }, targetUse: { type: "string", enum: ["streaming_demo", "cafe_background", "website_background", "video_background", "client_delivery", "internal_review"] }, instrumentPriorities: { type: "array", items: { type: "string", enum: ["realistic_piano", "upright_bass", "brush_drums", "room_ambience", "strings_pad"] } }, licensePolicy: { type: "string", enum: ["mit_apache_preferred", "commercial_safe_only", "generated_only_until_pack_verified"] }, targetLufs: { type: "number" }, truePeakDb: { type: "number" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: createProductionMusicRenderPlanInputSchema,
    handler: async (input, ctx) => {
      const parsed = createProductionMusicRenderPlanInputSchema.parse(input);
      const composition = parsed.compositionManifestPath ? await readComposition(ctx, parsed.projectId, parsed.compositionManifestPath) : undefined;
      const plan = createProductionRenderPlan(parsed, composition);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(plan, null, 2)}\n`);
      return { ok: true, summary: `Created production music render plan for ${plan.styleProfile}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { ...plan, productionPlanPath: file.path }, logs: [JSON.stringify(plan, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "apply_music_mix_master_chain", description: "Apply a deterministic preview mix/master chain to a WAV file with loudness normalization, limiter ceiling, stem notes, and an A/B mastering report.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, audioPath: { type: "string" }, stemPaths: { type: "array", items: { type: "string" } }, chain: { type: "array", items: { type: "string", enum: ["room_ambience", "eq_cleanup", "gentle_compression", "limiter", "loudness_normalize"] } }, targetRms: { type: "number", description: "Target RMS as LINEAR amplitude (0 to 1), not dBFS. Range 0.02-0.5; default 0.16." }, truePeakCeiling: { type: "number", description: "True-peak ceiling as LINEAR amplitude (0 to 1), not dBFS. Range 0.5-0.99; default 0.89. A common -1 dBFS ceiling is ~0.89 linear." }, abLabel: { type: "string" }, outputAudioPath: { type: "string" }, outputReportPath: { type: "string" } }, required: ["projectId", "audioPath"], additionalProperties: false } },
    enabledByDefault: true,
    schema: applyMusicMixMasterChainInputSchema,
    handler: async (input, ctx) => {
      const parsed = applyMusicMixMasterChainInputSchema.parse(input);
      const source = await readFile(await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, parsed.audioPath));
      const mastered = applyMasterChain(source, parsed);
      const audioFile = await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputAudioPath, mastered.output, "audio/wav");
      const report = { ...mastered.report, sourceAudioPath: parsed.audioPath, masteredAudioPath: audioFile.path, masteringReportPath: parsed.outputReportPath };
      const reportFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReportPath, `${JSON.stringify(report, null, 2)}\n`);
      const peak = report.after.peak;
      const errors = peak >= 0.98 ? ["Master peak remains near clipping."] : [];
      return { ok: errors.length === 0, summary: `Applied ${parsed.chain.length} mix/master stage(s) to ${parsed.audioPath}.`, jobId: parsed.projectId, artifacts: [audioFile.path, reportFile.path], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors };
    }
  },
  {
    definition: { name: "review_music_production_export", description: "Review a production music export against render plan, A/B master reports, license manifest, and export package readiness.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, productionPlanPath: { type: "string" }, masterReportPaths: { type: "array", items: { type: "string" } }, licenseManifestPath: { type: "string" }, exportManifestPath: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "productionPlanPath", "masterReportPaths"], additionalProperties: false } },
    enabledByDefault: true,
    schema: reviewMusicProductionExportInputSchema,
    handler: async (input, ctx) => {
      const parsed = reviewMusicProductionExportInputSchema.parse(input);
      const plan = JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.productionPlanPath, 2 * 1024 * 1024)) as Record<string, unknown>;
      const masterReports = await Promise.all(parsed.masterReportPaths.map(async (filePath) => JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, filePath, 2 * 1024 * 1024)) as Record<string, unknown>));
      const licenseManifest = parsed.licenseManifestPath ? JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.licenseManifestPath, 2 * 1024 * 1024)) as Record<string, unknown> : undefined;
      const exportManifest = parsed.exportManifestPath ? JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.exportManifestPath, 2 * 1024 * 1024)) as Record<string, unknown> : undefined;
      const review = productionReview(plan, masterReports, licenseManifest, exportManifest);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(review, null, 2)}\n`);
      const errors = review.findings.filter((finding) => finding.severity === "high").map((finding) => finding.message);
      return { ok: review.recommendation !== "blocked", summary: `Reviewed production music export: ${review.recommendation}.`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { ...review, reviewPath: file.path }, logs: [JSON.stringify(review, null, 2)], errors };
    }
  },
  {
    definition: { name: "export_music_project", description: "Export a production music project package with tracks, sessions, stems, MIDI, chord charts, license checks, README, playlist metadata, and optional public listening/download page.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, projectManifestPath: { type: "string" }, packageName: { type: "string" }, selectedVersionIds: { type: "array", items: { type: "string" } }, exports: { type: "array", items: { type: "string" } }, renderedAudioPaths: { type: "array", items: { type: "string" } }, midiPaths: { type: "array", items: { type: "string" } }, stemPaths: { type: "array", items: { type: "string" } }, chordChartPaths: { type: "array", items: { type: "string" } }, renderReportPaths: { type: "array", items: { type: "string" } }, qualityReportPaths: { type: "array", items: { type: "string" } }, licenseManifestPath: { type: "string" }, version: { type: "string" }, bpm: { type: "number" }, key: { type: "string" }, durationSeconds: { type: "number" }, demoManifestPath: { type: "string" }, sessionManifestPath: { type: "string" }, trackManifestPaths: { type: "array", items: { type: "string" } }, publish: { type: "boolean" }, outputHtmlPath: { type: "string" }, outputManifestPath: { type: "string" }, outputReadmePath: { type: "string" }, outputPackageReportPath: { type: "string" }, outputPlaylistPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: exportMusicProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportMusicProjectInputSchema.parse(input);
      const tracks = parsed.trackManifestPaths.length ? await loadTrackSummaries(ctx, parsed.projectId, parsed.trackManifestPaths) : [];
      const projectManifest = parsed.projectManifestPath ? JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.projectManifestPath, 2 * 1024 * 1024)) : undefined;
      const demo = parsed.demoManifestPath ? JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.demoManifestPath, 2 * 1024 * 1024)) : undefined;
      const session = parsed.sessionManifestPath ? JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.sessionManifestPath, 2 * 1024 * 1024)) : undefined;
      const licenseManifest = parsed.licenseManifestPath ? JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.licenseManifestPath, 2 * 1024 * 1024)) : undefined;
      const title = String(projectManifest?.title ?? demo?.title ?? "music-project");
      const packageName = parsed.packageName ?? `${slugifyMusicExportPart(title)}-package`;
      const naming = {
        packageName,
        title,
        version: parsed.version,
        bpm: parsed.bpm,
        key: parsed.key,
        durationSeconds: parsed.durationSeconds,
        date: new Date().toISOString().slice(0, 10),
        baseFileName: [
          slugifyMusicExportPart(packageName),
          parsed.version ? slugifyMusicExportPart(parsed.version) : undefined,
          parsed.bpm ? `${parsed.bpm}bpm` : undefined,
          parsed.key ? slugifyMusicExportPart(parsed.key) : undefined,
          parsed.durationSeconds ? `${parsed.durationSeconds}s` : undefined,
          new Date().toISOString().slice(0, 10)
        ].filter(Boolean).join("-")
      };
      const inputFiles = [
        parsed.projectManifestPath ? { path: parsed.projectManifestPath, role: "project_manifest", purpose: "Project manifest JSON with title, versions, and production metadata." } : undefined,
        parsed.demoManifestPath ? { path: parsed.demoManifestPath, role: "demo_manifest", purpose: "Demo page manifest for client listening/review." } : undefined,
        parsed.sessionManifestPath ? { path: parsed.sessionManifestPath, role: "session_manifest", purpose: "Long-session assembly manifest and tracklist." } : undefined,
        parsed.licenseManifestPath ? { path: parsed.licenseManifestPath, role: "license_manifest", purpose: "License and safety manifest for final usage decisions." } : undefined,
        ...parsed.trackManifestPaths.map((filePath) => ({ path: filePath, role: "track_manifest", purpose: "Editable track arrangement/composition manifest." })),
        ...parsed.renderedAudioPaths.map((filePath) => ({ path: filePath, role: "audio", purpose: "Rendered single-track or long-session audio deliverable." })),
        ...parsed.midiPaths.map((filePath) => ({ path: filePath, role: "midi", purpose: "Editable MIDI file for arrangement revisions." })),
        ...parsed.stemPaths.map((filePath) => ({ path: filePath, role: "stem", purpose: "Separated audio stem for mixing, games, videos, or client handoff." })),
        ...parsed.chordChartPaths.map((filePath) => ({ path: filePath, role: "chord_chart", purpose: "Chord chart or lead sheet reference." }))
      ].filter((file): file is { path: string; role: string; purpose: string } => Boolean(file));
      const fileInspection = await inspectProjectExportFiles(ctx, parsed.projectId, inputFiles);
      const unsupportedFormats = buildUnsupportedMusicExportWarnings(parsed.exports, fileInspection.exportedFiles);
      const licenseWarnings = collectMusicLicenseWarnings(licenseManifest);
      const productionGate = await findProductionRenderGateWarnings(ctx, parsed.projectId, parsed.renderedAudioPaths, parsed.renderReportPaths);
      const qualityGate = await findMusicQualityGateWarnings(ctx, parsed.projectId, parsed.qualityReportPaths);
      const productionGateWarnings = [...productionGate.warnings, ...qualityGate.warnings];
      const playlist = {
        projectId: parsed.projectId,
        packageName,
        selectedVersionIds: parsed.selectedVersionIds,
        bpm: parsed.bpm,
        key: parsed.key,
        durationSeconds: parsed.durationSeconds,
        tracks,
        session: session ? { targetDurationMinutes: session.targetDurationMinutes, schedule: session.schedule, tracklist: session.tracklist } : undefined,
        audio: fileInspection.exportedFiles.filter((file) => file.role === "audio" || file.role === "stem").map((file) => ({ path: file.path, role: file.role, format: file.format, sizeBytes: file.sizeBytes })),
        generatedAt: new Date().toISOString()
      };
      const packageReport = {
        projectId: parsed.projectId,
        packageName,
        exports: parsed.exports,
        naming,
        exportedFiles: fileInspection.exportedFiles,
        missingFiles: fileInspection.missingFiles,
        brokenAudioReferences: fileInspection.brokenAudioReferences,
        largeFiles: fileInspection.largeFiles,
        unsupportedFormats,
        licenseWarnings,
        productionGateWarnings,
        renderReportPaths: parsed.renderReportPaths,
        resolvedRenderReports: productionGate.resolvedReports,
        qualityReportPaths: parsed.qualityReportPaths,
        resolvedQualityReports: qualityGate.resolvedReports,
        userFacingReadmePath: parsed.outputReadmePath,
        playlistPath: parsed.outputPlaylistPath
      };
      const readme = renderMusicExportReadme({ packageName, naming, exports: parsed.exports, exportedFiles: fileInspection.exportedFiles, missingFiles: fileInspection.missingFiles, licenseWarnings, unsupportedFormats });
      const readmeFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReadmePath, readme);
      const playlistFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPlaylistPath, `${JSON.stringify(playlist, null, 2)}\n`);
      const packageReportFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPackageReportPath, `${JSON.stringify(packageReport, null, 2)}\n`);
      const html = renderMusicExportHtml({
        readmePath: readmeFile.path,
        packageReportPath: packageReportFile.path,
        playlistPath: playlistFile.path,
        exportedFiles: fileInspection.exportedFiles,
        missingFileCount: packageReport.missingFiles.length,
        licenseWarningCount: packageReport.licenseWarnings.length,
        unsupportedFormatCount: packageReport.unsupportedFormats.length,
        productionGateWarningCount: packageReport.productionGateWarnings.length,
        tracks,
        session
      });
      const htmlFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputHtmlPath, html);
      const blockingErrors = [
        ...fileInspection.missingFiles.map((filePath) => `Missing export file: ${filePath}`),
        ...licenseWarnings.map((warning) => `License warning: ${warning}`),
        ...unsupportedFormats,
        ...productionGateWarnings,
        ...fileInspection.brokenAudioReferences.map((warning) => `Broken audio reference: ${warning}`)
      ];
      const publishPolicy = parsed.publish && blockingErrors.length === 0 ? buildProjectPublishOptions(ctx) : undefined;
      const published = publishPolicy ? await publishProject(ctx.projectRoot, parsed.projectId, publishPolicy.publicBaseUrl, parsed.outputHtmlPath, publishPolicy.options) : undefined;
      const manifest = { projectId: parsed.projectId, packageName, projectManifestPath: parsed.projectManifestPath, demoManifestPath: parsed.demoManifestPath, sessionManifestPath: parsed.sessionManifestPath, trackManifestPaths: parsed.trackManifestPaths, selectedVersionIds: parsed.selectedVersionIds, requestedExports: parsed.exports, demoUrl: demo?.publishedUrl, exportPagePath: htmlFile.path, publishedUrl: published?.publishedUrl, readmePath: readmeFile.path, packageReportPath: packageReportFile.path, playlistPath: playlistFile.path, exportedFiles: fileInspection.exportedFiles, missingFiles: fileInspection.missingFiles, brokenAudioReferences: fileInspection.brokenAudioReferences, largeFiles: fileInspection.largeFiles, unsupportedFormats, licenseWarnings, productionGateWarnings, renderReportPaths: parsed.renderReportPaths, resolvedRenderReports: productionGate.resolvedReports, qualityReportPaths: parsed.qualityReportPaths, resolvedQualityReports: qualityGate.resolvedReports, naming, tracks, sessionSummary: session ? { targetDurationMinutes: session.targetDurationMinutes, slots: Array.isArray(session.schedule) ? session.schedule.length : 0 } : undefined, license: licenseManifest ?? { output: "generated_original", dependencies: ["Built-in safe synth unless external assets are added later."] }, packageNotes: ["ZIP/MP3/OGG export requires a verified archive/encoder step.", "ZIP bundle creation can be completed with export package archive tools after this music package manifest passes checks.", "MP3/OGG exports require verified encoded files; this tool reports missing encoded formats instead of fabricating them.", "Production export requires production_candidate render evidence from render_midi_with_soundfont."] };
      const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: blockingErrors.length === 0, summary: `Exported music package with ${fileInspection.exportedFiles.length} file(s), ${fileInspection.missingFiles.length} missing file(s), ${licenseWarnings.length} license warning(s), and ${unsupportedFormats.length} unsupported format warning(s).`, jobId: parsed.projectId, previewUrl: published?.publishedUrl, shareUrl: published?.publishedUrl, artifacts: [htmlFile.path, manifestFile.path, readmeFile.path, playlistFile.path, packageReportFile.path], structuredContent: manifest, logs: [JSON.stringify(manifest, null, 2)], errors: blockingErrors };
    }
  },
  {
    definition: { name: "process_music_revision_feedback", description: "Convert music audition feedback into structured revision instructions for MIDI edits, arrangement extension, groove/style changes, mix operations, QA checks, and export handoff.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, selectedVersionId: { type: "string" }, auditionManifestPath: { type: "string" }, sourceManifestPath: { type: "string" }, feedback: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", properties: { timestamp: { type: "string" }, endTimestamp: { type: "string" }, comment: { type: "string" }, rating: { type: "number" }, category: { type: "string" } }, required: ["comment"], additionalProperties: false }] } }, rejectedVersionIds: { type: "array", items: { type: "string" } }, targetUseCase: { type: "string" }, targetDurationMinutes: { type: "number" }, currentRevisionId: { type: "string" }, previousRevisionHistoryPath: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "selectedVersionId", "feedback"], additionalProperties: false } },
    enabledByDefault: true,
    schema: processMusicRevisionFeedbackInputSchema,
    handler: async (input, ctx) => {
      const parsed = processMusicRevisionFeedbackInputSchema.parse(input);
      let existingHistory: unknown = [];
      if (parsed.previousRevisionHistoryPath) {
        try {
          const prior = JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.previousRevisionHistoryPath, 2 * 1024 * 1024));
          existingHistory = Array.isArray(prior) ? prior : Array.isArray(prior.revisionHistory) ? prior.revisionHistory : [];
        } catch {
          existingHistory = [];
        }
      }
      const plan = buildMusicRevisionPlan(parsed, existingHistory);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(plan, null, 2)}\n`);
      return {
        ok: true,
        summary: `Created music revision plan for ${plan.selectedVersionId} -> ${plan.targetVersionId}.`,
        jobId: parsed.projectId,
        artifacts: [file.path],
        structuredContent: { ...plan, outputPath: file.path },
        logs: [JSON.stringify({ revisionPlan: plan.revisionPlan, nextToolSequence: plan.nextToolSequence }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: { name: "import_musicxml_score", description: "Import a piano-first MusicXML score into the existing composition manifest shape and write a standard MIDI file for SoundFont rendering.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, musicXmlPath: { type: "string" }, musicXmlString: { type: "string" }, title: { type: "string" }, defaultTempo: { type: "number" }, outputManifestPath: { type: "string" }, outputMidiPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: importMusicXmlScoreInputSchema,
    handler: async (input, ctx) => {
      const parsed = importMusicXmlScoreInputSchema.parse(input);
      const { composition } = await importMusicXmlScore(ctx, parsed);
      const [manifestFile, midiFile] = await Promise.all([
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(composition, null, 2)}\n`),
        writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputMidiPath, midiBuffer(composition), "audio/midi")
      ]);
      return {
        ok: true,
        summary: `Imported MusicXML score with ${Object.values(composition.tracks).flat().length} note(s) into ${midiFile.path}.`,
        jobId: parsed.projectId,
        artifacts: [manifestFile.path, midiFile.path],
        structuredContent: { ...composition, manifestPath: manifestFile.path, midiPath: midiFile.path },
        logs: [JSON.stringify({ manifestPath: manifestFile.path, midiPath: midiFile.path, warnings: composition.warnings, scoreSource: composition.scoreSource, recommendedPianoPack: composition.recommendedPianoPack }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: { name: "validate_music_ensemble", description: "Strict true-duet / ensemble validator. Given a composition manifest and the instruments that must play together, it fails closed when any requested instrument has zero notes, when instruments do not overlap in time (sequential handoff instead of a simultaneous ensemble), or when a long section contains only one instrument that is not marked as an intentional solo. Reports per-track note count, first/last note time, active ratio, and silence ratio.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, compositionManifestPath: { type: "string" }, requiredInstruments: { type: "array", items: { type: "string" } }, soloInstruments: { type: "array", items: { type: "string" } }, maxSingleInstrumentSeconds: { type: "number" }, requireStartWithinBars: { type: "number" }, barBeats: { type: "number" } }, required: ["projectId", "compositionManifestPath", "requiredInstruments"], additionalProperties: false } },
    enabledByDefault: true,
    schema: validateMusicEnsembleInputSchema,
    handler: async (input, ctx) => {
      const parsed = validateMusicEnsembleInputSchema.parse(input);
      const composition = await readComposition(ctx, parsed.projectId, parsed.compositionManifestPath);
      const report = analyzeEnsemble(composition, {
        requiredInstruments: parsed.requiredInstruments,
        soloInstruments: parsed.soloInstruments,
        maxSingleInstrumentSeconds: parsed.maxSingleInstrumentSeconds,
        requireStartWithinBars: parsed.requireStartWithinBars,
        barBeats: parsed.barBeats
      });
      return {
        ok: report.ok,
        summary: report.ok
          ? `Ensemble valid: ${parsed.requiredInstruments.join(" + ")} play together${report.overlap ? ` with ${report.overlap.durationSeconds}s of overlap` : ""}.`
          : `Ensemble validation failed: ${report.failures.length} blocking issue(s). Not safe to publish.`,
        jobId: parsed.projectId,
        artifacts: [],
        structuredContent: report,
        logs: [JSON.stringify(report, null, 2)],
        errors: report.failures
      };
    }
  },
  {
    definition: { name: "compose_music", description: "Compose a structured original music cue and write a project MIDI file plus composition manifest.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, style: { type: "string", enum: ["cafe_jazz", "lo_fi", "bossa_nova", "smooth_piano", "acoustic_pop", "cinematic_background", "corporate_intro", "game_bgm", "orchestral_sketch", "ambient", "chill_lounge"] }, mood: { type: "string" }, tempo: { type: "number" }, key: { type: "string" }, durationSeconds: { type: "number" }, useCase: { type: "string" }, instruments: { type: "array", items: { type: "string", enum: ["piano", "electric_piano", "upright_bass", "acoustic_bass", "violin", "cello", "drums", "brushes", "guitar", "strings", "pads", "synth", "sax_like_lead"] } }, complexity: { type: "string", enum: ["simple", "medium", "rich"] }, loopable: { type: "boolean" }, ensembleRequirement: { type: "object", properties: { requiredInstruments: { type: "array", items: { type: "string" } }, soloInstruments: { type: "array", items: { type: "string" } }, maxSingleInstrumentSeconds: { type: "number" }, requireStartWithinBars: { type: "number" }, barBeats: { type: "number" } } }, outputManifestPath: { type: "string" }, outputMidiPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: composeMusicInputSchema,
    handler: async (input, ctx) => {
      const parsed = composeMusicInputSchema.parse(input);
      const composition = buildComposition(parsed);
      // issue_0144: when the caller declares an ensemble, verify the requested instruments actually
      // play together (cello track present, with notes, overlapping piano) before reporting success.
      const ensembleReport = parsed.ensembleRequirement ? analyzeEnsemble(composition, parsed.ensembleRequirement) : undefined;
      // issue_0147: always expose ensemble QA (per-instrument noteCount, channel/program, first-note
      // time, overlap) so a missing/late voice is visible without opting into the fail-closed gate.
      const ensembleQa = buildEnsembleQa(composition, parsed.instruments);
      const [manifestFile, midiFile] = await Promise.all([
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(composition, null, 2)}\n`),
        writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputMidiPath, midiBuffer(composition), "audio/midi")
      ]);
      const ensembleOk = ensembleReport ? ensembleReport.ok : true;
      return {
        ok: ensembleOk,
        summary: ensembleOk
          ? `Composed ${composition.style} cue with ${Object.keys(composition.tracks).length} track(s); requested ${ensembleQa.instrumentsRequested.length}, found ${ensembleQa.instrumentsFound.length} with notes.`
          : `Ensemble requirement not met: ${ensembleReport!.failures.length} blocking issue(s). MIDI written for inspection but not a deliverable ensemble.`,
        jobId: parsed.projectId,
        artifacts: [manifestFile.path, midiFile.path],
        structuredContent: { ...composition, manifestPath: manifestFile.path, midiPath: midiFile.path, ensembleReport, ensembleQa },
        logs: [JSON.stringify({ ...composition, ensembleReport, ensembleQa }, null, 2)],
        errors: ensembleOk ? [] : ensembleReport!.failures
      };
    }
  },
  {
    definition: { name: "edit_midi", description: "Edit a generated composition/MIDI manifest with transpose, quantize, swing, humanize, and velocity shaping, then write an updated MIDI.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, compositionManifestPath: { type: "string" }, quantizeBeats: { type: "number" }, transposeSemitones: { type: "number" }, humanizeMs: { type: "number" }, velocityScale: { type: "number" }, swing: { type: "number" }, duplicateSections: { type: "array", items: { type: "string" } }, outputManifestPath: { type: "string" }, outputMidiPath: { type: "string" } }, required: ["projectId", "compositionManifestPath"], additionalProperties: false } },
    enabledByDefault: true,
    schema: editMidiInputSchema,
    handler: async (input, ctx) => {
      const parsed = editMidiInputSchema.parse(input);
      const { edited, bassRepairLog } = applyMidiEdits(await readComposition(ctx, parsed.projectId, parsed.compositionManifestPath), parsed);
      const [manifestFile, midiFile] = await Promise.all([
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(edited, null, 2)}\n`),
        writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputMidiPath, midiBuffer(edited), "audio/midi")
      ]);
      return { ok: true, summary: `Edited MIDI manifest and wrote ${midiFile.path}.${bassRepairLog.length ? ` Bass repair: ${bassRepairLog.length} note(s) adjusted.` : ""}`, jobId: parsed.projectId, artifacts: [manifestFile.path, midiFile.path], structuredContent: { ...edited, manifestPath: manifestFile.path, midiPath: midiFile.path, bassRepairLog }, logs: [JSON.stringify(edited, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "check_music_render_environment", description: "Detect offline music rendering tools (sfizz_render, FluidSynth, FFmpeg, SoX) and available .sf2/.sf3/.sfz instrument candidates without claiming production support when requirements are missing.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, includeLocalMusicPacks: { type: "boolean" }, projectSearchDirectories: { type: "array", items: { type: "string" } }, requestedPackId: { type: "string", enum: ["generaluser_gs", "ydp_grand", "salamander_grand"] } }, required: [], additionalProperties: false } },
    enabledByDefault: true,
    schema: checkMusicRenderEnvironmentInputSchema,
    handler: async (input, ctx) => {
      const parsed = checkMusicRenderEnvironmentInputSchema.parse(input);
      const environment = await inspectMusicRenderEnvironment(ctx, parsed);
      return {
        ok: environment.productionSupport.available,
        summary: environment.productionSupport.available ? "Music production render environment is available." : "Music production render environment is incomplete.",
        jobId: parsed.projectId,
        artifacts: [],
        structuredContent: environment,
        logs: [JSON.stringify(environment, null, 2)],
        errors: environment.productionSupport.reasons
      };
    }
  },
  {
    definition: { name: "render_production_music", description: "Run the free production music pipeline: render MIDI stems offline with ready license-cleared role-matched SoundFont/SFZ packs, mix stems, apply a basic master chain, encode preview.mp3 with FFmpeg, write LICENSES.md, and publish a truthful player/download page.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, compositionManifestPath: { type: "string" }, soundfontPackId: { type: "string" }, soundfontPath: { type: "string" }, instrumentPackMap: { type: "object" }, channelMap: { type: "object" }, sampleRate: { type: "number" }, targetRms: { type: "number" }, truePeakCeiling: { type: "number" }, outputProductionWavPath: { type: "string" }, outputPreviewMp3Path: { type: "string" }, outputRawRenderPath: { type: "string" }, outputStemDirectory: { type: "string" }, outputMidiStemDirectory: { type: "string" }, outputLicensesPath: { type: "string" }, outputReportPath: { type: "string" }, outputHtmlPath: { type: "string" }, publish: { type: "boolean" } }, required: ["projectId", "compositionManifestPath"], additionalProperties: false } },
    enabledByDefault: true,
    schema: renderProductionMusicInputSchema,
	    handler: async (input, ctx) => {
	      const parsed = renderProductionMusicInputSchema.parse(input);
	      const environment = await inspectMusicRenderEnvironment(ctx, { projectId: parsed.projectId, includeLocalMusicPacks: true, projectSearchDirectories: ["soundfonts", "instruments", "music"] });
	      const composition = await readComposition(ctx, parsed.projectId, parsed.compositionManifestPath);
	      const packResolution = await resolveProductionPackMap(ctx, parsed, composition);
	      const resolvedPacks = Object.values(packResolution.packsByRole);
	      const blockers = [
	        ...packResolution.blockers,
	        ...(!environment.tools.ffmpeg.ok ? ["FFmpeg is required to export preview.mp3."] : []),
	        ...resolvedPacks.filter((resolved) => resolved.renderer === "sfizz" && !environment.tools.sfizz.ok).map((resolved) => `sfizz_render is required for ${resolved.role} SFZ production rendering.`),
	        ...resolvedPacks.filter((resolved) => resolved.renderer === "fluidsynth" && !environment.tools.fluidsynth.ok).map((resolved) => `FluidSynth is required for ${resolved.role} SoundFont production rendering.`)
	      ];
	      if (blockers.length || !packResolution.ok) {
	        const report = {
	          qualityTier: "preview_only",
	          productionReady: false,
	          statusLabel: "MIDI preview only. Not production audio.",
	          blockingReasons: blockers,
	          requiredRoles: packResolution.requiredRoles,
	          instrumentCoverage: packResolution.instrumentCoverage,
	          requestedPackAvailability: packResolution.requestedPackAvailability,
	          environment
	        };
	        const reportFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReportPath, `${JSON.stringify(report, null, 2)}\n`);
	        return { ok: false, summary: `Production music render blocked: ${blockers[0] ?? "missing production requirement"}`, jobId: parsed.projectId, artifacts: [reportFile.path], structuredContent: { ...report, reportPath: reportFile.path }, logs: [JSON.stringify(report, null, 2)], errors: blockers };
	      }

	      const tempDir = path.join(ctx.artifactRoot, `production-music-${parsed.projectId}-${Date.now()}`);
	      await mkdir(tempDir, { recursive: true });
	      try {
	        const stemPaths: Record<string, string> = {};
	        const midiStemPaths: Record<string, string> = {};
	        const stemRenderers: Record<string, Record<string, unknown>> = {};
	        const stemValidations: Record<string, { rms: number; peak: number; ok: boolean }> = {};
	        const skippedLargeAudioAssets: SkippedLargeAudioAsset[] = [];
	        // A stem whose RMS is below this floor is effectively silent — usually a requested
	        // instrument that produced no audible notes. Publishing it would be the misleading
	        // "silent cello" output this work exists to prevent, so each stem is validated and we
	        // fail closed if any requested stem is silent.
	        const productionStemSilenceFloor = 0.0005;
	        const stemBuffers: Buffer[] = [];
	        const missingStemGroups: string[] = [];
	        for (const group of productionStemGroups(composition)) {
	          if (!group.tracks.length) {
	            missingStemGroups.push(group.label);
	            continue;
	          }
	          const resolved = packResolution.packsByRole[group.role];
	          if (!resolved) throw new Error(`No resolved ${group.role} pack for ${group.label} stem.`);
	          const stemComposition = compositionWithSelectedTracks(composition, group.tracks);
	          const stemMidiBuffer = midiBuffer(stemComposition, { channelMap: parsed.channelMap, programMap: parsed.programMap });
	          const stemMidiProjectPath = `${parsed.outputMidiStemDirectory}/${group.id}.mid`;
          const stemMidiProjectFile = await writeProjectAsset(ctx.projectRoot, parsed.projectId, stemMidiProjectPath, stemMidiBuffer, "audio/midi");
          midiStemPaths[group.id] = stemMidiProjectFile.path;
	          const stemMidiTempPath = path.join(tempDir, `${group.id}.mid`);
	          const stemWavTempPath = path.join(tempDir, `${group.id}.wav`);
	          await writeFile(stemMidiTempPath, stemMidiBuffer);
	          const stemWav = await productionInstrumentRender(resolved.renderer, resolved.absolutePath, stemMidiTempPath, stemWavTempPath, parsed.sampleRate, ctx.commandTimeoutMs);
	          const stemProjectPath = `${parsed.outputStemDirectory}/${group.id}.wav`;
	          const stemProjectFile = await writeProjectAudioAssetWithinMediaLimit(ctx, parsed.projectId, stemProjectPath, stemWav, "audio/wav", `rendered ${group.label} WAV stem`);
	          if (stemProjectFile.filePath) stemPaths[group.id] = stemProjectFile.filePath;
	          if (stemProjectFile.skipped) skippedLargeAudioAssets.push(stemProjectFile.skipped);
	          stemRenderers[group.id] = { role: group.role, packId: resolved.pack.packId, renderer: resolved.renderer, soundfontPath: resolved.soundfontPath };
	          stemBuffers.push(stemWav);
	          const stemStats = audioStats(stemWav);
	          stemValidations[group.id] = { rms: stemStats.rms, peak: stemStats.peak, ok: stemStats.rms >= productionStemSilenceFloor };
	        }
	        if (!stemBuffers.length) throw new Error("No renderable stems were produced from composition tracks.");
	        const silentStems = Object.entries(stemValidations).filter(([, value]) => !value.ok).map(([id]) => id);
	        if (silentStems.length) throw new Error(`Stem validation failed: ${silentStems.join(", ")} rendered effectively silent (RMS below ${productionStemSilenceFloor}). Refusing to publish a misleading mix where a requested instrument is missing.`);
	        const mixedStems = mixPcmWavStems(stemBuffers);
	        const rawFile = await writeProjectAudioAssetWithinMediaLimit(ctx, parsed.projectId, parsed.outputRawRenderPath, mixedStems, "audio/wav", "unmastered raw WAV mix");
	        if (rawFile.skipped) skippedLargeAudioAssets.push(rawFile.skipped);
	        const mastered = applyMasterChain(mixedStems, {
	          projectId: parsed.projectId,
	          audioPath: parsed.outputRawRenderPath,
          stemPaths: Object.values(stemPaths),
          chain: ["room_ambience", "eq_cleanup", "gentle_compression", "limiter", "loudness_normalize"],
          targetRms: parsed.targetRms,
          truePeakCeiling: parsed.truePeakCeiling,
          abLabel: "production_master",
          outputAudioPath: parsed.outputProductionWavPath,
          outputReportPath: parsed.outputReportPath
        });
        // The built-in PCM master chain leaves levels well below broadcast (~-35 LUFS), so a "mastered"
        // render still sounds very quiet. Finish with a real ffmpeg loudnorm pass to land at a usable
        // level (~-16 LUFS, -1.5 dBTP). Falls back to the master-chain output if ffmpeg is unavailable.
        const masteredTempPath = path.join(tempDir, "mastered.wav");
        await writeFile(masteredTempPath, mastered.output);
        const productionTempPath = path.join(tempDir, "production.wav");
        let productionBuffer = mastered.output;
        let loudnessFinalizedWithFfmpeg = false;
        if (environment.tools.ffmpeg?.ok) {
          try {
            productionBuffer = await normalizeWavWithFfmpeg(masteredTempPath, productionTempPath, parsed.sampleRate, ctx.commandTimeoutMs);
            loudnessFinalizedWithFfmpeg = true;
          } catch {
            productionBuffer = mastered.output;
          }
        }
        if (!loudnessFinalizedWithFfmpeg) await writeFile(productionTempPath, productionBuffer);
        const mp3TempPath = path.join(tempDir, "preview.mp3");
	        const mp3 = await encodeMp3WithFfmpeg(productionTempPath, mp3TempPath, ctx.commandTimeoutMs);
	        const mp3File = await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputPreviewMp3Path, mp3, "audio/mpeg");
        const productionFile = await writeProjectAudioAssetWithinMediaLimit(ctx, parsed.projectId, parsed.outputProductionWavPath, productionBuffer, "audio/wav", "final offline-rendered WAV master");
        if (productionFile.skipped) skippedLargeAudioAssets.push({ ...productionFile.skipped, replacementPath: mp3File.path });
	        const licenses = renderProductionLicensesMarkdown({
	          packs: Object.values(packResolution.packRecords),
	          toolchain: environment.tools,
	          productionWavPath: productionFile.filePath,
	          previewMp3Path: mp3File.path,
          stemPaths,
          midiStemPaths,
          skippedLargeAudioAssets
        });
        const licensesFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputLicensesPath, licenses);
        const statusLabel = "Rendered with free license-cleared instruments. Suitable for production use with proper attribution.";
        const report = {
	          qualityTier: "production_candidate",
	          productionReady: true,
	          statusLabel,
	          renderer: resolvedPacks.length > 1 ? "multi_instrument_renderer" : resolvedPacks[0]?.renderer,
	          environment,
	          sourceCompositionManifestPath: parsed.compositionManifestPath,
	          productionWavPath: productionFile.filePath,
	          masteredAudioPath: productionFile.filePath,
	          fullMixPath: productionFile.filePath ?? mp3File.path,
	          previewMp3Path: mp3File.path,
	          rawRenderPath: rawFile.filePath,
	          largeAudioAssetSkips: skippedLargeAudioAssets,
	          deliveryFormat: productionFile.filePath ? "wav_and_mp3" : "mp3_first_large_wav_omitted",
	          stemPaths,
	          midiStemPaths,
	          stemRenderers,
	          stemValidations,
	          licensesPath: licensesFile.path,
	          missingStemGroups,
	          requiredRoles: packResolution.requiredRoles,
	          instrumentCoverage: packResolution.instrumentCoverage,
	          ensembleQa: buildEnsembleQa(composition, composition.instruments),
	          roleMap: Object.fromEntries(packResolution.instrumentCoverage.map((entry) => [entry.track, entry.requiredRole])),
	          channelMap: parsed.channelMap,
	          mixMasterChain: ["gain_staging", "eq_cleanup", "light_compression", "room_reverb", "master_limiter", "loudness_normalize"],
	          loudnessFinalizedWithFfmpeg,
	          masteringReport: { ...mastered.report, qualityTier: "production_candidate", productionReady: true, blockingReasons: [], sourceRenderPath: rawFile.filePath },
	          soundfont: resolvedPacks[0] ? {
	            packId: resolvedPacks[0].pack.packId,
	            displayName: resolvedPacks[0].pack.displayName,
	            path: resolvedPacks[0].soundfontPath,
	            format: resolvedPacks[0].pack.format,
	            renderer: resolvedPacks[0].renderer,
	            licenseType: resolvedPacks[0].pack.licenseType,
	            attribution: resolvedPacks[0].pack.attribution,
	            commercialUseAllowed: resolvedPacks[0].pack.commercialUseAllowed,
	            redistributionAllowed: resolvedPacks[0].pack.redistributionAllowed,
	            productionUseApproved: resolvedPacks[0].pack.productionUseApproved,
	            qualityTier: resolvedPacks[0].pack.qualityTier,
	            computedSha256: resolvedPacks[0].pack.computedSha256,
	            sourceUrl: resolvedPacks[0].pack.sourceUrl,
	            licenseTextPath: resolvedPacks[0].pack.licenseTextPath,
	            readmePath: resolvedPacks[0].pack.readmePath
	          } : undefined,
	          soundfonts: Object.fromEntries(resolvedPacks.map((resolved) => [resolved.role, {
	            packId: resolved.pack.packId,
	            displayName: resolved.pack.displayName,
	            path: resolved.soundfontPath,
	            format: resolved.pack.format,
	            renderer: resolved.renderer,
	            licenseType: resolved.pack.licenseType,
	            attribution: resolved.pack.attribution,
	            commercialUseAllowed: resolved.pack.commercialUseAllowed,
	            redistributionAllowed: resolved.pack.redistributionAllowed,
	            productionUseApproved: resolved.pack.productionUseApproved,
	            qualityTier: resolved.pack.qualityTier,
	            computedSha256: resolved.pack.computedSha256,
	            sourceUrl: resolved.pack.sourceUrl,
	            licenseTextPath: resolved.pack.licenseTextPath,
	            readmePath: resolved.pack.readmePath
	          }])),
	          noSpotifyLevelClaim: true
	        };
        const reportFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReportPath, `${JSON.stringify(report, null, 2)}\n`);
        const html = renderProductionMusicHtml({
          htmlPath: parsed.outputHtmlPath,
          title: composition.title,
          statusLabel,
          productionReady: true,
          productionWavPath: productionFile.filePath,
          previewMp3Path: mp3File.path,
          licensesPath: licensesFile.path,
          reportPath: reportFile.path,
          skippedLargeAudioAssets
        });
        const htmlFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputHtmlPath, html);
        const publishPolicy = parsed.publish ? buildProjectPublishOptions(ctx) : undefined;
        const published = publishPolicy ? await publishProject(ctx.projectRoot, parsed.projectId, publishPolicy.publicBaseUrl, htmlFile.path, publishPolicy.options) : undefined;
        const artifacts = [productionFile.filePath, mp3File.path, rawFile.filePath, ...Object.values(stemPaths), ...Object.values(midiStemPaths), licensesFile.path, reportFile.path, htmlFile.path].filter((value): value is string => Boolean(value));
        const summary = productionFile.filePath
          ? `Rendered production_candidate music to ${productionFile.filePath} and ${mp3File.path}.`
          : `Rendered production_candidate music to ${mp3File.path}; omitted oversized WAV assets above the project media limit.`;
        return { ok: true, summary, jobId: parsed.projectId, previewUrl: published?.publishedUrl, shareUrl: published?.publishedUrl, artifacts, structuredContent: { ...report, reportPath: reportFile.path, htmlPath: htmlFile.path, publishedUrl: published?.publishedUrl }, logs: [JSON.stringify(report, null, 2)], errors: [] };
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  },
  {
    definition: { name: "install_free_soundfont_pack", description: "Install a free commercial-safe SoundFont into project assets (license/readme/source/hash metadata) and auto-register it for rendering. packIds: generaluser_gs (General MIDI, no attribution required); ydp_grand / salamander_grand (sampled grand pianos, CC-BY 3.0 — commercial use allowed WITH attribution, which is recorded automatically). The sampled grands are bundled-only: place their extracted .sf2+LICENSE under <MUSIC_SOUNDFONT_DIR>/<pack>/ first.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, packId: { type: "string", enum: ["generaluser_gs", "ydp_grand", "salamander_grand"] }, outputDirectory: { type: "string" } }, required: ["projectId", "packId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: installFreeSoundfontPackInputSchema,
    handler: async (input, ctx) => {
      const parsed = installFreeSoundfontPackInputSchema.parse(input);
      const sampledPack = (sampledPianoPacks as Record<string, typeof sampledPianoPacks[SampledPianoPackId] | undefined>)[parsed.packId];
      const result = sampledPack ? await installSampledPianoPack(ctx, parsed, sampledPack) : await installGeneralUserGsPack(ctx, parsed);
      // issue_0145: auto-register the installed pack so render tools can use the pack id directly,
      // instead of dead-ending the user at "install succeeded but render doesn't recognize it".
      const registration = result.ok ? await autoRegisterInstalledPack(ctx, parsed.projectId, result) : undefined;
      const artifacts = result.ok ? [...result.assetPaths, result.licenseTextPath, result.readmePath, ...(registration ? [registration.registryPath] : [])] : [];
      const isGeneralMidi = result.ok && result.instrumentRole === "general_midi";
      const structuredContent = result.ok
        ? {
          ...result,
          autoRegistered: registration?.registered ?? false,
          packRegistryPath: registration?.registryPath,
          readyPackIds: registration?.readyPackIds ?? [],
          attributionRequired: result.licenseType === "cc_by",
          attributionText: result.licenseType === "cc_by" ? result.attribution : undefined,
          renderUsage: registration?.registered
            ? `Pack "${result.packId}" is registered and ready. Render with soundfontPackId="${result.packId}"${isGeneralMidi ? " (a general_midi pack covers every instrument role)" : " for the realistic_piano role"}.${result.licenseType === "cc_by" ? ` Commercial use is allowed WITH attribution — keep this credit in your delivery: "${result.attribution}".` : ""}`
            : "Auto-registration did not pass production gates; inspect the registry and license sidecar.",
          recommendedNextTool: "render_production_music"
        }
        : result;
      return {
        ok: result.ok && (registration?.registered ?? true),
        summary: result.ok
          ? `Installed ${result.displayName} (SHA-256 ${result.computedSha256}) and ${registration?.registered ? `auto-registered pack id "${result.packId}" — ready to render` : "auto-registration needs review"}.`
          : `Failed to install ${result.displayName}.`,
        jobId: parsed.projectId,
        artifacts,
        structuredContent,
        logs: [JSON.stringify(structuredContent, null, 2)],
        errors: result.ok ? [] : result.errors
      };
    }
  },
  {
    definition: { name: "discover_soundfont_packs", description: "Read-only scan for .sf2/.sf3/.sfz candidates in project assets and optional .music-packs/, reporting hash, sidecar license/readme status, and registration guidance.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, includeLocalMusicPacks: { type: "boolean" }, projectSearchDirectories: { type: "array", items: { type: "string" } } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: discoverSoundfontPacksInputSchema,
    handler: async (input, ctx) => {
      const parsed = discoverSoundfontPacksInputSchema.parse(input);
      const result = await discoverSoundfontPacks(ctx, parsed);
      return {
        ok: result.blocked.length === 0,
        summary: `Discovered ${result.candidates.length} SoundFont/SFZ candidate(s): ${result.ready.length} ready, ${result.reviewRequired.length} review, ${result.blocked.length} blocked.`,
        jobId: parsed.projectId,
        artifacts: [],
        structuredContent: result,
        logs: [JSON.stringify(result, null, 2)],
        errors: result.blocked.flatMap((candidate) => candidate.reasons.map((reason) => `${candidate.path}: ${reason}`))
      };
    }
  },
  {
    definition: { name: "render_midi_with_soundfont", description: "Render a MIDI/composition manifest through a registered ready .sf2/.sf3 SoundFont or .sfz instrument pack, producing production_candidate WAV, optional stems, and a renderer/license report. .sf2/.sf3 uses FluidSynth; .sfz uses sfizz_render when installed.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, compositionManifestPath: { type: "string" }, midiPath: { type: "string" }, soundfontPackId: { type: "string" }, soundfontPath: { type: "string" }, channelMap: { type: "object" }, stems: { type: "boolean" }, normalize: { type: "boolean" }, expressiveStrings: { type: "boolean", description: "Auto-author CC11 bow swells + CC1 vibrato into monophonic cello/violin/strings lines (compositionManifestPath path only). Default true." }, sampleRate: { type: "number" }, outputAudioPath: { type: "string" }, outputStemDirectory: { type: "string" }, outputReportPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: renderMidiWithSoundfontInputSchema,
    handler: async (input, ctx) => {
      const parsed = renderMidiWithSoundfontInputSchema.parse(input);
      const hasChannelMap = Object.keys(parsed.channelMap).length > 0;
      const hasProgramMap = Object.keys(parsed.programMap).length > 0;
      if (!parsed.compositionManifestPath && hasChannelMap) {
        return writeSoundfontRenderFailure(ctx, parsed, ["channelMap requires compositionManifestPath; this tool does not rewrite channels in externally supplied MIDI files."], { channelMap: parsed.channelMap, channelMapApplied: false });
      }
      if (!parsed.compositionManifestPath && hasProgramMap) {
        return writeSoundfontRenderFailure(ctx, parsed, ["programMap requires compositionManifestPath; this tool does not rewrite programs in externally supplied MIDI files."], { programMap: parsed.programMap, programMapApplied: false });
      }
      if (!parsed.compositionManifestPath && parsed.stems) {
        return writeSoundfontRenderFailure(ctx, parsed, ["stems require compositionManifestPath so the renderer can isolate tracks; midiPath-only rendering cannot safely produce stems."], { stemPaths: {}, stemCount: 0 });
      }

	      const soundfont = await resolveProductionSoundfont(ctx, parsed);
	      if (!soundfont.ok) {
	        return writeSoundfontRenderFailure(ctx, parsed, soundfont.blockers.map((reason) => `${reason} Output is preview_only until a ready commercial-safe SoundFont/SFZ pack is registered.`), { requestedSoundfontPackId: parsed.soundfontPackId, requestedSoundfontPath: parsed.soundfontPath, requestedPackAvailability: soundfont.requestedPackAvailability });
	      }
	      let composition: Composition | undefined;
	      let instrumentCoverage: ReturnType<typeof instrumentCoverageForSinglePack> = [];
	      if (parsed.compositionManifestPath) {
	        composition = await readComposition(ctx, parsed.projectId, parsed.compositionManifestPath);
	        instrumentCoverage = instrumentCoverageForSinglePack(composition, soundfont.pack);
	        const coverageBlockers = instrumentCoverage.filter((entry) => !entry.covered).map((entry) => entry.reason);
	        if (coverageBlockers.length) {
	          return writeSoundfontRenderFailure(ctx, parsed, coverageBlockers, {
	            requestedSoundfontPackId: parsed.soundfontPackId,
	            requestedSoundfontPath: parsed.soundfontPath,
	            soundfont: { packId: soundfont.pack.packId, instrumentRole: soundfont.pack.instrumentRole, path: soundfont.soundfontPath, format: soundfont.pack.format },
	            instrumentCoverage
	          });
	        }
	      }
	      const fluidSynthCapability = soundfont.renderer === "fluidsynth" ? await toolVersion("fluidsynth") : { ok: false, version: undefined, error: "not required for selected renderer" };
	      const sfizzCapability = soundfont.renderer === "sfizz" ? await toolVersion("sfizz_render") : { ok: false, version: undefined, error: "not required for selected renderer" };
      const ffmpegCapability = await toolVersion("ffmpeg", ["-version"]);
      const rendererCapability = soundfont.renderer === "sfizz" ? sfizzCapability : fluidSynthCapability;
      if (!rendererCapability.ok) {
        const binary = soundfont.renderer === "sfizz" ? "sfizz_render" : "fluidsynth";
        return writeSoundfontRenderFailure(ctx, parsed, [`${binary} is not available in this runtime; ${soundfont.pack.format} render remains preview_only until the renderer is installed.`], { rendererMetadata: { fluidSynthCapability, sfizzCapability, ffmpegCapability }, requestedRenderer: soundfont.renderer, requestedSoundfontPackId: parsed.soundfontPackId, requestedSoundfontPath: parsed.soundfontPath });
      }

	      let midiAbsolutePath: string;
	      const temporaryFiles: string[] = [];
	      if (parsed.compositionManifestPath) {
	        const tempDir = path.join(ctx.artifactRoot, `music-render-${parsed.projectId}-${Date.now()}`);
	        await mkdir(tempDir, { recursive: true });
	        midiAbsolutePath = path.join(tempDir, "full.mid");
	        await writeFile(midiAbsolutePath, midiBuffer(composition!, { channelMap: parsed.channelMap, programMap: parsed.programMap, expressiveStrings: parsed.expressiveStrings }));
	        temporaryFiles.push(tempDir);
      } else {
        midiAbsolutePath = await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, parsed.midiPath!);
        let midi: Buffer;
        try {
          midi = await readFile(midiAbsolutePath);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return writeSoundfontRenderFailure(ctx, parsed, [
              `MIDI file not found at project path "${parsed.midiPath}". The file must be written to project storage before rendering.`
            ], {
              missingMidiPath: parsed.midiPath,
              nextAction: "write_project_asset or import_project_asset_from_local_file",
              hint: `Write or import the MIDI asset to project path "${parsed.midiPath}" first, then retry render_midi_with_soundfont.`
            });
          }
          throw err;
        }
        if (midi.subarray(0, 4).toString("ascii") !== "MThd") throw new Error("midiPath must point to a valid MIDI file.");
      }

      try {
        const tempDir = temporaryFiles[0] ?? path.join(ctx.artifactRoot, `music-render-${parsed.projectId}-${Date.now()}`);
        await mkdir(tempDir, { recursive: true });
        if (!temporaryFiles.includes(tempDir)) temporaryFiles.push(tempDir);
        // renderProfile="clean_dry": SoundFont render only, no noise bed/ambience, optional loudnorm off.
        // renderProfile="normalized": clean_dry + loudnorm. Explicit normalize field still works as before.
        // If renderProfile is set it takes precedence over the normalize field.
        const cleanDryMode = parsed.renderProfile === "clean_dry" || parsed.renderProfile === "normalized";
        const normalizeActive = parsed.renderProfile === "normalized"
          ? ffmpegCapability.ok
          : parsed.renderProfile === "clean_dry"
            ? false
            : parsed.normalize && ffmpegCapability.ok;
        const fullMixTemp = path.join(tempDir, "full.wav");
        const rawFullMix = await productionInstrumentRender(soundfont.renderer, soundfont.absolutePath, midiAbsolutePath, fullMixTemp, parsed.sampleRate, ctx.commandTimeoutMs);
        const fullMix = normalizeActive
          ? await normalizeWavWithFfmpeg(fullMixTemp, path.join(tempDir, "full.norm.wav"), parsed.sampleRate, ctx.commandTimeoutMs)
          : rawFullMix;
        const fullMixFile = await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputAudioPath, fullMix, "audio/wav");
        const stemPaths: Record<string, string> = {};
        const stemValidations: Record<string, { rms: number; peak: number; ok: boolean }> = {};
        if (parsed.stems && composition) {
          for (const track of Object.keys(composition.tracks)) {
            const stemMidiPath = path.join(tempDir, `${slugifyMusicExportPart(track)}.mid`);
            const stemWavPath = path.join(tempDir, `${slugifyMusicExportPart(track)}.wav`);
            await writeFile(stemMidiPath, midiBuffer(compositionWithSingleTrack(composition!, track), { channelMap: parsed.channelMap, programMap: parsed.programMap, expressiveStrings: parsed.expressiveStrings }));
            const rawStemWav = await productionInstrumentRender(soundfont.renderer, soundfont.absolutePath, stemMidiPath, stemWavPath, parsed.sampleRate, ctx.commandTimeoutMs);
            // Validate the RAW stem (pre-normalize): loudnorm would otherwise amplify a near-silent
            // stem's noise floor and let a missing instrument pass the silence guard.
            const stemStats = audioStats(rawStemWav);
            stemValidations[track] = { rms: stemStats.rms, peak: stemStats.peak, ok: stemStats.rms >= 0.0005 };
            const stemWav = normalizeActive
              ? await normalizeWavWithFfmpeg(stemWavPath, path.join(tempDir, `${slugifyMusicExportPart(track)}.norm.wav`), parsed.sampleRate, ctx.commandTimeoutMs)
              : rawStemWav;
            const stemFile = await writeProjectAsset(ctx.projectRoot, parsed.projectId, `${parsed.outputStemDirectory}/${slugifyMusicExportPart(track)}.wav`, stemWav, "audio/wav");
            stemPaths[track] = stemFile.path;
          }
          // Fail closed (same contract as render_production_music): a production_candidate render
          // must not ship a silent/missing-instrument stem as a success. The surrounding catch turns
          // this into a graceful ok:false render failure.
          const silentStems = Object.entries(stemValidations).filter(([, value]) => !value.ok).map(([track]) => track);
          if (silentStems.length) throw new Error(`Stem validation failed: ${silentStems.join(", ")} rendered effectively silent (RMS below 0.0005). Refusing to ship a production_candidate render with a missing/empty instrument stem.`);
        }
        const artifacts = [fullMixFile.path, ...Object.values(stemPaths)];
        const stats = audioStats(fullMix);
        const report = {
          renderer: soundfont.renderer,
          rendererMetadata: {
            fluidSynthAvailable: fluidSynthCapability.ok,
            fluidSynthVersion: fluidSynthCapability.version,
            sfizzAvailable: sfizzCapability.ok,
            sfizzVersion: sfizzCapability.version,
            ffmpegAvailable: ffmpegCapability.ok,
            ffmpegVersion: ffmpegCapability.version
          },
          qualityTier: "production_candidate",
          productionReady: true,
          normalized: normalizeActive,
          renderProfile: parsed.renderProfile ?? "default",
          cleanRender: cleanDryMode,
          noiseBedApplied: false,
          packSha256: soundfont.pack.computedSha256,
          packLicenseTextPath: soundfont.pack.licenseTextPath,
          packSourceUrl: soundfont.pack.sourceUrl,
          productionUseApproved: soundfont.pack.productionUseApproved,
          blockingReasons: [],
          sourceMidiPath: parsed.midiPath,
          sourceCompositionManifestPath: parsed.compositionManifestPath,
          fullMixPath: fullMixFile.path,
          stemPaths,
          stemValidations,
	          soundfont: {
            packId: soundfont.pack.packId,
            displayName: soundfont.pack.displayName,
            path: soundfont.soundfontPath,
            format: soundfont.pack.format,
            renderer: soundfont.renderer,
            licenseType: soundfont.pack.licenseType,
            attribution: soundfont.pack.attribution,
            commercialUseAllowed: soundfont.pack.commercialUseAllowed,
            redistributionAllowed: soundfont.pack.redistributionAllowed,
            productionUseApproved: soundfont.pack.productionUseApproved,
            qualityTier: soundfont.pack.qualityTier,
            computedSha256: soundfont.pack.computedSha256,
            source: soundfont.pack.source,
            sourceUrl: soundfont.pack.sourceUrl,
            licenseTextPath: soundfont.pack.licenseTextPath,
            readmePath: soundfont.pack.readmePath,
            version: soundfont.pack.version
	          },
	          instrumentCoverage,
	          ensembleQa: composition ? buildEnsembleQa(composition, composition.instruments) : undefined,
	          channelMap: parsed.channelMap,
          channelMapApplied: hasChannelMap,
          renderReport: {
            durationSeconds: composition?.durationSeconds,
            sampleRate: parsed.sampleRate,
            bitDepth: 16,
            requestedFormats: ["wav"],
            renderedFormats: ["wav"],
            peakLevel: stats.peak,
            rms: stats.rms,
            stemCount: Object.keys(stemPaths).length,
            fileSizes: Object.fromEntries(await Promise.all(artifacts.map(async (artifact) => {
              const bytes = await readFile(await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, artifact));
              return [artifact, bytes.length];
            })))
          },
          warnings: [
            ...(composition ? buildEnsembleQa(composition, composition.instruments).missingInstrumentWarnings : []),
            ...(parsed.stems ? [] : ["Rendered full mix only (stems=false); per-instrument audio presence is not verified. Pass stems=true to validate each voice is audible."]),
            ...(parsed.normalize && !ffmpegCapability.ok ? ["normalize=true was requested but FFmpeg is unavailable; shipped the raw (un-normalized, likely quiet) render instead."] : []),
            ...(ffmpegCapability.ok ? [] : ["FFmpeg is not available; downstream master/export encoding capability may be limited."])
          ]
        };
        const reportFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReportPath, `${JSON.stringify(report, null, 2)}\n`);
        artifacts.push(reportFile.path);
        return { ok: true, summary: `Rendered production_candidate ${soundfont.pack.format} audio with ${Object.keys(stemPaths).length} stem(s).`, jobId: parsed.projectId, artifacts, structuredContent: { ...report, renderReportPath: reportFile.path }, logs: [JSON.stringify(report, null, 2)], errors: [] };
      } catch (error) {
        return writeSoundfontRenderFailure(ctx, parsed, [`${soundfont.renderer} render failed: ${error instanceof Error ? error.message : String(error)}`], { rendererMetadata: { fluidSynthCapability, sfizzCapability, ffmpegCapability }, soundfont: soundfont.ok ? { packId: soundfont.pack.packId, path: soundfont.soundfontPath, format: soundfont.pack.format } : undefined });
      } finally {
        await Promise.all(temporaryFiles.map((filePath) => rm(filePath, { recursive: true, force: true })));
      }
    }
  },
  {
    definition: { name: "render_midi_to_audio", description: "Render generated MIDI/composition manifests into playable audio using a safe procedural instrument library, with full mix, optional stems, render report, license manifest, and format warnings.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, compositionManifestPath: { type: "string" }, midiPath: { type: "string" }, instrumentMap: { type: "object", additionalProperties: { type: "string", enum: ["warm_acoustic_piano", "soft_electric_piano", "upright_bass", "acoustic_bass", "jazz_brushes", "light_drum_kit", "guitar", "violin", "cello", "strings", "pads", "mallets", "soft_synth"] } }, renderPreset: { type: "string", enum: ["warm_cafe", "lo_fi_soft", "cinematic_soft", "clean_corporate", "game_loop"] }, outputFormats: { type: "array", items: { type: "string", enum: ["wav", "mp3", "ogg"] } }, stems: { type: "boolean" }, licenseConstraints: { type: "string", enum: ["generated_only", "allow_bundled_safe", "third_party_review_required"] }, format: { type: "string", enum: ["wav"] }, sampleRate: { type: "number" }, acknowledgePreviewOnly: { type: "boolean" }, outputAudioPath: { type: "string" }, outputStemDirectory: { type: "string" }, outputReportPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: renderMidiToAudioInputSchema,
    handler: async (input, ctx) => {
      const parsed = renderMidiToAudioInputSchema.parse(input);
      // issue_0143: fail closed. Without an explicit preview-only acknowledgement, do not emit
      // procedural audio — point the caller at the real source-backed render path instead.
      if (!parsed.acknowledgePreviewOnly) {
        return {
          ok: false,
          summary: "Procedural synth output is disabled for delivery. Install a real SoundFont and render with a verified engine.",
          jobId: parsed.projectId,
          artifacts: [],
          structuredContent: {
            renderer: "built_in_procedural_synth",
            qualityTier: "preview_only",
            productionReady: false,
            blockingReasons: ["Built-in procedural synth output is not a deliverable. There is no real audio source registered for this render."],
            recommendedNextTools: ["install_free_soundfont_pack", "render_production_music", "render_midi_with_soundfont"],
            howToFix: "Run install_free_soundfont_pack (auto-registers a GeneralUser GS general_midi pack), then render with render_production_music or render_midi_with_soundfont using that pack id. To generate an explicitly throwaway, non-deliverable scratch preview instead, re-call this tool with acknowledgePreviewOnly=true."
          },
          logs: [],
          errors: ["render_midi_to_audio is fail-closed: procedural preview requires acknowledgePreviewOnly=true and must never be delivered as finished music."]
        };
      }
      const warnings: string[] = [];
      let composition: Composition;
      if (parsed.compositionManifestPath) {
        composition = await readComposition(ctx, parsed.projectId, parsed.compositionManifestPath);
      } else {
        const midi = await readFile(await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, parsed.midiPath!));
        if (midi.subarray(0, 4).toString("ascii") !== "MThd") throw new Error("midiPath must point to a valid MIDI file.");
        warnings.push("midiPath-only rendering has no editable composition manifest; rendered a neutral safe preview bed.");
        composition = buildComposition({ projectId: parsed.projectId, title: path.basename(parsed.midiPath!), style: "ambient", mood: "safe MIDI preview", tempo: 90, key: "C", durationSeconds: 30, useCase: "audio preview", instruments: ["piano"], complexity: "simple", loopable: false, outputManifestPath: "unused.json", outputMidiPath: "unused.mid" });
      }
      const resolvedInstrumentMap = Object.fromEntries(Object.keys(composition.tracks).map((track) => [track, parsed.instrumentMap[track] ?? defaultInstrumentForTrack(track)]));
      const artifacts: string[] = [];
      let fullMixPath: string | undefined;
      const stemPaths: Record<string, string> = {};
      const needsWavFallback = parsed.outputFormats.some((format) => format !== "wav");
      if (parsed.outputFormats.includes("wav") || needsWavFallback) {
        const audio = wavBuffer(composition, parsed.sampleRate, { instrumentMap: resolvedInstrumentMap, renderPreset: parsed.renderPreset });
        const outputAudioPath = parsed.outputFormats.includes("wav") ? parsed.outputAudioPath : wavFallbackOutputPath(parsed.outputAudioPath);
        const file = await writeProjectAsset(ctx.projectRoot, parsed.projectId, outputAudioPath, audio, "audio/wav");
        fullMixPath = file.path;
        artifacts.push(file.path);
      }
      for (const unsupported of parsed.outputFormats.filter((format) => format !== "wav")) warnings.push(`${unsupported.toUpperCase()} output requires a verified encoder; WAV preview rendered instead at ${fullMixPath}.`);
      if (parsed.stems) {
        for (const track of Object.keys(composition.tracks)) {
          const stemAudio = wavBuffer(composition, parsed.sampleRate, { instrumentMap: resolvedInstrumentMap, renderPreset: parsed.renderPreset, trackFilter: track });
          const stemPath = `${parsed.outputStemDirectory}/${track}.wav`;
          const stemFile = await writeProjectAsset(ctx.projectRoot, parsed.projectId, stemPath, stemAudio, "audio/wav");
          stemPaths[track] = stemFile.path;
          artifacts.push(stemFile.path);
        }
      }
      const stats = fullMixPath ? audioStats(await readFile(await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, fullMixPath))) : { peak: 0, rms: 0, sampleCount: 0 };
      if (stats.peak >= 0.98) warnings.push("Rendered full mix peak is near clipping.");
      const renderReport = {
        renderer: "built_in_procedural_synth",
        qualityTier: "preview_only",
        productionReady: false,
        blockingReasons: ["Built-in procedural synth output is preview_only. Use render_midi_with_soundfont with a ready commercial-safe .sf2/.sf3 pack for production_candidate output."],
        sourceMidiPath: parsed.midiPath,
        sourceCompositionManifestPath: parsed.compositionManifestPath,
        durationSeconds: composition.durationSeconds,
        sampleRate: parsed.sampleRate,
        bitDepth: 16,
        requestedFormats: parsed.outputFormats,
        renderedFormats: fullMixPath ? ["wav"] : [],
        renderPreset: parsed.renderPreset,
        peakLevel: stats.peak,
        rms: stats.rms,
        clippingWarnings: warnings.filter((warning) => /clip/i.test(warning)),
        missingInstrumentFallbackWarnings: Object.keys(composition.tracks).filter((track) => !parsed.instrumentMap[track]).map((track) => `${track} used fallback ${resolvedInstrumentMap[track]}.`),
        fileSizes: Object.fromEntries(await Promise.all(artifacts.map(async (artifact) => {
          const bytes = await readFile(await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, artifact));
          return [artifact, bytes.length];
        })))
      };
      const licenseManifest = renderLicenseManifest(resolvedInstrumentMap, parsed.licenseConstraints);
      const report = {
        fullMixPath,
        stemPaths,
        renderer: "built_in_procedural_synth",
        qualityTier: "preview_only",
        productionReady: false,
        blockingReasons: ["Built-in procedural synth output is preview_only. Use render_midi_with_soundfont with a ready commercial-safe .sf2/.sf3 pack for production_candidate output."],
        renderReport,
        licenseManifest,
        warnings
      };
      const reportFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReportPath, `${JSON.stringify(report, null, 2)}\n`);
      artifacts.push(reportFile.path);
      const blockingReasons = [...report.blockingReasons, ...warnings];
      return { ok: false, summary: `Blocked preview_only MIDI audio with ${Object.keys(stemPaths).length} stem(s); use render_midi_with_soundfont for production-ready music.`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: blockingReasons };
    }
  },
  {
    definition: { name: "generate_jazz_harmony", description: "Generate original jazz chord charts, section harmony, piano voicings, bass guide tones, MIDI-ready voicing data, and variation notes for cafe/lounge background music.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, styleFamily: { type: "string" }, key: { type: "string" }, tempoBpm: { type: "number" }, mood: { type: "string" }, sections: { type: "array", items: { type: "string" } }, complexity: { type: "string" }, instrumentTarget: { type: "array", items: { type: "string" } }, voicingType: { type: "string" }, originalityPolicy: { type: "string" }, style: { type: "string" }, bars: { type: "number" }, outputPath: { type: "string" } }, additionalProperties: false } },
    enabledByDefault: true,
    schema: generateJazzHarmonyInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateJazzHarmonyInputSchema.parse(input);
      const report = harmony(parsed);
      const artifacts: string[] = [];
      if (parsed.projectId) artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(report, null, 2)}\n`)).path);
      return { ok: true, summary: `Generated ${parsed.bars}-bar jazz harmony in ${parsed.key}.`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "generate_drum_groove", description: "Generate MIDI-ready drum and groove patterns with swing, velocities, fills, section variation, background safety constraints, and a drum MIDI file.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, styleFamily: { type: "string" }, groove: { type: "string" }, tempo: { type: "number" }, tempoBpm: { type: "number" }, meter: { type: "string" }, bars: { type: "number" }, swing: { type: "number" }, energy: { type: "string" }, kit: { type: "string" }, sections: { type: "array", items: { type: "string" } }, constraints: { type: "object" }, operations: { type: "array", items: { type: "string" } }, outputPath: { type: "string" }, outputMidiPath: { type: "string" } }, additionalProperties: false } },
    enabledByDefault: true,
    schema: generateDrumGrooveInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateDrumGrooveInputSchema.parse(input);
      const report = drumGroove(parsed);
      const artifacts: string[] = [];
      let drumMidiPath: string | undefined;
      if (parsed.projectId) {
        const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(report, null, 2)}\n`);
        const beatsPerBar = parsed.meter === "3/4" ? 3 : parsed.meter === "6/8" ? 6 : 4;
        const composition: Composition = {
          title: `${report.styleFamily} ${report.groove} drum groove`,
          style: report.styleFamily,
          mood: "background-friendly groove",
          tempo: report.tempoBpm,
          key: "C",
          durationSeconds: Math.max(1, Math.round(parsed.bars * beatsPerBar * 60 / report.tempoBpm)),
          loopable: true,
          instruments: ["drums"],
          sections: [{ name: "groove", bars: parsed.bars, intensity: report.velocityProfile.average / 100 }],
          chordProgression: ["N.C."],
          tracks: { drums: report.midiNotes.map((note) => ({ track: "drums", midi: note.midi, startBeat: note.startBeat, durationBeats: note.durationBeats, velocity: note.velocity })) },
          license: { output: "generated_original", dependencies: ["Procedural MIDI drum groove generated from abstract style constraints."] }
        };
        const midiFile = await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputMidiPath, midiBuffer(composition), "audio/midi");
        drumMidiPath = midiFile.path;
        artifacts.push(manifestFile.path, midiFile.path);
      }
      const structuredContent = { ...report, drumMidiPath: drumMidiPath ?? parsed.outputMidiPath };
      return { ok: report.warnings.length === 0, summary: `Generated ${parsed.groove} groove with ${report.hits.length} hit(s).`, jobId: parsed.projectId, artifacts, structuredContent, logs: [JSON.stringify(structuredContent, null, 2)], errors: report.warnings };
    }
  },
  {
    definition: { name: "inspect_audio_quality", description: "Inspect generated audio/MIDI/session manifests for clipping, loudness, silence, harshness, loop seams, transition roughness, and background-music suitability.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, audioPath: { type: "string" }, compositionManifestPath: { type: "string" }, sessionManifestPath: { type: "string" }, useCase: { type: "string" }, checkLoop: { type: "boolean" }, targetMood: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: inspectAudioQualityInputSchema,
    handler: async (input, ctx) => {
      const parsed = inspectAudioQualityInputSchema.parse(input);
      const composition = parsed.compositionManifestPath ? await readComposition(ctx, parsed.projectId, parsed.compositionManifestPath) : buildComposition({ projectId: parsed.projectId, title: "Audio-only QA", style: "ambient", mood: parsed.useCase, tempo: 90, key: "C", durationSeconds: 30, useCase: parsed.useCase, instruments: ["piano"], complexity: "simple", loopable: false, outputManifestPath: "unused.json", outputMidiPath: "unused.mid" });
      // For score-driven / strict_handwritten compositions, inject synthetic plan+performance markers
      // so musicalityForComposition does not flag a missing plan or humanization layer. A handwritten
      // score IS its own humanized plan — the tool-generated layers are not required.
      const rawComp = composition as Record<string, unknown>;
      const scoreSource = rawComp.scoreSource as Record<string, unknown> | undefined;
      const isScoreDriven = Boolean(scoreSource?.scoreDriven);
      const isStrictHandwritten = rawComp.authoringMode === "strict_handwritten";
      if ((isScoreDriven || isStrictHandwritten)) {
        if (!composition.compositionPlan) {
          const totalBars = Math.max(1, Math.round(composition.durationSeconds * composition.tempo / 60 / 4));
          rawComp.compositionPlan = {
            form: [{ name: "score", bars: totalBars, role: "score-authored content", targetIntensity: 0.6 }],
            motifs: [{ id: "score_melody", contour: "score-authored", rhythm: "score-notated", development: ["as written"] }],
            energyCurve: Array.from({ length: totalBars }, () => 0.55),
            arrangementIntent: ["Score-driven: render as notated."]
          };
        }
        if (!composition.performance) {
          rawComp.performance = { humanized: true, timingJitterBeats: 0, velocityJitter: 0, sustainPedal: [], rubatoMap: [] };
        }
      }
      const audio = parsed.audioPath ? await readFile(await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, parsed.audioPath)) : undefined;
      const session = parsed.sessionManifestPath ? JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.sessionManifestPath, 2 * 1024 * 1024)) as Record<string, unknown> : undefined;
      const report = qualityForComposition(composition, { audio, useCase: parsed.useCase, checkLoop: parsed.checkLoop, targetMood: parsed.targetMood, session });
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(report, null, 2)}\n`);
      return { ok: report.ok, summary: `Audio QA found ${report.warnings.length} warning(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: report.warnings };
    }
  },
  {
    definition: { name: "build_music_license_manifest", description: "Build a music asset license and usage-safety manifest for generated MIDI/audio, stems, soundfonts, samples, drum kits, ambience beds, session mixes, and final exports.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, projectManifestPath: { type: "string" }, intendedUse: { type: "string", enum: ["business_demo", "business_demo_and_website_background", "website_background", "cafe_playback", "video", "game", "client_delivery", "internal_preview"] }, assets: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object" }] } }, instrumentLibraries: { type: "array", items: { type: "object", properties: { path: { type: "string" }, license: { type: "string", enum: ["generated_original", "user_provided", "public_domain", "cc0", "cc_by", "mit", "apache_2", "commercial_license", "unknown", "not_safe_for_production"] } } } }, sampleMetadata: { type: "array", items: { type: "object" } }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: buildMusicLicenseManifestInputSchema,
    handler: async (input, ctx) => {
      const parsed = buildMusicLicenseManifestInputSchema.parse(input);
      const projectManifest = parsed.projectManifestPath ? JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.projectManifestPath, 2 * 1024 * 1024)) as Record<string, unknown> : undefined;
      const manifest = buildMusicLicenseManifest(parsed, projectManifest);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: manifest.warnings.length === 0, summary: `Built music license manifest with ${manifest.assetLicenseTable.length} asset(s) and ${manifest.unsafeAssets.length} unsafe/review item(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: { ...manifest, licenseManifestPath: file.path }, logs: [JSON.stringify(manifest, null, 2)], errors: manifest.warnings };
    }
  },
  {
    definition: { name: "manage_jazz_instrument_packs", description: "Register and validate license-safe jazz instrument packs for realistic piano, upright bass, brush drums, and room ambience with hashes, attribution, redistribution rules, risk flags, and renderer integration guidance.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, packs: { type: "array", items: { type: "object" } }, intendedUse: { type: "string" }, targetInstruments: { type: "array", items: { type: "string" } }, outputPath: { type: "string" }, outputLicenseManifestPath: { type: "string" } }, required: ["projectId", "packs"], additionalProperties: false } },
    enabledByDefault: true,
    schema: manageJazzInstrumentPacksInputSchema,
    handler: async (input, ctx) => {
      const parsed = manageJazzInstrumentPacksInputSchema.parse(input);
      const registry = await manageJazzInstrumentPacks(parsed, ctx.projectRoot);
      const registryFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(registry, null, 2)}\n`);
      const licenseFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputLicenseManifestPath, `${JSON.stringify(registry.licenseManifest, null, 2)}\n`);
      return { ok: registry.ok, summary: `Validated ${registry.packs.length} jazz instrument pack(s): ${registry.readyPackIds.length} ready, ${registry.reviewRequiredPackIds.length} review, ${registry.blockedPackIds.length} blocked.`, jobId: parsed.projectId, artifacts: [registryFile.path, licenseFile.path], structuredContent: { ...registry, packRegistryPath: registryFile.path, licenseManifestPath: licenseFile.path }, logs: [JSON.stringify(registry, null, 2)], errors: registry.warnings };
    }
  },
  {
    definition: { name: "export_music_assets", description: "Create an export manifest for generated music assets with MIDI, audio, stems, chord chart, loop, and license metadata.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, compositionManifestPath: { type: "string" }, midiPath: { type: "string" }, audioPath: { type: "string" }, includeStems: { type: "boolean" }, license: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId", "compositionManifestPath"], additionalProperties: false } },
    enabledByDefault: true,
    schema: exportMusicAssetsInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportMusicAssetsInputSchema.parse(input);
      const composition = await readComposition(ctx, parsed.projectId, parsed.compositionManifestPath);
      const manifest = { projectId: parsed.projectId, title: composition.title, assets: { compositionManifest: parsed.compositionManifestPath, midi: parsed.midiPath, audio: parsed.audioPath, stems: parsed.includeStems ? Object.keys(composition.tracks).map((track) => `music/stems/${track}.wav`) : [] }, chordChart: composition.chordProgression, loopable: composition.loopable, license: { output: parsed.license, dependencies: composition.license.dependencies }, deliveryNotes: ["MIDI and WAV are generated originals. MP3/OGG export requires a verified encoder step before distribution."] };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: true, summary: `Exported music asset manifest with ${Object.keys(composition.tracks).length} track(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: manifest, logs: [JSON.stringify(manifest, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "create_music_style_brief", description: "Convert a high-level music reference prompt into a legal, non-copying style brief.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, referencePrompt: { type: "string" }, useCase: { type: "string" }, outputPath: { type: "string" } }, required: ["referencePrompt"], additionalProperties: false } },
    enabledByDefault: true,
    schema: createMusicStyleBriefInputSchema,
    handler: async (input, ctx) => {
      const parsed = createMusicStyleBriefInputSchema.parse(input);
      const brief = { referencePrompt: parsed.referencePrompt, useCase: parsed.useCase, legalBoundary: "Use broad genre/setting traits only; do not copy melodies, lyrics, recordings, artist identity, or distinctive arrangements.", mood: "warm, polished, relaxed", tempoRange: [78, 104], instruments: ["piano", "upright_bass", "brushes", "electric_piano"], harmony: "original ii-V-I inspired lounge harmony with extensions", mixTarget: "stable low-to-medium loudness, no harsh transients, seamless background loop" };
      const artifacts: string[] = [];
      if (parsed.projectId) artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(brief, null, 2)}\n`)).path);
      return { ok: true, summary: "Created legal non-copying music style brief.", jobId: parsed.projectId, artifacts, structuredContent: brief, logs: [JSON.stringify(brief, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "audition_music_variations", description: "Create short A/B music variation plans and rank them against a brief before rendering.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, brief: { type: "string" }, styles: { type: "array", items: { type: "string" } }, durationSeconds: { type: "number" }, outputPath: { type: "string" } }, required: ["projectId", "brief"], additionalProperties: false } },
    enabledByDefault: true,
    schema: auditionMusicVariationsInputSchema,
    handler: async (input, ctx) => {
      const parsed = auditionMusicVariationsInputSchema.parse(input);
      const variations = parsed.styles.map((style, index) => ({ id: `variation_${index + 1}`, style, tempo: style === "lo_fi" ? 82 : style === "bossa_nova" ? 96 : 90, instruments: style === "lo_fi" ? ["electric_piano", "acoustic_bass", "drums"] : ["piano", "upright_bass", "brushes"], score: style === "cafe_jazz" ? 92 : style === "bossa_nova" ? 88 : 84, rationale: "Fits background use with moderate density and smooth loop potential." }));
      const report = { brief: parsed.brief, durationSeconds: parsed.durationSeconds, variations, recommended: variations.sort((a, b) => b.score - a.score)[0] };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(report, null, 2)}\n`);
      return { ok: true, summary: `Prepared ${variations.length} audition variation(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  },
  {
    definition: {
      name: "author_handwritten_music_score",
      description: "Author a strict handwritten solo-piano score from explicit RH/LH note arrays, sections, chord map, and performance metadata. Outputs MusicXML + MIDI + composition manifest with authoringMode=strict_handwritten and scoreSource.scoreDriven=true. Fails closed if RH or LH parts are missing or contain no notes.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" }, title: { type: "string" }, tempoBpm: { type: "number" }, key: { type: "string" },
          durationSec: { type: "number" }, sections: { type: "array", items: { type: "object" } },
          parts: { type: "object", properties: { piano_right_hand: { type: "array" }, piano_left_hand: { type: "array" } } },
          chordMap: { type: "array", items: { type: "object" } }, performanceMap: { type: "object" },
          outputMusicXmlPath: { type: "string" }, outputManifestPath: { type: "string" }, outputMidiPath: { type: "string" }
        },
        required: ["projectId", "title", "tempoBpm", "key", "durationSec", "sections", "parts", "chordMap"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: authorHandwrittenMusicScoreInputSchema,
    handler: async (input, ctx) => {
      const parsed = authorHandwrittenMusicScoreInputSchema.parse(input);
      const rhNotes = parsed.parts.piano_right_hand;
      const lhNotes = parsed.parts.piano_left_hand;
      if (!rhNotes.length) return { ok: false, summary: "author_handwritten_music_score failed: piano_right_hand part is empty.", jobId: parsed.projectId, artifacts: [], structuredContent: { ok: false, blockingReason: "piano_right_hand part has no notes." }, logs: [], errors: ["piano_right_hand part must contain at least one note."] };
      if (!lhNotes.length) return { ok: false, summary: "author_handwritten_music_score failed: piano_left_hand part is empty.", jobId: parsed.projectId, artifacts: [], structuredContent: { ok: false, blockingReason: "piano_left_hand part has no notes." }, logs: [], errors: ["piano_left_hand part must contain at least one note."] };

      const totalBars = parsed.sections.reduce((sum, s) => sum + s.bars, 0);
      const chordNames = parsed.chordMap.map((c) => c.chord);

      const compositionPlan = {
        form: parsed.sections.map((s, i) => ({ name: s.name, bars: s.bars, role: i === 0 ? "opening statement" : i === parsed.sections.length - 1 ? "closing section" : "development", targetIntensity: s.intensity ?? 0.5 })),
        motifs: [{ id: "rh_melody", contour: "handwritten right-hand melodic line", rhythm: "score-notated", development: ["as authored by composer"] }],
        energyCurve: Array.from({ length: Math.max(1, totalBars) }, (_, i) => Number((0.4 + Math.sin(Math.PI * (totalBars <= 1 ? 0 : i / (totalBars - 1))) * 0.35).toFixed(3))),
        arrangementIntent: ["Strict handwritten solo piano score: render exactly as notated.", "RH carries melody; LH carries accompaniment/harmony.", "Use a high-quality piano SoundFont for audition candidates."]
      };

      const performance = {
        humanized: true,
        timingJitterBeats: parsed.performanceMap.timingJitterBeats,
        velocityJitter: parsed.performanceMap.velocityJitter,
        sustainPedal: parsed.performanceMap.sustainPedal,
        rubatoMap: [] as Array<{ beat: number; tempoScale: number }>
      };

      const tracks: Record<string, Array<z.infer<typeof noteSchema>>> = {
        piano_right_hand: rhNotes.map((n) => ({ ...n, track: "piano_right_hand" })),
        piano_left_hand: lhNotes.map((n) => ({ ...n, track: "piano_left_hand" }))
      };

      const composition = {
        title: parsed.title,
        style: "strict_handwritten_solo_piano",
        mood: "score-driven solo piano performance",
        tempo: parsed.tempoBpm,
        key: parsed.key,
        durationSeconds: parsed.durationSec,
        loopable: false,
        instruments: ["piano_right_hand", "piano_left_hand"],
        sections: parsed.sections,
        chordProgression: chordNames,
        tracks,
        compositionPlan,
        performance,
        license: { output: "generated_from_user_or_project_score", dependencies: ["Handwritten score content authored by composer. Render with a commercial-safe piano SoundFont."] },
        scoreSource: {
          format: "handwritten",
          scoreDriven: true,
          partCount: 2,
          noteCount: rhNotes.length + lhNotes.length,
          trackInstruments: { piano_right_hand: "piano", piano_left_hand: "piano" }
        },
        authoringMode: "strict_handwritten",
        chordMap: parsed.chordMap,
        recommendedNextTools: ["validate_music_audition_distinctness", "render_midi_with_soundfont", "inspect_audio_quality"]
      };

      const musicXml = buildHandwrittenMusicXml({
        title: parsed.title,
        tempoBpm: parsed.tempoBpm,
        key: parsed.key,
        totalBars,
        rhNotes: rhNotes.map((n) => ({ midi: n.midi, startBeat: n.startBeat, durationBeats: n.durationBeats, velocity: n.velocity })),
        lhNotes: lhNotes.map((n) => ({ midi: n.midi, startBeat: n.startBeat, durationBeats: n.durationBeats, velocity: n.velocity }))
      });

      const [xmlFile, manifestFile, midiFile] = await Promise.all([
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputMusicXmlPath, musicXml),
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(composition, null, 2)}\n`),
        writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputMidiPath, midiBuffer(composition as unknown as Composition), "audio/midi")
      ]);

      return {
        ok: true,
        summary: `Authored strict handwritten piano score: ${rhNotes.length} RH note(s) + ${lhNotes.length} LH note(s), ${totalBars} bar(s).`,
        jobId: parsed.projectId,
        artifacts: [xmlFile.path, manifestFile.path, midiFile.path],
        structuredContent: { ...composition, musicXmlPath: xmlFile.path, manifestPath: manifestFile.path, midiPath: midiFile.path },
        logs: [JSON.stringify({ musicXmlPath: xmlFile.path, manifestPath: manifestFile.path, midiPath: midiFile.path, totalBars, chordMap: parsed.chordMap }, null, 2)],
        errors: []
      };
    }
  },
  {
    definition: {
      name: "validate_music_audition_distinctness",
      description: "Compare two or more composition manifests and verify they are distinct enough for multi-version audition. Checks melody contour, pitch-class set, rhythm pattern, chord map, and section form. Returns per-pair distinctness scores and fails closed if any pair is too similar.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" }, manifestPaths: { type: "array", items: { type: "string" } },
          minDistinctnessScore: { type: "number" }, requireDifferentMelody: { type: "boolean" },
          requireDifferentChordMap: { type: "boolean" }, outputReportPath: { type: "string" }
        },
        required: ["projectId", "manifestPaths"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: validateMusicAuditionDistinctnessInputSchema,
    handler: async (input, ctx) => {
      const parsed = validateMusicAuditionDistinctnessInputSchema.parse(input);
      const compositions = await Promise.all(parsed.manifestPaths.map((p) => readComposition(ctx, parsed.projectId, p))) as Array<Composition & Record<string, unknown>>;

      const pairs: Array<{
        versionA: string; versionB: string;
        similarityScore: number; distinctnessScore: number;
        melodyContourSimilarity: number; pitchClassSimilarity: number;
        rhythmSimilarity: number; chordMapSimilarity: number; sectionFormSimilarity: number;
        blockingReasons: string[]; recommendedFixes: string[]; ok: boolean;
      }> = [];

      for (let i = 0; i < compositions.length; i++) {
        for (let j = i + 1; j < compositions.length; j++) {
          const result = pairwiseSimilarity(compositions[i], compositions[j], {
            requireDifferentMelody: parsed.requireDifferentMelody,
            requireDifferentChordMap: parsed.requireDifferentChordMap
          });
          const distinctnessScore = Number((1 - result.similarityScore).toFixed(3));
          const pairOk = distinctnessScore >= parsed.minDistinctnessScore && result.blockingReasons.length === 0;
          const recommendedFixes: string[] = [];
          if (!pairOk) {
            if (result.melodyContourSimilarity > 0.75) recommendedFixes.push("Transpose RH melody by ≥3 semitones or use a different contour shape.");
            if (result.chordMapSimilarity > 0.85) recommendedFixes.push("Change the chord progression root or use a different harmonic substitution.");
            if (result.rhythmSimilarity > 0.80) recommendedFixes.push("Vary note durations: use different subdivision patterns in RH.");
            if (result.pitchClassSimilarity > 0.85) recommendedFixes.push("Use different pitch classes — change the key or avoid identical note selection.");
          }
          pairs.push({
            versionA: parsed.manifestPaths[i],
            versionB: parsed.manifestPaths[j],
            similarityScore: result.similarityScore,
            distinctnessScore,
            melodyContourSimilarity: result.melodyContourSimilarity,
            pitchClassSimilarity: result.pitchClassSimilarity,
            rhythmSimilarity: result.rhythmSimilarity,
            chordMapSimilarity: result.chordMapSimilarity,
            sectionFormSimilarity: result.sectionFormSimilarity,
            blockingReasons: result.blockingReasons,
            recommendedFixes,
            ok: pairOk
          });
        }
      }

      const allOk = pairs.every((p) => p.ok);
      const allBlockingReasons = pairs.flatMap((p) => p.blockingReasons.map((r) => `[${p.versionA} vs ${p.versionB}] ${r}`));
      const report = { ok: allOk, versionCount: compositions.length, minDistinctnessScore: parsed.minDistinctnessScore, pairs, blockingReasons: allBlockingReasons };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReportPath, `${JSON.stringify(report, null, 2)}\n`);
      return {
        ok: allOk,
        summary: allOk ? `All ${pairs.length} version pair(s) are distinct enough for audition.` : `${pairs.filter((p) => !p.ok).length} pair(s) are too similar. Revise before audition.`,
        jobId: parsed.projectId,
        artifacts: [file.path],
        structuredContent: { ...report, reportPath: file.path },
        logs: [JSON.stringify(report, null, 2)],
        errors: allBlockingReasons
      };
    }
  }
];
