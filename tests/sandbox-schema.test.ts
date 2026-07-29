import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getToolModule } from "../src/mcp/registry.js";
import { callTool } from "../src/mcp/router.js";
import { skillRegistry } from "../src/skills/registry.js";

interface JsonSchemaNode {
  type?: string;
  enum?: string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  required?: string[];
  additionalProperties?: boolean;
}

function inputSchemaOf(name: string): JsonSchemaNode {
  const tool = getToolModule(name);
  assert.ok(tool, `${name} registered`);
  return tool!.definition.inputSchema as JsonSchemaNode;
}

function zodParse(name: string, payload: unknown): unknown {
  const tool = getToolModule(name);
  assert.ok(tool?.schema, `${name} has a zod schema`);
  return tool!.schema!.parse(payload);
}

// The bug this guards against: the JSON-Schema shown to the model advertised
// `profile: {type:"object"}` / `files: {type:"array"}` with no inner shape, while zod
// strictly required nested fields. The model could only guess, and guessing failed.
test("prepare_sandbox_workspace: profile and files are fully described, not opaque", () => {
  const schema = inputSchemaOf("prepare_sandbox_workspace");

  const profile = schema.properties?.profile;
  assert.equal(profile?.type, "object");
  assert.deepEqual(profile?.required, ["kind", "title"], "profile's own required fields are advertised");
  assert.deepEqual(
    profile?.properties?.kind?.enum,
    ["code_script", "build", "data_job", "experiment"],
    "kind enum is advertised"
  );
  assert.deepEqual(
    profile?.properties?.cleanupPolicy?.enum,
    ["keep", "cleanup_on_success", "cleanup_always"]
  );
  assert.deepEqual(profile?.properties?.allowedCommands?.items?.enum, ["node", "python3", "npm"]);

  const files = schema.properties?.files;
  assert.equal(files?.type, "array");
  assert.deepEqual(files?.items?.required, ["path", "content"], "file entry shape is advertised");
});

test("prepare_sandbox_workspace: a payload built only from the advertised schema passes zod", () => {
  const parsed = zodParse("prepare_sandbox_workspace", {
    profile: { kind: "experiment", title: "spike", cleanupPolicy: "cleanup_always" },
    files: [{ path: "spike.js", content: "console.log(1)" }]
  }) as { profile: { cleanupPolicy: string; allowedCommands: string[] }; files: unknown[] };

  assert.equal(parsed.profile.cleanupPolicy, "cleanup_always");
  assert.deepEqual(parsed.profile.allowedCommands, ["node", "python3", "npm"]);
  assert.equal(parsed.files.length, 1);
});

test("run_sandboxed_command: command enum is advertised and matches zod", () => {
  const schema = inputSchemaOf("run_sandboxed_command");
  assert.deepEqual(schema.properties?.command?.enum, ["node", "python3", "npm"]);
  assert.deepEqual(schema.required, ["sandboxId", "command"]);

  const parsed = zodParse("run_sandboxed_command", {
    sandboxId: "sandbox_abc123",
    command: "node",
    args: ["spike.js"]
  }) as { cwd: string; args: string[] };
  assert.equal(parsed.cwd, ".");
  assert.deepEqual(parsed.args, ["spike.js"]);

  assert.throws(() => zodParse("run_sandboxed_command", { sandboxId: "sandbox_abc123", command: "bash" }));
});

test("create_sandbox_profile: enums advertised and defaults land", () => {
  const schema = inputSchemaOf("create_sandbox_profile");
  assert.deepEqual(schema.properties?.kind?.enum, ["code_script", "build", "data_job", "experiment"]);
  assert.deepEqual(schema.properties?.cleanupPolicy?.enum, ["keep", "cleanup_on_success", "cleanup_always"]);

  const parsed = zodParse("create_sandbox_profile", { kind: "experiment", title: "spike" }) as {
    timeoutMs: number;
    maxOutputBytes: number;
    cleanupPolicy: string;
  };
  assert.equal(parsed.timeoutMs, 120000);
  assert.equal(parsed.maxOutputBytes, 50000);
  assert.equal(parsed.cleanupPolicy, "cleanup_on_success");
});

// Derives the expected set from zod rather than restating it. A hardcoded list would keep
// passing if someone added a required field to zod and forgot the JSON-Schema — which is the
// only failure this test exists to catch.
function zodRequiredFields(name: string): string[] {
  const tool = getToolModule(name);
  assert.ok(tool?.schema, `${name} has a zod schema`);
  const shape = (tool!.schema as unknown as { shape?: Record<string, { isOptional(): boolean }> }).shape;
  assert.ok(shape, `${name}'s zod schema exposes an object shape`);
  return Object.entries(shape!).filter(([, field]) => !field.isOptional()).map(([key]) => key).sort();
}

const sandboxToolNames = [
  "create_sandbox_profile",
  "prepare_sandbox_workspace",
  "run_sandboxed_command",
  "list_sandbox_runs",
  "cleanup_sandbox",
  "export_sandbox_report"
];

test("sandbox tools: every zod-required field is also required in the JSON-Schema", () => {
  for (const name of sandboxToolNames) {
    const schema = inputSchemaOf(name);
    const advertised = [...(schema.required ?? [])].sort();
    assert.deepEqual(advertised, zodRequiredFields(name), `${name}: JSON-Schema required[] must match zod's non-optional fields`);
    assert.equal(schema.additionalProperties, false, `${name} rejects unknown keys`);
    for (const field of advertised) {
      assert.ok(schema.properties?.[field], `${name}.${field} is described`);
    }
  }
});

// The advertised type must not be looser than the validator, or the model sends a legal-looking
// value and gets rejected. z.number().int() must surface as "integer", never "number".
test("sandbox tools: integer-constrained fields are advertised as integer, not number", () => {
  const profile = inputSchemaOf("create_sandbox_profile");
  for (const field of ["timeoutMs", "maxOutputBytes", "maxArtifactBytes"]) {
    assert.equal(profile.properties?.[field]?.type, "integer", `create_sandbox_profile.${field}`);
  }

  const run = inputSchemaOf("run_sandboxed_command");
  for (const field of ["timeoutMs", "maxOutputBytes"]) {
    assert.equal(run.properties?.[field]?.type, "integer", `run_sandboxed_command.${field}`);
  }

  assert.equal(inputSchemaOf("list_sandbox_runs").properties?.limit?.type, "integer", "list_sandbox_runs.limit");

  // Proof the distinction is load-bearing: a float is what "number" would have invited.
  assert.throws(
    () => zodParse("run_sandboxed_command", { sandboxId: "sandbox_abc123", command: "node", timeoutMs: 1500.5 }),
    /[Ii]nteger/
  );
});

test("sandbox-execution skill documents the two-call spike recipe", () => {
  const pack = skillRegistry.find((entry) => entry.id === "sandbox-execution");
  assert.ok(pack, "sandbox-execution skill pack exists");
  assert.match(pack!.protocolMarkdown, /Quick logic spike/);
  assert.ok(pack!.toolNames.includes("prepare_sandbox_workspace"));
  assert.ok(pack!.toolNames.includes("run_sandboxed_command"));
});

// Behavioural, not schema — but it belongs with the others: a description that misstates
// behaviour misleads the agent exactly as badly as a missing enum. cleanup_sandbox was
// documented as "only needed for cleanupPolicy 'keep'", which is wrong in the two cases
// pinned below; believing it leaks a sandbox on every failed run.
test("cleanup_sandbox's description matches when cleanup actually happens", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-cleanup-"));
  const ctx = {
    publicBaseUrl: "https://example.test",
    workspaceRoot: path.join(root, "workspace"),
    commandTimeoutMs: 30000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "test-client"
  } as never;
  const sandboxDir = (id: string) => path.join(root, "artifacts", "sandboxes", id);
  const exists = async (target: string) => Boolean(await stat(target).catch(() => null));

  async function prepare(title: string, cleanupPolicy: string, files?: Array<{ path: string; content: string }>): Promise<string> {
    const result = await callTool("prepare_sandbox_workspace", { profile: { kind: "experiment", title, cleanupPolicy }, ...(files ? { files } : {}) }, ctx);
    assert.equal(result.ok, true, `prepare ${title}`);
    return (result.structuredContent as { sandboxId: string }).sandboxId;
  }

  try {
    const passing = await prepare("passes", "cleanup_on_success", [{ path: "fine.js", content: "console.log('ok');" }]);
    await callTool("run_sandboxed_command", { sandboxId: passing, command: "node", args: ["fine.js"] }, ctx);
    assert.equal(await exists(sandboxDir(passing)), false, "cleanup_on_success removes the sandbox after a SUCCESSFUL run");

    const failing = await prepare("fails", "cleanup_on_success", [{ path: "boom.js", content: "process.exit(3);" }]);
    const failed = await callTool("run_sandboxed_command", { sandboxId: failing, command: "node", args: ["boom.js"] }, ctx);
    assert.equal(failed.ok, false, "the run really did fail");
    assert.equal(await exists(sandboxDir(failing)), true, "a FAILED run is kept on purpose — cleanup_sandbox is required here");

    const neverRun = await prepare("never run", "cleanup_always");
    assert.equal(await exists(sandboxDir(neverRun)), true, "cleanup only fires at the end of a run, so an unrun sandbox persists");

    const description = getToolModule("cleanup_sandbox")?.definition.description ?? "";
    assert.match(description, /failed/i, "the description must warn that failed runs are not auto-cleaned");
    assert.match(description, /never run|prepared but never/i, "the description must warn that an unrun sandbox persists");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
