---
id: TKT-20260810-005
title: "Enforce ensemble hard gates and per-role instrument packs in music production orchestration"
type: feature
priority: P1
status: PR_READY
owner: "Codex"
requestor: "Code-MCP user"
risk: HIGH
scope:
  in:
    - "Require every declared ensemble instrument to be present before rendering"
    - "Run validate_music_ensemble as a hard pre-render gate in create_music_production"
    - "Accept and validate per-role instrumentPackMap in the orchestrator"
    - "Preserve strict license, production-approval, and instrument-coverage checks"
    - "Add regression coverage for missing roles, invalid pack maps, and a valid piano/cello path"
  out:
    - "Changing low-level render_production_music semantics"
    - "Adding a new queue, database, or external music service"
    - "Changing existing solo-piano output artifacts"
constraints:
  - "localhost-first"
  - "fail closed before any audio render when a required ensemble role is absent"
  - "do not silently fall back from an explicitly selected instrument pack"
  - "keep binary assets server-side; never route them through the LLM"
  - "preserve backward compatibility for solo and existing orchestrator calls"
acceptance_criteria:
  - "An ensemble policy with piano and cello fails before render when either role has no note-bearing track."
  - "A valid piano/cello arrangement runs validate_music_ensemble before render and records its report in the production manifest."
  - "create_music_production accepts a per-role instrumentPackMap and passes it through to rendering."
  - "The map is rejected for unknown roles, unknown packs, unapproved packs, license-ineligible packs, and role-coverage mismatches."
  - "Existing solo-piano orchestration remains compatible and does not require an ensemble gate."
  - "Targeted tests, typecheck, lint, and MCP registry checks pass."
test_plan:
  - "Inspect the current orchestrator stage flow and render schema before editing."
  - "Add unit tests for the ensemble pre-render gate and pack-map validation."
  - "Run targeted music workflow/orchestrator tests, then typecheck and lint."
  - "Run MCP registry validation and the full test suite if targeted checks are green."
  - "Perform a no-audio piano/cello orchestration smoke test and verify manifest evidence."
rollback_plan:
  - "Revert the additive orchestrator/schema/test changes."
  - "If deployed, redeploy the previously verified image digest."
  - "Do not delete or rewrite any existing music project artifacts."
notes:
  - "The existing low-level validate_music_constraints allow-list does not require every allowed ensemble role to appear."
  - "The existing orchestrator does not invoke validate_music_ensemble before rendering and does not expose instrumentPackMap."
---

## Context

The previous piano/cello production required a manually constructed duet seed because the orchestrator could accept an ensemble allow-list while still producing only one role. This ticket closes that orchestration gap by making role presence and overlap authoritative before expensive rendering.

## Requirements

- Keep `validate_music_constraints` as the instrument allow/prohibited gate.
- Add `validate_music_ensemble` to the orchestrator's pre-render sequence when the policy is ensemble or when multiple required roles are declared.
- Treat a failed or missing ensemble report as a hard stop with preserved stage evidence.
- Add an optional `instrumentPackMap` keyed by canonical role names and validate it through the same pack registry and license gate used by the renderer.
- Include the validated ensemble report and resolved pack map in the revision-ready production manifest.

## Non-Goals

- Do not make a low-level allow-list imply required-role semantics globally.
- Do not introduce heuristic audio analysis into the ensemble gate.
- Do not add fallback to a different soundfont when a caller explicitly chooses a pack.

## Implementation Hints

- Reuse the existing `validateMusicEnsemble` handler rather than duplicating overlap logic.
- Keep validation before `render_production_music` and before any `publish` stage.
- Use the existing `resolveProductionPackMap`/registry path for role coverage and license truth.

## QA Checklist

- [x] Ticket scope and rollback reviewed.
- [x] Missing ensemble role fails closed before render.
- [x] Valid piano/cello path records ensemble evidence.
- [x] Per-role pack map reaches the renderer and is validated by the existing strict renderer gate.
- [x] Invalid/unsafe pack maps fail closed without fallback through the existing pack registry/license gate.
- [x] Solo-piano compatibility remains green.
- [x] Targeted tests, typecheck, lint, and registry checks pass.
- [x] Skill Reflection recorded.
- [ ] Full suite is not fully green because six unrelated browser/media environment tests require a missing Playwright Chromium executable.

## Implementation Summary

- Added strict canonical per-role `render.instrumentPackMap` support for the ten existing renderer roles.
- A non-empty pack map automatically selects `render_production_music`, which already owns registry, license, production-approval, and role-coverage validation; the map is not sent to the single-pack `render_midi_with_soundfont` schema.
- Added an `ensemble` stage to `create_music_production`. For `instrumentPolicy.mode=ensemble`, it calls `validate_music_ensemble` after constraints and before development/render. A failed report sets the revision-ready blocker and prevents development, render, audio QA, and publish.
- Ensemble reports are retained in `stages` and `qaResults.ensemble` in the final manifest. Solo policies record an explicit skipped ensemble stage and remain compatible.
- Ensemble mode now requires at least two allowed instruments so the hard gate cannot become a no-op.

## Validation Evidence

- `npx tsx --test --test-timeout=120000 tests/music-production-orchestrator.test.ts` — 11/11 passed, including a real registered piano/cello orchestration smoke test.
- `npx tsx --test --test-timeout=120000 tests/music-workflow.test.ts` — 70/70 passed.
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run check:mcp` — passed: build succeeded, 617 tools, 50 skills, zero duplicates.
- `git diff --check` — passed.
- `npm test` — 506/512 passed; six existing environment-dependent tests failed outside this change: two demo monitoring tests, two form persistence tests, and two workspace video tests. The direct blocker is the missing Playwright Chromium executable at `~/Library/Caches/ms-playwright/chromium_headless_shell-1228/...`; the Music Orchestrator path and all Music tests passed.

## Role Notes

### PM

The requested behavior is now one high-level ensemble production request that cannot silently render a missing voice.

### Tech Lead

The orchestrator owns sequencing and hard-gate state. The low-level ensemble analyzer and pack registry remain authoritative, avoiding duplicated overlap/license logic.

### Engineer

Changed `src/mcp/tools/music-production-orchestrator.ts` and `tests/music-production-orchestrator.test.ts`. No low-level renderer semantics or existing music artifacts were changed.

### Reviewer

Checked stage ordering, solo compatibility, schema strictness, renderer selection, failure preservation, and the no-fallback behavior for explicitly selected packs.

### QA

Verified missing-role failure, real piano/cello overlap, manifest evidence, per-role map forwarding, Music regressions, build/type/lint, and registry integrity.

### Release Manager

Local build is PR-ready. No production deployment was performed in this ticket because deployment is a separate production-impacting release action; rollback is the previous verified image digest.

### Security

The new map contains only pack IDs, keeps binary assets server-side, rejects unknown role keys, and delegates license/approval/coverage checks to the existing strict registry gate.

## PR Draft

### What / Why

Make ensemble production fail closed when a declared instrument is absent and allow one orchestrator call to select different approved instrument packs per role.

### Verification

- 11/11 orchestrator tests passed.
- 70/70 Music workflow tests passed.
- Typecheck, lint, build, MCP registry checks, and diff whitespace checks passed.
- Full suite: 506 passed, 6 blocked by missing local Playwright Chromium; unrelated to changed files and Music paths.

### Rollback Plan

Revert the additive orchestrator and test changes. If released, redeploy the previous verified image digest; no project asset deletion is required.

## Skill Reflection

Searched existing global/project skills before recording this result. No new skill was created or updated: the orchestration stage and role names are repository-specific, while the existing `quality-check-improvement-loop` already covers the reusable fail-closed QA, media, MIDI, and release-evidence procedure.
