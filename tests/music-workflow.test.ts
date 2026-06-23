import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, getProjectStoredFilePath, readProjectFile } from "../src/projects/store.js";
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
    clientId: "music-workflow-test"
  };
}

test("music workflow composes, edits, renders, audits, and exports music assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-workflow-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Music project", createdByClientId: "composer" });
    const styleBrief = getToolModule("create_music_style_brief");
    const compose = getToolModule("compose_music");
    const edit = getToolModule("edit_midi");
    const render = getToolModule("render_midi_to_audio");
    const harmony = getToolModule("generate_jazz_harmony");
    const drums = getToolModule("generate_drum_groove");
    const inspect = getToolModule("inspect_audio_quality");
    const exportAssets = getToolModule("export_music_assets");
    const audition = getToolModule("audition_music_variations");
    for (const [name, tool] of Object.entries({ styleBrief, compose, edit, render, harmony, drums, inspect, exportAssets, audition })) assert.ok(tool, `${name} registered`);

    const briefResult = await styleBrief!.handler({
      projectId: project.id,
      referencePrompt: "Starbucks-style cafe jazz background music",
      useCase: "coffee shop website hero background"
    }, ctx);
    assert.equal(briefResult.ok, true);
    const briefPayload = briefResult.structuredContent as { legalBoundary: string; instruments: string[] };
    assert.match(briefPayload.legalBoundary, /do not copy/i);
    assert.ok(briefPayload.instruments.includes("piano"));

    const composeResult = await compose!.handler({
      projectId: project.id,
      title: "Warm Cafe Loop",
      style: "cafe_jazz",
      mood: "warm, relaxed",
      tempo: 92,
      key: "C",
      durationSeconds: 16,
      useCase: "background music",
      instruments: ["piano", "upright_bass", "brushes"],
      loopable: true
    }, ctx);
    assert.equal(composeResult.ok, true);
    assert.deepEqual(composeResult.artifacts.sort(), ["music/composition-manifest.json", "music/composition.mid"].sort());
    const midiPath = await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/composition.mid");
    const midi = await readFile(midiPath);
    assert.equal(midi.subarray(0, 4).toString("ascii"), "MThd");
    const composition = composeResult.structuredContent as { chordProgression: string[]; tracks: Record<string, unknown[]>; license: { output: string } };
    assert.ok(composition.chordProgression.includes("Dm9"));
    assert.ok(composition.tracks.piano.length > 0);
    assert.equal(composition.license.output, "generated_original");

    const editResult = await edit!.handler({
      projectId: project.id,
      compositionManifestPath: "music/composition-manifest.json",
      quantizeBeats: 0.5,
      transposeSemitones: 2,
      swing: 0.12,
      velocityScale: 0.9
    }, ctx);
    assert.equal(editResult.ok, true);
    assert.ok(editResult.artifacts.includes("music/edited-composition.mid"));

    const renderResult = await render!.handler({
      projectId: project.id,
      compositionManifestPath: "music/edited-composition-manifest.json",
      sampleRate: 16000,
      instrumentMap: { piano: "warm_acoustic_piano", bass: "upright_bass", drums: "jazz_brushes" },
      renderPreset: "warm_cafe",
      outputFormats: ["wav", "mp3"],
      stems: true
    }, ctx);
    assert.equal(renderResult.ok, true);
    const wavPath = await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/rendered-preview.wav");
    const wav = await readFile(wavPath);
    assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
    const renderPayload = renderResult.structuredContent as {
      fullMixPath: string;
      stemPaths: Record<string, string>;
      renderReport: { requestedFormats: string[]; renderedFormats: string[]; sampleRate: number; bitDepth: number; peakLevel: number; missingInstrumentFallbackWarnings: string[]; fileSizes: Record<string, number> };
      licenseManifest: { renderer: string; instruments: Record<string, { license: string }> };
      warnings: string[];
    };
    assert.equal(renderPayload.fullMixPath, "music/rendered-preview.wav");
    assert.ok(renderPayload.stemPaths.piano);
    assert.ok(renderPayload.stemPaths.bass);
    assert.ok(renderPayload.stemPaths.drums);
    assert.deepEqual(renderPayload.renderReport.requestedFormats, ["wav", "mp3"]);
    assert.deepEqual(renderPayload.renderReport.renderedFormats, ["wav"]);
    assert.equal(renderPayload.renderReport.sampleRate, 16000);
    assert.equal(renderPayload.renderReport.bitDepth, 16);
    assert.ok(renderPayload.renderReport.peakLevel > 0);
    assert.equal(renderPayload.renderReport.missingInstrumentFallbackWarnings.length, 0);
    assert.equal(renderPayload.licenseManifest.renderer, "built_in_safe_synth");
    assert.equal(renderPayload.licenseManifest.instruments.piano.license, "generated_original_procedural");
    assert.ok(renderPayload.warnings.some((warning) => warning.includes("MP3 output requires")));
    const renderReport = await readProjectFile(ctx.projectRoot, project.id, "music/render-report.json");
    assert.match(renderReport, /licenseManifest/);
    const pianoStem = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, renderPayload.stemPaths.piano));
    assert.equal(pianoStem.subarray(0, 4).toString("ascii"), "RIFF");

    const qaResult = await inspect!.handler({
      projectId: project.id,
      audioPath: "music/rendered-preview.wav",
      compositionManifestPath: "music/edited-composition-manifest.json"
    }, ctx);
    assert.equal(qaResult.ok, true);
    const qaPayload = qaResult.structuredContent as { noteCount: number; peak: number; warnings: string[] };
    assert.ok(qaPayload.noteCount > 0);
    assert.ok(qaPayload.peak > 0);
    assert.deepEqual(qaPayload.warnings, []);

    const exportResult = await exportAssets!.handler({
      projectId: project.id,
      compositionManifestPath: "music/edited-composition-manifest.json",
      midiPath: "music/edited-composition.mid",
      audioPath: "music/rendered-preview.wav",
      includeStems: true
    }, ctx);
    assert.equal(exportResult.ok, true);
    const exportManifest = await readProjectFile(ctx.projectRoot, project.id, "music/export-manifest.json");
    assert.match(exportManifest, /generated_original/);
    assert.equal(exportManifest.includes("MP3/OGG export requires"), true);

    const harmonyResult = await harmony!.handler({ projectId: project.id, key: "C", style: "bossa", bars: 8 }, ctx);
    assert.equal(harmonyResult.ok, true);
    const harmonyPayload = harmonyResult.structuredContent as { chordChart: unknown[]; pianoVoicings: unknown[] };
    assert.equal(harmonyPayload.chordChart.length, 8);
    assert.equal(harmonyPayload.pianoVoicings.length, 8);

    const drumsResult = await drums!.handler({ projectId: project.id, groove: "jazz_brushes", bars: 4, swing: 0.2 }, ctx);
    assert.equal(drumsResult.ok, true);
    const drumPayload = drumsResult.structuredContent as { hits: unknown[]; fills: unknown[] };
    assert.equal(drumPayload.hits.length, 16);
    assert.equal(drumPayload.fills.length, 1);

    const auditionResult = await audition!.handler({
      projectId: project.id,
      brief: "three relaxed cafe loops for website background",
      styles: ["cafe_jazz", "bossa_nova", "lo_fi"]
    }, ctx);
    assert.equal(auditionResult.ok, true);
    const auditionPayload = auditionResult.structuredContent as { variations: unknown[]; recommended: { style: string } };
    assert.equal(auditionPayload.variations.length, 3);
    assert.equal(auditionPayload.recommended.style, "cafe_jazz");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production music workflow publishes auditions, extends arrangements, assembles sessions, normalizes audio, and exports project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-production-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Production music", createdByClientId: "producer" });
    const variations = getToolModule("generate_music_variations");
    const publishDemo = getToolModule("publish_music_audition_demo");
    const extend = getToolModule("extend_music_arrangement");
    const session = getToolModule("assemble_music_session");
    const normalize = getToolModule("normalize_music_loudness");
    const exportProject = getToolModule("export_music_project");
    for (const [name, tool] of Object.entries({ variations, publishDemo, extend, session, normalize, exportProject })) assert.ok(tool, `${name} registered`);

    const variationsResult = await variations!.handler({
      projectId: project.id,
      brief: "warm cafe jazz with piano, upright bass, brushes",
      styles: ["cafe_jazz", "bossa_nova", "lo_fi"],
      durationSeconds: 12,
      renderAudio: true
    }, ctx);
    assert.equal(variationsResult.ok, true);
    const variationsPayload = variationsResult.structuredContent as { variations: Array<{ id: string; manifestPath: string; midiPath: string; audioPath: string; label: string }> };
    assert.equal(variationsPayload.variations.length, 3);
    assert.equal(variationsPayload.variations[0].id, "version_A");
    const variationAudioPath = await getProjectStoredFilePath(ctx.projectRoot, project.id, variationsPayload.variations[0].audioPath);
    assert.equal((await readFile(variationAudioPath)).subarray(0, 4).toString("ascii"), "RIFF");

    const demoResult = await publishDemo!.handler({
      projectId: project.id,
      variationsManifestPath: "music/production-variations.json",
      title: "Cafe Music Audition",
      publish: true
    }, ctx);
    assert.equal(demoResult.ok, true);
    const demoPayload = demoResult.structuredContent as { demoUrl: string; publishedUrl: string; feedbackFields: string[]; variations: unknown[]; versionIds: string[]; selectedVersionWorkflow: { nextTool: string } };
    assert.match(demoPayload.demoUrl, /https:\/\/example\.test/);
    assert.match(demoPayload.publishedUrl, /https:\/\/example\.test/);
    assert.ok(demoPayload.feedbackFields.includes("winner"));
    assert.ok(demoPayload.feedbackFields.includes("rating"));
    assert.deepEqual(demoPayload.versionIds, ["version_A", "version_B", "version_C"]);
    assert.equal(demoPayload.selectedVersionWorkflow.nextTool, "extend_music_arrangement");
    assert.equal(demoPayload.variations.length, 3);
    const demoHtml = await readProjectFile(ctx.projectRoot, project.id, "music-demo.html");
    assert.match(demoHtml, /<audio controls/);
    assert.match(demoHtml, /Version A/);
    assert.match(demoHtml, /Warmer piano/);
    assert.match(demoHtml, /Rating/);

    const extendResult = await extend!.handler({
      projectId: project.id,
      compositionManifestPath: variationsPayload.variations[0].manifestPath,
      targetDurationSeconds: 300,
      arrangementStyle: "background_friendly",
      renderAudio: false
    }, ctx);
    assert.equal(extendResult.ok, true);
    const extendPayload = extendResult.structuredContent as { durationSeconds: number; sections: Array<{ name: string }>; midiPath: string };
    assert.equal(extendPayload.durationSeconds, 300);
    assert.ok(extendPayload.sections.some((item) => item.name === "bridge"));
    assert.equal(extendPayload.midiPath, "music/long-arrangement.mid");
    const longMidi = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/long-arrangement.mid"));
    assert.equal(longMidi.subarray(0, 4).toString("ascii"), "MThd");

    const secondExtend = await extend!.handler({
      projectId: project.id,
      compositionManifestPath: variationsPayload.variations[1].manifestPath,
      targetDurationSeconds: 240,
      outputManifestPath: "music/long-arrangement-b.json",
      outputMidiPath: "music/long-arrangement-b.mid"
    }, ctx);
    assert.equal(secondExtend.ok, true);

    const sessionResult = await session!.handler({
      projectId: project.id,
      trackManifestPaths: ["music/long-arrangement-manifest.json", "music/long-arrangement-b.json"],
      targetDurationMinutes: 10,
      useCase: "cafe_ambience",
      crossfadeSeconds: 6
    }, ctx);
    assert.equal(sessionResult.ok, true);
    const sessionPayload = sessionResult.structuredContent as { schedule: unknown[]; compatibilityChecks: unknown[]; loudnessNormalization: { targetRms: number }; ambientRoomTone: boolean };
    assert.ok(sessionPayload.schedule.length >= 2);
    assert.equal(sessionPayload.compatibilityChecks.length, sessionPayload.schedule.length);
    assert.equal(sessionPayload.loudnessNormalization.targetRms, 0.18);
    assert.equal(sessionPayload.ambientRoomTone, true);

    const normalizeResult = await normalize!.handler({
      projectId: project.id,
      audioPath: variationsPayload.variations[0].audioPath,
      targetRms: 0.16
    }, ctx);
    assert.equal(normalizeResult.ok, true);
    const normalizePayload = normalizeResult.structuredContent as { normalizedAudioPath: string; before: { rms: number }; after: { rms: number }; backgroundSuitabilityScore: number };
    assert.equal(normalizePayload.normalizedAudioPath, "music/normalized-preview.wav");
    assert.ok(normalizePayload.before.rms > 0);
    assert.ok(normalizePayload.after.rms > 0);
    assert.ok(normalizePayload.backgroundSuitabilityScore >= 70);

    const exportResult = await exportProject!.handler({
      projectId: project.id,
      demoManifestPath: "music/audition-demo-manifest.json",
      sessionManifestPath: "music/session-assembly.json",
      trackManifestPaths: ["music/long-arrangement-manifest.json", "music/long-arrangement-b.json"],
      publish: true
    }, ctx);
    assert.equal(exportResult.ok, true);
    const exportPayload = exportResult.structuredContent as { publishedUrl: string; sessionSummary: { slots: number }; tracks: unknown[]; packageNotes: string[] };
    assert.match(exportPayload.publishedUrl, /https:\/\/example\.test/);
    assert.equal(exportPayload.tracks.length, 2);
    assert.ok(exportPayload.sessionSummary.slots >= 2);
    assert.ok(exportPayload.packageNotes.some((note) => note.includes("ZIP/MP3/OGG")));
    const exportHtml = await readProjectFile(ctx.projectRoot, project.id, "music-project.html");
    assert.match(exportHtml, /Music Project Export/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("music audition publisher accepts direct version metadata and returns continuation fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-audition-direct-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Direct audition", createdByClientId: "producer" });
    const compose = getToolModule("compose_music");
    const render = getToolModule("render_midi_to_audio");
    const publishDemo = getToolModule("publish_music_audition_demo");
    assert.ok(compose);
    assert.ok(render);
    assert.ok(publishDemo);

    await compose!.handler({
      projectId: project.id,
      title: "Direct A",
      style: "cafe_jazz",
      durationSeconds: 10,
      outputManifestPath: "music/direct-a.json",
      outputMidiPath: "music/direct-a.mid"
    }, ctx);
    await render!.handler({
      projectId: project.id,
      compositionManifestPath: "music/direct-a.json",
      outputAudioPath: "music/direct-a.wav",
      sampleRate: 12000
    }, ctx);
    await compose!.handler({
      projectId: project.id,
      title: "Direct B",
      style: "bossa_nova",
      durationSeconds: 10,
      outputManifestPath: "music/direct-b.json",
      outputMidiPath: "music/direct-b.mid"
    }, ctx);
    await render!.handler({
      projectId: project.id,
      compositionManifestPath: "music/direct-b.json",
      outputAudioPath: "music/direct-b.wav",
      sampleRate: 12000
    }, ctx);

    const result = await publishDemo!.handler({
      projectId: project.id,
      projectTitle: "Cafe Jazz Auditions",
      versions: [
        { id: "A", audioPath: "music/direct-a.wav", midiPath: "music/direct-a.mid", manifestPath: "music/direct-a.json", title: "Warm Piano Trio", bpm: 82, key: "F major", durationSec: 75, instruments: ["piano", "upright bass", "brushes"], moodTags: ["warm", "relaxed"], styleNotes: ["soft trio"], generatedPrompt: "warm cafe jazz" },
        { id: "B", audioPath: "music/direct-b.wav", midiPath: "music/direct-b.mid", manifestPath: "music/direct-b.json", title: "Bossa Lounge", bpm: 92, key: "D minor", durationSec: 80, instruments: ["piano", "bass", "brushes"], moodTags: ["bossa", "smooth"], styleNotes: ["lighter groove"], generatedPrompt: "bossa cafe lounge" }
      ],
      outputHtmlPath: "direct-audition.html",
      outputManifestPath: "music/direct-audition-manifest.json"
    }, ctx);
    assert.equal(result.ok, true);
    const payload = result.structuredContent as { demoUrl: string; projectId: string; versionIds: string[]; manifestPath: string; selectedVersionWorkflow: { nextTool: string; revisionOptions: string[] } };
    assert.match(payload.demoUrl, /https:\/\/example\.test/);
    assert.equal(payload.projectId, project.id);
    assert.deepEqual(payload.versionIds, ["A", "B"]);
    assert.equal(payload.manifestPath, "music/direct-audition-manifest.json");
    assert.equal(payload.selectedVersionWorkflow.nextTool, "extend_music_arrangement");
    assert.ok(payload.selectedVersionWorkflow.revisionOptions.includes("less drums"));
    const html = await readProjectFile(ctx.projectRoot, project.id, "direct-audition.html");
    assert.match(html, /Warm Piano Trio/);
    assert.match(html, /Bossa Lounge/);
    assert.match(html, /Choose this version/);
    assert.match(html, /Download audio/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compose_edit_midi creates editable multi-track MIDI with sections and operations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "compose-edit-midi-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "MIDI editor", createdByClientId: "midi" });
    const composeEdit = getToolModule("compose_edit_midi");
    assert.ok(composeEdit);

    const result = await composeEdit!.handler({
      projectId: project.id,
      style: "cafe_jazz",
      tempoBpm: 82,
      key: "F major",
      durationSec: 300,
      tracks: ["piano", "upright_bass", "brush_drums"],
      sections: ["intro", "A", "B", "solo", "A2", "outro"],
      constraints: {
        backgroundFriendly: true,
        loopable: false,
        swing: 0.58,
        avoidHarshRegister: true,
        stableDynamics: true
      },
      operations: [
        { type: "quantize", value: 0.5 },
        { type: "humanize", value: 0.01 },
        { type: "adjust_velocity", track: "piano", value: 0.85 },
        { type: "duplicate_section", section: "A" },
        { type: "add_fill", track: "brush_drums" },
        { type: "change_instrument", track: "piano", value: "warm upright piano" }
      ]
    }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts.sort(), ["music/compose-edit-midi-manifest.json", "music/compose-edit-midi.mid"].sort());
    const payload = result.structuredContent as {
      midiPath: string;
      manifestPath: string;
      trackList: Array<{ name: string; instrument: string; noteCount: number; exportStemReady: boolean }>;
      sectionMap: Array<{ name: string; startBeat: number; endBeat: number }>;
      chordChart: Array<{ section: string; chord: string }>;
      warnings: string[];
      editableOperations: string[];
    };
    assert.equal(payload.midiPath, "music/compose-edit-midi.mid");
    assert.equal(payload.manifestPath, "music/compose-edit-midi-manifest.json");
    assert.ok(payload.trackList.some((track) => track.name === "piano" && track.instrument === "warm upright piano" && track.exportStemReady));
    assert.ok(payload.trackList.some((track) => track.name === "bass" && track.noteCount > 0));
    assert.ok(payload.trackList.some((track) => track.name === "drums" && track.noteCount > 0));
    assert.ok(payload.sectionMap.some((section) => section.name === "A_copy"));
    assert.equal(payload.chordChart.length, 6);
    assert.deepEqual(payload.warnings, []);
    assert.ok(payload.editableOperations.includes("mute_track"));
    assert.ok(payload.editableOperations.includes("solo_track"));
    const midiPath = await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/compose-edit-midi.mid");
    assert.equal((await readFile(midiPath)).subarray(0, 4).toString("ascii"), "MThd");
    const manifest = await readProjectFile(ctx.projectRoot, project.id, "music/compose-edit-midi-manifest.json");
    assert.match(manifest, /sectionMap/);
    assert.match(manifest, /chordChart/);

    const soloResult = await composeEdit!.handler({
      projectId: project.id,
      existingManifestPath: "music/compose-edit-midi-manifest.json",
      operations: [{ type: "solo_track", track: "piano" }],
      outputManifestPath: "music/compose-edit-midi-solo.json",
      outputMidiPath: "music/compose-edit-midi-solo.mid"
    }, ctx);
    assert.equal(soloResult.ok, true);
    const soloPayload = soloResult.structuredContent as { trackList: Array<{ name: string; solo: boolean; noteCount: number }> };
    assert.ok(soloPayload.trackList.some((track) => track.name === "piano" && track.solo && track.noteCount > 0));
    assert.ok(soloPayload.trackList.some((track) => track.name === "bass" && track.noteCount === 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extend_original_music_arrangement creates long-form section map and originality report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "original-arrangement-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Original arrangement", createdByClientId: "arranger" });
    const compose = getToolModule("compose_music");
    const extendOriginal = getToolModule("extend_original_music_arrangement");
    assert.ok(compose);
    assert.ok(extendOriginal);

    await compose!.handler({
      projectId: project.id,
      title: "Selected Cafe Sketch",
      style: "cafe_jazz",
      mood: "warm original sketch",
      tempo: 88,
      key: "F",
      durationSeconds: 45,
      instruments: ["piano", "upright_bass", "brushes"],
      loopable: false,
      outputManifestPath: "music/selected-sketch.json",
      outputMidiPath: "music/selected-sketch.mid"
    }, ctx);

    const result = await extendOriginal!.handler({
      projectId: project.id,
      sourceManifestPath: "music/selected-sketch.json",
      targetDurationSec: 360,
      styleFamily: "cafe_jazz",
      backgroundUse: "coffee_shop",
      variationLevel: "medium",
      sections: ["intro", "A", "A_variation", "B", "bridge", "light_solo", "breakdown", "reprise", "outro"],
      originalityPolicy: "do_not_imitate_specific_songs_or_artists",
      renderAudio: false
    }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts.sort(), ["music/original-long-arrangement-manifest.json", "music/original-long-arrangement.mid"].sort());
    const payload = result.structuredContent as {
      extendedMidiPath: string;
      arrangementManifestPath: string;
      sectionMap: Array<{ name: string; role: string; energy: number; transition: string }>;
      developmentReport: { targetDurationSec: number; styleFamily: string; backgroundUse: string; developmentMoves: string[]; backgroundFriendliness: { stableVolume: boolean } };
      originalityNotes: string[];
      warnings: string[];
      renderReady: boolean;
    };
    assert.equal(payload.extendedMidiPath, "music/original-long-arrangement.mid");
    assert.equal(payload.arrangementManifestPath, "music/original-long-arrangement-manifest.json");
    assert.equal(payload.sectionMap.length, 9);
    assert.ok(payload.sectionMap.some((section) => section.name === "light_solo" && section.role === "light improvisation"));
    assert.ok(payload.sectionMap.every((section) => section.transition.length > 0));
    assert.equal(payload.developmentReport.targetDurationSec, 360);
    assert.equal(payload.developmentReport.styleFamily, "cafe_jazz");
    assert.equal(payload.developmentReport.backgroundUse, "coffee_shop");
    assert.ok(payload.developmentReport.developmentMoves.some((move) => move.includes("instrument entrance")));
    assert.equal(payload.developmentReport.backgroundFriendliness.stableVolume, true);
    assert.ok(payload.originalityNotes.some((note) => note.includes("Do not imitate")));
    assert.deepEqual(payload.warnings, []);
    assert.equal(payload.renderReady, true);
    const midi = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/original-long-arrangement.mid"));
    assert.equal(midi.subarray(0, 4).toString("ascii"), "MThd");
    const manifest = await readProjectFile(ctx.projectRoot, project.id, "music/original-long-arrangement-manifest.json");
    assert.match(manifest, /developmentReport/);
    assert.match(manifest, /originalityNotes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("music-workflow skill exposes music tools through dedicated, coding, and debug skills", () => {
  const toolNames = [
    "create_music_style_brief",
    "compose_edit_midi",
    "generate_music_variations",
    "publish_music_audition_demo",
    "extend_music_arrangement",
    "extend_original_music_arrangement",
    "assemble_music_session",
    "normalize_music_loudness",
    "export_music_project",
    "compose_music",
    "edit_midi",
    "render_midi_to_audio",
    "generate_jazz_harmony",
    "generate_drum_groove",
    "inspect_audio_quality",
    "export_music_assets",
    "audition_music_variations"
  ];
  const music = skillRegistry.find((entry) => entry.id === "music-workflow");
  const coding = skillRegistry.find((entry) => entry.id === "coding");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(music);
  for (const toolName of toolNames) {
    assert.ok(music!.toolNames.includes(toolName), `${toolName} exposed in music-workflow`);
    assert.ok(coding?.toolNames.includes(toolName), `${toolName} exposed in coding`);
    assert.ok(debug?.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
