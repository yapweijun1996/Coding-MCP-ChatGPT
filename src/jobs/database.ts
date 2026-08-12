import { randomUUID } from "node:crypto";
import pg from "pg";
import type { JobExecutionClass, JobRecord, JobStatus } from "./store.js";

let pool: pg.Pool | undefined;

export interface JobQueueLimits {
  classConcurrency: Record<JobExecutionClass, number>;
  maxConcurrentPerUser: number;
}

export interface ClaimedPersistedJob {
  job: JobRecord;
  leaseToken: string;
}

export interface PersistedJobPage {
  jobs: JobRecord[];
  cursor: number;
}

function isJobRecord(value: unknown): value is JobRecord {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as { id?: unknown }).id === "string"
    && typeof (value as { status?: unknown }).status === "string";
}

function recordsFromRows(rows: Array<{ payload: unknown }>): JobRecord[] {
  return rows.map((row) => row.payload).filter(isJobRecord);
}

function executionClassFor(job: JobRecord): JobExecutionClass {
  return job.executionClass ?? "build";
}

function revisionFor(job: JobRecord): number {
  return Number.isSafeInteger(job.revision) && (job.revision ?? 0) > 0 ? job.revision! : 1;
}

export async function initializeJobDatabase(databaseUrl: string | undefined): Promise<boolean> {
  if (!databaseUrl) return false;
  if (pool) return true;
  const nextPool = new pg.Pool({ connectionString: databaseUrl });
  nextPool.on("error", (error) => console.error("Job queue Postgres pool error:", error));
  const client = await nextPool.connect().catch(async (error) => {
    await nextPool.end().catch(() => undefined);
    throw error;
  });
  try {
    await client.query("select pg_advisory_lock(hashtextextended('coding-mcp-job-schema', 0))");
    await client.query(`
      create sequence if not exists mcp_jobs_change_seq;
      create table if not exists mcp_jobs (
        id text primary key,
        status text not null,
        owner_user_id text,
        source_tool_name text,
        execution_class text not null default 'build',
        payload jsonb not null,
        revision bigint not null default 1,
        change_id bigint not null default nextval('mcp_jobs_change_seq'),
        lease_owner text,
        lease_token text,
        lease_expires_at timestamptz,
        heartbeat_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
      alter table mcp_jobs add column if not exists execution_class text not null default 'build';
      alter table mcp_jobs add column if not exists revision bigint not null default 1;
      alter table mcp_jobs add column if not exists change_id bigint not null default nextval('mcp_jobs_change_seq');
      alter table mcp_jobs add column if not exists lease_owner text;
      alter table mcp_jobs add column if not exists lease_token text;
      alter table mcp_jobs add column if not exists lease_expires_at timestamptz;
      alter table mcp_jobs add column if not exists heartbeat_at timestamptz;
      update mcp_jobs set execution_class = case
        when source_tool_name in ('render_midi_with_soundfont', 'render_production_music', 'create_music_production') then 'audio'
        when source_tool_name in ('record_project_workspace_video', 'capture_webpage', 'inspect_project_workspace', 'screenshot_project', 'analyze_webpage_visual', 'deliver_static_project') then 'browser'
        else 'build'
      end
      where payload->>'executionClass' is null;
      update mcp_jobs set payload = jsonb_set(payload, '{executionClass}', to_jsonb(execution_class))
      where payload->>'executionClass' is null;
      -- Use a new name because older deployments already created
      -- mcp_jobs_pending_idx with a different, non-partial definition. Keeping the old
      -- index is harmless; this index is the one the durable claim path is designed for.
      create index if not exists mcp_jobs_created_queue_idx on mcp_jobs (created_at) where status = 'created';
      create index if not exists mcp_jobs_active_limits_idx on mcp_jobs (execution_class, owner_user_id, lease_expires_at) where status = 'running';
      create index if not exists mcp_jobs_owner_idx on mcp_jobs (owner_user_id, updated_at desc);
      create index if not exists mcp_jobs_change_idx on mcp_jobs (change_id);
      create index if not exists mcp_jobs_retention_idx on mcp_jobs (updated_at) where status in ('success', 'error', 'cancelled', 'timeout');
    `);
    pool = nextPool;
    return true;
  } catch (error) {
    void nextPool.end().catch(() => undefined);
    console.error("Job queue Postgres is unavailable; using local file queue:", error instanceof Error ? error.message : error);
    return false;
  } finally {
    await client.query("select pg_advisory_unlock(hashtextextended('coding-mcp-job-schema', 0))").catch(() => undefined);
    client.release();
  }
}

export async function closeJobDatabase(): Promise<void> {
  const current = pool;
  pool = undefined;
  if (current) await current.end();
}

export function isJobDatabaseEnabled(): boolean {
  return Boolean(pool);
}

/**
 * Persist one monotonic snapshot. The revision predicate is the cross-process
 * ordering guarantee: a delayed `created` write can never replace `running` or
 * a terminal result. Worker writes are additionally fenced by their lease token.
 */
export async function persistJobSnapshot(job: JobRecord, leaseToken?: string): Promise<boolean> {
  if (!pool) return false;
  const revision = revisionFor(job);
  const terminal = ["success", "error", "cancelled", "timeout"].includes(job.status);
  if (leaseToken) {
    const result = await pool.query(
      `update mcp_jobs set
         status = $2, owner_user_id = $3, source_tool_name = $4,
         execution_class = $5, payload = $6::jsonb, revision = $7,
         change_id = nextval('mcp_jobs_change_seq'), updated_at = now(),
         lease_owner = case when $8::boolean then null else lease_owner end,
         lease_token = case when $8::boolean then null else lease_token end,
         lease_expires_at = case when $8::boolean then null else lease_expires_at end,
         heartbeat_at = case when $8::boolean then null else heartbeat_at end
       where id = $1 and status = 'running' and lease_token = $9 and revision < $7
       returning id`,
      [job.id, job.status, job.ownerUserId ?? null, job.sourceToolName ?? null, executionClassFor(job), JSON.stringify(job), revision, terminal, leaseToken]
    );
    return (result.rowCount ?? 0) === 1;
  }

  const result = await pool.query(
    `insert into mcp_jobs (
       id, status, owner_user_id, source_tool_name, execution_class, payload,
       revision, change_id, created_at, updated_at
     ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, nextval('mcp_jobs_change_seq'), $8::timestamptz, now())
     on conflict (id) do update set
       status = excluded.status, owner_user_id = excluded.owner_user_id,
       source_tool_name = excluded.source_tool_name, execution_class = excluded.execution_class,
       payload = excluded.payload, revision = excluded.revision,
       change_id = nextval('mcp_jobs_change_seq'), updated_at = now()
     where mcp_jobs.revision < excluded.revision
     returning id`,
    [job.id, job.status, job.ownerUserId ?? null, job.sourceToolName ?? null, executionClassFor(job), JSON.stringify(job), revision, job.createdAt]
  );
  return (result.rowCount ?? 0) === 1;
}

export async function getPersistedJob(id: string): Promise<JobRecord | undefined> {
  if (!pool) return undefined;
  const result = await pool.query<{ payload: unknown }>("select payload from mcp_jobs where id = $1", [id]);
  const payload = result.rows[0]?.payload;
  return isJobRecord(payload) ? payload : undefined;
}

export async function getPersistedJobForOwner(id: string, ownerUserId: string | undefined): Promise<JobRecord | undefined> {
  if (!pool) return undefined;
  const result = await pool.query<{ payload: unknown }>(
    "select payload from mcp_jobs where id = $1 and owner_user_id is not distinct from $2",
    [id, ownerUserId ?? null]
  );
  const payload = result.rows[0]?.payload;
  return isJobRecord(payload) ? payload : undefined;
}

export async function listPersistedJobsForOwner(
  ownerUserId: string | undefined,
  options: { status?: JobStatus; sourceToolName?: string; limit?: number } = {}
): Promise<JobRecord[]> {
  if (!pool) return [];
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const result = await pool.query<{ payload: unknown }>(
    `select payload from mcp_jobs
     where owner_user_id is not distinct from $1
       and ($2::text is null or status = $2)
       and ($3::text is null or source_tool_name = $3 or payload->>'title' = $3)
     order by updated_at desc limit $4`,
    [ownerUserId ?? null, options.status ?? null, options.sourceToolName ?? null, limit]
  );
  return recordsFromRows(result.rows);
}

export async function listRecentPersistedJobs(limit = 1000): Promise<PersistedJobPage> {
  if (!pool) return { jobs: [], cursor: 0 };
  const boundedLimit = Math.max(1, Math.min(5000, limit));
  const result = await pool.query<{ payload: unknown; cursor: string | number }>(`
    with snapshot as (select coalesce(max(change_id), 0) as cursor from mcp_jobs),
    recent as (select payload from mcp_jobs order by updated_at desc limit $1)
    select recent.payload, snapshot.cursor from recent cross join snapshot
  `, [boundedLimit]);
  return {
    jobs: recordsFromRows(result.rows),
    cursor: Number(result.rows[0]?.cursor ?? 0)
  };
}

export async function listPersistedJobChanges(afterCursor: number, limit = 1000): Promise<PersistedJobPage> {
  if (!pool) return { jobs: [], cursor: afterCursor };
  const boundedLimit = Math.max(1, Math.min(5000, limit));
  const result = await pool.query<{ payload: unknown; change_id: string | number }>(
    "select payload, change_id from mcp_jobs where change_id > $1 order by change_id limit $2",
    [Math.max(0, afterCursor), boundedLimit]
  );
  return {
    jobs: recordsFromRows(result.rows),
    cursor: result.rows.length ? Number(result.rows.at(-1)!.change_id) : afterCursor
  };
}

export async function getPersistedQueueDepth(): Promise<number> {
  if (!pool) return 0;
  const result = await pool.query<{ depth: string | number }>(
    "select count(*) as depth from mcp_jobs where status = 'created'"
  );
  return Number(result.rows[0]?.depth ?? 0);
}

// The advisory transaction lock makes the class/user capacity check and claim one
// serial scheduling decision across every worker process. SKIP LOCKED still avoids
// waiting on unrelated job-row updates.
export async function claimNextPersistedJob(input: {
  workerId: string;
  leaseMs: number;
  limits: JobQueueLimits;
}): Promise<ClaimedPersistedJob | undefined> {
  if (!pool) return undefined;
  const leaseToken = randomUUID();
  const result = await pool.query<{ payload: unknown }>(`
    with scheduler_lock as materialized (
      select pg_advisory_xact_lock(hashtextextended('coding-mcp-job-scheduler', 0))
    ), next_job as (
      select j.id
      from mcp_jobs j cross join scheduler_lock
      where j.status = 'created'
        and (
          select count(*) from mcp_jobs active
          where active.status = 'running'
            and active.lease_expires_at > now()
            and active.execution_class = j.execution_class
        ) < case j.execution_class
          when 'browser' then $1::bigint
          when 'audio' then $2::bigint
          else $3::bigint
        end
        and (
          select count(*) from mcp_jobs active
          where active.status = 'running'
            and active.lease_expires_at > now()
            and active.owner_user_id is not distinct from j.owner_user_id
        ) < $4::bigint
      order by j.created_at
      for update of j skip locked
      limit 1
    )
    update mcp_jobs j set
      status = 'running',
      payload = jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(j.payload, '{status}', '"running"'::jsonb),
              '{executionClass}', to_jsonb(j.execution_class)
            ),
            '{updatedAt}', to_jsonb(now()::text)
          ),
          '{startedAt}', to_jsonb(now()::text)
        ),
        '{revision}', to_jsonb(j.revision + 1)
      ),
      revision = j.revision + 1,
      change_id = nextval('mcp_jobs_change_seq'),
      lease_owner = $5,
      lease_token = $6,
      lease_expires_at = now() + ($7::bigint * interval '1 millisecond'),
      heartbeat_at = now(),
      updated_at = now()
    from next_job where j.id = next_job.id
    returning j.payload
  `, [
    input.limits.classConcurrency.browser,
    input.limits.classConcurrency.audio,
    input.limits.classConcurrency.build,
    input.limits.maxConcurrentPerUser,
    input.workerId,
    leaseToken,
    input.leaseMs
  ]);
  const payload = result.rows[0]?.payload;
  return isJobRecord(payload) ? { job: payload, leaseToken } : undefined;
}

export async function renewPersistedJobLease(jobId: string, leaseToken: string, leaseMs: number): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query(
    `update mcp_jobs set lease_expires_at = now() + ($3::bigint * interval '1 millisecond'), heartbeat_at = now()
     where id = $1 and status = 'running' and lease_token = $2`,
    [jobId, leaseToken, leaseMs]
  );
  return (result.rowCount ?? 0) === 1;
}

export async function recoverExpiredPersistedJobs(): Promise<number> {
  if (!pool) return 0;
  const result = await pool.query(`
    update mcp_jobs set
      status = 'created',
      payload = jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(payload - 'startedAt', '{status}', '"created"'::jsonb),
            '{stage}', '"queued"'::jsonb
          ),
          '{updatedAt}', to_jsonb(now()::text)
        ),
        '{revision}', to_jsonb(revision + 1)
      ),
      revision = revision + 1,
      change_id = nextval('mcp_jobs_change_seq'),
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      heartbeat_at = null,
      updated_at = now()
    where status = 'running' and (lease_expires_at is null or lease_expires_at <= now())
  `);
  return result.rowCount ?? 0;
}

export async function cancelPersistedJobForOwner(
  id: string,
  ownerUserId: string | undefined,
  reason: string
): Promise<JobRecord | undefined> {
  if (!pool) return undefined;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const selected = await client.query<{ payload: unknown; revision: string | number }>(
      "select payload, revision from mcp_jobs where id = $1 and owner_user_id is not distinct from $2 for update",
      [id, ownerUserId ?? null]
    );
    const payload = selected.rows[0]?.payload;
    if (!isJobRecord(payload)) {
      await client.query("rollback");
      return undefined;
    }
    if (["success", "error", "cancelled", "timeout"].includes(payload.status)) {
      await client.query("commit");
      return payload;
    }
    const now = new Date().toISOString();
    const next: JobRecord = {
      ...payload,
      status: "cancelled",
      stage: payload.estimatedWorkload?.kind === "music_render" ? "cancelled" : payload.stage,
      summary: reason,
      errors: [...(payload.errors ?? []), reason],
      cancelledAt: now,
      completedAt: now,
      updatedAt: now,
      revision: Number(selected.rows[0]!.revision) + 1
    };
    await client.query(
      `update mcp_jobs set status = 'cancelled', payload = $2::jsonb, revision = $3,
         change_id = nextval('mcp_jobs_change_seq'), lease_owner = null, lease_token = null,
         lease_expires_at = null, heartbeat_at = null, updated_at = now()
       where id = $1`,
      [id, JSON.stringify(next), next.revision]
    );
    await client.query("commit");
    return next;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function prunePersistedJobs(retentionDays: number): Promise<number> {
  if (!pool || retentionDays <= 0) return 0;
  const result = await pool.query(
    `delete from mcp_jobs
     where status in ('success', 'error', 'cancelled', 'timeout')
       and updated_at < now() - ($1::integer * interval '1 day')`,
    [retentionDays]
  );
  return result.rowCount ?? 0;
}
