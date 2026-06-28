# Request Lifecycle — how one `tools/call` flows through the server

A deep dive for a junior engineer. This walks a single MCP `tools/call` (the kind
ChatGPT sends when it runs a tool) from the network edge down to a tool handler and
back, naming the real file and function at each step. Read this alongside
[`architecture.md`](./architecture.md) (the big picture) and [`mcp.md`](./mcp.md)
(the tool catalog).

Everything here is HTTP request/response. There is no SSE, no streaming, no WebSocket.
One POST in, one JSON-RPC object out. The server is stateless per request: it holds no
session for the MCP endpoint — every call re-authenticates from the `Authorization`
header.

---

## 1. The walkthrough

### Step 0 — Ingress (TLS + Cloudflare)

ChatGPT talks to a public HTTPS URL (the default `PUBLIC_BASE_URL` is
`https://gmb01.xyz`, see `resolveConfig` in `src/config.ts`). TLS terminates at
Cloudflare, which tunnels the request to the local Node process listening on
`127.0.0.1:6859` (`config.host` / `config.port`, started by `app.listen(...)` at the
bottom of `src/server.ts`). The app itself never sees TLS — by the time Express runs,
it is a plain HTTP request on loopback.

> Described from `architecture.md`; not verified against infra config. The Node side is
> verified: it binds loopback and trusts the tunnel in front of it.

### Step 1 — Express bootstrap and middleware order

`src/server.ts` builds the single `app`. Order matters in Express, so note the sequence:

| Order | What | Where |
|-------|------|-------|
| 1 | `express.json({ limit: "40mb" })` parses the JSON body | `server.ts:51` |
| 2 | `express.urlencoded(...)` for OAuth form posts | `server.ts:52` |
| 3 | Content-host guard: 404s app-only paths on the content host | `server.ts:59-65` |
| 4 | `registerOAuthRoutes` (`/authorize`, `/token`, `/.well-known/*`, ...) | `server.ts:69` |
| 5 | `registerMcpRoutes` — mounts `POST /mcp` | `server.ts:70` |
| 6 | Admin API + admin SPA fallback | `server.ts:72-98` |
| 7 | `registerContentRoutes` — `/health`, `/outcome/:jobId`, `/share/*` | `server.ts:115` |
| 8 | Terminal error middleware (4-arg) | `server.ts:119-127` |

Before any route is registered, the stores are initialized and awaited
(`server.ts:30-49`): OAuth state, skill state, tool state, jobs, shares, users. This is
deliberate — the first request can never race a half-loaded store.

### Step 2 — Route match: `POST /mcp`

The handler lives in `registerMcpRoutes` in `src/http/mcp-routes.ts`, wrapped in
`asyncRoute(...)` so a thrown promise rejection is forwarded to the terminal error
middleware instead of hanging the socket.

### Step 3 — Authentication (`requireMcpAuth`)

`requireMcpAuth` (`mcp-routes.ts:117`) runs first. It pulls the bearer token from the
`Authorization` header (`getBearerToken`), then tries two paths:

1. **Real OAuth token.** `isValidAccessToken(token)` + `getClientIdForAccessToken(token)`
   (both in `src/oauth.ts`). If valid, it resolves the tenant: `getUserIdForAccessToken`
   → loads the user → checks `status === "active"` → returns per-user
   `projectRoot` / `workspaceRoot` / `publicShareBasePath`. This is the per-tenant
   isolation: each user's tools read and write only their own roots.
2. **Dev-token bypass.** If the token is not a valid OAuth token, it is compared (in
   constant time, `constantTimeEqual`) against `config.devToken`. If it matches, the
   call runs as the `legacy-user@local` account — same per-user isolation, no OAuth
   handshake. See §3 for when this is allowed.

If neither path matches, `unauthorized(res)` returns **401** with a
`WWW-Authenticate: Bearer resource_metadata="..."` header pointing at the
`/.well-known/oauth-protected-resource/mcp` document. That header is how ChatGPT
discovers it must run the OAuth flow.

### Step 4 — JSON-RPC parse and method routing

With `auth` in hand, the handler parses the body via `asJsonRpcRequest(req.body)`
(`src/http/json-rpc.ts`). A malformed body → `jsonRpcError(null, -32600, ...)` with
HTTP 400.

The handler then branches by `request.method` (all in `mcp-routes.ts`):

- `notifications/*` with no `id` → **202** empty body (notifications must not get a
  response).
- `ping` → empty result `{}`.
- `initialize` → echoes a supported `protocolVersion`, advertises `capabilities.tools`,
  and remembers the client type (ChatGPT / Gemini / Claude) for telemetry.
- `tools/list` → see §4.
- `tools/call` → the path we follow below.
- Anything else with an `id` → `jsonRpcError(request.id, -32601, "Method not found")`.

### Step 5 — `tools/call`: read the tool name

For `tools/call` (`mcp-routes.ts:224`), it reads `params.name`. Missing name →
`jsonRpcError(request.id, -32602, "tools/call requires params.name.")`.

### Step 6 — The access gate (enforced HERE, at the route)

This is the security-critical step, and it lives in **`mcp-routes.ts`, not in
`router.ts`**. Three checks, in order:

1. **Special tools (visible browser) — time-gate only.** If the name is one of the
   `visibleBrowserToolNames` (`src/special-tools.ts`) and visible-browser control is not
   currently enabled → `-32603 "Tool is disabled: visible browser control is off"`.
   These tools **bypass the two-layer gate entirely**; they are governed solely by the
   admin-set time window (see §4).
2. **Two-layer AND gate** (for all non-special tools): if
   `!isToolEffectivelyEnabled(name)` → reject with `-32603`. The message distinguishes
   `blocked_by_skill` ("disabled by skill catalog") from a plain tool-level disable.
   `isToolEffectivelyEnabled` (`src/tool-state.ts:102`) is literally
   `isToolEnabled(name) && isToolEnabledByAnySkill(name)` — see §4.

Only if the gate passes does the route call `callTool`. `router.ts` trusts that the gate
already ran; it does **no** access check of its own.

### Step 7 — Dispatch to the tool module (`callTool` → `getToolModule`)

`callTool(name, args, ctx)` in `src/mcp/router.ts` does three things and nothing else:

```ts
const tool = getToolModule(name);                 // registry lookup
if (!tool) return errorResult(new Error(...));    // unknown tool → ok:false result
const parsed = tool.schema ? tool.schema.parse(rawInput ?? {}) : rawInput;  // zod
return await tool.handler(parsed, ctx);
```

`getToolModule` (`src/mcp/registry.ts`) is a `Map` lookup. The map is built once at
import time from `allToolModules` (`src/mcp/tools/index.js`); a duplicate tool name
throws at startup so two modules can never claim the same name.

### Step 8 — Input validation (zod)

`tool.schema.parse(rawInput)` validates and coerces the arguments. If validation fails,
zod throws a `ZodError`. The surrounding `try/catch` in `callTool` catches it and routes
it through `errorResult(error)` (§9) — which flattens the ZodError into readable
`field: reason` lines via `formatZodError` (`src/mcp/result.ts:44`). The caller sees a
normal `ok:false` result with a specific message, not an opaque dump.

### Step 9 — Handler invocation with `ToolContext`

The handler receives `(parsedInput, ctx)`. `ctx` is the `ToolContext`
(`src/mcp/types.ts`) the route assembled at `mcp-routes.ts:250`:

| Field | Meaning |
|-------|---------|
| `projectRoot` / `workspaceRoot` | **per-user** roots from auth — the isolation boundary |
| `publicBaseUrl` / `contentBaseUrl` | base URLs for building links |
| `publicShareBasePath` | this user's `/share` (or `/@username/share`) prefix |
| `shareRoot` / `artifactRoot` / `feedbackRoot` | on-disk roots |
| `commandTimeoutMs` | wall-clock cap for `run_command`-style tools |
| `clientId` / `userId` | who is calling, for ownership + telemetry |

The handler does its work and returns a `ToolResult`.

### Step 10 — Standardized result

Every handler returns the same `ToolResult` shape (`src/mcp/types.ts`):

```ts
{ ok, summary, jobId?, previewUrl?, shareUrl?, artifacts[], logs[], errors[], structuredContent? }
```

Helpers in `src/mcp/result.ts` build the common cases: `createJobResult` saves a job and
sets `jobId` + `previewUrl` (`/outcome/<jobId>`); `makeShareUrl` builds a
`/share/<id>/<file>` link. See §5.

### Step 11 — JSON-RPC response + telemetry

Back in the route (`mcp-routes.ts:263-276`):

1. `recordActivity({...})` logs the call (duration, ok, summary, redacted+truncated
   args preview).
2. `resultToMcpContent(result)` wraps it as MCP content: the full `ToolResult` is
   JSON-stringified into a `content[0].text` block, with `isError: !result.ok` and the
   optional `structuredContent` lifted to the top level.
3. `res.json(jsonRpcResult(request.id, ...))` sends the JSON-RPC response. HTTP **200**
   even when `ok:false` — a tool failure is a successful RPC carrying a failure result.

If the handler *throws* (rather than returning `ok:false`), the route catches it, records
the failure with the error message, and re-throws to the terminal error middleware
(`server.ts:119`), which emits `-32603 "Internal server error."` for `/mcp`.

---

## 2. The flow as a diagram

```text
  ChatGPT
    │  POST https://gmb01.xyz/mcp   (Authorization: Bearer <token>)
    ▼
 ┌──────────────────────── Cloudflare (TLS, tunnel) ────────────────────────┐
 │                                                                          │
 ▼                                                                          │
 Node / Express  (127.0.0.1:6859, src/server.ts)
    │  express.json (40mb)  →  content-host guard
    ▼
 POST /mcp  handler  (src/http/mcp-routes.ts, asyncRoute)
    │
    ├─[3] requireMcpAuth ──────────────────────────────► 401 + WWW-Authenticate
    │       OAuth token  OR  dev-token (constant-time)      (if neither valid)
    │       → resolves per-user projectRoot / workspaceRoot
    ▼
   [4] asJsonRpcRequest ─ bad body ─────────────────────► 400  jsonRpcError(-32600)
    │
    ▼  method == "tools/call"
   [5] read params.name ─ missing ──────────────────────► jsonRpcError(-32602)
    │
   [6] ACCESS GATE  (enforced in mcp-routes.ts)
    │     ├─ visible-browser tool & control off ─────────► jsonRpcError(-32603 disabled)
    │     └─ !isToolEffectivelyEnabled(name) ────────────► jsonRpcError(-32603 disabled)
    │          = isToolEnabled  AND  isToolEnabledByAnySkill
    ▼  (gate passed)
   [7] callTool(name, args, ctx)            src/mcp/router.ts
    │     getToolModule(name) ── unknown ──► errorResult → ok:false result
    ▼
   [8] tool.schema.parse(args) ── ZodError ─► errorResult → ok:false (field: reason)
    ▼
   [9] tool.handler(parsedInput, ctx)   ── ctx = ToolContext (per-user roots) ──┐
    │                                                                            │
    ▼                                                                            │
   [10] ToolResult { ok, summary, jobId?, previewUrl?, shareUrl?, artifacts, ... }
    │
   [11] recordActivity → resultToMcpContent → res.json(jsonRpcResult(id, ...))
    │        (HTTP 200, even when ok:false)
    ▼
  ChatGPT  ◄── content[0].text = JSON.stringify(ToolResult), isError = !ok
```

Handler that throws instead of returning → caught, re-thrown → terminal error middleware
→ `-32603 "Internal server error."`.

---

## 3. The auth model

### Discovery endpoints (`src/http/oauth-routes.ts`)

ChatGPT bootstraps the whole flow from two well-known documents:

| Endpoint | Returns |
|----------|---------|
| `GET /.well-known/oauth-protected-resource/mcp` | `resource` (= `/mcp`) and `authorization_servers` (= this server) |
| `GET /.well-known/oauth-authorization-server` | the `authorize`, `token`, `register`, `revoke` endpoints + supported grant/PKCE methods |

The `401` from `/mcp` carries `WWW-Authenticate: ... resource_metadata="<protected-resource doc>"`,
so a client that calls `/mcp` with no token is told exactly where discovery starts.

### The authorize / token / PKCE / DCR flow (conceptual)

1. **DCR (Dynamic Client Registration).** `POST /register` (`registerClient` in
   `oauth.ts`) lets an unknown client create a `client_id` with no human in the loop.
   Because it is anonymous, registration is bounded: redirect URIs must pass
   `isRedirectUriAllowed` (https only, or `http://localhost`; no embedded credentials, no
   fragment), and the client store is capacity-capped (`MAX_OAUTH_CLIENTS = 500`,
   evicting only *unowned* clients).
2. **Authorize.** `GET /authorize` (`oauth-routes.ts`) requires an admin login session.
   If absent, it redirects to `/admin/login`. With a session, it renders a **consent
   page** (`renderConsentPage`) that shows *where* the auth code will be delivered (the
   redirect host) so a user can spot a phishing redirect.
3. **Approve.** `POST /oauth/approve` checks same-origin + a per-session CSRF token, then
   `createAuthorizationRedirectForUser` mints a one-time **authorization code** bound to
   the approving user's id and the PKCE `code_challenge` (S256 only). The code's `userId`
   is the approver — *not* the client owner — which prevents the confused-deputy bug
   where two users authorizing the same `client_id` get conflated.
4. **Token exchange.** `POST /token` (`exchangeToken`) verifies PKCE
   (`SHA256(code_verifier) === code_challenge`), the matching `client_id` and
   `redirect_uri`, then issues an `access_token` + `refresh_token`. Refresh tokens are
   single-use and rotated; the original absolute expiry is carried forward so a leaked,
   actively-refreshed token still dies on the original deadline.

### Where tokens are stored

All of it lives **in-memory** in `oauth.ts` (`clients`, `authCodes`, `accessTokens`,
`refreshTokens` maps) and is mirrored to a single on-disk JSON file
(`config.oauthConfig.statePath`, written atomically with mode `0600`). `cleanupExpired`
runs on every authenticated request and only re-persists when something actually expired.
There is no database for tokens.

### The dev-token bypass rule

`MCP_DEV_TOKEN` is a static shared secret that skips OAuth entirely (handy for `curl` and
local testing). `resolveDevToken` in `src/config.ts` decides whether it is honored:

| Condition | Result |
|-----------|--------|
| token shorter than 32 chars | **disabled** + warning |
| `NODE_ENV=production` and `MCP_DEV_TOKEN_ALLOW_PROD` != `true` | **disabled** + warning |
| production + `MCP_DEV_TOKEN_ALLOW_PROD=true` | enabled, loud SECURITY warning |
| non-production, 32+ chars | enabled |

The production-disable warning is logged at startup (`server.ts:26` loops over
`config.configWarnings`):

```text
[config] MCP_DEV_TOKEN is set but NODE_ENV=production; the OAuth bypass is DISABLED. Set MCP_DEV_TOKEN_ALLOW_PROD=true to force-enable it (NOT recommended).
```

The reason: the dev token grants full MCP access as the legacy user with no per-OAuth-user
binding. That is fine on a laptop, dangerous on the internet. So production must opt in
explicitly, and even then it screams in the logs.

---

## 4. Access control — the two-layer AND gate

A tool is callable only if **both** layers say yes:

```text
callable  =  isToolEnabled(name)            (raw tool override / default)
         AND isToolEnabledByAnySkill(name)  (≥1 enabled skill pack exposes it)
```

Combined in `isToolEffectivelyEnabled` (`src/tool-state.ts:102`).

### Layer 1 — raw tool state (`src/tool-state.ts`)

Each `ToolModule` has `enabledByDefault`. Admin overrides are persisted in
`tool-state.json` (`{ tools: { name: boolean } }`). On load, defaults are applied first,
then overrides layered on top. `isToolEnabled(name)` is just "is this name in the enabled
set."

### Layer 2 — skill exposure (`src/skills/state.ts`)

Tools are grouped into **skill packs** (`skillRegistry`, e.g. `core`, `coding`, `debug`).
Each pack lists `toolNames` and has its own enabled state in `skill-state.json`.
`isToolEnabledByAnySkill(name)` is true only if *some currently enabled pack* lists the
tool. A tool that no enabled pack exposes is unreachable — even if Layer 1 enabled it.

`getToolAccess(name)` (`tool-state.ts:106`) reports the combined verdict as one of:

| `access` | Meaning |
|----------|---------|
| `enabled` | both layers pass |
| `blocked_by_tool` | Layer 1 says no |
| `blocked_by_skill` | Layer 1 passes but no enabled pack exposes it |

### Where each layer is applied

- **`tools/list`** (`mcp-routes.ts:214`) filters the advertised list to
  `listEffectiveToolStates().filter(t => t.enabled && !isVisibleBrowserToolName(t.name))`,
  then re-adds visible-browser tools only when their time-gate is on. ChatGPT never sees a
  tool that the AND gate blocks.
- **`tools/call`** (`mcp-routes.ts:237`) re-checks `isToolEffectivelyEnabled(name)` and
  rejects with `-32603` if either layer blocks. Listing is not trusted as authorization —
  a hand-crafted call to a hidden tool is still rejected.

### Special-tools time-gating

The visible-browser tools (`visibleBrowserToolNames` in `src/special-tools.ts`) are
**outside** the AND gate. They are controlled by a single in-memory window an admin opens
for 15, 30, or 60 minutes (`enableVisibleBrowserControl`). `tools/call` checks
`isVisibleBrowserControlEnabled()`; once the window lapses,
`cleanupExpiredVisibleBrowserControl` (run at the top of the next `/mcp` request) calls
`closeAllBrowserSessions()` to tear down any live browsers.

---

## 5. Results, previews, and shareable links

A handler turns a `ToolResult` into user-visible URLs through `src/mcp/result.ts`.

### Job preview — `/outcome/{jobId}`

`createJobResult(ctx, title, summary, logs, artifacts)`:

1. mints a random `jobId` (`randomUUID`),
2. `saveJob({...})` to the jobs store (with `ownerUserId = ctx.userId`),
3. sets `previewUrl = makePreviewUrl(ctx.publicBaseUrl, jobId)` →
   `<publicBaseUrl>/outcome/<jobId>`.

`GET /outcome/:jobId` (`content-routes.ts:211`) looks the job up and renders a preview
page. Because the 122-bit random `jobId` *is* the capability (no session), the response
is locked down: `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`,
`Cache-Control: private, no-store`.

### Published share — `/share/{projectId}/{file}` (and `/@user/share/...`)

Handlers that publish HTML (`src/mcp/tools/share.ts`, `src/mcp/tools/project.ts`) call
`makeShareUrl(ctx.publicBaseUrl, id, filename)` → `<publicBaseUrl>/share/<id>/<file>`,
returned as `shareUrl` on the result.

`GET /share/:shareId/:filename` (`content-routes.ts:266`) resolves the id to a published
project (falling back to a legacy standalone share), enforces the share's access policy
(`canViewPublishedProjectShare` / `canViewLegacyShare`), and serves the file under a
strict CSP. When the request hits the *app* host but the project is public, it 302-redirects
to the canonical *content* host path (e.g. `/@username/share/...`) so untrusted HTML is
isolated on a different origin.

### `artifacts` / `structuredContent`

`artifacts` is a list of file references the tool produced (echoed in the preview/job).
`structuredContent` is optional machine-readable data lifted to the top of the MCP
response by `resultToMcpContent` so the client can parse it without scraping the text
block.

---

## 6. Where errors come from

There are **two structurally different** error levels. Don't confuse them.

### A. JSON-RPC protocol errors — in the `error` field, no result

Emitted directly by the route via `jsonRpcError(...)`. The RPC itself failed; there is no
`ToolResult`.

| Code | When | Source |
|------|------|--------|
| `-32600` | body is not a valid JSON-RPC request | `mcp-routes.ts:166` |
| `-32602` | `tools/call` with no `params.name` | `mcp-routes.ts:229` |
| `-32601` | unknown method | `mcp-routes.ts:306` |
| `-32603` | **tool disabled** (gate / visible-browser off) | `mcp-routes.ts:234,241` |
| `-32603` | uncaught exception → terminal middleware | `server.ts:123` |

The disabled-tool rejection is a *protocol* error, not an `ok:false` result. That is the
access gate's output.

### B. Tool-level errors — `ok:false` inside a successful (HTTP 200) result

These all funnel through `errorResult()` in `src/mcp/result.ts:54` and come back as a
normal JSON-RPC *result* with `ok:false`. They differ only by the message, not by shape:

1. **Schema validation error** — `tool.schema.parse` throws a `ZodError`, caught in
   `callTool`; `formatZodError` flattens it to `Invalid arguments — field: reason; ...`.
2. **Unknown tool** — `getToolModule` returns undefined → `errorResult(new Error("Unknown tool: ..."))`.
3. **Handler-thrown exception** — anything the handler throws is caught by `callTool`'s
   `try/catch` and becomes `ok:false` with `error.message`.
4. **Handler returning `ok:false`** — the tool authored a failure deliberately (e.g. a
   build failed). Same shape; the `summary` and `errors[]` explain why.

Rule of thumb: a protocol error means "I couldn't even run your call." An `ok:false`
result means "I ran it and it didn't work." HTTP status is 200 for case B in every
sub-case — the failure is in the payload, not the status line.
