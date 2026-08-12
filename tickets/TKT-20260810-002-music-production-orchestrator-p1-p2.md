---
id: TKT-20260810-002
title: "Add production orchestration and long-form music development QA"
type: feature
priority: P1
status: DONE
owner: "Codex"
requestor: "Code-MCP user"
risk: HIGH
scope:
  in:
    - "Long-form section/development/repetition QA with melody-lineage evidence"
    - "Human-friendly normalization for common Music style, output, and instrument-policy aliases"
    - "One high-level create_music_production orchestration tool over existing Music tools"
    - "Issue #0179 nested parent-directory creation for tool-output search indexes"
    - "Golden regression covering a 57-note source melody to a five-minute solo-piano production plan"
  out:
    - "Production deployment"
    - "A new external queue or database"
    - "Forced termination of already-running renderer subprocesses"
    - "A perceptual audio ML model or copyrighted-song fingerprint database"
constraints:
  - "localhost-first"
  - "reuse existing Music tools and background job store"
  - "fail closed before rendering when musical development or hard constraints fail"
  - "preserve existing low-level tool compatibility"
acceptance_criteria:
  - "A development validator reports section coverage, source-theme reuse, transformation evidence, repeated-window similarity, and a pass/fail score."
  - "A mechanically duplicated long-form composition fails while a developed five-minute solo-piano fixture passes."
  - "Common values such as cinematic, solo piano, audio, score, website demo, allowed, and output aliases normalize to canonical internal values with disclosed warnings."
  - "create_music_production coordinates extension, hard constraints, development QA, optional realistic rendering, audio QA, export metadata, and optional publishing while preserving intermediate artifacts and failure reasons."
  - "create_music_production can run through the background-job API and exposes a revision-ready final production manifest."
  - "build_tool_output_search_index creates missing nested output directories and has regression coverage for #0179."
  - "Targeted tests, typecheck, lint, build, full tests, and MCP registry checks pass."
test_plan:
  - "Unit-test development metrics against developed and mechanically duplicated compositions."
  - "Unit-test alias normalization and canonical disclosures."
  - "Run a no-audio golden orchestration fixture and assert manifest/MIDI/QA lineage outputs."
  - "Test render-stage failure preservation without requiring a five-minute sampled-piano render."
  - "Regression-test nested index output paths for #0179."
  - "Run full repository validation."
rollback_plan:
  - "Remove the orchestrator module registration and async allowlist entry."
  - "Remove the development validator registration and optional metadata fields."
  - "Revert nested-directory creation in tool-output-search; no stored index migration is required."
notes:
  - "Builds on completed TKT-20260810-001."
  - "No deployment is authorized by this ticket."
---

## Context

P0 made solo-instrument policy, long render jobs, and binary handoff reliable. The next gap is orchestration: agents still coordinate many low-level calls, and the existing long-form extension can repeat a short sketch without proving structural development.

## Requirements

- Add deterministic, explainable development QA that works from composition manifests and source lineage.
- Improve extension output enough to pass that gate without merely duplicating the source motif.
- Normalize high-frequency human terms before strict internal schema validation and disclose every interpretation.
- Add one production orchestrator that records every stage, artifact, warning, failure, and next action.
- Keep expensive render and publish stages optional so regression tests remain deterministic and offline.
- Fix #0179 with parent-directory creation before atomic writes.

## Non-Goals

- No claim of universal music-quality judgment.
- No copyrighted reference-song matching.
- No production rollout in this ticket.

## Implementation Hints

- Keep development analysis pure/exported for fixture tests.
- Compare normalized pitch/rhythm windows rather than raw absolute register alone.
- Treat exact repeated windows as blockers only when section-level transformation evidence is also insufficient.
- Implement orchestration as a thin stage runner over existing registered tools, not a second composition engine.
- Make the orchestrator itself eligible for `run_tool_async`.

## Role Notes

### PM

The user-facing outcome is one request producing revision-ready project state, not merely another low-level Music tool.

### Tech Lead

Keep lower-level tools authoritative. The orchestrator owns sequencing, state capture, and stage gates; it must not duplicate renderer, licensing, or storage logic.

### Engineer

Use additive schemas and a separate orchestrator module. Preserve every successful intermediate artifact when a later stage fails.

### Reviewer

Check deterministic metrics, false positives on legitimate reprises, circular imports, tool enablement, error propagation, and manifest truthfulness.

### QA

Require a mechanical-loop negative fixture and a developed positive fixture. Verify no-audio orchestration separately from renderer integration.

### Release Manager

No deployment in this ticket. Rollback is tool deregistration plus additive schema removal.

### Security

Do not expose binary payloads, absolute local paths, user melody content beyond project scope, or third-party assets without license evidence.

## QA Checklist

- [x] Developed golden fixture passes development QA.
- [x] Mechanical duplication fails development QA.
- [x] Alias normalization is deterministic and disclosed.
- [x] Orchestrator succeeds for manifest + MIDI + QA without audio.
- [x] Orchestrator preserves stage failure evidence.
- [x] Orchestrator is async-eligible and tool-gated.
- [x] #0179 nested output path succeeds.
- [x] Typecheck, lint, targeted tests, full tests, and MCP registry pass.

## Implementation Summary

- Added `validate_music_development`, an explainable manifest-level gate covering source lineage, transposition-tolerant motif identity, section coverage, independent variation signals, repeated-window similarity, and exact-clone ratio.
- Reworked long-form extension to apply deterministic register, rhythm, dynamics, density, contour, and phrasing transformations while retaining recurring source-theme statements.
- Added disclosed normalization for common style, solo-piano policy, `allowed`, output, score, audio, and website-demo aliases while keeping canonical internal schemas strict.
- Added `create_music_production`, a stage-recording orchestrator for extension, hard constraints, development QA, optional realistic rendering, optional audio QA/publishing, and a truthful revision-ready final manifest.
- Registered the orchestrator for normal and background execution; required lower-level tool enablement is rechecked at run time.
- Fixed #0179 by creating the resolved index parent directory before atomic writes and rejecting paths outside `feedbackRoot`.

## Validation Evidence

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- Targeted async, music workflow, orchestrator, and #0179 tests — 97/97 passed.
- `npm run check:mcp` — passed with 617 tools, 50 skills, and zero duplicates.
- `npm test` — 506/506 passed.
- `git diff --check` — passed.
- Deployment intentionally not performed; it remains outside this ticket's authorization.
