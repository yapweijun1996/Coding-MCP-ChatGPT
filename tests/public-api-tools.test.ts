import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { callTool } from "../src/mcp/router.js";
import { getToolModule } from "../src/mcp/registry.js";
import type { ToolContext } from "../src/mcp/types.js";
import { publicApiRegistry, publicApiToolName } from "../src/mcp/tools/public-api.js";
import { skillRegistry } from "../src/skills/registry.js";

function toolContext(root = "/tmp/public-api-tools-test"): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "public-api-tools-test"
  };
}

async function withMockFetch<T>(handler: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("public API tools register no-key APIs only with stable names", () => {
  assert.equal(publicApiRegistry.length, 91);
  const names = publicApiRegistry.map((api) => publicApiToolName(api.id));
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.every((name) => /^public_api_[a-z0-9_]+$/.test(name)), true);

  for (const name of names) assert.ok(getToolModule(name), `${name} registered`);
  for (const keyRequiredId of ["openalex-reference", "coingecko-demo", "fred-reference", "tmdb-reference", "lta"]) {
    assert.equal(getToolModule(publicApiToolName(keyRequiredId)), undefined);
  }
  assert.equal(getToolModule(publicApiToolName("usaspending")), undefined, "POST-only no-key API is not registered in GET-only v1");
});

test("public API tools are exposed through coding, debug, and readonly integration skills", () => {
  for (const skillId of ["coding", "debug", "agent-integration-readonly"]) {
    const skill = skillRegistry.find((entry) => entry.id === skillId);
    assert.ok(skill, `${skillId} skill exists`);
    assert.ok(skill.toolNames.includes("public_api_dummy_products"), `${skillId} exposes public_api_dummy_products`);
    assert.ok(skill.toolNames.includes("public_api_data_gov_carpark"), `${skillId} exposes public_api_data_gov_carpark`);
  }
});

test("public API tool parses JSON responses and rejects arbitrary URL input", async () => {
  const calls: string[] = [];
  await withMockFetch(async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ products: [{ id: 1, title: "Demo" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }, async () => {
    const result = await callTool("public_api_dummy_products", {}, toolContext());
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "https://dummyjson.com/products?limit=8");
    const payload = result.structuredContent as { apiId: string; endpoint: string; data: { products: Array<{ title: string }> }; usage: { status: string } };
    assert.equal(payload.apiId, "dummy-products");
    assert.equal(payload.endpoint, "https://dummyjson.com/products?limit=8");
    assert.equal(payload.data.products[0].title, "Demo");
    assert.equal(payload.usage.status, "demo-only");

    const invalid = await callTool("public_api_dummy_products", { url: "https://evil.example.test" }, toolContext());
    assert.equal(invalid.ok, false);
    assert.match(invalid.summary, /Unrecognized key/);
  });
});

test("public API tool returns text for XML and raw response mode", async () => {
  await withMockFetch(async () => new Response("<feed><title>arXiv</title></feed>", {
    status: 200,
    headers: { "content-type": "application/atom+xml" }
  }), async () => {
    const xml = await callTool("public_api_arxiv_search", {}, toolContext());
    assert.equal(xml.ok, true);
    assert.equal((xml.structuredContent as { text: string }).text.includes("<feed>"), true);

    const rawJson = await callTool("public_api_arxiv_search", { responseMode: "raw" }, toolContext());
    assert.equal(rawJson.ok, true);
    assert.equal(typeof (rawJson.structuredContent as { text: string }).text, "string");
  });
});

test("public API tool returns image metadata without inlining bytes", async () => {
  await withMockFetch(async () => new Response("ignored", {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": "12345" }
  }), async () => {
    const result = await callTool("public_api_open_library_covers", {}, toolContext());
    assert.equal(result.ok, true);
    const payload = result.structuredContent as { metadata: { contentLength?: number }; data?: unknown; text?: unknown };
    assert.equal(payload.metadata.contentLength, 12345);
    assert.equal(payload.data, undefined);
    assert.equal(payload.text, undefined);
  });
});

test("public API tool reports HTTP errors, oversized bodies, timeouts, and unsafe redirects", async () => {
  await withMockFetch(async () => new Response("upstream failed", { status: 500, headers: { "content-type": "text/plain" } }), async () => {
    const result = await callTool("public_api_dummy_products", {}, toolContext());
    assert.equal(result.ok, false);
    assert.match(result.summary, /HTTP 500/);
    assert.equal((result.structuredContent as { text: string }).text, "upstream failed");
  });

  await withMockFetch(async () => new Response("x", { status: 200, headers: { "content-length": String(1024 * 1024 + 1) } }), async () => {
    const result = await callTool("public_api_dummy_products", {}, toolContext());
    assert.equal(result.ok, false);
    assert.match(result.summary, /exceeds 1048576 bytes/);
  });

  await withMockFetch((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  }), async () => {
    const result = await callTool("public_api_dummy_products", { timeoutMs: 1000 }, toolContext());
    assert.equal(result.ok, false);
    assert.match(result.summary, /aborted/);
  });

  await withMockFetch(async () => new Response("", { status: 302, headers: { location: "http://127.0.0.1/private" } }), async () => {
    const result = await callTool("public_api_dummy_products", {}, toolContext());
    assert.equal(result.ok, false);
    assert.equal(/Only https:\/\/ URLs are allowed|Private or reserved IP URLs are not allowed/.test(result.summary), true);
  });
});
