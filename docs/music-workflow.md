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
