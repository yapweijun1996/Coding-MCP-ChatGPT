// Aggregates .telemetry/*.jsonl into a tool-failure report.
//
// Why this exists: the telemetry sink has been accumulating since 2026-06-20, but nothing
// read it. A 2026-07-30 aggregation found a 13.4% overall failure rate concentrated in a
// handful of tools — a level of pain that was invisible because agents silently retry. This
// script makes that measurement repeatable, so a fix can be proven to have moved the number
// rather than merely asserted to have.
//
// Usage:
//   node scripts/telemetry-report.mjs                 # all retained days
//   node scripts/telemetry-report.mjs --days 7        # last 7 days only
//   node scripts/telemetry-report.mjs --json          # machine-readable, for diffing runs
//   node scripts/telemetry-report.mjs --tool apply_patch   # sample failures for one tool

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const telemetryDir = value("--dir", path.join(process.cwd(), ".telemetry"));
const dayLimit = Number(value("--days", "0")) || 0;
const asJson = flag("--json");
const focusTool = value("--tool", "");

if (!existsSync(telemetryDir)) {
  console.error(`No telemetry directory at ${telemetryDir}`);
  process.exit(1);
}

let files = readdirSync(telemetryDir).filter((f) => f.endsWith(".jsonl")).sort();
if (dayLimit > 0) files = files.slice(-dayLimit);
if (files.length === 0) {
  console.error("No .jsonl telemetry files found.");
  process.exit(1);
}

const tools = new Map();
const clients = new Map();
const protocolVersions = new Map();
const failureCategories = new Map();
const focusFailures = [];
const performanceSamples = Object.fromEntries([
  "queueWaitMs", "executionMs", "queueDepth", "eventLoopDelayMs", "rssBytes", "toolListCount", "toolListBytes"
].map((name) => [name, []]));
let totalCalls = 0;
let totalFailures = 0;

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

for (const file of files) {
  const raw = readFileSync(path.join(telemetryDir, file), "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a torn final line during an in-flight write is not worth failing over
    }
    if (event.clientType) bump(clients, event.clientType);
    for (const [name, samples] of Object.entries(performanceSamples)) {
      if (typeof event[name] === "number" && Number.isFinite(event[name])) samples.push(event[name]);
    }
    // protocolVersion is only present on records written after the 2026-07-30 change; older
    // rows are counted as "(unrecorded)" rather than silently dropped, so the report never
    // implies more coverage than it has.
    if (event.method === "initialize") {
      bump(protocolVersions, `${event.clientType ?? "unknown"} => ${event.protocolVersion ?? "(unrecorded)"}`);
    }
    if (event.method !== "tools/call") continue;

    const name = event.toolName ?? "(unnamed)";
    totalCalls += 1;
    const entry = tools.get(name) ?? { calls: 0, failures: 0, durations: [], sampleError: "" };
    entry.calls += 1;
    if (typeof event.durationMs === "number") entry.durations.push(event.durationMs);
    if (event.ok === false) {
      totalFailures += 1;
      bump(failureCategories, event.failureCategory ?? "execution");
      entry.failures += 1;
      const message = event.errorMessage || event.summary || "";
      if (!entry.sampleError) entry.sampleError = String(message).slice(0, 200);
      if (focusTool && name === focusTool) {
        focusFailures.push({ time: event.time, summary: event.summary, errorMessage: event.errorMessage, args: event.args });
      }
    }
    tools.set(name, entry);
  }
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
const summarizeValues = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    samples: sorted.length,
    p50: sorted.length ? percentile(sorted, 0.5) : null,
    p95: sorted.length ? percentile(sorted, 0.95) : null,
    p99: sorted.length ? percentile(sorted, 0.99) : null,
    max: sorted.at(-1) ?? null,
    avg: sorted.length ? Number((sum / sorted.length).toFixed(3)) : null
  };
};

const rows = [...tools.entries()]
  .map(([name, entry]) => {
    const sorted = [...entry.durations].sort((a, b) => a - b);
    return {
      tool: name,
      calls: entry.calls,
      failures: entry.failures,
      failureRate: entry.calls ? entry.failures / entry.calls : 0,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      sampleError: entry.sampleError
    };
  })
  .sort((a, b) => b.failures - a.failures);

const report = {
  generatedFrom: { dir: telemetryDir, files: files.length, firstDay: files[0], lastDay: files[files.length - 1] },
  totals: {
    calls: totalCalls,
    failures: totalFailures,
    failureRate: totalCalls ? Number((totalFailures / totalCalls).toFixed(4)) : 0,
    distinctToolsCalled: tools.size
  },
  clients: Object.fromEntries([...clients.entries()].sort((a, b) => b[1] - a[1])),
  protocolVersions: Object.fromEntries([...protocolVersions.entries()].sort((a, b) => b[1] - a[1])),
  failureCategories: Object.fromEntries([...failureCategories.entries()].sort((a, b) => b[1] - a[1])),
  performance: Object.fromEntries(Object.entries(performanceSamples).map(([name, samples]) => [name, summarizeValues(samples)])),
  tools: rows
};

if (focusTool) {
  console.log(JSON.stringify({ tool: focusTool, failureCount: focusFailures.length, samples: focusFailures.slice(0, 20) }, null, 2));
  process.exit(0);
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;
console.log(`Telemetry: ${files.length} day file(s), ${files[0]} .. ${files[files.length - 1]}`);
console.log(`Calls: ${totalCalls}   Failures: ${totalFailures}   Failure rate: ${pct(report.totals.failureRate)}`);
console.log(`Distinct tools called: ${tools.size}\n`);

console.log("Clients:");
for (const [name, count] of Object.entries(report.clients)) console.log(`  ${String(count).padStart(6)}  ${name}`);

console.log("\nNegotiated MCP protocol versions (initialize):");
const versionRows = Object.entries(report.protocolVersions);
if (versionRows.length === 0) console.log("  (no initialize events in range)");
for (const [name, count] of versionRows) console.log(`  ${String(count).padStart(6)}  ${name}`);

console.log("\nTop failing tools (by absolute failure count):");
console.log(`  ${"fails".padStart(6)} ${"calls".padStart(6)} ${"rate".padStart(6)}  tool`);
for (const row of rows.filter((r) => r.failures > 0).slice(0, 25)) {
  console.log(`  ${String(row.failures).padStart(6)} ${String(row.calls).padStart(6)} ${pct(row.failureRate).padStart(6)}  ${row.tool}`);
  if (row.sampleError) console.log(`         ↳ ${row.sampleError}`);
}

console.log("\nFailure categories:");
for (const [name, count] of Object.entries(report.failureCategories)) console.log(`  ${String(count).padStart(6)}  ${name}`);

console.log("\nRuntime and queue metrics:");
for (const [name, metric] of Object.entries(report.performance)) {
  if (!metric.samples) continue;
  console.log(`  ${name.padEnd(18)} p50=${metric.p50}  p95=${metric.p95}  p99=${metric.p99}  max=${metric.max}  n=${metric.samples}`);
}

console.log("\nSlowest tools (p95, calls >= 5):");
for (const row of [...rows].filter((r) => r.calls >= 5).sort((a, b) => b.p95Ms - a.p95Ms).slice(0, 10)) {
  console.log(`  ${String(Math.round(row.p95Ms)).padStart(7)}ms p95  ${String(Math.round(row.p50Ms)).padStart(6)}ms p50  ${row.tool}`);
}
