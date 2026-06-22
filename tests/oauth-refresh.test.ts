import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  registerClient,
  createAuthorizationRedirectForUser,
  exchangeToken,
  type AuthorizeParams,
  type OAuthConfig
} from "../src/oauth.js";

const redirectUri = "https://chatgpt.com/aip/callback";

function makeConfig(refreshTokenTtlSeconds: number): OAuthConfig {
  return {
    issuer: "https://example.test",
    ownerPasscode: "",
    accessTokenTtlSeconds: 3600,
    authCodeTtlSeconds: 300,
    refreshTokenTtlSeconds,
    statePath: ""
  };
}

function authorizeForRefresh(config: OAuthConfig): { refresh_token: string; clientId: string } {
  const clientId = (registerClient({ client_name: "ChatGPT", redirect_uris: [redirectUri] }) as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params: AuthorizeParams = {
    responseType: "code",
    clientId,
    redirectUri,
    scope: "mcp",
    codeChallenge: challenge,
    codeChallengeMethod: "S256"
  };
  const redirect = createAuthorizationRedirectForUser(params, "user-refresh", config);
  const code = new URL(redirect).searchParams.get("code");
  assert.ok(code, "authorization code issued");
  const tokens = exchangeToken({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier }, config);
  return { refresh_token: tokens.refresh_token as string, clientId };
}

test("refresh token rotates and is single-use", () => {
  const config = makeConfig(2592000);
  const { refresh_token, clientId } = authorizeForRefresh(config);

  const rotated = exchangeToken({ grant_type: "refresh_token", refresh_token, client_id: clientId }, config);
  assert.ok(rotated.access_token, "refresh grant issues a new access token");
  assert.ok(rotated.refresh_token, "refresh grant rotates the refresh token");
  assert.notEqual(rotated.refresh_token, refresh_token, "rotated token differs from the consumed one");

  // The consumed refresh token must not be replayable.
  assert.throws(() => exchangeToken({ grant_type: "refresh_token", refresh_token, client_id: clientId }, config), /Invalid/);
});

test("refresh token rotation cannot extend lifetime past the original absolute deadline", () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    // 10-day TTL; Date starts at epoch 0 under mock timers.
    const config = makeConfig(10 * 24 * 60 * 60);
    const { refresh_token, clientId } = authorizeForRefresh(config);

    // Advance 9 days, then rotate — still inside the original window.
    mock.timers.tick(9 * 24 * 60 * 60 * 1000);
    const rotated = exchangeToken({ grant_type: "refresh_token", refresh_token, client_id: clientId }, config);
    const rotatedToken = rotated.refresh_token as string;

    // Advance past the ORIGINAL 10-day deadline (total 11 days). Rotation must not
    // have reset the clock, so the rotated token is now expired.
    mock.timers.tick(2 * 24 * 60 * 60 * 1000);
    // Rejected either by the explicit expiry check or by cleanupExpired (which runs
    // first and sweeps it) — both mean the rotated token did not outlive the original.
    assert.throws(
      () => exchangeToken({ grant_type: "refresh_token", refresh_token: rotatedToken, client_id: clientId }, config),
      /invalid|expired/i,
      "rotated token must expire at the original deadline, not a refreshed one"
    );
  } finally {
    mock.timers.reset();
  }
});
