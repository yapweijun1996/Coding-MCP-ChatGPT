import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getToolModule } from "../src/mcp/registry.js";
import type { ToolContext } from "../src/mcp/types.js";
import { skillRegistry } from "../src/skills/registry.js";

function toolContext(root: string): ToolContext {
  return {
    publicBaseUrl: "https://example.test",
    workspaceRoot: root,
    commandTimeoutMs: 1000,
    shareRoot: path.join(root, "shares"),
    artifactRoot: path.join(root, "artifacts"),
    feedbackRoot: path.join(root, "feedback"),
    projectRoot: path.join(root, "projects"),
    clientId: "interaction-recording-test"
  };
}

test("interaction recording tools create replayable artifacts and dry-run replay evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "interaction-recording-"));
  try {
    const ctx = toolContext(root);
    const record = getToolModule("record_interaction_flow");
    const replay = getToolModule("replay_interaction_recording");
    assert.ok(record, "record_interaction_flow registered");
    assert.ok(replay, "replay_interaction_recording registered");

    const recordResult = await record!.handler({
      title: "Mobile drawer bug",
      url: "https://example.test/app",
      viewport: "mobile",
      steps: [
        { action: "click", selector: "button[aria-label='Menu']", label: "Open menu" },
        { action: "fill", selector: "input[name='search']", value: "orders" },
        { action: "scroll", y: 480 },
        { action: "screenshot", label: "Menu state" }
      ]
    }, ctx);
    assert.equal(recordResult.ok, true);
    const recordingPayload = recordResult.structuredContent as {
      recordingId: string;
      recordingArtifact: string;
      reportUrl: string;
      replaySteps: Array<{ id: string; action: string; label: string; timestampMs: number }>;
      recording: { url: string; viewport: string; steps: unknown[] };
    };
    assert.match(recordingPayload.recordingId, /^interaction_/);
    assert.match(recordingPayload.recordingArtifact, /\/artifact\//);
    assert.match(recordingPayload.reportUrl, /\/share\//);
    assert.equal(recordingPayload.recording.url, "https://example.test/app");
    assert.equal(recordingPayload.recording.viewport, "mobile");
    assert.equal(recordingPayload.replaySteps.length, 4);
    assert.equal(recordingPayload.replaySteps[0].id, "step_01");
    assert.equal(recordingPayload.replaySteps[0].label, "Open menu");

    const replayResult = await replay!.handler({
      recording: recordingPayload.recording,
      dryRun: true,
      captureScreenshots: true,
      captureConsole: true,
      captureNetwork: true
    }, ctx);
    assert.equal(replayResult.ok, true);
    const replayPayload = replayResult.structuredContent as {
      replayId: string;
      dryRun: boolean;
      targetUrl: string;
      reportUrl: string;
      steps: Array<{ id: string; dryRun: boolean; screenshot?: string; consoleTrace?: unknown[]; networkTrace?: unknown[] }>;
    };
    assert.match(replayPayload.replayId, /^replay_/);
    assert.equal(replayPayload.dryRun, true);
    assert.equal(replayPayload.targetUrl, "https://example.test/app");
    assert.match(replayPayload.reportUrl, /\/share\//);
    assert.equal(replayPayload.steps.length, 4);
    assert.equal(replayPayload.steps[0].dryRun, true);
    assert.equal(replayPayload.steps[0].screenshot, "planned-step-1.png");
    assert.deepEqual(replayPayload.steps[0].consoleTrace, []);
    assert.deepEqual(replayPayload.steps[0].networkTrace, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interaction recording tools are exposed through browser QA and debug skills", () => {
  const toolNames = ["record_interaction_flow", "replay_interaction_recording"];
  const browserQa = skillRegistry.find((entry) => entry.id === "browser-qa");
  const observability = skillRegistry.find((entry) => entry.id === "agent-browser-observability");
  const debug = skillRegistry.find((entry) => entry.id === "debug");
  assert.ok(browserQa);
  assert.ok(observability);
  assert.ok(debug);
  for (const toolName of toolNames) {
    assert.ok(browserQa!.toolNames.includes(toolName), `${toolName} exposed in browser-qa`);
    assert.ok(observability!.toolNames.includes(toolName), `${toolName} exposed in agent-browser-observability`);
    assert.ok(debug!.toolNames.includes(toolName), `${toolName} exposed in debug`);
  }
});
