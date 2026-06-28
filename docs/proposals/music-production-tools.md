# Proposal: three tools to reach production / business-grade music for pure-MCP agents

**Status:** draft / PR-ready spec · **Author:** generated from the 2026-06-28 "Lantern on Still Water" production session · **Scope:** `src/mcp/tools/music-workflow.ts`

## Why

A pure-MCP agent (ChatGPT, etc.) can only call code-mcp tools — it has **no shell, no python, no ffmpeg of its own**. During the 2026-06-28 session, reaching a production-grade result required escaping the toolset into scratchpad scripts (numpy convolution, hand-written CC64 MIDI, a hand-built phrase-velocity curve, external `ffmpeg loudnorm`). **Every one of those escapes is a missing tool.** Today a pure-MCP agent stalls at a dry, quiet, flat-velocity render.

The **litmus test** for this proposal: anything the session did *outside* code-mcp becomes a native tool, so an agent with no shell can walk the full chain — compose → perform → instrument → space → master → license → publish.

This proposal covers the three highest-leverage gaps, in recommended PR order (cheapest/highest-confidence first).

---

## Empirically settled before speccing: the convolution mechanism

The obvious mechanism — FFmpeg's `afir` convolution filter — **is dead in the runtime ffmpeg** and must not be specced.

Evidence (ffmpeg 8.1.2, this session):
- `afir=dry=0:wet=1` with the real (direct-trimmed) hall IR → **digital silence** (peak `0.00000`).
- Pre-amping the IR by **+40 dB** before `afir` → still silence.
- `afir` with a **unit-impulse IR** (output should ≈ input) → silence.
- `afir=dry=1:wet=0` (pure dry passthrough) → silence.

`afir` is therefore a no-op/broken in this build, and its behavior is version-fragile across ffmpeg releases (and the production Docker image bundles an *older* ffmpeg than source — "merged ≠ deployed"). **Do not build tool #1 on `afir`.**

The runtime is **Node/TypeScript**; there is no numpy. The only dependency-free, version-stable mechanism is a **pure-TypeScript FFT overlap-add convolution** running in the existing Node process. The reference algorithm already exists and is verified: scratchpad `conv_reverb.py` (per-channel real-FFT multiply, RMS-matched wet/dry) produced the session's shipped audio. Porting radix-2 FFT + overlap-add to TS is standard and adds **zero new binary / Docker dependencies**.

> Per-tool rule for this doc: **state the runtime dependency and its Docker implication.** A tool that needs a binary the production image lacks fails silently the same way `afir` does.

---

## Tool 1 — `apply_convolution_reverb` (real recorded space)

**Gap.** The mastering chain's `room_ambience` stage is enum-only: it is recorded as "production intent" but **never processed** — `applyMasterChain` (`music-workflow.ts:2711`) only runs `normalizeWav` + `limitWav`. There is no real reverb and no IR. This is the single biggest "amateur vs pro" lever; the session added it entirely externally.

**Design.**
- New helper `convolveReverb(dryWav, irWav, { wetDryRms, trimDirectMs, sampleRate })` — **pure TS FFT overlap-add**, per-channel, no external process.
- Built-in pipeline (matches the verified scratchpad recipe):
  1. **Trim the direct impulse.** A real (deconvolved-sweep) IR starts with the direct burst at ≈0.3 ms; convolving it onto the dry signal comb-filters the dry (hollow/phasey). Trim ≈1 ms + 0.4 ms fade-in so only reflections+tail remain. *(This defect is invisible to loudness/HTTP checks — it only shows on a listen or a comb-proxy; `inspect_audio_quality.loopSeamClickProxy` is the available proxy.)*
  2. **Peak-normalize the IR** (predictable wet level).
  3. **Convolve, then RMS-match** the wet bus to `wetDryRms × dry_rms` (default `0.45`) so reverb *amount* is explicit, not whatever the IR's absolute energy happens to be.
  4. Sum dry + wet, peak-guard ≤ 0.99.
- Expose as a tool **and** wire it as the real implementation of the `room_ambience` master-chain stage (`music-workflow.ts:2681`).

**IR library + commercial-licensing gate (part of THIS tool, not a separate option).** The stated goal is *business use*. The session's demo IR (EchoThief "Conrad Prebys Concert Hall") is **eval-only** — EchoThief terms need per-space review. The tool must ship/accept only **CC0 / CC-BY / public-domain** IRs and auto-emit attribution through the existing `build_music_license_manifest`. Curated commercial-safe sources: OpenAIR (CC-BY concert halls/chambers), and synthesizable IRs (the session's numpy hall) which are license-free by construction. Bundle 3–4: `concert_hall`, `chamber`, `church`, `studio_plate`.

**Input schema (sketch).**
```ts
{ projectId, audioPath, irId?: enum, irPath?: string,
  wetDryRms?: number = 0.45, trimDirectMs?: number = 1.0, outputPath? }
```
**Runtime deps:** none beyond Node (pure-TS FFT). **Docker:** no image change. ✅

**Tests.** Unit: unit-impulse IR ⇒ output ≈ input (proves convolution correctness — the exact check `afir` fails); trimmed-IR wet bus RMS == `wetDryRms × dry_rms` ± ε; peak ≤ 0.99. License-gate: non-CC IR ⇒ blocking reason + no output. Golden: convolve the session dry stem, assert output within tolerance of the shipped `lantern-v2-real-hall.wav`.

---

## Tool 2 — always-on loudness / real mastering (wiring fix, lowest effort)

**Gap.** Two correct primitives exist but aren't wired together:
- `normalizeWavWithFfmpeg` (`music-workflow.ts:3594`) — real `loudnorm=I=-16:TP=-1.5:LRA=11`. **Good.**
- `applyMasterChain` (`:2711`) — uses in-memory **RMS** `normalizeWav`, *not* LUFS loudnorm, and its `room_ambience` stage is a no-op.
- `render_midi_with_soundfont` normalization is **opt-in, default `false`** → single-pack renders ship at ≈ −35 LUFS (the session's "too quiet / amateur" bug).

**Design (mostly wiring, no new DSP).**
1. Route the master chain's `loudness_normalize` stage through `normalizeWavWithFfmpeg` with a `targetLufs` param (reuse the existing `normalizeMusicLoudnessInputSchema.targetLufs`, default −16; presets: streaming −14, podcast −16, broadcast −23).
2. Make `room_ambience` call Tool 1.
3. Flip render paths to **normalize-by-default** (or auto-run loudnorm inside `render_production_music`) so no path can emit −35 LUFS. Keep an opt-out for intentionally raw stems.
4. True-peak ceiling already handled by `limitWav`; record final integrated LUFS + true-peak in the report (the session verified via `ebur128`: −15.0 LUFS / −1.5 dBFS).

**Runtime deps:** existing ffmpeg only. **Docker:** none. ✅ **Effort:** lowest of the three — start here.

**Tests.** A −35 LUFS fixture through the chain ⇒ measured integrated loudness within ±1 LU of target; true-peak ≤ ceiling; default render path produces a normalized master without an explicit flag.

---

## Tool 3 — structured performance / velocity curve (kills "robotic")

**Gap.** `performancePlanForComposition` (`music-workflow.ts:1039`) humanizes with **random jitter + fixed pedal only** (`timingJitterBeats 0.018`, `velocityJitter 7`, pedal every 4 beats @ value 96). There is no musical *shape*. The session hand-built the curve that made the line sing; the QA gate even bans robotic output (`:1958`) but the tool can't author the fix.

**Design.** Extend the performance plan with a deterministic (no-RNG) velocity curve, ported from the verified scratchpad `gen_midi_v2.py`:
- **Phrase-arc interpolation** — section dynamics interpolated *note-to-note*, not per-bar stairs.
- **Metric accents** — downbeat > beat 3 > backbeat > off-beat.
- **Melodic contour** — the melody leans louder into its high notes.
- **Voice balance** — melody projected ~30+ velocity above accompaniment so the top line sings.
- **Tightened jitter** (±2) so *shape*, not noise, carries expression.
- **Sustain pedal at channel granularity** — generalize the current `track === "piano"`-only CC64 (`:1383`) to any keyboard/multi-layer voice, re-pedaled per bar.

Measured effect from the session (old → new MIDI): velocity spread 70 → 80, std-dev 15.9 → 17.5, melody-channel mean 71 → 77; `inspect_audio_quality.mechanicalScore` stayed 0.027 (human) while dynamic range widened — i.e. wider *and* more intentional.

**Runtime deps:** none (MIDI authoring in TS). **Docker:** none. ✅

**Tests.** Assert the emitted velocity distribution widens vs the jitter-only baseline (spread + std-dev); downbeats > off-beats by the metric delta; melody mean > accompaniment mean by the voice-balance offset; pedal CC64 present on every keyboard channel; output stays deterministic across runs (golden MIDI byte-compare).

---

## Recommended PR sequencing

1. **Tool 2** (wiring loudnorm + default-on) — smallest diff, removes the −35 LUFS bug, unblocks "sounds professional" immediately.
2. **Tool 1** (`apply_convolution_reverb` + IR library + license gate) — biggest perceptual gain; Tool 2's `room_ambience` then calls it.
3. **Tool 3** (structured velocity curve + multi-channel pedal) — removes the last "robotic" residue.

Each PR is independently shippable, adds **no new runtime/Docker dependency**, and converts a verified scratchpad escape into a native tool a shell-less agent can call.

## Not in scope (already adequate, or separate)
MusicXML import, soundfont install (YDP/Salamander/GM), ensemble QA, `build_music_license_manifest`, `inspect_audio_quality`, MIDI editing. Follow-ups: install `sfizz` + ship one CC-BY SFZ pack (code path at `:3601` already exists, binary missing); per-instrument auto-mix (level/pan/EQ) that *fixes* ensemble imbalance instead of only reporting it.
