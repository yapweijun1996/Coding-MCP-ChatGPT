import { test } from "node:test";
import assert from "node:assert/strict";
import { gitTools } from "../src/mcp/tools/git.js";

const pushSchema = gitTools.find((t) => t.definition.name === "git_push")?.schema;
assert.ok(pushSchema, "git_push tool has a schema");

test("git_push rejects leading-dash remote (argument injection)", () => {
  const result = pushSchema!.safeParse({ remote: "--receive-pack=touch /tmp/pwn" });
  assert.equal(result.success, false, "--receive-pack remote is rejected");
});

test("git_push rejects leading-dash source refspec", () => {
  const result = pushSchema!.safeParse({ source: "--upload-pack=evil" });
  assert.equal(result.success, false, "--upload-pack source is rejected");
});

test("git_push accepts normal remote and refspec", () => {
  const ok = pushSchema!.safeParse({ remote: "origin", source: "+refs/heads/main:refs/heads/main" });
  assert.equal(ok.success, true, "legitimate push args still parse");
});
