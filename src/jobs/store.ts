import path from "node:path";
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { atomicWriteSync } from "../shared/atomic-write.js";

export type JobStatus = "created" | "running" | "success" | "error" | "cancelled" | "timeout";

export interface JobRecord {
  id: string;
  status: JobStatus;
  // The tenant (OAuth-bound userId) that created the job. undefined only for the shared
  // legacy/dev-token domain. Job tools authorize by exact match against ctx.userId so one
  // tenant cannot read, cancel, or re-execute another tenant's jobs. Jobs persisted before
  // this field existed load as undefined — a safe (deny) default for real users.
  ownerUserId?: string;
  title: string;
  summary: string;
  logs: string[];
  artifacts: string[];
  errors: string[];
  createdAt: string;
  updatedAt: string;
  sourceToolName?: string;
  sourceArgs?: Record<string, unknown>;
  parentJobId?: string;
  attempt?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  cancelledAt?: string;
}

// In-memory index for fast reads, backed by one JSON file per job under jobsRoot. Writes are
// synchronous (atomicWriteSync) so the public API stays synchronous for its callers. When
// jobsRoot is unset (tests, or persistence disabled) the store behaves as pure in-memory.
const jobs = new Map<string, JobRecord>();
let jobsRoot = "";

function jobFilePath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(jobsRoot, `${safe}.json`);
}

function persist(job: JobRecord): void {
  if (!jobsRoot) return;
  try {
    mkdirSync(jobsRoot, { recursive: true });
    atomicWriteSync(jobFilePath(job.id), `${JSON.stringify(job, null, 2)}\n`);
  } catch (error) {
    // Persistence is best-effort: never break a tool call because the job file could not be
    // written. The in-memory record is still authoritative for this process.
    console.error(`Failed to persist job ${job.id}:`, error instanceof Error ? error.message : error);
  }
}

export function initializeJobStore(root: string, retentionDays = 7): void {
  jobsRoot = root;
  jobs.clear();
  let files: string[];
  try {
    files = readdirSync(jobsRoot).filter((file) => file.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Failed to read jobs from ${jobsRoot}:`, error instanceof Error ? error.message : error);
    }
    return;
  }
  // Retention: prune job files older than the window so the directory does not grow without
  // bound. Pruning runs at startup, which on this restart/rebuild-driven deployment happens
  // regularly. retentionDays <= 0 disables pruning (keep everything).
  const cutoff = retentionDays > 0 ? Date.now() - retentionDays * 24 * 60 * 60 * 1000 : Number.NEGATIVE_INFINITY;
  for (const file of files) {
    try {
      const job = JSON.parse(readFileSync(path.join(jobsRoot, file), "utf8")) as JobRecord;
      if (!job || typeof job.id !== "string") continue;
      const updatedAtMs = Date.parse(job.updatedAt);
      if (Number.isFinite(updatedAtMs) && updatedAtMs < cutoff) {
        unlinkSync(path.join(jobsRoot, file));
        continue;
      }
      if (job.status === "running" || job.status === "created") {
        // A job left "running" cannot survive a restart: the background execution that owned it
        // is gone with the previous process. Fail it explicitly so get_job_status reports a
        // terminal state instead of a permanent "running".
        const reconciled: JobRecord = {
          ...job,
          status: "error",
          summary: `${job.title} was interrupted by a server restart.`,
          errors: [...(job.errors ?? []), "Job did not finish before the server stopped; re-run it."],
          updatedAt: new Date().toISOString()
        };
        jobs.set(reconciled.id, reconciled);
        persist(reconciled);
      } else {
        jobs.set(job.id, job);
      }
    } catch (error) {
      console.error(`Skipping unreadable job file ${file}:`, error instanceof Error ? error.message : error);
    }
  }
}

export function saveJob(job: JobRecord): JobRecord {
  jobs.set(job.id, job);
  persist(job);
  return job;
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

export function listJobs(options: { status?: JobStatus; sourceToolName?: string; limit?: number } = {}): JobRecord[] {
  const limit = options.limit ?? 100;
  return [...jobs.values()]
    .filter((job) => !options.status || job.status === options.status)
    .filter((job) => !options.sourceToolName || job.sourceToolName === options.sourceToolName || job.title === options.sourceToolName)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

// Tenant-scoped listing for the user-facing job tools: filters to the caller's own jobs
// BEFORE applying the limit, so one tenant's jobs can never appear in another's results.
export function listJobsForOwner(ownerUserId: string | undefined, options: { status?: JobStatus; sourceToolName?: string; limit?: number } = {}): JobRecord[] {
  const limit = options.limit ?? 100;
  return [...jobs.values()]
    .filter((job) => job.ownerUserId === ownerUserId)
    .filter((job) => !options.status || job.status === options.status)
    .filter((job) => !options.sourceToolName || job.sourceToolName === options.sourceToolName || job.title === options.sourceToolName)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

export function countJobs(): number {
  return jobs.size;
}

export function updateJob(id: string, update: Partial<Omit<JobRecord, "id" | "createdAt">>): JobRecord | undefined {
  const existing = jobs.get(id);
  if (!existing) return undefined;

  const next: JobRecord = {
    ...existing,
    ...update,
    updatedAt: new Date().toISOString()
  };
  jobs.set(id, next);
  persist(next);
  return next;
}

export function cancelJob(id: string, reason = "Cancelled by request."): JobRecord | undefined {
  const existing = jobs.get(id);
  if (!existing) return undefined;
  if (["success", "error", "cancelled", "timeout"].includes(existing.status)) return existing;
  return updateJob(id, {
    status: "cancelled",
    summary: reason,
    cancelledAt: new Date().toISOString(),
    errors: [...existing.errors, reason]
  });
}
