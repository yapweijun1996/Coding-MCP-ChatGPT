import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  registerClient,
  createAuthorizationRedirectForUser,
  exchangeToken,
  getUserIdForAccessToken,
  type AuthorizeParams,
  type OAuthConfig
} from "../src/oauth.js";

const config: OAuthConfig = {
  issuer: "https://example.test",
  ownerPasscode: "",
  accessTokenTtlSeconds: 3600,
  authCodeTtlSeconds: 300,
  refreshTokenTtlSeconds: 2592000,
  statePath: ""
};

const redirectUri = "https://chatgpt.com/aip/callback";

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizeParams(clientId: string, challenge: string): AuthorizeParams {
  return {
    responseType: "code",
    clientId,
    redirectUri,
    scope: "mcp",
    codeChallenge: challenge,
    codeChallengeMethod: "S256"
  };
}

function authorize(clientId: string, userId: string): string {
  const { verifier, challenge } = pkce();
  const redirect = createAuthorizationRedirectForUser(authorizeParams(clientId, challenge), userId, config);
  const code = new URL(redirect).searchParams.get("code");
  assert.ok(code, "authorization code issued");
  const tokens = exchangeToken({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier }, config);
  return tokens.access_token as string;
}

test("two users authorizing the SAME client_id get tokens bound to their own tenant", () => {
  const clientId = (registerClient({ client_name: "ChatGPT", redirect_uris: [redirectUri] }) as { client_id: string }).client_id;

  const tokenA = authorize(clientId, "user-A");
  assert.equal(getUserIdForAccessToken(tokenA), "user-A");

  // The same client_id, authorized by a DIFFERENT user, must NOT resolve to user-A (confused deputy).
  const tokenB = authorize(clientId, "user-B");
  assert.equal(getUserIdForAccessToken(tokenB), "user-B", "token B must resolve to its own approver");
  assert.equal(getUserIdForAccessToken(tokenA), "user-A", "token A is unaffected");
});

test("refresh_token rotates (single-use) and preserves the tenant userId", () => {
  const clientId = (registerClient({ client_name: "ChatGPT", redirect_uris: [redirectUri] }) as { client_id: string }).client_id;
  const { verifier, challenge } = pkce();
  const redirect = createAuthorizationRedirectForUser(authorizeParams(clientId, challenge), "user-C", config);
  const code = new URL(redirect).searchParams.get("code");
  const first = exchangeToken({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier }, config);
  const refresh = first.refresh_token as string;

  const refreshed = exchangeToken({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }, config);
  assert.equal(getUserIdForAccessToken(refreshed.access_token as string), "user-C", "tenant carried across refresh");
  assert.notEqual(refreshed.refresh_token, refresh, "a new refresh token is issued");

  // The old refresh token is now single-use spent — replay must fail.
  assert.throws(() => exchangeToken({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }, config), /Invalid refresh token/);
});

test("refresh_token grant rejects a mismatched client_id", () => {
  const clientId = (registerClient({ client_name: "ChatGPT", redirect_uris: [redirectUri] }) as { client_id: string }).client_id;
  const { verifier, challenge } = pkce();
  const redirect = createAuthorizationRedirectForUser(authorizeParams(clientId, challenge), "user-D", config);
  const code = new URL(redirect).searchParams.get("code");
  const first = exchangeToken({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier }, config);
  assert.throws(
    () => exchangeToken({ grant_type: "refresh_token", refresh_token: first.refresh_token as string, client_id: "some-other-client" }, config),
    /client_id does not match/
  );
});
