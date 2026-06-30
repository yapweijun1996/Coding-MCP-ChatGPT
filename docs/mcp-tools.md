# MCP Tools Architecture

The MCP server uses a single source of truth registry for tool metadata, handlers, and default access.

## Core files

- `src/mcp/types.ts`: shared tool types.
- `src/mcp/registry.ts`: exports `toolRegistry`, `toolDefinitions`, and lookup helpers.
- `src/mcp/router.ts`: validates inputs and dispatches `tools/call` to handlers.
- `src/mcp/result.ts`: shared result helpers.
- `src/skills/registry.ts`: local built-in agent skill packs and their exposed tool names.
- `src/skills/state.ts`: persistent Admin-managed skill enablement state.

## Tool groups

- `src/mcp/tools/preview.ts`: `ping`, `create_preview`.
- `src/mcp/tools/skills.ts`: `list_agent_skills`, `get_agent_skill`.
- `src/mcp/tools/project.ts`: persistent Project CRUD, manifest, validation, and publish tools.
- `src/mcp/tools/code-intelligence.ts`: repo summaries, test failure digests, changed file context, and advisory refactor hints.
- `src/mcp/tools/research.ts`: research source, evidence, notes, report, and publish workflow tools.
- `src/mcp/tools/share.ts`: legacy standalone HTML share tool, disabled by default.
- `src/mcp/tools/web-rebuild.ts`: webpage capture, analysis, and static rebuild tools backed by Playwright and Project publish.
- `src/mcp/tools/presentation.ts`: HTML deck, PPTX deck, immersive page, and browser-rendered video presentation tools.
- `src/mcp/tools/music-workflow.ts`: score import, MIDI editing, SoundFont rendering, audition, audio QA, licensing, and music export tools.
- `src/mcp/tools/workspace.ts`: workspace file tools delegated to legacy implementation.
- `src/mcp/tools/command.ts`: stable npm checks plus disabled high-risk diagnostics/server helpers.
- `src/mcp/tools/git.ts`: git tools delegated to legacy implementation.

## Default access

Admin access is now two-layered:

1. A tool must be enabled by its raw tool override.
2. At least one enabled Skill pack must expose that tool.

`tools/list` returns only effectively enabled tools, and direct `tools/call` is rejected if either layer blocks the tool. Special visible browser control tools remain separately time-gated under Admin Special Tools.

Enabled by default:

- Connectivity, preview, and skill protocol lookup: `ping`, `create_preview`, `list_agent_skills`, `get_agent_skill`.
- Project delivery: `deliver_static_project`, `create_project`, `list_projects`, `get_project`, `get_project_manifest`, `get_project_activity`, `write_project_file`, `read_project_file`, `delete_project_file`, `validate_project`, `publish_project`, `publish_and_report`.
- App project delivery: `create_app_project`, `write_app_project_file`, `read_app_project_file`, `install_project_dependencies`, `run_project_build`, `publish_project_dist`, `get_app_project_report`.
- Research delivery: `create_research_project`, `add_research_source`, `list_research_sources`, `add_research_note`, `record_research_evidence`, `get_research_manifest`, `write_research_report`, `publish_research_report`.
- Code intelligence: `refactor_hints` for advisory oversized-file and mixed-responsibility refactor signals.
- Browser validation: `inspect_webpage`.
- Webpage rebuild workflow: `capture_webpage`, `analyze_webpage_capture`, `generate_improved_static_page`.
- Presentation and media generation: `create_html_deck`, `create_pptx_deck`, `create_immersive_page`, `create_video_presentation`, `create_media_scene_timeline`, `add_media_captions`, `attach_media_voice_audio`, `preview_media_frames`, `export_media_project`.
- Video editor workflow: `create_video_project`, `import_video_asset_from_local_file`, `probe_video_asset`, `extract_video_frames`, `create_video_scene_asset`, `write_video_timeline`, `preview_video_timeline`, `render_video_timeline`.
- Music workflow: `import_musicxml_score`, `validate_music_ensemble`, `edit_midi`, `check_music_render_environment`, `render_production_music`, `install_free_soundfont_pack`, `discover_soundfont_packs`, `render_midi_with_soundfont`, `render_midi_to_audio`, `inspect_audio_quality`, `manage_jazz_instrument_packs`, `build_music_license_manifest`, `publish_music_audition_demo`, `export_music_project`, and supporting arrangement/export tools.
- Stable command checks backed by current package scripts: `run_command`, `run_typecheck`, `run_tests`, `run_build`.
- Workspace and git tools delegated from the legacy implementation.

Disabled by default and available only when Admin toggles them on:

- `delete_project`: destructive project operation.
- `create_share`: legacy standalone share; use Project publish for deliverables.
- `check_url`: network access / SSRF-sensitive diagnostic helper.
- `run_project_dev`: starts a local Vite dev server for app project previews.
- `stop_project_dev`: controls local dev servers started by MCP.
- `open_local_server`: starts a local process.
- `stop_local_server`: controls local processes started by MCP.
- `open_local_server_and_check`: starts a local process and performs a network check.
- `run_lint`: disabled until this project defines a `lint` package script.
- `run_format_check`: disabled until this project defines a `format` package script.
- `run_format_write`: mutating formatter command; keep disabled unless explicitly needed.
- `diagnostic_bundle`: depends on lint/typecheck/test; disabled until lint exists.
- `diagnostic_bundle_full`: depends on lint/typecheck/test; disabled until lint exists.

## Registry checks

Run this before deployment:

```bash
npm run check:mcp
```

The check builds `dist/`, verifies registry uniqueness, confirms critical tools exist, confirms high-risk tools are disabled by default, and ensures default-enabled command tools have matching package scripts.
It also validates Skill ids, confirms all Skill tool references exist, confirms the `high-risk` Skill is disabled by default, and confirms the `core` Skill exposes the Skill protocol lookup tools.

## Compatibility note

`src/mcp/tools.ts` is intentionally kept as a compatibility re-export during the transition. New code should import from `registry.ts`, `router.ts`, or `types.ts` directly.

## Recommended agent workflow

ChatGPT and other coding agents should use the persistent Project workflow for deliverables:

1. Use `deliver_static_project` for normal static HTML/CSS/JS deliverables.
2. Use `get_project_activity` if the agent needs task history or latest validation context.
3. Use the lower-level `create_project` / `write_project_file` / `validate_project` / `publish_and_report` flow only for repair or incremental edits.

`deliver_static_project` is the preferred delivery tool because it writes all files, validates local references, temporarily publishes, runs browser validation through Playwright, blocks on serious runtime/layout failures, and returns a structured report with the shareable `publishedUrl`.

Projects are private by default. Agent-facing delivery tools explicitly publish final handoff links with `shareAccess: "anyone_with_link"` by default so users and sandboxed preview sessions can load HTML plus referenced assets such as images, audio, and video. Use `shareAccess: "private"` only for internal previews that should require the owner/admin session cookie.

### Project workflow recipes

Use these exact argument names when calling project tools. `projectId` is the persistent Project identifier used by follow-up tools. Many tool results also set `jobId` to the same value for compatibility with generic job UIs, but follow-up project calls should pass `projectId`.

Preferred path for a complete static HTML/CSS/JS deliverable:

```json
{
  "tool": "deliver_static_project",
  "arguments": {
    "title": "Landing page",
    "entryFile": "index.html",
    "files": [
      { "path": "index.html", "content": "<!doctype html><html><head><link rel=\"stylesheet\" href=\"styles.css\"></head><body><h1>Hello</h1><script src=\"app.js\"></script></body></html>" },
      { "path": "styles.css", "content": "body { font-family: system-ui, sans-serif; }" },
      { "path": "app.js", "content": "console.log('ready');" }
    ]
  }
}
```

Use this path when the agent is producing the first complete version of a static app or site. Return `shareUrl` / `publishedUrl` to the user. Do not call legacy `create_share` for project deliverables.

Lower-level path for incremental edits or repair of an existing Project:

```json
{ "tool": "create_project", "arguments": { "title": "Repairable page", "entryFile": "index.html" } }
```

Capture `structuredContent.projectId` or `jobId`, then use that value as `projectId`:

```json
{ "tool": "write_project_file", "arguments": { "projectId": "proj_123", "path": "index.html", "content": "<!doctype html><html><body><h1>Ready</h1></body></html>" } }
```

```json
{ "tool": "validate_project", "arguments": { "projectId": "proj_123", "entryFile": "index.html" } }
```

```json
{ "tool": "publish_and_report", "arguments": { "projectId": "proj_123", "entryFile": "index.html" } }
```

Use `publish_project` only when the project has already passed validation and a browser report is not needed. It defaults to `shareAccess: "anyone_with_link"`; pass `shareAccess: "private"` only for owner-only internal previews. Use `publish_and_report` when handing off a fixed project because it publishes and returns a structured delivery report including `shareAccess`. Use `inspect_webpage`, `audit_accessibility`, `auto_fix_accessibility`, or `get_project_activity` after a failed validation or visual/runtime concern.

If published share pages show `Access to XMLHttpRequest at '.../cdn-cgi/rum?' from origin 'null' has been blocked by CORS policy`, treat it as Cloudflare Web Analytics/RUM injection in a sandboxed/null-origin preview context. Disable RUM injection for `/share/*` at the Cloudflare layer, or avoid injecting analytics into sandboxed project content.

Safe recovery from blocked writes:

1. Call `get_project_activity` with the `projectId` to inspect recent task history and validation failures.
2. Call `get_project_manifest` to verify the entry file, file list, and last validation.
3. Call `read_project_file` before overwriting a file the agent did not just create.
4. Use `create_project_backup` before broad rewrites, then `restore_latest_project_backup` if the repair makes the project worse.

For idea-to-demo React, Vue, or Vite apps, use the App project workflow:

1. `create_app_project` with `template` set to `vite-react`, `vite-vue`, or `vite-vanilla`.
2. `write_app_project_file` for source edits in `workspace/`.
3. `install_project_dependencies`.
4. `run_project_dev` when a local preview is useful.
5. `run_project_build`.
6. `publish_project_dist` with `outputDir: "dist"` and `entryFile: "index.html"`.
7. Return the `shareUrl` and Admin ZIP download link.

`publish_project_dist` replaces files from its previous app-dist publish, but preserves project files created by other workflows such as `music/*.wav`, `music/*.mid`, reports, manifests, and imported media assets. If an app needs audio or model files in its own build output, include them in `dist/`; common audio, MIDI, image, video, and GLB/GLTF assets are publishable.

## Presentation workflow

Use `create_video_presentation` for a quick storyboard/video-preview only — it is not a finished explainer video. The tool creates a Project with `index.html`, `video.css`, `video.js`, and a vendored MIT MP4 muxer module. The generated page lets a user scrub scenes and export a video-only MP4 preview in-browser via WebCodecs (no audio mix, no subtitle burn-in, no server-side final render). It returns `structuredContent.qualityTier = "storyboard_preview"` and `productionReady = false`. For a finished explainer video with captions, voice-over, and proper MP4/WebM output, use the scripted media workflow (`create_media_scene_timeline` → `add_media_captions` → `attach_media_voice_audio` → `preview_media_frames` → `export_media_project`) instead.

Use the scripted media workflow tools when the agent needs a reusable export handoff: create a scene timeline, add WebVTT captions, attach voice/audio alignment metadata, generate frame preview contact sheets, then create an export manifest for MP4/WebM/GIF/PNG sequence/HTML preview. The workflow is designed around Code-MCP project files, browser standards, and MIT-compatible muxing where used; it does not require a paid video engine. Byte encoding remains an explicit verified encoder step, and any optional external encoder must have its license and commercial-use status recorded before delivery.

Use the video editor workflow when ChatGPT needs to operate on uploaded video or CRUD an edit timeline: create a project, import MP4/WebM/MOV assets, probe metadata with `ffprobe`, extract bounded review frames, add SVG/WebGL scene assets, write the timeline JSON, generate an HTML preview, and render the MVP video-only timeline with `ffmpeg`. The initial renderer supports sequential video clip trimming and concatenation without audio mixing; SVG/WebGL clips are previewable references and require a later browser-scene recording step for final byte render.

The presentation generator does not render MP4 files server-side. If WebCodecs is unavailable, the generated page shows a clear browser capability error and remains usable as an animated HTML preview.

## Score-first music workflow

Use `import_musicxml_score` when a user provides MusicXML or asks for score-driven music. For user-facing music requests, the AI agent should author explicit MusicXML itself first, then import it with this tool to create the normal composition manifest and standard `.mid` file. Instrument identity is preserved: each `<score-part>` is mapped to a canonical instrument track from its `<part-name>` or `<midi-instrument><midi-program>` (e.g. a part named "Cello" or carrying GM program 43 stays a `cello` track, not `piano_2`). The generated MIDI also emits deterministic Program Change events so renderers honour the intended instrument. Missing tempo or meter metadata falls back conservatively to 90 BPM and 4/4-style timing; only a part with no usable name or program defaults to piano, and the manifest records warnings.

For any user-facing request to make music, a song, professional audio, cafe/venue background music, client-ready music, or a public demo, use this score-first workflow by default: write MusicXML, import to MIDI, render with Salamander Grand Piano when the request is piano-focused. Do not deliver browser oscillator, procedural synth, generic composition-tool MIDI, or other robotic preview audio as finished music.

Preferred professional path:

1. Author explicit MusicXML for the requested score, then call `import_musicxml_score` with `musicXmlPath` or `musicXmlString`.
2. For piano-focused requests, use `install_free_soundfont_pack` with `packId="salamander_grand"` and render with `render_midi_with_soundfont` / `render_production_music` using `soundfontPackId="salamander_grand"`. If Salamander is not installed, report the required files and stop instead of silently using a fallback.
3. For non-piano ensembles, use `install_free_soundfont_pack` for the v1 free GeneralUser GS candidate, or `discover_soundfont_packs` to inspect existing `.sf2`, `.sf3`, and `.sfz` assets. `install_free_soundfont_pack` now **auto-registers** the installed pack into `music/jazz-instrument-packs.json` as a `general_midi` pack and returns `autoRegistered`/`readyPackIds`, so you can render with the same pack id immediately — no separate `manage_jazz_instrument_packs` step is required for the free pack. A `general_midi` pack covers every instrument role (piano, cello, violin, strings, bass, drums...), so one GeneralUser GS install renders a full ensemble; `midiBuffer` emits the per-track Program Change events FluidSynth needs to voice each instrument correctly.
4. For your own/third-party packs, register a commercial-safe SoundFont or SFZ pack with `manage_jazz_instrument_packs`, including source URL, license text path, README path, attribution, SHA-256, redistribution notes, `productionUseApproved`, and `qualityTier`.
5. Use `edit_midi` only if arrangement cleanup is needed.
   - For multi-instrument requests (e.g. a cello + piano duet), run `validate_music_ensemble` with `requiredInstruments` before rendering. It fails closed when any requested instrument has zero notes, when the instruments never play simultaneously (a sequential handoff instead of a real ensemble), or when a long single-instrument stretch is not marked as an intentional solo (pass `soloInstruments`). It reports per-track note count and first/last note time so misleading output is caught before publishing. The same gate is available inline on `compose_edit_midi` via the optional `ensembleRequirement` field, which flips the result to `ok:false` (instead of a misleading success) when the requirement is not met; omit it to keep default/solo behaviour.
6. Run `check_music_render_environment` to detect `sfizz_render`, FluidSynth, FFmpeg, SoX, and available `.sf2`/`.sf3`/`.sfz` candidates.
7. Render the complete V1 handoff with `render_production_music`; it creates MIDI stems, rendered WAV stems, a stem-mixed `music/production.wav`, FFmpeg-encoded `music/preview.mp3`, `LICENSES.md`, a JSON pipeline report, and a page with Play Preview / Download WAV / Download MP3 controls.
8. Run `inspect_audio_quality`.
9. Export with `export_music_project` when an additional package manifest/playlist handoff is needed.

`render_production_music` is the preferred V1 production path. It requires a registered `production_candidate` instrument pack, an offline renderer (`sfizz_render` for SFZ or FluidSynth for `.sf2`/`.sf3`), and FFmpeg for MP3 export. If those requirements are missing, it returns `preview_only` and the user-facing label must be “MIDI preview only. Not production audio.” `render_midi_with_soundfont` remains the lower-level production-candidate renderer for WAV/stem creation. `render_midi_to_audio` is the built-in procedural ("WebAudio-style") synth and is **fail-closed**: it refuses by default and only emits audio when called with `acknowledgePreviewOnly: true`, producing an explicitly throwaway, non-deliverable scratch preview. Without that flag it returns `ok:false` and points to `install_free_soundfont_pack` → `render_production_music`/`render_midi_with_soundfont`. The `extend_music_arrangement` / `extend_original_music_arrangement` tools follow the same rule: with `renderAudio: true` but no `acknowledgePreviewOnly`, they skip the procedural preview and return a `previewWarning` instead of writing fake audio. Procedural output must never be used for finished music, professional music, public listening demos, or production handoff pages.

Instrument pack roles cover `realistic_piano`, `upright_bass`, `brush_drums`, `room_ambience`, plus `cello`, `violin`, and `strings` as first-class per-instrument roles, and `chamber_ensemble` and `orchestral_sketch` as registerable ensemble roles. `cello`, `violin`, and `strings` each route from their own track names and render to their own stem, so a cello + piano duet produces a dedicated `cello.wav` next to `piano.wav` and the mixed `production.wav` — cello/violin/strings are no longer folded into the pad/ambience stem. `chamber_ensemble` and `orchestral_sketch` packs can be registered and selected via `instrumentPackMap`, but no track currently auto-routes to them (they are reserved for explicit ensemble mapping); orchestral/chamber arrangements today render through the `strings`/`cello`/`violin` roles. Register a pack per required role (use `instrumentPackMap`, e.g. `{ "realistic_piano": "...", "cello": "..." }`); a composition needing a role with no ready pack fails closed on coverage. Every rendered stem is RMS-validated (`stemValidations` in the report); `render_production_music` refuses to publish if any requested stem is effectively silent, so a missing/empty instrument can never ship as a misleading mix.

GeneralUser GS is the v1 built-in free SoundFont candidate and uses license key `generaluser_gs_2_0`; do not label it MIT. Docker images preinstall it under `/app/soundfonts/generaluser-gs/`, and `install_free_soundfont_pack` copies that bundled cache into the target project before falling back to an upstream download. Treat it as a free/commercial-friendly SoundFont render candidate only after the project keeps the `.sf2`, `LICENSE.txt`, `README.md`, source URL, computed SHA-256, and clean QA/render reports. Avoid “Spotify-level” claims; use `production_candidate render` or `production-ready candidate after QA/license gates`.

For V1 piano rendering, prefer a registered `realistic_piano` SFZ/SoundFont such as a license-cleared Salamander Grand Piano or FreePats-style piano pack. Do not redistribute raw sample libraries unless the license explicitly allows redistribution. DecentSampler or Decent Samples libraries may be referenced only when source URL, license text, README, attribution, redistribution notes, and commercial-use flags are stored in project metadata and `LICENSES.md`.

Do not commit large `.sf2`, `.sf3`, SFZ sample sets, or other instrument binaries into git. Store local packs in project data or a configured workspace path such as `.music-packs/`, then register metadata and attribution before rendering or export.

## Refactor hint workflow

For code review or modernization tasks, agents can call `refactor_hints` before proposing broad cleanup. The tool scans workspace files and returns advisory candidates when a file exceeds the configured line or byte threshold, or when it shows mixed-responsibility signals.

Default thresholds are 1000 lines or 40KB. The result is intentionally advisory: agents should report the candidate path, reasons, proposed split direction, and smallest validation check before editing. The tool must not be treated as permission to refactor automatically.

## Webpage capture and rebuild workflow

For authorized webpage improvement tasks, agents should use:

1. `capture_webpage` to inspect one public HTTPS page or same-origin depth-1 links. The tool stores full capture JSON under `.captures/{captureId}.json` and returns a share report.
2. `analyze_webpage_capture` to create `.captures/{analysisId}.analysis.json` with UX, accessibility, performance, SEO, and implementation findings.
3. `generate_improved_static_page` to generate a static Project from the capture and analysis, validate it, publish it, and optionally run browser validation.

This workflow does not copy original CSS/JS or bypass website permissions. It uses captured structure and text as source evidence for a rebuilt static page.

See `docs/agent-delivery-reliability.md` for the full delivery runbook, validation gates, structured result contract, and smoke checklist.

## Research delivery workflow

For long research reports, ChatGPT should use its own web search and use this MCP to persist and publish the work:

1. `create_research_project`
2. `add_research_source` for each selected source.
3. Optional `inspect_webpage`, then `record_research_evidence` for key evidence.
4. `add_research_note` for findings, contradictions, open questions, and methodology.
5. `write_research_report` with agent-authored `report.md` and `report.html`.
6. `publish_research_report`

`publish_research_report` blocks publishing unless the research manifest contains sources and report files, and `report.html` references at least one source id or source URL.

See `docs/research-workflow.md` for the file layout and validation contract.
