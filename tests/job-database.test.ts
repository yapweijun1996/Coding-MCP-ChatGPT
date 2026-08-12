import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  cancelPersistedJobForOwner,
  claimNextPersistedJob,
  closeJobDatabase,
  getPersistedJob,
  initializeJobDatabase,
  listPersistedJobChanges,
  persistJobSnapshot,
  recoverExpiredPersistedJobs,
  renewPersistedJobLease
} from "../src/jobs/database.js";
import type { JobExecutionClass, JobRecord } from "../src/jobs/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

function fixture(id: string, ownerUserId: string, executionClass: JobExecutionClass, createdOffsetMs = 0): JobRecord {
  const createdAt = new Date(Date.now() + createdOffsetMs).toISOString();
  return {
    id,
    status: "created",
    ownerUserId,
    title: "run_project_build",
    summary: "queued",
    logs: [],
    artifacts: [],
    errors: [],
    sourceToolName: "run_project_build",
    sourceArgs: { projectId: "project_fixture" },
    executionClass,
    revision: 1,
    createdAt,
    updatedAt: createdAt
  };
}

test("PostgreSQL queue fences stale writes, enforces distributed limits, cancels leases, and recovers expiry", { skip: !databaseUrl }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    assert.equal(await initializeJobDatabase(databaseUrl), true);
    await client.query("delete from mcp_jobs");

    const staleTarget = fixture("job_revision", "user_revision", "build", -1000);
    assert.equal(await persistJobSnapshot(staleTarget), true);
    const terminal: JobRecord = {
      ...staleTarget,
      status: "success",
      summary: "done",
      revision: 2,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    assert.equal(await persistJobSnapshot(terminal), true);
    assert.equal(await persistJobSnapshot(staleTarget), false, "a delayed lower revision must be rejected");
    assert.equal((await getPersistedJob(staleTarget.id))?.status, "success");

    const queued = [
      fixture("job_a1", "user_a", "browser", 0),
      fixture("job_a2", "user_a", "browser", 1),
      fixture("job_b1", "user_b", "build", 2),
      fixture("job_c1", "user_c", "browser", 3)
    ];
    for (const job of queued) assert.equal(await persistJobSnapshot(job), true);
    const limits = { classConcurrency: { browser: 2, build: 2, audio: 1 }, maxConcurrentPerUser: 1 } as const;
    const first = await claimNextPersistedJob({ workerId: "worker_one", leaseMs: 30_000, limits });
    assert.equal(first?.job.id, "job_a1");
    const second = await claimNextPersistedJob({ workerId: "worker_two", leaseMs: 30_000, limits });
    assert.equal(second?.job.id, "job_b1", "same-user work is skipped while its first lease is active");
    const third = await claimNextPersistedJob({ workerId: "worker_three", leaseMs: 30_000, limits });
    assert.equal(third?.job.id, "job_c1", "a second browser slot may be used by another user");
    assert.equal(await claimNextPersistedJob({ workerId: "worker_four", leaseMs: 30_000, limits }), undefined);

    const cancelled = await cancelPersistedJobForOwner(first!.job.id, "user_a", "test cancellation");
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(await renewPersistedJobLease(first!.job.id, first!.leaseToken, 30_000), false, "cancel clears and fences the worker lease");
    const replacement = await claimNextPersistedJob({ workerId: "worker_four", leaseMs: 10, limits });
    assert.equal(replacement?.job.id, "job_a2", "cancellation releases the per-user reservation");

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await recoverExpiredPersistedJobs(), 1);
    assert.equal((await getPersistedJob("job_a2"))?.status, "created");

    const changes = await listPersistedJobChanges(0, 100);
    assert.ok(changes.cursor > 0);
    assert.ok(changes.jobs.some((job) => job.id === "job_a2" && job.status === "created"));
  } finally {
    await closeJobDatabase();
    await client.query("delete from mcp_jobs").catch(() => undefined);
    await client.end();
  }
});
