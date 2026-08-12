---
id: TKT-20260810-006
title: "Restore local Playwright Chromium runtime for browser regression tests"
type: bugfix
priority: P2
status: DONE
owner: "Codex"
requestor: "Code-MCP user"
risk: LOW
scope:
  in:
    - "Restore the repository-compatible Playwright Chromium executable in the local test environment"
    - "Rerun the six previously failing browser and media regression tests"
    - "Record exact environment and test evidence"
  out:
    - "Changing application logic or browser QA assertions unless the browser install exposes a real product defect"
    - "Changing Playwright versions or lockfiles without evidence"
    - "Deploying application code"
constraints:
  - "localhost-first"
  - "no secrets"
  - "preserve existing code and worktree changes"
acceptance_criteria:
  - "npx and the repository Playwright package are available"
  - "the required Chromium executable is installed and launchable"
  - "the two demo-monitoring, two form-persistence, and two workspace-video tests pass"
  - "music orchestrator and existing targeted regressions remain green"
test_plan:
  - "Check npx, Playwright version, browser cache, and install instructions"
  - "Install the matching Chromium browser if it is missing"
  - "Run the six exact failed test scenarios"
  - "Run targeted regression suites and the full npm test suite if feasible"
rollback_plan:
  - "Remove only a newly installed browser cache if necessary; do not delete repository files"
  - "Revert any test-run-only generated artifacts"
notes:
  - "Baseline npm test: 506/512 passed; six failures reported a missing Playwright Chromium executable."
---

## Context

The previous full test run completed 506 of 512 tests. The six failures were browser-backed regression tests, and the direct error for the form-persistence scenarios reported that the Playwright Chromium executable was missing from the local cache.

## Requirements

- Restore the browser runtime using the repository-compatible Playwright installation path.
- Verify the exact six failed scenarios before declaring the environment repaired.
- Confirm the music-production changes remain unaffected.
- Preserve unrelated dirty-worktree changes.

## Non-Goals

- No product-code changes are planned for this environment-only repair.
- No dependency upgrade, deployment, or external service mutation is in scope.

## QA Checklist

- [x] Chromium executable installed and launchable
- [x] Demo monitoring tests pass
- [x] Form persistence tests pass
- [x] Workspace video tests pass
- [x] Music orchestrator targeted suite passes
- [x] Full `npm test` result recorded
- [x] Skill reflection completed

## Resolution Evidence

- `npx playwright --version` -> `Version 1.61.0`.
- `npx playwright install chromium` installed Chrome for Testing and the headless shell at revision `1228` under `/Users/yapweijun/Library/Caches/ms-playwright`.
- `npx playwright install --list` confirmed the repository Playwright 1.61.0 browser paths and retained the separate Web-Design-MCP 1.62.1 browser installation.
- `npx tsx --test --test-timeout=120000 --test-name-pattern='monitor_published_demo_health' tests/demo-monitoring.test.ts` -> 2/2 passed.
- `npx tsx --test --test-timeout=120000 --test-name-pattern='test_form_persistence' tests/form-persistence.test.ts` -> 2/2 passed.
- `npx tsx --test --test-timeout=120000 --test-name-pattern='record_project_workspace_video' tests/project-dev.test.ts` -> 2/2 passed.
- `npx tsx --test --test-timeout=120000 tests/music-production-orchestrator.test.ts tests/music-workflow.test.ts` -> 81/81 passed.
- `npm test` -> 513/513 passed; the command also passed repository and admin UI typecheck.
- `npm run lint` -> passed.
- `npm run check:mcp` -> passed; build completed with 617 tools, 50 skills, and 0 duplicates.
- No application source or test assertion was changed for this ticket; only the local Playwright browser cache was restored and this ticket was recorded.

## Skill Reflection

The existing Playwright and quality-check skills already cover the reusable procedure: inspect the repository Playwright version, install its matching browser revision, rerun the exact browser regressions, and then run the broader suite. No new or updated skill is warranted; the missing revision was an environment-only issue, not a new project-specific workflow.
