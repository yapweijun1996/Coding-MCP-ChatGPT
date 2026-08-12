import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";
import { LazyToolRuntime } from "../src/mcp/lazy-registry.js";
import type { ToolManifestEntryBase } from "../src/mcp/manifest-types.js";
import type { ToolContext, ToolDefinition, ToolModule } from "../src/mcp/types.js";

type GroupId = "hot" | "cold";

const ctx: ToolContext = {
  publicBaseUrl: "https://example.test",
  workspaceRoot: "/tmp/lazy-registry-workspace",
  commandTimeoutMs: 1000,
  shareRoot: "/tmp/lazy-registry-shares",
  artifactRoot: "/tmp/lazy-registry-artifacts",
  feedbackRoot: "/tmp/lazy-registry-feedback",
  projectRoot: "/tmp/lazy-registry-projects",
  clientId: "lazy-registry-test"
};

function definition(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false
    }
  };
}

function moduleFor(toolDefinition: ToolDefinition): ToolModule {
  return {
    definition: toolDefinition,
    enabledByDefault: true,
    schema: z.object({ value: z.string().min(3) }),
    handler: async (input) => ({
      ok: true,
      summary: `handled ${(input as { value: string }).value}`,
      artifacts: [],
      logs: [],
      errors: []
    })
  };
}

test("static discovery keeps cold groups unloaded and concurrent first use imports once", async () => {
  const hotDefinition = definition("hot_tool");
  const coldDefinition = definition("cold_tool");
  const manifest: readonly ToolManifestEntryBase<GroupId>[] = [
    { groupId: "hot", definition: hotDefinition, enabledByDefault: true },
    { groupId: "cold", definition: coldDefinition, enabledByDefault: true }
  ];
  let hotLoads = 0;
  let coldLoads = 0;
  const runtime = new LazyToolRuntime(manifest, {
    hot: async () => {
      hotLoads += 1;
      return [moduleFor(hotDefinition)];
    },
    cold: async () => {
      coldLoads += 1;
      return [moduleFor(coldDefinition)];
    }
  });

  const listed = runtime.list();
  assert.deepEqual(listed.map((tool) => tool.definition.name), ["hot_tool", "cold_tool"]);
  assert.equal(hotLoads, 0);
  assert.equal(coldLoads, 0);
  assert.equal(runtime.states().cold.status, "unloaded");

  await runtime.warm(["hot"]);
  assert.equal(hotLoads, 1);
  assert.equal(coldLoads, 0);
  assert.equal(runtime.states().hot.status, "loaded");

  const [first, second] = await Promise.all([runtime.load("cold_tool"), runtime.load("cold_tool")]);
  assert.equal(coldLoads, 1);
  assert.equal(first, second);
  assert.equal(runtime.states().cold.status, "loaded");

  const result = await listed[1].handler({ value: "ready" }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.summary, "handled ready");
});

test("lazy proxy converts load failures into stable tool errors and caches the failure", async () => {
  const brokenDefinition = definition("broken_tool");
  let loads = 0;
  const runtime = new LazyToolRuntime<"broken">([
    { groupId: "broken", definition: brokenDefinition, enabledByDefault: true }
  ], {
    broken: async () => {
      loads += 1;
      throw new Error("optional dependency missing");
    }
  });
  const proxy = runtime.get("broken_tool");
  assert.ok(proxy);

  const first = await proxy.handler({ value: "ready" }, ctx);
  const second = await proxy.handler({ value: "ready" }, ctx);
  assert.equal(loads, 1);
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.match(first.summary, /Failed to load MCP tool group broken: optional dependency missing/);
  assert.equal(runtime.states().broken.status, "error");
});

test("manifest drift rejects the entire lazy group without exposing partial handlers", async () => {
  const firstDefinition = definition("first_tool");
  const secondDefinition = definition("second_tool");
  const runtime = new LazyToolRuntime<"drift">([
    { groupId: "drift", definition: firstDefinition, enabledByDefault: true },
    { groupId: "drift", definition: secondDefinition, enabledByDefault: true }
  ], {
    drift: async () => [
      moduleFor(firstDefinition),
      moduleFor({ ...secondDefinition, description: "stale runtime definition" })
    ]
  });

  await assert.rejects(runtime.load("second_tool"), /Tool manifest drift for second_tool/);
  await assert.rejects(runtime.load("first_tool"), /Tool manifest drift for second_tool/);
  assert.equal(runtime.states().drift.status, "error");
});

test("server entry modules do not statically import cold handler domains", async () => {
  const entryFiles = ["src/server.ts", "src/admin-api.ts", "src/http/mcp-routes.ts"];
  const coldModules = [
    "browser",
    "browser-observability",
    "web-inspect",
    "web-rebuild",
    "music-workflow",
    "music-production-orchestrator",
    "presentation",
    "svg-design-studio",
    "three-d-game"
  ];
  for (const filename of entryFiles) {
    const source = await readFile(filename, "utf8");
    for (const moduleName of coldModules) {
      const staticImport = new RegExp(`^import(?!\\s+type\\b)[^;]*["'][^"']*mcp/tools/${moduleName}\\.js["']`, "m");
      assert.doesNotMatch(source, staticImport, `${filename} bypasses lazy loading for ${moduleName}`);
    }
  }
});
