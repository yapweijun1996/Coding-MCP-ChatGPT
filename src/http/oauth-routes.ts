import type express from "express";
import { timingSafeEqual } from "node:crypto";
import { readSessionIdFromRequest } from "../admin-api.js";
import type { ServerConfig } from "../config.js";
import {
  createAuthorizationRedirectForUser,
  exchangeToken,
  parseAuthorizeParams,
  registerClient,
  renderConsentPage,
  revokeToken,
  validateAuthorizeRequest,
  type AuthorizeParams
} from "../oauth.js";
import { getSession as getUserSession } from "../user-store.js";
import { asyncRoute } from "./util.js";

export function registerOAuthRoutes(app: express.Express, config: ServerConfig): void {
  const { publicBaseUrl, oauthConfig } = config;

  function appOrigin(): string {
    try {
      return new URL(publicBaseUrl).origin;
    } catch {
      return "";
    }
  }

  function isSameOriginRequest(req: express.Request): boolean {
    const expected = appOrigin();
    const origin = req.header("origin");
    if (origin) return origin === expected;
    // Fall back to Referer when Origin is absent (older clients/proxies).
    const referer = req.header("referer");
    if (referer) {
      try {
        return new URL(referer).origin === expected;
      } catch {
        return false;
      }
    }
    // No Origin and no Referer: cannot prove same-origin; the CSRF token check still applies.
    return true;
  }

  function isValidCsrfToken(supplied: string, expected: string): boolean {
    if (!supplied || !expected) return false;
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({
      resource: `${publicBaseUrl}/mcp`,
      authorization_servers: [publicBaseUrl],
      bearer_methods_supported: ["header"],
      resource_name: "Coding MCP ChatGPT"
    });
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: oauthConfig.issuer,
      authorization_endpoint: `${publicBaseUrl}/authorize`,
      token_endpoint: `${publicBaseUrl}/token`,
      registration_endpoint: `${publicBaseUrl}/register`,
      revocation_endpoint: `${publicBaseUrl}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"]
    });
  });

  app.get("/authorize", asyncRoute(async (req, res) => {
    const params = parseAuthorizeParams(req);
    if (!params) {
      res.status(400).send("Invalid authorization request.");
      return;
    }
    const session = await getUserSession(readSessionIdFromRequest(req));
    if (!session) {
      res.redirect(302, `/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }

    const validation = validateAuthorizeRequest(params);
    const switchAccountUrl = `/admin/login?next=${encodeURIComponent(req.originalUrl)}`;
    res.type("html").send(renderConsentPage(params, validation, { email: session.user.email, role: session.user.role }, switchAccountUrl, session.session.csrfToken));
  }));

  app.post("/oauth/approve", asyncRoute(async (req, res) => {
    const session = await getUserSession(readSessionIdFromRequest(req));
    if (!session) {
      res.redirect(302, `/admin/login?next=${encodeURIComponent("/authorize")}`);
      return;
    }
    // Defense-in-depth: reject cross-origin POSTs. The session cookie is SameSite=Lax,
    // but published content is served from this same origin, so also require an explicit
    // per-session CSRF token. (Full isolation requires serving shares from a separate origin.)
    if (!isSameOriginRequest(req)) {
      res.status(403).type("text/plain").send("Cross-origin authorization is not allowed.");
      return;
    }
    const body = req.body as Partial<Record<string, string>>;
    const suppliedCsrf = body.csrf_token ?? "";
    if (!isValidCsrfToken(suppliedCsrf, session.session.csrfToken)) {
      res.status(403).type("text/plain").send("Invalid or missing CSRF token.");
      return;
    }
    const params: AuthorizeParams = {
      responseType: body.responseType ?? body.response_type ?? "",
      clientId: body.clientId ?? body.client_id ?? "",
      redirectUri: body.redirectUri ?? body.redirect_uri ?? "",
      state: body.state,
      scope: body.scope ?? "",
      codeChallenge: body.codeChallenge ?? body.code_challenge ?? "",
      codeChallengeMethod: body.codeChallengeMethod ?? body.code_challenge_method ?? ""
    };

    try {
      const redirectUrl = createAuthorizationRedirectForUser(params, session.user.id, oauthConfig);
      res.redirect(302, redirectUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Authorization failed.";
      const switchAccountUrl = `/admin/login?next=${encodeURIComponent("/authorize")}`;
      res.status(400).type("html").send(renderConsentPage(params, message, { email: session.user.email, role: session.user.role }, switchAccountUrl, session.session.csrfToken));
    }
  }));

  app.post("/token", (req, res) => {
    try {
      res.json(exchangeToken(req.body, oauthConfig));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Token exchange failed.";
      res.status(400).json({ error: "invalid_grant", error_description: message });
    }
  });

  app.post("/register", (req, res) => {
    try {
      res.status(201).json(registerClient(req.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Client registration failed.";
      res.status(400).json({ error: "invalid_client_metadata", error_description: message });
    }
  });

  app.post("/revoke", (req, res) => {
    revokeToken(req.body);
    res.status(200).json({ ok: true });
  });
}
