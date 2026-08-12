---
id: TKT-20260810-001
title: "Make the Music pipeline enforce constraints and survive long binary workflows"
type: feature
priority: P0
status: DONE
owner: "Codex"
requestor: "Code-MCP user"
risk: HIGH
scope:
  in:
    - "Hard solo/allowed/prohibited instrument and MIDI-channel validation before rendering"
    - "Background execution support for long SoundFont and production music renders"
    - "Byte-for-byte promotion of sandbox MIDI/audio artifacts into project storage"
    - "Regression coverage for issues #0176, #0177, and #0178"
    - "A deterministic long-form solo-piano golden fixture that does not require a five-minute audio render in every unit-test run"
  out:
    - "Full long-form musical-development scoring and melody-similarity algorithms"
    - "Complete schema synonym normalization across every Music tool"
    - "The final one-call create_music_production orchestrator"
    - "Production deployment"
constraints:
  - "localhost-first"
  - "preserve current low-level Music tool compatibility"
  - "never expose binary payloads to the model"
  - "fail closed when a declared instrument policy is violated"
acceptance_criteria:
  - "A solo-piano policy rejects drums, channel 10, non-piano tracks, and non-piano stems before rendering."
  - "Long-running Music render tools can be started as background jobs and use existing status, cancellation, retry, and partial-result recovery APIs."
  - "A sandbox artifact can be promoted directly into project storage with verified byte count, SHA-256, media type, and safe destination path."
  - "Golden regression metadata models an approximately 300-second piano-only composition with source-melody lineage and passes the hard constraints."
  - "Targeted tests, typecheck, and MCP registry checks pass."
test_plan:
  - "Unit-test solo policy success and failures for drums, channel 10, non-piano tracks, hidden channels, and duration tolerance."
  - "Unit-test async eligibility and status lifecycle for long Music render tools with a stubbed tool."
  - "Unit-test binary promotion preserves exact bytes and SHA-256 and rejects traversal/unregistered outputs."
  - "Run TypeScript typecheck and MCP registry validation."
rollback_plan:
  - "Remove the new validator and promotion tool registrations."
  - "Remove Music render names from the async allowlist."
  - "Revert optional schema fields; existing manifests and synchronous render paths remain compatible."
notes:
  - "Tracks reported issues #0176, #0177, and #0178."
  - "P1/P2 recommendations remain follow-up work after the P0 gates are verified."
---

## Context

A real 57-note melody-to-five-minute solo-piano workflow exposed reliability gaps between otherwise capable Music tools. Arrangement generation could introduce drums despite a solo request, realistic SoundFont rendering could outlive a synchronous MCP request, and sandbox-created MIDI/audio required model-mediated Base64 movement.

## Requirements

- Introduce a reusable Music constraint policy and validator.
- Persist or accept the policy at the points where compositions are produced and rendered.
- Block render entry points when a declared policy fails.
- Route long Music renders through the existing background-job system.
- Promote registered sandbox outputs to project storage server-side, preserving bytes and reporting integrity metadata.
- Add a five-minute solo-piano golden fixture with source lineage metadata.

## Non-Goals

- No claim that heuristic musical-development QA is solved in this ticket.
- No breaking replacement of existing low-level tools.
- No external queue, database migration, or production deployment.

## Implementation Hints

- Extend the existing generic background-job allowlist rather than creating a second job store.
- Reuse project file-path and asset validation rather than duplicating path rules.
- Treat General MIDI channel 10 (zero-based channel 9 internally) as percussion and reject either representation when a solo-piano policy is active.
- Keep the golden fixture deterministic and fast; use metadata-duration validation rather than rendering five minutes during normal unit tests.

## Role Notes

### PM

P0 is the smallest end-to-end reliability slice. P1 schema normalization, lineage analytics, development QA, and the P2 orchestrator will be separately triaged after this gate lands.

### Tech Lead

Use existing composition manifests, project storage, sandbox roots, and async jobs as authorities. Add policy checks at both explicit validation and render boundaries so callers cannot bypass the gate accidentally.

### Engineer

Keep validator logic pure where possible, add narrow tool adapters, and avoid rewriting the monolithic Music module outside affected schemas and handlers.

### Reviewer

Check fail-closed behavior, channel-number semantics, legacy manifest compatibility, sandbox ownership/path containment, and byte-for-byte verification.

### QA

Require positive and adversarial fixtures. Confirm background execution is authorized by the same tool/skill gates as synchronous execution.

### Release Manager

Ship behind additive schemas and registrations. Roll back by removing registrations/allowlist entries without touching stored project data.

### Security

Promotion may only read files declared by the caller's sandbox manifest and may only write through existing project storage validators. Never return raw binary or absolute filesystem paths.

## QA Checklist

- [x] Solo-piano valid fixture passes.
- [x] Drum/channel-10/non-piano/hidden-channel fixtures fail.
- [x] Render handlers fail before spawning a renderer when policy is invalid.
- [x] Music render tools are async-eligible and remain tool-gated.
- [x] Binary promotion verifies size/hash/type and rejects unsafe paths.
- [x] Golden fixture is approximately five minutes and records source lineage.
- [x] Typecheck and targeted tests pass.
- [x] MCP registry check passes.

## Implementation Evidence

- Added `instrumentPolicy`, `validate_music_constraints`, composition lineage fields, render-entry fail-closed gates, and duration-scaled renderer timeouts in `src/mcp/tools/music-workflow.ts`.
- Added background eligibility plus queued/running/completed/error/timeout/cancelled progress metadata for `render_midi_with_soundfont` and `render_production_music` in `src/mcp/tools/async-jobs.ts` and `src/jobs/store.ts`.
- Added `promote_sandbox_artifact_to_project` with registered-artifact, path-containment, type, size, and SHA-256 verification in `src/mcp/tools/sandbox-execution.ts`.
- Added deterministic `tests/fixtures/music/five-minute-solo-piano.json` with 57 notes, 300-second duration, solo-piano policy, six sections, and source-melody lineage.
- Targeted P0 regression suite: 101/101 passed.
- Full repository suite: 495/495 passed.
- `npm run check:mcp`: passed; 615 tools, 50 skills, zero duplicate tools.
- Scoped ESLint and `git diff --check`: passed.

## Known Follow-ups

- Cancellation is currently a durable logical cancellation: a late underlying renderer result is ignored, but an already-running subprocess is not forcibly terminated.
- Progress is coarse-grained lifecycle progress, not renderer-native percentage telemetry.
- Musical-development similarity scoring, broad schema synonym normalization, the one-call production orchestrator, and issue #0179 remain outside this P0 ticket.
