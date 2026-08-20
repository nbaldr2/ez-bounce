import { Router } from 'express';
import { stringify } from 'csv-stringify';
import { z } from 'zod';
import { db } from '../db.js';
import { getSettings } from '../settings.js';
import {
  cancelJob,
  countsFromDb,
  createJob,
  enqueueJob,
  getJob,
  jobStatus,
  listJobs,
  setJobStatus,
} from '../lib/jobstore.js';
import { pauseAll, resumeAll } from '../queue/queues.js';
import { CATEGORIES, type Category } from '../types.js';

export const jobsRouter = Router();

const createSchema = z.object({
  uploadId: z.string().uuid(),
});

/**
 * POST /api/jobs
 * Creates the job and returns immediately. Enqueueing 100k addresses (including
 * MX resolution for every distinct domain) happens on a detached promise, so the
 * HTTP request is never held open for it — the client starts polling status and
 * watches the queue fill up.
 */
jobsRouter.post('/', async (req, res, next) => {
  try {
    const { uploadId } = createSchema.parse(req.body ?? {});

    const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId) as
      | { report_json: string | null }
      | undefined;
    if (!upload) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    const total = (
      db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE upload_id = ?').get(uploadId) as {
        n: number;
      }
    ).n;

    if (total === 0) {
      res.status(400).json({
        error: 'No candidate addresses. Run POST /api/uploads/:id/analyze first.',
      });
      return;
    }

    const settings = await getSettings(true);
    const jobId = createJob({
      uploadId,
      total,
      settings,
      prefilter: upload.report_json ? JSON.parse(upload.report_json) : null,
    });

    void enqueueJob(jobId).catch((err) => {
      console.error(`[jobs] enqueue failed for ${jobId}:`, err);
      setJobStatus(jobId, 'cancelled');
    });

    res.status(202).json({ jobId, total });
  } catch (err) {
    next(err);
  }
});

jobsRouter.get('/', (_req, res) => {
  res.json({
    jobs: listJobs().map((j) => ({
      id: j.id,
      uploadId: j.upload_id,
      status: j.status,
      total: j.total,
      createdAt: j.created_at,
      startedAt: j.started_at,
      finishedAt: j.finished_at,
    })),
  });
});

/** GET /api/jobs/:id/status — the 2s polling endpoint. */
jobsRouter.get('/:id/status', async (req, res, next) => {
  try {
    const status = await jobStatus(req.params.id!);
    if (!status) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(status);
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/:id/pause', async (req, res, next) => {
  try {
    const job = getJob(req.params.id!);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    // Queues are shared, so pausing is global. With one job at a time (the
    // normal case for a single VPS) this is exactly what the operator wants.
    await pauseAll();
    setJobStatus(job.id, 'paused');
    res.json({ ok: true, status: 'paused' });
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/:id/resume', async (req, res, next) => {
  try {
    const job = getJob(req.params.id!);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    await resumeAll();
    setJobStatus(job.id, 'running');
    res.json({ ok: true, status: 'running' });
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const job = getJob(req.params.id!);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    await cancelJob(job.id);
    res.json({ ok: true, status: 'cancelled' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Results table
// ---------------------------------------------------------------------------

const resultsQuerySchema = z.object({
  category: z.string().optional(),
  group: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['email', 'category', 'updated_at', 'attempts']).default('email'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

function buildWhere(jobId: string, q: z.infer<typeof resultsQuerySchema>) {
  const clauses = ['job_id = @jobId'];
  const params: Record<string, unknown> = { jobId };

  if (q.category && q.category !== 'all') {
    const cats = q.category
      .split(',')
      .map((c) => c.trim())
      .filter((c): c is Category => CATEGORIES.includes(c as Category));
    if (cats.length > 0) {
      clauses.push(`category IN (${cats.map((_, i) => `@cat${i}`).join(',')})`);
      cats.forEach((c, i) => {
        params[`cat${i}`] = c;
      });
    }
  }

  if (q.group && q.group !== 'all') {
    clauses.push('provider_group = @group');
    params.group = q.group;
  }

  if (q.q && q.q.trim() !== '') {
    clauses.push('(email LIKE @like OR domain LIKE @like OR reason LIKE @like)');
    params.like = `%${q.q.trim().toLowerCase()}%`;
  }

  return { where: clauses.join(' AND '), params };
}

jobsRouter.get('/:id/results', (req, res, next) => {
  try {
    const jobId = req.params.id!;
    if (!getJob(jobId)) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const q = resultsQuerySchema.parse(req.query);
    const { where, params } = buildWhere(jobId, q);

    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM results WHERE ${where}`).get(params) as { n: number }
    ).n;

    const rows = db
      .prepare(
        `SELECT email, domain, provider_group, category, reason, reacher_status, attempts,
                smtp_code, message, updated_at
         FROM results WHERE ${where}
         ORDER BY ${q.sort} ${q.dir.toUpperCase()}
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: q.limit, offset: q.offset }) as Array<Record<string, unknown>>;

    res.json({
      total,
      limit: q.limit,
      offset: q.offset,
      rows: rows.map((r) => ({
        email: r.email,
        domain: r.domain,
        group: r.provider_group,
        category: r.category,
        reason: r.reason,
        reacherStatus: r.reacher_status,
        attempts: r.attempts,
        smtpCode: r.smtp_code,
        message: r.message,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

jobsRouter.get('/:id/summary', (req, res, next) => {
  try {
    const jobId = req.params.id!;
    const job = getJob(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const byReason = db
      .prepare(
        `SELECT category, reason, COUNT(*) AS n FROM results
         WHERE job_id = ? GROUP BY category, reason ORDER BY n DESC`,
      )
      .all(jobId) as Array<{ category: string; reason: string; n: number }>;

    const byGroup = db
      .prepare(
        `SELECT provider_group AS grp, category, COUNT(*) AS n FROM results
         WHERE job_id = ? GROUP BY provider_group, category`,
      )
      .all(jobId) as Array<{ grp: string; category: string; n: number }>;

    res.json({ counts: countsFromDb(jobId), byReason, byGroup });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

const exportSchema = z.object({
  mode: z.enum(['valid_only', 'all_labeled', 'safe_to_send']).default('valid_only'),
  /** Include the original CSV columns from the upload. */
  includeColumns: z.coerce.boolean().default(false),
  /** Include addresses dropped by the prefilter (all_labeled only). */
  includePrefiltered: z.coerce.boolean().default(false),
});

/**
 * GET /api/jobs/:id/export
 *
 * Streams straight out of SQLite with a cursor, so exporting 100k rows uses
 * constant memory and starts sending bytes immediately.
 *
 * Modes:
 *   valid_only   - just the addresses Reacher confirmed deliverable
 *   safe_to_send - valid + catch-all (catch-all domains accept everything, so
 *                  they are a judgement call; kept separate deliberately)
 *   all_labeled  - every address with its category and reason
 */
jobsRouter.get('/:id/export', async (req, res, next) => {
  try {
    const jobId = req.params.id!;
    const job = getJob(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const opts = exportSchema.parse(req.query);

    const categories: Category[] =
      opts.mode === 'valid_only'
        ? ['valid']
        : opts.mode === 'safe_to_send'
          ? ['valid', 'catch_all']
          : [...CATEGORIES];

    const labeled = opts.mode === 'all_labeled';

    const header = labeled
      ? ['email', 'category', 'reason', 'provider_group', 'attempts', 'smtp_code']
      : ['email'];

    const originalColumns: string[] = [];
    if (opts.includeColumns) {
      const up = db.prepare('SELECT columns_json, email_column FROM uploads WHERE id = ?').get(
        job.upload_id,
      ) as { columns_json: string; email_column: string | null } | undefined;
      if (up) {
        const cols = JSON.parse(up.columns_json) as string[];
        for (const c of cols) {
          if (c !== up.email_column) originalColumns.push(c);
        }
        header.push(...originalColumns);
      }
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader(
      'content-disposition',
      `attachment; filename="ez-debounce-${opts.mode}-${stamp}.csv"`,
    );

    const stringifier = stringify({ header: true, columns: header });
    stringifier.pipe(res);

    const rowLookup = opts.includeColumns
      ? db.prepare('SELECT row_json FROM candidates WHERE upload_id = ? AND email = ?')
      : null;

    const placeholders = categories.map(() => '?').join(',');
    const pageStmt = db.prepare(
      `SELECT email, category, reason, provider_group, attempts, smtp_code
       FROM results
       WHERE job_id = ? AND category IN (${placeholders}) AND email > ?
       ORDER BY email LIMIT ?`,
    );

    const extraFor = (email: string): string[] => {
      if (!rowLookup) return [];
      const r = rowLookup.get(job.upload_id, email) as { row_json: string | null } | undefined;
      const parsed = r?.row_json ? (JSON.parse(r.row_json) as Record<string, string>) : {};
      return originalColumns.map((c) => parsed[c] ?? '');
    };

    /** Resolves once the consumer has drained, so memory stays bounded. */
    const drain = () =>
      new Promise<void>((resolve) => stringifier.once('drain', () => resolve()));

    // Paged rather than a single open cursor: better-sqlite3 shares one
    // synchronous connection with the workers, and an iterator left open across
    // an await collides with result writes. Paging also yields to the event loop
    // between pages instead of blocking it for the whole export.
    const PAGE_SIZE = 2_000;
    let after = '';
    for (;;) {
      const rows = pageStmt.all(jobId, ...categories, after, PAGE_SIZE) as Array<{
        email: string;
        category: string;
        reason: string;
        provider_group: string;
        attempts: number;
        smtp_code: number | null;
      }>;
      if (rows.length === 0) break;

      for (const row of rows) {
        const base = labeled
          ? [
              row.email,
              row.category,
              row.reason,
              row.provider_group,
              String(row.attempts),
              row.smtp_code === null ? '' : String(row.smtp_code),
            ]
          : [row.email];
        if (!stringifier.write([...base, ...extraFor(row.email)])) {
          await drain();
        }
      }

      after = rows[rows.length - 1]!.email;
    }

    // Prefilter rejects never reached SMTP, so they only make sense in the
    // labelled export where the category column explains why they were dropped.
    if (labeled && opts.includePrefiltered) {
      let afterRej = '';
      for (;;) {
        const rows = db
          .prepare(
            `SELECT email, verdict FROM rejected
             WHERE upload_id = ? AND email > ?
             ORDER BY email LIMIT ?`,
          )
          .all(job.upload_id, afterRej, PAGE_SIZE) as Array<{ email: string; verdict: string }>;
        if (rows.length === 0) break;

        for (const r of rows) {
          if (
            !stringifier.write([
              r.email,
              'prefiltered',
              r.verdict,
              '',
              '0',
              '',
              ...originalColumns.map(() => ''),
            ])
          ) {
            await drain();
          }
        }
        afterRej = rows[rows.length - 1]!.email;
      }
    }

    stringifier.end();
  } catch (err) {
    next(err);
  }
});
