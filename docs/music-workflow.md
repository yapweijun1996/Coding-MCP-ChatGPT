# Music Workflow — Developer Deep-Dive

Audience: an engineer who has to change, debug, or extend the music tools. Everything
described here lives in one file: [`src/mcp/tools/music-workflow.ts`](../src/mcp/tools/music-workflow.ts)
(~5,300 lines). Tests are in [`tests/music-workflow.test.ts`](../tests/music-workflow.test.ts).
For the user-facing tool list and the recommended production workflow, see
[`docs/mcp-tools.md`](mcp-tools.md).

> If you only read one thing: the system never plays audio directly. It builds a
> **Composition data model**, serializes it to a **standard MIDI file**, and renders that
> MIDI through an **external sampler** (FluidSynth / sfizz) against a license-cleared
> SoundFont. Each layer has its own validation gate, and several gates **fail closed**.

---

## 1. The three-layer model

```
compose_music / import_musicxml_score / compose_edit_midi
        │  (build/edit)
        ▼
   Composition  ───────────────►  midiBuffer()  ──►  .mid  ──► FluidSynth/sfizz ──► .wav stems ──► mix/master ──► .wav + .mp3
   (JSON manifest)                (notation)                    (real audio)
        │                                                          ▲
        │                                                          │
   analyzeEnsemble() (MIDI-level gate)               jazz instrument pack registry
                                                     (license + role coverage)
```

| Layer | What it is | Key functions | Validation |
|---|---|---|---|
| **Composition** | A plain JSON object: tempo, key, sections, chord progression, and `tracks` (a map of track-name → notes). | `buildComposition`, `buildMidiComposition`, `importMusicXmlScore` | `analyzeEnsemble` (note-level) |
| **MIDI** | A standard `.mid` byte buffer, hand-encoded (no MIDI library). | `midiBuffer` | program-change bytes asserted in tests |
| **Audio** | WAV stems + full mix + MP3, produced by an external sampler. | `render_production_music`, `render_midi_with_soundfont`, `productionInstrumentRender` | per-stem RMS / silence (fail closed) |

The `Composition` type and the `tracks` shape are defined near the top of the file. A
note is `{ track, midi, startBeat, durationBeats, velocity }`.

---

## 2. Instrument identity — the SSOT catalog

Everything that needs to know "what instrument is this track?" reads one source of truth:
`instrumentCatalog`. This prevents the classic bug where import, MIDI, validation, and
stem-grouping each guess differently.

```ts
const instrumentCatalog: Record<CanonicalInstrument, { gmProgram: number; channel: number; namePatterns: RegExp[] }> = {
  electric_piano: { gmProgram: 5,  channel: 2, namePatterns: [/electric\s*piano/i, /\brhodes\b/i, ...] },
  piano:          { gmProgram: 1,  channel: 0, namePatterns: [/\bpiano\b/i, /\bkeys\b/i, ...] },
  acoustic_bass:  { gmProgram: 33, channel: 3, namePatterns: [/acoustic\s*bass/i] },
  upright_bass:   { gmProgram: 33, channel: 3, namePatterns: [/\bbass\b/i, /double\s*bass/i, ...] },
  cello:          { gmProgram: 43, channel: 5, namePatterns: [/\bcello\b/i, /violoncello/i, ...] },
  // …violin, drums, brushes, guitar, strings, pads, synth, sax_like_lead
};
```

- **GM program is 1-indexed** (General MIDI numbering). The MIDI Program Change byte is
  `gmProgram - 1`. Piano = program 1 → byte `0x00`; cello = program 43 → byte `0x2A`.
- **Order matters.** Specific entries come **before** generic ones (`electric_piano` before
  `piano`; `acoustic_bass` before `upright_bass`) because the resolver returns the *first*
  matching entry. Reorder carelessly and "Electric Piano" silently resolves to `piano`.

### Resolvers

| Function | Input | Output | Notes |
|---|---|---|---|
| `canonicalInstrumentFromName(name)` | a part name like `"Cello"` | canonical id | normalizes `_`→space first, so track keys like `electric_piano` also match (`\b` does **not** treat `_` as a boundary) |
| `canonicalInstrumentFromGmProgram(n)` | a GM program number | canonical id | family-range lookup (e.g. 41–42 → violin, 43–44 → cello) |
| `canonicalInstrumentFromTrackKey(key)` | a composition track key, possibly suffixed `_2` | canonical id | strips a trailing `_\d+` then delegates to `…FromName` |
| `resolveCanonicalInstrument({name, gmProgram})` | both hints | `{ instrument, source: "name"\|"program"\|"default" }` | **name wins** over program; defaults to `piano` and reports `source:"default"` so callers can warn |

> **Gotcha (already fixed, do not regress):** `\b` and `\s*` do not span `_`. Always go
> through `canonicalInstrumentFromName` (which replaces `_`→space) when resolving a track
> key — never test the raw regexes against an underscored key.

---

## 3. MusicXML import — preserving identity

`importMusicXmlScore` is where a real score becomes a Composition. The headline fix here:
a part named **Cello** (or carrying GM program 43) must stay a `cello` track, **not**
`piano_2`.

How it works:
1. Parse `<part-list><score-part>` into a `partId → { name, gmProgram }` map. The identity
   hints live in `<part-name>` and `<midi-instrument><midi-program>` — **not** in the
   `<part>` note nodes.
2. For each `<part>`, `resolveCanonicalInstrument(...)` picks the canonical instrument.
3. `allocateTrackKey(instrument)` assigns the track key: the first part of an instrument gets
   the bare id (`cello`), a second same-instrument part gets `cello_2`, etc. Nothing is ever
   clobbered, and a real cello is never renamed to `piano_2`.
4. The result records `scoreSource.trackInstruments` (track key → canonical instrument) so
   downstream code and tests can see the mapping.

---

## 4. MIDI serialization — `midiBuffer`

`midiBuffer(composition, { channelMap?, programMap? })` hand-encodes a type-1 MIDI file.

- **Channel:** `channelMap[track]` override → else the catalog channel → else a stable hash.
  Percussion (drums/brushes) is locked to channel 9 (GM percussion).
- **Program Change:** for each non-percussion channel it emits one `0xC0+channel, program-1`
  event at tick 0 (program from `programMap[track]` override → else the catalog). This is what
  makes a single General MIDI SoundFont voice each track as the right instrument. Program
  changes are pushed *before* the note loop so the stable `Array.sort` keeps them ahead of the
  note-on at tick 0.
- Resolution is **480 PPQ**; tempo and track-name meta events are written first.

Tests assert the exact bytes, e.g. piano `0xC0 0x00` and cello `0xC5 0x2A`, to lock the
deterministic mapping.

---

## 5. Ensemble validation — fail closed

The "fake duet" failure (cello requested, only piano delivered, or cello then piano played
sequentially) is caught by `analyzeEnsemble`, a **pure, MIDI-level** function (no audio
needed).

`analyzeEnsemble(composition, { requiredInstruments, soloInstruments?, maxSingleInstrumentSeconds?, requireStartWithinBars?, barBeats? })` returns per-track stats
(note count, first/last note time, active ratio, silence ratio) and a list of `failures`.
It fails when:

1. **Any required instrument has zero notes** — it would render silent.
2. **The instruments never sound simultaneously** — a half-beat grid is scanned; if no cell
   has ≥2 required instruments active, it is a sequential or alternating *fake* duet, not an
   ensemble. (This is grid-based on purpose — span-overlap alone would pass an alternating
   duet.)
3. **A long stretch contains only one instrument** that is not listed in `soloInstruments`.
4. (Optional) An instrument does not enter within `requireStartWithinBars`.

### Where the gate is wired

| Surface | Behavior |
|---|---|
| `validate_music_ensemble` tool | standalone validator; returns `ok:false` with `failures` when the ensemble is not real |
| `compose_music` / `compose_edit_midi` `ensembleRequirement` (opt-in) | when present, runs `analyzeEnsemble` between computation and the `ok:true` return, flipping to `ok:false` on failure |

> **Why opt-in, not always-on:** a `solo_track` operation legitimately produces a zero-note
> track. A blanket "zero notes → fail" would break valid solo/mute flows. The gate only fires
> when the caller *declares* an ensemble.

---

## 6. Composition generation — `buildComposition`

`buildComposition` turns a `compose_music` request into notes. It has per-instrument
generators guarded by flags: `hasPiano`, `hasBass`, `hasDrums`, `hasPad`, `hasLead`,
`hasCello`. **A requested instrument with no generator produces no track** — which is exactly
why `compose_music` with `["piano","cello"]` used to yield piano only until the `hasCello`
branch was added.

The cello generator emits a sustained voice in cello register (≈ MIDI 36–72) entering at
**every bar start**, so it overlaps the piano from bar 0 and passes `analyzeEnsemble`'s
simultaneity gate (the generator and the validator must stay self-consistent).

> **Known limitation (next ticket, not a bug to "fix" silently):** `buildComposition`
> collapses `electric_piano`→`piano`, `upright_bass`/`acoustic_bass`→`bass`,
> `brushes`→`drums` at *compose* time. Identity is preserved on *import* but not yet on
> compose. `guitar`/`synth`/distinct `strings` also have no dedicated generator.

---

## 7. Production roles, stems, and pack coverage

Rendering isolates one **stem** per instrument role. Roles and the track patterns that map to
them come from one ordered SSOT, `productionRoleSpecs`, from which both
`productionRoleForTrack` (track → role) and `productionStemGroups` (role → stem tracks) are
derived — so a track's pack role and its stem assignment can never disagree.

Roles: `realistic_piano`, `upright_bass`, `brush_drums`, `cello`, `violin`,
`chamber_ensemble`, `orchestral_sketch`, `strings`, `room_ambience`, plus the special
**`general_midi`**.

### The `general_midi` keystone

A General MIDI SoundFont (e.g. GeneralUser GS) contains **every** instrument program in one
file. So one registered `general_midi` pack can cover any role:

```ts
function packCoversRole(pack, requiredRole) {
  return pack.instrumentRole === requiredRole || pack.instrumentRole === "general_midi";
}
```

Both coverage checks (`instrumentCoverageForSinglePack`, `instrumentCoverageForPackMap`) and
the per-role resolver use this. `resolveProductionPackMap` also discovers a registered
`general_midi` pack via `findGeneralMidiPackId` and uses it as the fallback for any role the
caller did not map explicitly — so **one** `install_free_soundfont_pack` renders a full
piano + cello ensemble with no per-role wiring.

> A role-specific pack still only covers its own role (a `realistic_piano` pack will **not**
> cover `cello`) — that is correct fail-closed behavior.

---

## 8. The instrument pack registry

Render tools will only use packs that are registered, hash-verified, license-clean, and in a
supported format. The registry lives at `music/jazz-instrument-packs.json` inside the project.

| Tool / function | Role |
|---|---|
| `manage_jazz_instrument_packs` / `manageJazzInstrumentPacks` | validate + register packs; **clobbers** (builds the registry from the input packs only) |
| `install_free_soundfont_pack` / `installGeneralUserGsPack` | install GeneralUser GS bytes + license/readme + SHA-256 |
| `autoRegisterInstalledGeneralMidiPack` | **issue_0145**: after install, MERGE-register the pack as `general_midi` so render can use the id immediately |
| `analyzeJazzPack` | compute risk flags + status (`ready` / `review_required` / `blocked`) |
| `resolveProductionPackMap` / `resolveProductionSoundfont` | pick the pack(s) for a render, with the GM fallback |

`install_free_soundfont_pack` now returns `autoRegistered`, `readyPackIds`, and `renderUsage`
so the user can render with `soundfontPackId="generaluser_gs"` — or with no id at all (the GM
fallback). The render-production schema deliberately has **no** "a pack selector is required"
refine, so the fallback path is reachable; the resolution layer fails closed per role if
nothing covers a role.

> `autoRegisterInstalledGeneralMidiPack` re-analyzes existing packs when it merges. A
> previously-registered pack with an empty `attribution`/`sourceUrl` could re-acquire a risk
> flag and be demoted to `review_required` — see the inline NOTE. Install's `ok` only gates on
> the GM pack, so it won't lie, but be aware when touching this.

---

## 9. Rendering — three tools, fail-closed audio

| Tool | Engine | Output | Use |
|---|---|---|---|
| `render_production_music` | FluidSynth (`.sf2/.sf3`) or sfizz (`.sfz`) | per-role stems + mixed `production.wav` + `preview.mp3` + LICENSES.md + truthful player page | **preferred** V1 production path |
| `render_midi_with_soundfont` | same | `production_candidate` WAV + optional per-track stems | lower-level renderer |
| `render_midi_to_audio` | built-in procedural synth (oscillators) | `preview_only` WAV | **scratch preview only**, fail-closed |

### issue_0143 — no procedural fallback delivered as music

`render_midi_to_audio` is the built-in "WebAudio-style" synth. It **refuses by default** and
only emits audio when called with `acknowledgePreviewOnly: true` (explicitly throwaway). Without
the flag it returns `ok:false` and points to `install_free_soundfont_pack` →
`render_production_music`. The `extend_music_arrangement` / `extend_original_music_arrangement`
tools follow the same rule for their `renderAudio` flag (they return a `previewWarning` instead
of writing fake audio).

### Per-stem silence validation

Both `render_production_music` and `render_midi_with_soundfont` compute `audioStats` (RMS,
peak) for every rendered stem. If a requested stem renders effectively silent (RMS < `0.0005`),
the render **fails closed** — a silent/missing-instrument stem can never ship in a mix.

---

## 10. The 0143 / 0144 / 0145 fix map (recent work)

| Issue | Symptom | Fix | Where |
|---|---|---|---|
| keystone | one pack can't cover a cello+piano ensemble | `general_midi` role + `packCoversRole` + GM fallback; dropped the render-selector `refine` | `packCoversRole`, `resolveProductionPackMap`, schema |
| 0145 | install succeeds but render doesn't recognize the pack | auto-register installed pack as `general_midi` | `autoRegisterInstalledGeneralMidiPack` |
| 0144 | "cello + piano" delivers piano only | generate a real cello voice + opt-in `ensembleRequirement` | `buildComposition` (`hasCello`), `compose_music` handler |
| 0143 | procedural synth delivered as fake preview | fail closed behind `acknowledgePreviewOnly` | `render_midi_to_audio`, `extend_*` handlers |

End-to-end verification (real FluidSynth + real GeneralUser GS, run in the Docker container):
piano stem and cello stem produced **distinct** audio (different RMS / sample count / md5),
and the duet stem was louder than either alone — proving real simultaneous, distinct timbres,
not the CI fake's fixed tone.

---

## 11. How to extend (recipes)

**Add a new melodic instrument (e.g. flute):**
1. Add it to the `CanonicalInstrument` / `instrumentSchema` enum.
2. Add a catalog entry (GM program, channel, name patterns) in the correct specific-before-generic order.
3. Add a GM-program family range in `canonicalInstrumentFromGmProgram`.
4. If it should render as its own stem, add a role to `productionRoleSpecs` (and the role enum + `jazzPackAllowedFormats` + `instrumentPackMap` schema — TypeScript will point you at every exhaustive map).
5. If `compose_music` should generate it, add a `hasFlute` branch to `buildComposition`.
6. Add a test: import a part named "Flute" → correct track + program-change bytes.

**Add a new render engine:** implement a `*Render` function mirroring `fluidSynthRender` /
`sfizzRender` and wire it in `productionInstrumentRender` + `rendererForPack`.

---

## 12. Testing

- `tests/music-workflow.test.ts` runs against a **fake FluidSynth** installed on `PATH`
  (`installFakeFluidSynth`) that writes a fixed sine — so it proves *routing/pipeline*
  (which roles, which channels, which stems), **not** timbre. `FAKE_FLUIDSYNTH_SILENT=1`
  forces a silent render to exercise the fail-closed silence gate.
- MIDI-level identity is proven by asserting program-change bytes in the `.mid`.
- **Timbre truth** (does a real engine voice a cello distinctly from a piano) can only be
  verified with real FluidSynth + a real GeneralUser GS `.sf2`. The deployed Docker container
  has both at `/app/soundfonts/generaluser-gs/GeneralUser-GS.sf2`; render there and compare
  stem WAVs if you need to confirm audio truth.
- Run `npm test` (typecheck + all tests) before shipping music changes.

---

## 13. The 0146 / 0147 fix map + FluidSynth 2.x + MusicXML import (PR #9)

A second wave of fixes, found while taking a score all the way to commercial-usable audio.

| Issue | Symptom | Fix | Where |
|---|---|---|---|
| 0146 | render rejects a *ready* SoundFont: "No registered ready instrument pack" | read side discovers any `music/*instrument-packs*.json` (was hardcoded to the default name); self-heal discovery also scans `assets/soundfonts` + `assets`; failure message now names what it searched | `readJazzPackRegistry`, `pickJazzPackRegistryCandidatePaths`, `resolveProductionSoundfont`, `discoverSoundfontPacksInputSchema` |
| 0147 | a missing/late voice only inferable from an absent stem | always-on `buildEnsembleQa` in `compose_music` + both render reports (instrumentsRequested/Found, missing warnings, per-voice channel/program/firstBeat, overlapFromBeat0) | `buildEnsembleQa`, `compose_music`/render handlers |
| FluidSynth 2.x | render produces **no WAV** ("illegal option at this place") | options must precede positional sf2/midi; pure `fluidSynthArgs()` puts them first | `fluidSynthArgs`, `fluidSynthRender` |
| quiet render | single-pack render is very quiet (FluidSynth default gain) | opt-in `normalize` (ffmpeg loudnorm) on `render_midi_with_soundfont`; silence gate validates the **raw** stem so loudnorm can't mask a missing voice | `normalizeWavWithFfmpeg`, render handler |
| MusicXML import | `musicXmlPath` unusable: project file allowlist rejected `.xml`/`.musicxml` | added both to `allowedTextExtensions` | `src/projects/store.ts` |
| minor key | `<mode>minor</mode>` imported as relative major (fifths=-1 → "F major") | relative-minor table + read `<mode>` | `keyNamesByFifthsMinor`, `keyNameFromFifths`, importer |

Tests: `pickJazzPackRegistryCandidatePaths`, `buildEnsembleQa` (duet + empty voice), `fluidSynthArgs`
ordering, minor-key import, `.xml`-path import — all in `tests/music-workflow.test.ts`. The fake
FluidSynth now **rejects options-after-files** (mimics 2.x), so the e2e renders fail closed on a
regression. Verified end-to-end against real FluidSynth 2.5.5.

> Loudness: `render_production_music` now finishes the production WAV with a real `ffmpeg loudnorm`
> pass (-16 LUFS / -1.5 dBTP) when ffmpeg is available (report carries `loudnessFinalizedWithFfmpeg`),
> falling back to the master-chain output otherwise — fixed in commit f532d86 (earlier builds shipped
> a quiet ~-35 LUFS proxy master). `render_midi_with_soundfont` has its own opt-in `normalize: true`.

## 14. SoundFont quality tiers — the "pro sound" levers

Timbre realism is dominated by the sample source, then by performance expression, then by space.

| SoundFont | Size | Covers | Velocity layers | Use |
|---|---|---|---|---|
| GeneralUser-GS | 32 MB | all 128 GM instruments | few | default / sketches; `install_free_soundfont_pack` |
| YDP Grand (FreePats) | 118 MB | piano only | several | real sampled Yamaha Disklavier grand, CC-BY 3.0 — best size/quality |
| Salamander Grand V3 (FreePats) | 1.27 GB | piano only | 16 | top-tier Yamaha C5, CC-BY 3.0 (FreePats SF2 build drops pedal/release/resonance noise) |

YDP/Salamander SF2 sources: <https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html>.
Register a downloaded pack with `manage_jazz_instrument_packs` (needs SHA-256, license sidecar,
`instrumentRole: realistic_piano`, CC-BY → attribution required), then render by `soundfontPackId`.

**Why bytes ≈ realism:** a real piano changes *timbre* (not just volume) from soft→hard; only
multi-velocity sampling captures that. GM stretches a few samples; YDP/Salamander are real
per-note, per-dynamic recordings.

**Levers to push past "good piano" (layered by where they live in the pipeline):**
- *Performance layer (edit MIDI/manifest):* real sustain pedal (CC64 — note `midiBuffer` only emits
  pedal for the `piano` track today), rubato/timing humanization, velocity jitter, legato overlap.
- *Composition layer:* longer form (intro→climax→outro), modulation, inner voices, a strings pad
  layer for late-Yiruma style.
- *Post/space layer:* convolution reverb with a real piano-hall impulse response (ffmpeg `afir`),
  2-pass loudnorm, gentle EQ/compression.
- *Engine layer:* install `sfizz_render` to unlock SFZ libraries with pedal/release/resonance noise
  (the SF2 builds drop these).

Trick used for a pedaled feel without CC64 support on import: a third held-chord "pad" part
(whole notes) under the arpeggio simulates sustain; render with a `channelMap` that splits the
piano layers onto separate channels so a re-struck note doesn't cut the held pad.

## 15. Running Code-MCP locally as an MCP client target (dev)

To let an MCP client (Claude Code, etc.) call these tools natively against local code:

1. Start a **non-production** instance with a 32+ char dev token (bypasses OAuth; disabled when
   `NODE_ENV=production`):
   ```sh
   env -u NODE_ENV PORT=6860 PUBLIC_BASE_URL=http://127.0.0.1:6860 \
     MCP_DEV_TOKEN=<32+ char secret> MUSIC_SOUNDFONT_DIR=<dir with generaluser-gs/> \
     COMMAND_TIMEOUT_MS=600000 npx tsx src/server.ts
   ```
   (No `DATABASE_URL` → file-mode; big sf2 renders need a high `COMMAND_TIMEOUT_MS`.)
2. Register it: `claude mcp add --transport http code-mcp http://127.0.0.1:6860/mcp --header "Authorization: Bearer <token>"`. The client must reconnect/restart to pick up the ~548 tools.
3. The deployed Docker container (`:6859`, serves `gmb01.xyz`) is `NODE_ENV=production` → dev-token
   bypass is **off**; connecting to it needs the real OAuth flow.

**Publish + large sf2:** instrument source assets (`.sf2`/`.sf3`/`.sfz`) are render *inputs*, not
web deliverables, and `publishProject` never copies/serves them. As of commit f532d86,
`validateProject` **warns** (no longer errors) on an oversized instrument pack, so a 118 MB / 1.27 GB
sf2 in the project does not block publish — the page just references the produced WAV/MP3. (Earlier
builds errored "File exceeds max size"; the workaround then was to `delete_project_file` the sf2
before publishing.)
