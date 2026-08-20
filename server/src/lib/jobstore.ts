import { randomUUID } from 'node:crypto';
import { execute, query, type JobRow } from '../db.js';
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

export interface JobListRow extends JobRow {
  filename: string;
}

export async function createJob(args: {
  uploadId: string;
  total: number;
  settings: Settings;
  prefilter: PrefilterReport | null;
}): Promise<string> {
  const id = randomUUID();
  await execute(
    `INSERT INTO jobs (id, upload_id, status, total, created_at, settings_json, prefilter_json)
     VALUES ($1, $2, 'queued', $3, $4, $5, $6)`,
    [id, args.uploadId, args.total, Date.now(), JSON.stringify(args.settings), args.prefilter ? JSON.stringify(args.prefilter) : null],
  );
  return id;
}

export async function getJob(id: string): Promise<JobRow | undefined> {
  const [job] = await query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
  return job;
}

export async function listJobs(limit = 25): Promise<JobListRow[]> {
  return query<JobListRow>(
    `SELECT jobs.*, uploads.filename AS filename
     FROM jobs INNER JOIN uploads ON uploads.id = jobs.upload_id
     ORDER BY jobs.created_at DESC LIMIT $1`,
    [limit],
  );
}

export async function setJobStatus(id: string, status: JobStatus): Promise<void> {
  const now = Date.now();
  if (status === 'running') {
    await execute(
      'UPDATE jobs SET status = $1, started_at = COALESCE(started_at, $2) WHERE id = $3',
      [status, now, id],
    );
  } else if (status === 'completed' || status === 'cancelled') {
    await execute('UPDATE jobs SET status = $1, finished_at = $2 WHERE id = $3', [status, now, id]);
  } else {
    await execute('UPDATE jobs SET status = $1 WHERE id = $2', [status, id]);
  }
}

/**
 * Streams candidates in pages. We intentionally resolve MX hosts only for the
 * current page: PostgreSQL/Redis cache the domain result, so a 10M-domain
 * long-tail list never creates a 10M-entry JavaScript Map.
 */
export async function enqueueJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  await setJobStatus(jobId, 'running');
  await redis.del(keys.jobCancelled(jobId));

  const buffers = new Map<ProviderGroup, Array<{ name: string; data: VerifyJobData; opts: object }>>();
  const CHUNK = 1_000;
  const PAGE = 1_000;

  const flush = async (group: ProviderGroup, force = false) => {
    const items = buffers.get(group);
    if (!items || items.length === 0 || (!force && items.length < CHUNK)) return;
    await getQueue(group).addBulk(items);
    buffers.set(group, []);
  };

  let after = '';
  for (;;) {
    const rows = await query<{ email: string; domain: string }>(
      `SELECT email, domain FROM candidates
       WHERE upload_id = $1 AND email > $2
       ORDER BY email LIMIT $3`,
      [job.upload_id, after, PAGE],
    );
    if (rows.length === 0) break;

    const groupByDomain = new Map<string, ProviderGroup>();
    let cursor = 0;
    const DNS_CONCURRENCY = Math.min(20, rows.length);
    await Promise.all(
      Array.from({ length: DNS_CONCURRENCY }, async () => {
        for (;;) {
          const index = cursor++;
          if (index >= rows.length) return;
          const domain = rows[index]!.domain;
          let group: ProviderGroup = 'other';
          try {
            group = (await resolveGroup(domain)).group;
          } catch {
            // Reacher will independently report no-MX/DNS failures.
          }
          groupByDomain.set(domain, group);
        }
      }),
    );

    for (const row of rows) {
      const group = groupByDomain.get(row.domain) ?? 'other';
      const data: VerifyJobData = { jobId, email: row.email, domain: row.domain, group, attempt: 1 };
      const items = buffers.get(group) ?? [];
      items.push({
        name: 'verify',
        data,
        opts: { jobId: `${jobId}:${row.email}:1` },
      });
      buffers.set(group, items);
    }

    after = rows[rows.length - 1]!.email;
    await Promise.all(PROVIDER_GROUPS.map((group) => flush(group)));
  }

  await Promise.all(PROVIDER_GROUPS.map((group) => flush(group, true)));
}

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
 * `ON CONFLICT DO NOTHING RETURNING` preserves exact progress counters when a
 * stalled BullMQ task is delivered again. PostgreSQL is durable truth; Redis is
 * the low-latency status cache.
 */
export async function recordResult(args: RecordResultArgs): Promise<void> {
  const values = [
    args.jobId,
    args.email,
    args.domain,
    args.group,
    args.category,
    args.reason,
    args.reacherStatus,
    args.attempts,
    args.smtpCode,
    args.message ? args.message.slice(0, 1_000) : null,
    Date.now(),
    args.raw ? JSON.stringify(args.raw).slice(0, 8_000) : null,
  ];
  const inserted = await query<{ email: string }>(
    `INSERT INTO results
       (job_id, email, domain, provider_group, category, reason, reacher_status,
        attempts, smtp_code, message, updated_at, raw_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (job_id, email) DO NOTHING
     RETURNING email`,
    values,
  );

  if (inserted.length === 0) {
    await execute(
      `UPDATE results SET category = $5, reason = $6, reacher_status = $7,
         attempts = $8, smtp_code = $9, message = $10, updated_at = $11, raw_json = $12
       WHERE job_id = $1 AND email = $2`,
      values,
    );
    return;
  }

  try {
    const pipeline = redis.pipeline();
    pipeline.hincrby(keys.jobCounts(args.jobId), args.category, 1);
    pipeline.hincrby(keys.jobCounts(args.jobId), 'done', 1);
    await pipeline.exec();
  } catch {
    // PostgreSQL reconciles any lost Redis counter at job completion.
  }
}

export async function incrTempFailEvents(jobId: string): Promise<void> {
  try {
    await redis.hincrby(keys.jobCounts(jobId), 'tempFailEvents', 1);
  } catch {
    /* advisory */
  }
}

export async function countsFromDb(jobId: string): Promise<Record<Category, number> & { done: number }> {
  const rows = await query<{ category: Category | null; n: number }>(
    `SELECT category, COUNT(*)::bigint AS n FROM results
     WHERE job_id = $1 GROUP BY category`,
    [jobId],
  );
  const out = { valid: 0, invalid: 0, catch_all: 0, unknown: 0, done: 0 };
  for (const row of rows) {
    if (row.category && CATEGORIES.includes(row.category)) {
      out[row.category] = row.n;
      out.done += row.n;
    }
  }
  return out;
}

async function redisCounts(jobId: string): Promise<Record<string, number>> {
  try {
    const hash = await redis.hgetall(keys.jobCounts(jobId));
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(hash)) {
      const number = Number.parseInt(value, 10);
      if (Number.isFinite(number)) out[key] = number;
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
  await setJobStatus(jobId, 'cancelled');
}

export async function maybeComplete(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job || job.status === 'completed' || job.status === 'cancelled') return;

  const cached = await redisCounts(jobId);
  if ((cached.done ?? 0) < job.total) return;

  const authoritative = await countsFromDb(jobId);
  if (authoritative.done < job.total) return;

  await setJobStatus(jobId, 'completed');
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

export async function jobStatus(jobId: string): Promise<JobStatusResponse | null> {
  const job = await getJob(jobId);
  if (!job) return null;

  const settings = await getSettings();
  const [cached, queues] = await Promise.all([redisCounts(jobId), allGroupCounts()]);
  const finished = job.status === 'completed' || job.status === 'cancelled';
  const authoritative = finished || Object.keys(cached).length === 0 ? await countsFromDb(jobId) : null;

  const valid = authoritative?.valid ?? cached.valid ?? 0;
  const invalid = authoritative?.invalid ?? cached.invalid ?? 0;
  const catchAll = authoritative?.catch_all ?? cached.catch_all ?? 0;
  const unknown = authoritative?.unknown ?? cached.unknown ?? 0;
  const done = authoritative?.done ?? cached.done ?? 0;
  const delayed = PROVIDER_GROUPS.reduce((count, group) => count + queues[group].delayed, 0);
  const active = PROVIDER_GROUPS.reduce((count, group) => count + queues[group].active, 0);

  const counts: JobCounts = {
    valid,
    invalid,
    catch_all: catchAll,
    unknown,
    done,
    tempFailEvents: cached.tempFailEvents ?? 0,
    retryPending: delayed,
    pending: Math.max(0, job.total - done),
    active,
  };
  const startedAt = job.started_at;
  const endRef = job.finished_at ?? Date.now();
  const elapsedSeconds = startedAt ? Math.max(0.001, (endRef - startedAt) / 1000) : 0;
  const rate = elapsedSeconds > 0 ? done / elapsedSeconds : 0;

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
    etaSeconds: rate > 0 && counts.pending > 0 ? Math.round(counts.pending / rate) : null,
    prefilter: job.prefilter_json ? (JSON.parse(job.prefilter_json) as PrefilterReport) : null,
    perGroup: PROVIDER_GROUPS.map((group) => ({
      group,
      waiting: queues[group].waiting,
      active: queues[group].active,
      delayed: queues[group].delayed,
      concurrency: settings.groups[group].concurrency,
      delayMs: settings.groups[group].delayMs,
      paused: queues[group].paused,
    })),
  };
}
