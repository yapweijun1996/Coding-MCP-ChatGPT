import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getToolModule } from "../src/mcp/registry.js";
import type { ToolContext } from "../src/mcp/types.js";
import { actionableSilenceGaps, wavAnalysis } from "../src/mcp/tools/music-workflow-utils.js";
import { createProject, writeProjectAsset, writeProjectFile } from "../src/projects/store.js";

const SAMPLE_RATE = 8_000;

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1_000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "music-audio-qa-test"
  };
}

function pcmWav(durationSeconds: number, sampleAt: (timeSeconds: number, frame: number) => number) {
  const frameCount = Math.round(durationSeconds * SAMPLE_RATE);
  const pcm = Buffer.alloc(frameCount * 2);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = Math.max(-1, Math.min(1, sampleAt(frame / SAMPLE_RATE, frame)));
    pcm.writeInt16LE(Math.round(sample * 32767), frame * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function softDynamicPianoSample(timeSeconds: number) {
  const frequencies = [220, 261.63, 329.63, 392, 293.66, 349.23, 440, 246.94];
  const noteIndex = Math.floor(timeSeconds / 1.5);
  const localTime = timeSeconds - noteIndex * 1.5;
  const frequency = frequencies[noteIndex % frequencies.length];
  const phraseDynamic = 0.42 + 0.58 * (0.5 + 0.5 * Math.sin(noteIndex * 0.57));
  const attack = Math.min(1, localTime / 0.018);
  const decay = 0.48 + 0.52 * Math.exp(-localTime * 1.25);
  const amplitude = (0.055 + 0.15 * phraseDynamic) * attack * decay;
  return amplitude * (
    Math.sin(2 * Math.PI * frequency * localTime) * 0.78 +
    Math.sin(2 * Math.PI * frequency * 2 * localTime) * 0.17 +
    Math.sin(2 * Math.PI * frequency * 3 * localTime) * 0.05
  );
}

function softDynamicPianoWav(durationSeconds = 300) {
  return pcmWav(durationSeconds, softDynamicPianoSample);
}

function pianoWithPersistentHissWav(durationSeconds = 30) {
  let state = 0x6d2b79f5;
  return pcmWav(durationSeconds, (timeSeconds) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const hiss = (((state >>> 0) / 0xffffffff) * 2 - 1) * 0.04;
    return softDynamicPianoSample(timeSeconds) + hiss;
  });
}

function toneWithSilenceWav(durationSeconds: number, silentRanges: Array<[number, number]>) {
  return pcmWav(durationSeconds, (timeSeconds) => {
    if (silentRanges.some(([start, end]) => timeSeconds >= start && timeSeconds < end)) return 0;
    return Math.sin(2 * Math.PI * 220 * timeSeconds) * 0.12;
  });
}

function composition(projectId: string, durationSeconds: number, loopable = false) {
  return {
    projectId,
    title: "Deterministic audio QA fixture",
    style: "smooth_piano",
    mood: "soft dynamic solo piano",
    tempo: 72,
    key: "C major",
    durationSeconds,
    useCase: "solo piano production",
    complexity: "medium",
    loopable,
    instruments: ["piano"],
    chordProgression: ["Cmaj7", "Am7", "Fmaj7", "G7"],
    sections: [{ name: "theme", bars: 4, intensity: 0.4 }],
    tracks: {
      piano: [
        { track: "piano", midi: 48, startBeat: 0.11, durationBeats: 1.5, velocity: 42 },
        { track: "piano", midi: 64, startBeat: 1.37, durationBeats: 0.5, velocity: 67 },
        { track: "piano", midi: 55, startBeat: 4.19, durationBeats: 1.75, velocity: 51 },
        { track: "piano", midi: 72, startBeat: 6.43, durationBeats: 0.65, velocity: 78 }
      ]
    },
    compositionPlan: { motifs: [{ id: "theme", notes: [60, 64, 67] }], energyCurve: [0.3, 0.5, 0.4] },
    performance: { humanized: true, timingJitterBeats: 0.02, velocityJitter: 5, sustainPedal: [] },
    license: { output: "generated_original", dependencies: [] }
  };
}

async function inspectProductionAudio(audio: Buffer, durationSeconds: number) {
  const root = await mkdtemp(path.join(tmpdir(), "music-audio-qa-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Audio QA regression", createdByClientId: ctx.clientId });
    await writeProjectFile(ctx.projectRoot, project.id, "music/composition.json", `${JSON.stringify(composition(project.id, durationSeconds), null, 2)}\n`);
    await writeProjectFile(ctx.projectRoot, project.id, "music/render-report.json", `${JSON.stringify({ renderer: "render_midi_with_soundfont", qualityTier: "production_candidate", productionReady: true }, null, 2)}\n`);
    await writeProjectAsset(ctx.projectRoot, project.id, "music/production.wav", audio, "audio/wav");
    const inspect = getToolModule("inspect_audio_quality");
    assert.ok(inspect);
    return await inspect.handler({
      projectId: project.id,
      audioPath: "music/production.wav",
      compositionManifestPath: "music/composition.json",
      useCase: "solo piano production",
      renderReportPath: "music/render-report.json",
      renderTier: "preview",
      checkLoop: false,
      outputPath: "music/audio-qa.json"
    }, ctx);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("audio QA accepts a five-minute soft dynamic piano-like render without calling its decays hiss", async () => {
  const wav = softDynamicPianoWav();
  const analysis = wavAnalysis(wav);
  assert.equal(analysis.readable, true);
  assert.ok(analysis.rms > 0.04 && analysis.rms < 0.12, `unexpected RMS ${analysis.rms}`);
  assert.ok(analysis.noiseLikeFlatnessProxy < 0.85, `unexpected temporal flatness ${analysis.noiseLikeFlatnessProxy}`);
  assert.equal(analysis.noiseFloorEstimate.detected, false);
  assert.equal(analysis.noiseFloorRms, 0);

  const result = await inspectProductionAudio(wav, 300);
  const report = result.structuredContent as {
    productionSafe: boolean;
    blockingReasons: string[];
    noiseFloorReport: { renderTier: string; renderTierSource: string; overThreshold: boolean; gated: boolean };
  };
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(report.productionSafe, true);
  assert.equal(report.noiseFloorReport.renderTier, "production_candidate");
  assert.equal(report.noiseFloorReport.renderTierSource, "render_report");
  assert.equal(report.noiseFloorReport.overThreshold, false);
  assert.equal(report.noiseFloorReport.gated, false);
  assert.ok(!report.blockingReasons.some((reason) => reason.includes("Audible noise floor detected")));
});

test("audio QA still blocks deterministic persistent broadband hiss in the production gate", async () => {
  const wav = pianoWithPersistentHissWav();
  const analysis = wavAnalysis(wav);
  assert.equal(analysis.readable, true);
  assert.equal(analysis.noiseFloorEstimate.detected, true, JSON.stringify(analysis));
  assert.ok(analysis.noiseFloorEstimate.noiseLikeBlockRatio >= 0.60);
  assert.ok(analysis.noiseFloorRms > 0.003);

  const result = await inspectProductionAudio(wav, 30);
  const report = result.structuredContent as {
    productionSafe: boolean;
    blockingReasons: string[];
    noiseFloorReport: { renderTier: string; renderTierSource: string; noiseToSignalRatio: number; threshold: number; overThreshold: boolean; gated: boolean };
  };
  assert.equal(result.ok, false);
  assert.equal(report.productionSafe, false);
  assert.equal(report.noiseFloorReport.renderTier, "production_candidate");
  assert.equal(report.noiseFloorReport.renderTierSource, "render_report");
  assert.equal(report.noiseFloorReport.overThreshold, true);
  assert.equal(report.noiseFloorReport.gated, true);
  assert.ok(report.noiseFloorReport.noiseToSignalRatio > report.noiseFloorReport.threshold);
  assert.ok(report.blockingReasons.some((reason) => reason.includes("Audible noise floor detected")));
});

test("silence-gap classifier preserves raw evidence but suppresses only non-loopable renderer tail padding", () => {
  const tailAnalysis = wavAnalysis(toneWithSilenceWav(6, [[3.25, 6]]));
  assert.equal(tailAnalysis.readable, true);
  assert.ok(tailAnalysis.silenceGaps.length > 0, "raw tail gap must remain in technical analysis");
  assert.deepEqual(actionableSilenceGaps(tailAnalysis.silenceGaps, { declaredDurationSeconds: 3, loopable: false }), []);
  assert.deepEqual(
    actionableSilenceGaps(tailAnalysis.silenceGaps, { declaredDurationSeconds: 3, loopable: true }),
    tailAnalysis.silenceGaps,
    "a loopable trailing gap is an actionable seam defect"
  );

  const interiorAnalysis = wavAnalysis(toneWithSilenceWav(8, [[2, 4.5]]));
  assert.equal(interiorAnalysis.readable, true);
  assert.ok(interiorAnalysis.silenceGaps.some((gap) => gap.startSeconds >= 2 && gap.startSeconds < 4));
  assert.deepEqual(
    actionableSilenceGaps(interiorAnalysis.silenceGaps, { declaredDurationSeconds: 8, loopable: false }),
    interiorAnalysis.silenceGaps,
    "a genuine interior gap must remain actionable"
  );
});
