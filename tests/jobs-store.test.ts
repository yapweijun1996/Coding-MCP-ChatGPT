import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cancelJob, initializeJobStore, listJobs, saveJob, getJob, updateJob, type JobRecord } from "../src/jobs/store.js";

function job(id: string, status: JobRecord["status"]): JobRecord {
  // Use a current timestamp so fixtures stay inside the default retention window. A hardcoded date
  // turned these tests into a time bomb: once wall-clock passed retentionDays (7) beyond it,
  // initializeJobStore pruned the fixture before the behavior under test (reconcile / survive) ran.
  // Tests that exercise pruning override updatedAt explicitly, so a fresh default is safe.
  const now = new Date().toISOString();
  return { id, status, title: "run_project_build", summary: "x", logs: [], artifacts: [], errors: [], createdAt: now, updatedAt: now };
}

test("saveJob persists to disk and updateJob rewrites the file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jobs-"));
  try {
    initializeJobStore(root);
    saveJob(job("job_persist_1", "running"));
    const files = await readdir(root);
    assert.ok(files.includes("job_persist_1.json"), "job file written");
    updateJob("job_persist_1", { status: "success", summary: "done" });
    const onDisk = JSON.parse(await readFile(path.join(root, "job_persist_1.json"), "utf8")) as JobRecord;
    assert.equal(onDisk.status, "success");
    assert.equal(onDisk.summary, "done");
  } finally {
    initializeJobStore("");
    await rm(root, { recursive: true, force: true });
  }
});

test("a persisted running job is reconciled to error on restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jobs-"));
  try {
    // Simulate a job file left behind by a previous process that died mid-run.
    await writeFile(path.join(root, "job_orphan.json"), JSON.stringify(job("job_orphan", "running")));
    initializeJobStore(root); // == server restart loading persisted jobs
    const reloaded = getJob("job_orphan");
    assert.ok(reloaded);
    assert.equal(reloaded!.status, "error");
    assert.match(reloaded!.summary, /interrupted by a server restart/);
    // And the reconciliation is itself persisted.
    const onDisk = JSON.parse(await readFile(path.join(root, "job_orphan.json"), "utf8")) as JobRecord;
    assert.equal(onDisk.status, "error");
  } finally {
    initializeJobStore("");
    await rm(root, { recursive: true, force: true });
  }
});

test("a persisted finished job survives restart unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jobs-"));
  try {
    await writeFile(path.join(root, "job_done.json"), JSON.stringify({ ...job("job_done", "success"), summary: "kept" }));
    initializeJobStore(root);
    const reloaded = getJob("job_done");
    assert.ok(reloaded);
    assert.equal(reloaded!.status, "success");
    assert.equal(reloaded!.summary, "kept");
  } finally {
    initializeJobStore("");
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeJobStore prunes job files older than the retention window", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jobs-"));
  try {
    const old = { ...job("job_old", "success"), updatedAt: "2020-01-01T00:00:00.000Z" };
    const fresh = { ...job("job_fresh", "success"), updatedAt: new Date().toISOString() };
    await writeFile(path.join(root, "job_old.json"), JSON.stringify(old));
    await writeFile(path.join(root, "job_fresh.json"), JSON.stringify(fresh));
    initializeJobStore(root, 7); // prune anything older than 7 days
    assert.equal(getJob("job_old"), undefined, "stale job pruned from memory");
    assert.ok(getJob("job_fresh"), "recent job retained");
    const remaining = await readdir(root);
    assert.ok(!remaining.includes("job_old.json"), "stale job file deleted");
    assert.ok(remaining.includes("job_fresh.json"), "recent job file kept");
  } finally {
    initializeJobStore("");
    await rm(root, { recursive: true, force: true });
  }
});

test("retentionDays <= 0 disables pruning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jobs-"));
  try {
    await writeFile(path.join(root, "job_ancient.json"), JSON.stringify({ ...job("job_ancient", "success"), updatedAt: "2000-01-01T00:00:00.000Z" }));
    initializeJobStore(root, 0);
    assert.ok(getJob("job_ancient"), "pruning disabled keeps old jobs");
  } finally {
    initializeJobStore("");
    await rm(root, { recursive: true, force: true });
  }
});

test("getJob is undefined when jobsRoot is unset and id is unknown", () => {
  initializeJobStore("");
  assert.equal(getJob("never-seen-id"), undefined);
});

test("listJobs and cancelJob expose queue control state", () => {
  initializeJobStore("");
  const running = saveJob({ ...job("job_cancel_me", "running"), sourceToolName: "run_project_build", sourceArgs: {} });
  saveJob(job("job_done_for_list", "success"));

  const runningJobs = listJobs({ status: "running", limit: 10 });
  assert.equal(runningJobs.some((item) => item.id === running.id), true);

  const cancelled = cancelJob(running.id, "No longer needed.");
  assert.ok(cancelled);
  assert.equal(cancelled!.status, "cancelled");
  assert.equal(cancelled!.errors.includes("No longer needed."), true);

  const secondCancel = cancelJob(running.id, "again");
  assert.equal(secondCancel!.status, "cancelled");
});
