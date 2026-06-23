import { test } from "node:test";
import assert from "node:assert/strict";
import { getToolModule } from "../src/mcp/registry.js";

test("inspect_webpage_multibrowser is registered with safe defaults", () => {
  const tool = getToolModule("inspect_webpage_multibrowser");
  assert.ok(tool, "inspect_webpage_multibrowser registered");
  const parsed = tool!.schema!.parse({ url: "https://93.184.216.34/" }) as {
    browsers: string[];
    viewports: string[];
    captureNetwork: boolean;
    continueOnBrowserError: boolean;
  };
  assert.deepEqual(parsed.browsers, ["chromium", "firefox", "webkit"]);
  assert.deepEqual(parsed.viewports, ["desktop", "tablet", "mobile"]);
  assert.equal(parsed.captureNetwork, true);
  assert.equal(parsed.continueOnBrowserError, true);
  assert.throws(() => tool!.schema!.parse({ url: "https://93.184.216.34/", browsers: ["safari"] }), /Invalid enum value/);
});
