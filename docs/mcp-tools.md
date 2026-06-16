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
- Research delivery: `create_research_project`, `add_research_source`, `list_research_sources`, `add_research_note`, `record_research_evidence`, `get_research_manifest`, `write_research_report`, `publish_research_report`.
- Code intelligence: `refactor_hints` for advisory oversized-file and mixed-responsibility refactor signals.
- Browser validation: `inspect_webpage`.
- Webpage rebuild workflow: `capture_webpage`, `analyze_webpage_capture`, `generate_improved_static_page`.
- Stable command checks backed by current package scripts: `run_command`, `run_typecheck`, `run_tests`, `run_build`.
- Workspace and git tools delegated from the legacy implementation.

Disabled by default and available only when Admin toggles them on:

- `delete_project`: destructive project operation.
- `create_share`: legacy standalone share; use Project publish for deliverables.
- `check_url`: network access / SSRF-sensitive diagnostic helper.
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

`deliver_static_project` is the preferred delivery tool because it writes all files, validates local references, temporarily publishes, runs browser validation through Playwright, blocks on serious runtime/layout failures, and returns a structured report with the public `publishedUrl`.

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
