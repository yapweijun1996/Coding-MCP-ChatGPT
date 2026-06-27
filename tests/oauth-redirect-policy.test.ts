import { test } from "node:test";
import assert from "node:assert/strict";
import { isRedirectUriAllowed } from "../src/oauth.js";

test("allows the real ChatGPT connector redirect_uri (https, clean)", () => {
  assert.equal(isRedirectUriAllowed("https://chatgpt.com/connector/oauth/W0teFFJ0v5bL"), true);
});

test("allows http loopback for local development", () => {
  assert.equal(isRedirectUriAllowed("http://localhost:6859/callback"), true);
  assert.equal(isRedirectUriAllowed("http://127.0.0.1/cb"), true);
});

test("rejects non-loopback plain http", () => {
  assert.equal(isRedirectUriAllowed("http://attacker.example/cb"), false);
});

test("rejects embedded credentials (confused-deputy disguise)", () => {
  assert.equal(isRedirectUriAllowed("https://chatgpt.com@attacker.com/cb"), false);
});

test("rejects a fragment in the redirect_uri", () => {
  assert.equal(isRedirectUriAllowed("https://chatgpt.com/cb#evil"), false);
});

test("rejects non-http(s) schemes and garbage", () => {
  assert.equal(isRedirectUriAllowed("javascript:alert(1)"), false);
  assert.equal(isRedirectUriAllowed("data:text/html,x"), false);
  assert.equal(isRedirectUriAllowed("not a url"), false);
  assert.equal(isRedirectUriAllowed(""), false);
});
