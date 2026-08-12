#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { heavyToolGroupIds } from "../dist/mcp/tools/index.js";

const registryUrl = new URL("../dist/mcp/registry.js", import.meta.url).href;
const serverUrl = new URL("../dist/server.js", import.meta.url).href;
const repetitionsArg = process.argv.find((value) => value.startsWith("--repetitions="));
const repetitions = repetitionsArg ? Number.parseInt(repetitionsArg.split("=")[1], 10) : 5;
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 50) {
  throw new Error("--repetitions must be an integer from 1 to 50.");
}

const scenarios = [
  { id: "registry", toolName: undefined },
  { id: "web_inspect_first_load", toolName: "inspect_webpage" },
  { id: "music_first_load", toolName: "create_music_style_brief" },
  { id: "presentation_first_load", toolName: "create_html_deck" }
];

function runChild(toolName) {
  const source = `
const beforeRss = process.memoryUsage().rss;
const registryStartedAt = performance.now();
const registry = await import(${JSON.stringify(registryUrl)});
const registryMs = performance.now() - registryStartedAt;
const afterRegistryRss = process.memoryUsage().rss;
const toolStartedAt = performance.now();
const toolName = ${JSON.stringify(toolName)};
if (toolName) {
  const tool = await registry.loadToolModule(toolName);
  if (!tool) throw new Error(\`Benchmark tool not found: \${toolName}\`);
}
const toolMs = performance.now() - toolStartedAt;
const afterToolRss = process.memoryUsage().rss;
console.log(JSON.stringify({
  registryMs,
  registryRssDeltaMiB: (afterRegistryRss - beforeRss) / 1024 / 1024,
  toolMs,
  toolRssDeltaMiB: (afterToolRss - afterRegistryRss) / 1024 / 1024,
  toolCount: registry.toolDefinitions.length
}));
`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  if (child.status !== 0) {
    throw new Error(`Registry benchmark child failed (${child.status}): ${child.stderr || child.stdout}`);
  }
  const output = child.stdout.trim().split("\n").at(-1);
  if (!output) throw new Error("Registry benchmark child produced no output.");
  return JSON.parse(output);
}

function runServerChild() {
  const source = `
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const root = await mkdtemp(path.join(os.tmpdir(), "mcp-server-benchmark-"));
process.env.NODE_ENV = "test";
process.env.WORKSPACE_ROOT = root;
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:6859";
process.env.CONTENT_BASE_URL = "http://127.0.0.1:6859";
process.env.ADMIN_PASSCODE = "benchmark-only-passcode";
process.env.STORAGE_MONITOR_INTERVAL_MS = "0";
delete process.env.DATABASE_URL;
const beforeRss = process.memoryUsage().rss;
const startedAt = performance.now();
try {
  await import(${JSON.stringify(serverUrl)});
  const importMs = performance.now() - startedAt;
  const afterRss = process.memoryUsage().rss;
  const registry = await import(${JSON.stringify(registryUrl)});
  const states = registry.getToolGroupRuntimeStates();
  const unexpectedlyLoaded = ${JSON.stringify(heavyToolGroupIds)}
    .filter((groupId) => states[groupId]?.status !== "unloaded");
  console.log(JSON.stringify({ importMs, rssDeltaMiB: (afterRss - beforeRss) / 1024 / 1024, unexpectedlyLoaded }));
} finally {
  await rm(root, { recursive: true, force: true });
}
`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  if (child.status !== 0) {
    throw new Error(`Server benchmark child failed (${child.status}): ${child.stderr || child.stdout}`);
  }
  const output = child.stdout.trim().split("\n").at(-1);
  if (!output) throw new Error("Server benchmark child produced no output.");
  return JSON.parse(output);
}

function percentile(values, quantile) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)];
}

function metric(values) {
  return {
    min: Math.round(Math.min(...values) * 1000) / 1000,
    p50: Math.round(percentile(values, 0.5) * 1000) / 1000,
    p95: Math.round(percentile(values, 0.95) * 1000) / 1000,
    max: Math.round(Math.max(...values) * 1000) / 1000
  };
}

const report = {};
const serverSamples = Array.from({ length: repetitions }, () => runServerChild());
report.server_entry = {
  importMs: metric(serverSamples.map((sample) => sample.importMs)),
  rssDeltaMiB: metric(serverSamples.map((sample) => sample.rssDeltaMiB)),
  unexpectedlyLoadedColdGroups: [...new Set(serverSamples.flatMap((sample) => sample.unexpectedlyLoaded))]
};
for (const scenario of scenarios) {
  const samples = Array.from({ length: repetitions }, () => runChild(scenario.toolName));
  report[scenario.id] = scenario.toolName
    ? {
        toolName: scenario.toolName,
        firstLoadMs: metric(samples.map((sample) => sample.toolMs)),
        rssDeltaMiB: metric(samples.map((sample) => sample.toolRssDeltaMiB))
      }
    : {
        toolCount: samples[0].toolCount,
        importMs: metric(samples.map((sample) => sample.registryMs)),
        rssDeltaMiB: metric(samples.map((sample) => sample.registryRssDeltaMiB))
      };
}

const thresholds = {
  registryP95Ms: Number.parseFloat(process.env.MCP_REGISTRY_MAX_P95_MS ?? "125"),
  registryRssP95MiB: Number.parseFloat(process.env.MCP_REGISTRY_MAX_RSS_P95_MIB ?? "70")
};
const failures = [];
if (report.server_entry.unexpectedlyLoadedColdGroups.length > 0) {
  failures.push(`server entry loaded cold groups: ${report.server_entry.unexpectedlyLoadedColdGroups.join(", ")}`);
}
if (report.registry.importMs.p95 > thresholds.registryP95Ms) {
  failures.push(`registry import p95 ${report.registry.importMs.p95}ms exceeds ${thresholds.registryP95Ms}ms`);
}
if (report.registry.rssDeltaMiB.p95 > thresholds.registryRssP95MiB) {
  failures.push(`registry RSS p95 ${report.registry.rssDeltaMiB.p95}MiB exceeds ${thresholds.registryRssP95MiB}MiB`);
}

console.log(JSON.stringify({
  ok: failures.length === 0,
  enforced: process.env.MCP_REGISTRY_BENCHMARK_ENFORCE === "1",
  repetitions,
  node: process.version,
  thresholds,
  failures,
  scenarios: report
}, null, 2));

if (failures.length > 0 && process.env.MCP_REGISTRY_BENCHMARK_ENFORCE === "1") {
  process.exitCode = 1;
}
