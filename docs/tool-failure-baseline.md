# Tool failure baseline (2026-07-30)

The purpose of this file is to make improvement provable. Re-run the report after a fix and
compare against these numbers — do not claim a fix worked without doing so.

```bash
npm run report:telemetry              # all retained days
npm run report:telemetry -- --days 7  # last 7 days
npm run report:telemetry -- --json    # machine-readable, for diffing runs
npm run report:telemetry -- --tool apply_patch   # sample the actual failing payloads
```

## How this baseline was found

The `.telemetry/` sink had been accumulating since 2026-06-20 and nothing had ever read it.
The working assumption before measuring was "611 tools registered, 435 reach `tools/list`,
that's too many and it's hurting the agent." Aggregating 39 days of real traffic contradicted
that:

- Only **216 of 611** tools have ever been called. The ~219 never-called tools are dead
  weight, not a source of failure.
- The real cost is a **13.6% call failure rate** concentrated in a handful of high-traffic
  tools — invisible day-to-day because agents silently retry.
- Most of those root-cause to **the JSON Schema not telling the agent what the argument
  actually looks like**, or to a missing binary in the container.

Priority was therefore reordered to: infrastructure → schema/error messages → tool count.

## Baseline numbers

Window: `2026-06-20` .. `2026-07-29` (39 day files)

| Metric | Value |
|---|---|
| `tools/call` total | 13,986 |
| Failures | 1,896 |
| **Failure rate** | **13.6%** |
| Distinct tools ever called | 216 (of 611 registered) |
| Dominant client | `openai-mcp` (ChatGPT), ~12.9k of 14.0k calls |

### Top failing tools

| Tool | Calls | Failures | Rate | Root cause |
|---|---|---|---|---|
| `inspect_interaction_flow` | 637 | 233 | 36.6% | `steps` published as untyped `{type:"object"}`; validated against a 7-arm discriminated union |
| `apply_patch` | 330 | 204 | 61.8% | `git apply --check`: "No valid patches in input" |
| `inspect_project_workspace` | 360 | 136 | 37.8% | Server health timeout; also tests the *requested* port even when the app bound elsewhere |
| `search_in_project` | 125 | 125 | **100%** | `spawn rg ENOENT` — ripgrep not installed in the container |
| `patch_project_file` | 1374 | 99 | 7.2% | Find-text not present in target file |
| `audit_project_pwa` | 144 | 55 | 38.2% | ⚠️ see "Not all failures are bugs" below |
| `search_files` | 275 | 52 | 18.9% | `ENOENT scandir .../workspace/src` |
| `read_app_project_file` | 561 | 49 | 8.7% | "too large to read. Size=4492, maxBytes=4000" |
| `inspect_audio_quality` | 58 | 48 | 82.8% | ENOENT on the `.wav`; plus a missing guard makes manifest-only QA never pass |
| `run_project_npm_command` | 308 | 45 | 14.6% | **Doubled path**: `.../workspace/workspace/package.json` |
| `import_project_workspace_asset_from_local_file` | 30 | 30 | **100%** | Extension rejected; the allowlist is never named in the error |
| `test_failure_digest` | 28 | 24 | 85.7% | "Command is not in allowlist" — allowlist never enumerated |
| `audit_lighthouse` | 8 | 8 | **100%** | `CHROME_PATH` environment variable not set |

## Not all failures are bugs

Audit-style tools return `ok: false` when the audit *found problems* — that is correct
behaviour, not a defect. `audit_project_pwa` ("Entry file does not link to a web app
manifest") and `inspect_3d_scene_visuals` ("found 6 blocking 3D visual issues") are in this
category. The true "tool is broken" rate is therefore lower than 13.6%.

Do not chase the headline number blindly. The unambiguous defects are the ones where the tool
could not even attempt its job: missing binary (`search_in_project`, `audit_lighthouse`),
schema the agent cannot see (`inspect_interaction_flow`), or a wrong answer returned as
success (`inspect_project_workspace` inspecting an unrelated app on an occupied port).

## Protocol version coverage

`protocolVersion` was not recorded before 2026-07-30, so every historical `initialize` row
reports `(unrecorded)`. After that change, `initialize` stores the **negotiated** version and
every later `tools/list` / `tools/call` from the same client inherits it.

This matters because `outputSchema` was introduced in MCP `2025-06-18`. This server supports
`2024-11-05`, `2025-03-26`, and `2025-06-18` (`src/http/mcp-routes.ts`), but until the report
shows which revision ChatGPT actually negotiates, building against `outputSchema` is
unverifiable. Check the "Negotiated MCP protocol versions" section of the report before
starting that work.
