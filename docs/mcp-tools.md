# MCP Tools Architecture

The MCP server uses a single source of truth registry for tool metadata, handlers, and default access.

## Core files

- `src/mcp/types.ts`: shared tool types.
- `src/mcp/registry.ts`: exports `toolRegistry`, `toolDefinitions`, and lookup helpers.
- `src/mcp/router.ts`: validates inputs and dispatches `tools/call` to handlers.
- `src/mcp/result.ts`: shared result helpers.

## Tool groups

- `src/mcp/tools/preview.ts`: `ping`, `create_preview`.
- `src/mcp/tools/project.ts`: persistent Project CRUD, manifest, validation, and publish tools.
- `src/mcp/tools/share.ts`: legacy standalone HTML share tool, disabled by default.
- `src/mcp/tools/workspace.ts`: workspace file tools delegated to legacy implementation.
- `src/mcp/tools/command.ts`: stable npm checks plus disabled high-risk diagnostics/server helpers.
- `src/mcp/tools/git.ts`: git tools delegated to legacy implementation.

## Default access

Enabled by default:

- Connectivity and preview: `ping`, `create_preview`.
- Project delivery: `deliver_static_project`, `create_project`, `list_projects`, `get_project`, `get_project_manifest`, `get_project_activity`, `write_project_file`, `read_project_file`, `delete_project_file`, `validate_project`, `publish_project`, `publish_and_report`.
- Browser validation: `inspect_webpage`.
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

## Compatibility note

`src/mcp/tools.ts` is intentionally kept as a compatibility re-export during the transition. New code should import from `registry.ts`, `router.ts`, or `types.ts` directly.

## Recommended agent workflow

ChatGPT and other coding agents should use the persistent Project workflow for deliverables:

1. Use `deliver_static_project` for normal static HTML/CSS/JS deliverables.
2. Use `get_project_activity` if the agent needs task history or latest validation context.
3. Use the lower-level `create_project` / `write_project_file` / `validate_project` / `publish_and_report` flow only for repair or incremental edits.

`deliver_static_project` is the preferred delivery tool because it writes all files, validates local references, temporarily publishes, runs browser validation through Playwright, blocks on serious runtime/layout failures, and returns a structured report with the public `publishedUrl`.

See `docs/agent-delivery-reliability.md` for the full delivery runbook, validation gates, structured result contract, and smoke checklist.
