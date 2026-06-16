export type JobStatus = "created" | "success" | "error";

export interface JobRecord {
  id: string;
  status: JobStatus;
  title: string;
  summary: string;
  logs: string[];
  artifacts: string[];
  errors: string[];
  createdAt: string;
  updatedAt: string;
}

const jobs = new Map<string, JobRecord>();

export function saveJob(job: JobRecord): JobRecord {
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
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
  return next;
}
