import { test } from "node:test";
import assert from "node:assert/strict";
import { setShareCacheHeaders } from "../src/share/access-policy.js";

// Minimal Express-Response stand-in that records setHeader() calls.
function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
    }
  } as unknown as import("express").Response & { headers: Record<string, string> };
}

test("public shares must revalidate (no stale republish window)", () => {
  // anyone_with_link, access-gated route
  const a = fakeRes();
  setShareCacheHeaders(a, "anyone_with_link", false);
  assert.equal(a.headers["Cache-Control"], "public, no-cache");

  // public route (homepage etc.) regardless of shareAccess
  const b = fakeRes();
  setShareCacheHeaders(b, "private", true);
  assert.equal(b.headers["Cache-Control"], "public, no-cache");

  // Regression guard: the old policy let republished content go stale for up to 24h.
  assert.ok(!/(max-age=\d|stale-while-revalidate)/.test(a.headers["Cache-Control"]));
});

test("private shares are never cached", () => {
  const r = fakeRes();
  setShareCacheHeaders(r, "private", false);
  assert.equal(r.headers["Cache-Control"], "private, no-store");
  assert.equal(r.headers["Vary"], "Cookie");
});
