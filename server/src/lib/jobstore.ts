import { randomUUID } from 'node:crypto';
import { db, type JobRow } from '../db.js';
import { keys, redis } from '../redis.js';
import { getSettings } from '../settings.js';
import { allGroupCounts, getQueue } from '../queue/queues.js';
import type { VerifyJobData } from '../queue/queues.js';
import { resolveGroup } from './providers.js';
import type {
  Category,
  JobCounts,
  JobStatus,
  JobStatusResponse,
  PrefilterReport,
  ProviderGroup,
  Reason,
  Settings,
} from '../types.js';
import { CATEGORIES, PROVIDER_GROUPS } from '../types.js';

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

const insertJob = db.prepare(`
  INSERT INTO jobs (id, upload_id, status, total, created_at, settings_json, prefilter_json)
  VALUES (@id, @upload_id, @status, @total, @created_at, @settings_json, @prefilter_json)
`);

const selectJob = db.prepare('SELECT * FROM jobs WHERE id = ?');
const selectJobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?');

export function createJob(args: {
  uploadId: string;
  total: number;
  settings: Settings;
  prefilter: PrefilterReport | null;
}): string {
  const id = randomUUID();
  insertJob.run({
    id,
    upload_id: args.uploadId,
    status: 'queued' satisfies JobStatus,
    total: args.total,
    created_at: Date.now(),
    settings_json: JSON.stringify(args.settings),
    prefilter_json: args.prefilter ? JSON.stringify(args.prefilter) : null,
  });
  return id;
}

export function getJob(id: string): JobRow | undefined {
  return selectJob.get(id) as JobRow | undefined;
}

export function listJobs(limit = 25): JobRow[] {
  return selectJobs.all(limit) as JobRow[];
}

export function setJobStatus(id: string, status: JobStatus): void {
  const now = Date.now();
  if (status === 'running') {
    db.prepare(
      "UPDATE jobs SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?",
    ).run(status, now, id);
  } else if (status === 'completed' || status === 'cancelled') {
    db.prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?').run(status, now, id);
  } else {
    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, id);
  }
}

// ---------------------------------------------------------------------------
// Enqueueing
// ---------------------------------------------------------------------------

/**
 * Resolves provider pools for every distinct domain in the upload, then bulk
 * adds one job per address to its pool's queue.
 *
 * MX resolution is per *domain*, bounded to 20 concurrent lookups: a 100k list
 * of Gmail addresses costs exactly one DNS query, and even a long-tail B2B list
 * usually resolves in a few seconds.
 */
export async function enqueueJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  // Distinct domains only: a 100k Gmail list is a single DNS query.
  const domains = (
    db
      .prepare('SELECT DISTINCT domain FROM candidates WHERE upload_id = ?')
      .all(job.upload_id) as Array<{ domain: string }>
  ).map((r) => r.domain);

  const groupByDomain = new Map<string, ProviderGroup>();

  const CONCURRENCY = 20;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, domains.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= domains.length) return;
        const d = domains[i]!;
        try {
          const res = await resolveGroup(d);
          groupByDomain.set(d, res.group);
        } catch {
          groupByDomain.set(d, 'other');
        }
      }
    }),
  );

  setJobStatus(jobId, 'running');
  await redis.del(keys.jobCancelled(jobId));

  // Buffer per pool, flushing in chunks so we never build a 100k-element array.
  const buffers = new Map<ProviderGroup, Array<{ name: string; data: VerifyJobData; opts: object }>>();
  const CHUNK = 1_000;

  const flush = async (group: ProviderGroup, force = false) => {
    const buf = buffers.get(group);
    if (!buf || buf.length === 0) return;
    if (!force && buf.length < CHUNK) return;
    await getQueue(group).addBulk(buf);
    buffers.set(group, []);
  };

  /**
   * Read the candidates in keyset-paginated pages rather than holding a
   * `.iterate()` cursor open.
   *
   * better-sqlite3 uses one synchronous connection: an open read cursor that
   * survives an `await` will collide with a worker writing a result on the same
   * connection ("This database connection is busy executing a query"). Paging
   * with `.all()` keeps every statement confined to a single tick while still
   * never materialising the whole list.
   */
  const page = db.prepare(
    `SELECT email, domain FROM candidates
     WHERE upload_id = ? AND email > ?
     ORDER BY email LIMIT ?`,
  );

  let after = '';
  for (;;) {
    const rows = page.all(job.upload_id, after, CHUNK) as Array<{
      email: string;
      domain: string;
    }>;
    if (rows.length === 0) break;

    for (const row of rows) {
      const group = groupByDomain.get(row.domain) ?? 'other';
      const data: VerifyJobData = {
        jobId,
        email: row.email,
        domain: row.domain,
        group,
        attempt: 1,
      };
      const list = buffers.get(group) ?? [];
      list.push({
        name: 'verify',
        data,
        // Deterministic id makes re-enqueueing the same job idempotent.
        opts: { jobId: `${jobId}:${row.email}:1` },
      });
      buffers.set(group, list);
    }

    after = rows[rows.length - 1]!.email;

    for (const group of PROVIDER_GROUPS) {
      await flush(group);
    }
  }

  for (const group of PROVIDER_GROUPS) {
    await flush(group, true);
  }
}

/** Re-enqueues one address after a temp-fail, with the configured backoff. */
export async function requeueWithBackoff(
  data: VerifyJobData,
  nextAttempt: number,
  delayMs: number,
): Promise<void> {
  await getQueue(data.group).add(
    'verify',
    { ...data, attempt: nextAttempt },
    { delay: delayMs, jobId: `${data.jobId}:${data.email}:${nextAttempt}` },
  );
}

// ---------------------------------------------------------------------------
// Results + counters
// ---------------------------------------------------------------------------

const insertResult = db.prepare(`
  INSERT OR IGNORE INTO results
    (job_id, email, domain, provider_group, category, reason, reacher_status,
     attempts, smtp_code, message, updated_at, raw_json)
  VALUES
    (@job_id, @email, @domain, @provider_group, @category, @reason, @reacher_status,
     @attempts, @smtp_code, @message, @updated_at, @raw_json)
`);

const updateResult = db.prepare(`
  UPDATE results SET
    category = @category,
    reason = @reason,
    reacher_status = @reacher_status,
    attempts = @attempts,
    smtp_code = @smtp_code,
    message = @message,
    updated_at = @updated_at,
    raw_json = @raw_json
  WHERE job_id = @job_id AND email = @email
`);

export interface RecordResultArgs {
  jobId: string;
  email: string;
  domain: string;
  group: ProviderGroup;
  category: Category;
  reason: Reason;
  reacherStatus: string | null;
  attempts: number;
  smtpCode: number | null;
  message: string | null;
  raw: unknown;
}

/**
 * Persists a terminal verdict and bumps the live counters.
 *
 * SQLite is the source of truth; the Redis hash exists purely so the 2s status
 * poll is O(1) instead of a GROUP BY over 100k rows.
 *
 * The insert-then-update split matters for correctness. If a worker dies
 * mid-check, BullMQ eventually reclaims the job as stalled and another worker
 * reprocesses it — so the same address can legitimately produce two results.
 * `INSERT OR IGNORE` tells us whether the row was genuinely new, and the
 * counters are only incremented in that case. A plain UPSERT would report
 * `changes === 1` either way and silently inflate the totals past the job size,
 * which would also stop `maybeComplete` from ever firing correctly.
 */
export async function recordResult(args: RecordResultArgs): Promise<void> {
  const params = {
    job_id: args.jobId,
    email: args.email,
    domain: args.domain,
    provider_group: args.group,
    category: args.category,
    reason: args.reason,
    reacher_status: args.reacherStatus,
    attempts: args.attempts,
    smtp_code: args.smtpCode,
    message: args.message ? args.message.slice(0, 1_000) : null,
    updated_at: Date.now(),
    raw_json: args.raw ? JSON.stringify(args.raw).slice(0, 8_000) : null,
  };

  const info = insertResult.run(params);
  const isNew = info.changes === 1;

  if (!isNew) {
    // Redelivery of an address we already scored. Keep the newer verdict but
    // leave the counters alone.
    updateResult.run(params);
    return;
  }

  try {
    await redis.hincrby(keys.jobCounts(args.jobId), args.category, 1);
    await redis.hincrby(keys.jobCounts(args.jobId), 'done', 1);
  } catch {
    // Counters are advisory; the dashboard reconciles from SQLite when the job
    // finishes.
  }
}

export async function incrTempFailEvents(jobId: string): Promise<void> {
  try {
    await redis.hincrby(keys.jobCounts(jobId), 'tempFailEvents', 1);
  } catch {
    /* advisory */
  }
}

/** Authoritative counts straight from SQLite. */
export function countsFromDb(jobId: string): Record<Category, number> & { done: number } {
  const rows = db
    .prepare('SELECT category, COUNT(*) AS n FROM results WHERE job_id = ? GROUP BY category')
    .all(jobId) as Array<{ category: Category | null; n: number }>;

  const out = { valid: 0, invalid: 0, catch_all: 0, unknown: 0, done: 0 };
  for (const r of rows) {
    if (r.category && CATEGORIES.includes(r.category)) {
      out[r.category] = r.n;
      out.done += r.n;
    }
  }
  return out;
}

async function redisCounts(jobId: string): Promise<Record<string, number>> {
  try {
    const h = await redis.hgetall(keys.jobCounts(jobId));
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(h)) {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export async function isCancelled(jobId: string): Promise<boolean> {
  try {
    return (await redis.exists(keys.jobCancelled(jobId))) === 1;
  } catch {
    return false;
  }
}

export async function cancelJob(jobId: string): Promise<void> {
  await redis.set(keys.jobCancelled(jobId), '1', 'EX', 7 * 24 * 60 * 60);
  setJobStatus(jobId, 'cancelled');
}

/**
 * Marks a job completed once every address has a terminal verdict.
 * Called after each result; cheap because it reads the Redis counter first.
 */
export async function maybeComplete(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job || job.status === 'completed' || job.status === 'cancelled') return;

  const rc = await redisCounts(jobId);
  if ((rc.done ?? 0) < job.total) return;

  // Confirm against SQLite before declaring victory.
  const authoritative = countsFromDb(jobId);
  if (authoritative.done >= job.total) {
    setJobStatus(jobId, 'completed');
    // Re-sync the Redis hash so the final dashboard render is exact.
    try {
      await redis.hset(keys.jobCounts(jobId), {
        valid: authoritative.valid,
        invalid: authoritative.invalid,
        catch_all: authoritative.catch_all,
        unknown: authoritative.unknown,
        done: authoritative.done,
      });
    } catch {
      /* advisory */
    }
  }
}

// ---------------------------------------------------------------------------
// Status assembly
// ---------------------------------------------------------------------------

export async function jobStatus(jobId: string): Promise<JobStatusResponse | null> {
  const job = getJob(jobId);
  if (!job) return null;

  const settings = await getSettings();
  const [rc, qc] = await Promise.all([redisCounts(jobId), allGroupCounts()]);

  const finished = job.status === 'completed' || job.status === 'cancelled';
  // Trust SQLite once the run is over (or if Redis counters were lost).
  const authoritative = finished || Object.keys(rc).length === 0 ? countsFromDb(jobId) : null;

  const valid = authoritative?.valid ?? rc.valid ?? 0;
  const invalid = authoritative?.invalid ?? rc.invalid ?? 0;
  const catchAll = authoritative?.catch_all ?? rc.catch_all ?? 0;
  const unknown = authoritative?.unknown ?? rc.unknown ?? 0;
  const done = authoritative?.done ?? rc.done ?? 0;

  // Queue depth is global; attribute only this job's share of it.
  const delayed = PROVIDER_GROUPS.reduce((n, g) => n + qc[g].delayed, 0);
  const active = PROVIDER_GROUPS.reduce((n, g) => n + qc[g].active, 0);

  const counts: JobCounts = {
    valid,
    invalid,
    catch_all: catchAll,
    unknown,
    done,
    tempFailEvents: rc.tempFailEvents ?? 0,
    retryPending: delayed,
    pending: Math.max(0, job.total - done),
    active,
  };

  const startedAt = job.started_at;
  const endRef = job.finished_at ?? Date.now();
  const elapsedSec = startedAt ? Math.max(0.001, (endRef - startedAt) / 1000) : 0;
  const rate = elapsedSec > 0 ? done / elapsedSec : 0;
  const etaSeconds = rate > 0 && counts.pending > 0 ? Math.round(counts.pending / rate) : null;

  return {
    id: job.id,
    uploadId: job.upload_id,
    status: job.status as JobStatus,
    total: job.total,
    counts,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    rate: Number(rate.toFixed(2)),
    etaSeconds,
    prefilter: job.prefilter_json ? (JSON.parse(job.prefilter_json) as PrefilterReport) : null,
    perGroup: PROVIDER_GROUPS.map((g) => ({
      group: g,
      waiting: qc[g].waiting,
      active: qc[g].active,
      delayed: qc[g].delayed,
      concurrency: settings.groups[g].concurrency,
      delayMs: settings.groups[g].delayMs,
      paused: qc[g].paused,
    })),
  };
}
