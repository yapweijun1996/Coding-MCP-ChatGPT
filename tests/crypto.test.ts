import { test } from "node:test";
import assert from "node:assert/strict";
import { constantTimeEqual } from "../src/shared/crypto.js";

test("constantTimeEqual matches equal strings and rejects mismatches", () => {
  assert.equal(constantTimeEqual("abc123", "abc123"), true);
  assert.equal(constantTimeEqual("abc123", "abc124"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false, "different lengths are not equal");
});

test("constantTimeEqual treats missing values as non-matching", () => {
  assert.equal(constantTimeEqual(undefined, "x"), false);
  assert.equal(constantTimeEqual("x", undefined), false);
  assert.equal(constantTimeEqual(undefined, undefined), false);
});
