# Engineering Handover Guide

Welcome. This is the document to read **first** if you are new to this codebase. It gives you
the mental model, where things live, how to run and test the system, and the conventions you
must follow. Every section links to a deeper doc; this page is the map, not the territory.

---

## 1. What this project is (in one paragraph)

This is an **HTTP MCP (Model Context Protocol) server**, written in TypeScript on Express
([`src/server.ts`](../src/server.ts)). It exposes a curated set of **tools** (file/project
delivery, research, music generation, browser QA, git, etc.) to **ChatGPT** (and other MCP
clients) over `POST /mcp` JSON-RPC, authenticated with **OAuth**. Tools do real work on the
server — they create persistent **projects**, build and **publish** static sites, render music,
run browser audits — and return **shareable result links** (`/share/{projectId}/...`). The
public entry point is `https://gmb01.xyz/mcp`, fronted by a Cloudflare Tunnel; the Node process
listens on `127.0.0.1:6859`.

**The mental model:** *ChatGPT is the brain; this server is the hands.* ChatGPT decides what to
do and calls our tools; each tool validates its input, performs a controlled side effect, and
returns a standardized result with a link. The server enforces safety (path allow-listing, SSRF
guards, a two-layer tool access gate) so an untrusted model can't do arbitrary damage.

---

## 2. Read these, in this order

| # | Doc | What you get |
|---|---|---|
| 1 | **this file** | the map + how to run/test |
| 2 | [`code-map.md`](code-map.md) | where every `src/` module lives and what it does |
| 3 | [`architecture.md`](architecture.md) | the high-level architecture & boundaries |
| 4 | [`request-lifecycle.md`](request-lifecycle.md) | how a `tools/call` flows end to end (auth → gate → handler → result) |
| 5 | [`adding-a-tool.md`](adding-a-tool.md) | step-by-step: add a new MCP tool the right way |
| 6 | [`mcp-tools.md`](mcp-tools.md) | the full tool catalog + default access rules |
| 7 | [`project-management.md`](project-management.md) | the persistent Project store (the core deliverable mechanism) |
| 8 | [`music-workflow.md`](music-workflow.md) | the largest/most complex subsystem, as a worked example |
| 9 | [`setup.md`](setup.md) · [`docker.md`](docker.md) · [`operations.md`](operations.md) · [`cloudflare.md`](cloudflare.md) | run, containerize, operate, expose |

---

## 3. Local development setup

**Prerequisites:** Node.js 20+ (the repo is tested on Node 23), npm. Optional but useful:
Docker (for the production-like stack + Postgres), `ffmpeg`/`fluidsynth` (for media/music),
a Chromium for browser-QA tools (Playwright pulls its own).

```bash
npm install                 # install dependencies
npm run dev                 # tsx watch src/server.ts — hot-reloading dev server on :6859
curl -sS http://127.0.0.1:6859/health
```

Configuration is via environment variables (see the full list in the root
[`README.md`](../README.md#配置说明) and [`setup.md`](setup.md)). The ones you will touch most:

| Var | Purpose |
|---|---|
| `PORT` | HTTP port (default `6859`) |
| `NODE_ENV` | `development` / `production` |
| `MCP_DEV_TOKEN` | a bearer token that bypasses OAuth **only** in non-production (disabled when `NODE_ENV=production`) |
| `MCP_RATE_LIMIT_MAX_REQUESTS` / `MCP_RATE_LIMIT_WINDOW_MS` | per-user/per-client `/mcp` request limit (defaults: 100 requests / 60s) |
| `CONVERSATION_FILE_MAX_BYTES` / `FILE_TRANSFER_TIMEOUT_MS` | native ChatGPT connector-file transfer ceiling/timeout (defaults: 100 MiB / 5 minutes) |
| `PUBLIC_BASE_URL` | external base URL used to build share/preview links (default `https://gmb01.xyz`) |
| `WORKSPACE_ROOT` | the directory tools are allowed to operate in |
| `DATABASE_URL` | Postgres connection (the store falls back to JSON files if absent) |

For local testing of `/mcp` without ChatGPT, set `MCP_DEV_TOKEN` and send
`Authorization: Bearer <token>` — see the `curl` examples in the README.

---

## 4. The inner dev loop

Run these constantly. They are fast and they are the same checks CI runs.

| Command | What it does | When |
|---|---|---|
| `npm run typecheck` | checks generated tool-manifest drift, then runs `tsc --noEmit` over server + admin-ui | after any edit |
| `npm test` | typecheck **then** `tsx --test tests/*.test.ts` | before every commit |
| `npm run check:mcp` | builds `dist/`, then validates registry contracts, skill references, and that heavy tool groups stay cold during discovery | before shipping tool changes |
| `npm run benchmark:registry` | measures registry/server cold import and RSS, verifies cold groups remain unloaded, and times first load of browser, music, and presentation groups in isolated processes | after changing registry grouping or imports |
| `npm run lint` | eslint over `src/` + `tests/` | before commit |
| `npm run build` | `tsc` server build + admin-ui build | release / docker |

> **Test a single file fast:** `npx tsx --test --test-timeout=120000 --test-force-exit tests/music-workflow.test.ts`

**Known flaky tests:** two `jobs-store` restart-reconciliation tests
(`a persisted running job is reconciled to error on restart`, `… survives restart unchanged`)
fail intermittently in isolation and are **not** related to most changes. If only those two
fail, it is pre-existing — don't pin them on your branch. Everything else should be green.

---

## 5. Docker, build, and deploy

The production-like stack is Docker Compose: the app (`coding-mcp-chatgpt`, port 6859) plus
Postgres (`coding-mcp-postgres`). See [`docker.md`](docker.md) for data directories and env.

```bash
npm run docker:up        # docker compose up -d --build  (rebuild image + (re)start, zero-downtime swap)
docker compose ps        # confirm both services are healthy
docker compose logs -f coding-mcp-chatgpt
npm run docker:down      # stop
```

**Deploy = rebuild the image and recreate the app container.** The old container keeps serving
until the new image is built, so there is no downtime window. Verify a deploy by confirming the
image is freshly built, the container reports `healthy`, and the log shows
`coding-mcp-chatgpt listening on http://0.0.0.0:6859`. "Build exited 0" is **not** proof of a
deploy — check the running state.

> Long Docker builds should be run as a background job so a session timeout doesn't kill them
> mid-build. The container has a real FluidSynth + GeneralUser GS SoundFont preinstalled under
> `/app/soundfonts/generaluser-gs/` (the host may not), which is where you verify real music
> audio.

Public exposure is via Cloudflare Tunnel → see [`cloudflare.md`](cloudflare.md). Day-2
operations and rollback notes are in [`operations.md`](operations.md).

---

## 6. How the system fits together

```
ChatGPT ──HTTPS──► Cloudflare Tunnel (gmb01.xyz) ──► Express (127.0.0.1:6859)
                                                       │
        ┌──────────────────────────────────────────────┤
        ▼                  ▼                  ▼          ▼
   OAuth (/oauth,     MCP (/mcp JSON-RPC)  Content     Admin (/admin)
   /.well-known)      router → registry    (/share,    React ops console
                      → access gate        /outcome)
                      → tool handler
                              │
                     ToolContext (projectRoot, artifactRoot, …)
                              │
                  Project store ──► .../projects/{projectId}/files/
                              │
                  Publish ──► /share/{projectId}/index.html
```

The full step-by-step (with real file/function names) is in
[`request-lifecycle.md`](request-lifecycle.md). The key invariant: a tool is callable only if
**both** (a) it is enabled by its raw tool-state override **and** (b) at least one enabled
**skill pack** exposes it. Forgetting (b) is the #1 "my tool isn't showing up" mistake.

---

## 7. Subsystem tour

| Subsystem | Code | Doc | What it does |
|---|---|---|---|
| MCP core | `src/mcp/` | [request-lifecycle](request-lifecycle.md), [adding-a-tool](adding-a-tool.md) | registry, router, result shape, tool modules |
| Projects | `src/projects/` | [project-management](project-management.md) | persistent static-site projects: create/write/validate/publish/zip; the main deliverable path |
| Research | `src/research/` | [research-workflow](research-workflow.md) | persistent research workspace: sources, notes, evidence, report.md/html, publish |
| Music | `src/mcp/tools/music-workflow.ts` | [music-workflow](music-workflow.md) | MusicXML/MIDI/SoundFont composition + render + license gating |
| Blog / Site | `src/blog/`, `src/site/` | — | content/SEO generation and the marketing/landing surface |
| Web capture / QA | `src/web-capture/` | — | Playwright-backed page capture, rebuild, and browser audits |
| Auth | `src/oauth.ts` | [request-lifecycle](request-lifecycle.md#auth) | OAuth/OIDC discovery, PKCE, DCR; the dev-token bypass |
| Skills & access | `src/skills/`, `src/tool-state.ts`, `src/special-tools.ts` | [mcp-tools](mcp-tools.md) | the two-layer tool-visibility gate |
| Security | `src/security/` | [security-origin-isolation](security-origin-isolation.md) | path allow-listing, SSRF/URL safety, origin isolation |
| Admin | `src/admin.ts`, `src/admin-api.ts`, `admin-ui/` | [operations](operations.md) | React ops console: connectors, tools, skills, activity, projects |
| Jobs / activity | `src/jobs/`, `src/activity.ts` | [task-tracking](task-tracking.md) | async job records + per-project activity history |

---

## 8. Conventions and gotchas (read before you commit)

1. **Dual schema, kept in sync.** Every tool has a JSON-Schema in `definition.inputSchema`
   (what ChatGPT sees) **and** a parallel zod `schema` (runtime validation). If you change one,
   change the other. Drift = ChatGPT sends a field the validator rejects (or vice versa).
2. **Register *and* expose.** Add the tool module to the registry **and** add its name to the
   relevant skill packs in `src/skills/registry.ts`. Both are required.
3. **High-risk tools ship disabled.** Destructive/network tools (`delete_project`, `check_url`,
   `run_shell_command`, …) must be `enabledByDefault: false`; `npm run check:mcp` enforces it.
4. **Never touch the filesystem raw.** Writes go through the project store / path
   allow-listing; outbound HTTP goes through the SSRF-safe `safeFetch`. Don't `fs.writeFile`
   into arbitrary paths or `fetch()` an attacker-controlled URL.
5. **Prefer the restart-safe project store** for deliverables (`create_project` /
   `publish_project`), not the legacy `create_share` (disabled by default, not restart-safe).
6. **Fail closed.** Several subsystems refuse rather than deliver something misleading (music:
   no real SoundFont → no fake preview; silent stem → no publish). When in doubt, fail closed
   with a clear, actionable message — don't paper over a missing input.
7. **Docs are part of the change.** A behavior change updates the matching `docs/` section in
   the same commit (this repo's long-standing rule).

---

## 9. Testing philosophy

- Tests use Node's built-in `node:test` via `tsx`, with a `toolContext(root)` helper that points
  the tool at a temp project root. Tools are exercised through `getToolModule(name).handler(...)`
  or `callTool(...)`.
- **Test the branch that fails, not just the happy path.** A passing happy-path test does not
  prove a gate works — write the input that should be *rejected* and assert it is.
- **Know what a fake proves.** Browser and music tests use fakes (a fixed-tone FluidSynth, mock
  fetch). A fake proves *routing/pipeline*, not real-world output. State that boundary in the
  test and verify the real-world claim once against real infra when it matters (see
  [music-workflow.md §12](music-workflow.md)).
- Run `npm test` before committing; run `npm run check:mcp` before shipping tool changes.

---

## 10. Your first week — a checklist

- [ ] `npm install && npm run dev`, then `curl /health` — get the server running.
- [ ] Read [`code-map.md`](code-map.md) and open each `src/` dir it names; you don't need to
      understand them, just know where they are.
- [ ] Trace one real `tools/call` with [`request-lifecycle.md`](request-lifecycle.md) open next
      to `src/mcp/router.ts`.
- [ ] Add a trivial throwaway tool by following [`adding-a-tool.md`](adding-a-tool.md), expose
      it in a skill, write its test, run `npm run check:mcp`, then delete it. This teaches the
      whole loop.
- [ ] Run the full test suite and note the two known `jobs-store` flakes so they never confuse
      you later.
- [ ] Bring up the Docker stack (`npm run docker:up`) and read [`docker.md`](docker.md).
- [ ] Skim [`music-workflow.md`](music-workflow.md) as a model of how a complex,
      fail-closed subsystem is structured in this codebase.

When you can add a tool, test it, and explain why it isn't callable until a skill exposes it —
you're productive here.
