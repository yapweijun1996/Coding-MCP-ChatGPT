# Code Map — `src/` tour for new engineers

A module-by-module map of the `src/` tree. Read this first when you need to answer
"where does X live, and what does it do." For the full tool catalog see
[`docs/mcp-tools.md`](./mcp-tools.md); for the MCP protocol shape see
[`docs/mcp.md`](./mcp.md); for the high-level diagram see [`docs/architecture.md`](./architecture.md).

## Orientation

This repo is an **HTTP MCP (Model Context Protocol) server** built on **Express**. It exposes
a large set of coding / research / music / project tools to ChatGPT (and other MCP clients
like Claude and Gemini) over a single `POST /mcp` JSON-RPC endpoint, gated by **OAuth**. Each
authenticated user is a tenant with an isolated project store; tools can publish HTML to a
**preview / share / publish pipeline** that is served back out over public content routes. The
process entry point is **`src/server.ts`** — it resolves config, initializes every store in a
fixed order, then registers the OAuth, MCP, admin, and content route groups on one Express app.

## Top-level map

| Module / dir | What it is | Key files | When you'd touch it |
| --- | --- | --- | --- |
| `server.ts` | Process entry point. Builds the Express app, runs the ordered store bootstrap, wires route groups, handles graceful shutdown. | `server.ts` | Adding a new route group or a new store to initialize. |
| `config.ts` | Pure env → `ServerConfig` resolver (ports, base URLs, all on-disk roots, OAuth TTLs, dev-token gating). No I/O. | `config.ts` | Adding a config value or a new on-disk root. |
| `mcp/` | **The heart.** Tool registry, per-call router, result helpers, shared types, and ~80 tool modules under `tools/`. | `registry.ts`, `router.ts`, `result.ts`, `types.ts`, `tools/` | Adding or changing any MCP tool. |
| `http/` | Express route registration: MCP JSON-RPC, OAuth endpoints, public content serving, plus host/JSON-RPC/SEO helpers. | `mcp-routes.ts`, `oauth-routes.ts`, `content-routes.ts` | Changing how requests are authed, routed, or served. |
| `oauth.ts` | OAuth 2.0 authorization-server logic: dynamic client registration, PKCE auth codes, access/refresh tokens, per-user binding. | `oauth.ts` | Auth flow, token lifetime, consent page changes. |
| `user-store.ts` | User accounts, sessions, roles, and the per-user project/workspace root resolution that drives tenant isolation. Postgres-or-JSON backed. | `user-store.ts` | User auth, roles, where a user's files live. |
| `projects/` | The **project store**: project metadata, files, tasks, review comments, validation, publish policy, and cross-user resolution. | `store.ts`, `project-resolution.ts`, `publish-policy.ts` | Anything about projects, project files, or tasks. |
| `skills/` | **Skill packs** — named bundles of tool names that gate which tools are exposed. Registry + on-disk enable state. | `registry.ts`, `state.ts` | Grouping tools, enabling/disabling a skill pack. |
| `tool-state.ts` | Per-tool enable flag (the second gate). Combined with skill-state into "effective" tool visibility. | `tool-state.ts` | Toggling a single tool on/off. |
| `special-tools.ts` | A separate third gate: time-boxed "visible browser control" tools that bypass tool-state. | `special-tools.ts` | Visible-browser admin toggle. |
| `jobs/` | Job records (one JSON file per job) returned as `previewUrl` (`/outcome/<jobId>`). Tenant-scoped by `ownerUserId`. | `store.ts` | Async/long-running tool results, outcome pages. |
| `share/` | Share artifacts (published HTML snippets) + access policy for `/share/...` routes. | `store.ts`, `access-policy.ts` | Share links, share visibility. |
| `artifacts/` | Binary/text artifact blobs addressable by id+filename, served at `/artifact/...`. | `store.ts` | Tool output files (zips, images). |
| `security/` | URL/SSRF safety (private-IP blocking, DNS-checked fetch) and a Playwright per-request SSRF route guard. | `url.ts`, `playwright-guard.ts` | Any tool that fetches a URL or drives a browser. |
| `research/` | Research-project store: sources, evidence, notes, manifest validation, report publishing. | `store.ts` | Research workflow tools. |
| `blog/` | Blog post store + markdown/HTML rendering + HTML sanitization. Postgres-or-JSON backed. | `store.ts`, `render.ts`, `markdown.ts`, `sanitize-html.ts` | Blog content + rendering. |
| `site/` | Tiny store for "which project is the homepage." | `store.ts` | Homepage selection. |
| `telemetry/` | Per-day telemetry event log + aggregation into summaries. | `store.ts`, `aggregate.ts` | Usage metrics, dashboards. |
| `feedback/` | Bug/feedback issue store (severity, category, status). | `store.ts` | Feedback/issue tools. |
| `web-capture/` | Headless capture of a webpage (resources, links, forms) + report rendering. | `capture.ts`, `report.ts` | Web inspect/rebuild tools. |
| `activity.ts` | In-memory ring buffer of recent request activity, surfaced in admin. | `activity.ts` | Recent-activity views. |
| `preview.ts` | Renders the `/outcome/<jobId>` HTML preview page from a `JobRecord`. | `preview.ts` | Outcome page look. |
| `shared/` | Cross-cutting primitives: atomic file writes, keyed locks, constant-time compare, secret redaction. | `atomic-write.ts`, `keyed-lock.ts`, `crypto.ts`, `redact.ts` | Safe writes, race-free updates, redacting logs. |
| `admin.ts` | Server-side HTML rendering for admin / public-share pages. | `admin.ts` | Admin or public-share page markup. |
| `admin-api.ts` | The `/admin/api/*` REST surface (passcode-gated): projects, users, tools, skills, telemetry, exports. | `admin-api.ts` | Admin backend endpoints. |

> The admin **UI** itself is a separate built SPA served from `admin-ui/dist` (outside `src/`).

---

## Deep dives

### `src/mcp/` — the tool engine

This is where you spend most of your time. A tool is a **`ToolModule`** (`mcp/types.ts`):

```ts
interface ToolModule {
  definition: ToolDefinition;       // name + description + JSON-Schema inputSchema (sent to the client)
  enabledByDefault: boolean;        // seeds tool-state on first boot
  schema?: z.ZodType<unknown>;      // runtime Zod validation of the input
  handler: (input, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}
```

Worked example — `mcp/tools/preview.ts` exports `previewTools: ToolModule[]` with the `ping`
and `create_preview` tools. Each entry has a `definition` (the schema ChatGPT sees), an
`enabledByDefault`, a Zod `schema`, and a `handler` that returns a `ToolResult`
(`{ ok, summary, artifacts, logs, errors, ... }`).

**Wiring, end to end:**

| File | Key exports | Role |
| --- | --- | --- |
| `mcp/tools/index.ts` | `allToolModules: ToolModule[]` | The live registry source — every tool group is imported and spread into one array. **Add a new tool group here.** |
| `mcp/registry.ts` | `toolRegistry`, `toolDefinitions`, `getToolModule(name)`, `hasToolModule(name)` | Builds a name→module map and **throws on duplicate tool names**. |
| `mcp/router.ts` | `callTool(name, rawInput, ctx)` | Looks up the module, runs `schema.parse(input)`, calls `handler(input, ctx)`, wraps failures via `errorResult`. |
| `mcp/result.ts` | `createJobResult`, `makePreviewUrl`, `makeShareUrl`, `errorResult`, `formatZodError` | Result/URL builders; flattens Zod errors into actionable `field: reason` strings. |
| `mcp/types.ts` | `ToolModule`, `ToolDefinition`, `ToolResult`, `ToolContext` | The contracts every tool implements. |
| `mcp/child-env.ts` | `childEnv`, `gitChildEnv` | Sanitized env for spawned child processes / git. |

**`ToolContext` is built per request, not globally.** In `http/mcp-routes.ts`, after auth,
the handler constructs a `ctx` from the *authenticated user's* roots
(`projectRoot`, `workspaceRoot`, `publicShareBasePath`) plus `clientId`/`userId` and the shared
roots (`shareRoot`, `artifactRoot`, `feedbackRoot`). That per-request `ctx` is what makes
tenant isolation real: tool handlers never see global roots, only the caller's.

**Legacy duality (not a bug):** there is a *second* `callTool` / `toolDefinitions` in
`mcp/legacy-tools.ts`. It exists only to be delegated to from `mcp/tools/legacy-delegate.ts`
(`legacyDelegatedTools(names)`), which re-wraps selected legacy definitions as modern
`ToolModule`s. The **live** registry is `mcp/tools/index.ts`; `legacy-tools.ts` is never
imported directly except by the delegate.

### Tool visibility — the gating model

A registered tool is **not** automatically visible. `tools/list` and `tools/call` apply gates:

1. **Tool-state gate** (`tool-state.ts`): `isToolEnabled(name)` — per-tool on/off flag,
   seeded from `enabledByDefault`, persisted to `tool-state.json`.
2. **Skill-state gate** (`skills/state.ts`): `isToolEnabledByAnySkill(name)` — the tool must
   belong to at least one *enabled* skill pack.
3. Combined: **`isToolEffectivelyEnabled(name)` = tool-enabled AND skill-enabled.**
   `getToolAccess(name)` returns a status of `enabled | blocked_by_tool | blocked_by_skill`,
   which is how the admin UI explains *why* a tool is hidden.
4. **Third, separate gate** (`special-tools.ts`): the visible-browser tools are time-boxed by
   an admin and bypass tool-state entirely — `mcp-routes.ts` checks
   `isVisibleBrowserControlEnabled()` for them instead.

If a tool is "registered but invisible," it is almost always gate #2 (no enabled skill
includes it). Start in `skills/registry.ts`.

### `src/skills/` — skill packs

| File | Key exports | Role |
| --- | --- | --- |
| `skills/registry.ts` | `skillRegistry: SkillDefinition[]`, `getSkillDefinition` | Static list of skill packs. Each pack has `id`, `label`, `toolNames[]`, `enabledByDefault`, `riskLevel`, and a `protocolMarkdown` (the instructions the agent reads). |
| `skills/state.ts` | `initializeSkillState`, `getEnabledSkillIdsForTool`, `getSkillIdsForTool`, `isToolEnabledByAnySkill` | On-disk enable/disable state per skill, persisted to `skill-state.json`. |

A `SkillDefinition.toolNames` is the bridge between a pack and the tool registry. To expose a
new tool to ChatGPT, add it to a pack here (in addition to registering the module).

### `src/projects/` — the project store

The durable record of everything a user builds.

| File | Key exports | Role |
| --- | --- | --- |
| `projects/store.ts` | `createProject`, `getProject`, `listProjects`, `getProjectWithFiles`, `getProjectManifest`, `writeProjectFile`, `patchProjectFile`, `writeProjectAsset`, `getProjectStoredFilePath`, `getProjectFilesDirectory`, `upsertProjectTask`, `getProjectTaskGraph`, `addProjectReviewComments`, `assertSafeProjectFilePath` | All project CRUD: metadata, files, tasks (todo/doing/blocked/done with dependency graph), review comments, validation. Read-modify-write runs under `withKeyedLock` per project to avoid lost-update races; writes go through `atomicWrite`. |
| `projects/project-resolution.ts` | `listVisibleProjectsForUser`, `resolveProjectRootForUser`, `resolveProjectForUser`, `resolveProjectAcrossRoots` | Maps a `(user, projectId)` to the right on-disk root. Admins can resolve across all users' roots; non-admins are confined to their own. |
| `projects/publish-policy.ts` | `buildProjectPublishOptions`, `publishBaseUrlForShareAccess`, `projectShareAccessSchema` | Decides the public vs content base URL and share-access (`private` / `anyone_with_link`) when publishing. |

### `src/http/` — the Express surface

`server.ts` registers these in order (order matters: the content catch-all is last).

| File | Key export | Role |
| --- | --- | --- |
| `http/mcp-routes.ts` | `registerMcpRoutes(app, config)` | The `POST /mcp` JSON-RPC handler: `requireMcpAuth` (bearer token → user, or dev-token bypass), then dispatch `initialize` / `tools/list` (filtered by the gates) / `tools/call` (builds per-user `ctx`, calls `router.callTool`, records telemetry). |
| `http/oauth-routes.ts` | `registerOAuthRoutes(app, config)` | OAuth discovery, `/authorize`, consent, `/token`, `/register`, `/revoke`. |
| `http/content-routes.ts` | `registerContentRoutes(app, config)` | Public serving: `/outcome/<jobId>`, `/share/...`, `/artifact/...`, published project files, blog, homepage, sitemap/robots — with per-route CSP/sandbox headers. |
| `http/json-rpc.ts` | `jsonRpcResult`, `jsonRpcError`, `asJsonRpcRequest` | JSON-RPC envelope helpers. |
| `http/hosts.ts` | `configuredHost`, `sameConfiguredHost`, `configuredHostsAreSeparate`, `contentUrl` | Public-host vs content-host separation logic (origin isolation). |
| `http/util.ts` | `asyncRoute` | Wraps async handlers so thrown errors reach the terminal error middleware. |
| `http/seo.ts` | `buildSitemapXml`, `buildRobotsTxt`, `buildBlogPostHead`, `injectHeadHtml` | SEO tag/sitemap builders. |

### `src/oauth.ts` — auth model (high level)

A self-contained OAuth 2.0 authorization server:

- **Dynamic client registration** (`registerClient`) — MCP clients self-register and get a
  `clientId` + allowed redirect URIs.
- **Authorization code + PKCE** (`parseAuthorizeParams`, `validateAuthorizeRequest`,
  `renderConsentPage`, `createAuthorizationRedirectForUser`) — the user logs in (session from
  `user-store.ts`), approves, and an `S256` code-challenge auth code is issued. The code is
  bound to the **approving user's `userId`**, not the client's owner — this prevents the
  confused-deputy bug where two users share one `clientId`.
- **Token exchange / refresh** (`exchangeToken`, refresh-token rotation with absolute expiry).
- **Token introspection** used by routes: `isValidAccessToken`, `getClientIdForAccessToken`,
  `getUserIdForAccessToken` — these are what `mcp-routes.ts` calls to resolve the tenant.
- State persists to `oauth-state.json` via `atomicWriteSync`.

A `config.devToken` (`MCP_DEV_TOKEN`) bypass exists for local testing; `config.ts` only honors
it for a 32+ char secret outside production, and `mcp-routes.ts` binds it to the legacy user so
it still runs through normal per-user isolation.

### `src/jobs/` and the preview pipeline

`jobs/store.ts` keeps an in-memory `Map<id, JobRecord>` backed by one JSON file per job under
`jobsRoot`. `createJobResult` (in `mcp/result.ts`) saves a job and returns a `previewUrl` of
`/<publicBaseUrl>/outcome/<jobId>`, which `content-routes.ts` renders via `preview.ts`. Jobs
carry `ownerUserId`; job tools authorize by exact match so one tenant can't read another's jobs.

### `src/security/` — URL safety & origin isolation

| File | Key exports | Role |
| --- | --- | --- |
| `security/url.ts` | `isBlockedIpv4`, `isBlockedIpv6`, `isBlockedIpAddress`, `assertSafePublicUrl`, `safeFetch` | SSRF defense: blocks private/loopback/link-local/ULA ranges and resolves DNS before fetching so a public hostname can't point at an internal IP. Use `safeFetch` instead of raw `fetch` in any tool. |
| `security/playwright-guard.ts` | `installSsrfRouteGuard(page, allowPrivateNetwork)` | Per-request guard on a Playwright page: re-checks every navigation (and literal-IP subresources) so a redirect can't escape into an internal address after the first hop. |

**Origin isolation** (see also `docs/security-origin-isolation.md`): `config.ts` separates
`publicBaseUrl` (app + admin + private shares) from `contentBaseUrl` (untrusted published
HTML). `server.ts` 404s app-only paths on the content host, and `content-routes.ts` applies a
stricter sandbox CSP to user-published HTML.

---

## Data on disk

Roots are defined in `config.ts` and default under `workspaceRoot` (in Docker, under
`.docker-data/`). The important nuance for project files:

- **A real OAuth user's projects live under a per-user root**, resolved by
  `getProjectRootForUser(userId)` in `user-store.ts`:
  `${usersRoot}/{userId}/projects/{projectId}/`, where `usersRoot` defaults to
  `${workspaceRoot}/.users` (Docker: `.docker-data/users/...`).
- The global `config.projectRoot` (`${workspaceRoot}/.projects`) is the **fallback / legacy
  tenant root** only — do not expect a logged-in user's files there.
- Inside each `{projectId}/` directory:
  - `files/` — the published/served project files (`getProjectFilesDirectory`).
  - `workspace/` — the project's scratch workspace (`getProjectWorkspaceDirectory`).
  - a project metadata JSON at the directory root (status, tasks, history).
- Per-user scratch workspace (non-project tools): `${usersRoot}/{userId}/workspace/`
  (`getWorkspaceRootForUser`).

Other roots (defaults; `${workspaceRoot}/...`, Docker `.docker-data/...`):

| Root | Default path | Holds |
| --- | --- | --- |
| `shareRoot` | `.shares` | Share artifacts (published HTML), served at `/share/...`. |
| `artifactRoot` | `.artifacts` | Tool output blobs, served at `/artifact/...`. |
| `jobsRoot` | `.jobs` | One JSON per job; `/outcome/<jobId>` reads these. |
| `feedbackRoot` | `.feedback` | Feedback/issue records. |
| `telemetryRoot` | `.telemetry` | Per-day telemetry event logs. |
| `*StatePath` | `.state/*.json` | `oauth-state`, `users-state`, `skill-state`, `tool-state`, `site-state`, `blog-state`. |

Blog and user data also support a Postgres backend (via `DATABASE_URL`); the JSON files are the
fallback when no database is configured.
