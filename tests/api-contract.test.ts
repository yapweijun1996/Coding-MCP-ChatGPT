import { createServer } from "node:http";
import assert from "node:assert/strict";
import test from "node:test";
import { getToolModule } from "../src/mcp/registry.js";
import { skillRegistry } from "../src/skills/registry.js";

async function withServer<T>(handler: Parameters<typeof createServer>[0], run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("api_contract_test validates status, headers, schema, json paths, and pagination", async () => {
  await withServer((req, res) => {
    if (req.url?.startsWith("/v1/items")) {
      res.setHeader("content-type", "application/json");
      res.setHeader("x-api-version", "2026-06");
      res.end(JSON.stringify({ data: [{ id: 1, name: "Alpha" }], next: "/v1/items?page=2", status: "ok" }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  }, async (baseUrl) => {
    const tool = getToolModule("api_contract_test");
    assert.ok(tool, "api_contract_test registered");
    const result = await tool!.handler({
      allowlistedHosts: ["127.0.0.1"],
      cases: [{
        id: "list-items",
        url: `${baseUrl}/v1/items?page=1`,
        expectStatus: 200,
        expectJsonSchema: {
          type: "object",
          required: ["data", "next"],
          properties: {
            data: { type: "array", items: { type: "object", required: ["id", "name"], properties: { id: { type: "integer" }, name: { type: "string" } } } },
            next: { type: "string" },
            status: { enum: ["ok"] }
          }
        },
        assertions: [
          { kind: "header_exists", name: "content-type" },
          { kind: "header_equals", name: "x-api-version", value: "2026-06" },
          { kind: "json_path_equals", path: "$.data[0].name", value: "Alpha" },
          { kind: "json_path_type", path: "$.data", type: "array" }
        ],
        pagination: { itemsPath: "$.data", nextPath: "$.next", minItems: 1 }
      }]
    }, {} as never);

    assert.equal(result.ok, true);
    const payload = result.structuredContent as { passed: number; failed: number; caseResults: Array<{ ok: boolean }> };
    assert.equal(payload.passed, 1);
    assert.equal(payload.failed, 0);
    assert.equal(payload.caseResults[0].ok, true);
  });
});

test("api_contract_test reports schema drift", async () => {
  await withServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "not-an-integer" }] }));
  }, async (baseUrl) => {
    const tool = getToolModule("api_contract_test");
    assert.ok(tool, "api_contract_test registered");
    const result = await tool!.handler({
      allowlistedHosts: ["127.0.0.1"],
      cases: [{
        id: "schema-drift",
        url: `${baseUrl}/v1/items`,
        expectJsonSchema: {
          type: "object",
          required: ["data"],
          properties: {
            data: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } }
          }
        }
      }]
    }, {} as never);

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /expected integer/);
  });
});

test("integration skills expose api_contract_test", () => {
  for (const id of ["coding", "agent-integration-readonly"]) {
    const skill = skillRegistry.find((entry) => entry.id === id);
    assert.ok(skill, `${id} skill registered`);
    assert.ok(skill!.toolNames.includes("api_contract_test"));
  }
});
