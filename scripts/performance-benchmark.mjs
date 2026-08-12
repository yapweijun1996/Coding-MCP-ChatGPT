#!/usr/bin/env node

import { performance } from "node:perf_hooks";

const baseUrl = (process.env.MCP_BENCHMARK_URL ?? "http://127.0.0.1:6859").replace(/\/$/, "");
const token = process.env.MCP_BENCHMARK_TOKEN?.trim();
// Twenty samples keep the default run below the production MCP token-bucket limit while
// still exercising the requested 20-way concurrency. Larger CI runs can opt in via env.
const iterations = positiveInt(process.env.MCP_BENCHMARK_ITERATIONS, 20);
const concurrency = positiveInt(process.env.MCP_BENCHMARK_CONCURRENCY, 20);
const enqueueEnabled = process.env.MCP_BENCHMARK_ENQUEUE === "1";
const enforce = process.env.MCP_BENCHMARK_ENFORCE === "1";
const benchmarkProjectId = process.env.MCP_BENCHMARK_PROJECT_ID ?? "benchmark_missing_project";
const pollDeadlineMs = positiveInt(process.env.MCP_BENCHMARK_POLL_DEADLINE_MS, 10_000);

if (!token) {
  console.error("MCP_BENCHMARK_TOKEN is required. Use a short-lived OAuth access token or an enabled local dev token.");
  process.exit(2);
}

function positiveInt(raw, fallback) {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

let nextRequestId = 1;
async function rpc(method, params) {
  const id = nextRequestId++;
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
  });
  const durationMs = performance.now() - startedAt;
  const payload = await response.json().catch(() => undefined);
  if (!response.ok || !payload || payload.error) {
    throw new Error(`RPC ${method} failed (${response.status}): ${JSON.stringify(payload?.error ?? payload ?? "invalid JSON")}`);
  }
  return { durationMs, result: payload.result };
}

async function runConcurrent(count, width, task) {
  const results = new Array(count);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(width, count) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= count) return;
      results[index] = await task(index);
    }
  }));
  return results;
}

function percentile(sorted, quantile) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function stats(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    meanMs: round(sum / Math.max(1, sorted.length)),
    p50Ms: round(percentile(sorted, 0.50)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted.at(-1) ?? 0)
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function toolResult(rpcResult) {
  const text = rpcResult?.content?.find?.((item) => item?.type === "text")?.text;
  const parsed = typeof text === "string" ? JSON.parse(text) : undefined;
  return { ...parsed, structuredContent: rpcResult?.structuredContent ?? parsed?.structuredContent };
}

async function benchmarkRpc(name, method, params) {
  await runConcurrent(Math.min(5, iterations), Math.min(5, concurrency), () => rpc(method, params));
  const samples = await runConcurrent(iterations, concurrency, async () => (await rpc(method, params)).durationMs);
  return { name, ...stats(samples) };
}

const checks = [];
checks.push(await benchmarkRpc("tools/list", "tools/list"));
checks.push(await benchmarkRpc("light:list_background_jobs", "tools/call", {
  name: "list_background_jobs",
  arguments: { limit: 1 }
}));

let queueResult;
if (enqueueEnabled) {
  const enqueued = await runConcurrent(iterations, concurrency, async () => {
    const response = await rpc("tools/call", {
      name: "run_project_build",
      arguments: { projectId: benchmarkProjectId }
    });
    const result = toolResult(response.result);
    if (!result.jobId) throw new Error("Queue response did not contain a jobId.");
    return { jobId: result.jobId, enqueueMs: response.durationMs };
  });

  const pollSamples = [];
  const completionSamples = [];
  const timedOutJobs = [];
  await runConcurrent(enqueued.length, concurrency, async (index) => {
    const entry = enqueued[index];
    const startedAt = performance.now();
    for (;;) {
      const response = await rpc("tools/call", { name: "get_job_status", arguments: { jobId: entry.jobId } });
      pollSamples.push(response.durationMs);
      const result = toolResult(response.result);
      if (result.structuredContent?.done) {
        completionSamples.push(performance.now() - startedAt);
        return;
      }
      if (performance.now() - startedAt >= pollDeadlineMs) {
        timedOutJobs.push(entry.jobId);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  queueResult = {
    name: "durable-queue",
    projectId: benchmarkProjectId,
    enqueue: stats(enqueued.map((entry) => entry.enqueueMs)),
    poll: stats(pollSamples),
    completion: stats(completionSamples),
    timedOutJobs: timedOutJobs.length
  };
}

const thresholds = {
  toolsListP95Ms: 250,
  lightCallP95Ms: 250,
  enqueueP95Ms: 1000,
  pollP95Ms: 250
};
const failures = [];
if (checks[0].p95Ms > thresholds.toolsListP95Ms) failures.push(`tools/list p95 ${checks[0].p95Ms}ms > ${thresholds.toolsListP95Ms}ms`);
if (checks[1].p95Ms > thresholds.lightCallP95Ms) failures.push(`light call p95 ${checks[1].p95Ms}ms > ${thresholds.lightCallP95Ms}ms`);
if (queueResult?.enqueue.p95Ms > thresholds.enqueueP95Ms) failures.push(`enqueue p95 ${queueResult.enqueue.p95Ms}ms > ${thresholds.enqueueP95Ms}ms`);
if (queueResult?.poll.p95Ms > thresholds.pollP95Ms) failures.push(`poll p95 ${queueResult.poll.p95Ms}ms > ${thresholds.pollP95Ms}ms`);
if (queueResult?.timedOutJobs) failures.push(`${queueResult.timedOutJobs} benchmark job(s) did not reach a terminal state`);

const report = {
  generatedAt: new Date().toISOString(),
  target: baseUrl,
  settings: { iterations, concurrency, enqueueEnabled },
  checks,
  queue: queueResult,
  thresholds,
  passed: failures.length === 0,
  failures
};
console.log(JSON.stringify(report, null, 2));
if (enforce && failures.length) process.exitCode = 1;
