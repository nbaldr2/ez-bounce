import { Router } from 'express';
import { stringify } from 'csv-stringify';
import { z } from 'zod';
import { query } from '../db.js';
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

const createSchema = z.object({ uploadId: z.string().uuid() });

jobsRouter.post('/', async (req, res, next) => {
  try {
    const { uploadId } = createSchema.parse(req.body ?? {});
    const [upload] = await query<{ report_json: string | null }>(
      'SELECT report_json FROM uploads WHERE id = $1',
      [uploadId],
    );
    if (!upload) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    const [count] = await query<{ n: number }>(
      'SELECT COUNT(*)::bigint AS n FROM candidates WHERE upload_id = $1',
      [uploadId],
    );
    const total = count?.n ?? 0;
    if (total === 0) {
      res.status(400).json({ error: 'No candidate addresses. Run analysis first.' });
      return;
    }

    const jobId = await createJob({
      uploadId,
      total,
      settings: await getSettings(true),
      prefilter: upload.report_json ? JSON.parse(upload.report_json) : null,
    });

    void enqueueJob(jobId).catch(async (err) => {
      console.error(`[jobs] enqueue failed for ${jobId}:`, err);
      await setJobStatus(jobId, 'cancelled').catch(() => undefined);
    });
    res.status(202).json({ jobId, total });
  } catch (err) {
    next(err);
  }
});

jobsRouter.get('/', async (_req, res, next) => {
  try {
    const jobs = await listJobs();
    res.json({
      jobs: jobs.map((job) => ({
        id: job.id,
        uploadId: job.upload_id,
        filename: job.filename,
        status: job.status,
        total: job.total,
        createdAt: job.created_at,
        startedAt: job.started_at,
        finishedAt: job.finished_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

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
    const job = await getJob(req.params.id!);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    await pauseAll();
    await setJobStatus(job.id, 'paused');
    res.json({ ok: true, status: 'paused' });
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/:id/resume', async (req, res, next) => {
  try {
    const job = await getJob(req.params.id!);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    await resumeAll();
    await setJobStatus(job.id, 'running');
    res.json({ ok: true, status: 'running' });
  } catch (err) {
    next(err);
  }
});

jobsRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const job = await getJob(req.params.id!);
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

const resultsQuerySchema = z.object({
  category: z.string().optional(),
  group: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['email', 'category', 'updated_at', 'attempts']).default('email'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

function buildWhere(jobId: string, filters: z.infer<typeof resultsQuerySchema>) {
  const clauses = ['job_id = $1'];
  const values: unknown[] = [jobId];
  const add = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filters.category && filters.category !== 'all') {
    const categories = filters.category
      .split(',')
      .map((item) => item.trim())
      .filter((item): item is Category => CATEGORIES.includes(item as Category));
    if (categories.length > 0) clauses.push(`category = ANY(${add(categories)}::text[])`);
  }
  if (filters.group && filters.group !== 'all') clauses.push(`provider_group = ${add(filters.group)}`);
  if (filters.q && filters.q.trim() !== '') {
    const term = `%${filters.q.trim()}%`;
    const placeholder = add(term);
    clauses.push(`(email ILIKE ${placeholder} OR domain ILIKE ${placeholder} OR reason ILIKE ${placeholder})`);
  }
  return { where: clauses.join(' AND '), values };
}

jobsRouter.get('/:id/results', async (req, res, next) => {
  try {
    const jobId = req.params.id!;
    if (!(await getJob(jobId))) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const filters = resultsQuerySchema.parse(req.query);
    const { where, values } = buildWhere(jobId, filters);
    const [count] = await query<{ n: number }>(`SELECT COUNT(*)::bigint AS n FROM results WHERE ${where}`, values);
    const sortColumns = {
      email: 'email',
      category: 'category',
      updated_at: 'updated_at',
      attempts: 'attempts',
    } as const;
    const limit = values.length + 1;
    const offset = values.length + 2;
    const rows = await query<{
      email: string;
      domain: string;
      provider_group: string;
      category: Category;
      reason: string;
      reacher_status: string | null;
      attempts: number;
      smtp_code: number | null;
      message: string | null;
      updated_at: number;
    }>(
      `SELECT email, domain, provider_group, category, reason, reacher_status, attempts,
              smtp_code, message, updated_at
       FROM results WHERE ${where}
       ORDER BY ${sortColumns[filters.sort]} ${filters.dir.toUpperCase()}, email ASC
       LIMIT $${limit} OFFSET $${offset}`,
      [...values, filters.limit, filters.offset],
    );

    res.json({
      total: count?.n ?? 0,
      limit: filters.limit,
      offset: filters.offset,
      rows: rows.map((row) => ({
        email: row.email,
        domain: row.domain,
        group: row.provider_group,
        category: row.category,
        reason: row.reason,
        reacherStatus: row.reacher_status,
        attempts: row.attempts,
        smtpCode: row.smtp_code,
        message: row.message,
        updatedAt: row.updated_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

jobsRouter.get('/:id/summary', async (req, res, next) => {
  try {
    const jobId = req.params.id!;
    if (!(await getJob(jobId))) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const [counts, byReason, byGroup] = await Promise.all([
      countsFromDb(jobId),
      query<{ category: string; reason: string; n: number }>(
        `SELECT category, reason, COUNT(*)::bigint AS n FROM results
         WHERE job_id = $1 GROUP BY category, reason ORDER BY n DESC`,
        [jobId],
      ),
      query<{ grp: string; category: string; n: number }>(
        `SELECT provider_group AS grp, category, COUNT(*)::bigint AS n FROM results
         WHERE job_id = $1 GROUP BY provider_group, category`,
        [jobId],
      ),
    ]);
    res.json({ counts, byReason, byGroup });
  } catch (err) {
    next(err);
  }
});

const exportSchema = z.object({
  mode: z.enum(['valid_only', 'all_labeled', 'safe_to_send']).default('valid_only'),
  includeColumns: z.coerce.boolean().default(false),
  includePrefiltered: z.coerce.boolean().default(false),
});

/** Keyset-paged PostgreSQL export; never loads the list into Node memory. */
jobsRouter.get('/:id/export', async (req, res, next) => {
  try {
    const jobId = req.params.id!;
    const job = await getJob(jobId);
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
      const [upload] = await query<{ columns_json: string; email_column: string | null }>(
        'SELECT columns_json, email_column FROM uploads WHERE id = $1',
        [job.upload_id],
      );
      if (upload) {
        for (const column of JSON.parse(upload.columns_json) as string[]) {
          if (column !== upload.email_column) originalColumns.push(column);
        }
        header.push(...originalColumns);
      }
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="ez-debounce-${opts.mode}-${stamp}.csv"`);
    const stringifier = stringify({ header: true, columns: header });
    stringifier.pipe(res);
    const drain = () => new Promise<void>((resolve) => stringifier.once('drain', resolve));

    const PAGE_SIZE = 2_000;
    let after = '';
    for (;;) {
      const rows = await query<{
        email: string;
        category: string;
        reason: string;
        provider_group: string;
        attempts: number;
        smtp_code: number | null;
        row_json: string | null;
      }>(
        `SELECT results.email, results.category, results.reason, results.provider_group,
                results.attempts, results.smtp_code, candidates.row_json
         FROM results
         LEFT JOIN candidates ON candidates.upload_id = $1 AND candidates.email = results.email
         WHERE results.job_id = $2 AND results.category = ANY($3::text[]) AND results.email > $4
         ORDER BY results.email LIMIT $5`,
        [job.upload_id, jobId, categories, after, PAGE_SIZE],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const original = row.row_json ? (JSON.parse(row.row_json) as Record<string, string>) : {};
        const base = labeled
          ? [row.email, row.category, row.reason, row.provider_group, String(row.attempts), row.smtp_code === null ? '' : String(row.smtp_code)]
          : [row.email];
        if (!stringifier.write([...base, ...originalColumns.map((column) => original[column] ?? '')])) {
          await drain();
        }
      }
      after = rows[rows.length - 1]!.email;
    }

    if (labeled && opts.includePrefiltered) {
      let afterRejected = '';
      for (;;) {
        const rows = await query<{ email: string; verdict: string }>(
          `SELECT email, verdict FROM rejected
           WHERE upload_id = $1 AND email > $2
           ORDER BY email LIMIT $3`,
          [job.upload_id, afterRejected, PAGE_SIZE],
        );
        if (rows.length === 0) break;
        for (const row of rows) {
          if (!stringifier.write([row.email, 'prefiltered', row.verdict, '', '0', '', ...originalColumns.map(() => '')])) {
            await drain();
          }
        }
        afterRejected = rows[rows.length - 1]!.email;
      }
    }
    stringifier.end();
  } catch (err) {
    next(err);
  }
});
