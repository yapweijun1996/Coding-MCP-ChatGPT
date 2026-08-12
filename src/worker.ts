import { randomUUID } from "node:crypto";
import os from "node:os";
import { config } from "./config.js";
import {
  claimNextPersistedJob,
  closeJobDatabase,
  getPersistedJob,
  getPersistedQueueDepth,
  initializeJobDatabase,
  isJobDatabaseEnabled,
  recoverExpiredPersistedJobs,
  renewPersistedJobLease,
  type ClaimedPersistedJob,
  type JobQueueLimits
} from "./jobs/database.js";
import {
  attachJobLease,
  clearJobLease,
  flushJobPersistence,
  getJob,
  initializeJobStore,
  replaceJobsFromPersistentStore,
  updateJob
} from "./jobs/store.js";
import { runQueuedJob } from "./mcp/tools/async-jobs.js";
import type { ToolContext } from "./mcp/types.js";
import { initializeSkillState } from "./skills/state.js";
import { initializeToolState } from "./tool-state.js";
import { initializeTelemetry } from "./telemetry/store.js";
import { initializeUserStore, getProjectRootForUser, getPublicShareBasePathForUser, getUserById, getWorkspaceRootForUser } from "./user-store.js";
import { configureStoragePolicy } from "./storage/manager.js";
import { recordActivity } from "./activity.js";

const workerId = `worker_${os.hostname()}_${process.pid}_${randomUUID()}`;
const activeControllers = new Map<string, AbortController>();
const activeTasks = new Set<Promise<void>>();
const loopController = new AbortController();
let stopping = false;

const queueLimits: JobQueueLimits = {
  classConcurrency: {
    browser: config.jobQueue.browserConcurrency,
    build: config.jobQueue.buildConcurrency,
    audio: config.jobQueue.audioConcurrency
  },
  maxConcurrentPerUser: config.jobQueue.maxConcurrentPerUser
};

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function contextForJob(job: { ownerUserId?: string; sourceToolName?: string; sourceArgs?: Record<string, unknown>; clientId?: string }, abortSignal: AbortSignal): Promise<ToolContext> {
  if (!job.sourceToolName || !job.sourceArgs) throw new Error("Queued job has no executable source metadata.");
  if (!job.ownerUserId) {
    return {
      publicBaseUrl: config.publicBaseUrl, contentBaseUrl: config.contentBaseUrl,
      workspaceRoot: config.workspaceRoot, commandTimeoutMs: config.commandTimeoutMs,
      shareRoot: config.shareRoot, artifactRoot: config.artifactRoot, feedbackRoot: config.feedbackRoot,
      projectRoot: config.projectRoot, clientId: "job-worker", storagePolicy: config.storagePolicy,
      conversationFileMaxBytes: config.conversationFileMaxBytes, fileTransferTimeoutMs: config.fileTransferTimeoutMs,
      abortSignal
    };
  }
  const user = await getUserById(job.ownerUserId);
  if (!user || user.status !== "active") throw new Error("Job owner is unavailable or inactive.");
  return {
    publicBaseUrl: config.publicBaseUrl, contentBaseUrl: config.contentBaseUrl,
    workspaceRoot: await getWorkspaceRootForUser(user.id), commandTimeoutMs: config.commandTimeoutMs,
    shareRoot: config.shareRoot, artifactRoot: config.artifactRoot, feedbackRoot: config.feedbackRoot,
    projectRoot: await getProjectRootForUser(user.id), clientId: "job-worker", userId: user.id,
    publicShareBasePath: getPublicShareBasePathForUser(user), storagePolicy: config.storagePolicy,
    conversationFileMaxBytes: config.conversationFileMaxBytes, fileTransferTimeoutMs: config.fileTransferTimeoutMs,
    abortSignal
  };
}

async function refreshAfterLostLease(jobId: string, controller: AbortController): Promise<void> {
  const persisted = await getPersistedJob(jobId).catch(() => undefined);
  if (persisted) replaceJobsFromPersistentStore([persisted]);
  if (!controller.signal.aborted) controller.abort(new Error("Job lease was lost or the job was cancelled."));
}

async function executeClaim(claimed: ClaimedPersistedJob): Promise<void> {
  const { job, leaseToken } = claimed;
  const queueDepthAtClaim = getPersistedQueueDepth().catch(() => undefined);
  const controller = new AbortController();
  activeControllers.set(job.id, controller);
  replaceJobsFromPersistentStore([job]);
  attachJobLease(job.id, leaseToken);
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || controller.signal.aborted) return;
    heartbeatBusy = true;
    void renewPersistedJobLease(job.id, leaseToken, config.jobQueue.leaseMs)
      .then((renewed) => renewed ? undefined : refreshAfterLostLease(job.id, controller))
      .catch((error) => {
        console.error(`Job ${job.id} heartbeat failed:`, error instanceof Error ? error.message : error);
      })
      .finally(() => { heartbeatBusy = false; });
  }, config.jobQueue.heartbeatMs);
  heartbeat.unref();
  let finalizationError: unknown;

  try {
    const ctx = await contextForJob(job, controller.signal);
    await runQueuedJob(job.id, job.sourceToolName!, job.sourceArgs!, ctx, job.timeoutMs, controller.signal);
  } catch (error) {
    const now = new Date().toISOString();
    updateJob(job.id, {
      status: controller.signal.aborted ? "cancelled" : "error",
      summary: `${job.title} failed in worker.`,
      errors: [error instanceof Error ? error.message : "Worker execution failed."],
      completedAt: now,
      ...(controller.signal.aborted ? { cancelledAt: now } : {})
    });
  } finally {
    clearInterval(heartbeat);
    try {
      await flushJobPersistence(job.id);
    } catch (error) {
      const authoritative = await getPersistedJob(job.id).catch(() => undefined);
      if (!authoritative || authoritative.status === "running") finalizationError = error;
      else replaceJobsFromPersistentStore([authoritative]);
    } finally {
      clearJobLease(job.id);
      activeControllers.delete(job.id);
    }
  }
  if (finalizationError) throw finalizationError;

  const persisted = await getPersistedJob(job.id).catch(() => undefined);
  if (persisted) replaceJobsFromPersistentStore([persisted]);
  const completed = persisted ?? getJob(job.id);
  if (!completed || completed.status === "running" || completed.status === "created") return;
  const startedMs = Date.parse(completed.startedAt ?? completed.updatedAt);
  const createdMs = Date.parse(completed.createdAt);
  const finishedMs = Date.parse(completed.completedAt ?? completed.updatedAt);
  recordActivity({
    clientId: "job-worker", userId: completed.ownerUserId, method: "tools/call", toolName: completed.sourceToolName,
    ok: completed.status === "success", summary: completed.summary,
    durationMs: Number.isFinite(finishedMs - createdMs) ? Math.max(0, finishedMs - createdMs) : undefined,
    queueWaitMs: Number.isFinite(startedMs - createdMs) ? Math.max(0, startedMs - createdMs) : undefined,
    executionMs: Number.isFinite(finishedMs - startedMs) ? Math.max(0, finishedMs - startedMs) : undefined,
    queueDepth: await queueDepthAtClaim,
    errorMessage: completed.errors.join("; ") || undefined
  });
}

function trackClaim(claimed: ClaimedPersistedJob): void {
  const task = executeClaim(claimed)
    .catch((error) => console.error(`Job ${claimed.job.id} execution failed:`, error instanceof Error ? error.message : error))
    .finally(() => activeTasks.delete(task));
  activeTasks.add(task);
}

async function waitForCapacityOrPoll(): Promise<void> {
  if (activeTasks.size >= config.jobQueue.workerConcurrency) {
    await Promise.race(activeTasks);
    return;
  }
  await delay(config.jobQueue.pollMs, loopController.signal);
}

async function runLoop(): Promise<void> {
  let nextRecoveryAt = 0;
  while (!stopping) {
    if (Date.now() >= nextRecoveryAt) {
      const recovered = await recoverExpiredPersistedJobs();
      if (recovered) console.log(`Requeued ${recovered} expired job lease(s).`);
      // Recovery is global work: every worker may perform it, so polling at the much
      // faster heartbeat cadence creates avoidable write pressure as the fleet grows.
      nextRecoveryAt = Date.now() + Math.max(Math.floor(config.jobQueue.leaseMs / 2), 5000);
    }

    let claimedAny = false;
    while (!stopping && activeTasks.size < config.jobQueue.workerConcurrency) {
      const claimed = await claimNextPersistedJob({ workerId, leaseMs: config.jobQueue.leaseMs, limits: queueLimits });
      if (!claimed) break;
      claimedAny = true;
      trackClaim(claimed);
    }
    if (!claimedAny || activeTasks.size >= config.jobQueue.workerConcurrency) await waitForCapacityOrPoll();
  }
}

function requestShutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`Received ${signal}; worker stopped claiming new jobs.`);
  loopController.abort();
}

async function main(): Promise<void> {
  if (config.jobQueue.heartbeatMs >= config.jobQueue.leaseMs) {
    throw new Error("JOB_HEARTBEAT_MS must be lower than JOB_LEASE_MS.");
  }
  configureStoragePolicy(config.storagePolicy ?? { projectQuotaBytes: 0, userQuotaBytes: 0, globalQuotaBytes: 0, warningThreshold: 0.8, deletedProjectRetentionDays: 7, monitorIntervalMs: 0 });
  initializeSkillState(config.skillStatePath);
  initializeToolState(config.toolStatePath);
  initializeTelemetry(config.telemetryRoot);
  initializeJobStore("");
  await initializeUserStore({ databaseUrl: process.env.DATABASE_URL, statePath: config.userStatePath, projectRoot: config.projectRoot, usersRoot: config.usersRoot, adminEmail: process.env.ADMIN_EMAIL, adminPassword: process.env.ADMIN_PASSWORD, fallbackAdminPasscode: config.adminPasscode, sessionTtlMs: 8 * 60 * 60 * 1000 });
  if (!await initializeJobDatabase(process.env.DATABASE_URL) || !isJobDatabaseEnabled()) {
    console.error("Job worker requires DATABASE_URL; exiting without processing jobs.");
    return;
  }

  process.on("SIGTERM", () => requestShutdown("SIGTERM"));
  process.on("SIGINT", () => requestShutdown("SIGINT"));
  const recovered = await recoverExpiredPersistedJobs();
  if (recovered) console.log(`Requeued ${recovered} expired job lease(s).`);
  console.log(`MCP job worker started (${workerId}, concurrency=${config.jobQueue.workerConcurrency}).`);
  await runLoop();

  const drained = Promise.allSettled([...activeTasks]);
  await Promise.race([drained, delay(config.jobQueue.shutdownGraceMs)]);
  if (activeTasks.size) {
    console.warn(`Worker shutdown grace expired with ${activeTasks.size} active job(s); aborting local execution and leaving leases to expire.`);
    for (const controller of activeControllers.values()) controller.abort(new Error("Worker shutdown grace expired."));
    await Promise.race([Promise.allSettled([...activeTasks]), delay(1000)]);
  }
  await closeJobDatabase();
}

void main().catch((error) => {
  console.error("MCP job worker failed:", error);
  process.exitCode = 1;
});
