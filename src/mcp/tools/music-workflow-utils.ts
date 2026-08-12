import { createHash } from "node:crypto";

// Leaf utilities extracted from music-workflow.ts: pure functions with no
// dependency on the rest of that file, split out to shrink the monolith.
// Keep this file dependency-free of music-workflow.ts to avoid import cycles.

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
export function fifthsFromKeyName(key: string): { fifths: number; mode: "major" | "minor" } {
  for (const [fifths, name] of Object.entries(keyNamesByFifthsMinor)) {
    if (name.toLowerCase() === key.toLowerCase()) return { fifths: Number(fifths), mode: "minor" };
  }
  for (const [fifths, name] of Object.entries(keyNamesByFifths)) {
    if (name.toLowerCase() === key.toLowerCase()) return { fifths: Number(fifths), mode: "major" };
  }
  return { fifths: 0, mode: "major" };
}

export function keyNameFromFifths(fifths: number, mode: string | undefined): string | undefined {
  const table = mode?.toLowerCase() === "minor" ? keyNamesByFifthsMinor : keyNamesByFifths;
  return table[fifths];
}

// MIDI number → MusicXML <pitch> element (prefer naturals + sharps)
export function midiToPitchXml(midi: number): string {
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

// Standard note-value table in beats, where 1 beat = one quarter note (matches this file's
// DIVISIONS/BEATS_PER_BAR convention). Ordered longest-first so exact and dotted matches are
// checked at each duration before falling through to a shorter one.
const noteTypeDurationTable: Array<[number, string]> = [
  [4, "whole"], [2, "half"], [1, "quarter"], [0.5, "eighth"], [0.25, "16th"], [0.125, "32nd"]
];

// Map a note/rest duration (in beats) to its MusicXML <type> + dotted flag. Irregular durations
// (e.g. tuplets) fall back to the closest table entry rather than throwing, since this is a
// display hint only — <duration> (already in divisions) remains the source of truth for timing.
function noteTypeFromDurationBeats(durationBeats: number): { type: string; dotted: boolean } {
  for (const [beats, type] of noteTypeDurationTable) {
    if (Math.abs(durationBeats - beats) < 0.01) return { type, dotted: false };
    if (Math.abs(durationBeats - beats * 1.5) < 0.01) return { type, dotted: true };
  }
  let closest = noteTypeDurationTable[2];
  let bestDiff = Infinity;
  for (const entry of noteTypeDurationTable) {
    const diff = Math.abs(durationBeats - entry[0]);
    if (diff < bestDiff) { bestDiff = diff; closest = entry; }
  }
  return { type: closest[1], dotted: false };
}

function noteTypeXml(durationBeats: number): string {
  const { type, dotted } = noteTypeFromDurationBeats(durationBeats);
  return `<type>${type}</type>${dotted ? "<dot/>" : ""}`;
}

function tieXml(tieStart: boolean | undefined, tieStop: boolean | undefined): string {
  let xml = "";
  if (tieStop) xml += `<tie type="stop"/>`;
  if (tieStart) xml += `<tie type="start"/>`;
  if (tieStart || tieStop) {
    const notations = `${tieStop ? `<tied type="stop"/>` : ""}${tieStart ? `<tied type="start"/>` : ""}`;
    xml += `<notations>${notations}</notations>`;
  }
  return xml;
}

// Split any note whose duration crosses a bar boundary into per-bar fragments carrying
// tieStart/tieStop flags, so buildMeasureNotesXml's per-measure filter (which only looks at a
// single [measureStart, measureEnd) window) never has to silently truncate a note's tail.
export function splitNotesAcrossBars<T extends { midi: number; startBeat: number; durationBeats: number; velocity: number }>(
  notes: T[],
  beatsPerBar: number
): Array<T & { tieStart?: boolean; tieStop?: boolean }> {
  const fragments: Array<T & { tieStart?: boolean; tieStop?: boolean }> = [];
  for (const note of notes) {
    let cursor = note.startBeat;
    let remaining = note.durationBeats;
    let isFirstFragment = true;
    while (remaining > 0.001) {
      const barEnd = (Math.floor(cursor / beatsPerBar) + 1) * beatsPerBar;
      const chunkBeats = Math.min(remaining, barEnd - cursor);
      const hasMore = remaining - chunkBeats > 0.001;
      fragments.push({ ...note, startBeat: cursor, durationBeats: chunkBeats, tieStart: hasMore, tieStop: !isFirstFragment });
      cursor += chunkBeats;
      remaining -= chunkBeats;
      isFirstFragment = false;
    }
  }
  return fragments;
}

// Build MusicXML note elements for one measure of one part.
// Returns rest-filled measure content so the measure is always metrically complete.
export function buildMeasureNotesXml(
  notes: Array<{ midi: number; startBeat: number; durationBeats: number; velocity: number; tieStart?: boolean; tieStop?: boolean }>,
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
          xml += `<note><rest/><duration>${gapDiv}</duration>${noteTypeXml(gapDiv / divisions)}<voice>1</voice></note>`;
          usedDivisions += gapDiv;
        }
      }
    }

    const remaining = totalDivisions - usedDivisions;
    const noteDiv = Math.min(remaining, Math.max(1, Math.round(note.durationBeats * divisions)));
    if (noteDiv <= 0) continue;

    const chordTag = isChord ? "<chord/>" : "";
    xml += `<note>${chordTag}${midiToPitchXml(note.midi)}<duration>${noteDiv}</duration>${tieXml(note.tieStart, note.tieStop)}${noteTypeXml(noteDiv / divisions)}<voice>1</voice></note>`;
    if (!isChord) {
      usedDivisions += noteDiv;
      prevBeat = note.startBeat + note.durationBeats;
    }
  }

  // Trailing rest to fill remaining measure
  const trailingDiv = totalDivisions - usedDivisions;
  if (trailingDiv > 0) {
    xml += `<note><rest/><duration>${trailingDiv}</duration>${noteTypeXml(trailingDiv / divisions)}<voice>1</voice></note>`;
  }

  return xml;
}

// Build a minimal but valid MusicXML document from RH/LH note arrays.
export function buildHandwrittenMusicXml(params: {
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
    const fragments = splitNotesAcrossBars(notes, BEATS_PER_BAR);
    let measuresXml = "";
    for (let bar = 0; bar < params.totalBars; bar++) {
      const measureStart = bar * BEATS_PER_BAR;
      const notesXml = buildMeasureNotesXml(fragments, measureStart, BEATS_PER_BAR, DIVISIONS, bar === 0, params.tempoBpm, keyXml);
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

export function varLen(value: number) {
  const bytes = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}

export function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

export function slugifyMusicExportPart(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "music-export";
}

export function sha256Hex(data: Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

export type PcmWavInfo = { sampleRate: number; bitDepth: number; channelCount: number; dataOffset: number; dataBytes: number };

export function parsePcmWav(buffer?: Buffer): { ok: true; info: PcmWavInfo } | { ok: false; reason: string } {
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

export function assertPcmWav(buffer: Buffer, label: string): PcmWavInfo {
  const parsed = parsePcmWav(buffer);
  if (!parsed.ok) throw new Error(`${label} must be a readable PCM WAV file: ${parsed.reason}`);
  return parsed.info;
}

export type WavSilenceGap = { startSeconds: number; durationSeconds: number };

/**
 * Return silence gaps that overlap the intended programme by at least one second.
 *
 * `wavAnalysis` deliberately keeps every measured gap in `technicalReport`. Renderers
 * commonly append a release tail or codec-alignment padding after a non-looping piece's
 * declared duration, however, and that tail is not an arrangement defect. Loopable audio
 * keeps the stricter rule because silence at the end becomes an audible loop seam.
 */
export function actionableSilenceGaps(
  gaps: readonly WavSilenceGap[],
  options: { declaredDurationSeconds?: number; loopable: boolean }
) {
  if (options.loopable || !Number.isFinite(options.declaredDurationSeconds)) return [...gaps];
  const declaredDurationSeconds = Math.max(0, options.declaredDurationSeconds ?? 0);
  return gaps.filter((gap) => {
    const interiorEnd = Math.min(gap.startSeconds + gap.durationSeconds, declaredDurationSeconds);
    return interiorEnd - gap.startSeconds >= 1;
  });
}

type NoiseFloorEstimate = {
  rms: number;
  candidateBlockCount: number;
  noiseLikeBlockRatio: number;
  relativeSpread: number;
  medianZeroCrossingRatio: number;
  medianNormalizedDifference: number;
  detected: boolean;
};

const noiseFloorThresholds = {
  lowerEnvelopeFraction: 0.25,
  minimumCandidateBlocks: 4,
  maximumRelativeSpread: 0.35,
  minimumNoiseLikeBlockRatio: 0.60,
  minimumZeroCrossingRatio: 0.12,
  minimumNormalizedDifference: 0.45
} as const;

function percentile(sorted: readonly number[], fraction: number) {
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)));
  return sorted[index];
}

/**
 * Estimate a persistent broadband floor from stable, low-energy, noise-textured blocks.
 * A low RMS percentile alone is not a noise estimate: in expressive music it mostly
 * selects quiet notes and decays. The estimator therefore requires the lower envelope
 * to be both level-stable and dominated by high zero-crossing/sample-difference texture.
 */
function estimateNoiseFloor(
  blockRms: readonly number[],
  blockZeroCrossingRatio: readonly number[],
  blockNormalizedDifference: readonly number[]
): NoiseFloorEstimate {
  const audibleIndexes = blockRms
    .map((rms, index) => ({ rms, index }))
    .filter(({ rms }) => rms >= 0.002);
  const sortedAudibleRms = audibleIndexes.map(({ rms }) => rms).sort((a, b) => a - b);
  if (sortedAudibleRms.length < 4) {
    return { rms: 0, candidateBlockCount: sortedAudibleRms.length, noiseLikeBlockRatio: 0, relativeSpread: 0, medianZeroCrossingRatio: 0, medianNormalizedDifference: 0, detected: false };
  }

  const lowerEnvelopeLimit = percentile(sortedAudibleRms, noiseFloorThresholds.lowerEnvelopeFraction);
  const candidates = audibleIndexes.filter(({ rms }) => rms <= lowerEnvelopeLimit);
  const candidateRms = candidates.map(({ rms }) => rms).sort((a, b) => a - b);
  const medianRms = percentile(candidateRms, 0.5);
  const lowerQuartileRms = percentile(candidateRms, 0.25);
  const upperQuartileRms = percentile(candidateRms, 0.75);
  const relativeSpread = medianRms > 0 ? (upperQuartileRms - lowerQuartileRms) / medianRms : Number.POSITIVE_INFINITY;
  const candidateZeroCrossingRatios = candidates.map(({ index }) => blockZeroCrossingRatio[index] ?? 0).sort((a, b) => a - b);
  const candidateNormalizedDifferences = candidates.map(({ index }) => blockNormalizedDifference[index] ?? 0).sort((a, b) => a - b);
  const medianZeroCrossingRatio = percentile(candidateZeroCrossingRatios, 0.5);
  const medianNormalizedDifference = percentile(candidateNormalizedDifferences, 0.5);
  const noiseLikeBlocks = candidates.filter(({ index }) =>
    (blockZeroCrossingRatio[index] ?? 0) >= noiseFloorThresholds.minimumZeroCrossingRatio &&
    (blockNormalizedDifference[index] ?? 0) >= noiseFloorThresholds.minimumNormalizedDifference
  ).length;
  const noiseLikeBlockRatio = noiseLikeBlocks / Math.max(1, candidates.length);
  const detected =
    candidates.length >= noiseFloorThresholds.minimumCandidateBlocks &&
    relativeSpread <= noiseFloorThresholds.maximumRelativeSpread &&
    noiseLikeBlockRatio >= noiseFloorThresholds.minimumNoiseLikeBlockRatio;
  return {
    rms: detected ? medianRms : 0,
    candidateBlockCount: candidates.length,
    noiseLikeBlockRatio,
    relativeSpread: Number.isFinite(relativeSpread) ? relativeSpread : 0,
    medianZeroCrossingRatio,
    medianNormalizedDifference,
    detected
  };
}

export function wavAnalysis(buffer?: Buffer) {
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
      noiseFloorEstimate: { method: "stable_low_energy_noise_blocks", thresholds: noiseFloorThresholds, candidateBlockCount: 0, noiseLikeBlockRatio: 0, relativeSpread: 0, medianZeroCrossingRatio: 0, medianNormalizedDifference: 0, detected: false },
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
  const blockZeroCrossingRatio: number[] = [];
  const blockNormalizedDifference: number[] = [];
  let blockSum = 0;
  let blockCount = 0;
  let blockZeroCrossings = 0;
  let blockDifferenceSum = 0;
  let previousMono = 0;
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
    if (frame > 0) {
      const difference = Math.abs(mono - previousMono);
      highDiffSum += difference;
      blockDifferenceSum += difference;
      if ((mono >= 0) !== (previousMono >= 0)) blockZeroCrossings += 1;
    }
    previousMono = mono;
    lowPass = lowPass * 0.995 + mono * 0.005;
    bassSum += Math.abs(lowPass);
    blockSum += mono * mono;
    blockCount += 1;
    if (blockCount >= blockSize) {
      const rms = Math.sqrt(blockSum / blockCount);
      blockRms.push(rms);
      blockZeroCrossingRatio.push(blockZeroCrossings / Math.max(1, blockCount - 1));
      blockNormalizedDifference.push(rms > 0 ? blockDifferenceSum / Math.max(1, blockCount - 1) / rms : 0);
      blockSum = 0;
      blockCount = 0;
      blockZeroCrossings = 0;
      blockDifferenceSum = 0;
    }
  }
  if (blockCount) {
    const rms = Math.sqrt(blockSum / blockCount);
    blockRms.push(rms);
    blockZeroCrossingRatio.push(blockZeroCrossings / Math.max(1, blockCount - 1));
    blockNormalizedDifference.push(rms > 0 ? blockDifferenceSum / Math.max(1, blockCount - 1) / rms : 0);
  }
  const rms = Math.sqrt(rmsSum / Math.max(1, frameCount));
  const sortedBlocks = [...blockRms].sort((a, b) => a - b);
  const audibleSortedBlocks = sortedBlocks.filter((value) => value >= 0.002);
  const quietSignalRms = percentile(audibleSortedBlocks, 0.1);
  const noiseFloorEstimate = estimateNoiseFloor(blockRms, blockZeroCrossingRatio, blockNormalizedDifference);
  const noiseFloorRms = noiseFloorEstimate.rms;
  const loudestBlock = sortedBlocks[sortedBlocks.length - 1] ?? 0;
  const dynamicRange = loudestBlock && quietSignalRms ? 20 * Math.log10(loudestBlock / Math.max(0.000001, quietSignalRms)) : 0;
  const silenceGaps: WavSilenceGap[] = [];
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
    noiseFloorEstimate: {
      method: "stable_low_energy_noise_blocks",
      thresholds: noiseFloorThresholds,
      candidateBlockCount: noiseFloorEstimate.candidateBlockCount,
      noiseLikeBlockRatio: Number(noiseFloorEstimate.noiseLikeBlockRatio.toFixed(3)),
      relativeSpread: Number(noiseFloorEstimate.relativeSpread.toFixed(3)),
      medianZeroCrossingRatio: Number(noiseFloorEstimate.medianZeroCrossingRatio.toFixed(3)),
      medianNormalizedDifference: Number(noiseFloorEstimate.medianNormalizedDifference.toFixed(3)),
      detected: noiseFloorEstimate.detected
    },
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

export function audioStats(buffer: Buffer) {
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

export function normalizeWav(buffer: Buffer, targetRms: number) {
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

export function limitWav(buffer: Buffer, ceiling: number) {
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
