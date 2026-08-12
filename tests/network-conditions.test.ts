import { test } from "node:test";
import assert from "node:assert/strict";
import { loadToolModule } from "../src/mcp/registry.js";
import { skillRegistry } from "../src/skills/registry.js";

test("inspect_network_conditions is registered with offline and weak-network defaults", async () => {
  const tool = await loadToolModule("inspect_network_conditions");
  assert.ok(tool, "inspect_network_conditions registered");
  const parsed = tool!.schema!.parse({ url: "https://example.com/" }) as {
    scenarios: string[];
    viewport: string;
    timeoutMs: number;
    settleMs: number;
    screenshot: boolean;
    maxRequests: number;
  };

  assert.deepEqual(parsed.scenarios, ["offline", "slow3g"]);
  assert.equal(parsed.viewport, "mobile");
  assert.equal(parsed.timeoutMs, 30000);
  assert.equal(parsed.settleMs, 2000);
  assert.equal(parsed.screenshot, true);
  assert.equal(parsed.maxRequests, 40);
  assert.throws(() => tool!.schema!.parse({ url: "https://example.com/", scenarios: ["edge"] }), /Invalid enum value/);
});

test("Browser QA skill exposes network condition inspection", () => {
  const browserQa = skillRegistry.find((skill) => skill.id === "browser-qa");
  assert.ok(browserQa, "browser-qa skill registered");
  assert.ok(browserQa!.toolNames.includes("inspect_network_conditions"));
});
