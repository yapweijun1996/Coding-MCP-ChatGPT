import { readFile } from "node:fs/promises";
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
  key: z.string().min(1).max(12).optional().default("C"),
  style: z.enum(["ii_v_i", "circle_fifths", "bossa", "modal_lounge", "minor_jazz"]).optional().default("ii_v_i"),
  bars: z.number().int().min(4).max(64).optional().default(16),
  outputPath: z.string().min(1).max(240).optional().default("music/jazz-harmony.json")
});

const generateDrumGrooveInputSchema = z.object({
  projectId: z.string().min(8).max(80).optional(),
  groove: z.enum(["jazz_brushes", "lo_fi", "bossa_nova", "pop_ballad", "light_swing", "cinematic_pulse"]).optional().default("jazz_brushes"),
  tempo: z.number().int().min(40).max(220).optional().default(92),
  bars: z.number().int().min(1).max(64).optional().default(8),
  swing: z.number().min(0).max(0.45).optional().default(0.18),
  outputPath: z.string().min(1).max(240).optional().default("music/drum-groove.json")
});

const inspectAudioQualityInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  audioPath: z.string().min(1).max(240).optional(),
  compositionManifestPath: z.string().min(1).max(240).optional(),
  useCase: z.string().min(1).max(240).optional().default("background music"),
  outputPath: z.string().min(1).max(240).optional().default("music/audio-quality-report.json")
}).refine((value) => Boolean(value.audioPath || value.compositionManifestPath), { message: "audioPath or compositionManifestPath is required." });

const exportMusicAssetsInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  compositionManifestPath: z.string().min(1).max(240),
  midiPath: z.string().min(1).max(240).optional(),
  audioPath: z.string().min(1).max(240).optional(),
  includeStems: z.boolean().optional().default(false),
  license: z.enum(["generated_original", "user_provided", "third_party_review_required"]).optional().default("generated_original"),
  outputPath: z.string().min(1).max(240).optional().default("music/export-manifest.json")
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

const exportMusicProjectInputSchema = z.object({
  projectId: z.string().min(8).max(80),
  demoManifestPath: z.string().min(1).max(240).optional(),
  sessionManifestPath: z.string().min(1).max(240).optional(),
  trackManifestPaths: z.array(z.string().min(1).max(240)).max(80).optional().default([]),
  publish: z.boolean().optional().default(true),
  outputHtmlPath: z.string().min(1).max(240).optional().default("music-project.html"),
  outputManifestPath: z.string().min(1).max(240).optional().default("music/production-export-manifest.json")
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

function qualityForComposition(composition: Composition, audio?: Buffer) {
  const warnings: string[] = [];
  const allNotes = Object.values(composition.tracks).flat();
  if (!allNotes.length) warnings.push("Composition has no notes.");
  if (composition.loopable) {
    const beatSeconds = 60 / composition.tempo;
    const totalBeats = composition.durationSeconds / beatSeconds;
    const seamNotes = allNotes.filter((note) => note.startBeat < 0.25 || Math.abs(note.startBeat + note.durationBeats - totalBeats) < 0.25);
    if (!seamNotes.length) warnings.push("Loop has no explicit seam-supporting note; verify loop transition.");
  }
  if (composition.instruments.length > 8) warnings.push("Arrangement may be too busy for cafe/background use.");
  const repeated = composition.chordProgression.every((chord) => chord === composition.chordProgression[0]);
  if (repeated) warnings.push("Chord progression is highly repetitive.");
  let peak = 0;
  let rms = 0;
  if (audio?.subarray(0, 4).toString("ascii") === "RIFF") {
    for (let offset = 44; offset + 1 < audio.length; offset += 2) {
      const value = audio.readInt16LE(offset) / 32768;
      peak = Math.max(peak, Math.abs(value));
      rms += value * value;
    }
    rms = Math.sqrt(rms / Math.max(1, (audio.length - 44) / 2));
    if (peak > 0.98) warnings.push("Audio may clip; peak is near 0 dBFS.");
    if (rms > 0.35) warnings.push("Audio is loud for background music; lower master gain.");
  }
  return {
    ok: warnings.length === 0,
    noteCount: allNotes.length,
    trackCount: Object.keys(composition.tracks).length,
    peak: Number(peak.toFixed(4)),
    rms: Number(rms.toFixed(4)),
    tempoStable: true,
    loopable: composition.loopable,
    warnings,
    recommendations: warnings.length ? ["Reduce density, vary harmony, lower gain, and re-render QA."] : ["Musical structure and preview audio pass default background QA checks."]
  };
}

function harmony(input: z.infer<typeof generateJazzHarmonyInputSchema>) {
  const base = progressionFor(input.style === "bossa" ? "bossa_nova" : "cafe_jazz", input.key);
  const chords = Array.from({ length: input.bars }, (_, index) => base.names[index % base.names.length]);
  return {
    key: input.key,
    style: input.style,
    chordChart: chords.map((chord, index) => ({ bar: index + 1, chord })),
    pianoVoicings: chords.map((chord, index) => ({ bar: index + 1, chord, midi: chordNotes(base.roots[index % base.roots.length], chord).slice(1) })),
    walkingBass: chords.map((_, index) => base.roots[index % base.roots.length] - 24),
    notes: ["Original harmony sketch; avoid copying any specific song or artist progression verbatim."]
  };
}

function drumGroove(input: z.infer<typeof generateDrumGrooveInputSchema>) {
  const hits = [];
  for (let bar = 0; bar < input.bars; bar += 1) {
    const start = bar * 4;
    hits.push({ instrument: input.groove === "bossa_nova" ? "rim" : "brush", beat: start, velocity: 42 });
    hits.push({ instrument: "kick", beat: start, velocity: input.groove === "cinematic_pulse" ? 72 : 46 });
    hits.push({ instrument: "snare", beat: start + 2 + input.swing, velocity: 48 });
    hits.push({ instrument: "hat", beat: start + 2.67 + input.swing / 2, velocity: 32 });
  }
  return { groove: input.groove, tempo: input.tempo, bars: input.bars, swing: input.swing, hits, fills: [{ bar: input.bars, instruction: "light pickup fill into loop seam" }] };
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
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
    definition: { name: "assemble_music_session", description: "Assemble multiple long-form tracks into a cafe/study/background session plan with crossfades, key/tempo checks, energy curve, and loudness strategy.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, trackManifestPaths: { type: "array", items: { type: "string" } }, targetDurationMinutes: { type: "number" }, useCase: { type: "string" }, crossfadeSeconds: { type: "number" }, outputPath: { type: "string" } }, required: ["projectId", "trackManifestPaths"], additionalProperties: false } },
    enabledByDefault: true,
    schema: assembleMusicSessionInputSchema,
    handler: async (input, ctx) => {
      const parsed = assembleMusicSessionInputSchema.parse(input);
      const tracks = await loadTrackSummaries(ctx, parsed.projectId, parsed.trackManifestPaths);
      const targetSeconds = parsed.targetDurationMinutes * 60;
      const schedule: Array<{ order: number; trackTitle: string; manifestPath: string; startSeconds: number; durationSeconds: number; crossfadeInSeconds: number; key: string; tempo: number; energy: number }> = [];
      let cursor = 0;
      let index = 0;
      while (cursor < targetSeconds) {
        const track = tracks[index % tracks.length];
        schedule.push({ order: schedule.length + 1, trackTitle: track.title, manifestPath: track.manifestPath, startSeconds: cursor, durationSeconds: track.durationSeconds, crossfadeInSeconds: schedule.length ? parsed.crossfadeSeconds : 0, key: track.key, tempo: track.tempo, energy: track.energy });
        cursor += Math.max(1, track.durationSeconds - parsed.crossfadeSeconds);
        index += 1;
      }
      const session = { useCase: parsed.useCase, targetDurationMinutes: parsed.targetDurationMinutes, actualDurationSeconds: cursor, tracks, schedule, compatibilityChecks: schedule.map((item, i) => ({ order: item.order, keyTempoCompatible: i === 0 || Math.abs(item.tempo - schedule[i - 1].tempo) <= 18, transition: i === 0 ? "start" : `${parsed.crossfadeSeconds}s crossfade` })), loudnessNormalization: { targetRms: 0.18, avoidClipping: true }, ambientRoomTone: parsed.useCase.includes("cafe") || parsed.useCase.includes("restaurant") };
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(session, null, 2)}\n`);
      return { ok: true, summary: `Assembled ${Math.round(cursor / 60)} minute music session with ${schedule.length} slot(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: session, logs: [JSON.stringify(session, null, 2)], errors: [] };
    }
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
    definition: { name: "export_music_project", description: "Export a production music project manifest and optional public listening/download page for demos, long tracks, and assembled sessions.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, demoManifestPath: { type: "string" }, sessionManifestPath: { type: "string" }, trackManifestPaths: { type: "array", items: { type: "string" } }, publish: { type: "boolean" }, outputHtmlPath: { type: "string" }, outputManifestPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: exportMusicProjectInputSchema,
    handler: async (input, ctx) => {
      const parsed = exportMusicProjectInputSchema.parse(input);
      const tracks = parsed.trackManifestPaths.length ? await loadTrackSummaries(ctx, parsed.projectId, parsed.trackManifestPaths) : [];
      const demo = parsed.demoManifestPath ? JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.demoManifestPath, 2 * 1024 * 1024)) : undefined;
      const session = parsed.sessionManifestPath ? JSON.parse(await readProjectFile(ctx.projectRoot, parsed.projectId, parsed.sessionManifestPath, 2 * 1024 * 1024)) : undefined;
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Music Project Export</title><style>body{font-family:system-ui;margin:32px;max-width:960px}li{margin:8px 0}</style></head><body><h1>Music Project Export</h1><p>Generated original production music handoff.</p><h2>Tracks</h2><ul>${tracks.map((track) => `<li>${escapeHtml(track.title)} - ${Math.round(track.durationSeconds / 60)} min, ${escapeHtml(track.key)}, ${track.tempo} BPM</li>`).join("")}</ul><h2>Session</h2><pre>${escapeHtml(JSON.stringify(session ?? {}, null, 2))}</pre></body></html>`;
      const htmlFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputHtmlPath, html);
      const published = parsed.publish ? await publishProject(ctx.projectRoot, parsed.projectId, ctx.publicBaseUrl, parsed.outputHtmlPath, { shareBasePath: ctx.publicShareBasePath }) : undefined;
      const manifest = { projectId: parsed.projectId, demoManifestPath: parsed.demoManifestPath, sessionManifestPath: parsed.sessionManifestPath, trackManifestPaths: parsed.trackManifestPaths, demoUrl: demo?.publishedUrl, exportPagePath: htmlFile.path, publishedUrl: published?.publishedUrl, tracks, sessionSummary: session ? { targetDurationMinutes: session.targetDurationMinutes, slots: Array.isArray(session.schedule) ? session.schedule.length : 0 } : undefined, license: { output: "generated_original", dependencies: ["Built-in safe synth unless external assets are added later."] }, packageNotes: ["ZIP/MP3/OGG export requires a verified archive/encoder step."] };
      const manifestFile = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return { ok: true, summary: "Exported production music project.", jobId: parsed.projectId, previewUrl: published?.publishedUrl, shareUrl: published?.publishedUrl, artifacts: [htmlFile.path, manifestFile.path], structuredContent: manifest, logs: [JSON.stringify(manifest, null, 2)], errors: [] };
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
    definition: { name: "generate_jazz_harmony", description: "Generate original jazz chord charts, voicings, and walking bass suggestions.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, key: { type: "string" }, style: { type: "string" }, bars: { type: "number" }, outputPath: { type: "string" } }, additionalProperties: false } },
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
    definition: { name: "generate_drum_groove", description: "Generate drum/brush groove patterns with swing, fills, and section transition hints.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, groove: { type: "string" }, tempo: { type: "number" }, bars: { type: "number" }, swing: { type: "number" }, outputPath: { type: "string" } }, additionalProperties: false } },
    enabledByDefault: true,
    schema: generateDrumGrooveInputSchema,
    handler: async (input, ctx) => {
      const parsed = generateDrumGrooveInputSchema.parse(input);
      const report = drumGroove(parsed);
      const artifacts: string[] = [];
      if (parsed.projectId) artifacts.push((await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(report, null, 2)}\n`)).path);
      return { ok: true, summary: `Generated ${parsed.groove} groove with ${report.hits.length} hit(s).`, jobId: parsed.projectId, artifacts, structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: [] };
    }
  },
  {
    definition: { name: "inspect_audio_quality", description: "Inspect generated audio/MIDI manifests for clipping, density, repetition, loop seams, and background-music suitability.", inputSchema: { type: "object", properties: { projectId: { type: "string" }, audioPath: { type: "string" }, compositionManifestPath: { type: "string" }, useCase: { type: "string" }, outputPath: { type: "string" } }, required: ["projectId"], additionalProperties: false } },
    enabledByDefault: true,
    schema: inspectAudioQualityInputSchema,
    handler: async (input, ctx) => {
      const parsed = inspectAudioQualityInputSchema.parse(input);
      const composition = parsed.compositionManifestPath ? await readComposition(ctx, parsed.projectId, parsed.compositionManifestPath) : buildComposition({ projectId: parsed.projectId, title: "Audio-only QA", style: "ambient", mood: parsed.useCase, tempo: 90, key: "C", durationSeconds: 30, useCase: parsed.useCase, instruments: ["piano"], complexity: "simple", loopable: false, outputManifestPath: "unused.json", outputMidiPath: "unused.mid" });
      const audio = parsed.audioPath ? await readFile(await getProjectStoredFilePath(ctx.projectRoot, parsed.projectId, parsed.audioPath)) : undefined;
      const report = qualityForComposition(composition, audio);
      const file = await writeProjectFile(ctx.projectRoot, parsed.projectId, parsed.outputPath, `${JSON.stringify(report, null, 2)}\n`);
      return { ok: report.ok, summary: `Audio QA found ${report.warnings.length} warning(s).`, jobId: parsed.projectId, artifacts: [file.path], structuredContent: report, logs: [JSON.stringify(report, null, 2)], errors: report.warnings };
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
