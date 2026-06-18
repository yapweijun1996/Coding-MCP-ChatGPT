# Security: Origin Isolation for Published / Shared Content

## Why this is needed (the root cause)

The OAuth/admin surface (`/authorize`, `/oauth/approve`, `/admin/*`, the session
cookie) and **user-published content** (`/share/...`, `/@user/share/...`) are served
from the **same origin** (`PUBLIC_BASE_URL`, e.g. `https://gmb01.xyz`).

Published projects can contain arbitrary `.html` / `.js` — that is the product's
purpose. But because that active content runs on the **same origin** as the OAuth
consent flow, a malicious published page can drive the victim's authenticated
session:

1. Attacker (any developer / connected MCP client) publishes `index.html` whose JS
   auto-submits a form to `/oauth/approve` with the attacker's
   `client_id` / `redirect_uri` / `code_challenge`.
2. A logged-in admin opens the attacker's share URL. Because the request is
   **same-site**, `SameSite=Lax` does **not** block the cookie.
3. The victim's session silently authorizes the attacker's OAuth client → auth code
   → attacker's `redirect_uri` → attacker exchanges it (their PKCE verifier) → access
   token acting as the victim. **Account takeover.**

### What the code-layer fix already does (commit `9d04790`)

`/oauth/approve` now requires:
- a per-session **CSRF token** (embedded in the consent form, verified with
  `timingSafeEqual`), and
- a same-origin **Origin/Referer** check.

This **fully closes the cross-site variant** (a form on `evil.com`). It does **not**
close the same-origin variant: attacker JS running on `gmb01.xyz` can same-origin
`fetch('/authorize')`, read the CSRF token out of the returned consent HTML, and
replay it; the Origin header on that POST is the legitimate `gmb01.xyz`.

**The only complete fix is to stop serving user content on the OAuth/admin origin.**

## The fix: serve published/shared content from a separate host

Move all user-controlled content to a distinct host, e.g.:

| Surface | Host |
|---|---|
| OAuth + admin + MCP API (cookie lives here) | `https://gmb01.xyz` (`PUBLIC_BASE_URL`) |
| Published projects + shares (no cookie) | `https://content.gmb01.xyz` (new `CONTENT_BASE_URL`) |

A **subdomain is sufficient** given the Origin check already in place:

- The session cookie is **host-only** (no `Domain` attribute), so a page on
  `content.gmb01.xyz` cannot read it, and any POST it makes to
  `gmb01.xyz/oauth/approve` carries an **Origin of `content.gmb01.xyz`** →
  rejected by `isSameOriginRequest`.
- A **separate registrable domain** (e.g. `gmb01-usercontent.xyz`) is strictly
  stronger (makes the request cross-*site*, so `SameSite=Lax` also blocks it) and
  is the recommended target if DNS/TLS cost allows.

### Implementation steps

1. **Add `CONTENT_BASE_URL` env** (default to `PUBLIC_BASE_URL` so existing
   single-origin deploys keep working until DNS is ready).
2. **Route published/share content by host.** Either:
   - run a second Express listener / vhost that only mounts the
     `/share`, `/@:username/share`, `/artifact` routes and static published files, or
   - keep one process but `return 404` for content routes when
     `req.hostname === PUBLIC_BASE_URL` host, and `404` for OAuth/admin routes when
     `req.hostname === CONTENT_BASE_URL` host.
3. **Generate published URLs against `CONTENT_BASE_URL`.** Update
   `makeProjectPublicUrl` (`src/projects/store.ts:319`) and every canonical-URL
   builder in `src/server.ts` (lines ~489, 517, 533) to use the content host.
4. **Set the session cookie host-only on the app host only** (already the case —
   keep it; do **not** add a `Domain=.gmb01.xyz` attribute, which would leak the
   cookie to the content subdomain).
5. **Keep the Origin check** in `/oauth/approve` (it now also blocks the
   cross-subdomain POST).
6. **Add a strict CSP** on content responses as belt-and-suspenders, e.g.
   `Content-Security-Policy: sandbox allow-scripts; form-action 'none';`
   so even on the content origin a published page cannot POST to form endpoints.
7. **Cloudflare / reverse proxy:** add the new hostname, TLS cert, and a route to
   the same backend (see `docs/cloudflare.md`).

### Cutover notes

- Existing published URLs on the main origin will need redirects
  (`301 gmb01.xyz/share/* → content.gmb01.xyz/share/*`) for backward compatibility.
- The OAuth discovery documents (`/.well-known/...`) must keep pointing
  `authorization_servers` / `resource` at `PUBLIC_BASE_URL`, not the content host.

## Verification checklist

- [ ] A published page on the content host cannot read the session cookie
      (`document.cookie` is empty for the app's session).
- [ ] A POST from the content host to `gmb01.xyz/oauth/approve` is rejected (403).
- [ ] The legitimate consent flow on `gmb01.xyz` still succeeds (CSRF token present).
- [ ] Published apps still load their own same-host assets correctly.
