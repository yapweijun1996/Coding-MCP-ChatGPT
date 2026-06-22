import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedIpv6, isBlockedIpAddress } from "../src/security/url.js";

test("isBlockedIpv6 blocks loopback/unspecified and IPv4-mapped/compat forms", () => {
  for (const addr of ["::1", "::", "::ffff:127.0.0.1", "::ffff:169.254.0.1", "::127.0.0.1"]) {
    assert.equal(isBlockedIpv6(addr), true, `${addr} must be blocked`);
  }
});

test("isBlockedIpv6 blocks the full fe80::/10 link-local range, not just fe80:", () => {
  for (const addr of ["fe80::1", "fe90::1", "fea0::1", "febf::1"]) {
    assert.equal(isBlockedIpv6(addr), true, `${addr} (link-local) must be blocked`);
  }
});

test("isBlockedIpv6 blocks fc00::/7 unique-local and NAT64", () => {
  for (const addr of ["fc00::1", "fd12:3456::1", "64:ff9b::7f00:1"]) {
    assert.equal(isBlockedIpv6(addr), true, `${addr} must be blocked`);
  }
});

test("isBlockedIpv6 allows ordinary global addresses", () => {
  for (const addr of ["2001:4860:4860::8888", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedIpv6(addr), false, `${addr} (global) must be allowed`);
  }
});

test("isBlockedIpAddress dispatches v4/v6 and rejects non-IPs", () => {
  assert.equal(isBlockedIpAddress("127.0.0.1"), true);
  assert.equal(isBlockedIpAddress("8.8.8.8"), false);
  assert.equal(isBlockedIpAddress("fe9a::1"), true);
  assert.equal(isBlockedIpAddress("not-an-ip"), true); // unknown form is treated as blocked
});
