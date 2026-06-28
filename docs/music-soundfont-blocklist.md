# Music soundfont block-list & preferences

Hard-won preferences for the music-generation pipeline. **Honor these before picking a
soundfont for any render.**

## ❌ Do NOT use

| Source | Articulation | Why rejected | Verdict (date) |
|--------|--------------|--------------|----------------|
| **VSCO-2 CE Solo Cello** (`susvib` = sustain+vibrato), rendered via **sfizz** | solo cello | User listened and rejected: "sucks." Tone/vibrato unconvincing as an exposed solo line; also carries more bow/sample noise than alternatives. | 2026-06-28 — **do not use** |

Notes on the rejected VSCO cello:
- Built from raw `sgossner/VSCO-2-CE` WAVs (`Strings/Cello Section/susvib`, 13 pitches C2–B4, only 2 velocity layers v1/v3), auto-mapped to an SFZ by measured fundamental, rendered with `sfizz_render`.
- Objectively it measured *worse* than the alternative on noise floor (RMS 0.0156 vs 0.0061) and harshness (0.0112 vs 0.0050) — and the user's ear agreed. The objective A/B and the listening verdict aligned.
- The SFZ mapping itself was *correct* (chromatic round-trip 7/7). The problem is the **samples/instrument**, not the pipeline.

## ✅ Preferred for solo cello (free pipeline)

- **Cello Cocoto** soundfont (`.sf2`, ~17 MB, program 43), rendered with FluidSynth — cleaner/darker, lower noise floor, smoother top end. Use this over the VSCO susvib cello.

## General ceiling note

No *free* solo-string source reaches "Salamander-level" depth (the piano has 16 velocity
layers; free cellos have ~1–2). For true orchestral-cello realism, a paid library
(Spitfire, Cinematic Studio Strings) used in a DAW is required — the sf2/sfizz free
pipeline tops out below that.

## Mastering reminder (not a soundfont, but pipeline-wide)

Never master with single-pass `loudnorm` — it is a *dynamic* normalizer that boosts quiet
passages ~11 dB more than loud ones, lifting the noise floor only in soft sections
(audible "pumping"). Use **linear gain + a true-peak limiter** instead (see `master.py`):
measure integrated LUFS once → apply one constant gain → `alimiter` catches only transient
peaks → 35 Hz high-pass. A constant gain cannot pump the floor.
