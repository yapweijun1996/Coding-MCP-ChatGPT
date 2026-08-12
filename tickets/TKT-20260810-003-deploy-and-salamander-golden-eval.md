---
id: TKT-20260810-003
title: "Deploy current Music pipeline and run the real Salamander golden evaluation"
type: release
priority: P0
status: DONE
owner: "Codex"
requestor: "Code-MCP user"
risk: HIGH
scope:
  in:
    - "Deploy the currently verified dirty-worktree build through the existing Docker Compose service"
    - "Preserve and verify a rollback image before replacement"
    - "Smoke-test local and public Cloudflare Tunnel health plus MCP behavior"
    - "Run the five-minute, 57-note-source, solo-piano production through the async path"
    - "Render with the existing Salamander Grand Piano SoundFont and verify MIDI, WAV, MP3, QA, license evidence, and listening URL"
  out:
    - "Cloudflare Tunnel or DNS configuration changes"
    - "Database or Docker volume deletion"
    - "Fallback to a non-Salamander instrument"
constraints:
  - "keep existing persistent Docker volumes"
  - "fail closed on instrument-policy, render, QA, or license failure"
  - "do not pass binary assets through the model as Base64"
  - "record the deployed base commit, worktree state, image identity, and rollback identity"
acceptance_criteria:
  - "The pre-deploy service state and public health baseline are recorded."
  - "A rollback image is retained before replacing the running application container."
  - "The rebuilt service becomes healthy locally and through https://gmb01.xyz without changing Tunnel configuration."
  - "The MCP registry exposes create_music_production and the relevant Music tools after deployment."
  - "The Golden Eval runs as a background job and completes without depending on one synchronous MCP request."
  - "The final composition is approximately 300 seconds, piano-only, contains no channel 10 or drum events, preserves melody lineage, and passes development QA."
  - "The production creates playable MIDI, WAV, MP3, manifest/score evidence, QA evidence, license/attribution evidence, and a working listening URL."
test_plan:
  - "Capture pre-deploy compose/container/image and local/public health evidence."
  - "Run pre-deploy typecheck, lint, build, focused tests, and full tests if the worktree changed since the previous validation."
  - "Build and deploy with Docker Compose without removing volumes."
  - "Verify container health, logs, public health, and MCP initialize/tools/list smoke checks."
  - "Submit and poll the real five-minute Golden Eval through the async Music orchestration API."
  - "Inspect artifacts with composition/MIDI validators and ffprobe; exercise the listening URL."
rollback_plan:
  - "Retag and restart the preserved pre-deploy application image with the unchanged Compose configuration and volumes."
  - "Do not roll back or delete persistent PostgreSQL/project-state volumes."
notes:
  - "Authorized by the user's selection of options 2 and 3."
  - "The public endpoint is an existing Cloudflare Tunnel to the local Compose service; no Wrangler deployment is required."
  - "Initial execution was paused when the filesystem had only 116 MiB free; npm's rebuildable cache was cleaned before this ticket could be written."
  - "Completed on 2026-08-10 (Asia/Singapore)."
---

## Context

TKT-20260810-002 completed and verified the production orchestrator and development QA without deploying or performing a real five-minute sampled-piano render. This ticket performs the authorized release and production-like end-to-end regression.

## QA Checklist

- [x] Baseline and rollback image recorded.
- [x] Pre-deploy gates pass.
- [x] New container and public endpoint are healthy.
- [x] MCP tool smoke checks pass after deployment.
- [x] Async Golden Eval completes with real Salamander rendering.
- [x] Solo-piano, duration, lineage, and development checks pass.
- [x] MIDI, WAV, MP3, QA, license, and listening URL are verified.
- [x] Release evidence and recovery instructions are recorded.

## Release Evidence

### Source and rollback identity

- Base commit: `a10f8956d523235a733085bf269545ef32edc37a`.
- Pre-release image retained as `coding-mcp-chatgpt:rollback-tkt-20260810-003`:
  `sha256:5689299383d2a646fabcbdfd6ab45b9d50244ac04d445221ff3d80eecb8558bb`.
- First verified release image retained as `coding-mcp-chatgpt:release-tkt-20260810-003-v1`:
  `sha256:b78c0d7efc02ed92d20b872ceccfd0b5fc01081352b588edc6b7689f8bc74d9a`.
- Final deployed QA-fix image:
  `sha256:ab3c396512f23c0746c553070ff2b0c87bc1da0046097bfa385c61da5a19a403`.
- Final container: `a15edacff1746004f9718a00325c64688140da28c9acacef3e5cfb5ee85fbe58`.
- Host and image copies of `dist/mcp/tools/music-workflow-utils.js` and
  `dist/mcp/tools/music-workflow.js` matched byte-for-byte after the hotfix.
- Salamander asset SHA-256 remained
  `712d0e681efbe5203a8014e9b3e84168f1908c82f2f6fb13bd2c77d6d72c70b7`.

### Storage and Docker recovery

- The host initially had 116 MiB free. Only rebuildable npm caches were removed with
  `npm cache clean --force` and deletion of the exact `~/.npm/_npx` cache tree.
- Host disk exhaustion had caused Docker Desktop's ext4 journal to abort and remount read-only.
  Docker Desktop was recovered through its supported stop/start CLI, without deleting volumes.
- `docker builder prune --all --force` removed unused build cache and reclaimed 52.03 GB.
  Final host free space was approximately 46 GB.
- PostgreSQL and all named/project volumes were preserved throughout.

### Verification gates

- `npm run typecheck`: pass.
- `npm run lint`: pass.
- `npm run build`: pass.
- `npm run check:mcp`: pass; 617 tools, 50 skills, zero duplicate registrations.
- `npm test`: pass; 509/509 tests.
- `git diff --check`: pass.
- Deterministic audio-QA regressions prove all three cases:
  clean five-minute soft piano passes, persistent broadband hiss fails closed, and only
  non-loopable post-duration renderer padding is suppressed while internal/loopable gaps remain actionable.

### Build and deployment method

- The Dockerfile and dependency manifests were unchanged. After the cache recovery caused the
  full Dockerfile to re-download large pinned runtime music assets, the release used a safe
  incremental image layer: fresh verified `dist` and `admin-ui/dist` were copied onto the
  retained verified runtime image. The Salamander bytes and runtime dependencies were rechecked.
- Deployment used `docker compose up -d --no-deps --force-recreate --no-build coding-mcp-chatgpt`.
- Final application and PostgreSQL containers are healthy.
- Local and public application health returned HTTP 200.
- The content host correctly returned 404 for `/health`, preserving host separation.
- Unauthenticated public MCP POST returned 401.
- Authenticated local and public MCP initialization negotiated `2025-06-18`; `tools/list`
  exposed 446 enabled tools, including the production orchestrator, async job tools,
  validators, renderer, and audio QA. Temporary OAuth clients/tokens/sessions were revoked.

## Golden Eval Evidence

### Runs and QA correction

- First async run: `job_1fbc8623-45a5-4290-b408-39528c3928b2`.
- It correctly passed composition constraints and development QA, rendered all artifacts, and
  then failed closed because the old audio QA treated quiet piano decays as a noise floor and
  renderer tail padding as an internal silence gap.
- The fix replaced the RMS-only p10 floor with a stable low-energy broadband-noise estimator and
  filters only non-loopable silence outside the declared programme duration. Raw gap evidence is
  still retained in the technical report.
- The existing real 303-second WAV then passed online MCP preflight with `ok=true`,
  `productionSafe=true`, no findings, and no blocking reasons.
- Final async run: `job_812e3629-f4ed-4d80-9403-e1018a17e2bd`.
- Final status: `success`, 100%, `completed`; 15 artifacts, no errors.

### Musical constraints and development

- Source: `music/golden-20260810/source.composition.json`, derived truthfully from the user's
  57-note, 16.2-second piano melody and linked to `music/piano_piece.musicxml`.
- Arrangement duration: exactly 300 seconds; rendered audio duration: 303.005896 seconds,
  including a 2.691814-second post-programme release/padding tail.
- Instruments: piano only; two piano tracks; 341 right-hand plus 679 left-hand notes.
- Independent MIDI parse: 1020 note-ons, all on zero-based channel 0 (MIDI channel 1),
  program 0; zero note-ons on MIDI channel 10.
- Melody identity score: 1.000 (minimum 0.600).
- Development score: 0.785 (minimum 0.550).
- Repeated-section similarity: 0.676 (maximum 0.920).
- Exact-repeat ratio: 0.158 (maximum 0.350).
- Mechanical loop detection: false; seven transformation-evidence signals recorded.

### Audio, artifacts, and publishing

- WAV: PCM 16-bit, 44.1 kHz, stereo, 53,450,318 bytes.
- MP3: 192 kbps, 44.1 kHz, stereo, 7,273,787 bytes.
- Independent FFmpeg loudnorm measurement: -16.00 LUFS integrated, -1.50 dBTP,
  6.60 LU loudness range.
- Audio QA: `ok=true`, `productionSafe=true`, no findings/blockers; persistent broadband
  noise was not detected. The raw final silence gap remains in the evidence but is outside the
  300-second non-loopable programme.
- MIDI SHA-256: `34227c7fc85bdd146eee71adcb61edc692b077594543b6f0280b70c40eb95f82`.
- WAV SHA-256: `02cf8e314bcba1c139cea7422561d061fa28455cf8b3e9cda7161a6ef3ae33c7`.
- MP3 SHA-256: `281df6bbe6f712f6cd8775fb9247c1eb87cc014e934a65033746819a3a10a2f9`.
- MusicXML SHA-256: `0ef3c998c458311a5911252174df0eea1b098cd9ef47178d1e2a3b327bb612dd`.
- `LICENSES.md` identifies Salamander Grand Piano V3 (Yamaha C5) and includes the required
  FreePats / CC BY 3.0 attribution.
- Listening URL:
  `https://content.gmb01.xyz/share/project_4312d78c-a30e-433f-8524-3b86b5f874e5/music/golden-20260810-final/listen.html`.
- Public verification: listening page HTTP 200; MP3 and WAV byte-range requests HTTP 206.
- No MIDI, WAV, MP3, SoundFont, or stem bytes passed through the LLM as Base64.

## Rollback Instructions

To roll back only the QA hotfix while keeping the rest of this release:

```sh
docker tag coding-mcp-chatgpt:release-tkt-20260810-003-v1 coding-mcp-chatgpt:local
docker compose up -d --no-deps --force-recreate --no-build coding-mcp-chatgpt
```

To restore the complete pre-release application image:

```sh
docker tag coding-mcp-chatgpt:rollback-tkt-20260810-003 coding-mcp-chatgpt:local
docker compose up -d --no-deps --force-recreate --no-build coding-mcp-chatgpt
```

Neither rollback procedure changes or deletes PostgreSQL/project volumes.

## Skill Reflection

- Searched the active global and project skill locations for Docker disk-exhaustion recovery,
  music rendering, SoundFont, noise-floor, and audio-QA guidance.
- No new skill was created. The audio estimator and tail-gap behavior are repository-specific
  and are now enforced by deterministic tests; the Docker incident was a single environment
  recovery with potentially destructive cleanup choices, so it is documented here instead of
  being generalized prematurely.
- The existing `quality-check-improvement-loop` skill already covers the reusable fail-fix-retest
  workflow used for the Golden Eval.
