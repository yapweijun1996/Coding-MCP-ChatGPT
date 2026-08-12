import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildMusicProductionStagePlan,
  executeMusicProduction,
  musicProductionOrchestratorTools,
  normalizeMusicProductionInput,
  type MusicProductionCallTool
} from "../src/mcp/tools/music-production-orchestrator.js";
import type { ToolContext, ToolResult } from "../src/mcp/types.js";
import { getToolModule } from "../src/mcp/registry.js";
import { createProject, readProjectFile, writeProjectFile } from "../src/projects/store.js";

function toolContext(): ToolContext {
  const root = "/tmp/music-production-orchestrator-test";
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: path.join(root, "workspace"),
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "music-production-orchestrator-test"
  };
}

function result(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    ok: true,
    summary: "ok",
    artifacts: [],
    logs: [],
    errors: [],
    ...overrides
  };
}

type FakeHandler = (input: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

function fakeCaller(overrides: Record<string, FakeHandler> = {}, sourceManifest: Record<string, unknown> = { title: "57-note melody" }) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const writtenManifests: Record<string, Record<string, unknown>> = {};
  const defaults: Record<string, FakeHandler> = {
    read_project_file: () => result({ logs: [JSON.stringify(sourceManifest)] }),
    extend_original_music_arrangement: (input) => result({
      summary: "extended",
      artifacts: [String(input.outputManifestPath), String(input.outputMidiPath)],
      structuredContent: {
        arrangementManifestPath: input.outputManifestPath,
        extendedMidiPath: input.outputMidiPath,
        sourceManifestPath: input.sourceManifestPath
      }
    }),
    validate_music_constraints: (input) => result({
      summary: "constraints passed",
      artifacts: [String(input.outputReportPath)],
      structuredContent: { ok: true, reportPath: input.outputReportPath }
    }),
    validate_music_ensemble: (input) => result({
      summary: "ensemble passed",
      structuredContent: {
        ok: true,
        requiredInstruments: input.requiredInstruments,
        overlap: { durationSeconds: 12.5 },
        tracks: input.requiredInstruments
      }
    }),
    validate_music_development: (input) => result({
      summary: "development passed",
      artifacts: [String(input.outputReportPath)],
      structuredContent: { ok: true, developmentScore: 0.82, reportPath: input.outputReportPath }
    }),
    write_project_file: (input) => {
      const relativePath = String(input.relativePath);
      writtenManifests[relativePath] = JSON.parse(String(input.content)) as Record<string, unknown>;
      return result({ summary: "manifest written", artifacts: [relativePath] });
    }
  };
  const callTool: MusicProductionCallTool = async (name, input) => {
    const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
    calls.push({ name, input: record });
    const handler = overrides[name] ?? defaults[name];
    if (!handler) return result({ ok: false, summary: `Unexpected tool: ${name}`, errors: [`Unexpected tool: ${name}`] });
    return handler(record);
  };
  let tick = 0;
  const now = () => `2026-08-10T00:00:${String(tick++).padStart(2, "0")}.000Z`;
  return { callTool, calls, writtenManifests, now };
}

const baseInput = {
  projectId: "project_12345678",
  sourceCompositionManifestPath: "music/source.json",
  targetDurationSec: 300,
  style: "cinematic",
  instrumentPolicy: { mode: "solo" as const, allowed: ["solo piano"] },
  development: { variationLevel: "strong", preserveMelodicIdentity: true },
  outputManifestPath: "music/final-production.json"
};

test("exports create_music_production with deterministic normalization and stage planning", () => {
  assert.equal(musicProductionOrchestratorTools.length, 1);
  assert.equal(musicProductionOrchestratorTools[0]?.definition.name, "create_music_production");

  const normalized = normalizeMusicProductionInput({
    ...baseInput,
    instrumentPolicy: { mode: "solo", allowed: ["grand piano"], allowedInstruments: ["piano"] },
    outputs: ["manifest", "midi"],
    render: { enabled: false }
  });
  assert.equal(normalized.style, "soft_cinematic");
  assert.deepEqual(normalized.instrumentPolicy.allowedInstruments, ["piano"]);
  assert.equal(normalized.development.variationLevel, "high");
  assert.equal(normalized.render.enabled, false);
  assert.ok(normalized.normalizedInputs.interpretations.some((item) => item.field === "style" && item.canonical === "soft_cinematic"));
  assert.ok(normalized.normalizedInputs.interpretations.some((item) => item.field === "instrumentPolicy.allowed" && item.canonical === "piano"));

  const duet = normalizeMusicProductionInput({
    ...baseInput,
    instrumentPolicy: { mode: "ensemble", allowed: ["piano", "cello"] },
    render: { enabled: true, instrumentPackMap: { realistic_piano: "piano_pack", cello: "cello_pack" } }
  });
  assert.deepEqual(duet.render.instrumentPackMap, { realistic_piano: "piano_pack", cello: "cello_pack" });
  assert.equal(duet.render.tool, "render_production_music");
  assert.equal(buildMusicProductionStagePlan(duet).find((stage) => stage.id === "ensemble")?.hardGate, true);
  assert.throws(() => normalizeMusicProductionInput({
    ...baseInput,
    instrumentPolicy: { mode: "ensemble", allowed: ["piano", "cello"] },
    render: { instrumentPackMap: { flute: "unsupported_pack" } }
  }), /Unrecognized key/);
  assert.throws(() => normalizeMusicProductionInput({
    ...baseInput,
    instrumentPolicy: { mode: "ensemble", allowed: ["piano"] }
  }), /at least two allowed instruments/);

  assert.deepEqual(buildMusicProductionStagePlan(normalized).map((stage) => [stage.toolName, stage.enabled]), [
    ["extend_original_music_arrangement", true],
    ["validate_music_constraints", true],
    ["validate_music_ensemble", false],
    ["validate_music_development", true],
    ["render_midi_with_soundfont", false],
    ["inspect_audio_quality", false],
    ["write_project_file", true]
  ]);
});

test("no-audio production succeeds with manifest, MIDI, both QA reports, lineage, and revision-ready state", async () => {
  const fake = fakeCaller();
  const production = await executeMusicProduction({
    ...baseInput,
    outputs: { manifest: true, midi: true, wav: false, mp3: false },
    render: { enabled: false },
    qa: { enabled: true }
  }, toolContext(), fake);

  assert.equal(production.ok, true, production.errors.join("\n"));
  assert.match(production.summary, /No-audio music production completed/);
  assert.deepEqual(fake.calls.map((call) => call.name), [
    "read_project_file",
    "extend_original_music_arrangement",
    "validate_music_constraints",
    "validate_music_development",
    "write_project_file"
  ]);
  assert.ok(production.artifacts.includes("music/production.mid"));
  assert.ok(production.artifacts.includes("music/constraint-qa.json"));
  assert.ok(production.artifacts.includes("music/development-qa.json"));
  assert.ok(production.artifacts.includes("music/final-production.json"));

  const manifest = fake.writtenManifests["music/final-production.json"];
  assert.ok(manifest);
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.compositionReady, true);
  assert.equal(manifest.productionReady, false);
  const lineage = manifest.sourceLineage as Record<string, unknown>;
  assert.equal(lineage.sourceCompositionManifestPath, "music/source.json");
  assert.equal(lineage.preserveMelodicIdentity, true);
  const revision = manifest.revisionReadyState as Record<string, unknown>;
  assert.equal(revision.ready, true);
  assert.equal(revision.midiPath, "music/production.mid");
  const stages = manifest.stages as Array<Record<string, unknown>>;
  assert.equal(stages.find((stage) => stage.id === "render")?.status, "skipped");
  assert.equal(stages.find((stage) => stage.id === "audio_qa")?.status, "skipped");
  assert.ok(stages.every((stage) => typeof stage.startedAt === "string" && typeof stage.completedAt === "string"));
});

test("ensemble production runs a hard ensemble gate and records its report before render", async () => {
  const fake = fakeCaller();
  const production = await executeMusicProduction({
    ...baseInput,
    instrumentPolicy: { mode: "ensemble", allowed: ["piano", "cello"] },
    render: { enabled: false },
    outputs: { manifest: true, midi: true, wav: false, mp3: false },
    outputManifestPath: "music/duet-production.json"
  }, toolContext(), fake);

  assert.equal(production.ok, true, production.errors.join("\n"));
  assert.deepEqual(fake.calls.map((call) => call.name), [
    "read_project_file",
    "extend_original_music_arrangement",
    "validate_music_constraints",
    "validate_music_ensemble",
    "validate_music_development",
    "write_project_file"
  ]);
  const ensembleCall = fake.calls.find((call) => call.name === "validate_music_ensemble");
  assert.deepEqual(ensembleCall?.input.requiredInstruments, ["cello", "piano"]);
  const payload = production.structuredContent as Record<string, unknown>;
  const qa = payload.qaResults as Record<string, unknown>;
  assert.deepEqual(qa.ensemble, {
    ok: true,
    requiredInstruments: ["cello", "piano"],
    overlap: { durationSeconds: 12.5 },
    tracks: ["cello", "piano"]
  });
  const stages = payload.stages as Array<Record<string, unknown>>;
  assert.equal(stages.find((stage) => stage.id === "ensemble")?.status, "passed");
});

test("registered orchestrator runs the real ensemble validator on a piano/cello source before composition QA", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-production-ensemble-integration-"));
  try {
    const ctx: ToolContext = {
      ...toolContext(),
      workspaceRoot: path.join(root, "workspace"),
      shareRoot: path.join(root, "shares"),
      artifactRoot: path.join(root, "artifacts"),
      feedbackRoot: path.join(root, "feedback"),
      projectRoot: path.join(root, "projects")
    };
    const project = await createProject(ctx.projectRoot, { title: "Registered duet production", createdByClientId: "music-production-ensemble-integration" });
    const notes = (track: string, baseMidi: number) => Array.from({ length: 8 }, (_, index) => ({
      track,
      midi: baseMidi + (index % 4),
      startBeat: index,
      durationBeats: 0.75,
      velocity: 72 + (index % 3) * 8
    }));
    await writeProjectFile(ctx.projectRoot, project.id, "music/duet-source.json", `${JSON.stringify({
      title: "Piano cello source",
      style: "soft_cinematic",
      mood: "expressive",
      tempo: 90,
      key: "C major",
      durationSeconds: 16,
      loopable: false,
      instruments: ["piano", "cello"],
      sections: [{ name: "source_theme", bars: 4, intensity: 0.5 }],
      chordProgression: ["C", "Am", "F", "G"],
      tracks: { piano: notes("piano", 60), cello: notes("cello", 48) },
      license: { output: "original", dependencies: [] },
      instrumentPolicy: { mode: "ensemble", allowedInstruments: ["piano", "cello"], prohibitedInstruments: [] }
    }, null, 2)}\n`);

    const orchestrator = getToolModule("create_music_production");
    assert.ok(orchestrator, "create_music_production is registered");
    const result = await orchestrator.handler({
      projectId: project.id,
      sourceCompositionManifestPath: "music/duet-source.json",
      targetDurationSec: 300,
      style: "cinematic",
      instrumentPolicy: { mode: "ensemble", allowed: ["piano", "cello"] },
      render: { enabled: false },
      outputs: ["manifest", "midi"],
      outputManifestPath: "music/duet-production.json"
    }, ctx);

    assert.equal(result.ok, true, result.errors.join("\n"));
    const payload = result.structuredContent as {
      qaResults: { ensemble: { ok: boolean; overlap: { durationSeconds: number } | null; tracks: Array<{ noteCount: number }> } };
      stages: Array<{ id: string; status: string }>;
    };
    assert.equal(payload.qaResults.ensemble.ok, true);
    assert.ok((payload.qaResults.ensemble.overlap?.durationSeconds ?? 0) > 0);
    assert.ok(payload.qaResults.ensemble.tracks.every((track) => track.noteCount > 0));
    assert.equal(payload.stages.find((stage) => stage.id === "ensemble")?.status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensemble hard-gate failure blocks development and render while preserving the failure stage", async () => {
  const fake = fakeCaller({
    validate_music_ensemble: (input) => result({
      ok: false,
      summary: "cello is missing",
      structuredContent: { ok: false, failures: ["Instrument cello has no notes"] },
      artifacts: [String(input.compositionManifestPath)],
      errors: ["Instrument cello has no notes"]
    }),
    validate_music_development: () => {
      throw new Error("development must not run after ensemble failure");
    },
    render_production_music: () => {
      throw new Error("render must not run after ensemble failure");
    }
  });
  const production = await executeMusicProduction({
    ...baseInput,
    instrumentPolicy: { mode: "ensemble", allowed: ["piano", "cello"] },
    render: { enabled: true },
    outputs: ["manifest", "midi", "wav", "mp3"]
  }, toolContext(), fake);

  assert.equal(production.ok, false);
  assert.equal(fake.calls.some((call) => call.name === "validate_music_development"), false);
  assert.equal(fake.calls.some((call) => call.name.startsWith("render_")), false);
  const payload = production.structuredContent as Record<string, unknown>;
  const revision = payload.revisionReadyState as Record<string, unknown>;
  assert.equal(revision.failedStage, "validate_music_ensemble");
  assert.match(String(revision.nextAction), /declared ensemble instrument/i);
  const qa = payload.qaResults as Record<string, unknown>;
  assert.deepEqual(qa.ensemble, { ok: false, failures: ["Instrument cello has no notes"] });
});

test("ensemble orchestration forwards a strict per-role instrumentPackMap to production rendering", async () => {
  const fake = fakeCaller({
    render_production_music: (input) => result({
      summary: "rendered duet",
      artifacts: [String(input.outputProductionWavPath), String(input.outputPreviewMp3Path)],
      structuredContent: {
        productionWavPath: input.outputProductionWavPath,
        previewMp3Path: input.outputPreviewMp3Path,
        soundfont: { attribution: "Fixture duet packs" }
      }
    })
  });
  const production = await executeMusicProduction({
    ...baseInput,
    instrumentPolicy: { mode: "ensemble", allowed: ["piano", "cello"] },
    render: {
      enabled: true,
      instrumentPackMap: { realistic_piano: "piano_pack", cello: "cello_pack" }
    },
    outputs: ["manifest", "midi", "wav", "mp3"],
    qa: { enabled: false }
  }, toolContext(), fake);

  assert.equal(production.ok, true, production.errors.join("\n"));
  const renderCall = fake.calls.find((call) => call.name === "render_production_music");
  assert.deepEqual(renderCall?.input.instrumentPackMap, { realistic_piano: "piano_pack", cello: "cello_pack" });
  const payload = production.structuredContent as Record<string, unknown>;
  const normalized = payload.normalizedInputs as { render: { instrumentPackMap: Record<string, string> } };
  assert.deepEqual(normalized.render.instrumentPackMap, { realistic_piano: "piano_pack", cello: "cello_pack" });
});

test("constraint hard-gate failure preserves prior artifacts and never calls development or render", async () => {
  const fake = fakeCaller({
    validate_music_constraints: (input) => result({
      ok: false,
      summary: "channel 10 prohibited",
      artifacts: [String(input.outputReportPath)],
      structuredContent: { ok: false, failures: ["MIDI channel 10 detected"] },
      errors: ["MIDI channel 10 detected"]
    }),
    validate_music_development: () => {
      throw new Error("development must not run after constraint failure");
    },
    render_production_music: () => {
      throw new Error("render must not run after constraint failure");
    }
  });
  const production = await executeMusicProduction({ ...baseInput, render: { enabled: true }, outputs: ["manifest", "midi", "wav", "mp3"] }, toolContext(), fake);

  assert.equal(production.ok, false);
  assert.equal(fake.calls.some((call) => call.name === "validate_music_development"), false);
  assert.equal(fake.calls.some((call) => call.name.startsWith("render_")), false);
  assert.ok(production.artifacts.includes("music/production.mid"));
  assert.ok(production.artifacts.includes("music/constraint-qa.json"));
  assert.ok(production.artifacts.includes("music/final-production.json"));
  const payload = production.structuredContent as Record<string, unknown>;
  const revision = payload.revisionReadyState as Record<string, unknown>;
  assert.equal(revision.failedStage, "validate_music_constraints");
  assert.match(String(revision.nextAction), /channel 10/i);
});

test("development hard-gate failure stops realistic rendering and keeps development evidence", async () => {
  const fake = fakeCaller({
    validate_music_development: (input) => result({
      ok: false,
      summary: "mechanical repetition detected",
      artifacts: [String(input.outputReportPath)],
      structuredContent: { ok: false, developmentScore: 0.2, repeatedSectionSimilarity: 0.99 },
      errors: ["Repeated-section similarity exceeds threshold"]
    }),
    render_production_music: () => {
      throw new Error("render must not run after development failure");
    }
  });
  const production = await executeMusicProduction({ ...baseInput, render: { enabled: true }, outputs: ["manifest", "midi", "wav", "mp3"] }, toolContext(), fake);

  assert.equal(production.ok, false);
  assert.equal(fake.calls.some((call) => call.name.startsWith("render_")), false);
  assert.ok(production.artifacts.includes("music/development-qa.json"));
  const payload = production.structuredContent as Record<string, unknown>;
  const revision = payload.revisionReadyState as Record<string, unknown>;
  assert.equal(revision.failedStage, "validate_music_development");
  assert.match(String(revision.nextAction), /mechanically repeated/i);
  const stages = payload.stages as Array<Record<string, unknown>>;
  assert.equal(stages.find((stage) => stage.id === "render")?.status, "skipped");
});

test("score request without a reusable source score is explicitly unsupported and never claims MusicXML generation", async () => {
  const fake = fakeCaller();
  const production = await executeMusicProduction({
    ...baseInput,
    outputs: { manifest: true, midi: true, score: true },
    render: { enabled: false }
  }, toolContext(), fake);

  assert.equal(production.ok, true);
  const payload = production.structuredContent as Record<string, unknown>;
  const unsupported = payload.unsupportedOutputs as Array<Record<string, unknown>>;
  assert.ok(unsupported.some((item) => item.output === "score" && /did not generate or claim/.test(String(item.reason))));
  const delivered = payload.deliveredOutputs as Record<string, unknown>;
  assert.deepEqual(delivered.score, { status: "unsupported", generated: false });
  assert.equal(production.artifacts.some((artifact) => /\.musicxml$|\.xml$/i.test(artifact)), false);
});

test("fake rendered production merges listening URL, audio QA, and license attribution without real rendering", async () => {
  const fake = fakeCaller({
    render_production_music: (input) => result({
      summary: "rendered",
      previewUrl: "https://example.test/listen/production",
      shareUrl: "https://example.test/listen/production",
      artifacts: [String(input.outputProductionWavPath), String(input.outputPreviewMp3Path), String(input.outputReportPath), String(input.outputLicensesPath)],
      structuredContent: {
        productionWavPath: input.outputProductionWavPath,
        previewMp3Path: input.outputPreviewMp3Path,
        reportPath: input.outputReportPath,
        licensesPath: input.outputLicensesPath,
        publishedUrl: "https://example.test/listen/production",
        soundfont: { attribution: "Fixture Grand Piano, CC-BY", licenseTextPath: "music/fixture-license.txt" }
      }
    }),
    inspect_audio_quality: (input) => result({
      summary: "audio QA passed",
      artifacts: [String(input.outputPath)],
      structuredContent: { ok: true, truePeakDb: -1.2, integratedLufs: -16 }
    })
  });
  const production = await executeMusicProduction({
    ...baseInput,
    render: { enabled: true, pack: "fixture_grand", stems: true, normalize: true },
    outputs: ["manifest", "midi", "wav", "mp3"],
    publish: true
  }, toolContext(), fake);

  assert.equal(production.ok, true, production.errors.join("\n"));
  assert.equal(production.shareUrl, "https://example.test/listen/production");
  const payload = production.structuredContent as Record<string, unknown>;
  assert.equal(payload.licenseAttributionPath, "music/LICENSES.md");
  assert.equal(payload.attribution, "Fixture Grand Piano, CC-BY");
  const qa = payload.qaResults as Record<string, unknown>;
  assert.deepEqual(qa.audio, { ok: true, truePeakDb: -1.2, integratedLufs: -16 });
  assert.deepEqual(fake.calls.filter((call) => !["read_project_file", "write_project_file"].includes(call.name)).map((call) => call.name), [
    "extend_original_music_arrangement",
    "validate_music_constraints",
    "validate_music_development",
    "render_production_music",
    "inspect_audio_quality"
  ]);
});

test("registered one-call orchestrator completes the 57-note golden fixture through composition QA without audio", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-production-integration-"));
  try {
    const ctx: ToolContext = {
      ...toolContext(),
      workspaceRoot: path.join(root, "workspace"),
      shareRoot: path.join(root, "shares"),
      artifactRoot: path.join(root, "artifacts"),
      feedbackRoot: path.join(root, "feedback"),
      projectRoot: path.join(root, "projects")
    };
    const project = await createProject(ctx.projectRoot, { title: "One-call music production", createdByClientId: "music-production-integration" });
    const golden = JSON.parse(await readFile(path.join(process.cwd(), "tests/fixtures/music/five-minute-solo-piano.json"), "utf8"));
    const source = structuredClone(golden);
    source.title = "Original 57-note production source";
    source.durationSeconds = 57;
    source.sections = [{ name: "source_theme", bars: 15, intensity: 0.45 }];
    source.tracks.piano = source.tracks.piano.map((note: Record<string, number>, index: number) => ({ ...note, startBeat: index, durationBeats: index % 4 === 0 ? 1.25 : 0.75 }));
    delete source.sourceComposition;
    delete source.development;
    await writeProjectFile(ctx.projectRoot, project.id, "music/source-57.json", `${JSON.stringify(source, null, 2)}\n`);

    const orchestrator = getToolModule("create_music_production");
    assert.ok(orchestrator, "create_music_production is registered");
    const result = await orchestrator!.handler({
      projectId: project.id,
      sourceCompositionManifestPath: "music/source-57.json",
      targetDurationSec: 300,
      style: "cinematic",
      instrumentPolicy: { mode: "solo", allowed: ["solo piano"] },
      development: { variationLevel: "high", preserveMelodicIdentity: true },
      render: { enabled: false },
      outputs: ["manifest", "midi"],
      outputManifestPath: "music/golden-production.json"
    }, ctx);

    assert.equal(result.ok, true, result.errors.join("\n"));
    const payload = result.structuredContent as {
      compositionReady: boolean;
      productionReady: boolean;
      deliveredOutputs: { arrangementManifestPath: string; midiPath: string };
      qaResults: { passed: boolean; audioVerified: boolean; development: { development: { score: number } } };
      sourceLineage: { sourceCompositionManifestPath: string; preserveMelodicIdentity: boolean };
    };
    assert.equal(payload.compositionReady, true);
    assert.equal(payload.productionReady, false);
    assert.equal(payload.qaResults.passed, true);
    assert.equal(payload.qaResults.audioVerified, false);
    assert.ok(payload.qaResults.development.development.score >= 0.55);
    assert.equal(payload.deliveredOutputs.midiPath, "music/production.mid");
    assert.equal(payload.sourceLineage.sourceCompositionManifestPath, "music/source-57.json");
    assert.equal(payload.sourceLineage.preserveMelodicIdentity, true);
    const persisted = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "music/golden-production.json"));
    assert.equal(persisted.compositionReady, true);
    assert.equal(persisted.productionReady, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
