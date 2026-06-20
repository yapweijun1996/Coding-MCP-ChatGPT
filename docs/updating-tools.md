# Updating MCP Tools (without reconnecting the ChatGPT connector)

This is the operational contract for changing the MCP tool surface. Following it means you
**never delete and re-add the connector** in ChatGPT — you rebuild on the server, open a new
chat, and the new tools are there.

## TL;DR

1. Change code (add / edit a tool).
2. On the server: `npm run docker:up`  (= `docker compose up -d --build`, keeps the data volumes).
3. In ChatGPT: **open a new conversation** → the new tools appear.

You do **not** need to remove and re-add the connector. You **do** need a new conversation:
ChatGPT caches the tool list within a single conversation and does not support live
`tools/list_changed` push.

## Adding a NEW tool — the three required steps

A tool only appears in `tools/list` when **all three** are true. Miss one and it is silently
hidden (`blocked_by_skill` / `blocked_by_tool`); reconnecting does not help.

1. **Register it** in `src/mcp/tools/index.ts` (`allToolModules`).
2. **Enable it**: `enabledByDefault: true` on the tool module (use `false` for maintainer/admin-only
   tools you do not want exposed to clients).
3. **Catalog it**: add the tool name to an **enabled** skill's `toolNames` in
   `src/skills/registry.ts` (e.g. `core` for foundational/read-only, `coding` for project work,
   `high-risk` for destructive — note `high-risk` is disabled by default).

Then run the guard before building:

```bash
npm run check:tools
```

This **fails the build** if any `enabledByDefault` tool is in no skill catalog — turning the
"added a tool, it never showed up" trap into a compile-time error.

## Enabling / disabling an EXISTING tool — no rebuild needed

Use the admin console **Tools & Skills** page to toggle a tool or skill at runtime. The change
is reflected on the next `tools/list` fetch (next conversation). No rebuild, no reconnect.

## Why no reconnect is required

| Thing | State | Effect |
| --- | --- | --- |
| OAuth tokens | Persisted to `/data/state/oauth-state.json` on the `.docker-data/state` volume; reloaded on boot | Survive `docker compose up --build` → ChatGPT stays authenticated |
| MCP URL | Fixed (`/mcp`) | ChatGPT keeps pointing at the same endpoint |
| Tool list | Re-fetched by ChatGPT on each new conversation | New tools show up in new chats automatically |

So as long as the URL is unchanged and the token state volume is intact, the connector stays
valid — only the tool list refreshes.

## Red lines (these DO force a reconnect / data loss)

- **Do not** `docker compose down -v` or delete `.docker-data/state` — that wipes OAuth tokens
  and forces a re-add. Use `docker compose up -d --build` (rebuilds the image, keeps volumes).
- **Do not** change `PUBLIC_BASE_URL` / the `/mcp` URL without expecting to re-add the connector.

## What is NOT possible

- Hot-updating tools mid-conversation, or updating without any restart. Tools are compiled into
  the server, so a rebuild + restart is required (the data volumes make this safe and
  reconnect-free).

## Background jobs across a rebuild

Long-running tools dispatched with `run_tool_async` persist their job records to the
`/data/jobs` volume, so `get_job_status` still works after a restart/rebuild. A job that was
mid-run when the server stopped is reconciled to `error` on boot (re-run it); finished jobs are
retained for `JOB_RETENTION_DAYS` (default 7).
