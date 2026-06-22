import { test } from "node:test";
import assert from "node:assert/strict";
import { renderConsentPage, type AuthorizeParams } from "../src/oauth.js";

function params(redirectUri: string): AuthorizeParams {
  return {
    responseType: "code",
    clientId: "client-abc",
    redirectUri,
    scope: "mcp",
    codeChallenge: "x".repeat(43),
    codeChallengeMethod: "S256"
  };
}

test("consent page shows the redirect destination host so phishing clients are visible", () => {
  const html = renderConsentPage(params("https://evil.example.com/cb"), undefined, { email: "a@b.com", role: "owner" });
  assert.match(html, /After you authorize, you will be sent to/);
  assert.match(html, /evil\.example\.com/, "the attacker host is displayed to the user");
});

test("consent page flags an unparseable redirect_uri instead of hiding it", () => {
  const html = renderConsentPage(params("not a url"), undefined, undefined);
  assert.match(html, /an unknown destination/);
});
