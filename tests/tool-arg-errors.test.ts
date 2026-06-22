import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { formatZodError, errorResult } from "../src/mcp/result.js";
import { projectTools } from "../src/mcp/tools/project.js";
import type { ToolContext } from "../src/mcp/types.js";

function ctxFor(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "share"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: root,
    clientId: "test-client"
  };
}

// issue_0002: a raw ZodError surfaced as an opaque "blocked / double check the input" failure.
test("formatZodError names the field and the exact constraint", () => {
  const schema = z.object({ content: z.string().max(8) });
  const parsed = schema.safeParse({ content: "way too long for the cap" });
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  const message = formatZodError(parsed.error);
  assert.match(message, /^Invalid arguments — /);
  assert.match(message, /content:/);
  assert.match(message, /8/); // mentions the max so the caller knows the limit
});

test("errorResult turns a ZodError into an actionable, non-empty error", () => {
  const schema = z.object({ projectId: z.string().min(8) });
  const parsed = schema.safeParse({ projectId: "short" });
  if (parsed.success) throw new Error("expected failure");
  const result = errorResult(parsed.error);
  assert.equal(result.ok, false);
  assert.match(result.summary, /projectId/);
  assert.deepEqual(result.errors, [result.summary]);
});

test("errorResult keeps plain Error messages unchanged", () => {
  const result = errorResult(new Error("Unknown tool: foo"));
  assert.equal(result.summary, "Unknown tool: foo");
});

// issue_0001: create_project response must name projectId and the exact next call explicitly.
test("create_project returns explicit projectId and a write_project_file next step", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-mcp-create-"));
  try {
    const createTool = projectTools.find((tool) => tool.definition.name === "create_project");
    assert.ok(createTool, "create_project tool exists");
    const parsedInput = createTool!.schema!.parse({ title: "Hello" });
    const result = await createTool!.handler(parsedInput, ctxFor(root));
    assert.equal(result.ok, true);
    const projectId = result.structuredContent?.projectId as string;
    assert.match(projectId, /^project_/);
    assert.equal(result.jobId, projectId);
    assert.match(result.summary, /projectId/);
    assert.match(result.summary, /write_project_file/);
    const nextStep = result.structuredContent?.nextStep as Record<string, unknown>;
    assert.equal(nextStep.tool, "write_project_file");
    assert.deepEqual(
      Object.keys(nextStep.arguments as Record<string, unknown>).sort(),
      ["content", "projectId", "relativePath"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
