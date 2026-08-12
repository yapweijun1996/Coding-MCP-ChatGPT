import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule, loadToolModule } from "../src/mcp/registry.js";
import { pickJazzPackRegistryCandidatePaths, buildEnsembleQa, evaluateMusicConstraints, fluidSynthArgs, midiBuffer, renderProductionMusicHtml } from "../src/mcp/tools/music-workflow.js";
import { createProject, getProjectStoredFilePath, getProjectFilesDirectory, validateProject, readProjectFile, writeProjectAsset, writeProjectFile } from "../src/projects/store.js";
import { mkdir as mkdirNode, truncate as truncateNode } from "node:fs/promises";
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

function fakeSoundfontBytes() {
  return Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0x04, 0x00, 0x00, 0x00]), Buffer.from("sfbk", "ascii"), Buffer.from("pdta", "ascii")]);
}

test("golden eval: five-minute 57-note solo piano passes hard constraints and rejects drums/channel 10", async () => {
  const fixturePath = path.join(process.cwd(), "tests/fixtures/music/five-minute-solo-piano.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(fixture.tracks.piano.length, 57);
  const requiredSections = ["intro", "theme", "development", "bridge", "reprise", "outro"];
  const passing = evaluateMusicConstraints(fixture, { targetDurationSec: 300, durationToleranceSec: 5, requiredSections });
  assert.equal(passing.ok, true, passing.failures.join("\n"));
  assert.deepEqual(passing.observed.instruments, ["piano"]);
  assert.deepEqual(passing.observed.channels, [0]);
  assert.equal(passing.observed.percussionChannelPresent, false);

  const withDrums = structuredClone(fixture);
  withDrums.instruments.push("drums");
  withDrums.tracks.drums = [{ track: "drums", midi: 36, startBeat: 0, durationBeats: 1, velocity: 80 }];
  const drumsRejected = evaluateMusicConstraints(withDrums);
  assert.equal(drumsRejected.ok, false);
  assert.ok(drumsRejected.failures.some((failure) => failure.includes("drums") && failure.includes("not allowed")));
  assert.equal(drumsRejected.observed.percussionChannelPresent, true);

  const channelTenRejected = evaluateMusicConstraints(fixture, { channelMap: { piano: 9 } });
  assert.equal(channelTenRejected.ok, false);
  assert.ok(channelTenRejected.failures.some((failure) => failure.includes("channel 10")));

  const withHiddenTrack = structuredClone(fixture);
  withHiddenTrack.tracks.secret_layer = [];
  const hiddenTrackRejected = evaluateMusicConstraints(withHiddenTrack);
  assert.equal(hiddenTrackRejected.ok, false);
  assert.ok(hiddenTrackRejected.failures.some((failure) => failure.includes("Unknown instrument/track")));
  assert.ok(hiddenTrackRejected.failures.some((failure) => failure.includes("Empty or hidden track")));

  const durationRejected = evaluateMusicConstraints(fixture, { targetDurationSec: 240, durationToleranceSec: 5 });
  assert.equal(durationRejected.ok, false);
  assert.ok(durationRejected.failures.some((failure) => failure.includes("outside target")));
});

test("golden eval: 57-note source becomes a developed five-minute solo piano while mechanical cloning fails QA", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-development-golden-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Five-minute solo piano golden eval", createdByClientId: "music-golden-eval" });
    const golden = JSON.parse(await readFile(path.join(process.cwd(), "tests/fixtures/music/five-minute-solo-piano.json"), "utf8"));
    const source = structuredClone(golden);
    source.title = "Original 57-note piano melody";
    source.durationSeconds = 57;
    source.sections = [{ name: "source_theme", bars: 15, intensity: 0.45 }];
    source.tracks.piano = source.tracks.piano.map((note: Record<string, number>, index: number) => ({
      ...note,
      startBeat: index,
      durationBeats: index % 4 === 0 ? 1.25 : 0.75
    }));
    delete source.sourceComposition;
    delete source.development;
    await writeProjectFile(ctx.projectRoot, project.id, "music/original-57-note-melody.json", `${JSON.stringify(source, null, 2)}\n`);

    const extend = getToolModule("extend_original_music_arrangement");
    const constraints = getToolModule("validate_music_constraints");
    const development = getToolModule("validate_music_development");
    assert.ok(extend);
    assert.ok(constraints);
    assert.ok(development);

    const sections = ["intro", "theme", "development", "bridge", "variation", "reprise", "outro"];
    const extended = await extend!.handler({
      projectId: project.id,
      sourceManifestPath: "music/original-57-note-melody.json",
      targetDurationSec: 300,
      styleFamily: "cinematic",
      backgroundUse: "video",
      variationLevel: "high",
      sections,
      instrumentPolicy: "solo piano",
      renderAudio: false,
      outputManifestPath: "music/developed-five-minute-piano.json",
      outputMidiPath: "music/developed-five-minute-piano.mid"
    }, ctx);
    assert.equal(extended.ok, true, extended.errors.join("\n"));
    const normalized = (extended.structuredContent as { normalizationWarnings: string[] }).normalizationWarnings;
    assert.ok(normalized.some((warning) => warning.includes("styleFamily")));
    assert.ok(normalized.some((warning) => warning.includes("instrumentPolicy")));

    const hardGate = await constraints!.handler({
      projectId: project.id,
      compositionManifestPath: "music/developed-five-minute-piano.json",
      instrumentPolicy: { mode: "solo", allowed: ["piano"] },
      targetDurationSec: 300,
      durationToleranceSec: 1,
      requiredSections: sections,
      outputReportPath: "music/developed-constraints.json"
    }, ctx);
    assert.equal(hardGate.ok, true, hardGate.errors.join("\n"));
    const hardGatePayload = hardGate.structuredContent as { observed: { instruments: string[]; channels: number[]; percussionChannelPresent: boolean } };
    assert.deepEqual(hardGatePayload.observed.instruments, ["piano"]);
    assert.deepEqual(hardGatePayload.observed.channels, [0]);
    assert.equal(hardGatePayload.observed.percussionChannelPresent, false);

    const developedQa = await development!.handler({
      projectId: project.id,
      sourceCompositionManifestPath: "music/original-57-note-melody.json",
      compositionManifestPath: "music/developed-five-minute-piano.json",
      targetDurationSec: 300,
      requiredSections: sections,
      preserveMelodicIdentity: true,
      variationLevel: "high",
      outputReportPath: "music/developed-qa.json"
    }, ctx);
    assert.equal(developedQa.ok, true, developedQa.errors.join("\n"));
    const developedPayload = developedQa.structuredContent as {
      lineage: { recorded: boolean };
      melodyIdentity: { score: number; themeMatches: number };
      development: { score: number; transformationEvidence: string[] };
      repetition: { exactRepeatRatio: number; mechanicalLoopDetected: boolean };
    };
    assert.equal(developedPayload.lineage.recorded, true);
    assert.ok(developedPayload.melodyIdentity.score >= 0.6);
    assert.ok(developedPayload.melodyIdentity.themeMatches >= 2);
    assert.ok(developedPayload.development.score >= 0.55);
    assert.ok(developedPayload.development.transformationEvidence.length >= 3);
    assert.ok(developedPayload.repetition.exactRepeatRatio <= 0.35);
    assert.equal(developedPayload.repetition.mechanicalLoopDetected, false);

    const sourceBeats = source.durationSeconds / 60 * source.tempo;
    const mechanical = structuredClone(source);
    mechanical.title = "Mechanical five-minute clone";
    mechanical.durationSeconds = 300;
    mechanical.sections = sections.map((name) => ({ name, bars: 11, intensity: 0.45 }));
    mechanical.sourceComposition = { manifest: "music/original-57-note-melody.json", sourceType: "user_melody" };
    mechanical.development = { preserveMelodicIdentity: true, variationLevel: "high" };
    mechanical.tracks.piano = Array.from({ length: Math.ceil(300 / source.durationSeconds) }, (_, repeat) =>
      source.tracks.piano.map((note: Record<string, number>) => ({ ...note, startBeat: note.startBeat + repeat * sourceBeats }))
    ).flat().filter((note: Record<string, number>) => note.startBeat < 300);
    await writeProjectFile(ctx.projectRoot, project.id, "music/mechanical-five-minute-clone.json", `${JSON.stringify(mechanical, null, 2)}\n`);
    const mechanicalQa = await development!.handler({
      projectId: project.id,
      sourceCompositionManifestPath: "music/original-57-note-melody.json",
      compositionManifestPath: "music/mechanical-five-minute-clone.json",
      targetDurationSec: 300,
      requiredSections: sections,
      outputReportPath: "music/mechanical-qa.json"
    }, ctx);
    assert.equal(mechanicalQa.ok, false);
    assert.ok(mechanicalQa.errors.some((error) => error.includes("Development score") || error.includes("Exact source-window repeat ratio")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("music schemas normalize human-friendly style, instrument, and export aliases with disclosures", async () => {
  const [exportTool, renderPlanTool, constraintTool] = await Promise.all([
    loadToolModule("export_music_project"),
    loadToolModule("create_production_music_render_plan"),
    loadToolModule("validate_music_constraints")
  ]);
  assert.ok(exportTool?.schema);
  assert.ok(renderPlanTool?.schema);
  assert.ok(constraintTool?.schema);

  const exportInput = exportTool!.schema!.safeParse({
    projectId: "project_12345678",
    exports: ["audio", "score", "website demo"],
    publish: false
  });
  assert.equal(exportInput.success, true);
  if (exportInput.success) {
    const parsed = exportInput.data as { exports: string[]; normalizationWarnings: string[] };
    assert.deepEqual(parsed.exports, ["single_track_wav", "chord_chart", "demo_page"]);
    assert.ok(parsed.normalizationWarnings.some((warning) => warning.includes("exports")));
  }

  const renderPlanInput = renderPlanTool!.schema!.safeParse({ projectId: "project_12345678", styleProfile: "cinematic" });
  assert.equal(renderPlanInput.success, true);
  if (renderPlanInput.success) {
    const parsed = renderPlanInput.data as { styleProfile: string; normalizationWarnings: string[] };
    assert.equal(parsed.styleProfile, "cinematic_soft");
    assert.ok(parsed.normalizationWarnings.some((warning) => warning.includes("styleProfile")));
  }

  const constraintInput = constraintTool!.schema!.safeParse({
    projectId: "project_12345678",
    compositionManifestPath: "music/piano.json",
    instrumentPolicy: "solo piano"
  });
  assert.equal(constraintInput.success, true);
  if (constraintInput.success) {
    const parsed = constraintInput.data as { instrumentPolicy: { mode: string; allowedInstruments: string[] }; normalizationWarnings: string[] };
    assert.equal(parsed.instrumentPolicy.mode, "solo");
    assert.deepEqual(parsed.instrumentPolicy.allowedInstruments, ["piano"]);
    assert.ok(parsed.normalizationWarnings.some((warning) => warning.includes("instrumentPolicy")));
  }
});

test("render_midi_with_soundfont fails before pack lookup when a solo policy is violated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-hard-policy-render-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Hard policy render gate", createdByClientId: "music-workflow-test" });
    const fixture = JSON.parse(await readFile(path.join(process.cwd(), "tests/fixtures/music/five-minute-solo-piano.json"), "utf8"));
    fixture.instruments.push("drums");
    fixture.tracks.drums = [{ track: "drums", midi: 36, startBeat: 0, durationBeats: 1, velocity: 80 }];
    await writeProjectFile(ctx.projectRoot, project.id, "music/invalid-solo.json", `${JSON.stringify(fixture, null, 2)}\n`);
    const validator = getToolModule("validate_music_constraints");
    assert.ok(validator);
    const validation = await validator!.handler({
      projectId: project.id,
      compositionManifestPath: "music/invalid-solo.json",
      targetDurationSec: 300,
      outputReportPath: "music/hard-policy-validation-report.json"
    }, ctx);
    assert.equal(validation.ok, false);
    assert.ok(validation.artifacts.includes("music/hard-policy-validation-report.json"));
    const renderer = getToolModule("render_midi_with_soundfont");
    assert.ok(renderer);
    const result = await renderer!.handler({
      projectId: project.id,
      compositionManifestPath: "music/invalid-solo.json",
      soundfontPackId: "not-installed",
      outputReportPath: "music/hard-policy-render-report.json"
    }, ctx);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("drums") && error.includes("not allowed")));
    assert.equal((result.structuredContent as Record<string, unknown>).renderStarted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function installMockFetch(files: Record<string, Buffer | string>, missing: string[] = []) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const textUrl = String(url);
    const name = path.basename(new URL(textUrl).pathname);
    if (missing.includes(name) || files[name] === undefined) return new Response("missing", { status: 404 });
    const body = files[name];
    return new Response(body instanceof Buffer ? body : Buffer.from(body, "utf8"), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = oldFetch;
  };
}

const simplePianoMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Simple Piano Score</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>1</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>96</per-minute></metronome></direction-type><sound tempo="96"/></direction>
      <harmony><root><root-step>G</root-step></root><kind text="maj7">major-seventh</kind></harmony>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      <note><rest/><duration>2</duration><type>quarter</type></note>
      <note dynamics="88"><pitch><step>G</step><alter>1</alter><octave>4</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>8</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

// compose_music was removed in "Remove generic music composition tool"; compose_edit_midi is its
// successor and delegates to the same buildComposition, so the manifest it writes is a superset.
// The parameter names differ, so map them in one place instead of at every call site.
const COMPOSE_TRACK_ALIASES: Record<string, string> = { brushes: "brush_drums", sax_like_lead: "lead", mallets: "pads" };

type ComposeCueInput = {
  projectId: string;
  title?: string;
  style?: string;
  mood?: string;
  tempo?: number;
  key?: string;
  durationSeconds?: number;
  useCase?: string;
  instruments?: string[];
  complexity?: string;
  loopable?: boolean;
  sections?: string[];
  ensembleRequirement?: Record<string, unknown>;
  outputManifestPath?: string;
  outputMidiPath?: string;
};

/**
 * Compose a test cue through compose_edit_midi using the old compose_music argument shape.
 * Returns the tool result plus the composition manifest it wrote, because compose_edit_midi
 * deliberately summarises its structuredContent instead of echoing every note back.
 */
async function composeTestCue(ctx: ToolContext, input: ComposeCueInput) {
  const compose = getToolModule("compose_edit_midi");
  assert.ok(compose, "compose_edit_midi must be registered");
  const manifestPath = input.outputManifestPath ?? "music/composition-manifest.json";
  const result = await compose.handler({
    projectId: input.projectId,
    ...(input.style ? { style: input.style } : {}),
    ...(input.mood ? { mood: input.mood } : {}),
    ...(input.tempo ? { tempoBpm: input.tempo } : {}),
    ...(input.key ? { key: input.key } : {}),
    // compose_edit_midi's floor is 10s; compose_music allowed 5s.
    ...(input.durationSeconds ? { durationSec: Math.max(10, input.durationSeconds) } : {}),
    ...(input.instruments ? { tracks: input.instruments.map((name) => COMPOSE_TRACK_ALIASES[name] ?? name) } : {}),
    ...(input.sections ? { sections: input.sections } : {}),
    constraints: { loopable: input.loopable ?? true },
    ...(input.ensembleRequirement ? { ensembleRequirement: input.ensembleRequirement } : {}),
    outputManifestPath: manifestPath,
    outputMidiPath: input.outputMidiPath ?? "music/composition.mid"
  }, ctx);
  const composition = result.ok
    ? JSON.parse(await readProjectFile(ctx.projectRoot, input.projectId, manifestPath)) as Record<string, never>
    : undefined;
  return { result, composition };
}

async function importTestMusicXml(
  ctx: ToolContext,
  projectId: string,
  musicXmlString: string,
  outputManifestPath: string,
  outputMidiPath: string,
  title = "Imported Test Score"
) {
  const importer = getToolModule("import_musicxml_score");
  assert.ok(importer, "import_musicxml_score must be registered");
  const result = await importer.handler({
    projectId,
    musicXmlString,
    title,
    outputManifestPath,
    outputMidiPath
  }, ctx);
  assert.equal(result.ok, true, `MusicXML import should succeed: ${JSON.stringify(result.errors)}`);
  return result;
}

// Cello + piano duet. P2 carries part-name "Cello" and GM program 43; identity must survive
// import as a `cello` track (not `piano_2`). Both parts play from bar 1 (true simultaneity).
const celloPianoDuetMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Cello and Piano Duet</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name><midi-instrument id="P1-I1"><midi-program>1</midi-program></midi-instrument></score-part>
    <score-part id="P2"><part-name>Cello</part-name><midi-instrument id="P2-I1"><midi-program>43</midi-program></midi-instrument></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <direction><sound tempo="80"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

// Sequential "fake duet": cello plays bars 1-2, piano rests then plays bars 3-4. They never
// overlap — the exact misleading output the ensemble validator must reject.
const sequentialDuetMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name><midi-instrument id="P1-I1"><midi-program>1</midi-program></midi-instrument></score-part>
    <score-part id="P2"><part-name>Cello</part-name><midi-instrument id="P2-I1"><midi-program>43</midi-program></midi-instrument></score-part>
  </part-list>
  <part id="P1">
    <measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="80"/></direction><note><rest/><duration>4</duration><type>whole</type></note></measure>
    <measure number="2"><note><rest/><duration>4</duration><type>whole</type></note></measure>
    <measure number="3"><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure>
    <measure number="4"><note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure>
  </part>
  <part id="P2">
    <measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>whole</type></note></measure>
    <measure number="2"><note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration><type>whole</type></note></measure>
    <measure number="3"><note><rest/><duration>4</duration><type>whole</type></note></measure>
    <measure number="4"><note><rest/><duration>4</duration><type>whole</type></note></measure>
  </part>
</score-partwise>`;

// Electric Piano + Acoustic Bass: their canonical track keys contain underscores. Regression guard
// for the resolver bug where "\b"/"\s*" patterns failed to match underscored keys (and where the
// generic piano/upright_bass entries shadowed the specific electric_piano/acoustic_bass entries),
// which silently dropped the Program Change and channel for these instruments.
const electricPianoBassMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Electric Piano</part-name><midi-instrument id="P1-I1"><midi-program>5</midi-program></midi-instrument></score-part>
    <score-part id="P2"><part-name>Acoustic Bass</part-name><midi-instrument id="P2-I1"><midi-program>33</midi-program></midi-instrument></score-part>
  </part-list>
  <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><direction><sound tempo="90"/></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>
  <part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>2</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>
</score-partwise>`;

// Two cello parts: the second must keep its cello identity as `cello_2`, not collide or fall back.
const twoCellosMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Cello I</part-name><midi-instrument id="P1-I1"><midi-program>43</midi-program></midi-instrument></score-part>
    <score-part id="P2"><part-name>Cello II</part-name><midi-instrument id="P2-I1"><midi-program>43</midi-program></midi-instrument></score-part>
  </part-list>
  <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><direction><sound tempo="80"/></direction><note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>
  <part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>
</score-partwise>`;

// One part, two voices sharing a measure: voice 1 plays a melody note at beat 0, voice 2 plays a
// harmony note that must ALSO start at beat 0 (not trail after voice 1 finishes). Before the
// <voice>-grouping fix, both notes shared one global beat cursor, so voice 2's note landed at
// beat 1 instead of beat 0 — the exact "second voice plays out of sync" bug this guards against.
const twoVoiceSingleMeasureMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <direction><sound tempo="90"/></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type><voice>1</voice></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type><voice>1</voice></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type><voice>1</voice></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type><voice>1</voice></note>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>whole</type><voice>2</voice></note>
    </measure>
  </part>
</score-partwise>`;

const noTempoMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>
    </measure>
  </part>
</score-partwise>`;

async function installFakeFluidSynth(root: string) {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const scriptPath = path.join(bin, "fluidsynth");
  const script = `#!/usr/bin/env node
const fs = require("fs");
if (process.argv.includes("--version")) {
  console.log("FluidSynth fake 2.3.0");
  process.exit(0);
}
// Mimic FluidSynth 2.x: options after the first positional (SoundFont) file are illegal. This makes
// the e2e suite fail closed if fluidSynthRender ever regresses to trailing -F/-r (issue: no WAV written).
const fakeArgs = process.argv.slice(2);
const sfIndex = fakeArgs.findIndex((a) => a.endsWith(".sf2") || a.endsWith(".sf3"));
for (const opt of ["-F", "-r"]) {
  const oi = fakeArgs.indexOf(opt);
  if (oi !== -1 && sfIndex !== -1 && oi > sfIndex) {
    console.error("error: '" + opt + "' is an illegal option at this place, only -b option is allowed here.");
    process.exit(1);
  }
}
const out = process.argv[process.argv.indexOf("-F") + 1];
const midi = process.argv.find((arg) => arg.endsWith(".mid"));
if (process.env.FAKE_FLUIDSYNTH_INVALID_RIFF) {
  fs.writeFileSync(out, Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0x04, 0x00, 0x00, 0x00]), Buffer.from("sfbk", "ascii")]));
  process.exit(0);
}
if (process.env.EXPECT_MIDI_STATUS_HEX && midi) {
  const status = Number.parseInt(process.env.EXPECT_MIDI_STATUS_HEX, 16);
  const bytes = fs.readFileSync(midi);
  if (!bytes.includes(status)) {
    console.error("Expected MIDI status byte 0x" + process.env.EXPECT_MIDI_STATUS_HEX + " in " + midi);
    process.exit(9);
  }
}
const sampleRate = 8000;
const frames = sampleRate / 4;
const pcm = Buffer.alloc(frames * 2);
// FAKE_FLUIDSYNTH_SILENT forces a silent (all-zero) render so tests can exercise the silent-stem
// fail-closed path deterministically. Otherwise emit an audible sine.
if (!process.env.FAKE_FLUIDSYNTH_SILENT) {
  for (let i = 0; i < frames; i++) {
    const value = Math.round(Math.sin(i / 12) * 8000);
    pcm.writeInt16LE(value, i * 2);
  }
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
fs.writeFileSync(out, Buffer.concat([header, pcm]));
`;
  await writeFile(scriptPath, script);
  await chmod(scriptPath, 0o755);
  return bin;
}

async function installFakeSfizz(root: string) {
  const bin = path.join(root, "bin-sfizz");
  await mkdir(bin, { recursive: true });
  const scriptPath = path.join(bin, "sfizz_render");
  const script = `#!/usr/bin/env node
const fs = require("fs");
if (process.argv.includes("--version")) {
  console.log("sfizz_render fake 1.2.0");
  process.exit(0);
}
const outFlagIndex = Math.max(process.argv.indexOf("--wav"), process.argv.indexOf("-o"));
const out = outFlagIndex >= 0 ? process.argv[outFlagIndex + 1] : process.argv.find((arg) => arg.endsWith(".wav"));
const sfzFlagIndex = Math.max(process.argv.indexOf("--sfz"), process.argv.indexOf("-s"));
const sfz = sfzFlagIndex >= 0 ? process.argv[sfzFlagIndex + 1] : process.argv.find((arg) => arg.endsWith(".sfz"));
if (!out || !sfz) {
  console.error("missing output or sfz argument");
  process.exit(2);
}
const sfzText = fs.readFileSync(sfz, "utf8");
if (!sfzText.includes("<region>")) {
  console.error("invalid sfz fixture");
  process.exit(3);
}
const sampleRate = 8000;
const frames = Math.floor(sampleRate / 3);
const pcm = Buffer.alloc(frames * 2);
for (let i = 0; i < frames; i++) {
  const value = Math.round((Math.sin(i / 8) * 0.7 + Math.sin(i / 23) * 0.2) * 7000);
  pcm.writeInt16LE(value, i * 2);
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
fs.writeFileSync(out, Buffer.concat([header, pcm]));
`;
  await writeFile(scriptPath, script);
  await chmod(scriptPath, 0o755);
  return bin;
}

async function installFakeFfmpeg(root: string) {
  const bin = path.join(root, "bin-ffmpeg");
  await mkdir(bin, { recursive: true });
  const scriptPath = path.join(bin, "ffmpeg");
  const script = `#!/usr/bin/env node
const fs = require("fs");
if (process.argv.includes("-version")) {
  console.log("ffmpeg fake 6.1");
  process.exit(0);
}
// Two-pass loudnorm pass 1: emit fake measured stats to stderr so the caller can build the
// linear=true pass 2 filter. No output file is written (null muxer, last arg is "-").
if (process.argv.some(a => a.includes("print_format=json"))) {
  process.stderr.write(JSON.stringify({
    input_i: "-23.17", input_tp: "-12.41", input_lra: "7.40",
    input_thresh: "-33.86", target_offset: "7.17"
  }) + "\\n");
  process.exit(0);
}
const out = process.argv[process.argv.length - 1];
if (!out) {
  console.error("missing output");
  process.exit(2);
}
// WAV outputs (e.g. the loudnorm finalize pass) need a real PCM WAV so assertPcmWav passes; only the
// MP3 encode wants ID3. Emit the right container by output extension.
if (out.toLowerCase().endsWith(".wav")) {
  if (process.env.FAKE_FFMPEG_LARGE_WAV) {
    const size = Number(process.env.FAKE_FFMPEG_LARGE_WAV);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(size - 8, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(44100, 24); header.writeUInt32LE(44100 * 2, 28); header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(size - 44, 40);
    fs.writeFileSync(out, Buffer.concat([header, Buffer.alloc(size - 44, 1)]));
    process.exit(0);
  }
  const frames = 2000;
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 12) * 9000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(44100, 24); header.writeUInt32LE(44100 * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(out, Buffer.concat([header, pcm]));
} else {
  fs.writeFileSync(out, Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.alloc(256, 1)]));
}
`;
  await writeFile(scriptPath, script);
  await chmod(scriptPath, 0o755);
  return bin;
}

test("music workflow imports MusicXML score into manifest and MIDI", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "musicxml-import-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "MusicXML import", createdByClientId: "composer" });
    const importer = getToolModule("import_musicxml_score");
    assert.ok(importer);

    const result = await importer!.handler({
      projectId: project.id,
      musicXmlString: simplePianoMusicXml,
      outputManifestPath: "music/imported-score.json",
      outputMidiPath: "music/imported-score.mid"
    }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.artifacts.sort(), ["music/imported-score.json", "music/imported-score.mid"].sort());
    const payload = result.structuredContent as {
      title: string;
      tempo: number;
      key: string;
      tracks: Record<string, Array<{ midi: number; startBeat: number; durationBeats: number; velocity: number }>>;
      chordProgression: string[];
      scoreSource: { format: string; noteCount: number; scoreDriven: boolean };
      warnings: string[];
      recommendedNextTools: string[];
      recommendedPianoPack: { licenseType: string; commercialUseAllowed: boolean };
    };
    assert.equal(payload.title, "Simple Piano Score");
    assert.equal(payload.tempo, 96);
    assert.equal(payload.key, "G major");
    assert.equal(payload.scoreSource.format, "MusicXML");
    assert.equal(payload.scoreSource.scoreDriven, true);
    assert.equal(payload.scoreSource.noteCount, 4);
    assert.ok(payload.chordProgression.some((chord) => chord.includes("major-seventh")));
    assert.equal(payload.tracks.piano.length, 4);
    assert.equal(payload.tracks.piano[0].startBeat, 0);
    assert.equal(payload.tracks.piano[1].startBeat, 0, "MusicXML chord notes share the previous note start");
    assert.equal(payload.tracks.piano[2].startBeat, 2, "Rest advances score time");
    assert.equal(payload.tracks.piano[2].midi, 68, "Altered G#4 imports as MIDI 68");
    assert.equal(payload.tracks.piano[2].velocity, 88);
    assert.ok(payload.recommendedNextTools.includes("render_midi_with_soundfont"));
    assert.equal(payload.recommendedPianoPack.licenseType, "cc_by");
    assert.equal(payload.recommendedPianoPack.commercialUseAllowed, true);
    const midi = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/imported-score.mid"));
    assert.equal(midi.subarray(0, 4).toString("ascii"), "MThd");
    assert.ok([...midi].some((byte) => byte >= 0x90 && byte <= 0x9f));

    const noTempoResult = await importer!.handler({
      projectId: project.id,
      musicXmlString: noTempoMusicXml,
      defaultTempo: 84,
      outputManifestPath: "music/no-tempo.json",
      outputMidiPath: "music/no-tempo.mid"
    }, ctx);
    assert.equal(noTempoResult.ok, true);
    const noTempoPayload = noTempoResult.structuredContent as { tempo: number; warnings: string[] };
    assert.equal(noTempoPayload.tempo, 84);
    assert.ok(noTempoPayload.warnings.some((warning) => warning.includes("No explicit tempo")));

    await assert.rejects(
      () => importer!.handler({ projectId: project.id, musicXmlString: "<score-partwise><part>" }, ctx),
      /Invalid MusicXML/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("import_musicxml_score preserves cello identity instead of renaming it to piano_2", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-cello-identity-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Cello identity", createdByClientId: "composer" });
    const importer = getToolModule("import_musicxml_score");
    assert.ok(importer);

    const result = await importer!.handler({
      projectId: project.id,
      musicXmlString: celloPianoDuetMusicXml,
      outputManifestPath: "music/duet.json",
      outputMidiPath: "music/duet.mid"
    }, ctx);
    assert.equal(result.ok, true);
    const payload = result.structuredContent as {
      tracks: Record<string, Array<{ midi: number }>>;
      instruments: string[];
      scoreSource: { partCount: number; trackInstruments: Record<string, string> };
    };

    // Identity preserved: a `cello` track exists with notes; nothing was renamed to piano_2.
    assert.ok(payload.tracks.cello, "cello part must keep its identity as a cello track");
    assert.ok(payload.tracks.cello.length > 0, "cello track must carry its notes (no empty track)");
    assert.ok(payload.tracks.piano && payload.tracks.piano.length > 0, "piano track must carry its notes");
    assert.ok(!Object.keys(payload.tracks).some((track) => /^piano_\d/.test(track)), "no piano_N fallback track should be created");
    assert.equal(payload.scoreSource.trackInstruments.cello, "cello");
    assert.equal(payload.scoreSource.trackInstruments.piano, "piano");

    // Deterministic channel/program mapping: piano = channel 0 / GM program 1 (PC byte 0xC0 0x00),
    // cello = channel 5 / GM program 43 (PC byte 0xC5 0x2A). Both must appear in the MIDI.
    const midi = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/duet.mid"));
    const hasSequence = (a: number, b: number) => {
      for (let i = 0; i + 1 < midi.length; i += 1) if (midi[i] === a && midi[i + 1] === b) return true;
      return false;
    };
    assert.ok(hasSequence(0xc0, 0x00), "piano program change (channel 0, GM program 1) must be present");
    assert.ok(hasSequence(0xc5, 0x2a), "cello program change (channel 5, GM program 43) must be present");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate_music_ensemble passes a true duet and fails closed on sequential or missing instruments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-ensemble-validate-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Ensemble validate", createdByClientId: "composer" });
    const importer = getToolModule("import_musicxml_score");
    const validator = getToolModule("validate_music_ensemble");
    assert.ok(importer);
    assert.ok(validator);

    // True simultaneous duet -> passes, with measurable overlap and per-track stats.
    await importer!.handler({ projectId: project.id, musicXmlString: celloPianoDuetMusicXml, outputManifestPath: "music/real-duet.json", outputMidiPath: "music/real-duet.mid" }, ctx);
    const pass = await validator!.handler({ projectId: project.id, compositionManifestPath: "music/real-duet.json", requiredInstruments: ["piano", "cello"] }, ctx);
    assert.equal(pass.ok, true);
    const passReport = pass.structuredContent as { overlap: { durationSeconds: number } | null; tracks: Array<{ instrument: string; noteCount: number; firstNoteSeconds: number | null }>; failures: string[] };
    assert.ok(passReport.overlap && passReport.overlap.durationSeconds > 0, "real duet must report time overlap");
    assert.ok(passReport.tracks.every((track) => track.noteCount > 0));
    assert.deepEqual(passReport.failures, []);

    // Sequential handoff (cello then piano) -> fails closed with an overlap failure.
    await importer!.handler({ projectId: project.id, compositionManifestPath: undefined, musicXmlString: sequentialDuetMusicXml, outputManifestPath: "music/fake-duet.json", outputMidiPath: "music/fake-duet.mid" }, ctx);
    const seq = await validator!.handler({ projectId: project.id, compositionManifestPath: "music/fake-duet.json", requiredInstruments: ["piano", "cello"] }, ctx);
    assert.equal(seq.ok, false);
    const seqReport = seq.structuredContent as { failures: string[] };
    assert.ok(seqReport.failures.some((reason) => /do not overlap|sequential handoff/i.test(reason)), `expected overlap failure, got ${JSON.stringify(seqReport.failures)}`);

    // Missing instrument (violin requested but absent) -> fails closed with a noteCount=0 failure.
    const missing = await validator!.handler({ projectId: project.id, compositionManifestPath: "music/real-duet.json", requiredInstruments: ["piano", "cello", "violin"] }, ctx);
    assert.equal(missing.ok, false);
    const missingReport = missing.structuredContent as { failures: string[] };
    assert.ok(missingReport.failures.some((reason) => /violin.*noteCount=0|has no notes/i.test(reason)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("import_musicxml_score resolves underscored instrument keys (electric piano, acoustic bass) to the right channel/program", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-underscore-id-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Underscore identity", createdByClientId: "composer" });
    const importer = getToolModule("import_musicxml_score");
    assert.ok(importer);

    const result = await importer!.handler({ projectId: project.id, musicXmlString: electricPianoBassMusicXml, outputManifestPath: "music/ep-bass.json", outputMidiPath: "music/ep-bass.mid" }, ctx);
    const payload = result.structuredContent as { tracks: Record<string, unknown[]>; scoreSource: { trackInstruments: Record<string, string> } };
    // Specific instruments are not shadowed by the generic piano/upright_bass entries.
    assert.ok(payload.tracks.electric_piano && payload.tracks.electric_piano.length > 0, "electric piano keeps its own track");
    assert.ok(payload.tracks.acoustic_bass && payload.tracks.acoustic_bass.length > 0, "acoustic bass keeps its own track");
    assert.equal(payload.scoreSource.trackInstruments.electric_piano, "electric_piano");
    assert.equal(payload.scoreSource.trackInstruments.acoustic_bass, "acoustic_bass");

    // The underscored keys must still resolve in midiBuffer: electric_piano = ch2/program5
    // (PC 0xC2 0x04) and acoustic_bass = ch3/program33 (PC 0xC3 0x20). Before the fix these emitted
    // no Program Change at all.
    const midi = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/ep-bass.mid"));
    const hasSequence = (a: number, b: number) => {
      for (let i = 0; i + 1 < midi.length; i += 1) if (midi[i] === a && midi[i + 1] === b) return true;
      return false;
    };
    assert.ok(hasSequence(0xc2, 0x04), "electric piano program change (channel 2, GM program 5) must be present");
    assert.ok(hasSequence(0xc3, 0x20), "acoustic bass program change (channel 3, GM program 33) must be present");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("import_musicxml_score keeps a second same-instrument part as cello_2 with resolvable identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-two-cellos-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Two cellos", createdByClientId: "composer" });
    const importer = getToolModule("import_musicxml_score");
    const validator = getToolModule("validate_music_ensemble");
    assert.ok(importer && validator);

    await importer!.handler({ projectId: project.id, musicXmlString: twoCellosMusicXml, outputManifestPath: "music/two-cellos.json", outputMidiPath: "music/two-cellos.mid" }, ctx);
    const payload = (await importer!.handler({ projectId: project.id, musicXmlString: twoCellosMusicXml, outputManifestPath: "music/two-cellos.json", outputMidiPath: "music/two-cellos.mid" }, ctx)).structuredContent as {
      tracks: Record<string, Array<{ midi: number }>>;
      scoreSource: { trackInstruments: Record<string, string> };
    };
    assert.ok(payload.tracks.cello && payload.tracks.cello.length > 0);
    assert.ok(payload.tracks.cello_2 && payload.tracks.cello_2.length > 0, "second cello must be preserved as cello_2");
    assert.equal(payload.scoreSource.trackInstruments.cello_2, "cello");

    // cello_2 must resolve to the cello catalog entry: validator counts both parts toward `cello`.
    const report = (await validator!.handler({ projectId: project.id, compositionManifestPath: "music/two-cellos.json", requiredInstruments: ["cello"] }, ctx)).structuredContent as { tracks: Array<{ instrument: string; matchedTracks: string[]; noteCount: number }> };
    const celloStat = report.tracks.find((track) => track.instrument === "cello");
    assert.ok(celloStat);
    assert.deepEqual(celloStat!.matchedTracks.sort(), ["cello", "cello_2"]);
    assert.equal(celloStat!.noteCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("import_musicxml_score aligns voice 2 with voice 1 instead of trailing after it (backup/forward equivalent)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-two-voice-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Two voice", createdByClientId: "composer" });
    const importer = getToolModule("import_musicxml_score");
    assert.ok(importer);

    const result = await importer!.handler({
      projectId: project.id,
      musicXmlString: twoVoiceSingleMeasureMusicXml,
      outputManifestPath: "music/two-voice.json",
      outputMidiPath: "music/two-voice.mid"
    }, ctx);
    assert.equal(result.ok, true, `Expected ok:true but got errors: ${JSON.stringify(result.errors)}`);
    const payload = result.structuredContent as {
      tracks: Record<string, Array<{ midi: number; startBeat: number; durationBeats: number }>>;
    };
    const notes = payload.tracks.piano;
    assert.equal(notes.length, 5, "4 voice-1 melody notes + 1 voice-2 harmony note");

    const voice2Note = notes.find((n) => n.midi === 48); // C3, the voice-2 whole note
    assert.ok(voice2Note, "voice 2 note must be imported");
    assert.equal(voice2Note!.startBeat, 0, "voice 2 must start at beat 0, aligned with voice 1 — not trailing after voice 1's 4 beats");
    assert.equal(voice2Note!.durationBeats, 4);

    const voice1FirstNote = notes.find((n) => n.midi === 72); // C5, the first voice-1 melody note
    assert.ok(voice1FirstNote);
    assert.equal(voice1FirstNote!.startBeat, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate_music_ensemble rejects an alternating fake duet whose spans overlap but never sound together", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-alternating-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Alternating", createdByClientId: "composer" });
    const validator = getToolModule("validate_music_ensemble");
    assert.ok(validator);

    // piano on beats [0,2)+[4,6), cello on [2,4)+[6,8): the [first,last] spans overlap (piano 0-6,
    // cello 2-8) so old span-based overlap would pass — but no half-beat cell has both active, and
    // each solo run is short, so only the true-simultaneity grid check catches it.
    const manifest = {
      title: "Alternating duet", style: "score_import", mood: "test", tempo: 80, key: "C major",
      durationSeconds: 6, loopable: false, instruments: ["piano", "cello"], sections: [], chordProgression: [],
      tracks: {
        piano: [
          { track: "piano", midi: 60, startBeat: 0, durationBeats: 2, velocity: 80 },
          { track: "piano", midi: 62, startBeat: 4, durationBeats: 2, velocity: 80 }
        ],
        cello: [
          { track: "cello", midi: 48, startBeat: 2, durationBeats: 2, velocity: 80 },
          { track: "cello", midi: 50, startBeat: 6, durationBeats: 2, velocity: 80 }
        ]
      },
      license: { output: "test", dependencies: [] }
    };
    await writeProjectFile(ctx.projectRoot, project.id, "music/alternating.json", `${JSON.stringify(manifest)}\n`);

    const result = await validator!.handler({ projectId: project.id, compositionManifestPath: "music/alternating.json", requiredInstruments: ["piano", "cello"] }, ctx);
    assert.equal(result.ok, false);
    const report = result.structuredContent as { overlap: unknown; failures: string[] };
    assert.equal(report.overlap, null, "no cell has both instruments active");
    assert.ok(report.failures.some((reason) => /never play simultaneously/i.test(reason)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compose_edit_midi fails closed when an ensembleRequirement instrument has no notes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-compose-gate-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Compose gate", createdByClientId: "composer" });
    const composeEdit = getToolModule("compose_edit_midi");
    assert.ok(composeEdit);

    // Default (no ensembleRequirement): unchanged behaviour, still reports success.
    const control = await composeEdit!.handler({
      projectId: project.id,
      tracks: ["piano", "upright_bass", "brush_drums"],
      outputManifestPath: "music/control.json",
      outputMidiPath: "music/control.mid"
    }, ctx);
    assert.equal(control.ok, true);

    // Opt-in gate: a cello is required but was never generated -> fail closed instead of ok:true.
    const gated = await composeEdit!.handler({
      projectId: project.id,
      tracks: ["piano", "upright_bass", "brush_drums"],
      ensembleRequirement: { requiredInstruments: ["piano", "cello"] },
      outputManifestPath: "music/gated.json",
      outputMidiPath: "music/gated.mid"
    }, ctx);
    assert.equal(gated.ok, false);
    const gatedReport = (gated.structuredContent as { ensembleReport: { failures: string[] } }).ensembleReport;
    assert.ok(gatedReport.failures.some((reason) => /cello.*noteCount=0|cello.*has no notes/i.test(reason)), `expected cello noteCount failure, got ${JSON.stringify(gatedReport.failures)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("imported MusicXML cello + piano ensemble validates and missing cello fails closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-import-cello-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Import cello", createdByClientId: "composer" });
    const validator = getToolModule("validate_music_ensemble");
    assert.ok(validator);

    const ensembleResult = await importTestMusicXml(ctx, project.id, celloPianoDuetMusicXml, "music/cello-cue.json", "music/cello-cue.mid");
    const payload = ensembleResult.structuredContent as { tracks: Record<string, unknown[]>; ensembleReport: { ok: boolean; overlap: { durationSeconds: number } | null } };
    assert.ok(payload.tracks.cello && payload.tracks.cello.length > 0, "cello voice must be generated, not just requested");
    assert.ok(payload.tracks.piano && payload.tracks.piano.length > 0);
    const ensembleGate = await validator!.handler({
      projectId: project.id,
      compositionManifestPath: "music/cello-cue.json",
      requiredInstruments: ["piano", "cello"]
    }, ctx);
    assert.equal(ensembleGate.ok, true);
    const ensembleGatePayload = ensembleGate.structuredContent as { overlap: { durationSeconds: number } | null };
    assert.ok(ensembleGatePayload.overlap && ensembleGatePayload.overlap.durationSeconds > 0, "cello must overlap piano in time");
    // cello = channel 5 / GM program 43 -> Program Change 0xC5 0x2A in the MIDI.
    const midi = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/cello-cue.mid"));
    let hasCelloPc = false;
    for (let i = 0; i + 1 < midi.length; i += 1) if (midi[i] === 0xc5 && midi[i + 1] === 0x2a) hasCelloPc = true;
    assert.ok(hasCelloPc, "cello program change must be present in the MIDI");

    await importTestMusicXml(ctx, project.id, simplePianoMusicXml, "music/piano-only.json", "music/piano-only.mid");
    const missing = await validator!.handler({
      projectId: project.id,
      compositionManifestPath: "music/piano-only.json",
      requiredInstruments: ["piano", "cello"]
    }, ctx);
    assert.equal(missing.ok, false);
    assert.ok((missing.structuredContent as { failures: string[] }).failures.some((reason) => /cello/i.test(reason)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render_midi_to_audio refuses procedural fallback by default and points to the real render path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-no-procedural-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "No procedural", createdByClientId: "composer" });
    const render = getToolModule("render_midi_to_audio");
    assert.ok(render);
    await importTestMusicXml(ctx, project.id, simplePianoMusicXml, "music/p.json", "music/p.mid");

    // Default (no acknowledgement): fail closed, no fake preview written.
    const refused = await render!.handler({ acknowledgePreviewOnly: false, projectId: project.id, compositionManifestPath: "music/p.json", outputAudioPath: "music/refused.wav" }, ctx);
    assert.equal(refused.ok, false);
    const refusedPayload = refused.structuredContent as { recommendedNextTools: string[]; productionReady: boolean };
    assert.equal(refusedPayload.productionReady, false);
    assert.ok(refusedPayload.recommendedNextTools.includes("install_free_soundfont_pack"));
    assert.deepEqual(refused.artifacts, [], "no procedural preview file should be written");
    await assert.rejects(async () => readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/refused.wav")), "refused preview file must not exist");

    // Explicit acknowledgement: the throwaway preview is written (still preview_only, so ok stays
    // false — but the audio is produced, unlike the refused case where nothing is written).
    const acknowledged = await render!.handler({ acknowledgePreviewOnly: true, projectId: project.id, compositionManifestPath: "music/p.json", outputAudioPath: "music/scratch.wav" }, ctx);
    assert.ok(acknowledged.artifacts.some((artifact) => artifact.includes("scratch.wav")), "acknowledged preview must be written");
    const scratch = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/scratch.wav"));
    assert.equal(scratch.subarray(0, 4).toString("ascii"), "RIFF");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("end-to-end: install GeneralUser GS -> compose cello+piano -> render covers both roles from one GM pack", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-e2e-ensemble-"));
  const oldPath = process.env.PATH;
  let restoreFetch = () => {};
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "E2E ensemble", createdByClientId: "producer" });
    const installer = getToolModule("install_free_soundfont_pack");
    const productionRender = getToolModule("render_production_music");
    const soundfontRender = getToolModule("render_midi_with_soundfont");
    assert.ok(installer && productionRender && soundfontRender);

    // 1) Install the only free pack — it must auto-register so render can use the id (issue_0145).
    restoreFetch = installMockFetch({ "GeneralUser-GS.sf2": fakeSoundfontBytes(), "LICENSE.txt": "GeneralUser GS license fixture\n", "README.md": "# GeneralUser GS fixture\n" });
    const install = await installer!.handler({ projectId: project.id, packId: "generaluser_gs" }, ctx);
    assert.equal(install.ok, true);
    const installPayload = install.structuredContent as { autoRegistered: boolean; readyPackIds: string[] };
    assert.equal(installPayload.autoRegistered, true, "installed pack must auto-register");
    assert.ok(installPayload.readyPackIds.includes("generaluser_gs"));

    // 2) Import a real cello + piano ensemble from MusicXML.
    await importTestMusicXml(ctx, project.id, celloPianoDuetMusicXml, "music/e2e-cue.json", "music/e2e-cue.mid");

    // 3) Render: one general_midi pack must cover BOTH the piano and cello roles (keystone).
    process.env.PATH = `${await installFakeFluidSynth(root)}:${await installFakeFfmpeg(root)}:${oldPath}`;
    const render = await productionRender!.handler({
      projectId: project.id,
      compositionManifestPath: "music/e2e-cue.json",
      soundfontPackId: "generaluser_gs",
      sampleRate: 16000,
      publish: false
    }, ctx);
    assert.equal(render.ok, true, `render should succeed using the GM pack for both roles: ${JSON.stringify(render.errors)}`);
    const payload = render.structuredContent as { stemPaths: Record<string, string>; stemRenderers: Record<string, { role: string; packId: string }>; instrumentCoverage: Array<{ covered: boolean }>; loudnessFinalizedWithFfmpeg: boolean };
    assert.ok(payload.stemPaths.piano, "piano stem rendered");
    assert.ok(payload.stemPaths.cello, "cello stem rendered from the same GM pack");
    assert.equal(payload.stemRenderers.cello.packId, "generaluser_gs");
    assert.equal(payload.stemRenderers.piano.packId, "generaluser_gs");
    assert.ok(payload.instrumentCoverage.every((entry) => entry.covered), "all roles covered by the one GM pack");
    // The built-in PCM master leaves levels ~-35 LUFS; production render must finish with a real
    // ffmpeg loudnorm pass when ffmpeg is present (otherwise the "mastered" file ships too quiet).
    assert.equal(payload.loudnessFinalizedWithFfmpeg, true, "production master is loudness-finalized via ffmpeg");

    // 4) The natural flow: render again with NO soundfontPackId and NO instrumentPackMap — the
    // auto-registered general_midi pack must be discovered as the fallback and still cover both roles.
    const renderNoId = await productionRender!.handler({
      projectId: project.id,
      compositionManifestPath: "music/e2e-cue.json",
      sampleRate: 16000,
      publish: false,
      outputReportPath: "music/e2e-noid-report.json"
    }, ctx);
    assert.equal(renderNoId.ok, true, `render without a pack id should fall back to the registered GM pack: ${JSON.stringify(renderNoId.errors)}`);
    const noIdPayload = renderNoId.structuredContent as { stemPaths: Record<string, string>; stemRenderers: Record<string, { packId: string }> };
    assert.ok(noIdPayload.stemPaths.cello && noIdPayload.stemPaths.piano, "both stems render via the GM fallback");
    assert.equal(noIdPayload.stemRenderers.cello.packId, "generaluser_gs");

    const directSoundfontRender = await soundfontRender!.handler({
      projectId: project.id,
      compositionManifestPath: "music/e2e-cue.json",
      soundfontPackId: "generaluser_gs",
      sampleRate: 16000,
      outputAudioPath: "music/e2e-direct-soundfont.wav",
      outputReportPath: "music/e2e-direct-soundfont-report.json"
    }, ctx);
    assert.equal(directSoundfontRender.ok, true, `render_midi_with_soundfont should use the installed pack id directly: ${JSON.stringify(directSoundfontRender.errors)}`);

    // NOTE: routing/identity is verified at the MIDI level (piano PC 0xC0 0x00, cello PC 0xC5 0x2A,
    // GeneralUser GS is GM-compliant so program 43 = cello). The fake FluidSynth emits a fixed tone
    // regardless of program, so timbre is assumed from GM compliance, not rendered with real FluidSynth.
  } finally {
    process.env.PATH = oldPath;
    restoreFetch();
    await rm(root, { recursive: true, force: true });
  }
});

test("install_free_soundfont_pack installs GeneralUser GS metadata and blocks bad downloads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-install-soundfont-"));
  let restoreFetch = () => {};
  const oldSoundfontDir = process.env.MUSIC_SOUNDFONT_DIR;
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Install SoundFont", createdByClientId: "producer" });
    const installer = getToolModule("install_free_soundfont_pack");
    const packManager = getToolModule("manage_jazz_instrument_packs");
    assert.ok(installer);
    assert.ok(packManager);

    restoreFetch = installMockFetch({
      "GeneralUser-GS.sf2": fakeSoundfontBytes(),
      "LICENSE.txt": "GeneralUser GS license fixture\n",
      "README.md": "# GeneralUser GS fixture\n"
    });
    const result = await installer!.handler({ projectId: project.id, packId: "generaluser_gs" }, ctx);
    assert.equal(result.ok, true);
    const payload = result.structuredContent as { assetPaths: string[]; licenseTextPath: string; readmePath: string; computedSha256: string; sourceUrl: string; licenseType: string; commercialUseAllowed: boolean; productionUseApproved: boolean; qualityTier: string };
    assert.deepEqual(payload.assetPaths, ["soundfonts/generaluser-gs/GeneralUser-GS.sf2"]);
    assert.equal(payload.licenseTextPath, "soundfonts/generaluser-gs/LICENSE.txt");
    assert.equal(payload.readmePath, "soundfonts/generaluser-gs/README.md");
    assert.equal(payload.computedSha256, createHash("sha256").update(fakeSoundfontBytes()).digest("hex"));
    assert.equal(payload.sourceUrl, "https://github.com/mrbumpy409/GeneralUser-GS");
    assert.equal(payload.licenseType, "generaluser_gs_2_0");
    assert.equal(payload.commercialUseAllowed, true);
    assert.equal(payload.productionUseApproved, true);
    assert.equal(payload.qualityTier, "production_candidate");

    const packResult = await packManager!.handler({
      projectId: project.id,
      packs: [{
        packId: "generaluser_gs",
        displayName: "GeneralUser GS",
        instrumentRole: "realistic_piano",
        format: "soundfont",
        assetPaths: payload.assetPaths,
        declaredSha256: payload.computedSha256,
        licenseType: "generaluser_gs_2_0",
        source: payload.sourceUrl,
        sourceUrl: payload.sourceUrl,
        licenseTextPath: payload.licenseTextPath,
        readmePath: payload.readmePath,
        commercialUseAllowed: true,
        redistributionAllowed: true,
        productionUseApproved: true,
        qualityTier: "production_candidate"
      }]
    }, ctx);
    assert.equal(packResult.ok, true);
    const packPayload = packResult.structuredContent as { readyPackIds: string[]; packs: Array<{ packId: string; licenseType: string; qualityTier: string; productionUseApproved: boolean }> };
    assert.deepEqual(packPayload.readyPackIds, ["generaluser_gs"]);
    assert.ok(packPayload.packs.some((pack) => pack.packId === "generaluser_gs" && pack.licenseType === "generaluser_gs_2_0" && pack.qualityTier === "production_candidate" && pack.productionUseApproved));

    restoreFetch();
    const bundledRoot = path.join(root, "bundled-soundfonts");
    const bundledDir = path.join(bundledRoot, "generaluser-gs");
    await mkdir(bundledDir, { recursive: true });
    await writeFile(path.join(bundledDir, "GeneralUser-GS.sf2"), fakeSoundfontBytes());
    await writeFile(path.join(bundledDir, "LICENSE.txt"), "Bundled GeneralUser GS license\n");
    await writeFile(path.join(bundledDir, "README.md"), "# Bundled GeneralUser GS\n");
    process.env.MUSIC_SOUNDFONT_DIR = bundledRoot;
    restoreFetch = installMockFetch({}, ["GeneralUser-GS.sf2", "LICENSE.txt", "README.md"]);
    const bundledResult = await installer!.handler({ projectId: project.id, packId: "generaluser_gs", outputDirectory: "soundfonts/bundled-generaluser" }, ctx);
    assert.equal(bundledResult.ok, true);
    const bundledPayload = bundledResult.structuredContent as { installSource: string; bundledDirectory: string; computedSha256: string; assetPaths: string[] };
    assert.equal(bundledPayload.installSource, "bundled_runtime_soundfont");
    assert.equal(bundledPayload.bundledDirectory, bundledDir);
    assert.equal(bundledPayload.computedSha256, createHash("sha256").update(fakeSoundfontBytes()).digest("hex"));
    assert.deepEqual(bundledPayload.assetPaths, ["soundfonts/bundled-generaluser/GeneralUser-GS.sf2"]);

    delete process.env.MUSIC_SOUNDFONT_DIR;
    restoreFetch();
    restoreFetch = installMockFetch({
      "GeneralUser-GS.sf2": fakeSoundfontBytes(),
      "README.md": "# Missing license fixture\n"
    }, ["LICENSE.txt"]);
    const missingLicense = await installer!.handler({ projectId: project.id, packId: "generaluser_gs", outputDirectory: "soundfonts/missing-license" }, ctx);
    assert.equal(missingLicense.ok, false);
    assert.ok(missingLicense.errors.some((error) => error.includes("Download failed")));

    restoreFetch();
    restoreFetch = installMockFetch({
      "GeneralUser-GS.sf2": "not-a-soundfont",
      "LICENSE.txt": "license\n",
      "README.md": "readme\n"
    });
    const badSoundfont = await installer!.handler({ projectId: project.id, packId: "generaluser_gs", outputDirectory: "soundfonts/bad-sf2" }, ctx);
    assert.equal(badSoundfont.ok, false);
    assert.ok(badSoundfont.errors.some((error) => error.includes("not a valid RIFF/sfbk")));
  } finally {
    restoreFetch();
    if (oldSoundfontDir === undefined) delete process.env.MUSIC_SOUNDFONT_DIR;
    else process.env.MUSIC_SOUNDFONT_DIR = oldSoundfontDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("discover_soundfont_packs reports ready, review_required, and blocked candidates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-discover-soundfont-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Discover SoundFont", createdByClientId: "producer" });
    const discover = getToolModule("discover_soundfont_packs");
    const packManager = getToolModule("manage_jazz_instrument_packs");
    assert.ok(discover);
    assert.ok(packManager);

    await writeProjectAsset(ctx.projectRoot, project.id, "soundfonts/GeneralUser-GS.sf2", fakeSoundfontBytes(), "audio/soundfont");
    await writeProjectFile(ctx.projectRoot, project.id, "soundfonts/LICENSE.txt", "GeneralUser GS license fixture\n");
    await writeProjectFile(ctx.projectRoot, project.id, "soundfonts/README.md", "# GeneralUser GS\n");
    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/review.sfz", Buffer.from("<region> sample=piano.wav key=60\n", "utf8"), "text/plain");
    await writeProjectAsset(ctx.projectRoot, project.id, "music/bad.sfz", Buffer.from("no regions\n", "utf8"), "text/plain");

    const result = await discover!.handler({ projectId: project.id, includeLocalMusicPacks: false, projectSearchDirectories: ["soundfonts", "instruments", "music"] }, ctx);
    assert.equal(result.ok, false);
    const payload = result.structuredContent as {
      candidates: Array<{ path: string; format: string; sha256: string; status: string; reasons: string[]; licensePresent: boolean; readmePresent: boolean; inferredPackId?: string; suggestedRegistration?: Record<string, unknown> }>;
      ready: unknown[];
      reviewRequired: unknown[];
      blocked: unknown[];
      recommendations: string[];
    };
    const generalUser = payload.candidates.find((candidate) => candidate.path === "soundfonts/GeneralUser-GS.sf2");
    assert.ok(generalUser);
    assert.equal(generalUser!.format, "soundfont");
    assert.equal(generalUser!.status, "ready");
    assert.equal(generalUser!.inferredPackId, "generaluser_gs");
    assert.equal(generalUser!.licensePresent, true);
    assert.equal(generalUser!.readmePresent, true);
    assert.match(generalUser!.sha256, /^[a-f0-9]{64}$/);
    assert.equal(generalUser!.suggestedRegistration?.licenseType, "generaluser_gs_2_0");
    assert.ok(payload.recommendations.some((item) => item.includes("GeneralUser GS")));
    assert.ok(payload.reviewRequired.some((candidate) => (candidate as { path: string }).path === "instruments/review.sfz"));
    assert.ok(payload.blocked.some((candidate) => (candidate as { path: string; reasons: string[] }).path === "music/bad.sfz" && (candidate as { reasons: string[] }).reasons.includes("sfz_missing_region")));

    const incompleteRegistration = await packManager!.handler({
      projectId: project.id,
      packs: [{
        packId: "incomplete_generaluser",
        displayName: "Incomplete GeneralUser",
        instrumentRole: "realistic_piano",
        format: "soundfont",
        assetPaths: ["soundfonts/GeneralUser-GS.sf2"],
        licenseType: "generaluser_gs_2_0",
        source: "fixture",
        commercialUseAllowed: true,
        redistributionAllowed: true,
        productionUseApproved: true,
        qualityTier: "production_candidate"
      }]
    }, ctx);
    assert.equal(incompleteRegistration.ok, false);
    const incompletePayload = incompleteRegistration.structuredContent as { blockedPackIds: string[]; packs: Array<{ packId: string; riskFlags: string[]; qualityTier: string }> };
    assert.deepEqual(incompletePayload.blockedPackIds, ["incomplete_generaluser"]);
    assert.ok(incompletePayload.packs.some((pack) => pack.packId === "incomplete_generaluser" && pack.riskFlags.includes("missing_license_text_path") && pack.qualityTier === "preview_only"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MusicXML score can render through a commercial-safe CC BY piano SoundFont pack", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "musicxml-soundfont-"));
  const oldPath = process.env.PATH;
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "MusicXML SoundFont", createdByClientId: "producer" });
    const importer = getToolModule("import_musicxml_score");
    const packManager = getToolModule("manage_jazz_instrument_packs");
    const soundfontRender = getToolModule("render_midi_with_soundfont");
    assert.ok(importer);
    assert.ok(packManager);
    assert.ok(soundfontRender);

    await importer!.handler({
      projectId: project.id,
      musicXmlString: simplePianoMusicXml,
      outputManifestPath: "music/score.json",
      outputMidiPath: "music/score.mid"
    }, ctx);
    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/salamander-cc-by.sf2", fakeSoundfontBytes(), "audio/soundfont");
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/LICENSE.txt", "CC BY fixture license\n");
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/README.md", "# Salamander fixture\n");
    const packResult = await packManager!.handler({
      projectId: project.id,
      intendedUse: "streaming_demo",
      packs: [{
        packId: "salamander_cc_by",
        displayName: "Salamander Grand Piano Fixture",
        instrumentRole: "realistic_piano",
        format: "soundfont",
        assetPaths: ["instruments/salamander-cc-by.sf2"],
        licenseType: "cc_by",
        source: "fixture",
        sourceUrl: "https://example.test/salamander-fixture",
        licenseTextPath: "instruments/LICENSE.txt",
        readmePath: "instruments/README.md",
        attribution: "Salamander Grand Piano sample fixture, CC BY attribution captured.",
        commercialUseAllowed: true,
        redistributionAllowed: true,
        modificationsAllowed: true,
        productionUseApproved: true,
        qualityTier: "production_candidate"
      }]
    }, ctx);
    assert.equal(packResult.ok, true);
    const packPayload = packResult.structuredContent as { readyPackIds: string[]; licenseManifest: { assetLicenseTable: Array<{ path: string; license: string; attribution?: string; commercialUseAllowed?: boolean }> } };
    assert.deepEqual(packPayload.readyPackIds, ["salamander_cc_by"]);
    assert.ok(packPayload.licenseManifest.assetLicenseTable.some((asset) => asset.path === "instruments/salamander-cc-by.sf2" && asset.license === "cc_by" && asset.commercialUseAllowed === true && asset.attribution));

    process.env.PATH = `${await installFakeFluidSynth(root)}:${await installFakeSfizz(root)}:${oldPath}`;
    const renderResult = await soundfontRender!.handler({
      projectId: project.id,
      compositionManifestPath: "music/score.json",
      soundfontPackId: "salamander_cc_by",
      outputAudioPath: "music/score-soundfont.wav",
      outputReportPath: "music/score-soundfont-report.json"
    }, ctx);
    assert.equal(renderResult.ok, true);
    const renderPayload = renderResult.structuredContent as { qualityTier: string; productionReady: boolean; packSha256: string; packLicenseTextPath: string; packSourceUrl: string; productionUseApproved: boolean; soundfont: { licenseType: string; attribution: string; commercialUseAllowed: boolean; licenseTextPath: string; sourceUrl: string }; fullMixPath: string };
    assert.equal(renderPayload.qualityTier, "production_candidate");
    assert.equal(renderPayload.productionReady, true);
    assert.match(renderPayload.packSha256, /^[a-f0-9]{64}$/);
    assert.equal(renderPayload.packLicenseTextPath, "instruments/LICENSE.txt");
    assert.equal(renderPayload.packSourceUrl, "https://example.test/salamander-fixture");
    assert.equal(renderPayload.productionUseApproved, true);
    assert.equal(renderPayload.soundfont.licenseType, "cc_by");
    assert.equal(renderPayload.soundfont.commercialUseAllowed, true);
    assert.equal(renderPayload.soundfont.licenseTextPath, "instruments/LICENSE.txt");
    assert.equal(renderPayload.soundfont.sourceUrl, "https://example.test/salamander-fixture");
    assert.match(renderPayload.soundfont.attribution, /Salamander/);
    assert.equal(renderPayload.fullMixPath, "music/score-soundfont.wav");
    const wav = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/score-soundfont.wav"));
    assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");

    // render_midi_with_soundfont must also fail closed (not just render_production_music) when a
    // requested stem renders silent — it would otherwise ship an empty stem as production_candidate.
    process.env.FAKE_FLUIDSYNTH_SILENT = "1";
    try {
      const silentStemRender = await soundfontRender!.handler({
        projectId: project.id,
        compositionManifestPath: "music/score.json",
        soundfontPackId: "salamander_cc_by",
        stems: true,
        outputAudioPath: "music/score-silent.wav",
        outputStemDirectory: "music/stems-silent",
        outputReportPath: "music/score-silent-report.json"
      }, ctx);
      assert.equal(silentStemRender.ok, false);
      assert.match(silentStemRender.summary, /silent|Stem validation failed/i);
    } finally {
      delete process.env.FAKE_FLUIDSYNTH_SILENT;
    }
  } finally {
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("render auto-registers a discovered license-cleared SoundFont instead of dead-ending on 'no registered ready pack'", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "musicxml-autoregister-"));
  const oldPath = process.env.PATH;
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Auto Register SoundFont", createdByClientId: "producer" });
    const importer = getToolModule("import_musicxml_score");
    const soundfontRender = getToolModule("render_midi_with_soundfont");
    assert.ok(importer);
    assert.ok(soundfontRender);

    await importer!.handler({
      projectId: project.id,
      musicXmlString: simplePianoMusicXml,
      outputManifestPath: "music/score.json",
      outputMidiPath: "music/score.mid"
    }, ctx);

    // A license-cleared GeneralUser-GS SoundFont sits in project assets with its sidecars, but is
    // NEVER registered via manage_jazz_instrument_packs — the exact registry-to-renderer mismatch.
    await writeProjectAsset(ctx.projectRoot, project.id, "soundfonts/GeneralUser-GS.sf2", fakeSoundfontBytes(), "audio/soundfont");
    await writeProjectFile(ctx.projectRoot, project.id, "soundfonts/LICENSE.txt", "GeneralUser GS license fixture\n");
    await writeProjectFile(ctx.projectRoot, project.id, "soundfonts/README.md", "# GeneralUser GS fixture\n");

    // No registry file exists yet.
    await assert.rejects(readProjectFile(ctx.projectRoot, project.id, "music/jazz-instrument-packs.json", 1024 * 1024));

    process.env.PATH = `${await installFakeFluidSynth(root)}:${await installFakeSfizz(root)}:${oldPath}`;
    const renderResult = await soundfontRender!.handler({
      projectId: project.id,
      compositionManifestPath: "music/score.json",
      soundfontPath: "soundfonts/GeneralUser-GS.sf2",
      outputAudioPath: "music/score-soundfont.wav",
      outputReportPath: "music/score-soundfont-report.json"
    }, ctx);

    assert.equal(renderResult.ok, true, `expected self-heal to render, got: ${JSON.stringify(renderResult.errors)}`);
    const renderPayload = renderResult.structuredContent as { qualityTier: string; productionReady: boolean };
    assert.equal(renderPayload.qualityTier, "production_candidate");
    assert.equal(renderPayload.productionReady, true);

    // The self-heal must have written the registry so subsequent renders resolve directly.
    const registry = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "music/jazz-instrument-packs.json", 1024 * 1024)) as { readyPackIds: string[]; packs: Array<{ assetPaths: string[] }> };
    assert.ok(registry.readyPackIds.length > 0, "auto-registration should produce a ready pack");
    assert.ok(registry.packs.some((pack) => pack.assetPaths.includes("soundfonts/GeneralUser-GS.sf2")));
  } finally {
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("music workflow composes, edits, renders, audits, and exports music assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-workflow-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Music project", createdByClientId: "composer" });
    const styleBrief = getToolModule("create_music_style_brief");
    const edit = getToolModule("edit_midi");
    const render = getToolModule("render_midi_to_audio");
    const harmony = getToolModule("generate_jazz_harmony");
    const drums = getToolModule("generate_drum_groove");
    const inspect = getToolModule("inspect_audio_quality");
    const licenseManifest = getToolModule("build_music_license_manifest");
    const packManager = getToolModule("manage_jazz_instrument_packs");
    const soundfontRender = getToolModule("render_midi_with_soundfont");
    const exportProject = getToolModule("export_music_project");
    const exportAssets = getToolModule("export_music_assets");
    const audition = getToolModule("audition_music_variations");
    for (const [name, tool] of Object.entries({ styleBrief, edit, render, harmony, drums, inspect, licenseManifest, packManager, soundfontRender, exportProject, exportAssets, audition })) assert.ok(tool, `${name} registered`);

    const briefResult = await styleBrief!.handler({
      projectId: project.id,
      referencePrompt: "Starbucks-style cafe jazz background music",
      useCase: "coffee shop website hero background"
    }, ctx);
    assert.equal(briefResult.ok, true);
    const briefPayload = briefResult.structuredContent as { legalBoundary: string; instruments: string[] };
    assert.match(briefPayload.legalBoundary, /do not copy/i);
    assert.ok(briefPayload.instruments.includes("piano"));

    const { result: composeResult, composition: composedManifest } = await composeTestCue(ctx, {
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
    const composition = composedManifest as unknown as { chordProgression: string[]; tracks: Record<string, unknown[]>; license: { output: string } };
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

    const renderResult = await render!.handler({ acknowledgePreviewOnly: true,
      projectId: project.id,
      compositionManifestPath: "music/edited-composition-manifest.json",
      sampleRate: 16000,
      instrumentMap: { piano: "warm_acoustic_piano", bass: "upright_bass", drums: "jazz_brushes" },
      renderPreset: "warm_cafe",
      outputFormats: ["wav", "mp3"],
      stems: true
    }, ctx);
    assert.equal(renderResult.ok, false);
    const wavPath = await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/rendered-preview.wav");
    const wav = await readFile(wavPath);
    assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
    const renderPayload = renderResult.structuredContent as {
      fullMixPath: string;
      stemPaths: Record<string, string>;
      qualityTier: string;
      productionReady: boolean;
      blockingReasons: string[];
      renderReport: { requestedFormats: string[]; renderedFormats: string[]; sampleRate: number; bitDepth: number; peakLevel: number; missingInstrumentFallbackWarnings: string[]; fileSizes: Record<string, number> };
      licenseManifest: { renderer: string; qualityTier: string; productionReady: boolean; instruments: Record<string, { license: string }> };
      warnings: string[];
    };
    assert.equal(renderPayload.fullMixPath, "music/rendered-preview.wav");
    assert.equal(renderPayload.qualityTier, "preview_only");
    assert.equal(renderPayload.productionReady, false);
    assert.ok(renderPayload.blockingReasons.some((reason) => reason.includes("preview_only")));
    assert.ok(renderPayload.stemPaths.piano);
    assert.ok(renderPayload.stemPaths.bass);
    assert.ok(renderPayload.stemPaths.drums);
    assert.deepEqual(renderPayload.renderReport.requestedFormats, ["wav", "mp3"]);
    assert.deepEqual(renderPayload.renderReport.renderedFormats, ["wav"]);
    assert.equal(renderPayload.renderReport.sampleRate, 16000);
    assert.equal(renderPayload.renderReport.bitDepth, 16);
    assert.ok(renderPayload.renderReport.peakLevel > 0);
    assert.equal(renderPayload.renderReport.missingInstrumentFallbackWarnings.length, 0);
    assert.equal(renderPayload.licenseManifest.renderer, "built_in_procedural_synth");
    assert.equal(renderPayload.licenseManifest.qualityTier, "preview_only");
    assert.equal(renderPayload.licenseManifest.productionReady, false);
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
      // render_midi_to_audio output is a procedural preview, not production audio.
      renderTier: "preview",
      checkLoop: true,
      targetMood: "warm calm jazz"
    }, ctx);
    assert.equal(qaResult.ok, true);
    const qaPayload = qaResult.structuredContent as {
      noteCount: number;
      productionSafe: boolean;
      blockingReasons: string[];
      peak: number;
      warnings: string[];
      technicalReport: { format: string; sampleRate: number; bitDepth: number; durationSeconds: number; peak: number; rms: number; silenceGaps: unknown[]; harshHighFrequencyProxy: number; excessiveBassProxy: number };
      loudnessReport: { peak: number; rms: number; estimatedLufs: number; dynamicRange: number };
      loopSeamReport: { checked: boolean; loopable: boolean; seamClickProxy: number };
      noiseFloorReport: { renderTier: string; renderTierSource: string; noiseToSignalRatio: number; threshold: number; overThreshold: boolean; gated: boolean };
      backgroundSuitabilityScore: number;
      findings: Array<{ severity: string; category: string; message: string; suggestedFix: string }>;
      suggestedFixes: string[];
      recommendations: string[];
    };
    assert.ok(qaPayload.noteCount > 0);
    assert.equal(qaPayload.productionSafe, true);
    assert.deepEqual(qaPayload.blockingReasons, []);
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
    // The preview still reports the noise-floor measurement; this clean render has no
    // stable broadband floor, so the robust estimator truthfully reports a zero ratio.
    assert.equal(qaPayload.noiseFloorReport.renderTier, "preview");
    assert.equal(qaPayload.noiseFloorReport.renderTierSource, "declared");
    assert.equal(qaPayload.noiseFloorReport.threshold, 0.15);
    assert.equal(qaPayload.noiseFloorReport.noiseToSignalRatio, 0);
    assert.equal(qaPayload.noiseFloorReport.gated, false);
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
    const pianoSf2 = fakeSoundfontBytes();
    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/piano/warm-pack.sfz", Buffer.from(pianoSfz, "utf8"), "text/plain");
    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/bass/upright-pack.sfz", Buffer.from(bassSfz, "utf8"), "text/plain");
    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/brushes/soft-pack.sfz", Buffer.from(brushesSfz, "utf8"), "text/plain");
    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/piano/warm-pack.sf2", pianoSf2, "audio/soundfont");
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/piano/LICENSE.txt", "MIT/Apache fixture license\n");
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/piano/README.md", "# Piano fixture\n");
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/brushes/LICENSE.txt", "CC0 fixture license\n");
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/brushes/README.md", "# Brushes fixture\n");
    await assert.rejects(
      writeProjectAsset(ctx.projectRoot, project.id, "instruments/piano/broken.sf2", Buffer.from("not-a-soundfont", "utf8"), "audio/soundfont"),
      /SoundFont asset has invalid magic bytes/
    );

    const blockedPackResult = await packManager!.handler({
      projectId: project.id,
      intendedUse: "client_delivery",
      packs: [
        {
          packId: "warm_piano_mit",
          displayName: "Warm Piano MIT",
          instrumentRole: "realistic_piano",
          format: "sfz",
          assetPaths: ["instruments/piano/warm-pack.sfz"],
          version: "1.0.0",
          declaredSha256: createHash("sha256").update(pianoSfz).digest("hex"),
          licenseType: "mit",
          source: "project fixture",
          sourceUrl: "https://example.test/warm-piano",
          licenseTextPath: "instruments/piano/LICENSE.txt",
          readmePath: "instruments/piano/README.md",
          commercialUseAllowed: true,
          redistributionAllowed: true,
          modificationsAllowed: true,
          productionUseApproved: true,
          qualityTier: "production_candidate"
        },
        {
          packId: "upright_bass_lgpl",
          displayName: "Upright Bass LGPL",
          instrumentRole: "upright_bass",
          format: "sfz",
          assetPaths: ["instruments/bass/upright-pack.sfz"],
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
          assetPaths: ["instruments/brushes/soft-pack.sfz"],
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
          assetPaths: ["instruments/piano/warm-pack.sfz"],
          licenseType: "mit",
          source: "project fixture",
          sourceUrl: "https://example.test/warm-piano",
          licenseTextPath: "instruments/piano/LICENSE.txt",
          readmePath: "instruments/piano/README.md",
          commercialUseAllowed: true,
          redistributionAllowed: true,
          modificationsAllowed: true,
          productionUseApproved: true,
          qualityTier: "production_candidate"
        },
        {
          packId: "upright_bass_apache",
          displayName: "Upright Bass Apache",
          instrumentRole: "upright_bass",
          format: "soundfont",
          assetPaths: ["instruments/piano/warm-pack.sf2"],
          licenseType: "apache_2",
          source: "project fixture",
          sourceUrl: "https://example.test/upright-bass",
          licenseTextPath: "instruments/piano/LICENSE.txt",
          readmePath: "instruments/piano/README.md",
          commercialUseAllowed: true,
          redistributionAllowed: true,
          modificationsAllowed: true,
          productionUseApproved: true,
          qualityTier: "production_candidate"
        },
        {
          packId: "brushes_cc0",
          displayName: "Brushes CC0",
          instrumentRole: "brush_drums",
          format: "wav_multisample",
          assetPaths: ["instruments/brushes/soft-pack.sfz"],
          licenseType: "cc0",
          source: "project fixture",
          sourceUrl: "https://example.test/brushes",
          licenseTextPath: "instruments/brushes/LICENSE.txt",
          readmePath: "instruments/brushes/README.md",
          commercialUseAllowed: true,
          redistributionAllowed: true,
          modificationsAllowed: true,
          productionUseApproved: true,
          qualityTier: "production_candidate"
        }
      ]
    }, ctx);
    assert.equal(safePackResult.ok, true);
    const safePackPayload = safePackResult.structuredContent as {
      readyPackIds: string[];
      reviewRequiredPackIds: string[];
      blockedPackIds: string[];
      packs: Array<{ packId: string; format: string; computedSha256?: string; eligibleRenderer?: string; qualityTier: string; productionUseApproved: boolean; licenseTextPath?: string; sourceUrl?: string }>;
      instrumentMapCandidates: Record<string, { packId?: string; rendererUse: string }>;
      rendererIntegration: { rule: string; eligibleRenderer: string; eligibleRenderers: string[]; safeProceduralFallbackMap: Record<string, string> };
      licenseManifest: { commercialUseStatus: string; unsafeAssets: unknown[] };
    };
    assert.deepEqual(safePackPayload.readyPackIds.sort(), ["brushes_cc0", "upright_bass_apache", "warm_piano_mit"].sort());
    assert.deepEqual(safePackPayload.reviewRequiredPackIds, []);
    assert.deepEqual(safePackPayload.blockedPackIds, []);
    assert.ok(safePackPayload.packs.some((pack) => pack.packId === "warm_piano_mit" && pack.format === "sfz" && pack.eligibleRenderer === "sfizz" && pack.computedSha256 === createHash("sha256").update(pianoSfz).digest("hex")));
    assert.ok(safePackPayload.packs.some((pack) => pack.packId === "upright_bass_apache" && pack.format === "soundfont" && pack.eligibleRenderer === "fluidsynth" && pack.computedSha256 === createHash("sha256").update(pianoSf2).digest("hex")));
    assert.ok(safePackPayload.packs.some((pack) => pack.packId === "upright_bass_apache" && pack.qualityTier === "production_candidate" && pack.productionUseApproved && pack.licenseTextPath === "instruments/piano/LICENSE.txt" && pack.sourceUrl === "https://example.test/upright-bass"));
    assert.equal(safePackPayload.instrumentMapCandidates.realistic_piano.packId, "warm_piano_mit");
    assert.equal(safePackPayload.instrumentMapCandidates.upright_bass.packId, "upright_bass_apache");
    assert.equal(safePackPayload.instrumentMapCandidates.brush_drums.packId, "brushes_cc0");
    assert.match(safePackPayload.rendererIntegration.rule, /status=ready/);
    assert.equal(safePackPayload.rendererIntegration.eligibleRenderer, "fluidsynth");
    assert.deepEqual(safePackPayload.rendererIntegration.eligibleRenderers.sort(), ["fluidsynth", "sfizz"].sort());
    assert.equal(safePackPayload.rendererIntegration.safeProceduralFallbackMap.brush_drums, "jazz_brushes");
    assert.equal(safePackPayload.licenseManifest.commercialUseStatus, "allowed");
    assert.equal(safePackPayload.licenseManifest.unsafeAssets.length, 0);
    const safePackRegistry = await readProjectFile(ctx.projectRoot, project.id, "music/jazz-instrument-packs.json");
    assert.match(safePackRegistry, /warm_piano_mit/);

    const oldPath = process.env.PATH;
	    process.env.PATH = `${await installFakeFluidSynth(root)}:${await installFakeSfizz(root)}:${oldPath}`;
	    const oldExpectedStatus = process.env.EXPECT_MIDI_STATUS_HEX;
	    try {
	      const editedComposition = JSON.parse(await readProjectFile(ctx.projectRoot, project.id, "music/edited-composition-manifest.json")) as Record<string, unknown> & { tracks: Record<string, unknown[]> };
	      await writeProjectFile(ctx.projectRoot, project.id, "music/bass-only-manifest.json", `${JSON.stringify({ ...editedComposition, instruments: ["upright_bass"], tracks: { bass: editedComposition.tracks.bass ?? [] } }, null, 2)}\n`);
	      await writeProjectFile(ctx.projectRoot, project.id, "music/piano-only-manifest.json", `${JSON.stringify({ ...editedComposition, instruments: ["piano"], tracks: { piano: editedComposition.tracks.piano ?? [] } }, null, 2)}\n`);

	      const mixedSinglePackResult = await soundfontRender!.handler({
	        projectId: project.id,
	        compositionManifestPath: "music/edited-composition-manifest.json",
	        soundfontPackId: "warm_piano_mit",
	        outputReportPath: "music/mixed-single-pack-report.json"
	      }, ctx);
	      assert.equal(mixedSinglePackResult.ok, false);
	      assert.ok(mixedSinglePackResult.errors.some((error) => error.includes("requires upright_bass") || error.includes("requires brush_drums")));
	      const mixedSinglePackPayload = mixedSinglePackResult.structuredContent as { qualityTier: string; productionReady: boolean; instrumentCoverage: Array<{ covered: boolean; track: string; requiredRole: string }> };
	      assert.equal(mixedSinglePackPayload.qualityTier, "preview_only");
	      assert.equal(mixedSinglePackPayload.productionReady, false);
	      assert.ok(mixedSinglePackPayload.instrumentCoverage.some((entry) => entry.track === "bass" && entry.requiredRole === "upright_bass" && !entry.covered));

	      const soundfontResult = await soundfontRender!.handler({
	        projectId: project.id,
	        compositionManifestPath: "music/bass-only-manifest.json",
	        soundfontPackId: "upright_bass_apache",
	        stems: true,
	        sampleRate: 8000
      }, ctx);
      assert.equal(soundfontResult.ok, true);
      const soundfontPayload = soundfontResult.structuredContent as {
        renderer: string;
        qualityTier: string;
        productionReady: boolean;
        fullMixPath: string;
        stemPaths: Record<string, string>;
        packLicenseTextPath: string;
	        packSourceUrl: string;
	        productionUseApproved: boolean;
	        soundfont: { packId: string; computedSha256: string; licenseTextPath: string; sourceUrl: string; productionUseApproved: boolean };
	        instrumentCoverage: Array<{ covered: boolean; requiredRole: string }>;
	        channelMapApplied: boolean;
	        renderReport: { renderedFormats: string[]; peakLevel: number; rms: number; stemCount: number };
	      };
      assert.equal(soundfontPayload.renderer, "fluidsynth");
      assert.equal(soundfontPayload.qualityTier, "production_candidate");
      assert.equal(soundfontPayload.productionReady, true);
      assert.equal(soundfontPayload.packLicenseTextPath, "instruments/piano/LICENSE.txt");
      assert.equal(soundfontPayload.packSourceUrl, "https://example.test/upright-bass");
      assert.equal(soundfontPayload.productionUseApproved, true);
      assert.equal(soundfontPayload.fullMixPath, "music/rendered-soundfont.wav");
      assert.equal(soundfontPayload.channelMapApplied, false);
      assert.ok(Object.keys(soundfontPayload.stemPaths).length > 0);
      assert.equal(soundfontPayload.renderReport.stemCount, Object.keys(soundfontPayload.stemPaths).length);
      assert.equal(soundfontPayload.soundfont.packId, "upright_bass_apache");
      assert.equal(soundfontPayload.soundfont.computedSha256, createHash("sha256").update(pianoSf2).digest("hex"));
      assert.equal(soundfontPayload.soundfont.licenseTextPath, "instruments/piano/LICENSE.txt");
      assert.equal(soundfontPayload.soundfont.sourceUrl, "https://example.test/upright-bass");
	      assert.equal(soundfontPayload.soundfont.productionUseApproved, true);
	      assert.ok(soundfontPayload.instrumentCoverage.every((entry) => entry.covered && entry.requiredRole === "upright_bass"));
	      assert.deepEqual(soundfontPayload.renderReport.renderedFormats, ["wav"]);
      assert.ok(soundfontPayload.renderReport.peakLevel > 0);
      assert.ok(soundfontPayload.renderReport.rms > 0);
      const rendered = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, soundfontPayload.fullMixPath));
      assert.equal(rendered.subarray(0, 4).toString("ascii"), "RIFF");

	      process.env.EXPECT_MIDI_STATUS_HEX = "91";
	      const mappedSoundfontResult = await soundfontRender!.handler({
	        projectId: project.id,
	        compositionManifestPath: "music/bass-only-manifest.json",
	        soundfontPackId: "upright_bass_apache",
	        channelMap: { bass: 1 },
	        stems: false,
        sampleRate: 8000,
        outputAudioPath: "music/mapped-soundfont.wav",
        outputReportPath: "music/custom-soundfont-report.json"
      }, ctx);
      assert.equal(mappedSoundfontResult.ok, true);
      const mappedPayload = mappedSoundfontResult.structuredContent as { fullMixPath: string; renderReportPath: string; channelMapApplied: boolean; renderReport: { stemCount: number } };
      assert.equal(mappedPayload.fullMixPath, "music/mapped-soundfont.wav");
      assert.equal(mappedPayload.renderReportPath, "music/custom-soundfont-report.json");
      assert.equal(mappedPayload.channelMapApplied, true);
      assert.equal(mappedPayload.renderReport.stemCount, 0);

	      const sfzRenderResult = await soundfontRender!.handler({
	        projectId: project.id,
	        compositionManifestPath: "music/piano-only-manifest.json",
	        soundfontPackId: "warm_piano_mit",
        stems: false,
        sampleRate: 8000,
        outputAudioPath: "music/rendered-sfz.wav",
        outputReportPath: "music/sfz-render-report.json"
      }, ctx);
      assert.equal(sfzRenderResult.ok, true, JSON.stringify(sfzRenderResult.errors));
      const sfzPayload = sfzRenderResult.structuredContent as {
        renderer: string;
        qualityTier: string;
        productionReady: boolean;
        fullMixPath: string;
        soundfont: { packId: string; format: string; renderer: string; computedSha256: string };
        renderReport: { renderedFormats: string[]; peakLevel: number; rms: number };
      };
      assert.equal(sfzPayload.renderer, "sfizz");
      assert.equal(sfzPayload.qualityTier, "production_candidate");
      assert.equal(sfzPayload.productionReady, true);
      assert.equal(sfzPayload.fullMixPath, "music/rendered-sfz.wav");
      assert.equal(sfzPayload.soundfont.packId, "warm_piano_mit");
      assert.equal(sfzPayload.soundfont.format, "sfz");
      assert.equal(sfzPayload.soundfont.renderer, "sfizz");
      assert.equal(sfzPayload.soundfont.computedSha256, createHash("sha256").update(pianoSfz).digest("hex"));
      assert.deepEqual(sfzPayload.renderReport.renderedFormats, ["wav"]);
      assert.ok(sfzPayload.renderReport.peakLevel > 0);
      assert.ok(sfzPayload.renderReport.rms > 0);
      const renderedSfz = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, sfzPayload.fullMixPath));
      assert.equal(renderedSfz.subarray(0, 4).toString("ascii"), "RIFF");

      const defaultGateResult = await exportProject!.handler({
        projectId: project.id,
        projectManifestPath: "music/edited-composition-manifest.json",
        exports: ["single_track_wav", "project_manifest"],
        renderedAudioPaths: ["music/rendered-soundfont.wav"],
        publish: false,
        outputHtmlPath: "music/default-gate.html",
        outputManifestPath: "music/default-gate-export.json",
        outputReadmePath: "music/default-gate/README.md",
        outputPackageReportPath: "music/default-gate/package-report.json",
        outputPlaylistPath: "music/default-gate/playlist.json"
      }, ctx);
      assert.equal(defaultGateResult.ok, true);
      const defaultGatePayload = defaultGateResult.structuredContent as { productionGateWarnings: string[]; resolvedRenderReports: Array<{ reportPath: string; qualityTier: string }> };
      assert.deepEqual(defaultGatePayload.productionGateWarnings, []);
      assert.ok(defaultGatePayload.resolvedRenderReports.some((report) => report.reportPath === "music/soundfont-render-report.json" && report.qualityTier === "production_candidate"));

      const customGateResult = await exportProject!.handler({
        projectId: project.id,
        projectManifestPath: "music/edited-composition-manifest.json",
        exports: ["single_track_wav", "project_manifest"],
        renderedAudioPaths: ["music/mapped-soundfont.wav"],
        renderReportPaths: ["music/custom-soundfont-report.json"],
        publish: false,
        outputHtmlPath: "music/custom-gate.html",
        outputManifestPath: "music/custom-gate-export.json",
        outputReadmePath: "music/custom-gate/README.md",
        outputPackageReportPath: "music/custom-gate/package-report.json",
        outputPlaylistPath: "music/custom-gate/playlist.json"
      }, ctx);
      assert.equal(customGateResult.ok, true);
      const customGatePayload = customGateResult.structuredContent as { renderReportPaths: string[]; productionGateWarnings: string[]; resolvedRenderReports: Array<{ reportPath: string; fullMixPath?: string }> };
      assert.deepEqual(customGatePayload.renderReportPaths, ["music/custom-soundfont-report.json"]);
      assert.deepEqual(customGatePayload.productionGateWarnings, []);
      assert.ok(customGatePayload.resolvedRenderReports.some((report) => report.reportPath === "music/custom-soundfont-report.json" && report.fullMixPath === "music/mapped-soundfont.wav"));
    } finally {
      process.env.PATH = oldPath;
      if (oldExpectedStatus === undefined) delete process.env.EXPECT_MIDI_STATUS_HEX;
      else process.env.EXPECT_MIDI_STATUS_HEX = oldExpectedStatus;
    }

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

test("compose_edit_midi creates a shaped piano sketch instead of block-chord placeholders", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-compose-quality-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Piano compose quality", createdByClientId: "composer" });
    const render = getToolModule("render_midi_to_audio");
    const inspect = getToolModule("inspect_audio_quality");
    assert.ok(render);
    assert.ok(inspect);

    const { result: composeResult, composition: composedManifest } = await composeTestCue(ctx, {
      projectId: project.id,
      title: "Glass Study Sketch",
      style: "smooth_piano",
      mood: "gentle lyrical solo piano",
      tempo: 72,
      key: "A minor",
      durationSeconds: 48,
      useCase: "solo piano sketch",
      instruments: ["piano"],
      complexity: "medium",
      loopable: false,
      outputManifestPath: "music/piano-quality.json",
      outputMidiPath: "music/piano-quality.mid"
    }, ctx);
    assert.equal(composeResult.ok, true);
    const composition = composedManifest as unknown as {
      durationSeconds: number;
      tempo: number;
      tracks: Record<string, Array<{ startBeat: number; durationBeats: number; velocity: number }>>;
      compositionPlan: { motifs: Array<{ id: string }>; energyCurve: number[] };
      performance: { humanized: boolean; sustainPedal: Array<{ startBeat: number; endBeat: number }> };
      musicalityReport: { hasPlan: boolean; hasHumanizedPerformance: boolean; mechanicalScore: number; gridLockRatio: number };
    };
    const pianoNotes = composition.tracks.piano;
    assert.ok(composition.compositionPlan.motifs.some((motif) => motif.id === "main_motif"));
    assert.ok(composition.compositionPlan.energyCurve.length >= 8);
    assert.equal(composition.performance.humanized, true);
    assert.ok(composition.performance.sustainPedal.length > 0);
    assert.equal(composition.musicalityReport.hasPlan, true);
    assert.equal(composition.musicalityReport.hasHumanizedPerformance, true);
    assert.ok(composition.musicalityReport.mechanicalScore < 0.72);
    assert.ok(composition.musicalityReport.gridLockRatio < 0.92);
    assert.ok(pianoNotes.length >= 80, "piano sketch should have enough arpeggio and melody notes to be musically inspectable");
    assert.ok(pianoNotes.some((note) => note.startBeat % 1 !== 0), "piano sketch should include off-beat arpeggios or pickup notes");
    assert.ok(pianoNotes.some((note) => note.durationBeats <= 0.75), "piano sketch should include short moving notes, not only sustained block chords");
    assert.ok(pianoNotes.some((note) => note.durationBeats >= 1.25), "piano sketch should include sustained melodic or harmonic notes");
    const velocities = pianoNotes.map((note) => note.velocity);
    assert.ok(Math.max(...velocities) - Math.min(...velocities) >= 18, "piano sketch should have an audible dynamic curve");
    const finalNoteSeconds = Math.max(...pianoNotes.map((note) => (note.startBeat + note.durationBeats) * 60 / composition.tempo));
    assert.ok(finalNoteSeconds <= composition.durationSeconds + 0.01, "generated notes should not run past the declared duration");

    const renderResult = await render!.handler({ acknowledgePreviewOnly: true,
      projectId: project.id,
      compositionManifestPath: "music/piano-quality.json",
      sampleRate: 16000,
      instrumentMap: { piano: "warm_acoustic_piano" },
      renderPreset: "warm_cafe",
      outputAudioPath: "music/piano-quality.wav",
      outputReportPath: "music/piano-quality-render.json"
    }, ctx);
    assert.equal(renderResult.ok, false);
    const qaResult = await inspect!.handler({
      projectId: project.id,
      audioPath: "music/piano-quality.wav",
      compositionManifestPath: "music/piano-quality.json",
      useCase: "solo piano sketch",
      // Tier comes from the renderer's own report, not from a claim in this call.
      renderReportPath: "music/piano-quality-render.json",
      checkLoop: false,
      outputPath: "music/piano-quality-qa.json"
    }, ctx);
    assert.equal(qaResult.ok, true);
    const qa = qaResult.structuredContent as { warnings: string[]; technicalReport: { silenceGaps: unknown[] }; musicalityReport: { mechanicalScore: number; hasPlan: boolean } };
    assert.deepEqual(qa.warnings, []);
    assert.deepEqual(qa.technicalReport.silenceGaps, []);
    assert.equal(qa.musicalityReport.hasPlan, true);
    assert.ok(qa.musicalityReport.mechanicalScore < 0.72);

    // Same audio, default renderTier: quiet piano notes and decays are programme material, not a
    // measured hiss floor, so the production gate must accept this clean deterministic render.
    const productionQaResult = await inspect!.handler({
      projectId: project.id,
      audioPath: "music/piano-quality.wav",
      compositionManifestPath: "music/piano-quality.json",
      useCase: "solo piano sketch",
      checkLoop: false,
      outputPath: "music/piano-quality-production-qa.json"
    }, ctx);
    assert.equal(productionQaResult.ok, true);
    const productionQa = productionQaResult.structuredContent as {
      productionSafe: boolean;
      blockingReasons: string[];
      noiseFloorReport: { renderTier: string; renderTierSource: string; threshold: number; overThreshold: boolean; gated: boolean };
    };
    assert.equal(productionQa.noiseFloorReport.renderTier, "production_candidate");
    assert.equal(productionQa.noiseFloorReport.renderTierSource, "default");
    // Solo piano is auto-detected, so the stricter 10% threshold applies.
    assert.equal(productionQa.noiseFloorReport.threshold, 0.10);
    assert.equal(productionQa.noiseFloorReport.overThreshold, false);
    assert.equal(productionQa.noiseFloorReport.gated, false);
    assert.equal(productionQa.productionSafe, true);
    assert.ok(!productionQa.blockingReasons.some((reason) => reason.includes("Audible noise floor detected")));

    // The renderer's stamp still outranks the caller, independently of whether the measured audio
    // crosses the noise gate.
    await writeProjectFile(ctx.projectRoot, project.id, "music/claimed-preview-render.json", `${JSON.stringify({ renderer: "render_midi_with_soundfont", qualityTier: "production_candidate", productionReady: true }, null, 2)}\n`);
    const spoofedQaResult = await inspect!.handler({
      projectId: project.id,
      audioPath: "music/piano-quality.wav",
      compositionManifestPath: "music/piano-quality.json",
      useCase: "solo piano sketch",
      renderReportPath: "music/claimed-preview-render.json",
      renderTier: "preview",
      checkLoop: false,
      outputPath: "music/claimed-preview-qa.json"
    }, ctx);
    assert.equal(spoofedQaResult.ok, true);
    const spoofedQa = spoofedQaResult.structuredContent as { noiseFloorReport: { renderTier: string; renderTierSource: string; gated: boolean } };
    assert.equal(spoofedQa.noiseFloorReport.renderTierSource, "render_report");
    assert.equal(spoofedQa.noiseFloorReport.renderTier, "production_candidate");
    assert.equal(spoofedQa.noiseFloorReport.gated, false);

    const roboticComposition = {
      ...composition,
      performance: undefined,
      musicalityReport: undefined,
      tracks: Object.fromEntries(Object.entries(composition.tracks).map(([track, notes]) => [
        track,
        notes.map((note, index) => ({
          ...note,
          startBeat: Math.round(note.startBeat * 4) / 4,
          velocity: 64 + (index % 2)
        }))
      ]))
    };
    await writeProjectFile(ctx.projectRoot, project.id, "music/robotic-quality.json", `${JSON.stringify(roboticComposition, null, 2)}\n`);
    const roboticRenderResult = await render!.handler({ acknowledgePreviewOnly: true,
      projectId: project.id,
      compositionManifestPath: "music/robotic-quality.json",
      sampleRate: 16000,
      instrumentMap: { piano: "warm_acoustic_piano" },
      outputAudioPath: "music/robotic-quality.wav",
      outputReportPath: "music/robotic-quality-render.json"
    }, ctx);
    assert.equal(roboticRenderResult.ok, false);
    const roboticQaResult = await inspect!.handler({
      projectId: project.id,
      audioPath: "music/robotic-quality.wav",
      compositionManifestPath: "music/robotic-quality.json",
      useCase: "solo piano sketch",
      checkLoop: false,
      outputPath: "music/robotic-quality-qa.json"
    }, ctx);
    assert.equal(roboticQaResult.ok, false);
    const roboticQa = roboticQaResult.structuredContent as {
      productionSafe: boolean;
      blockingReasons: string[];
      musicalityReport: { hasHumanizedPerformance: boolean; mechanicalScore: number };
      findings: Array<{ severity: string; message: string }>;
    };
    assert.equal(roboticQa.productionSafe, false);
    assert.equal(roboticQa.musicalityReport.hasHumanizedPerformance, false);
    assert.ok(roboticQa.musicalityReport.mechanicalScore >= 0);
    assert.ok(roboticQa.blockingReasons.some((reason) => reason.includes("Robotic music output is banned")));
    assert.ok(roboticQa.findings.some((finding) => finding.severity === "high" && finding.message.includes("Robotic music output is banned")));

    const { result: shortComposeResult, composition: shortComposition } = await composeTestCue(ctx, {
      projectId: project.id,
      title: "Short Non Loop",
      style: "smooth_piano",
      tempo: 72,
      durationSeconds: 5,
      instruments: ["piano"],
      loopable: false,
      outputManifestPath: "music/short-form.json",
      outputMidiPath: "music/short-form.mid"
    }, ctx);
    assert.equal(shortComposeResult.ok, true);
    const shortPlan = shortComposition as unknown as {
      durationSeconds: number;
      tempo: number;
      compositionPlan: { form: Array<{ name: string; bars: number }> };
    };
    // The plan's form still has to add up to the bars implied by tempo and duration.
    const expectedBars = Math.max(4, Math.round(Math.round(shortPlan.durationSeconds / 60 * shortPlan.tempo) / 4));
    assert.equal(shortPlan.compositionPlan.form.reduce((sum, section) => sum + section.bars, 0), expectedBars);
    // compose_edit_midi replaces the plan's sections with the caller's section list, so the old
    // "sections sum to the same bars" invariant is now a section-map/duration coherence check.
    const shortSections = (shortComposeResult.structuredContent as { sectionMap: Array<{ startBeat: number; endBeat: number }> }).sectionMap;
    assert.ok(shortSections.length > 0);
    assert.equal(shortSections[0]!.startBeat, 0);
    assert.ok(shortSections.every((section, index) => index === 0 || section.startBeat === shortSections[index - 1]!.endBeat), "section map is contiguous");
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
    const render = getToolModule("render_midi_to_audio");
    const extend = getToolModule("extend_music_arrangement");
    const session = getToolModule("assemble_music_session");
    const originalSession = getToolModule("assemble_original_music_session");
    const normalize = getToolModule("normalize_music_loudness");
    const productionPlan = getToolModule("create_production_music_render_plan");
    const master = getToolModule("apply_music_mix_master_chain");
    const productionReview = getToolModule("review_music_production_export");
    const exportProject = getToolModule("export_music_project");
    for (const [name, tool] of Object.entries({ variations, publishDemo, render, extend, session, originalSession, normalize, productionPlan, master, productionReview, exportProject })) assert.ok(tool, `${name} registered`);

    const variationsResult = await variations!.handler({
      projectId: project.id,
      brief: "warm cafe jazz with piano, upright bass, brushes",
      styles: ["cafe_jazz", "bossa_nova", "lo_fi"],
      durationSeconds: 12,
      renderAudio: false
    }, ctx);
    assert.equal(variationsResult.ok, true);
    const variationsPayload = variationsResult.structuredContent as { productionReady: boolean; variations: Array<{ id: string; manifestPath: string; midiPath: string; audioPath?: string; label: string; qualityTier: string; productionReady: boolean }> };
    assert.equal(variationsPayload.productionReady, false);
    assert.equal(variationsPayload.variations.length, 3);
    assert.equal(variationsPayload.variations[0].id, "version_A");
    assert.equal(variationsPayload.variations[0].audioPath, undefined);
    assert.equal(variationsPayload.variations[0].qualityTier, "requires_production_render");

    const demoResult = await publishDemo!.handler({
      projectId: project.id,
      variationsManifestPath: "music/production-variations.json",
      title: "Cafe Music Audition",
      publish: true
    }, ctx);
    assert.equal(demoResult.ok, false);
    const demoPayload = demoResult.structuredContent as { productionReady: boolean; blockingReasons: string[]; variations: unknown[] };
    assert.equal(demoPayload.productionReady, false);
    assert.ok(demoPayload.blockingReasons.some((reason) => reason.includes("production_candidate")));
    assert.equal(demoPayload.variations.length, 3);

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

    const scratchRender = await render!.handler({ acknowledgePreviewOnly: true,
      projectId: project.id,
      compositionManifestPath: variationsPayload.variations[0].manifestPath,
      outputAudioPath: "music/production-scratch.wav",
      outputReportPath: "music/production-scratch-render.json",
      sampleRate: 12000
    }, ctx);
    assert.equal(scratchRender.ok, false);
    const scratchPayload = scratchRender.structuredContent as { fullMixPath: string; qualityTier: string; productionReady: boolean };
    assert.equal(scratchPayload.qualityTier, "preview_only");
    assert.equal(scratchPayload.productionReady, false);

    const normalizeResult = await normalize!.handler({
      projectId: project.id,
      audioPath: scratchPayload.fullMixPath,
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
      audioPath: scratchPayload.fullMixPath,
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
      audioPath: scratchPayload.fullMixPath,
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

test("free production render pipeline creates WAV, MP3, stems, licenses, and truthful UI", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-production-pipeline-"));
  const oldPath = process.env.PATH;
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Production pipeline", createdByClientId: "producer" });
	    const packManager = getToolModule("manage_jazz_instrument_packs");
	    const environmentCheck = getToolModule("check_music_render_environment");
	    const productionRender = getToolModule("render_production_music");
	    const exportProject = getToolModule("export_music_project");
	    assert.ok(packManager);
	    assert.ok(environmentCheck);
	    assert.ok(productionRender);
	    assert.ok(exportProject);

    process.env.PATH = `${await installFakeFluidSynth(root)}:${await installFakeFfmpeg(root)}:${oldPath}`;
    const emptyEnvironment = await environmentCheck!.handler({ projectId: project.id, includeLocalMusicPacks: false }, ctx);
    assert.equal(emptyEnvironment.ok, false);
    const emptyEnvironmentPayload = emptyEnvironment.structuredContent as { productionSupport: { statusLabel: string; reasons: string[] }; tools: { fluidsynth: { ok: boolean }; ffmpeg: { ok: boolean }; sox: { ok: boolean } } };
    assert.equal(emptyEnvironmentPayload.tools.fluidsynth.ok, true);
    assert.equal(emptyEnvironmentPayload.tools.ffmpeg.ok, true);
    assert.equal(typeof emptyEnvironmentPayload.tools.sox.ok, "boolean");
    assert.equal(emptyEnvironmentPayload.productionSupport.statusLabel, "MIDI preview only. Not production audio.");
    assert.ok(emptyEnvironmentPayload.productionSupport.reasons.some((reason) => reason.includes("No ready")));

    await composeTestCue(ctx, {
      projectId: project.id,
      title: "Free Production Cue",
      style: "smooth_piano",
      tempo: 84,
      key: "C",
      durationSeconds: 18,
      instruments: ["piano", "upright_bass", "brushes", "pads"],
      outputManifestPath: "music/free-production.json",
      outputMidiPath: "music/free-production.mid"
    }, ctx);
	    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/free-piano.sf2", fakeSoundfontBytes(), "audio/soundfont");
	    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/free-bass.sf2", fakeSoundfontBytes(), "audio/soundfont");
	    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/free-brushes.sf2", fakeSoundfontBytes(), "audio/soundfont");
	    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/free-room.sf2", fakeSoundfontBytes(), "audio/soundfont");
	    await writeProjectFile(ctx.projectRoot, project.id, "instruments/LICENSE.txt", "Public domain fixture license\n");
	    await writeProjectFile(ctx.projectRoot, project.id, "instruments/README.md", "# Free piano fixture\n");
	    const packResult = await packManager!.handler({
      projectId: project.id,
      intendedUse: "client_delivery",
	      packs: [
	        {
	          packId: "free_piano_public_domain",
	          displayName: "Free Piano Public Domain",
	          instrumentRole: "realistic_piano",
	          format: "soundfont",
	          assetPaths: ["instruments/free-piano.sf2"],
	          licenseType: "public_domain",
	          source: "fixture",
	          sourceUrl: "https://example.test/free-piano",
	          licenseTextPath: "instruments/LICENSE.txt",
	          readmePath: "instruments/README.md",
	          commercialUseAllowed: true,
	          redistributionAllowed: true,
	          productionUseApproved: true,
	          qualityTier: "production_candidate"
	        },
	        {
	          packId: "free_bass_public_domain",
	          displayName: "Free Bass Public Domain",
	          instrumentRole: "upright_bass",
	          format: "soundfont",
	          assetPaths: ["instruments/free-bass.sf2"],
	          licenseType: "public_domain",
	          source: "fixture",
	          sourceUrl: "https://example.test/free-bass",
	          licenseTextPath: "instruments/LICENSE.txt",
	          readmePath: "instruments/README.md",
	          commercialUseAllowed: true,
	          redistributionAllowed: true,
	          productionUseApproved: true,
	          qualityTier: "production_candidate"
	        },
	        {
	          packId: "free_brushes_public_domain",
	          displayName: "Free Brushes Public Domain",
	          instrumentRole: "brush_drums",
	          format: "soundfont",
	          assetPaths: ["instruments/free-brushes.sf2"],
	          licenseType: "public_domain",
	          source: "fixture",
	          sourceUrl: "https://example.test/free-brushes",
	          licenseTextPath: "instruments/LICENSE.txt",
	          readmePath: "instruments/README.md",
	          commercialUseAllowed: true,
	          redistributionAllowed: true,
	          productionUseApproved: true,
	          qualityTier: "production_candidate"
	        },
	        {
	          packId: "free_room_public_domain",
	          displayName: "Free Room Public Domain",
	          instrumentRole: "room_ambience",
	          format: "soundfont",
	          assetPaths: ["instruments/free-room.sf2"],
	          licenseType: "public_domain",
	          source: "fixture",
	          sourceUrl: "https://example.test/free-room",
	          licenseTextPath: "instruments/LICENSE.txt",
	          readmePath: "instruments/README.md",
	          commercialUseAllowed: true,
	          redistributionAllowed: true,
	          productionUseApproved: true,
	          qualityTier: "production_candidate"
	        }
	      ]
	    }, ctx);
	    assert.equal(packResult.ok, true);

	    const blockedSinglePackRender = await productionRender!.handler({
	      projectId: project.id,
	      compositionManifestPath: "music/free-production.json",
	      soundfontPackId: "free_piano_public_domain",
	      sampleRate: 16000,
	      publish: false,
	      outputReportPath: "music/blocked-single-pack-production.json"
	    }, ctx);
	    assert.equal(blockedSinglePackRender.ok, false);
	    assert.ok(blockedSinglePackRender.errors.some((error) => error.includes("upright_bass") || error.includes("brush_drums") || error.includes("room_ambience")));
	    const blockedSinglePackPayload = blockedSinglePackRender.structuredContent as { productionReady: boolean; instrumentCoverage: Array<{ covered: boolean }> };
	    assert.equal(blockedSinglePackPayload.productionReady, false);
	    assert.ok(blockedSinglePackPayload.instrumentCoverage.some((entry) => !entry.covered));

	    const renderResult = await productionRender!.handler({
	      projectId: project.id,
	      compositionManifestPath: "music/free-production.json",
	      instrumentPackMap: {
	        realistic_piano: "free_piano_public_domain",
	        upright_bass: "free_bass_public_domain",
	        brush_drums: "free_brushes_public_domain",
	        room_ambience: "free_room_public_domain"
	      },
	      sampleRate: 16000,
	      publish: true
	    }, ctx);
    assert.equal(renderResult.ok, true);
    const payload = renderResult.structuredContent as {
      productionReady: boolean;
      qualityTier: string;
	      statusLabel: string;
	      productionWavPath: string;
	      masteredAudioPath: string;
	      fullMixPath: string;
	      previewMp3Path: string;
	      stemPaths: Record<string, string>;
	      midiStemPaths: Record<string, string>;
	      stemRenderers: Record<string, { role: string; packId: string }>;
	      instrumentCoverage: Array<{ covered: boolean; requiredRole: string }>;
	      soundfonts: Record<string, { packId: string; commercialUseAllowed: boolean; productionUseApproved: boolean }>;
	      licensesPath: string;
	      reportPath: string;
	      htmlPath: string;
      publishedUrl: string;
      mixMasterChain: string[];
      noSpotifyLevelClaim: boolean;
      environment: { tools: { fluidsynth: { ok: boolean }; ffmpeg: { ok: boolean }; sox: { ok: boolean } } };
    };
    assert.equal(payload.productionReady, true);
    assert.equal(payload.qualityTier, "production_candidate");
	    assert.equal(payload.statusLabel, "Rendered with free license-cleared instruments. Suitable for production use with proper attribution.");
	    assert.equal(payload.productionWavPath, "music/production.wav");
	    assert.equal(payload.masteredAudioPath, "music/production.wav");
	    assert.equal(payload.fullMixPath, "music/production.wav");
	    assert.equal(payload.previewMp3Path, "music/preview.mp3");
	    assert.equal(payload.licensesPath, "LICENSES.md");
	    assert.ok(payload.stemPaths.piano);
	    assert.ok(payload.stemPaths.bass);
	    assert.ok(payload.stemPaths.drums);
	    assert.ok(payload.stemPaths["pad-ambience"]);
	    assert.equal(payload.stemRenderers.piano.packId, "free_piano_public_domain");
	    assert.equal(payload.stemRenderers.bass.packId, "free_bass_public_domain");
	    assert.equal(payload.stemRenderers.drums.packId, "free_brushes_public_domain");
	    assert.equal(payload.stemRenderers["pad-ambience"].packId, "free_room_public_domain");
	    assert.ok(payload.instrumentCoverage.every((entry) => entry.covered));
	    assert.equal(payload.soundfonts.realistic_piano.packId, "free_piano_public_domain");
	    assert.equal(payload.soundfonts.upright_bass.packId, "free_bass_public_domain");
	    assert.equal(payload.soundfonts.brush_drums.packId, "free_brushes_public_domain");
	    assert.equal(payload.soundfonts.room_ambience.packId, "free_room_public_domain");
	    assert.ok(payload.midiStemPaths.piano);
    assert.ok(payload.mixMasterChain.includes("master_limiter"));
    assert.equal(payload.noSpotifyLevelClaim, true);
    assert.equal(payload.environment.tools.fluidsynth.ok, true);
    assert.equal(payload.environment.tools.ffmpeg.ok, true);
    assert.equal(typeof payload.environment.tools.sox.ok, "boolean");
    assert.match(payload.publishedUrl, /https:\/\/example\.test/);

    const productionWav = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, payload.productionWavPath));
    assert.equal(productionWav.subarray(0, 4).toString("ascii"), "RIFF");
    const previewMp3 = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, payload.previewMp3Path));
    assert.equal(previewMp3.subarray(0, 3).toString("ascii"), "ID3");
    const licenses = await readProjectFile(ctx.projectRoot, project.id, payload.licensesPath);
    assert.match(licenses, /# Music Rendering Licenses/);
    assert.match(licenses, /Free Piano Public Domain/);
    assert.match(licenses, /No Spotify-level mastering claim/);
    const html = await readProjectFile(ctx.projectRoot, project.id, payload.htmlPath);
    assert.match(html, /Play Preview/);
    assert.match(html, /Download WAV/);
    assert.match(html, /Download MP3/);
    assert.match(html, /Rendered with free license-cleared instruments/);
	    const report = await readProjectFile(ctx.projectRoot, project.id, payload.reportPath);
	    assert.match(report, /production.wav/);
	    assert.match(report, /preview.mp3/);

	    const exportResult = await exportProject!.handler({
	      projectId: project.id,
	      projectManifestPath: "music/free-production.json",
	      renderedAudioPaths: [payload.productionWavPath],
	      renderReportPaths: [payload.reportPath],
	      exports: ["single_track_wav", "project_manifest"],
	      publish: true,
	      outputHtmlPath: "music/production-export.html",
	      outputManifestPath: "music/production-export.json",
	      outputReadmePath: "music/production-export/README.md",
	      outputPackageReportPath: "music/production-export/package-report.json",
	      outputPlaylistPath: "music/production-export/playlist.json"
	    }, ctx);
	    assert.equal(exportResult.ok, true, JSON.stringify(exportResult.errors));
	    const exportPayload = exportResult.structuredContent as { productionGateWarnings: string[]; publishedUrl?: string; resolvedRenderReports: Array<{ productionWavPath?: string; qualityTier: string }> };
	    assert.deepEqual(exportPayload.productionGateWarnings, []);
	    assert.match(exportPayload.publishedUrl ?? "", /https:\/\/example\.test/);
	    assert.ok(exportPayload.resolvedRenderReports.some((item) => item.productionWavPath === payload.productionWavPath && item.qualityTier === "production_candidate"));

	    const blockedExport = await exportProject!.handler({
	      projectId: project.id,
	      projectManifestPath: "music/free-production.json",
	      renderedAudioPaths: ["music/missing-production.wav"],
	      renderReportPaths: [payload.reportPath],
	      exports: ["single_track_wav", "project_manifest"],
	      publish: true,
	      outputHtmlPath: "music/blocked-export.html",
	      outputManifestPath: "music/blocked-export.json",
	      outputReadmePath: "music/blocked-export/README.md",
	      outputPackageReportPath: "music/blocked-export/package-report.json",
	      outputPlaylistPath: "music/blocked-export/playlist.json"
	    }, ctx);
	    assert.equal(blockedExport.ok, false);
	    assert.equal(blockedExport.shareUrl, undefined);
	    const blockedExportPayload = blockedExport.structuredContent as { publishedUrl?: string };
	    assert.equal(blockedExportPayload.publishedUrl, undefined);
	  } finally {
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("render_production_music publishes MP3 when production WAV exceeds media asset limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-production-large-wav-"));
  const oldPath = process.env.PATH;
  const oldLargeWav = process.env.FAKE_FFMPEG_LARGE_WAV;
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Large production WAV", createdByClientId: "producer" });
    const packManager = getToolModule("manage_jazz_instrument_packs");
    const productionRender = getToolModule("render_production_music");
    assert.ok(packManager);
    assert.ok(productionRender);

    process.env.PATH = `${await installFakeFluidSynth(root)}:${await installFakeFfmpeg(root)}:${oldPath}`;
    process.env.FAKE_FFMPEG_LARGE_WAV = String(101 * 1024 * 1024);

    await composeTestCue(ctx, {
      projectId: project.id,
      title: "Long Solo Piano",
      style: "smooth_piano",
      tempo: 70,
      key: "D minor",
      durationSeconds: 600,
      instruments: ["piano"],
      outputManifestPath: "music/long-solo.json",
      outputMidiPath: "music/long-solo.mid"
    }, ctx);
    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/free-piano.sf2", fakeSoundfontBytes(), "audio/soundfont");
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/LICENSE.txt", "Public domain fixture license\n");
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/README.md", "# Free piano fixture\n");
    const packResult = await packManager!.handler({
      projectId: project.id,
      intendedUse: "client_delivery",
      packs: [{
        packId: "free_piano_public_domain",
        displayName: "Free Piano Public Domain",
        instrumentRole: "realistic_piano",
        format: "soundfont",
        assetPaths: ["instruments/free-piano.sf2"],
        licenseType: "public_domain",
        source: "fixture",
        sourceUrl: "https://example.test/free-piano",
        licenseTextPath: "instruments/LICENSE.txt",
        readmePath: "instruments/README.md",
        commercialUseAllowed: true,
        redistributionAllowed: true,
        productionUseApproved: true,
        qualityTier: "production_candidate"
      }]
    }, ctx);
    assert.equal(packResult.ok, true);

    const renderResult = await productionRender!.handler({
      projectId: project.id,
      compositionManifestPath: "music/long-solo.json",
      instrumentPackMap: { realistic_piano: "free_piano_public_domain" },
      sampleRate: 44100,
      publish: false
    }, ctx);
    assert.equal(renderResult.ok, true);
    const payload = renderResult.structuredContent as {
      productionWavPath?: string;
      previewMp3Path: string;
      deliveryFormat: string;
      largeAudioAssetSkips: Array<{ path: string; replacementPath?: string }>;
      htmlPath: string;
      licensesPath: string;
    };
    assert.equal(payload.productionWavPath, undefined);
    assert.equal(payload.previewMp3Path, "music/preview.mp3");
    assert.equal(payload.deliveryFormat, "mp3_first_large_wav_omitted");
    assert.ok(payload.largeAudioAssetSkips.some((asset) => asset.path === "music/production.wav" && asset.replacementPath === "music/preview.mp3"));
    const previewMp3 = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, payload.previewMp3Path));
    assert.equal(previewMp3.subarray(0, 3).toString("ascii"), "ID3");
    const omittedWavPath = await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/production.wav");
    await assert.rejects(readFile(omittedWavPath), /ENOENT|no such file/i);
    const html = await readProjectFile(ctx.projectRoot, project.id, payload.htmlPath);
    assert.match(html, /Download MP3/);
    assert.doesNotMatch(html, /Download WAV/);
    assert.match(html, /Large WAV assets were omitted/);
    const licenses = await readProjectFile(ctx.projectRoot, project.id, payload.licensesPath);
    assert.match(licenses, /Large WAV Assets Omitted/);
    assert.match(licenses, /music\/production\.wav/);
  } finally {
    process.env.PATH = oldPath;
    if (oldLargeWav === undefined) delete process.env.FAKE_FFMPEG_LARGE_WAV; else process.env.FAKE_FFMPEG_LARGE_WAV = oldLargeWav;
    await rm(root, { recursive: true, force: true });
  }
});

test("render_production_music does not relabel a GeneralUser fallback as requested Salamander", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-salamander-no-fallback-"));
  const oldPath = process.env.PATH;
  const oldSoundfontDir = process.env.MUSIC_SOUNDFONT_DIR;
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Salamander unavailable", createdByClientId: "producer" });
    const packManager = getToolModule("manage_jazz_instrument_packs");
    const productionRender = getToolModule("render_production_music");
    assert.ok(packManager);
    assert.ok(productionRender);

    process.env.PATH = `${await installFakeFluidSynth(root)}:${await installFakeFfmpeg(root)}:${oldPath}`;
    process.env.MUSIC_SOUNDFONT_DIR = path.join(root, "empty-soundfonts");

    await composeTestCue(ctx, {
      projectId: project.id,
      title: "Requested Salamander Cue",
      style: "smooth_piano",
      durationSeconds: 30,
      instruments: ["piano"],
      outputManifestPath: "music/requested-salamander.json",
      outputMidiPath: "music/requested-salamander.mid"
    }, ctx);
    await writeProjectAsset(ctx.projectRoot, project.id, "soundfonts/generaluser-gs/GeneralUser-GS.sf2", fakeSoundfontBytes(), "audio/soundfont");
    await writeProjectFile(ctx.projectRoot, project.id, "soundfonts/generaluser-gs/LICENSE.txt", "GeneralUser GS license fixture\n");
    await writeProjectFile(ctx.projectRoot, project.id, "soundfonts/generaluser-gs/README.md", "# GeneralUser GS fixture\n");
    await packManager!.handler({
      projectId: project.id,
      packs: [{
        packId: "generaluser_gs",
        displayName: "GeneralUser GS",
        instrumentRole: "general_midi",
        format: "soundfont",
        assetPaths: ["soundfonts/generaluser-gs/GeneralUser-GS.sf2"],
        licenseType: "generaluser_gs_2_0",
        source: "fixture",
        sourceUrl: "https://example.test/generaluser",
        licenseTextPath: "soundfonts/generaluser-gs/LICENSE.txt",
        readmePath: "soundfonts/generaluser-gs/README.md",
        commercialUseAllowed: true,
        redistributionAllowed: true,
        productionUseApproved: true,
        qualityTier: "production_candidate"
      }]
    }, ctx);

    const result = await productionRender!.handler({
      projectId: project.id,
      compositionManifestPath: "music/requested-salamander.json",
      soundfontPackId: "salamander_grand",
      publish: false
    }, ctx);
    assert.equal(result.ok, false);
    assert.equal(result.previewUrl, undefined);
    assert.ok(result.errors.some((error) => /Salamander Grand Piano/.test(error) && /autoRegistered=true|install_free_soundfont_pack/.test(error)));
    const payload = result.structuredContent as {
      productionReady: boolean;
      requestedPackAvailability: Array<{
        requestedPackId: string;
        manualInstallRequired: boolean;
        requiredFiles: string[];
        fallbackPolicy: string;
      }>;
      instrumentCoverage: Array<{ selectedPackId?: string; covered: boolean }>;
      previewMp3Path?: string;
    };
    assert.equal(payload.productionReady, false);
    assert.equal(payload.previewMp3Path, undefined);
    assert.ok(payload.instrumentCoverage.every((entry) => !entry.covered || entry.selectedPackId !== "generaluser_gs"));
    const availability = payload.requestedPackAvailability.find((entry) => entry.requestedPackId === "salamander_grand");
    assert.ok(availability);
    assert.equal(availability.manualInstallRequired, true);
    assert.deepEqual(availability.requiredFiles, ["Salamander.sf2", "LICENSE.txt"]);
    assert.match(availability.fallbackPolicy, /Do not label fallback renders as Salamander Grand Piano/);
  } finally {
    process.env.PATH = oldPath;
    if (oldSoundfontDir === undefined) delete process.env.MUSIC_SOUNDFONT_DIR; else process.env.MUSIC_SOUNDFONT_DIR = oldSoundfontDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("export_music_project creates a music package with README, playlist, checks, and license warnings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-export-package-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Cafe export", createdByClientId: "producer" });
    const render = getToolModule("render_midi_to_audio");
    const exportProject = getToolModule("export_music_project");
    assert.ok(render);
    assert.ok(exportProject);

    await composeTestCue(ctx, {
      projectId: project.id,
      title: "Cafe Jazz Pack",
      style: "cafe_jazz",
      tempo: 92,
      key: "F",
      durationSeconds: 30,
      outputManifestPath: "music/project.manifest.json",
      outputMidiPath: "music/final.mid"
    }, ctx);
    await render!.handler({ acknowledgePreviewOnly: true,
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
      productionGateWarnings: string[];
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
    assert.ok(payload.productionGateWarnings.some((warning) => warning.includes("preview_only")));
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
    assert.match(html, /<h2>Listen<\/h2>/);
    assert.match(html, /<audio controls preload="metadata" src="music\/final\.wav"><\/audio>/);
    const report = await readProjectFile(ctx.projectRoot, project.id, payload.packageReportPath);
    assert.match(report, /missing-drums/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export_music_project blocks on custom audio quality report paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-export-custom-qa-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Custom QA gate", createdByClientId: "producer" });
    const exportProject = getToolModule("export_music_project");
    assert.ok(exportProject);

    await writeProjectFile(ctx.projectRoot, project.id, "music/custom-audio-qa.json", `${JSON.stringify({
      productionSafe: false,
      blockingReasons: ["Loop seam click remains audible."],
      findings: [{ severity: "high", message: "True peak exceeds delivery ceiling." }]
    }, null, 2)}\n`);

    const result = await exportProject!.handler({
      projectId: project.id,
      packageName: "custom-qa-package",
      qualityReportPaths: ["music/custom-audio-qa.json"],
      publish: false
    }, ctx);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("productionSafe=false")));
    assert.ok(result.errors.some((error) => error.includes("Loop seam click remains audible")));
    assert.ok(result.errors.some((error) => error.includes("True peak exceeds delivery ceiling")));
    const payload = result.structuredContent as {
      qualityReportPaths: string[];
      resolvedQualityReports: Array<{ reportPath: string; productionSafe: boolean | "unknown"; blockingReasonCount: number; highFindingCount: number }>;
      packageReportPath: string;
    };
    assert.deepEqual(payload.qualityReportPaths, ["music/custom-audio-qa.json"]);
    assert.deepEqual(payload.resolvedQualityReports, [{
      reportPath: "music/custom-audio-qa.json",
      productionSafe: false,
      blockingReasonCount: 1,
      highFindingCount: 1
    }]);
    const packageReport = await readProjectFile(ctx.projectRoot, project.id, payload.packageReportPath);
    assert.match(packageReport, /custom-audio-qa\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export_music_project fails when requested encoded formats are missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-export-format-gate-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Format gate", createdByClientId: "producer" });
    const render = getToolModule("render_midi_to_audio");
    const exportProject = getToolModule("export_music_project");
    assert.ok(render);
    assert.ok(exportProject);

    await composeTestCue(ctx, {
      projectId: project.id,
      title: "Format Gate Cue",
      style: "cafe_jazz",
      durationSeconds: 12,
      outputManifestPath: "music/format-gate.json",
      outputMidiPath: "music/format-gate.mid"
    }, ctx);
    await render!.handler({ acknowledgePreviewOnly: true,
      projectId: project.id,
      compositionManifestPath: "music/format-gate.json",
      outputAudioPath: "music/format-gate.wav",
      sampleRate: 12000
    }, ctx);
    const encodedOnlyResult = await render!.handler({ acknowledgePreviewOnly: true,
      projectId: project.id,
      compositionManifestPath: "music/format-gate.json",
      outputFormats: ["mp3"],
      outputAudioPath: "music/encoded-only.mp3",
      outputReportPath: "music/encoded-only-report.json",
      sampleRate: 12000
    }, ctx);
    assert.equal(encodedOnlyResult.ok, false);
    const encodedOnlyPayload = encodedOnlyResult.structuredContent as { fullMixPath: string; renderReport: { requestedFormats: string[]; renderedFormats: string[] } };
    assert.equal(encodedOnlyPayload.fullMixPath, "music/encoded-only.wav");
    assert.deepEqual(encodedOnlyPayload.renderReport.requestedFormats, ["mp3"]);
    assert.deepEqual(encodedOnlyPayload.renderReport.renderedFormats, ["wav"]);
    const encodedOnlyWav = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/encoded-only.wav"));
    assert.equal(encodedOnlyWav.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(encodedOnlyWav.subarray(8, 12).toString("ascii"), "WAVE");

    const result = await exportProject!.handler({
      projectId: project.id,
      projectManifestPath: "music/format-gate.json",
      exports: ["single_track_wav", "single_track_mp3", "midi", "project_manifest"],
      renderedAudioPaths: ["music/format-gate.wav"],
      midiPaths: ["music/format-gate.mid"],
      publish: false
    }, ctx);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("MP3 export was requested")));
    const payload = result.structuredContent as { missingFiles: string[]; licenseWarnings: string[]; unsupportedFormats: string[]; productionGateWarnings: string[] };
    assert.deepEqual(payload.missingFiles, []);
    assert.deepEqual(payload.licenseWarnings, []);
    assert.ok(payload.unsupportedFormats.some((warning) => warning.includes("MP3")));
    assert.ok(payload.productionGateWarnings.some((warning) => warning.includes("preview_only")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("music WAV processing tools reject invalid WAV inputs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-invalid-wav-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Invalid WAV", createdByClientId: "producer" });
    const normalize = getToolModule("normalize_music_loudness");
    const master = getToolModule("apply_music_mix_master_chain");
    assert.ok(normalize);
    assert.ok(master);

    await writeProjectAsset(ctx.projectRoot, project.id, "music/bad.wav", Buffer.from("not-a-real-wav", "utf8"), "audio/wav");

    await assert.rejects(
      normalize!.handler({
        projectId: project.id,
        audioPath: "music/bad.wav",
        outputAudioPath: "music/bad-normalized.wav"
      }, ctx),
      /must be a readable PCM WAV file/
    );
    await assert.rejects(
      master!.handler({
        projectId: project.id,
        audioPath: "music/bad.wav",
        outputAudioPath: "music/bad-master.wav"
      }, ctx),
      /must be a readable PCM WAV file/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render_production_music renders a dedicated cello stem for a cello + piano duet", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-cello-stem-"));
  const oldPath = process.env.PATH;
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Cello stem", createdByClientId: "producer" });
    const importer = getToolModule("import_musicxml_score");
    const packManager = getToolModule("manage_jazz_instrument_packs");
    const productionRender = getToolModule("render_production_music");
    assert.ok(importer && packManager && productionRender);

    process.env.PATH = `${await installFakeFluidSynth(root)}:${await installFakeFfmpeg(root)}:${oldPath}`;
    await importer!.handler({ projectId: project.id, musicXmlString: celloPianoDuetMusicXml, outputManifestPath: "music/duet-prod.json", outputMidiPath: "music/duet-prod.mid" }, ctx);

    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/piano.sf2", fakeSoundfontBytes(), "audio/soundfont");
    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/cello.sf2", fakeSoundfontBytes(), "audio/soundfont");
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/LICENSE.txt", "Public domain fixture license\n");
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/README.md", "# Fixture\n");
    const mkPack = (packId: string, instrumentRole: string, asset: string) => ({
      packId, displayName: packId, instrumentRole, format: "soundfont" as const, assetPaths: [asset],
      licenseType: "public_domain" as const, source: "fixture", sourceUrl: `https://example.test/${packId}`,
      licenseTextPath: "instruments/LICENSE.txt", readmePath: "instruments/README.md",
      commercialUseAllowed: true, redistributionAllowed: true, productionUseApproved: true, qualityTier: "production_candidate" as const
    });
    const packResult = await packManager!.handler({
      projectId: project.id,
      intendedUse: "client_delivery",
      packs: [mkPack("piano_pd", "realistic_piano", "instruments/piano.sf2"), mkPack("cello_pd", "cello", "instruments/cello.sf2")]
    }, ctx);
    assert.equal(packResult.ok, true);

    const renderResult = await productionRender!.handler({
      projectId: project.id,
      compositionManifestPath: "music/duet-prod.json",
      instrumentPackMap: { realistic_piano: "piano_pd", cello: "cello_pd" },
      sampleRate: 16000,
      publish: false
    }, ctx);
    assert.equal(renderResult.ok, true);
    const payload = renderResult.structuredContent as {
      stemPaths: Record<string, string>;
      stemRenderers: Record<string, { role: string }>;
      stemValidations: Record<string, { ok: boolean; rms: number }>;
      environment: { instrumentDiscovery?: unknown };
    };
    // #5: cello is its own role/stem, no longer folded into pad/ambience.
    assert.ok(payload.stemPaths.cello, "cello must render as its own stem (cello.wav)");
    assert.ok(payload.stemPaths.piano, "piano must render as its own stem");
    assert.equal(payload.stemRenderers.cello.role, "cello");
    // #4: each stem is validated; both are audible.
    assert.equal(payload.stemValidations.cello.ok, true);
    assert.equal(payload.stemValidations.piano.ok, true);
    // Registered-pack resolution is the authoritative production gate. Rendering must not
    // re-discover and fully read every unrelated project SoundFont during binary preflight.
    assert.equal(payload.environment.instrumentDiscovery, undefined);

    // #4 fail-closed branch: if the renderer produces a silent stem, the publish path must refuse.
    process.env.FAKE_FLUIDSYNTH_SILENT = "1";
    try {
      await assert.rejects(
        () => productionRender!.handler({
          projectId: project.id,
          compositionManifestPath: "music/duet-prod.json",
          instrumentPackMap: { realistic_piano: "piano_pd", cello: "cello_pd" },
          sampleRate: 16000,
          publish: false,
          outputReportPath: "music/silent-stem-report.json"
        }, ctx),
        /silent|Stem validation failed/i
      );
    } finally {
      delete process.env.FAKE_FLUIDSYNTH_SILENT;
    }
  } finally {
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("render_midi_with_soundfont blocks missing renderer and unsafe packs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-soundfont-gate-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "SoundFont gate", createdByClientId: "producer" });
    const packManager = getToolModule("manage_jazz_instrument_packs");
    const soundfontRender = getToolModule("render_midi_with_soundfont");
    assert.ok(packManager);
    assert.ok(soundfontRender);

	    const { composition: composedManifest } = await composeTestCue(ctx, {
	      projectId: project.id,
	      title: "SoundFont Gate Cue",
	      style: "cafe_jazz",
	      durationSeconds: 8,
	      outputManifestPath: "music/soundfont-gate.json",
	      outputMidiPath: "music/soundfont-gate.mid"
	    }, ctx);
	    const gateComposition = composedManifest as unknown as Record<string, unknown> & { tracks: Record<string, unknown[]> };
	    await writeProjectFile(ctx.projectRoot, project.id, "music/soundfont-gate-piano-only.json", `${JSON.stringify({ ...gateComposition, instruments: ["piano"], tracks: { piano: gateComposition.tracks.piano ?? [] } }, null, 2)}\n`);
    const sf2 = fakeSoundfontBytes();
    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/unsafe.sf2", sf2, "audio/soundfont");
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/LICENSE.txt", "Public domain fixture\n");
    await writeProjectFile(ctx.projectRoot, project.id, "instruments/README.md", "# Ready PD fixture\n");
    await packManager!.handler({
      projectId: project.id,
      packs: [{
        packId: "unsafe_unknown",
        displayName: "Unsafe Unknown",
        instrumentRole: "realistic_piano",
        format: "soundfont",
        assetPaths: ["instruments/unsafe.sf2"],
        licenseType: "unknown",
        source: "fixture",
        commercialUseAllowed: true,
        redistributionAllowed: true
      }]
    }, ctx);

    const unsafeOldPath = process.env.PATH;
    process.env.PATH = `${await installFakeFluidSynth(root)}:${unsafeOldPath}`;
    try {
      const unsafeResult = await soundfontRender!.handler({
        projectId: project.id,
        compositionManifestPath: "music/soundfont-gate.json",
        soundfontPackId: "unsafe_unknown"
      }, ctx);
      assert.equal(unsafeResult.ok, false);
      assert.ok(unsafeResult.errors.some((error) => error.includes("not ready") || error.includes("unresolved risk")));
      const unsafePayload = unsafeResult.structuredContent as { qualityTier: string; productionReady: boolean; blockingReasons: string[] };
      assert.equal(unsafePayload.qualityTier, "preview_only");
      assert.equal(unsafePayload.productionReady, false);
      assert.ok(unsafePayload.blockingReasons.length > 0);
    } finally {
      process.env.PATH = unsafeOldPath;
    }

    await packManager!.handler({
      projectId: project.id,
      packs: [{
        packId: "ready_pd",
        displayName: "Ready PD",
        instrumentRole: "realistic_piano",
        format: "soundfont",
        assetPaths: ["instruments/unsafe.sf2"],
        licenseType: "public_domain",
        source: "fixture",
        sourceUrl: "https://example.test/ready-pd",
        licenseTextPath: "instruments/LICENSE.txt",
        readmePath: "instruments/README.md",
        commercialUseAllowed: true,
        redistributionAllowed: true,
        productionUseApproved: true,
        qualityTier: "production_candidate"
      }]
    }, ctx);
    await writeProjectAsset(ctx.projectRoot, project.id, "instruments/mismatch.sfz", Buffer.from("<region> sample=piano-C4.wav key=60\n", "utf8"), "text/plain");
    await packManager!.handler({
      projectId: project.id,
      packs: [
        {
          packId: "ready_pd",
          displayName: "Ready PD",
          instrumentRole: "realistic_piano",
          format: "soundfont",
          assetPaths: ["instruments/unsafe.sf2"],
          licenseType: "public_domain",
          source: "fixture",
          sourceUrl: "https://example.test/ready-pd",
          licenseTextPath: "instruments/LICENSE.txt",
          readmePath: "instruments/README.md",
          commercialUseAllowed: true,
          redistributionAllowed: true,
          productionUseApproved: true,
          qualityTier: "production_candidate"
        },
        {
          packId: "mixed_soundfont",
          displayName: "Mixed SoundFont",
          instrumentRole: "realistic_piano",
          format: "soundfont",
          assetPaths: ["instruments/unsafe.sf2", "instruments/mismatch.sfz"],
          licenseType: "public_domain",
          source: "fixture",
          sourceUrl: "https://example.test/mixed",
          licenseTextPath: "instruments/LICENSE.txt",
          readmePath: "instruments/README.md",
          commercialUseAllowed: true,
          redistributionAllowed: true,
          productionUseApproved: true,
          qualityTier: "production_candidate"
        }
      ]
    }, ctx);
    const readyOldPathForInputValidation = process.env.PATH;
    process.env.PATH = `${await installFakeFluidSynth(root)}:${readyOldPathForInputValidation}`;
    try {
      const mismatchedPathResult = await soundfontRender!.handler({
        projectId: project.id,
        compositionManifestPath: "music/soundfont-gate.json",
        soundfontPackId: "mixed_soundfont",
        soundfontPath: "instruments/mismatch.sfz",
        outputReportPath: "music/mismatched-renderer-report.json"
      }, ctx);
      assert.equal(mismatchedPathResult.ok, false);
      assert.ok(mismatchedPathResult.errors.some((error) => error.includes("does not match soundfont pack")));

      const channelMapMidiOnly = await soundfontRender!.handler({
        projectId: project.id,
        midiPath: "music/soundfont-gate.mid",
        soundfontPackId: "ready_pd",
        channelMap: { piano: 1 },
        outputReportPath: "music/midi-only-channel-map-report.json"
      }, ctx);
      assert.equal(channelMapMidiOnly.ok, false);
      assert.ok(channelMapMidiOnly.errors.some((error) => error.includes("channelMap requires compositionManifestPath")));
      const channelMapPayload = channelMapMidiOnly.structuredContent as { channelMapApplied: boolean; qualityTier: string; productionReady: boolean };
      assert.equal(channelMapPayload.channelMapApplied, false);
      assert.equal(channelMapPayload.qualityTier, "preview_only");
      assert.equal(channelMapPayload.productionReady, false);

      const stemsMidiOnly = await soundfontRender!.handler({
        projectId: project.id,
        midiPath: "music/soundfont-gate.mid",
        soundfontPackId: "ready_pd",
        stems: true,
        outputReportPath: "music/midi-only-stems-report.json"
      }, ctx);
      assert.equal(stemsMidiOnly.ok, false);
      assert.ok(stemsMidiOnly.errors.some((error) => error.includes("stems require compositionManifestPath")));
      const stemsPayload = stemsMidiOnly.structuredContent as { stemCount: number; stemPaths: Record<string, string>; qualityTier: string; productionReady: boolean };
      assert.equal(stemsPayload.stemCount, 0);
      assert.deepEqual(stemsPayload.stemPaths, {});
      assert.equal(stemsPayload.qualityTier, "preview_only");
      assert.equal(stemsPayload.productionReady, false);

      const mixedSinglePackResult = await soundfontRender!.handler({
        projectId: project.id,
        compositionManifestPath: "music/soundfont-gate.json",
        soundfontPackId: "ready_pd",
        outputReportPath: "music/mixed-single-pack-report.json"
      }, ctx);
      assert.equal(mixedSinglePackResult.ok, false);
      assert.ok(mixedSinglePackResult.errors.some((error) => error.includes("requires upright_bass") || error.includes("requires brush_drums")));
      const mixedSinglePackPayload = mixedSinglePackResult.structuredContent as { qualityTier: string; productionReady: boolean; instrumentCoverage: Array<{ covered: boolean }> };
      assert.equal(mixedSinglePackPayload.qualityTier, "preview_only");
      assert.equal(mixedSinglePackPayload.productionReady, false);
      assert.ok(mixedSinglePackPayload.instrumentCoverage.some((entry) => !entry.covered));

      process.env.FAKE_FLUIDSYNTH_INVALID_RIFF = "1";
      const invalidRendererResult = await soundfontRender!.handler({
        projectId: project.id,
        compositionManifestPath: "music/soundfont-gate-piano-only.json",
        soundfontPackId: "ready_pd",
        outputReportPath: "music/invalid-renderer-report.json"
      }, ctx);
      delete process.env.FAKE_FLUIDSYNTH_INVALID_RIFF;
      assert.equal(invalidRendererResult.ok, false);
      assert.ok(invalidRendererResult.errors.some((error) => error.includes("must be a readable PCM WAV file")));
      const invalidRendererPayload = invalidRendererResult.structuredContent as { qualityTier: string; productionReady: boolean; fullMixPath?: string };
      assert.equal(invalidRendererPayload.qualityTier, "preview_only");
      assert.equal(invalidRendererPayload.productionReady, false);
      assert.equal(invalidRendererPayload.fullMixPath, undefined);
    } finally {
      delete process.env.FAKE_FLUIDSYNTH_INVALID_RIFF;
      process.env.PATH = readyOldPathForInputValidation;
    }
    const emptyBin = path.join(root, "empty-bin");
    await mkdir(emptyBin, { recursive: true });
    const oldPath = process.env.PATH;
    process.env.PATH = `${emptyBin}:/usr/bin:/bin`;
    try {
      const missingRendererResult = await soundfontRender!.handler({
        projectId: project.id,
        compositionManifestPath: "music/soundfont-gate-piano-only.json",
        soundfontPackId: "ready_pd"
      }, ctx);
      assert.equal(missingRendererResult.ok, false);
      assert.ok(missingRendererResult.errors.some((error) => /fluidsynth.*not available/i.test(error)));
    } finally {
      process.env.PATH = oldPath;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("music audition publisher accepts direct version metadata and returns continuation fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-audition-direct-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Direct audition", createdByClientId: "producer" });
    const render = getToolModule("render_midi_to_audio");
    const publishDemo = getToolModule("publish_music_audition_demo");
    assert.ok(render);
    assert.ok(publishDemo);

    await composeTestCue(ctx, {
      projectId: project.id,
      title: "Direct A",
      style: "cafe_jazz",
      durationSeconds: 10,
      outputManifestPath: "music/direct-a.json",
      outputMidiPath: "music/direct-a.mid"
    }, ctx);
    await render!.handler({ acknowledgePreviewOnly: true,
      projectId: project.id,
      compositionManifestPath: "music/direct-a.json",
      outputAudioPath: "music/direct-a.wav",
      sampleRate: 12000
    }, ctx);
    await composeTestCue(ctx, {
      projectId: project.id,
      title: "Direct B",
      style: "bossa_nova",
      durationSeconds: 10,
      outputManifestPath: "music/direct-b.json",
      outputMidiPath: "music/direct-b.mid"
    }, ctx);
    await render!.handler({ acknowledgePreviewOnly: true,
      projectId: project.id,
      compositionManifestPath: "music/direct-b.json",
      outputAudioPath: "music/direct-b.wav",
      sampleRate: 12000
    }, ctx);

    const result = await publishDemo!.handler({
      projectId: project.id,
      projectTitle: "Cafe Jazz Auditions",
      versions: [
        { id: "A", audioPath: "music/direct-a.wav", midiPath: "music/direct-a.mid", manifestPath: "music/direct-a.json", title: "Warm Piano Trio", bpm: 82, key: "F major", durationSec: 75, instruments: ["piano", "upright bass", "brushes"], moodTags: ["warm", "relaxed"], styleNotes: ["soft trio"], generatedPrompt: "warm cafe jazz", renderer: "fluidsynth", qualityTier: "production_candidate", productionReady: true, soundfontName: "verified commercial-safe piano", licenseStatus: "commercial_safe" },
        { id: "B", audioPath: "music/direct-b.wav", midiPath: "music/direct-b.mid", manifestPath: "music/direct-b.json", title: "Bossa Lounge", bpm: 92, key: "D minor", durationSec: 80, instruments: ["piano", "bass", "brushes"], moodTags: ["bossa", "smooth"], styleNotes: ["lighter groove"], generatedPrompt: "bossa cafe lounge", renderer: "sfizz", qualityTier: "production_candidate", productionReady: true, soundfontName: "verified commercial-safe SFZ", licenseStatus: "commercial_safe" }
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
    const extendOriginal = getToolModule("extend_original_music_arrangement");
    assert.ok(extendOriginal);

    await composeTestCue(ctx, {
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

test("process_music_revision_feedback treats no-cello piano-only feedback as a hard exclusion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-revision-no-cello-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "No cello revision", createdByClientId: "producer" });
    const processFeedback = getToolModule("process_music_revision_feedback");
    assert.ok(processFeedback);

    const result = await processFeedback!.handler({
      projectId: project.id,
      selectedVersionId: "solo-piano",
      sourceManifestPath: "music/solo-piano.json",
      feedback: [{ comment: "Piano only is preferred. No cello." }]
    }, ctx);

    assert.equal(result.ok, true);
    const payload = result.structuredContent as {
      midiEditOperations: Array<{ type: string; track?: string; value?: string | number | boolean }>;
    };
    assert.ok(payload.midiEditOperations.some((operation) => operation.type === "mute_track" && operation.track === "cello" && operation.value === true));
    assert.equal(payload.midiEditOperations.some((operation) => operation.type === "create_track" && operation.track === "cello"), false);
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
    "create_music_production",
    "assemble_original_music_session",
    "assemble_music_session",
    "normalize_music_loudness",
    "create_production_music_render_plan",
    "apply_music_mix_master_chain",
    "review_music_production_export",
    "export_music_project",
    "process_music_revision_feedback",
    "import_musicxml_score",
    "validate_music_ensemble",
    "validate_music_constraints",
    "validate_music_development",
    "edit_midi",
    "render_midi_to_audio",
    "check_music_render_environment",
    "render_production_music",
    "install_free_soundfont_pack",
    "discover_soundfont_packs",
    "render_midi_with_soundfont",
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

// issue_0146: read-side registry discovery. manage_jazz_instrument_packs' outputPath is a free
// parameter; the render read path used to be a hardcoded constant. pickJazzPackRegistryCandidatePaths
// is the pure bridge — default first, then any other *instrument-packs*.json the agent wrote.
test("pickJazzPackRegistryCandidatePaths: default first, finds non-default name, excludes license", () => {
  const out = pickJazzPackRegistryCandidatePaths([
    "music/instrument-packs.json",
    "music/jazz-instrument-license-manifest.json",
    "music/jazz-instrument-packs.json",
    "music/cue.json"
  ]);
  assert.equal(out[0], "music/jazz-instrument-packs.json", "default path is always tried first");
  assert.ok(out.includes("music/instrument-packs.json"), "non-default registry name is discovered");
  assert.ok(!out.some((p) => /license/i.test(p)), "license manifests are never registry candidates");
  assert.ok(!out.includes("music/cue.json"), "unrelated json is not a candidate");
  // Default is always present even when the listing is empty (it may exist without being listed).
  assert.deepEqual(pickJazzPackRegistryCandidatePaths([]), ["music/jazz-instrument-packs.json"]);
  // No duplicates when the default is also in the listing.
  assert.equal(out.filter((p) => p === "music/jazz-instrument-packs.json").length, 1);
});

// issue_0146 end-to-end: a registry written to a NON-default filename must still be read by the
// render tool. Before the fix this rendered as a misleading "No registered ready instrument pack".
test("issue_0146: render_midi_with_soundfont reads a registry written under a non-default name", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-registry-discovery-"));
  const oldPath = process.env.PATH;
  let restoreFetch = () => {};
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Registry discovery", createdByClientId: "producer" });
    const installer = getToolModule("install_free_soundfont_pack");
    const render = getToolModule("render_midi_with_soundfont");
    assert.ok(installer && render);

    restoreFetch = installMockFetch({ "GeneralUser-GS.sf2": fakeSoundfontBytes(), "LICENSE.txt": "GeneralUser GS license fixture\n", "README.md": "# GeneralUser GS fixture\n" });
    const install = await installer!.handler({ projectId: project.id, packId: "generaluser_gs" }, ctx);
    assert.equal(install.ok, true);

    // Relocate the auto-registered registry to a non-default name and delete the default, simulating
    // an agent that called manage_jazz_instrument_packs with a custom outputPath (the real 0146 case).
    const registryJson = await readProjectFile(ctx.projectRoot, project.id, "music/jazz-instrument-packs.json", 1024 * 1024);
    await writeProjectFile(ctx.projectRoot, project.id, "music/instrument-packs.json", registryJson);
    await rm(await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/jazz-instrument-packs.json"), { force: true });

    await composeTestCue(ctx, {
      projectId: project.id,
      instruments: ["piano", "cello"],
      durationSeconds: 12,
      outputManifestPath: "music/cue.json",
      outputMidiPath: "music/cue.mid"
    }, ctx);

    process.env.PATH = `${await installFakeFluidSynth(root)}:${await installFakeFfmpeg(root)}:${oldPath}`;
    const result = await render!.handler({
      projectId: project.id,
      compositionManifestPath: "music/cue.json",
      soundfontPackId: "generaluser_gs",
      sampleRate: 16000,
      outputReportPath: "music/render-report.json"
    }, ctx);

    const errorText = JSON.stringify(result.errors ?? []);
    assert.ok(!/No registered ready instrument pack|No instrument-pack registry/i.test(errorText), `registry must resolve from the non-default path, got: ${errorText}`);
    assert.equal(result.ok, true, `render should succeed once the non-default registry is read: ${errorText}`);
    // Isolate the read-path fix from self-heal: if resolution had relied on re-discovering and
    // re-registering the sf2, it would have rewritten the default registry path. It must stay absent,
    // proving the render read the agent's non-default registry file directly.
    await assert.rejects(
      readProjectFile(ctx.projectRoot, project.id, "music/jazz-instrument-packs.json", 1024 * 1024),
      "default registry must not be recreated — resolution came from reading the non-default path"
    );
  } finally {
    process.env.PATH = oldPath;
    restoreFetch();
    await rm(root, { recursive: true, force: true });
  }
});

test("issue_0141: registered assets SoundFont renders by pack id and path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-assets-soundfont-"));
  const oldPath = process.env.PATH;
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Assets SoundFont", createdByClientId: "producer" });
    const packManager = getToolModule("manage_jazz_instrument_packs");
    const soundfontRender = getToolModule("render_midi_with_soundfont");
    assert.ok(packManager && soundfontRender);

    await composeTestCue(ctx, {
      projectId: project.id,
      instruments: ["piano"],
      durationSeconds: 8,
      outputManifestPath: "music/assets-soundfont.json",
      outputMidiPath: "music/assets-soundfont.mid"
    }, ctx);

    const soundfontPath = "assets/soundfonts/generaluser_gs/GeneralUser-GS.sf2";
    const sf2 = fakeSoundfontBytes();
    await writeProjectAsset(ctx.projectRoot, project.id, soundfontPath, sf2, "audio/soundfont");
    await writeProjectFile(ctx.projectRoot, project.id, "assets/soundfonts/generaluser_gs/LICENSE.txt", "GeneralUser GS license fixture\n");
    await writeProjectFile(ctx.projectRoot, project.id, "assets/soundfonts/generaluser_gs/README.md", "# GeneralUser GS fixture\n");

    const registered = await packManager!.handler({
      projectId: project.id,
      packs: [{
        packId: "generaluser_gs",
        displayName: "GeneralUser GS",
        instrumentRole: "realistic_piano",
        format: "soundfont",
        assetPaths: [soundfontPath],
        declaredSha256: createHash("sha256").update(sf2).digest("hex"),
        licenseType: "generaluser_gs_2_0",
        source: "https://github.com/mrbumpy409/GeneralUser-GS",
        sourceUrl: "https://github.com/mrbumpy409/GeneralUser-GS",
        licenseTextPath: "assets/soundfonts/generaluser_gs/LICENSE.txt",
        readmePath: "assets/soundfonts/generaluser_gs/README.md",
        commercialUseAllowed: true,
        redistributionAllowed: true,
        productionUseApproved: true,
        qualityTier: "production_candidate"
      }]
    }, ctx);
    assert.equal(registered.ok, true);

    process.env.PATH = `${await installFakeFluidSynth(root)}:${oldPath}`;
    const byPackId = await soundfontRender!.handler({
      projectId: project.id,
      compositionManifestPath: "music/assets-soundfont.json",
      soundfontPackId: "generaluser_gs",
      outputAudioPath: "music/by-pack-id.wav",
      outputReportPath: "music/by-pack-id-report.json"
    }, ctx);
    assert.equal(byPackId.ok, true, `pack id render should succeed: ${JSON.stringify(byPackId.errors)}`);

    const byPath = await soundfontRender!.handler({
      projectId: project.id,
      compositionManifestPath: "music/assets-soundfont.json",
      soundfontPath,
      outputAudioPath: "music/by-path.wav",
      outputReportPath: "music/by-path-report.json"
    }, ctx);
    assert.equal(byPath.ok, true, `path render should succeed: ${JSON.stringify(byPath.errors)}`);
  } finally {
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

// issue_0147: always-on ensemble QA. buildEnsembleQa is the pure transparency report (non-blocking)
// that lets compose/render outputs prove which requested instruments carry notes, their
// channel/program, first-note time, and whether they truly overlap.
type EnsembleQaComposition = Parameters<typeof buildEnsembleQa>[0];
function qaComposition(tracks: Record<string, Array<{ startBeat: number; durationBeats: number; midi: number; velocity: number }>>): EnsembleQaComposition {
  return { tempo: 90, durationSeconds: 8, instruments: Object.keys(tracks), tracks } as unknown as EnsembleQaComposition;
}

test("buildEnsembleQa: real duet reports both voices, channel/program, and overlap from the top", () => {
  const qa = buildEnsembleQa(qaComposition({
    piano: [{ startBeat: 0, durationBeats: 4, midi: 60, velocity: 80 }],
    cello: [{ startBeat: 0, durationBeats: 4, midi: 48, velocity: 70 }]
  }), ["piano", "cello"]);
  assert.deepEqual(qa.instrumentsRequested.sort(), ["cello", "piano"]);
  assert.deepEqual(qa.instrumentsFound.sort(), ["cello", "piano"]);
  assert.deepEqual(qa.missingInstruments, []);
  assert.deepEqual(qa.missingInstrumentWarnings, []);
  assert.equal(qa.overlapFromBeat0, true, "both voices sound together from the downbeat");
  const cello = qa.tracks.find((t) => t.instrument === "cello");
  assert.equal(cello?.gmProgram, 43, "cello maps to GM program 43");
  assert.equal(cello?.channel, 5);
  assert.equal(cello?.noteCount, 1);
  assert.equal(cello?.firstBeat, 0);
});

test("buildEnsembleQa: a requested-but-empty voice is reported missing with a warning (no silent fake duet)", () => {
  const qa = buildEnsembleQa(qaComposition({
    piano: [{ startBeat: 0, durationBeats: 4, midi: 60, velocity: 80 }],
    cello: []
  }), ["piano", "cello"]);
  assert.deepEqual(qa.instrumentsFound, ["piano"]);
  assert.deepEqual(qa.missingInstruments, ["cello"]);
  assert.equal(qa.missingInstrumentWarnings.length, 1);
  assert.match(qa.missingInstrumentWarnings[0], /cello.*no notes/i);
  assert.equal(qa.overlapFromBeat0, false, "a single sounding voice is not an overlap");
});

test("issue_0147: compose_edit_midi always surfaces ensembleQa proving both requested voices", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-ensemble-qa-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Ensemble QA", createdByClientId: "composer" });
    // No ensembleRequirement passed — QA must appear by default, not only under the opt-in gate.
    const { result } = await composeTestCue(ctx, {
      projectId: project.id,
      instruments: ["piano", "cello"],
      durationSeconds: 16,
      outputManifestPath: "music/qa-cue.json",
      outputMidiPath: "music/qa-cue.mid"
    }, ctx);
    assert.equal(result.ok, true);
    const payload = result.structuredContent as { ensembleQa?: { instrumentsRequested: string[]; instrumentsFound: string[]; missingInstruments: string[]; overlapFromBeat0: boolean; tracks: Array<{ instrument: string; gmProgram: number | null; noteCount: number }> } };
    assert.ok(payload.ensembleQa, "ensembleQa present without opting into ensembleRequirement");
    assert.ok(payload.ensembleQa!.instrumentsRequested.includes("cello"));
    assert.ok(payload.ensembleQa!.instrumentsFound.includes("cello"), "cello has notes (issue_0144 fix) and is reported found");
    assert.ok(payload.ensembleQa!.instrumentsFound.includes("piano"));
    assert.deepEqual(payload.ensembleQa!.missingInstruments, []);
    assert.equal(payload.ensembleQa!.overlapFromBeat0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// FluidSynth 2.x rejects -F/-r placed AFTER the SoundFont/MIDI positional args ("illegal option at
// this place"), so the old `-ni <sf2> <midi> -F <out> -r <rate>` wrote no WAV on modern fluidsynth.
// Options must precede the positional files. (The fake fluidsynth in installFakeFluidSynth enforces
// this too, so the e2e renders double as a guard.)
test("fluidSynthArgs: render options precede the SoundFont and MIDI positional args", () => {
  const args = fluidSynthArgs("/packs/gm.sf2", "/tmp/song.mid", "/tmp/out.wav", 44100);
  const sfIdx = args.indexOf("/packs/gm.sf2");
  const midIdx = args.indexOf("/tmp/song.mid");
  const fIdx = args.indexOf("-F");
  const rIdx = args.indexOf("-r");
  assert.ok(fIdx !== -1 && rIdx !== -1, "-F and -r are present");
  assert.ok(fIdx < sfIdx && fIdx < midIdx, "-F precedes the positional files");
  assert.ok(rIdx < sfIdx && rIdx < midIdx, "-r precedes the positional files");
  assert.equal(args[fIdx + 1], "/tmp/out.wav", "-F is immediately followed by the output path");
  assert.equal(args[rIdx + 1], "44100", "-r is immediately followed by the sample rate");
  // SoundFont before MIDI (FluidSynth positional order).
  assert.ok(sfIdx < midIdx, "SoundFont positional precedes the MIDI positional");
});

// A D-minor score: fifths=-1 with <mode>minor</mode>. Two parts so import is a real piano+cello duet.
const dMinorDuetMusicXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Minor Duet</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name><midi-instrument id="P1-I1"><midi-program>1</midi-program></midi-instrument></score-part>
    <score-part id="P2"><part-name>Violoncello</part-name><midi-instrument id="P2-I1"><midi-program>43</midi-program></midi-instrument></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>-1</fifths><mode>minor</mode></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>D</step><octave>3</octave></pitch><duration>4</duration><type>half</type></note>
      <note><pitch><step>A</step><octave>3</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>-1</fifths><mode>minor</mode></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>8</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

// Bug fix: a MusicXML <key> with <mode>minor</mode> must import as the minor key, not its relative
// major (fifths=-1 + minor = D minor, previously mislabeled "F major").
test("import_musicxml_score honors <mode>minor</mode> (fifths=-1 imports as D minor, not F major)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "musicxml-minor-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Minor key", createdByClientId: "composer" });
    const importer = getToolModule("import_musicxml_score");
    const result = await importer!.handler({ projectId: project.id, musicXmlString: dMinorDuetMusicXml, outputManifestPath: "music/minor.json", outputMidiPath: "music/minor.mid" }, ctx);
    assert.equal(result.ok, true);
    const payload = result.structuredContent as { key: string; tracks: Record<string, unknown[]> };
    assert.equal(payload.key, "D minor");
    assert.ok(payload.tracks.piano && payload.tracks.cello, "both parts import");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Bug fix: import_musicxml_score reads via the project file allowlist, which rejected .xml/.musicxml
// (the standard MusicXML extensions) — so musicXmlPath was unusable and only musicXmlString worked.
test("import_musicxml_score reads a score from a .xml project file path (extension allowlist)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "musicxml-ext-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Xml ext", createdByClientId: "composer" });
    // write_project_file would previously reject .xml; the allowlist now permits it.
    await writeProjectFile(ctx.projectRoot, project.id, "music/score.xml", dMinorDuetMusicXml);
    const importer = getToolModule("import_musicxml_score");
    const result = await importer!.handler({ projectId: project.id, musicXmlPath: "music/score.xml", outputManifestPath: "music/from-xml.json", outputMidiPath: "music/from-xml.mid" }, ctx);
    assert.equal(result.ok, true, `import from .xml path should succeed: ${JSON.stringify(result.errors)}`);
    const payload = result.structuredContent as { key: string; scoreSource: { sourcePath: string } };
    assert.equal(payload.key, "D minor");
    assert.equal(payload.scoreSource.sourcePath, "music/score.xml");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A sampled SoundFont (e.g. a grand piano) is legitimately 100MB-1GB+. It is a render input, never a
// web-served deliverable, and publishProject does not copy it — so an oversized .sf2 must WARN, not
// ERROR, or the music project can never be published. (Regression for the YDP 118MB publish block.)
test("validateProject warns (not errors) on an oversized instrument SoundFont asset", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-sf2-validate-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "SF2 size", createdByClientId: "composer" });
    await writeProjectFile(ctx.projectRoot, project.id, "index.html", "<!doctype html><title>ok</title><p>player</p>");
    // Create a sparse 130MB .sf2 (over the ~100MB asset cap) without writing real bytes.
    const filesRoot = getProjectFilesDirectory(ctx.projectRoot, project.id);
    await mkdirNode(path.join(filesRoot, "soundfonts"), { recursive: true });
    const sf2 = path.join(filesRoot, "soundfonts", "grand.sf2");
    await writeFile(sf2, Buffer.from("RIFF")); // valid-ish header byte; size set by truncate
    await truncateNode(sf2, 130 * 1024 * 1024);

    const result = await validateProject(ctx.projectRoot, project.id, "index.html");
    assert.equal(result.errors.some((e) => /exceeds max size/i.test(e)), false, "oversized .sf2 must not be a blocking error");
    assert.equal(result.ok, true, "project with a large render-only SoundFont still validates");
    assert.ok(result.warnings.some((w) => /grand\.sf2/.test(w) && /render input/i.test(w)), "oversized SoundFont is surfaced as a warning");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// option: install_free_soundfont_pack now installs bundled sampled grand pianos (YDP / Salamander)
// straight from MUSIC_SOUNDFONT_DIR and auto-registers them as realistic_piano with CC-BY attribution
// recorded automatically (so business delivery is legal with zero manual credit work).
test("install_free_soundfont_pack installs a bundled sampled grand (YDP) with auto CC-BY attribution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-ydp-install-"));
  const oldSoundfontDir = process.env.MUSIC_SOUNDFONT_DIR;
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "YDP install", createdByClientId: "producer" });
    // Bundle a fake YDP under MUSIC_SOUNDFONT_DIR/ydp-grand/ (valid RIFF/sfbk so it passes validation).
    const bundleDir = path.join(root, "soundfonts", "ydp-grand");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, "YDP-GrandPiano.sf2"), fakeSoundfontBytes());
    await writeFile(path.join(bundleDir, "LICENSE.txt"), "YDP Grand Piano — Creative Commons Attribution 3.0\n");
    await writeFile(path.join(bundleDir, "README.md"), "# YDP Grand Piano fixture\n");
    process.env.MUSIC_SOUNDFONT_DIR = path.join(root, "soundfonts");

    const installer = getToolModule("install_free_soundfont_pack");
    assert.ok(installer);
    const result = await installer!.handler({ projectId: project.id, packId: "ydp_grand" }, ctx);
    assert.equal(result.ok, true, `install should succeed: ${JSON.stringify(result.errors)}`);
    const payload = result.structuredContent as { instrumentRole: string; licenseType: string; autoRegistered: boolean; readyPackIds: string[]; attributionRequired: boolean; attributionText?: string; assetPaths: string[]; installSource: string };
    assert.equal(payload.instrumentRole, "realistic_piano");
    assert.equal(payload.licenseType, "cc_by");
    assert.equal(payload.installSource, "bundled_runtime_soundfont");
    assert.equal(payload.autoRegistered, true, "sampled grand must auto-register so render can use it directly");
    assert.ok(payload.readyPackIds.includes("ydp_grand"));
    assert.equal(payload.attributionRequired, true, "CC-BY requires attribution");
    assert.match(payload.attributionText ?? "", /YDP Grand Piano.*CC-BY 3\.0/);
    assert.deepEqual(payload.assetPaths, ["soundfonts/ydp-grand/YDP-GrandPiano.sf2"]);
    // The license manifest must carry the attribution automatically (legal commercial delivery).
    const licenseManifest = await readProjectFile(ctx.projectRoot, project.id, "music/jazz-instrument-license-manifest.json", 1024 * 1024);
    assert.match(licenseManifest, /allowed_with_attribution/);
    assert.match(licenseManifest, /YDP Grand Piano/);
  } finally {
    if (oldSoundfontDir === undefined) delete process.env.MUSIC_SOUNDFONT_DIR; else process.env.MUSIC_SOUNDFONT_DIR = oldSoundfontDir;
    await rm(root, { recursive: true, force: true });
  }
});

// Bundled-only: when the sampled grand is not present in the runtime soundfont directory, install
// fails closed with download/extract guidance rather than silently producing nothing.
test("install_free_soundfont_pack fails closed for a sampled grand that is not bundled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-ydp-missing-"));
  const oldSoundfontDir = process.env.MUSIC_SOUNDFONT_DIR;
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "YDP missing", createdByClientId: "producer" });
    process.env.MUSIC_SOUNDFONT_DIR = path.join(root, "empty-soundfonts");
    const installer = getToolModule("install_free_soundfont_pack");
    const result = await installer!.handler({ projectId: project.id, packId: "salamander_grand" }, ctx);
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result.errors), /not bundled|MUSIC_SOUNDFONT_DIR/);
    const payload = result.structuredContent as {
      manualInstallRequired: boolean;
      autoDownloadAvailable: boolean;
      requiredFiles: string[];
      searchDirectories: string[];
      nextAction: string;
    };
    assert.equal(payload.manualInstallRequired, true);
    assert.equal(payload.autoDownloadAvailable, false);
    assert.deepEqual(payload.requiredFiles, ["Salamander.sf2", "LICENSE.txt"]);
    assert.ok(payload.searchDirectories.some((dir) => dir.endsWith("salamander")));
    assert.match(payload.nextAction, /Do not call render_production_music.*autoRegistered=true/);
    assert.ok(typeof (payload as unknown as Record<string, unknown>).userFacingExplanation === "string" && ((payload as unknown as Record<string, unknown>).userFacingExplanation as string).length > 0, "userFacingExplanation is a non-empty string");
    assert.match((payload as unknown as Record<string, string>).userFacingExplanation, /Salamander/, "userFacingExplanation mentions the pack name");
  } finally {
    if (oldSoundfontDir === undefined) delete process.env.MUSIC_SOUNDFONT_DIR; else process.env.MUSIC_SOUNDFONT_DIR = oldSoundfontDir;
    await rm(root, { recursive: true, force: true });
  }
});

// issue_0152: check_music_render_environment with requestedPackId="salamander_grand" returns a
// blocked preflight when the runtime soundfont directory does not contain Salamander.sf2.
test("check_music_render_environment: salamander_grand preflight returns blocked when not installed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-salamander-preflight-"));
  const oldSoundfontDir = process.env.MUSIC_SOUNDFONT_DIR;
  try {
    const ctx = toolContext(root);
    process.env.MUSIC_SOUNDFONT_DIR = path.join(root, "empty-soundfonts");
    const checker = getToolModule("check_music_render_environment");
    assert.ok(checker);
    const result = await checker!.handler({ requestedPackId: "salamander_grand" }, ctx);
    const env = result.structuredContent as Record<string, unknown>;
    assert.ok("requestedPackPreflight" in env, "requestedPackPreflight present in structuredContent");
    const preflight = env.requestedPackPreflight as Record<string, unknown>;
    assert.equal(preflight.requestedPackId, "salamander_grand");
    assert.equal(preflight.runtimeFilesReady, false);
    assert.equal(preflight.manualInstallRequired, true);
    assert.deepEqual(preflight.requiredFiles, ["Salamander.sf2", "LICENSE.txt"]);
    assert.ok(typeof preflight.userFacingExplanation === "string" && (preflight.userFacingExplanation as string).length > 0, "userFacingExplanation is present");
    assert.match(preflight.userFacingExplanation as string, /Salamander/, "userFacingExplanation mentions the pack name");
  } finally {
    if (oldSoundfontDir === undefined) delete process.env.MUSIC_SOUNDFONT_DIR; else process.env.MUSIC_SOUNDFONT_DIR = oldSoundfontDir;
    await rm(root, { recursive: true, force: true });
  }
});

// issue_0152: when Salamander is missing but YDP Grand runtime files are present, the preflight
// recommends ydp_grand as the fallback (preferred one-click sampled piano).
test("check_music_render_environment: salamander_grand preflight recommends ydp_grand when YDP is available", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-ydp-fallback-"));
  const oldSoundfontDir = process.env.MUSIC_SOUNDFONT_DIR;
  try {
    const ctx = toolContext(root);
    const soundfontDir = path.join(root, "test-soundfonts");
    process.env.MUSIC_SOUNDFONT_DIR = soundfontDir;
    // Place YDP Grand runtime files so sampledPianoPackAvailability("ydp_grand") returns runtimeFilesReady=true.
    const ydpDir = path.join(soundfontDir, "ydp-grand");
    await mkdir(ydpDir, { recursive: true });
    await writeFile(path.join(ydpDir, "YDP-GrandPiano.sf2"), fakeSoundfontBytes());
    await writeFile(path.join(ydpDir, "LICENSE.txt"), "YDP Grand license fixture\n");
    const checker = getToolModule("check_music_render_environment");
    assert.ok(checker);
    const result = await checker!.handler({ requestedPackId: "salamander_grand" }, ctx);
    const env = result.structuredContent as Record<string, unknown>;
    assert.ok("requestedPackPreflight" in env, "requestedPackPreflight present");
    const preflight = env.requestedPackPreflight as Record<string, unknown>;
    assert.equal(preflight.runtimeFilesReady, false, "Salamander is still blocked");
    assert.equal(preflight.manualInstallRequired, true);
    const fallback = preflight.fallbackRecommendation as Record<string, unknown>;
    assert.ok(fallback, "fallbackRecommendation is present");
    assert.equal(fallback.packId, "ydp_grand", "fallback is ydp_grand when YDP runtime files are present");
    assert.match(fallback.label as string, /YDP Grand fallback/, "fallback label is truthful");
    assert.match(preflight.renderLabel as string, /YDP Grand fallback/, "renderLabel matches fallback label");
  } finally {
    if (oldSoundfontDir === undefined) delete process.env.MUSIC_SOUNDFONT_DIR; else process.env.MUSIC_SOUNDFONT_DIR = oldSoundfontDir;
    await rm(root, { recursive: true, force: true });
  }
});

// issue_0152: when both Salamander and YDP Grand are missing, the preflight falls back to
// generaluser_gs as the last resort and uses a truthful fallback label.
test("check_music_render_environment: salamander_grand preflight recommends generaluser_gs when YDP is also missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-gus-fallback-"));
  const oldSoundfontDir = process.env.MUSIC_SOUNDFONT_DIR;
  try {
    const ctx = toolContext(root);
    process.env.MUSIC_SOUNDFONT_DIR = path.join(root, "empty-soundfonts");
    const checker = getToolModule("check_music_render_environment");
    assert.ok(checker);
    const result = await checker!.handler({ requestedPackId: "salamander_grand" }, ctx);
    const env = result.structuredContent as Record<string, unknown>;
    assert.ok("requestedPackPreflight" in env, "requestedPackPreflight present");
    const preflight = env.requestedPackPreflight as Record<string, unknown>;
    assert.equal(preflight.runtimeFilesReady, false, "Salamander is blocked");
    const fallback = preflight.fallbackRecommendation as Record<string, unknown>;
    assert.ok(fallback, "fallbackRecommendation is present");
    assert.equal(fallback.packId, "generaluser_gs", "last-resort fallback is generaluser_gs");
    assert.match(fallback.label as string, /GeneralUser GS fallback/, "fallback label is truthful and does not mention Salamander as the renderer");
    assert.match(preflight.renderLabel as string, /GeneralUser GS fallback/, "renderLabel is truthful");
    assert.ok(!(preflight.renderLabel as string).startsWith("Salamander"), "renderLabel must not falsely claim Salamander rendered");
  } finally {
    if (oldSoundfontDir === undefined) delete process.env.MUSIC_SOUNDFONT_DIR; else process.env.MUSIC_SOUNDFONT_DIR = oldSoundfontDir;
    await rm(root, { recursive: true, force: true });
  }
});

// ---- auto bow-expression for bowed-string lines (CC11 swell + CC1 vibrato) ----
type MidiBufferComposition = Parameters<typeof midiBuffer>[0];
function makeComposition(tracks: Record<string, Array<{ track: string; midi: number; startBeat: number; durationBeats: number; velocity: number }>>): MidiBufferComposition {
  return {
    title: "exp", style: "cinematic_background", mood: "calm", tempo: 66, key: "D minor",
    durationSeconds: 16, loopable: false, instruments: Object.keys(tracks), sections: [],
    chordProgression: [], tracks, license: { output: "generated_original", dependencies: [] }
  } as unknown as MidiBufferComposition;
}
// Count control-change events for (channel, controller) by walking the single MTrk. midiBuffer emits
// a full status byte per event (no running status), but we still parse delta/status/data lengths so
// a data byte that merely looks like a status byte cannot be miscounted.
function countController(buf: Buffer, channel: number, controller: number): number {
  let i = 14; // skip MThd
  if (buf.subarray(i, i + 4).toString("ascii") !== "MTrk") return -1;
  i += 8; // skip MTrk id + length
  let count = 0;
  let running = 0;
  while (i < buf.length) {
    while (i < buf.length && (buf[i] & 0x80)) i++; // delta varlen continuation bytes
    i++;                                            // delta final byte
    if (i >= buf.length) break;
    let status = buf[i];
    if (status & 0x80) { i++; running = status; } else { status = running; }
    if (status === 0xff) {
      i++; // meta type
      let len = 0; while (buf[i] & 0x80) { len = (len << 7) | (buf[i] & 0x7f); i++; } len = (len << 7) | buf[i]; i++;
      i += len;
      continue;
    }
    const hi = status & 0xf0;
    if (hi === 0xb0) {
      const ctrl = buf[i]; i += 2;
      if ((status & 0x0f) === channel && ctrl === controller) count++;
      continue;
    }
    if (hi === 0xc0 || hi === 0xd0) { i += 1; continue; }
    i += 2;
  }
  return count;
}

const longCelloLine = [
  { track: "cello", midi: 62, startBeat: 0, durationBeats: 3, velocity: 64 },
  { track: "cello", midi: 65, startBeat: 3, durationBeats: 1, velocity: 60 },
  { track: "cello", midi: 64, startBeat: 4, durationBeats: 4, velocity: 70 },
  { track: "cello", midi: 60, startBeat: 8, durationBeats: 2, velocity: 66 }
];

test("midiBuffer auto-authors CC11 swell + CC1 vibrato on a monophonic cello line", () => {
  const buf = midiBuffer(makeComposition({ cello: longCelloLine })); // cello => channel 5
  assert.ok(countController(buf, 5, 11) > 10, "expected many CC11 expression points on the cello channel");
  assert.ok(countController(buf, 5, 1) > 5, "expected CC1 vibrato points on sustained cello notes");
});

test("midiBuffer leaves a POLYPHONIC bowed-string track flat (monophony guard — the discriminating case)", () => {
  const doubleStops = [
    { track: "cello", midi: 50, startBeat: 0, durationBeats: 4, velocity: 64 },
    { track: "cello", midi: 57, startBeat: 0, durationBeats: 4, velocity: 60 },
    { track: "cello", midi: 53, startBeat: 4, durationBeats: 4, velocity: 64 },
    { track: "cello", midi: 60, startBeat: 4, durationBeats: 4, velocity: 60 }
  ];
  const buf = midiBuffer(makeComposition({ cello: doubleStops }));
  assert.equal(countController(buf, 5, 11), 0, "polyphonic cello must stay flat (no CC11)");
  assert.equal(countController(buf, 5, 1), 0, "polyphonic cello must stay flat (no CC1)");
});

test("midiBuffer keeps shared-channel string parts flat (two monophonic lines on one channel)", () => {
  // violin + violin_2 both resolve to channel 4. Each line is individually monophonic, but they
  // share a channel, so per-track curves would pump each other. Must stay flat.
  const buf = midiBuffer(makeComposition({
    violin:   [{ track: "violin",   midi: 67, startBeat: 0, durationBeats: 4, velocity: 64 }],
    violin_2: [{ track: "violin_2", midi: 62, startBeat: 0, durationBeats: 4, velocity: 60 }]
  }));
  assert.equal(countController(buf, 4, 11), 0, "shared-channel string parts must stay flat (no CC11)");
  assert.equal(countController(buf, 4, 1), 0, "shared-channel string parts must stay flat (no CC1)");
});

test("midiBuffer does not author bow expression on a piano line", () => {
  const buf = midiBuffer(makeComposition({ piano: [
    { track: "piano", midi: 60, startBeat: 0, durationBeats: 4, velocity: 70 },
    { track: "piano", midi: 64, startBeat: 4, durationBeats: 4, velocity: 70 }
  ] })); // piano => channel 0
  assert.equal(countController(buf, 0, 11), 0, "piano must not receive CC11 bow swells");
});

test("midiBuffer skips bow swells on short (detache) cello notes", () => {
  const buf = midiBuffer(makeComposition({ cello: [
    { track: "cello", midi: 62, startBeat: 0, durationBeats: 0.5, velocity: 64 },
    { track: "cello", midi: 64, startBeat: 0.5, durationBeats: 0.5, velocity: 64 },
    { track: "cello", midi: 65, startBeat: 1, durationBeats: 0.5, velocity: 64 }
  ] }));
  assert.equal(countController(buf, 5, 11), 0, "notes below the swell threshold must stay flat");
});

test("midiBuffer expressiveStrings:false renders strings exactly as written", () => {
  const buf = midiBuffer(makeComposition({ cello: longCelloLine }), { expressiveStrings: false });
  assert.equal(countController(buf, 5, 11), 0, "opt-out must suppress CC11");
  assert.equal(countController(buf, 5, 1), 0, "opt-out must suppress CC1");
});

test("midiBuffer bow-expression output is deterministic", () => {
  const a = midiBuffer(makeComposition({ cello: longCelloLine }));
  const b = midiBuffer(makeComposition({ cello: longCelloLine }));
  assert.deepEqual(a, b, "same composition must emit byte-identical MIDI");
});

// Regression for issue_0153: when HTML is in a subdirectory, the MP3 src must be relative
// to the HTML file, not the project root — otherwise the browser resolves the wrong URL.
test("renderProductionMusicHtml: subdirectory HTML uses correct relative MP3 URL (issue_0153)", () => {
  // Case 1: HTML at root, MP3 in music/ subdirectory — relative path is music/preview.mp3.
  const rootHtml = renderProductionMusicHtml({
    htmlPath: "music-project.html",
    title: "Test",
    statusLabel: "OK",
    productionReady: true,
    previewMp3Path: "music/preview.mp3",
    licensesPath: "LICENSES.md",
    reportPath: "music/report.json"
  });
  assert.ok(rootHtml.includes('src="music/preview.mp3"'), "root HTML must use project-relative MP3 path");
  assert.ok(rootHtml.includes('href="music/preview.mp3"'), "root download link must use project-relative MP3 path");
  assert.ok(rootHtml.includes('href="LICENSES.md"'), "root HTML licenses link must be correct");

  // Case 2 (the bug): HTML at music/player.html, MP3 at music/preview.mp3 — both in same
  // directory, so relative path from the HTML is just the filename: preview.mp3.
  const subdirHtml = renderProductionMusicHtml({
    htmlPath: "music/player.html",
    title: "Test",
    statusLabel: "OK",
    productionReady: true,
    previewMp3Path: "music/preview.mp3",
    licensesPath: "LICENSES.md",
    reportPath: "music/report.json"
  });
  assert.ok(subdirHtml.includes('src="preview.mp3"'), "subdirectory HTML must use filename-only MP3 src, not music/preview.mp3");
  assert.ok(!subdirHtml.includes('src="music/preview.mp3"'), "subdirectory HTML must NOT use project-root-relative MP3 path in src");
  assert.ok(subdirHtml.includes('href="../LICENSES.md"'), "subdirectory HTML must use ../LICENSES.md to reach the root");
});

// ── P1 Epic: Strict Handwritten Solo Piano Path ─────────────────────────────

test("author_handwritten_music_score: writes MusicXML + manifest + MIDI with D minor key, RH/LH parts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-handwritten-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Handwritten Piano", createdByClientId: "composer" });
    const author = getToolModule("author_handwritten_music_score");
    assert.ok(author, "author_handwritten_music_score must be registered");

    const rhNotes = [
      { track: "piano_right_hand", midi: 62, startBeat: 0, durationBeats: 1, velocity: 80 },
      { track: "piano_right_hand", midi: 64, startBeat: 1, durationBeats: 1, velocity: 75 },
      { track: "piano_right_hand", midi: 65, startBeat: 2, durationBeats: 1, velocity: 78 },
      { track: "piano_right_hand", midi: 69, startBeat: 3, durationBeats: 1, velocity: 82 }
    ];
    const lhNotes = [
      { track: "piano_left_hand", midi: 38, startBeat: 0, durationBeats: 2, velocity: 65 },
      { track: "piano_left_hand", midi: 41, startBeat: 2, durationBeats: 2, velocity: 68 }
    ];

    const result = await author!.handler({
      projectId: project.id,
      title: "Nocturne in D Minor",
      tempoBpm: 60,
      key: "D minor",
      durationSec: 8,
      sections: [
        { name: "A", bars: 2, intensity: 0.5 }
      ],
      parts: { piano_right_hand: rhNotes, piano_left_hand: lhNotes },
      chordMap: [
        { bar: 1, chord: "Dm" },
        { bar: 2, chord: "A7" }
      ],
      outputMusicXmlPath: "music/score.xml",
      outputManifestPath: "music/composition-manifest.json",
      outputMidiPath: "music/score.mid"
    }, ctx);

    assert.equal(result.ok, true, `Expected ok:true but got errors: ${JSON.stringify(result.errors)}`);
    assert.ok(result.artifacts.includes("music/score.xml"), "MusicXML file listed in artifacts");
    assert.ok(result.artifacts.includes("music/composition-manifest.json"), "manifest listed in artifacts");
    assert.ok(result.artifacts.includes("music/score.mid"), "MIDI listed in artifacts");

    // Verify MusicXML is valid XML with correct structure
    const xmlContent = await readProjectFile(ctx.projectRoot, project.id, "music/score.xml");
    assert.ok(xmlContent.includes("score-partwise"), "MusicXML must have score-partwise root");
    assert.ok(xmlContent.includes("Piano Right Hand"), "RH part name must appear");
    assert.ok(xmlContent.includes("Piano Left Hand"), "LH part name must appear");
    assert.ok(xmlContent.includes("<fifths>-1</fifths>"), "D minor must use fifths=-1");
    assert.ok(xmlContent.includes("<mode>minor</mode>"), "key mode must be minor");

    // Verify manifest metadata
    const manifestJson = await readProjectFile(ctx.projectRoot, project.id, "music/composition-manifest.json");
    const manifest = JSON.parse(manifestJson) as {
      title: string; key: string; tempo: number;
      authoringMode: string;
      scoreSource: { scoreDriven: boolean; format: string };
      compositionPlan: { form: Array<{ name: string; bars: number }>; motifs: Array<{ id: string }> };
      performance: { humanized: boolean };
      tracks: { piano_right_hand: unknown[]; piano_left_hand: unknown[] };
      chordMap: Array<{ bar: number; chord: string }>;
    };
    assert.equal(manifest.title, "Nocturne in D Minor");
    assert.equal(manifest.key, "D minor");
    assert.equal(manifest.tempo, 60);
    assert.equal(manifest.authoringMode, "strict_handwritten");
    assert.equal(manifest.scoreSource.scoreDriven, true);
    assert.equal(manifest.scoreSource.format, "handwritten");
    assert.ok(manifest.compositionPlan.motifs.length > 0, "compositionPlan must have at least one motif");
    assert.equal(manifest.performance.humanized, true, "performance.humanized must be true for handwritten scores");
    assert.equal(manifest.tracks.piano_right_hand.length, rhNotes.length);
    assert.equal(manifest.tracks.piano_left_hand.length, lhNotes.length);
    assert.ok(Array.isArray(manifest.chordMap), "chordMap must be in manifest");

    // Verify MIDI file is valid
    const midiBytes = await readFile(await getProjectStoredFilePath(ctx.projectRoot, project.id, "music/score.mid"));
    assert.equal(midiBytes.subarray(0, 4).toString("ascii"), "MThd", "MIDI must start with MThd header");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("author_handwritten_music_score: exported <type> matches actual note duration (half/eighth/dotted-quarter), not hardcoded quarter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-handwritten-notetype-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Note type test", createdByClientId: "composer" });
    const author = getToolModule("author_handwritten_music_score");
    assert.ok(author);

    // One bar (4 beats): half note, then eighth note, then dotted-quarter note — exactly fills the bar.
    const rhNotes = [
      { track: "piano_right_hand", midi: 67, startBeat: 0, durationBeats: 2, velocity: 80 },
      { track: "piano_right_hand", midi: 69, startBeat: 2, durationBeats: 0.5, velocity: 75 },
      { track: "piano_right_hand", midi: 71, startBeat: 2.5, durationBeats: 1.5, velocity: 78 }
    ];
    const lhNotes = [{ track: "piano_left_hand", midi: 43, startBeat: 0, durationBeats: 4, velocity: 60 }];

    const result = await author!.handler({
      projectId: project.id,
      title: "Note Type Test",
      tempoBpm: 90,
      key: "C major",
      durationSec: 4,
      sections: [{ name: "A", bars: 1, intensity: 0.5 }],
      parts: { piano_right_hand: rhNotes, piano_left_hand: lhNotes },
      chordMap: [{ bar: 1, chord: "C" }],
      outputMusicXmlPath: "music/note-type.xml",
      outputManifestPath: "music/note-type-manifest.json",
      outputMidiPath: "music/note-type.mid"
    }, ctx);
    assert.equal(result.ok, true, `Expected ok:true but got errors: ${JSON.stringify(result.errors)}`);

    const xmlContent = await readProjectFile(ctx.projectRoot, project.id, "music/note-type.xml");
    assert.ok(xmlContent.includes("<type>half</type>"), "2-beat note must export as half, not quarter");
    assert.ok(xmlContent.includes("<type>eighth</type>"), "0.5-beat note must export as eighth, not quarter");
    assert.ok(xmlContent.includes("<type>quarter</type><dot/>"), "1.5-beat note must export as dotted quarter");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("author_handwritten_music_score: a note crossing a bar line is split with <tie> instead of silently truncated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-handwritten-tie-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Tie test", createdByClientId: "composer" });
    const author = getToolModule("author_handwritten_music_score");
    assert.ok(author);

    // RH note starts at beat 2 of bar 1 and runs 4 beats, so it crosses into bar 2 (2 beats in
    // each bar). Before the fix, buildMeasureNotesXml clamped this to the 2 beats remaining in
    // bar 1 and the tail simply vanished from the exported MusicXML.
    const rhNotes = [{ track: "piano_right_hand", midi: 60, startBeat: 2, durationBeats: 4, velocity: 80 }];
    const lhNotes = [
      { track: "piano_left_hand", midi: 36, startBeat: 0, durationBeats: 4, velocity: 60 },
      { track: "piano_left_hand", midi: 38, startBeat: 4, durationBeats: 4, velocity: 62 }
    ];

    const result = await author!.handler({
      projectId: project.id,
      title: "Tie Test",
      tempoBpm: 90,
      key: "C major",
      durationSec: 8,
      sections: [{ name: "A", bars: 2, intensity: 0.5 }],
      parts: { piano_right_hand: rhNotes, piano_left_hand: lhNotes },
      chordMap: [{ bar: 1, chord: "C" }, { bar: 2, chord: "C" }],
      outputMusicXmlPath: "music/tie.xml",
      outputManifestPath: "music/tie-manifest.json",
      outputMidiPath: "music/tie.mid"
    }, ctx);
    assert.equal(result.ok, true, `Expected ok:true but got errors: ${JSON.stringify(result.errors)}`);

    const xmlContent = await readProjectFile(ctx.projectRoot, project.id, "music/tie.xml");
    const c4PitchXml = "<pitch><step>C</step><octave>4</octave></pitch>"; // MIDI 60
    const c4Occurrences = xmlContent.split(c4PitchXml).length - 1;
    assert.equal(c4Occurrences, 2, "the crossing note must be split into 2 fragments (one per bar), not truncated to 1");

    const tieStartCount = xmlContent.split(`<tie type="start"/>`).length - 1;
    const tieStopCount = xmlContent.split(`<tie type="stop"/>`).length - 1;
    assert.equal(tieStartCount, 1, "exactly one fragment must open the tie");
    assert.equal(tieStopCount, 1, "exactly one fragment must close the tie");
    assert.ok(xmlContent.includes(`<tied type="start"/>`) && xmlContent.includes(`<tied type="stop"/>`), "notation-level <tied> must accompany the sound-level <tie>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("author_handwritten_music_score: fails closed when RH part is empty", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-handwritten-empty-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Empty RH", createdByClientId: "composer" });
    const author = getToolModule("author_handwritten_music_score");
    assert.ok(author);

    // Zod min(1) on piano_right_hand should reject empty array
    await assert.rejects(
      () => author!.handler({
        projectId: project.id,
        title: "Bad Score",
        tempoBpm: 60,
        key: "C major",
        durationSec: 4,
        sections: [{ name: "A", bars: 1, intensity: 0.5 }],
        parts: { piano_right_hand: [], piano_left_hand: [{ track: "piano_left_hand", midi: 48, startBeat: 0, durationBeats: 1, velocity: 60 }] },
        chordMap: [{ bar: 1, chord: "C" }]
      }, ctx),
      (err) => err instanceof Error || (typeof err === "object" && err !== null),
      "empty piano_right_hand must be rejected"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate_music_audition_distinctness: fails near-identical versions, passes genuinely different ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-distinctness-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Distinctness Test", createdByClientId: "composer" });
    const validator = getToolModule("validate_music_audition_distinctness");
    assert.ok(validator, "validate_music_audition_distinctness must be registered");

    // Build two near-identical manifests (same notes, same chords)
    const makeManifest = (filename: string, transpose = 0) => writeProjectFile(ctx.projectRoot, project.id, filename, JSON.stringify({
      title: "Test", style: "score_import", mood: "test", tempo: 90, key: "C major",
      durationSeconds: 8, loopable: false, instruments: ["piano_right_hand", "piano_left_hand"],
      sections: [{ name: "A", bars: 2, intensity: 0.5 }],
      chordProgression: ["Cmaj7", "Am7", "Dm7", "G7"],
      tracks: {
        piano_right_hand: [
          { track: "piano_right_hand", midi: 60 + transpose, startBeat: 0, durationBeats: 1, velocity: 80 },
          { track: "piano_right_hand", midi: 62 + transpose, startBeat: 1, durationBeats: 1, velocity: 78 },
          { track: "piano_right_hand", midi: 64 + transpose, startBeat: 2, durationBeats: 1, velocity: 76 },
          { track: "piano_right_hand", midi: 65 + transpose, startBeat: 3, durationBeats: 1, velocity: 74 }
        ],
        piano_left_hand: [
          { track: "piano_left_hand", midi: 48 + transpose, startBeat: 0, durationBeats: 2, velocity: 65 },
          { track: "piano_left_hand", midi: 52 + transpose, startBeat: 2, durationBeats: 2, velocity: 65 }
        ]
      },
      compositionPlan: { form: [{ name: "A", bars: 2, role: "main", targetIntensity: 0.5 }], motifs: [{ id: "m1", contour: "test", rhythm: "q", development: [] }], energyCurve: [0.5, 0.5], arrangementIntent: [] },
      performance: { humanized: true, timingJitterBeats: 0, velocityJitter: 0, sustainPedal: [], rubatoMap: [] },
      license: { output: "generated_from_user_or_project_score", dependencies: [] },
      scoreSource: { format: "handwritten", scoreDriven: true, partCount: 2, noteCount: 6, trackInstruments: {} },
      authoringMode: "strict_handwritten"
    }, null, 2) + "\n");

    // Near-identical pair (transpose=0 vs 0)
    await makeManifest("music/v1.json", 0);
    await makeManifest("music/v2-same.json", 0);

    const failResult = await validator!.handler({
      projectId: project.id,
      manifestPaths: ["music/v1.json", "music/v2-same.json"],
      minDistinctnessScore: 0.65,
      requireDifferentMelody: true,
      requireDifferentChordMap: true
    }, ctx);
    assert.equal(failResult.ok, false, "identical manifests must fail distinctness check");
    const failPayload = failResult.structuredContent as { pairs: Array<{ ok: boolean; distinctnessScore: number }> };
    assert.ok(failPayload.pairs.length >= 1);
    assert.equal(failPayload.pairs[0].ok, false);
    assert.ok(failPayload.pairs[0].distinctnessScore < 0.65, `distinctness score ${failPayload.pairs[0].distinctnessScore} should be < 0.65 for identical versions`);

    // Genuinely different pair: v1 vs v3 with 12 semitone transpose (octave) AND different chord map
    await writeProjectFile(ctx.projectRoot, project.id, "music/v3-different.json", JSON.stringify({
      title: "Variation B", style: "score_import", mood: "test", tempo: 120, key: "G minor",
      durationSeconds: 8, loopable: false, instruments: ["piano_right_hand", "piano_left_hand"],
      sections: [{ name: "intro", bars: 1, intensity: 0.3 }, { name: "B", bars: 1, intensity: 0.7 }],
      chordProgression: ["Gm", "Eb", "F", "Bb"],
      tracks: {
        piano_right_hand: [
          { track: "piano_right_hand", midi: 74, startBeat: 0, durationBeats: 2, velocity: 90 },
          { track: "piano_right_hand", midi: 79, startBeat: 2, durationBeats: 0.5, velocity: 85 },
          { track: "piano_right_hand", midi: 77, startBeat: 2.5, durationBeats: 0.5, velocity: 82 }
        ],
        piano_left_hand: [
          { track: "piano_left_hand", midi: 43, startBeat: 0, durationBeats: 4, velocity: 60 }
        ]
      },
      compositionPlan: { form: [{ name: "B", bars: 2, role: "contrast", targetIntensity: 0.7 }], motifs: [{ id: "m2", contour: "ascending", rhythm: "e.e", development: [] }], energyCurve: [0.3, 0.7], arrangementIntent: [] },
      performance: { humanized: true, timingJitterBeats: 0.02, velocityJitter: 8, sustainPedal: [], rubatoMap: [] },
      license: { output: "generated_from_user_or_project_score", dependencies: [] },
      scoreSource: { format: "handwritten", scoreDriven: true, partCount: 2, noteCount: 4, trackInstruments: {} },
      authoringMode: "strict_handwritten"
    }, null, 2) + "\n");

    const passResult = await validator!.handler({
      projectId: project.id,
      manifestPaths: ["music/v1.json", "music/v3-different.json"],
      minDistinctnessScore: 0.65,
      requireDifferentMelody: true,
      requireDifferentChordMap: true
    }, ctx);
    assert.equal(passResult.ok, true, `Different manifests should pass distinctness: errors=${JSON.stringify(passResult.errors)}`);
    const passPayload = passResult.structuredContent as { pairs: Array<{ ok: boolean; distinctnessScore: number }> };
    assert.ok(passPayload.pairs[0].distinctnessScore >= 0.65, `distinctness score ${passPayload.pairs[0].distinctnessScore} should be >= 0.65`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render_midi_with_soundfont: renderProfile=clean_dry reports noiseBedApplied=false and cleanRender=true", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-clean-dry-"));
  const oldPath = process.env.PATH;
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Clean Dry Render", createdByClientId: "composer" });
    const packManager = getToolModule("manage_jazz_instrument_packs");
    const soundfontRender = getToolModule("render_midi_with_soundfont");
    assert.ok(packManager && soundfontRender);

    await composeTestCue(ctx, {
      projectId: project.id,
      instruments: ["piano"],
      durationSeconds: 8,
      outputManifestPath: "music/cue.json",
      outputMidiPath: "music/cue.mid"
    }, ctx);

    const sf2 = fakeSoundfontBytes();
    const soundfontPath = "soundfonts/generaluser-gs/GeneralUser-GS.sf2";
    await writeProjectAsset(ctx.projectRoot, project.id, soundfontPath, sf2, "audio/soundfont");
    await writeProjectFile(ctx.projectRoot, project.id, "soundfonts/generaluser-gs/LICENSE.txt", "GeneralUser GS license fixture\n");
    await writeProjectFile(ctx.projectRoot, project.id, "soundfonts/generaluser-gs/README.md", "# GeneralUser GS fixture\n");

    await packManager!.handler({
      projectId: project.id,
      packs: [{
        packId: "generaluser_gs",
        displayName: "GeneralUser GS",
        instrumentRole: "general_midi",
        format: "soundfont",
        assetPaths: [soundfontPath],
        declaredSha256: createHash("sha256").update(sf2).digest("hex"),
        licenseType: "generaluser_gs_2_0",
        source: "https://github.com/mrbumpy409/GeneralUser-GS",
        sourceUrl: "https://github.com/mrbumpy409/GeneralUser-GS",
        licenseTextPath: "soundfonts/generaluser-gs/LICENSE.txt",
        readmePath: "soundfonts/generaluser-gs/README.md",
        commercialUseAllowed: true,
        redistributionAllowed: true,
        productionUseApproved: true,
        qualityTier: "production_candidate"
      }]
    }, ctx);

    process.env.PATH = `${await installFakeFluidSynth(root)}:${oldPath}`;
    const cleanDryResult = await soundfontRender!.handler({
      projectId: project.id,
      compositionManifestPath: "music/cue.json",
      soundfontPackId: "generaluser_gs",
      renderProfile: "clean_dry",
      outputAudioPath: "music/clean-dry.wav",
      outputReportPath: "music/clean-dry-report.json"
    }, ctx);

    assert.equal(cleanDryResult.ok, true, `clean_dry render should succeed: ${JSON.stringify(cleanDryResult.errors)}`);
    const cleanPayload = cleanDryResult.structuredContent as {
      noiseBedApplied: boolean; cleanRender: boolean; renderProfile: string; normalized: boolean;
    };
    assert.equal(cleanPayload.noiseBedApplied, false, "clean_dry must report noiseBedApplied=false");
    assert.equal(cleanPayload.cleanRender, true, "clean_dry must report cleanRender=true");
    assert.equal(cleanPayload.renderProfile, "clean_dry");
    assert.equal(cleanPayload.normalized, false, "clean_dry must not apply loudnorm");
  } finally {
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect_audio_quality: accepts strict_handwritten manifest without plan/performance penalty (scoreSource.scoreDriven=true)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "music-qa-scoredrive-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "QA ScoreDriven", createdByClientId: "composer" });
    const inspect = getToolModule("inspect_audio_quality");
    assert.ok(inspect, "inspect_audio_quality must be registered");

    // Write a manifest that simulates an author_handwritten_music_score output
    // (has scoreSource.scoreDriven=true and authoringMode=strict_handwritten, with plan+performance)
    const manifest = {
      title: "Test Score", style: "strict_handwritten_solo_piano", mood: "test", tempo: 80, key: "D minor",
      durationSeconds: 8, loopable: false, instruments: ["piano_right_hand", "piano_left_hand"],
      sections: [{ name: "A", bars: 2, intensity: 0.5 }],
      chordProgression: ["Dm", "A7", "Dm", "A7"],
      tracks: {
        piano_right_hand: [
          { track: "piano_right_hand", midi: 62, startBeat: 0, durationBeats: 1, velocity: 80 },
          { track: "piano_right_hand", midi: 64, startBeat: 1, durationBeats: 1, velocity: 75 },
          { track: "piano_right_hand", midi: 65, startBeat: 2, durationBeats: 1, velocity: 78 },
          { track: "piano_right_hand", midi: 69, startBeat: 3, durationBeats: 1, velocity: 82 }
        ],
        piano_left_hand: [
          { track: "piano_left_hand", midi: 38, startBeat: 0, durationBeats: 2, velocity: 65 },
          { track: "piano_left_hand", midi: 41, startBeat: 2, durationBeats: 2, velocity: 68 }
        ]
      },
      compositionPlan: {
        form: [{ name: "A", bars: 2, role: "main", targetIntensity: 0.5 }],
        motifs: [{ id: "rh_melody", contour: "handwritten", rhythm: "score-notated", development: ["as authored"] }],
        energyCurve: [0.5, 0.5],
        arrangementIntent: ["render as notated"]
      },
      performance: { humanized: true, timingJitterBeats: 0.01, velocityJitter: 5, sustainPedal: [], rubatoMap: [] },
      license: { output: "generated_from_user_or_project_score", dependencies: [] },
      scoreSource: { format: "handwritten", scoreDriven: true, partCount: 2, noteCount: 6, trackInstruments: {} },
      authoringMode: "strict_handwritten"
    };
    await writeProjectFile(ctx.projectRoot, project.id, "music/handwritten-manifest.json", JSON.stringify(manifest, null, 2) + "\n");

    const qaResult = await inspect!.handler({
      projectId: project.id,
      compositionManifestPath: "music/handwritten-manifest.json",
      useCase: "solo piano audition",
      checkLoop: false,
      outputPath: "music/qa-report.json"
    }, ctx);

    // Should not have "high" severity findings for missing plan/performance (those are injected for score-driven)
    const qaPayload = qaResult.structuredContent as {
      findings: Array<{ severity: string; category: string; message: string }>;
      musicalityReport: { hasPlan: boolean; hasHumanizedPerformance: boolean };
    };
    assert.equal(qaPayload.musicalityReport.hasPlan, true, "hasPlan must be true when compositionPlan is present");
    assert.equal(qaPayload.musicalityReport.hasHumanizedPerformance, true, "hasHumanizedPerformance must be true when performance.humanized=true");
    const highPerfFindings = qaPayload.findings.filter((f) => f.severity === "high" && f.category === "performance");
    assert.equal(highPerfFindings.length, 0, `No high-severity performance finding expected for strict_handwritten: ${JSON.stringify(highPerfFindings)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("music-workflow skill requires handwritten MusicXML import and Salamander rendering path", () => {
  const music = skillRegistry.find((skill) => skill.id === "music-workflow");
  assert.ok(music, "music-workflow skill must exist in registry");
  assert.ok(music!.toolNames.includes("import_musicxml_score"), "import_musicxml_score must be in toolNames");
  assert.ok(music!.toolNames.includes("author_handwritten_music_score"), "author_handwritten_music_score must be in toolNames");
  assert.ok(music!.toolNames.includes("validate_music_audition_distinctness"), "validate_music_audition_distinctness must be in toolNames");
  assert.ok(music!.toolNames.includes("validate_music_ensemble"), "validate_music_ensemble must be in toolNames");
  assert.ok(music!.toolNames.includes("validate_music_constraints"), "validate_music_constraints must be in toolNames");
  assert.ok(music!.toolNames.includes("validate_music_development"), "validate_music_development must be in toolNames");
  assert.ok(music!.toolNames.includes("create_music_production"), "create_music_production must be in toolNames");
  assert.equal(music!.toolNames.includes("compose_music"), false, "generic compose_music must not be exposed");
  const protocol = music!.protocolMarkdown;
  assert.ok(protocol.includes("author the score itself as explicit MusicXML"), "protocolMarkdown must require agent-authored MusicXML");
  assert.ok(protocol.includes("soundfontPackId=\"salamander_grand\""), "protocolMarkdown must require Salamander rendering for piano");
  assert.ok(protocol.includes("author_handwritten_music_score"), "protocolMarkdown must mention author_handwritten_music_score");
  assert.ok(protocol.includes("validate_music_audition_distinctness"), "protocolMarkdown must mention validate_music_audition_distinctness");
  assert.ok(protocol.includes("validate_music_constraints"), "protocolMarkdown must require hard music constraint validation");
  assert.ok(protocol.includes("validate_music_development"), "protocolMarkdown must require long-form development validation");
  assert.ok(protocol.includes("create_music_production"), "protocolMarkdown must mention the one-call production orchestrator");
  assert.equal(protocol.includes("Rough sketch"), false, "generic compose_music rough-sketch guidance must be removed");
});

test("edit_midi: bassRepair raises LH notes below C3, scales velocity, caps duration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "edit-midi-bass-repair-"));
  try {
    const ctx = toolContext(root);
    const project = await createProject(ctx.projectRoot, { title: "Bass repair test", createdByClientId: "test" });
    const edit = getToolModule("edit_midi");
    assert.ok(edit, "edit_midi registered");

    // Compose a minimal manifest with piano_left_hand notes spanning above and below C3 (MIDI 48).
    const composition = {
      title: "Bass Repair Test",
      tempo: 90,
      key: "C",
      style: "jazz",
      durationSeconds: 8,
      loopable: false,
      instruments: ["piano_right_hand", "piano_left_hand"],
      sections: [{ name: "A", startBeat: 0, endBeat: 16 }],
      tracks: {
        piano_right_hand: [
          { track: "piano_right_hand", midi: 60, startBeat: 0, durationBeats: 1, velocity: 80 },
          { track: "piano_right_hand", midi: 64, startBeat: 1, durationBeats: 1, velocity: 80 }
        ],
        piano_left_hand: [
          { track: "piano_left_hand", midi: 40, startBeat: 0, durationBeats: 3, velocity: 90 },  // below C3 → should rise
          { track: "piano_left_hand", midi: 36, startBeat: 2, durationBeats: 4, velocity: 85 },  // below C3 → should rise
          { track: "piano_left_hand", midi: 52, startBeat: 4, durationBeats: 1, velocity: 88 }   // above C3 → untouched
        ]
      }
    };
    await writeProjectFile(ctx.projectRoot, project.id, "music/test-manifest.json", JSON.stringify(composition, null, 2));

    const result = await edit!.handler({
      projectId: project.id,
      compositionManifestPath: "music/test-manifest.json",
      bassRepair: true,
      bassRepairConfig: { raiseBelowMidi: 48, velocityScale: 0.72, maxDurationBeats: 1.5 },
      outputManifestPath: "music/repaired-manifest.json",
      outputMidiPath: "music/repaired.mid"
    }, ctx);

    assert.equal(result.ok, true, "bassRepair edit should succeed");
    const payload = result.structuredContent as {
      tracks: { piano_right_hand: Array<{ midi: number; velocity: number; durationBeats: number }>; piano_left_hand: Array<{ midi: number; velocity: number; durationBeats: number }> };
      bassRepairLog: Array<{ track: string; midi: number; beat: number; change: string }>;
    };

    // LH note at MIDI 40 → should be raised to 52, velocity 90×0.72=64, duration capped at 1.5
    const lh = payload.tracks.piano_left_hand;
    assert.equal(lh[0].midi, 52, "MIDI 40 should be raised to 52");
    assert.equal(lh[0].velocity, Math.round(90 * 0.72), "velocity should be scaled by 0.72");
    assert.equal(lh[0].durationBeats, 1.5, "duration capped at 1.5");

    // LH note at MIDI 36 → should be raised to 48, velocity 85×0.72=61, duration capped
    assert.equal(lh[1].midi, 48, "MIDI 36 should be raised to 48");
    assert.equal(lh[1].velocity, Math.round(85 * 0.72), "velocity scaled");
    assert.equal(lh[1].durationBeats, 1.5, "duration capped");

    // LH note at MIDI 52 → untouched (above threshold)
    assert.equal(lh[2].midi, 52, "MIDI 52 above threshold, untouched");
    assert.equal(lh[2].velocity, 88, "velocity untouched above threshold");

    // RH notes untouched
    const rh = payload.tracks.piano_right_hand;
    assert.equal(rh[0].midi, 60, "RH note untouched");

    // bassRepairLog has exactly the two below-C3 notes
    assert.equal(payload.bassRepairLog.length, 2, "exactly 2 notes repaired");
    assert.equal(payload.bassRepairLog[0].midi, 40, "log records original MIDI 40");
    assert.equal(payload.bassRepairLog[1].midi, 36, "log records original MIDI 36");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("render_midi_with_soundfont: ENOENT on missing midiPath returns structured nextAction error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "render-enoent-"));
  const ffmpegBin = await installFakeFfmpeg(root);
  const origPath = process.env.PATH;
  try {
    const ctx = toolContext(root);
    process.env.PATH = `${ffmpegBin}:${origPath}`;
    const project = await createProject(ctx.projectRoot, { title: "ENOENT test", createdByClientId: "test" });
    const soundfontRender = getToolModule("render_midi_with_soundfont");
    assert.ok(soundfontRender, "render_midi_with_soundfont registered");

    // Register a fake soundfont so the render gets past soundfont resolution.
    // Must supply all production_candidate fields so productionRenderBlockersForPack returns [].
    const packManager = getToolModule("manage_jazz_instrument_packs");
    assert.ok(packManager, "manage_jazz_instrument_packs registered");
    const sfPath = "assets/fake.sf2";
    const licensePath = "assets/fake-license.md";
    await writeProjectAsset(ctx.projectRoot, project.id, sfPath, fakeSoundfontBytes(), "audio/soundfont");
    await writeProjectFile(ctx.projectRoot, project.id, licensePath, "MIT License");
    await packManager!.handler({
      projectId: project.id,
      packs: [{
        packId: "test_sf2",
        displayName: "Test SF2",
        instrumentRole: "general_midi",
        format: "soundfont",
        assetPaths: [sfPath],
        licenseType: "mit",
        source: "https://example.com/fake.sf2",
        sourceUrl: "https://example.com/fake.sf2",
        licenseTextPath: licensePath,
        commercialUseAllowed: true,
        productionUseApproved: true,
        qualityTier: "production_candidate"
      }]
    }, ctx);

    // Call render with a midiPath that does NOT exist in project storage
    const result = await soundfontRender!.handler({
      projectId: project.id,
      midiPath: "music/nonexistent.mid",
      soundfontPackId: "test_sf2",
      outputAudioPath: "music/out.wav"
    }, ctx);

    // Should NOT throw; should return a structured failure with nextAction
    assert.equal(result.ok, false, "render should fail cleanly on ENOENT");
    const payload = result.structuredContent as { missingMidiPath?: string; nextAction?: string; hint?: string };
    assert.equal(payload.missingMidiPath, "music/nonexistent.mid", "missingMidiPath reported");
    assert.ok(payload.nextAction?.includes("write_project_asset"), "nextAction should mention write_project_asset");
    assert.ok(payload.hint, "hint should be present");
  } finally {
    process.env.PATH = origPath;
    await rm(root, { recursive: true, force: true });
  }
});
