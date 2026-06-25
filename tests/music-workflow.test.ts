import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, getProjectStoredFilePath, readProjectFile, writeProjectFile } from "../src/projects/store.js";
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
    const licenseManifest = getToolModule("build_music_license_manifest");
    const packManager = getToolModule("manage_jazz_instrument_packs");
    const exportAssets = getToolModule("export_music_assets");
    const audition = getToolModule("audition_music_variations");
    for (const [name, tool] of Object.entries({ styleBrief, compose, edit, render, harmony, drums, inspect, licenseManifest, packManager, exportAssets, audition })) assert.ok(tool, `${name} registered`);

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
      compositionManifestPath: "music/edited-composition-manifest.json",
      useCase: "cafe_background",
      checkLoop: true,
      targetMood: "warm calm jazz"
    }, ctx);
    assert.equal(qaResult.ok, true);
    const qaPayload = qaResult.structuredContent as {
      noteCount: number;
      peak: number;
      warnings: string[];
      technicalReport: { format: string; sampleRate: number; bitDepth: number; durationSeconds: number; peak: number; rms: number; silenceGaps: unknown[]; harshHighFrequencyProxy: number; excessiveBassProxy: number };
      loudnessReport: { peak: number; rms: number; estimatedLufs: number; dynamicRange: number };
      loopSeamReport: { checked: boolean; loopable: boolean; seamClickProxy: number };
      backgroundSuitabilityScore: number;
      findings: Array<{ severity: string; category: string; message: string; suggestedFix: string }>;
      suggestedFixes: string[];
      recommendations: string[];
    };
    assert.ok(qaPayload.noteCount > 0);
    assert.ok(qaPayload.peak > 0);
    assert.equal(qaPayload.technicalReport.format, "wav_pcm");
    assert.equal(qaPayload.technicalReport.sampleRate, 16000);
    assert.equal(qaPayload.technicalReport.bitDepth, 16);
    assert.ok(qaPayload.technicalReport.durationSeconds > 0);
    assert.ok(qaPayload.technicalReport.peak > 0);
    assert.ok(qaPayload.technicalReport.rms > 0);
    assert.deepEqual(qaPayload.technicalReport.silenceGaps, []);
    assert.ok(qaPayload.technicalReport.harshHighFrequencyProxy >= 0);
    assert.ok(qaPayload.technicalReport.excessiveBassProxy >= 0);
    assert.ok(qaPayload.loudnessReport.estimatedLufs < 0);
    assert.equal(qaPayload.loopSeamReport.checked, true);
    assert.equal(qaPayload.loopSeamReport.loopable, true);
    assert.ok(qaPayload.loopSeamReport.seamClickProxy >= 0);
    assert.ok(qaPayload.backgroundSuitabilityScore >= 90);
    assert.deepEqual(qaPayload.findings, []);
    assert.deepEqual(qaPayload.suggestedFixes, []);
    assert.deepEqual(qaPayload.warnings, []);
    assert.ok(qaPayload.recommendations.some((item) => item.includes("pass default background QA")));

    const blockedLicenseResult = await licenseManifest!.handler({
      projectId: project.id,
      intendedUse: "business_demo_and_website_background",
      assets: [
        "music/edited-composition.mid",
        "music/rendered-preview.wav",
        "music/stems/piano.wav",
        { path: "instruments/warm_piano.sf2", type: "soundfont", license: "unknown", source: "external library" },
        { path: "samples/brush-loop-cc-by.wav", type: "sample_pack", license: "cc_by", attribution: "Brush loop by Example Creator (CC-BY)" }
      ],
      outputPath: "music/license-safety-blocked.json"
    }, ctx);
    assert.equal(blockedLicenseResult.ok, false);
    const blockedLicensePayload = blockedLicenseResult.structuredContent as {
      licenseManifestPath: string;
      assetLicenseTable: Array<{ path: string; type: string; license: string; commercialUseAllowed: boolean; attributionRequired: boolean; usageStatus: string }>;
      commercialUseStatus: string;
      attributionText: string;
      unsafeAssets: Array<{ path: string; license: string }>;
      warnings: string[];
      userFacingSummary: string;
      businessDemoSuitable: boolean;
      zipExportSummary: { blockFinalExport: boolean };
    };
    assert.equal(blockedLicensePayload.licenseManifestPath, "music/license-safety-blocked.json");
    assert.equal(blockedLicensePayload.commercialUseStatus, "blocked_pending_license_review");
    assert.equal(blockedLicensePayload.businessDemoSuitable, false);
    assert.equal(blockedLicensePayload.zipExportSummary.blockFinalExport, true);
    assert.ok(blockedLicensePayload.assetLicenseTable.some((asset) => asset.path === "music/edited-composition.mid" && asset.license === "generated_original"));
    assert.ok(blockedLicensePayload.assetLicenseTable.some((asset) => asset.path === "samples/brush-loop-cc-by.wav" && asset.attributionRequired));
    assert.match(blockedLicensePayload.attributionText, /Brush loop by Example Creator/);
    assert.ok(blockedLicensePayload.unsafeAssets.some((asset) => asset.path === "instruments/warm_piano.sf2"));
    assert.ok(blockedLicensePayload.warnings.some((warning) => warning.includes("warm_piano.sf2")));
    assert.match(blockedLicensePayload.userFacingSummary, /license review/i);

    const safeLicenseResult = await licenseManifest!.handler({
      projectId: project.id,
      intendedUse: "business_demo",
      assets: [
        "music/edited-composition.mid",
        "music/rendered-preview.wav",
        { path: "renderer/built-in-safe-synth", type: "virtual_instrument", license: "generated_original", commercialUseAllowed: true }
      ],
      outputPath: "music/license-safety-manifest.json"
    }, ctx);
    assert.equal(safeLicenseResult.ok, true);
    const safeLicensePayload = safeLicenseResult.structuredContent as { commercialUseStatus: string; unsafeAssets: unknown[]; attributionRequired: boolean; userFacingSummary: string; licenseManifestPath: string };
    assert.equal(safeLicensePayload.licenseManifestPath, "music/license-safety-manifest.json");
    assert.equal(safeLicensePayload.commercialUseStatus, "allowed");
    assert.equal(safeLicensePayload.unsafeAssets.length, 0);
    assert.equal(safeLicensePayload.attributionRequired, false);
    assert.match(safeLicensePayload.userFacingSummary, /commercial-safe/);

    const pianoSfz = "<region> sample=piano-C4.wav key=60\n";
    const bassSfz = "<region> sample=bass-E2.wav key=40\n";
    const brushesSfz = "<region> sample=brush-snare.wav key=38\n";
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/piano/warm-pack.json", pianoSfz);
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/bass/upright-pack.json", bassSfz);
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/brushes/soft-pack.json", brushesSfz);

    const blockedPackResult = await packManager!.handler({
      projectId: project.id,
      intendedUse: "client_delivery",
      packs: [
        {
          packId: "warm_piano_mit",
          displayName: "Warm Piano MIT",
          instrumentRole: "realistic_piano",
          format: "sfz",
          assetPaths: ["instruments/piano/warm-pack.json"],
          version: "1.0.0",
          declaredSha256: createHash("sha256").update(pianoSfz).digest("hex"),
          licenseType: "mit",
          source: "project fixture",
          commercialUseAllowed: true,
          redistributionAllowed: true,
          modificationsAllowed: true
        },
        {
          packId: "upright_bass_lgpl",
          displayName: "Upright Bass LGPL",
          instrumentRole: "upright_bass",
          format: "sfz",
          assetPaths: ["instruments/bass/upright-pack.json"],
          licenseType: "lgpl",
          source: "external library",
          commercialUseAllowed: true,
          redistributionAllowed: false
        },
        {
          packId: "brushes_nc",
          displayName: "Brushes NC",
          instrumentRole: "brush_drums",
          format: "wav_multisample",
          assetPaths: ["instruments/brushes/soft-pack.json"],
          licenseType: "non_commercial",
          source: "external sample pack",
          commercialUseAllowed: false,
          redistributionAllowed: false
        }
      ],
      outputPath: "music/jazz-pack-registry-blocked.json",
      outputLicenseManifestPath: "music/jazz-pack-license-blocked.json"
    }, ctx);
    assert.equal(blockedPackResult.ok, false);
    const blockedPackPayload = blockedPackResult.structuredContent as {
      packRegistryPath: string;
      licenseManifestPath: string;
      readyPackIds: string[];
      reviewRequiredPackIds: string[];
      blockedPackIds: string[];
      packs: Array<{ packId: string; status: string; riskFlags: string[]; computedSha256?: string; renderUse: string }>;
      instrumentMapCandidates: Record<string, { packId?: string; rendererUse: string }>;
      licenseManifest: { commercialUseStatus: string; unsafeAssets: unknown[] };
      warnings: string[];
    };
    assert.equal(blockedPackPayload.packRegistryPath, "music/jazz-pack-registry-blocked.json");
    assert.equal(blockedPackPayload.licenseManifestPath, "music/jazz-pack-license-blocked.json");
    assert.ok(blockedPackPayload.readyPackIds.includes("warm_piano_mit"));
    assert.ok(blockedPackPayload.reviewRequiredPackIds.includes("upright_bass_lgpl"));
    assert.ok(blockedPackPayload.blockedPackIds.includes("brushes_nc"));
    assert.ok(blockedPackPayload.packs.some((pack) => pack.packId === "warm_piano_mit" && pack.computedSha256 === createHash("sha256").update(pianoSfz).digest("hex")));
    assert.ok(blockedPackPayload.packs.some((pack) => pack.packId === "upright_bass_lgpl" && pack.riskFlags.includes("copyleft_license_review_required")));
    assert.ok(blockedPackPayload.packs.some((pack) => pack.packId === "brushes_nc" && pack.riskFlags.includes("non_commercial_license") && pack.renderUse === "do_not_use_until_license_review_passes"));
    assert.equal(blockedPackPayload.instrumentMapCandidates.realistic_piano.packId, "warm_piano_mit");
    assert.equal(blockedPackPayload.instrumentMapCandidates.upright_bass.rendererUse, "use_procedural_fallback_until_safe_pack_ready");
    assert.equal(blockedPackPayload.licenseManifest.commercialUseStatus, "blocked_pending_license_review");
    assert.ok(blockedPackPayload.licenseManifest.unsafeAssets.length > 0);
    assert.ok(blockedPackPayload.warnings.some((warning) => warning.includes("brushes_nc")));

    const safePackResult = await packManager!.handler({
      projectId: project.id,
      intendedUse: "streaming_demo",
      packs: [
        {
          packId: "warm_piano_mit",
          displayName: "Warm Piano MIT",
          instrumentRole: "realistic_piano",
          format: "sfz",
          assetPaths: ["instruments/piano/warm-pack.json"],
          licenseType: "mit",
          source: "project fixture",
          commercialUseAllowed: true,
          redistributionAllowed: true,
          modificationsAllowed: true
        },
        {
          packId: "upright_bass_apache",
          displayName: "Upright Bass Apache",
          instrumentRole: "upright_bass",
          format: "sfz",
          assetPaths: ["instruments/bass/upright-pack.json"],
          licenseType: "apache_2",
          source: "project fixture",
          commercialUseAllowed: true,
          redistributionAllowed: true,
          modificationsAllowed: true
        },
        {
          packId: "brushes_cc0",
          displayName: "Brushes CC0",
          instrumentRole: "brush_drums",
          format: "wav_multisample",
          assetPaths: ["instruments/brushes/soft-pack.json"],
          licenseType: "cc0",
          source: "project fixture",
          commercialUseAllowed: true,
          redistributionAllowed: true,
          modificationsAllowed: true
        }
      ]
    }, ctx);
    assert.equal(safePackResult.ok, true);
    const safePackPayload = safePackResult.structuredContent as {
      readyPackIds: string[];
      reviewRequiredPackIds: string[];
      blockedPackIds: string[];
      instrumentMapCandidates: Record<string, { packId?: string; rendererUse: string }>;
      rendererIntegration: { rule: string; safeProceduralFallbackMap: Record<string, string> };
      licenseManifest: { commercialUseStatus: string; unsafeAssets: unknown[] };
    };
    assert.deepEqual(safePackPayload.readyPackIds.sort(), ["brushes_cc0", "upright_bass_apache", "warm_piano_mit"].sort());
    assert.deepEqual(safePackPayload.reviewRequiredPackIds, []);
    assert.deepEqual(safePackPayload.blockedPackIds, []);
    assert.equal(safePackPayload.instrumentMapCandidates.realistic_piano.packId, "warm_piano_mit");
    assert.equal(safePackPayload.instrumentMapCandidates.upright_bass.packId, "upright_bass_apache");
    assert.equal(safePackPayload.instrumentMapCandidates.brush_drums.packId, "brushes_cc0");
    assert.match(safePackPayload.rendererIntegration.rule, /Only packs with status=ready/);
    assert.equal(safePackPayload.rendererIntegration.safeProceduralFallbackMap.brush_drums, "jazz_brushes");
    assert.equal(safePackPayload.licenseManifest.commercialUseStatus, "allowed");
    assert.equal(safePackPayload.licenseManifest.unsafeAssets.length, 0);
    const safePackRegistry = await readProjectFile(ctx.projectRoot, project.id, "music/jazz-instrument-packs.json");
    assert.match(safePackRegistry, /warm_piano_mit/);

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

    const harmonyResult = await harmony!.handler({
      projectId: project.id,
      styleFamily: "cafe_jazz",
      key: "F major",
      tempoBpm: 82,
      mood: "warm calm elegant",
      sections: ["intro", "A", "B", "A_variation", "outro"],
      complexity: "medium",
      instrumentTarget: ["piano", "upright_bass"],
      voicingType: "warm_cafe",
      originalityPolicy: "do_not_imitate_specific_songs_or_artists",
      bars: 10
    }, ctx);
    assert.equal(harmonyResult.ok, true);
    const harmonyPayload = harmonyResult.structuredContent as {
      chordChart: Array<{ bar: number; section: string; chord: string; harmonicRhythm: string }>;
      sectionHarmony: Array<{ section: string; chords: string[]; role: string }>;
      pianoVoicings: Array<{ bar: number; chord: string; midi: number[]; voicingType: string; velocity: number }>;
      bassGuideTones: Array<{ bar: number; midi: number[]; movement: string }>;
      midiVoicingData: Array<{ track: string; midi: number; startBeat: number; durationBeats: number; velocity: number; chord: string; section: string }>;
      variationNotes: string[];
      originalityNotes: string[];
      warnings: string[];
    };
    assert.equal(harmonyPayload.chordChart.length, 10);
    assert.equal(harmonyPayload.pianoVoicings.length, 10);
    assert.equal(harmonyPayload.bassGuideTones.length, 10);
    assert.ok(harmonyPayload.sectionHarmony.some((section) => section.section === "B" && section.role.includes("contrast")));
    assert.ok(harmonyPayload.chordChart.some((entry) => entry.section === "intro" && entry.chord.includes("Gm")));
    assert.ok(harmonyPayload.pianoVoicings.every((voicing) => voicing.voicingType === "warm_cafe" && voicing.midi.length >= 3));
    assert.ok(harmonyPayload.bassGuideTones.every((guide) => guide.midi.length === 4));
    assert.ok(harmonyPayload.midiVoicingData.length >= 30);
    assert.ok(harmonyPayload.midiVoicingData.every((note) => note.track === "piano" && note.durationBeats > 0));
    assert.ok(harmonyPayload.variationNotes.some((note) => note.includes("tritone substitute")));
    assert.ok(harmonyPayload.originalityNotes.some((note) => note.includes("do_not_imitate_specific_songs_or_artists")));
    assert.deepEqual(harmonyPayload.warnings, []);

    const drumsResult = await drums!.handler({
      projectId: project.id,
      styleFamily: "cafe_jazz",
      groove: "jazz_brushes",
      tempoBpm: 82,
      meter: "4/4",
      bars: 5,
      swing: 0.58,
      energy: "low_medium",
      kit: "jazz_brushes",
      sections: ["intro", "A", "B", "solo", "outro"],
      constraints: { backgroundFriendly: true, noSuddenHits: true, avoidAggressiveCymbals: true, maxHitsPerBar: 8 },
      operations: ["generate_groove", "add_transition_fill", "humanize_timing", "soften_snare", "use_brushes_instead_of_sticks"]
    }, ctx);
    assert.equal(drumsResult.ok, true);
    const drumPayload = drumsResult.structuredContent as {
      drumMidiPath: string;
      hits: Array<{ instrument: string; midi: number; startBeat: number; velocity: number; section: string; role: string }>;
      fills: Array<{ instruction: string; midi: unknown[] }>;
      grooveManifest: { styleFamily: string; tempoBpm: number; meter: string; kit: string; operations: string[]; midiIntegration: { channel: number } };
      sectionVariationMap: Array<{ section: string; role: string; recommendedOperation: string }>;
      velocityProfile: { min: number; max: number; average: number; backgroundCeiling: number };
      swingReport: { amount: number; feel: string; humanizeRecommended: boolean };
      backgroundSafety: { longListeningFriendly: boolean; noSuddenHits: boolean };
      midiNotes: Array<{ track: string; midi: number; startBeat: number; durationBeats: number; velocity: number; instrument: string; section: string }>;
      warnings: string[];
    };
    assert.ok(drumPayload.hits.length >= 20);
    assert.equal(drumPayload.fills.length, 1);
    assert.equal(drumPayload.drumMidiPath, "music/drum-groove.mid");
    assert.equal(drumPayload.grooveManifest.styleFamily, "cafe_jazz");
    assert.equal(drumPayload.grooveManifest.tempoBpm, 82);
    assert.equal(drumPayload.grooveManifest.meter, "4/4");
    assert.equal(drumPayload.grooveManifest.kit, "jazz_brushes");
    assert.equal(drumPayload.grooveManifest.midiIntegration.channel, 10);
    assert.ok(drumPayload.grooveManifest.operations.includes("soften_snare"));
    assert.ok(drumPayload.sectionVariationMap.some((section) => section.section === "intro" && section.role === "sparse setup"));
    assert.ok(drumPayload.sectionVariationMap.some((section) => section.section === "B" && section.role.includes("lifted")));
    assert.ok(drumPayload.velocityProfile.max <= drumPayload.velocityProfile.backgroundCeiling);
    assert.equal(drumPayload.swingReport.amount, 0.58);
    assert.match(drumPayload.swingReport.feel, /deep swing/);
    assert.equal(drumPayload.swingReport.humanizeRecommended, false);
    assert.equal(drumPayload.backgroundSafety.longListeningFriendly, true);
    assert.equal(drumPayload.backgroundSafety.noSuddenHits, true);
    assert.ok(drumPayload.midiNotes.every((note) => note.track === "drums" && note.durationBeats > 0));
    assert.ok(drumPayload.hits.some((hit) => hit.section === "solo" && hit.role === "supportive solo bed"));
    assert.deepEqual(drumPayload.warnings, []);
    const drumMidi = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/drum-groove.mid"));
    assert.equal(drumMidi.subarray(0, 4).toString("ascii"), "MThd");

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
    const originalSession = getToolModule("assemble_original_music_session");
    const normalize = getToolModule("normalize_music_loudness");
    const productionPlan = getToolModule("create_production_music_render_plan");
    const master = getToolModule("apply_music_mix_master_chain");
    const productionReview = getToolModule("review_music_production_export");
    const exportProject = getToolModule("export_music_project");
    for (const [name, tool] of Object.entries({ variations, publishDemo, extend, session, originalSession, normalize, productionPlan, master, productionReview, exportProject })) assert.ok(tool, `${name} registered`);

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
      targetDurationMinutes: 60,
      useCase: "cafe_background",
      energyProfile: "afternoon_cafe",
      transitionStyle: "ambient_bed",
      crossfadeSeconds: 6,
      outputFormats: ["manifest", "segmented_playlist", "wav"],
      targetRms: 0.16,
      publish: true
    }, ctx);
    assert.equal(sessionResult.ok, true);
    const sessionPayload = sessionResult.structuredContent as { schedule: unknown[]; tracklist: unknown[]; transitionMap: unknown[]; energyCurve: unknown[]; compatibilityChecks: unknown[]; loudnessNormalization: { targetRms: number }; loudnessReport: { targetRms: number }; ambientRoomTone: boolean; exportPlan: { sessionAudioPath?: string; segmentedPlaylist: boolean }; sourceManifest: { originalitySafetyRule: string }; publishedUrl: string; sessionPagePath: string; warnings: string[] };
    assert.ok(sessionPayload.schedule.length >= 10);
    assert.equal(sessionPayload.tracklist.length, sessionPayload.schedule.length);
    assert.equal(sessionPayload.transitionMap.length, sessionPayload.schedule.length - 1);
    assert.equal(sessionPayload.energyCurve.length, sessionPayload.schedule.length);
    assert.equal(sessionPayload.compatibilityChecks.length, sessionPayload.schedule.length);
    assert.equal(sessionPayload.loudnessNormalization.targetRms, 0.16);
    assert.equal(sessionPayload.loudnessReport.targetRms, 0.16);
    assert.equal(sessionPayload.ambientRoomTone, true);
    assert.equal(sessionPayload.exportPlan.sessionAudioPath, "requires-render-step");
    assert.equal(sessionPayload.exportPlan.segmentedPlaylist, true);
    assert.match(sessionPayload.sourceManifest.originalitySafetyRule, /original\/generated/);
    assert.match(sessionPayload.publishedUrl, /https:\/\/example\.test/);
    assert.deepEqual(sessionPayload.warnings, []);
    const sessionHtml = await readProjectFile(ctx.projectRoot, project.id, sessionPayload.sessionPagePath);
    assert.match(sessionHtml, /Music Session Assembly/);
    assert.match(sessionHtml, /Transition Map/);

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

    const productionPlanResult = await productionPlan!.handler({
      projectId: project.id,
      compositionManifestPath: variationsPayload.variations[0].manifestPath,
      styleProfile: "cafe_piano_trio",
      targetUse: "streaming_demo",
      instrumentPriorities: ["realistic_piano", "upright_bass", "brush_drums", "room_ambience"],
      licensePolicy: "mit_apache_preferred",
      targetLufs: -16,
      truePeakDb: -1
    }, ctx);
    assert.equal(productionPlanResult.ok, true);
    const productionPlanPayload = productionPlanResult.structuredContent as {
      productionPlanPath: string;
      instrumentEnginePlan: Array<{ id: string; fallback: string }>;
      humanization: { timingMs: number; velocityVariance: number };
      mixMasterChain: Array<{ stage: string }>;
      abMasteringPlan: unknown[];
      licenseGate: { allowed: string[]; reviewRequired: string[] };
      exportReviewChecklist: string[];
    };
    assert.equal(productionPlanPayload.productionPlanPath, "music/production-render-plan.json");
    assert.ok(productionPlanPayload.instrumentEnginePlan.some((item) => item.id === "realistic_piano" && item.fallback === "warm_acoustic_piano procedural preview"));
    assert.ok(productionPlanPayload.humanization.timingMs > 0);
    assert.ok(productionPlanPayload.humanization.velocityVariance > 0);
    assert.ok(productionPlanPayload.mixMasterChain.some((stage) => stage.stage === "limiter"));
    assert.equal(productionPlanPayload.abMasteringPlan.length, 2);
    assert.ok(productionPlanPayload.licenseGate.allowed.includes("mit"));
    assert.ok(productionPlanPayload.licenseGate.allowed.includes("apache_2"));
    assert.ok(productionPlanPayload.licenseGate.reviewRequired.includes("gpl"));
    assert.ok(productionPlanPayload.exportReviewChecklist.some((item) => item.includes("commercial-use")));
    const productionPlanJson = await readProjectFile(ctx.projectRoot, project.id, productionPlanPayload.productionPlanPath);
    assert.match(productionPlanJson, /licenseGate/);

    const masterAResult = await master!.handler({
      projectId: project.id,
      audioPath: variationsPayload.variations[0].audioPath,
      stemPaths: ["music/stems/piano.wav", "music/stems/bass.wav", "music/stems/drums.wav"],
      chain: ["eq_cleanup", "gentle_compression", "limiter", "loudness_normalize"],
      targetRms: 0.16,
      truePeakCeiling: 0.89,
      abLabel: "master_A",
      outputAudioPath: "music/master-A.wav",
      outputReportPath: "music/master-A-report.json"
    }, ctx);
    assert.equal(masterAResult.ok, true);
    const masterAPayload = masterAResult.structuredContent as { abLabel: string; masteredAudioPath: string; masteringReportPath: string; after: { peak: number; rms: number }; productionNotes: string[] };
    assert.equal(masterAPayload.abLabel, "master_A");
    assert.equal(masterAPayload.masteredAudioPath, "music/master-A.wav");
    assert.equal(masterAPayload.masteringReportPath, "music/master-A-report.json");
    assert.ok(masterAPayload.after.peak <= 0.9);
    assert.ok(masterAPayload.after.rms > 0);
    assert.ok(masterAPayload.productionNotes.some((note) => note.includes("EQ")));
    const masterAudio = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/master-A.wav"));
    assert.equal(masterAudio.subarray(0, 4).toString("ascii"), "RIFF");

    const masterBResult = await master!.handler({
      projectId: project.id,
      audioPath: variationsPayload.variations[0].audioPath,
      chain: ["limiter", "loudness_normalize"],
      targetRms: 0.14,
      truePeakCeiling: 0.86,
      abLabel: "master_B",
      outputAudioPath: "music/master-B.wav",
      outputReportPath: "music/master-B-report.json"
    }, ctx);
    assert.equal(masterBResult.ok, true);
    await writeProjectFile(ctx.projectRoot, project.id, "music/production-license-safe.json", `${JSON.stringify({ unsafeAssets: [], warnings: [], commercialUseStatus: "ready_for_business_demo" }, null, 2)}\n`);

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

    const productionReviewResult = await productionReview!.handler({
      projectId: project.id,
      productionPlanPath: productionPlanPayload.productionPlanPath,
      masterReportPaths: ["music/master-A-report.json", "music/master-B-report.json"],
      licenseManifestPath: "music/production-license-safe.json",
      exportManifestPath: "music/production-export-manifest.json"
    }, ctx);
    assert.equal(productionReviewResult.ok, true);
    const productionReviewPayload = productionReviewResult.structuredContent as {
      recommendation: string;
      checks: string[];
      masterComparisons: unknown[];
      licenseStatus: string;
      exportStatus: string;
      reviewPath: string;
    };
    assert.notEqual(productionReviewPayload.recommendation, "blocked");
    assert.ok(productionReviewPayload.checks.includes("production_plan_loaded"));
    assert.ok(productionReviewPayload.checks.includes("master_reports_compared"));
    assert.equal(productionReviewPayload.masterComparisons.length, 2);
    assert.equal(productionReviewPayload.licenseStatus, "reviewed");
    assert.equal(productionReviewPayload.exportStatus, "reviewed");
    assert.equal(productionReviewPayload.reviewPath, "music/production-export-review.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export_music_project creates a music package with README, playlist, checks, and license warnings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-export-package-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Cafe export", createdByClientId: "producer" });
    const compose = getToolModule("compose_music");
    const render = getToolModule("render_midi_to_audio");
    const exportProject = getToolModule("export_music_project");
    assert.ok(compose);
    assert.ok(render);
    assert.ok(exportProject);

    await compose!.handler({
      projectId: project.id,
      title: "Cafe Jazz Pack",
      style: "cafe_jazz",
      tempo: 92,
      key: "F",
      durationSeconds: 30,
      outputManifestPath: "music/project.manifest.json",
      outputMidiPath: "music/final.mid"
    }, ctx);
    await render!.handler({
      projectId: project.id,
      compositionManifestPath: "music/project.manifest.json",
      outputAudioPath: "music/final.wav",
      outputStemDirectory: "music/stems",
      stems: true,
      sampleRate: 12000
    }, ctx);
    await writeProjectFile(ctx.projectRoot, project.id, "music/charts/lead-sheet.md", "# Cafe Jazz Pack\n\nFmaj7 | Gm7 C7 | Fmaj7\n");
    await writeProjectFile(ctx.projectRoot, project.id, "music/license-safety-manifest.json", `${JSON.stringify({ businessDemoSuitable: false, warnings: ["External sample requires attribution."] }, null, 2)}\n`);

    const result = await exportProject!.handler({
      projectId: project.id,
      projectManifestPath: "music/project.manifest.json",
      packageName: "cafe-jazz-background-pack",
      selectedVersionIds: ["version_A"],
      version: "v2",
      bpm: 92,
      key: "F",
      durationSeconds: 3600,
      exports: ["single_track_wav", "single_track_mp3", "session_mp3", "midi", "stems", "chord_chart", "license_manifest", "demo_page", "playlist_metadata", "project_manifest"],
      renderedAudioPaths: ["music/final.wav"],
      midiPaths: ["music/final.mid"],
      stemPaths: ["music/stems/piano.wav", "music/stems/missing-drums.wav"],
      chordChartPaths: ["music/charts/lead-sheet.md"],
      licenseManifestPath: "music/license-safety-manifest.json",
      trackManifestPaths: ["music/project.manifest.json"],
      publish: false
    }, ctx);
    assert.equal(result.ok, false);
    const payload = result.structuredContent as {
      packageName: string;
      readmePath: string;
      playlistPath: string;
      packageReportPath: string;
      exportedFiles: Array<{ path: string; role: string }>;
      missingFiles: string[];
      licenseWarnings: string[];
      unsupportedFormats: string[];
      naming: { baseFileName: string };
    };
    assert.equal(payload.packageName, "cafe-jazz-background-pack");
    assert.ok(payload.exportedFiles.some((file) => file.path === "music/final.wav" && file.role === "audio"));
    assert.ok(payload.exportedFiles.some((file) => file.path === "music/final.mid" && file.role === "midi"));
    assert.ok(payload.exportedFiles.some((file) => file.path === "music/stems/piano.wav" && file.role === "stem"));
    assert.deepEqual(payload.missingFiles, ["music/stems/missing-drums.wav"]);
    assert.ok(payload.licenseWarnings.some((warning) => warning.includes("attribution")));
    assert.ok(payload.licenseWarnings.some((warning) => warning.includes("business demos")));
    assert.ok(payload.unsupportedFormats.some((warning) => warning.includes("MP3")));
    assert.match(payload.naming.baseFileName, /cafe-jazz-background-pack-v2-92bpm-f-3600s/);
    assert.ok(result.artifacts.includes("music/export-package/README.md"));
    assert.ok(result.artifacts.includes("music/export-package/playlist.json"));
    assert.ok(result.artifacts.includes("music/export-package/package-report.json"));

    const readme = await readProjectFile(ctx.projectRoot, project.id, payload.readmePath);
    assert.match(readme, /single track audio/);
    assert.match(readme, /License warnings/);
    const playlist = await readProjectFile(ctx.projectRoot, project.id, payload.playlistPath);
    assert.match(playlist, /music\/final\.wav/);
    const html = await readProjectFile(ctx.projectRoot, project.id, "music-project.html");
    assert.match(html, /Download package/);
    const report = await readProjectFile(ctx.projectRoot, project.id, payload.packageReportPath);
    assert.match(report, /missing-drums/);
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

test("process_music_revision_feedback turns audition comments into revision operations and history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-revision-feedback-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Revision feedback", createdByClientId: "producer" });
    const processFeedback = getToolModule("process_music_revision_feedback");
    assert.ok(processFeedback);

    await writeProjectFile(ctx.projectRoot, project.id, "music/previous-revisions.json", `${JSON.stringify({
      revisionHistory: [{ revisionId: "B-rev1", sourceVersionId: "B", targetVersionId: "B-rev1", reasonForChanges: ["make it softer"] }]
    }, null, 2)}\n`);

    const result = await processFeedback!.handler({
      projectId: project.id,
      selectedVersionId: "B",
      rejectedVersionIds: ["A", "C"],
      targetUseCase: "cafe",
      previousRevisionHistoryPath: "music/previous-revisions.json",
      feedback: [
        { timestamp: "0:32", comment: "drums too busy", rating: 3 },
        { timestamp: "1:10", comment: "transition feels sudden" },
        { comment: "extend this to 6 minutes with warmer piano" }
      ]
    }, ctx);

    assert.equal(result.ok, true);
    const payload = result.structuredContent as {
      targetVersionId: string;
      detectedFeedbackTypes: string[];
      midiEditOperations: Array<{ type: string; track?: string; value?: string | number; timestampSeconds?: number }>;
      arrangementOperations: Array<{ action: string; value?: number; timestampSeconds?: number }>;
      mixOperations: Array<{ action: string; target?: string; value?: string }>;
      qaChecklist: string[];
      nextToolSequence: string[];
      revisionHistory: unknown[];
      outputPath: string;
    };
    assert.equal(payload.targetVersionId, "B-rev2");
    assert.ok(payload.detectedFeedbackTypes.includes("drums"));
    assert.ok(payload.detectedFeedbackTypes.includes("transition"));
    assert.ok(payload.detectedFeedbackTypes.includes("duration"));
    assert.ok(payload.detectedFeedbackTypes.includes("piano"));
    assert.ok(payload.midiEditOperations.some((operation) => operation.type === "adjust_velocity" && operation.track === "drums" && operation.timestampSeconds === 32));
    assert.ok(payload.midiEditOperations.some((operation) => operation.type === "humanize" && operation.track === "piano"));
    assert.ok(payload.arrangementOperations.some((operation) => operation.action === "smooth_transition" && operation.timestampSeconds === 70));
    assert.ok(payload.arrangementOperations.some((operation) => operation.action === "extend_selected_version" && operation.value === 360));
    assert.ok(payload.mixOperations.some((operation) => operation.action === "use warmer piano preset" && operation.target === "piano"));
    assert.ok(payload.qaChecklist.some((item) => item.includes("transition")));
    assert.deepEqual(payload.nextToolSequence, ["edit_midi", "extend_music_arrangement", "render_midi_to_audio", "normalize_music_loudness", "inspect_audio_quality", "export_music_project"]);
    assert.equal(payload.revisionHistory.length, 2);
    const saved = await readProjectFile(ctx.projectRoot, project.id, payload.outputPath);
    assert.match(saved, /B-rev2/);
    assert.match(saved, /drums too busy/);
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
    "assemble_original_music_session",
    "assemble_music_session",
    "normalize_music_loudness",
    "create_production_music_render_plan",
    "apply_music_mix_master_chain",
    "review_music_production_export",
    "export_music_project",
    "process_music_revision_feedback",
    "compose_music",
    "edit_midi",
    "render_midi_to_audio",
    "generate_jazz_harmony",
    "generate_drum_groove",
    "inspect_audio_quality",
    "build_music_license_manifest",
    "manage_jazz_instrument_packs",
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
