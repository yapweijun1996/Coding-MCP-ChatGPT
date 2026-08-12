---
id: TKT-20260810-004
title: "Create and publish a five-minute piano and cello production"
type: feature
priority: P1
status: DONE
owner: "Codex"
requestor: "Code-MCP user"
risk: MEDIUM
scope:
  in:
    - "Create a separate piano-and-cello arrangement from the existing 57-note source melody"
    - "Preserve the completed solo-piano version and its artifacts"
    - "Produce approximately five minutes of developed music with audible piano and cello roles"
    - "Render, QA, license, publish, and independently verify MIDI, WAV, MP3, manifest, stems, and listening URL"
  out:
    - "Replace or modify the existing solo-piano production"
    - "Add drums, bass, pads, strings sections, or other instruments"
    - "Change application code or redeploy unless a verified pipeline defect blocks the requested production"
constraints:
  - "localhost-first"
  - "piano and cello only"
  - "no MIDI channel 10 or percussion events"
  - "preserve source-melody lineage and meaningful long-form development"
  - "use a production-approved multi-instrument SoundFont with truthful license attribution"
  - "do not pass binary assets through the LLM as Base64"
acceptance_criteria:
  - "A new approximately 300-second arrangement exists in a separate project directory."
  - "The arrangement and MIDI contain audible piano and cello roles, no prohibited instruments, and no channel 10 events."
  - "Piano and cello overlap musically rather than appearing only as sequential solo sections."
  - "Melody-lineage and musical-development QA pass without mechanical looping."
  - "The real rendered WAV and MP3 pass audio QA and independent codec, duration, loudness, peak, and silence checks."
  - "MIDI, WAV, MP3, stems, manifest, QA reports, license notice, and a working listening URL are delivered."
test_plan:
  - "Audit the deployed Music tools and installed production-approved SoundFont packs for piano plus cello coverage."
  - "Run a no-audio or pre-render constraint check when needed to prove both roles before the expensive render."
  - "Submit the production through the async job path and poll to a terminal state."
  - "Inspect composition, constraint, ensemble, development, audio, render, and license reports."
  - "Independently parse MIDI note-bearing channels/programs and inspect WAV/MP3 with ffprobe and ffmpeg."
  - "Exercise the public listening page and ranged audio requests."
rollback_plan:
  - "Keep the existing solo-piano directory and listening URL unchanged."
  - "If the new version fails acceptance, retain its isolated artifacts as revision evidence and do not present its URL as complete."
  - "No database, volume, application image, or prior music artifact is deleted."
notes:
  - "Assumption: the user wants the same approximately five-minute source-derived work arranged as a piano-and-cello duet."
  - "Assumption: cello may carry the theme, countermelody, and long expressive lines while piano retains harmony and texture."
---

## Context

The verified solo-piano Golden Eval is complete. The user requested an additional piano-and-cello version. This ticket creates a sibling production without changing the solo master.

## Requirements

- Reuse the existing source melody and MusicXML lineage.
- Generate a real duet with independent piano and cello material and meaningful overlap.
- Keep the orchestration strictly to piano and cello.
- Render through a production-approved pack that actually supports both instruments.
- Publish only after hard constraints, development, audio, and license checks pass.

## Non-Goals

- No drums, percussion, bass, pads, ensemble strings, synths, or hidden tracks.
- No application deployment unless a reproducible product defect prevents the requested duet.
- No overwrite of `music/golden-20260810-final`.

## Implementation Hints

- Prefer a separate output directory such as `music/piano-cello-20260810`.
- Fail closed if the selected pack does not cover both piano and cello or if the generated cello track is empty.
- Keep the existing solo-piano production as the rollback-safe reference.

## QA Checklist

- [x] Production-approved piano/cello render path selected.
- [x] Piano and cello both contain notes and overlap.
- [x] Duration and instrument hard constraints pass.
- [x] Channel 10 and percussion events are absent.
- [x] Melody identity and development QA pass.
- [x] WAV, MP3, MIDI, stems, manifest, and licenses are verified.
- [x] Public listening URL returns 200 and audio ranges return 206.
- [x] Evidence and Skill Reflection are recorded.

## Completion Evidence

- Output directory: `music/piano-cello-20260810` in project `project_4312d78c-a30e-433f-8524-3b86b5f874e5`.
- Listening URL: `https://content.gmb01.xyz/share/project_4312d78c-a30e-433f-8524-3b86b5f874e5/music/piano-cello-20260810/listen.html` returned HTTP 200; an MP3 range request returned HTTP 206.
- Successful async render job: `job_fe9e3204-abe3-4b09-83b9-02300fa717f0`, completed at 100% with 10 artifacts.
- Arrangement: declared duration 300 seconds, eight sections, 1,020 notes total: piano 679 and cello 341.
- MIDI: piano uses channel 1/program 1; cello uses channel 6/program 43; channel 10 has zero note events.
- Ensemble QA: piano/cello overlap 238.421 seconds; longest single-instrument span 1.184 seconds.
- Development QA: passed with melody identity 1.0, development score 0.785, exact-repeat ratio 0.158, section coverage 1.0, and `mechanicalLoop=false`.
- Melody lineage: final -> duet seed -> original lineage validated; transposition-invariant original-theme match to cello was 1.0 with 12 theme matches.
- Audio QA: production safe with suitability 96 and no warnings. Independent `ffmpeg`/`ffprobe` checks measured 303.194558 seconds, -16.0 LUFS integrated, 6.8 LU LRA, and -3.9 dBFS true peak.
- Production assets verified: `production.mid`, `production.wav`, `preview.mp3`, piano/cello WAV stems, piano/cello MIDI stems, production manifest, render report, QA reports, `LICENSES.md`, and listening page.
- Render pack: GeneralUser GS, SHA-256 `9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe`, with attribution recorded in `LICENSES.md`.
- Existing solo-piano production and URL were preserved unchanged.

## Verified Pipeline Fix

The first long render exposed a production defect: the render preflight scanned and fully read every project SoundFont, including an unselected 1.26 GB pack. `render_production_music` now performs a binary-only environment preflight while retaining the authoritative registry, license, and instrument-role checks in `resolveProductionPackMap`.

- Changed: `src/mcp/tools/music-workflow.ts`.
- Regression assertion: `tests/music-workflow.test.ts` confirms broad instrument discovery is absent from the render preflight.
- Targeted test passed: `npx tsx --test --test-timeout=120000 --test-name-pattern='render_production_music renders a dedicated cello stem' tests/music-workflow.test.ts`.
- Type checking passed: `npm run typecheck`.
- Deployment image digest: `sha256:2bd22d3046ba8bf2b5ae23aae2927604f18a5eb7c9db02e9ae1b5c4c6574e0bf`.
- Deployed service health check: `https://gmb01.xyz/health` returned healthy.

## Role Notes

- PM: scoped this as a separate source-derived duet and preserved the solo-piano master as the rollback-safe version.
- Tech Lead: selected a strict two-role instrument policy, async production path, and fail-closed licensing/render checks.
- Engineer: authored the seed and arrangement, rendered the production and stems, fixed the preflight defect, and deployed the rebuilt image.
- Reviewer: inspected the patch and confirmed the strict pack-resolution gate was unchanged.
- QA: independently validated MIDI channels/programs, musical development, lineage, codecs, duration, loudness, peak, silence, HTTP status, and byte ranges.
- Release Manager: verified the new container health and published the isolated duet artifacts without deleting prior assets.

## PR Draft

### Summary

- Avoid broad SoundFont discovery during `render_production_music` environment preflight.
- Retain strict registry, licensing, and per-role instrument-pack resolution.
- Add regression coverage using the dedicated cello-stem production fixture.

### Testing

- Targeted cello production test: passed.
- TypeScript typecheck: passed.
- End-to-end five-minute piano/cello async render, QA, publish, and HTTP verification: passed.

### Rollback

Revert the two source/test changes and redeploy the previous image. The duet and solo-piano assets are isolated and do not require deletion for rollback.

## Skill Reflection

Searched global and project-local skills after verification. No skill was created or updated: the SoundFont preflight optimization is repository-specific, while the existing `quality-check-improvement-loop` already covers the reusable MIDI, SoundFont, audio, licensing, and media-delivery validation workflow used here.
