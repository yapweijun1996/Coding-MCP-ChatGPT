import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDevToken } from "../src/config.js";

const STRONG = "x".repeat(32);

test("resolveDevToken returns no token and no warning when unset or blank", () => {
  assert.deepEqual(resolveDevToken(undefined, "production", false), { warnings: [] });
  assert.deepEqual(resolveDevToken("   ", "development", false), { warnings: [] });
});

test("resolveDevToken disables a weak (<32 char) token and explains why", () => {
  const result = resolveDevToken("change-me-local-token", "development", false);
  assert.equal(result.token, undefined);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /shorter than 32 characters/);
});

test("resolveDevToken disables the bypass in production by default", () => {
  const result = resolveDevToken(STRONG, "production", false);
  assert.equal(result.token, undefined, "production must not honor the dev token without explicit opt-in");
  assert.match(result.warnings[0], /NODE_ENV=production/);
});

test("resolveDevToken force-enables in production only with the explicit flag, and warns loudly", () => {
  const result = resolveDevToken(STRONG, "production", true);
  assert.equal(result.token, STRONG);
  assert.match(result.warnings[0], /SECURITY/);
});

test("resolveDevToken enables a strong token outside production", () => {
  const result = resolveDevToken(STRONG, "development", false);
  assert.equal(result.token, STRONG);
  assert.match(result.warnings[0], /non-production/);
});

test("resolveDevToken trims surrounding whitespace before length and equality checks", () => {
  const result = resolveDevToken(`  ${STRONG}  `, "development", false);
  assert.equal(result.token, STRONG);
});
