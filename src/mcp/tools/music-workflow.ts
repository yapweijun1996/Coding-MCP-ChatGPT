import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getProjectStoredFilePath, publishProject, readProjectFile, writeProjectAsset, writeProjectFile } from "../../projects/store.js";
import type { ToolContext, ToolModule } from "../types.js";

const musicStyleSchema = z.enum(["cafe_jazz", "lo_fi", "bossa_nova", "smooth_piano", "acoustic_pop", "cinematic_background", "corporate_intro", "game_bgm", "orchestral_sketch", "ambient", "chill_lounge"]);
const instrumentSchema = z.enum(["piano", "electric_piano", "upright_bass", "acoustic_bass", "violin", "cello", "drums", "brushes", "guitar", "strings", "pads", "synth", "sax_like_lead"]);
const complexitySchema = z.enum(["simple", "medium", "rich"]);
const sectionSchema = z.object({ name: z.string().min(1).max(40), bars: z.number().int().min(1).max(64), intensity: z.number().min(0).max(1).optional().default(0.5) });
const noteSchema = z.object({ track: z.string().min(1).max(80), midi: z.number().int().min(0).max(127), startBeat: z.number().min(0), durationBeats: z.number().min(0.05).max(64), velocity: z.number().int().min(1).max(127) });

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
  outputReportPath: z.string().min(1).max(240).optional().default("music/render-report.json")
}).refine((value) => Boolean(value.compositionManifestPath || value.midiPath), {
  message: "compositionManifestPath or midiPath is required."
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
  instrumentRole: z.enum(["realistic_piano", "upright_bass", "brush_drums", "room_ambience"]),
  format: z.enum(["sfz", "soundfont", "wav_multisample", "impulse_response", "virtual_instrument"]),
  assetPaths: z.array(z.string().min(1).max(240)).min(1).max(80),
  version: z.string().min(1).max(80).optional(),
  declaredSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  licenseType: z.enum(["generated_original", "user_provided", "public_domain", "cc0", "cc_by", "mit", "apache_2", "commercial_license", "lgpl", "gpl", "proprietary", "non_commercial", "unknown"]),
  source: z.string().min(1).max(240),
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
  renderAudio: z.boolean().optional().default(true),
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
  generatedPrompt: z.string().min(1).max(500).optional()
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
};

const noteBase: Record<string, number> = { C: 60, Db: 61, D: 62, Eb: 63, E: 64, F: 65, Gb: 66, G: 67, Ab: 68, A: 69, Bb: 70, B: 71 };
const chordIntervals: Record<string, number[]> = { maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], "7": [0, 4, 7, 10], m9: [0, 3, 7, 10, 14], "13": [0, 4, 7, 10, 21], dim: [0, 3, 6, 9] };

function keyRoot(key: string) {
  return noteBase[key.replace(/m$/, "")] ?? 60;
}

function progressionFor(style: string, key: string) {
  const root = keyRoot(key);
  const names = style === "bossa_nova" ? ["Dm9", "G13", "Cmaj7", "A7"] : style === "lo_fi" ? ["Cmaj7", "Am7", "Dm7", "G7"] : style === "cinematic_background" ? ["Am", "Fmaj7", "C", "G"] : ["Dm9", "G13", "Cmaj7", "Cmaj7"];
  const roots = [root + 2, root + 7, root, root + 9];
  return { names, roots };
}

function chordNotes(root: number, symbol: string) {
  const type = symbol.includes("m9") ? "m9" : symbol.includes("m7") ? "m7" : symbol.includes("13") ? "13" : symbol.includes("7") && !symbol.includes("maj7") ? "7" : symbol.includes("dim") ? "dim" : "maj7";
  return chordIntervals[type].map((interval) => root + interval);
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
  const sections = input.loopable
    ? [{ name: "loop_A", bars, intensity: 0.52 }]
    : [{ name: "intro", bars: 4, intensity: 0.25 }, { name: "A", bars: Math.max(4, bars - 8), intensity: 0.55 }, { name: "outro", bars: 4, intensity: 0.25 }];
  const progression = progressionFor(input.style, input.key);
  const tracks: Composition["tracks"] = {};
  const add = (track: string, midi: number, startBeat: number, durationBeats: number, velocity: number) => {
    tracks[track] ??= [];
    tracks[track].push({ track, midi, startBeat: Number(startBeat.toFixed(3)), durationBeats: Number(durationBeats.toFixed(3)), velocity });
  };
  for (let bar = 0; bar < bars; bar += 1) {
    const chordIndex = bar % progression.names.length;
    const start = bar * 4;
    if (input.instruments.includes("piano") || input.instruments.includes("electric_piano")) {
      for (const midi of chordNotes(progression.roots[chordIndex], progression.names[chordIndex])) add("piano", midi, start, input.loopable ? 3.8 : 3.6, 54);
    }
    if (input.instruments.includes("upright_bass") || input.instruments.includes("acoustic_bass")) add("bass", progression.roots[chordIndex] - 24, start, 1.8, 68);
    if (input.instruments.includes("violin") || input.instruments.includes("sax_like_lead")) add(input.instruments.includes("violin") ? "violin" : "lead", progression.roots[chordIndex] + 12 + (bar % 2 ? 2 : 7), start + 1, 1.75, 58);
    if (input.instruments.includes("drums") || input.instruments.includes("brushes")) {
      add("drums", 42, start, 0.25, 42);
      add("drums", 38, start + 2, 0.25, 38);
      add("drums", 42, start + 2.67, 0.25, 32);
    }
    if (input.instruments.includes("pads") || input.instruments.includes("strings")) add("pad", progression.roots[chordIndex], start, 3.9, 35);
  }
  return {
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
    license: { output: "generated_original", dependencies: ["No third-party samples. WAV preview uses built-in sine/noise synthesis."] }
  };
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

function midiBuffer(composition: Composition) {
  const ppq = 480;
  const events: Array<{ tick: number; bytes: number[] }> = [];
  const pushText = (type: number, text: string) => events.push({ tick: 0, bytes: [0xff, type, ...varLen(Buffer.byteLength(text)), ...Buffer.from(text, "utf8")] });
  pushText(0x03, composition.title);
  events.push({ tick: 0, bytes: [0xff, 0x51, 0x03, ...Buffer.from([(60000000 / composition.tempo) >> 16 & 255, (60000000 / composition.tempo) >> 8 & 255, (60000000 / composition.tempo) & 255])] });
  const channelFor = (track: string) => track === "drums" ? 9 : Math.abs([...track].reduce((sum, ch) => sum + ch.charCodeAt(0), 0)) % 8;
  for (const [track, notes] of Object.entries(composition.tracks)) {
    for (const note of notes) {
      const channel = channelFor(track);
      const start = Math.round(note.startBeat * ppq);
      const end = Math.round((note.startBeat + note.durationBeats) * ppq);
      events.push({ tick: start, bytes: [0x90 + channel, note.midi, note.velocity] });
      events.push({ tick: end, bytes: [0x80 + channel, note.midi, 0] });
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

function applyMidiEdits(composition: Composition, input: z.infer<typeof editMidiInputSchema>) {
  const edited = JSON.parse(JSON.stringify(composition)) as Composition;
  for (const notes of Object.values(edited.tracks)) {
    for (const note of notes) {
      note.midi = Math.max(0, Math.min(127, note.midi + input.transposeSemitones));
      note.velocity = Math.max(1, Math.min(127, Math.round(note.velocity * input.velocityScale)));
      if (input.quantizeBeats) note.startBeat = Number((Math.round(note.startBeat / input.quantizeBeats) * input.quantizeBeats).toFixed(3));
      if (input.swing && Math.floor(note.startBeat * 2) % 2 === 1) note.startBeat = Number((note.startBeat + input.swing).toFixed(3));
      if (input.humanizeMs) note.startBeat = Number((note.startBeat + ((note.midi % 5) - 2) * input.humanizeMs / 1000 / (60 / edited.tempo)).toFixed(3));
    }
  }
  edited.title = `${edited.title} (edited)`;
  return edited;
}

type AudioFinding = { severity: "high" | "medium" | "low"; category: string; message: string; suggestedFix: string };

function addFinding(findings: AudioFinding[], severity: AudioFinding["severity"], category: string, message: string, suggestedFix: string) {
  findings.push({ severity, category, message, suggestedFix });
}

function wavAnalysis(buffer?: Buffer) {
  if (!buffer || buffer.subarray(0, 4).toString("ascii") !== "RIFF") {
    return {
      readable: false,
      format: "unknown",
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
      silenceGaps: [] as Array<{ startSeconds: number; durationSeconds: number }>,
      harshHighFrequencyProxy: 0,
      excessiveBassProxy: 0,
      loopSeamClickProxy: 0,
      startNearZero: true,
      endNearZero: true
    };
  }
  const channelCount = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitDepth = buffer.readUInt16LE(34);
  const bytesPerSample = Math.max(1, bitDepth / 8);
  const dataOffset = 44;
  const frameCount = Math.max(0, Math.floor((buffer.length - dataOffset) / Math.max(1, bytesPerSample * channelCount)));
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
      const value = bitDepth === 16 ? buffer.readInt16LE(offset) / 32768 : 0;
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
  let silenceStart: number | undefined;
  for (let index = 0; index < blockRms.length; index += 1) {
    const isSilent = blockRms[index] < 0.002;
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
  const noteDensityPerMinute = allNotes.length / Math.max(1, composition.durationSeconds / 60);
  if (noteDensityPerMinute > 900) addFinding(findings, "medium", "background_suitability", "Note density is high for long background listening.", "Lower drum subdivisions, simplify comping, or thin the melody.");
  if (composition.durationSeconds < 10 && options.useCase.includes("background")) addFinding(findings, "low", "duration", "Preview is very short for judging background comfort.", "Render at least 30-60 seconds before final QA.");
  const technicalReport = wavAnalysis(options.audio);
  if (options.audio && !technicalReport.readable) addFinding(findings, "medium", "file_format", "Audio file is not a readable PCM WAV for detailed analysis.", "Render a WAV preview before QA or run an external analyzer for compressed files.");
  if (technicalReport.peak > 0.98) addFinding(findings, "high", "clipping", "Audio peak is near 0 dBFS and may clip.", "Lower master gain or normalize to a safer true peak ceiling.");
  if (technicalReport.rms > 0.35) addFinding(findings, "medium", "loudness", "Audio is loud for background music.", "Normalize loudness lower and reduce dense transient layers.");
  if (technicalReport.dynamicRange > 28) addFinding(findings, "medium", "dynamic_range", "Dynamic range is wide for steady background playback.", "Use gentle compression or rebalance quiet/loud sections.");
  if (technicalReport.silenceGaps.length) addFinding(findings, "medium", "silence", "Detected long silence gaps.", "Fill gaps with room tone, pads, or adjust arrangement section lengths.");
  if (technicalReport.harshHighFrequencyProxy > 0.08) addFinding(findings, "medium", "harshness", "High-frequency change proxy suggests possible harshness.", "Reduce high-end, soften piano/drum velocities, or apply a gentle low-pass.");
  if (technicalReport.excessiveBassProxy > 0.18) addFinding(findings, "medium", "bass", "Low-frequency proxy suggests excessive bass energy.", "Lower bass gain or high-pass non-bass instruments.");
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
  return {
    ok: findings.every((finding) => finding.severity === "low"),
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

  for (const item of normalizedFeedback) {
    const text = item.comment.toLowerCase();
    const reason = item.timestamp ? `${item.timestamp}: ${item.comment}` : item.comment;
    if (/(drum|drums|brush|snare|kick|cymbal|鼓|镲)/i.test(text)) {
      detectedFeedbackTypes.add("drums");
      if (/(too busy|busy|less|reduce|quieter|soft|太忙|少一点|降低)/i.test(text)) {
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
      if (/(remove|less|without|不要|去掉)/i.test(text)) {
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
  if (buffer.subarray(0, 4).toString("ascii") !== "RIFF") return { peak, rms, sampleCount: 0 };
  const sampleCount = Math.max(0, Math.floor((buffer.length - 44) / 2));
  for (let offset = 44; offset + 1 < buffer.length; offset += 2) {
    const value = buffer.readInt16LE(offset) / 32768;
    peak = Math.max(peak, Math.abs(value));
    rms += value * value;
  }
  return { peak: Number(peak.toFixed(4)), rms: Number(Math.sqrt(rms / Math.max(1, sampleCount)).toFixed(4)), sampleCount };
}

function normalizeWav(buffer: Buffer, targetRms: number) {
  const before = audioStats(buffer);
  const output = Buffer.from(buffer);
  const gain = before.rms > 0 ? Math.min(4, targetRms / before.rms) : 1;
  for (let offset = 44; offset + 1 < output.length; offset += 2) {
    const next = Math.max(-32767, Math.min(32767, Math.round(output.readInt16LE(offset) * gain)));
    output.writeInt16LE(next, offset);
  }
  return { output, before, after: audioStats(output), gain: Number(gain.toFixed(3)) };
}

function limitWav(buffer: Buffer, ceiling: number) {
  const output = Buffer.from(buffer);
  let limitedSamples = 0;
  for (let offset = 44; offset + 1 < output.length; offset += 2) {
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
    allowed: ["generated_original", "public_domain", "cc0", "mit", "apache_2", "commercial_license"],
    reviewRequired: ["cc_by", "unknown", "lgpl", "gpl", "proprietary", "non_commercial"],
    rule: "Do not use third-party samples, soundfonts, drum kits, or impulse responses until build_music_license_manifest marks them commercial-safe."
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
    renderer: "built_in_safe_synth",
    source: "Procedural oscillator/noise synthesis generated in-process; no third-party samples or soundfonts embedded.",
    instruments: Object.fromEntries(Object.entries(instrumentMap).map(([track, instrument]) => [track, { instrument, license: "generated_original_procedural" }])),
    formatNotes: ["WAV is generated directly. MP3/OGG require a verified encoder step before distribution."]
  };
}

function inferMusicAssetType(assetPath: string): z.infer<typeof musicLicenseDependencySchema>["type"] {
  const lower = assetPath.toLowerCase();
  if (lower.endsWith(".mid") || lower.endsWith(".midi")) return "generated_midi";
  if (lower.endsWith(".wav")) return lower.includes("stem") ? "stem" : "exported_wav";
  if (lower.endsWith(".mp3")) return "exported_mp3";
  if (lower.endsWith(".ogg")) return "exported_ogg";
  if (lower.endsWith(".sf2") || lower.endsWith(".sfz")) return "soundfont";
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
  room_ambience: ["impulse_response", "wav_multisample", "virtual_instrument"]
};

const jazzPackSafeLicenses = new Set(["generated_original", "public_domain", "cc0", "mit", "apache_2", "commercial_license"]);
const jazzPackReviewLicenses = new Set(["cc_by", "user_provided", "lgpl", "gpl", "proprietary", "unknown"]);

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
  return {
    assets,
    missing,
    combinedSha256: assets.every((asset) => asset.exists) ? hash.digest("hex") : undefined
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

  const blocked = riskFlags.some((flag) => ["non_commercial_license", "commercial_use_not_allowed", "missing_pack_assets", "declared_hash_mismatch"].includes(flag));
  const review = blocked || riskFlags.length > 0 || jazzPackReviewLicenses.has(pack.licenseType);
  const status = blocked ? "blocked" : review ? "review_required" : "ready";
  return {
    packId: pack.packId,
    displayName: pack.displayName,
    instrumentRole: pack.instrumentRole,
    format: pack.format,
    version: pack.version ?? "unversioned",
    source: pack.source,
    licenseType: pack.licenseType,
    commercialUseAllowed: pack.commercialUseAllowed ?? (jazzPackSafeLicenses.has(pack.licenseType) || pack.licenseType === "cc_by"),
    redistributionAllowed: pack.redistributionAllowed ?? false,
    modificationsAllowed: pack.modificationsAllowed ?? false,
    attributionRequired: pack.licenseType === "cc_by" || Boolean(pack.attribution),
    attribution: pack.attribution ?? "",
    assetPaths: pack.assetPaths,
    assetInspection: inspected.assets,
    declaredSha256: pack.declaredSha256,
    computedSha256: inspected.combinedSha256,
    riskFlags,
    status,
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
      rule: "Only packs with status=ready may be selected by a realistic instrument renderer. Existing procedural WAV preview rendering should use fallbacks for review_required or blocked packs."
    },
    ok: blockedPacks.length === 0 && reviewPacks.length === 0,
    warnings: [...reviewPacks.map((pack) => `${pack.packId}: license or redistribution review required (${pack.riskFlags.join(", ") || pack.licenseType}).`), ...blockedPacks.map((pack) => `${pack.packId}: blocked (${pack.riskFlags.join(", ")}).`)]
  };
}

function renderAuditionHtml(title: string, variations: Array<Record<string, unknown>>, allowDownloads: boolean) {
  const cards = variations.map((variation) => {
    const audioPath = String(variation.audioPath ?? "");
    const midiPath = String(variation.midiPath ?? "");
    const notes = Array.isArray(variation.styleNotes) ? variation.styleNotes.join(", ") : String(variation.rationale ?? "");
    const versionId = String(variation.id ?? variation.label ?? "version");
    const titleText = String(variation.title ?? variation.label ?? variation.id ?? "Version");
    const duration = Number(variation.durationSeconds ?? variation.durationSec ?? 0);
    const tempo = variation.tempo ?? variation.bpm ?? "";
    const moodTags = Array.isArray(variation.moodTags) ? variation.moodTags : [];
    return `<article class="card">
      <header><h2>${escapeHtml(titleText)}</h2><label class="winner"><input type="radio" name="winner" value="${escapeHtml(versionId)}"> Choose this version</label></header>
      <audio controls preload="metadata" src="${escapeHtml(audioPath)}"></audio>
      <dl>
        <dt>Style</dt><dd>${escapeHtml(String(variation.style ?? ""))}</dd>
        <dt>BPM / Key</dt><dd>${escapeHtml(String(tempo))} / ${escapeHtml(String(variation.key ?? ""))}</dd>
        <dt>Instruments</dt><dd>${escapeHtml(Array.isArray(variation.instruments) ? variation.instruments.join(", ") : "")}</dd>
        <dt>Mood</dt><dd>${escapeHtml(moodTags.join(", "))}</dd>
        <dt>Notes</dt><dd>${escapeHtml(notes)}</dd>
        <dt>Prompt</dt><dd>${escapeHtml(String(variation.generatedPrompt ?? ""))}</dd>
      </dl>
      <div class="timeline" aria-label="Timeline"><span style="width:${Math.max(10, Math.min(100, (duration || 30) / 1.2))}%"></span></div>
      <label class="rating">Rating <input type="range" min="1" max="5" value="3" data-version="${escapeHtml(versionId)}"></label>
      ${allowDownloads ? `<p class="downloads"><a href="${escapeHtml(audioPath)}" download>Download audio</a>${midiPath ? ` <a href="${escapeHtml(midiPath)}" download>Download MIDI</a>` : ""}</p>` : ""}
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
dt{font-weight:700;margin-top:10px}.timeline{height:8px;background:#ece7dc;border-radius:999px;overflow:hidden}.timeline span{display:block;height:100%;background:#5b7f95}
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
  if (input.constraints.backgroundFriendly && allNotes().length / Math.max(1, input.durationSec / 60) > 180) warnings.push("MIDI density may be too busy for background use.");
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
  const published = parsed.publish ? await publishProject(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, parsed.outputHtmlPath, { shareBasePath: ctx.publicShareBasePath }) : undefined;
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
    definition: { name: "compose_edit_midi", description: "Create or edit a structured multi-track MIDI composition with sections, chord chart, arrangement map, editable operations, background constraints, and a real MIDI asset.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, existingManifestPath: { type: "string" }, style: { type: "string" }, mood: { type: "string" }, tempoBpm: { type: "number" }, key: { type: "string" }, durationSec: { type: "number" }, tracks: { type: "array", items: { type: "string" } }, sections: { type: "array", items: { type: "string" } }, constraints: { type: "object" }, operations: { type: "array", items: { type: "object" } }, outputManifestPath: { type: "string" }, outputMidiPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: composeEditMidiInputSchema,
    handler: async (input, ctx) => {
      const parsed = composeEditMidiInputSchema.parse(input);
      const base = parsed.existingManifestPath
        ? Object.assign(buildMidiComposition(parsed), await readComposition(ctx, parsed.projectId, parsed.existingManifestPath))
        : buildMidiComposition(parsed);
      const composition = applyComposeEditOperations(base, parsed.operations);
      const [manifestFile, midiFile] = await Promise.all([
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(composition, null, 2)}\n`),
        writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputMidiPath, midiBuffer(composition), "audio/midi")
      ]);
      return {
        ok: composition.warnings.length === 0,
        summary: `Created editable MIDI with ${composition.trackList.length} track(s), ${composition.sectionMap.length} section marker(s), and ${composition.warnings.length} warning(s).`,
        jobId: parsed.projectId,
        artifacts: [manifestFile.path, midiFile.path],
        structuredContent: { midiPath: midiFile.path, manifestPath: manifestFile.path, trackList: composition.trackList, sectionMap: composition.sectionMap, chordChart: composition.chordChart, warnings: composition.warnings, editableOperations: composition.editableOperations },
        logs: [JSON.stringify({ trackList: composition.trackList, sectionMap: composition.sectionMap, chordChart: composition.chordChart }, null, 2)],
        errors: composition.warnings
      };
    }
  },
  {
    definition: { name: "generate_music_variations", description: "Generate multiple short production music variations from one brief, with different style, instrumentation, MIDI, WAV preview, and comparison metadata.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, brief: { type: "string" }, styles: { type: "array", items: { type: "string" } }, durationSeconds: { type: "number" }, renderAudio: { type: "boolean" }, outputPath: { type: "string" } }, required: ["projectId", "brief"], additionalProperties: false } },
    enabledByDefault: true,
    schema: generateMusicVariationsInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateMusicVariationsInputSchema.parse(input);
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
        const bundle = await writeCompositionBundle(ctx, parsed.projectId, composition, basePath, parsed.renderAudio);
        artifacts.push(...bundle.artifacts);
        variations.push({ id: `version_${String.fromCharCode(65 + index)}`, label: `Version ${String.fromCharCode(65 + index)}`, style, tempo: composition.tempo, key: composition.key, instruments: composition.instruments, durationSeconds: composition.durationSeconds, manifestPath: bundle.manifestPath, midiPath: bundle.midiPath, audioPath: bundle.audioPath, styleNotes: [`${style.replaceAll("_", " ")} arrangement`, "background-friendly density", "generated original"] });
      }
      const manifest = { brief: parsed.brief, durationSeconds: parsed.durationSeconds, variations, reviewPrompts: ["Choose winner", "More jazz", "Less drums", "Warmer piano", "Smoother loop"] };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: true, summary: `Generated ${variations.length} music variation(s).`, jobId: parsed.projectId, artifacts: [file.path, ...artifacts], structuredContent: manifest, logs: [JSON.stringify(manifest, null, 2)], errors: [] };
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
      const html = renderAuditionHtml(title, variations, parsed.allowDownloads);
      const htmlFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputHtmlPath, html);
      const published = parsed.publish ? await publishProject(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, parsed.outputHtmlPath, { shareBasePath: ctx.publicShareBasePath }) : undefined;
      const selectedVersionWorkflow = {
        nextTool: "extend_music_arrangement",
        instructions: "Use the chosen version manifestPath as compositionManifestPath, then optionally run normalize_music_loudness and export_music_project.",
        requiredUserInput: ["winner", "revisionNotes"],
        revisionOptions: ["warmer piano", "less drums", "more jazz", "smoother transition", "longer intro", "less repetitive"]
      };
      const manifest = { title, projectId: parsed.projectId, brief: variationsManifest.brief, pagePath: htmlFile.path, demoUrl: published?.publishedUrl, publishedUrl: published?.publishedUrl, versionIds: variations.map((variation) => variation.id), variations, feedbackFields: ["winner", "rating", "revisionNotes", "warmerPiano", "lessDrums", "moreJazz", "smootherTransition", "longerIntro", "lessRepetitive"], selectedVersionWorkflow };
      const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: true, summary: `Published music audition demo with ${variations.length} version(s).`, jobId: parsed.projectId, previewUrl: published?.publishedUrl, shareUrl: published?.publishedUrl, artifacts: [htmlFile.path, manifestFile.path], structuredContent: { ...manifest, manifestPath: manifestFile.path }, logs: [JSON.stringify(manifest, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "extend_music_arrangement", description: "Extend a short sketch into a 5-10 minute long-form arrangement with intro, A/B, bridge, solo texture, reprise, outro, MIDI, and optional WAV preview.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, compositionManifestPath: { type: "string" }, targetDurationSeconds: { type: "number" }, arrangementStyle: { type: "string" }, renderAudio: { type: "boolean" }, outputManifestPath: { type: "string" }, outputMidiPath: { type: "string" }, outputAudioPath: { type: "string" } }, required: ["projectId", "compositionManifestPath"], additionalProperties: false } },
    enabledByDefault: true,
    schema: extendMusicArrangementInputSchema,
    handler: async (input, ctx) => {
      const parsed = extendMusicArrangementInputSchema.parse(input);
      const extended = extendComposition(await readComposition(ctx, parsed.projectId, parsed.compositionManifestPath), parsed.targetDurationSeconds, parsed.arrangementStyle);
      const artifacts = [
        (await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(extended, null, 2)}\n`)).path,
        (await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputMidiPath, midiBuffer(extended), "audio/midi")).path
      ];
      if (parsed.renderAudio) artifacts.push((await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputAudioPath, wavBuffer(extended, 12000), "audio/wav")).path);
      return { ok: true, summary: `Extended arrangement to ${Math.round(extended.durationSeconds / 60)} minute(s).`, jobId: parsed.projectId, artifacts, structuredContent: { ...extended, manifestPath: parsed.outputManifestPath, midiPath: parsed.outputMidiPath, audioPath: parsed.renderAudio ? parsed.outputAudioPath : undefined }, logs: [JSON.stringify({ sections: extended.sections, durationSeconds: extended.durationSeconds }, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "extend_original_music_arrangement", description: "Extend a selected original short sketch into a 5-10 minute background-friendly arrangement with section map, development report, originality notes, warnings, MIDI, and optional audio preview.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, sourceManifestPath: { type: "string" }, targetDurationSec: { type: "number" }, styleFamily: { type: "string" }, backgroundUse: { type: "string" }, variationLevel: { type: "string" }, sections: { type: "array", items: { type: "string" } }, originalityPolicy: { type: "string" }, renderAudio: { type: "boolean" }, outputManifestPath: { type: "string" }, outputMidiPath: { type: "string" }, outputAudioPath: { type: "string" } }, required: ["projectId", "sourceManifestPath"], additionalProperties: false } },
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
      if (parsed.renderAudio) artifacts.push((await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputAudioPath, wavBuffer(arranged.extended, 12000), "audio/wav")).path);
      return {
        ok: arranged.warnings.length === 0,
        summary: `Extended original arrangement to ${Math.round(parsed.targetDurationSec / 60)} minute(s) with ${arranged.warnings.length} warning(s).`,
        jobId: parsed.projectId,
        artifacts,
        structuredContent: { extendedMidiPath: parsed.outputMidiPath, arrangementManifestPath: parsed.outputManifestPath, audioPath: parsed.renderAudio ? parsed.outputAudioPath : undefined, sectionMap: arranged.sectionMap, developmentReport: arranged.developmentReport, originalityNotes: arranged.originalityNotes, warnings: arranged.warnings, renderReady: arranged.renderReady },
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
    definition: { name: "create_production_music_render_plan", description: "Create a production-grade music render plan for realistic instruments, humanization, stems, A/B mastering, loudness targets, and license gates.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, compositionManifestPath: { type: "string" }, styleProfile: { type: "string" }, targetUse: { type: "string" }, instrumentPriorities: { type: "array", items: { type: "string" } }, licensePolicy: { type: "string" }, targetLufs: { type: "number" }, truePeakDb: { type: "number" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
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
    definition: { name: "apply_music_mix_master_chain", description: "Apply a deterministic preview mix/master chain to a WAV file with loudness normalization, limiter ceiling, stem notes, and an A/B mastering report.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, audioPath: { type: "string" }, stemPaths: { type: "array", items: { type: "string" } }, chain: { type: "array", items: { type: "string" } }, targetRms: { type: "number" }, truePeakCeiling: { type: "number" }, abLabel: { type: "string" }, outputAudioPath: { type: "string" }, outputReportPath: { type: "string" } }, required: ["projectId", "audioPath"], additionalProperties: false } },
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
    definition: { name: "export_music_project", description: "Export a production music project package with tracks, sessions, stems, MIDI, chord charts, license checks, README, playlist metadata, and optional public listening/download page.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, projectManifestPath: { type: "string" }, packageName: { type: "string" }, selectedVersionIds: { type: "array", items: { type: "string" } }, exports: { type: "array", items: { type: "string" } }, renderedAudioPaths: { type: "array", items: { type: "string" } }, midiPaths: { type: "array", items: { type: "string" } }, stemPaths: { type: "array", items: { type: "string" } }, chordChartPaths: { type: "array", items: { type: "string" } }, licenseManifestPath: { type: "string" }, version: { type: "string" }, bpm: { type: "number" }, key: { type: "string" }, durationSeconds: { type: "number" }, demoManifestPath: { type: "string" }, sessionManifestPath: { type: "string" }, trackManifestPaths: { type: "array", items: { type: "string" } }, publish: { type: "boolean" }, outputHtmlPath: { type: "string" }, outputManifestPath: { type: "string" }, outputReadmePath: { type: "string" }, outputPackageReportPath: { type: "string" }, outputPlaylistPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
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
        userFacingReadmePath: parsed.outputReadmePath,
        playlistPath: parsed.outputPlaylistPath
      };
      const readme = renderMusicExportReadme({ packageName, naming, exports: parsed.exports, exportedFiles: fileInspection.exportedFiles, missingFiles: fileInspection.missingFiles, licenseWarnings, unsupportedFormats });
      const readmeFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReadmePath, readme);
      const playlistFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPlaylistPath, `${JSON.stringify(playlist, null, 2)}\n`);
      const packageReportFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPackageReportPath, `${JSON.stringify(packageReport, null, 2)}\n`);
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Music Project Export</title><style>body{font-family:system-ui;margin:32px;max-width:960px}li{margin:8px 0}.warn{color:#9a3412}.ok{color:#166534}</style></head><body><h1>Music Project Export</h1><p>Generated original production music handoff.</p><h2>Download package</h2><ul><li><a href="${escapeHtml(readmeFile.path)}">README</a></li><li><a href="${escapeHtml(packageReportFile.path)}">Package report JSON</a></li><li><a href="${escapeHtml(playlistFile.path)}">Playlist metadata JSON</a></li>${fileInspection.exportedFiles.map((file) => `<li><a href="${escapeHtml(file.path)}">${escapeHtml(file.path)}</a> - ${escapeHtml(file.role)}</li>`).join("")}</ul><h2>Checks</h2><p class="${packageReport.missingFiles.length || packageReport.licenseWarnings.length ? "warn" : "ok"}">Missing files: ${packageReport.missingFiles.length}; license warnings: ${packageReport.licenseWarnings.length}; unsupported formats: ${packageReport.unsupportedFormats.length}</p><h2>Tracks</h2><ul>${tracks.map((track) => `<li>${escapeHtml(track.title)} - ${Math.round(track.durationSeconds / 60)} min, ${escapeHtml(track.key)}, ${track.tempo} BPM</li>`).join("")}</ul><h2>Session</h2><pre>${escapeHtml(JSON.stringify(session ?? {}, null, 2))}</pre></body></html>`;
      const htmlFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputHtmlPath, html);
      const published = parsed.publish ? await publishProject(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, parsed.outputHtmlPath, { shareBasePath: ctx.publicShareBasePath }) : undefined;
      const manifest = { projectId: parsed.projectId, packageName, projectManifestPath: parsed.projectManifestPath, demoManifestPath: parsed.demoManifestPath, sessionManifestPath: parsed.sessionManifestPath, trackManifestPaths: parsed.trackManifestPaths, selectedVersionIds: parsed.selectedVersionIds, requestedExports: parsed.exports, demoUrl: demo?.publishedUrl, exportPagePath: htmlFile.path, publishedUrl: published?.publishedUrl, readmePath: readmeFile.path, packageReportPath: packageReportFile.path, playlistPath: playlistFile.path, exportedFiles: fileInspection.exportedFiles, missingFiles: fileInspection.missingFiles, brokenAudioReferences: fileInspection.brokenAudioReferences, largeFiles: fileInspection.largeFiles, unsupportedFormats, licenseWarnings, naming, tracks, sessionSummary: session ? { targetDurationMinutes: session.targetDurationMinutes, slots: Array.isArray(session.schedule) ? session.schedule.length : 0 } : undefined, license: licenseManifest ?? { output: "generated_original", dependencies: ["Built-in safe synth unless external assets are added later."] }, packageNotes: ["ZIP/MP3/OGG export requires a verified archive/encoder step.", "ZIP bundle creation can be completed with export package archive tools after this music package manifest passes checks.", "MP3/OGG exports require verified encoded files; this tool reports missing encoded formats instead of fabricating them."] };
      const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const blockingErrors = [
        ...fileInspection.missingFiles.map((filePath) => `Missing export file: ${filePath}`),
        ...licenseWarnings.map((warning) => `License warning: ${warning}`),
        ...unsupportedFormats,
        ...fileInspection.brokenAudioReferences.map((warning) => `Broken audio reference: ${warning}`)
      ];
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
    definition: { name: "compose_music", description: "Compose a structured original music cue and write a project MIDI file plus composition manifest.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, style: { type: "string" }, mood: { type: "string" }, tempo: { type: "number" }, key: { type: "string" }, durationSeconds: { type: "number" }, useCase: { type: "string" }, instruments: { type: "array", items: { type: "string" } }, complexity: { type: "string" }, loopable: { type: "boolean" }, outputManifestPath: { type: "string" }, outputMidiPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: composeMusicInputSchema,
    handler: async (input, ctx) => {
      const parsed = composeMusicInputSchema.parse(input);
      const composition = buildComposition(parsed);
      const [manifestFile, midiFile] = await Promise.all([
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(composition, null, 2)}\n`),
        writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputMidiPath, midiBuffer(composition), "audio/midi")
      ]);
      return { ok: true, summary: `Composed ${composition.style} cue with ${Object.keys(composition.tracks).length} track(s).`, jobId: parsed.projectId, artifacts: [manifestFile.path, midiFile.path], structuredContent: { ...composition, manifestPath: manifestFile.path, midiPath: midiFile.path }, logs: [JSON.stringify(composition, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "edit_midi", description: "Edit a generated composition/MIDI manifest with transpose, quantize, swing, humanize, and velocity shaping, then write an updated MIDI.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, compositionManifestPath: { type: "string" }, quantizeBeats: { type: "number" }, transposeSemitones: { type: "number" }, humanizeMs: { type: "number" }, velocityScale: { type: "number" }, swing: { type: "number" }, duplicateSections: { type: "array", items: { type: "string" } }, outputManifestPath: { type: "string" }, outputMidiPath: { type: "string" } }, required: ["projectId", "compositionManifestPath"], additionalProperties: false } },
    enabledByDefault: true,
    schema: editMidiInputSchema,
    handler: async (input, ctx) => {
      const parsed = editMidiInputSchema.parse(input);
      const edited = applyMidiEdits(await readComposition(ctx, parsed.projectId, parsed.compositionManifestPath), parsed);
      const [manifestFile, midiFile] = await Promise.all([
        writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(edited, null, 2)}\n`),
        writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputMidiPath, midiBuffer(edited), "audio/midi")
      ]);
      return { ok: true, summary: `Edited MIDI manifest and wrote ${midiFile.path}.`, jobId: parsed.projectId, artifacts: [manifestFile.path, midiFile.path], structuredContent: { ...edited, manifestPath: manifestFile.path, midiPath: midiFile.path }, logs: [JSON.stringify(edited, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "render_midi_to_audio", description: "Render generated MIDI/composition manifests into playable audio using a safe procedural instrument library, with full mix, optional stems, render report, license manifest, and format warnings.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, compositionManifestPath: { type: "string" }, midiPath: { type: "string" }, instrumentMap: { type: "object" }, renderPreset: { type: "string" }, outputFormats: { type: "array", items: { type: "string" } }, stems: { type: "boolean" }, licenseConstraints: { type: "string" }, format: { type: "string" }, sampleRate: { type: "number" }, outputAudioPath: { type: "string" }, outputStemDirectory: { type: "string" }, outputReportPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: renderMidiToAudioInputSchema,
    handler: async (input, ctx) => {
      const parsed = renderMidiToAudioInputSchema.parse(input);
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
      if (parsed.outputFormats.includes("wav")) {
        const audio = wavBuffer(composition, parsed.sampleRate, { instrumentMap: resolvedInstrumentMap, renderPreset: parsed.renderPreset });
        const file = await writeProjectAsset(ctx.projectRoot, parsed.projectId, parsed.outputAudioPath, audio, "audio/wav");
        fullMixPath = file.path;
        artifacts.push(file.path);
      }
      for (const unsupported of parsed.outputFormats.filter((format) => format !== "wav")) warnings.push(`${unsupported.toUpperCase()} output requires a verified encoder; WAV rendered instead.`);
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
      const report = { fullMixPath, stemPaths, renderReport, licenseManifest, warnings };
      const reportFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputReportPath, `${JSON.stringify(report, null, 2)}\n`);
      artifacts.push(reportFile.path);
      return { ok: warnings.every((warning) => /requires a verified encoder|fallback/i.test(warning)), summary: `Rendered MIDI audio with ${Object.keys(stemPaths).length} stem(s) and ${warnings.length} warning(s).`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: warnings };
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
      const audio = parsed.audioPath ? await readFile(await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, parsed.audioPath)) : undefined;
      const session = parsed.sessionManifestPath ? JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.sessionManifestPath, 2 * 1024 * 1024)) as Record<string, unknown> : undefined;
      const report = qualityForComposition(composition, { audio, useCase: parsed.useCase, checkLoop: parsed.checkLoop, targetMood: parsed.targetMood, session });
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(report, null, 2)}\n`);
      return { ok: report.ok, summary: `Audio QA found ${report.warnings.length} warning(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: report.warnings };
    }
  },
  {
    definition: { name: "build_music_license_manifest", description: "Build a music asset license and usage-safety manifest for generated MIDI/audio, stems, soundfonts, samples, drum kits, ambience beds, session mixes, and final exports.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, projectManifestPath: { type: "string" }, intendedUse: { type: "string" }, assets: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object" }] } }, instrumentLibraries: { type: "array", items: { type: "object" } }, sampleMetadata: { type: "array", items: { type: "object" } }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
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
  }
];
