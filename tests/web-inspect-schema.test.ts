import { test } from "node:test";
import assert from "node:assert/strict";
import { getToolModule } from "../src/mcp/registry.js";

test("inspect_webpage schema: captureNetwork defaults to true, slowRequestMs defaults to 2500", () => {
  const tool = getToolModule("inspect_webpage");
  assert.ok(tool, "inspect_webpage registered");
  const parsed = tool!.schema!.parse({ url: "https://93.184.216.34/" }) as {
    captureNetwork: boolean;
    slowRequestMs: number;
    viewports: string[];
  };
  assert.equal(parsed.captureNetwork, true);
  assert.equal(parsed.slowRequestMs, 2500);
  assert.deepEqual(parsed.viewports, ["desktop", "tablet", "mobile"]);
});

test("inspect_webpage schema: captureNetwork can be set to false for lightweight check", () => {
  const tool = getToolModule("inspect_webpage");
  assert.ok(tool, "inspect_webpage registered");
  const parsed = tool!.schema!.parse({ url: "https://93.184.216.34/", captureNetwork: false }) as {
    captureNetwork: boolean;
  };
  assert.equal(parsed.captureNetwork, false);
});

test("inspect_webpage_plus schema: defaults unchanged", () => {
  const tool = getToolModule("inspect_webpage_plus");
  assert.ok(tool, "inspect_webpage_plus registered");
  const parsed = tool!.schema!.parse({ url: "https://93.184.216.34/" }) as {
    captureNetwork: boolean;
    captureTrace: boolean;
    slowRequestMs: number;
  };
  assert.equal(parsed.captureNetwork, true);
  assert.equal(parsed.captureTrace, false);
  assert.equal(parsed.slowRequestMs, 2500);
});
