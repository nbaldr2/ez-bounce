import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { execute, query, transaction, type UploadRow } from '../db.js';
import { prefilterCsv, scanCsv } from '../lib/prefilter.js';
import type { KeptAddress, RejectedAddress } from '../lib/prefilter.js';

export const uploadsRouter = Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadTmpDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    cb(null, `${randomUUID()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok =
      /\.(csv|tsv|txt)$/i.test(file.originalname) ||
      ['text/csv', 'text/plain', 'application/vnd.ms-excel', 'text/tab-separated-values'].includes(
        file.mimetype,
      );
    if (!ok) return cb(new Error('Only .csv, .tsv and .txt files are accepted'));
    cb(null, true);
  },
});

function storedPath(uploadId: string): string {
  return path.join(config.uploadTmpDir, `${uploadId}.csv`);
}

/**
 * One SQL statement per batch, not one network round trip per candidate.
 * `dedupe_key` is unique per upload, making PostgreSQL the source of truth for
 * exact Gmail alias-aware dedupe at 10M scale.
 */
async function insertCandidates(
  uploadId: string,
  batch: KeptAddress[],
): Promise<{ inserted: number; duplicates: RejectedAddress[] }> {
  if (batch.length === 0) return { inserted: 0, duplicates: [] };

  const inserted = await query<{ dedupe_key: string }>(
    `INSERT INTO candidates (upload_id, email, dedupe_key, domain, provider_group, row_json)
     SELECT $1, input.email, input.dedupe_key, input.domain, input.provider_group, input.row_json
     FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
       AS input(email, dedupe_key, domain, provider_group, row_json)
     ON CONFLICT (upload_id, dedupe_key) DO NOTHING
     RETURNING dedupe_key`,
    [
      uploadId,
      batch.map((row) => row.email),
      batch.map((row) => row.dedupeKey),
      batch.map((row) => row.domain),
      batch.map((row) => row.group),
      batch.map((row) => (row.row ? JSON.stringify(row.row) : null)),
    ],
  );

  const insertedKeys = new Set(inserted.map((row) => row.dedupe_key));
  return {
    inserted: inserted.length,
    duplicates: batch
      .filter((row) => !insertedKeys.has(row.dedupeKey))
      .map((row) => ({ email: row.email, verdict: 'duplicate' as const })),
  };
}

async function insertRejected(uploadId: string, batch: RejectedAddress[]): Promise<void> {
  if (batch.length === 0) return;
  await execute(
    `INSERT INTO rejected (upload_id, email, verdict, row_json)
     SELECT $1, input.email, input.verdict, NULL
     FROM UNNEST($2::text[], $3::text[]) AS input(email, verdict)
     ON CONFLICT (upload_id, email, verdict) DO NOTHING`,
    [
      uploadId,
      batch.map((row) => row.email),
      batch.map((row) => row.verdict),
    ],
  );
}

/** Uploads a CSV and returns content-driven email-column detection. */
uploadsRouter.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });
      return;
    }

    const uploadId = randomUUID();
    const dest = storedPath(uploadId);
    fs.renameSync(req.file.path, dest);

    const scan = await scanCsv(dest);
    if (scan.columns.length === 0) {
      fs.rmSync(dest, { force: true });
      res.status(400).json({ error: 'File appears to be empty' });
      return;
    }

    await execute(
      `INSERT INTO uploads (id, filename, created_at, email_column, columns_json, total_rows, delimiter)
       VALUES ($1, $2, $3, $4, $5, 0, $6)`,
      [
        uploadId,
        req.file.originalname,
        Date.now(),
        scan.emailColumn,
        JSON.stringify(scan.columns),
        scan.delimiter,
      ],
    );

    res.status(201).json({
      uploadId,
      filename: req.file.originalname,
      sizeBytes: req.file.size,
      ...scan,
    });
  } catch (err) {
    next(err);
  }
});

const analyzeSchema = z.object({
  emailColumn: z.string().min(1).optional(),
  dropRole: z.boolean().default(true),
  dropDisposable: z.boolean().default(true),
  keepColumns: z.boolean().default(true),
});

/**
 * Streams local filters into PostgreSQL in 5k-row batches. The response remains
 * a preflight report before SMTP verification starts; candidate data never sits
 * in an in-memory 10M-row array.
 */
uploadsRouter.post('/:id/analyze', async (req, res, next) => {
  try {
    const uploadId = req.params.id;
    const [row] = await query<UploadRow>('SELECT * FROM uploads WHERE id = $1', [uploadId]);
    if (!row) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    const filePath = storedPath(uploadId);
    if (!fs.existsSync(filePath)) {
      res.status(410).json({ error: 'Uploaded file is no longer on disk; re-upload it' });
      return;
    }

    const body = analyzeSchema.parse(req.body ?? {});
    const columns = JSON.parse(row.columns_json) as string[];
    const emailColumn = body.emailColumn ?? row.email_column;
    if (!emailColumn) {
      res.status(400).json({ error: 'No email column detected; specify emailColumn explicitly' });
      return;
    }
    if (!columns.includes(emailColumn)) {
      res.status(400).json({ error: `Unknown column ${emailColumn}` });
      return;
    }

    const scan = await scanCsv(filePath, 50);
    await transaction(async (client) => {
      await client.query('DELETE FROM candidates WHERE upload_id = $1', [uploadId]);
      await client.query('DELETE FROM rejected WHERE upload_id = $1', [uploadId]);
    });

    const outcome = await prefilterCsv(
      filePath,
      {
        emailColumn,
        columns,
        delimiter: row.delimiter ?? ',',
        headerless: scan.headerless,
        dropRole: body.dropRole,
        dropDisposable: body.dropDisposable,
        keepRow: body.keepColumns,
      },
      {
        keep: (batch) => insertCandidates(uploadId, batch),
        reject: (batch) => insertRejected(uploadId, batch),
      },
    );

    const [topDomains, groups] = await Promise.all([
      query<{ domain: string; count: number }>(
        `SELECT domain, COUNT(*)::bigint AS count
         FROM candidates WHERE upload_id = $1
         GROUP BY domain ORDER BY count DESC, domain ASC LIMIT 15`,
        [uploadId],
      ),
      query<{ provider_group: string; count: number }>(
        `SELECT provider_group, COUNT(*)::bigint AS count
         FROM candidates WHERE upload_id = $1 GROUP BY provider_group`,
        [uploadId],
      ),
    ]);
    outcome.report.topDomains = topDomains;
    outcome.report.groupCounts = Object.fromEntries(
      groups.map((item) => [item.provider_group, item.count]),
    );

    await execute(
      `UPDATE uploads
       SET email_column = $1, total_rows = $2, report_json = $3
       WHERE id = $4`,
      [emailColumn, outcome.report.totalRows, JSON.stringify(outcome.report), uploadId],
    );

    res.json({
      uploadId,
      emailColumn,
      report: outcome.report,
      options: {
        dropRole: body.dropRole,
        dropDisposable: body.dropDisposable,
        keepColumns: body.keepColumns,
      },
    });
  } catch (err) {
    next(err);
  }
});

uploadsRouter.get('/:id', async (req, res, next) => {
  try {
    const [row] = await query<UploadRow>('SELECT * FROM uploads WHERE id = $1', [req.params.id]);
    if (!row) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }
    res.json({
      uploadId: row.id,
      filename: row.filename,
      createdAt: row.created_at,
      emailColumn: row.email_column,
      columns: JSON.parse(row.columns_json) as string[],
      totalRows: row.total_rows,
      report: row.report_json ? JSON.parse(row.report_json) : null,
    });
  } catch (err) {
    next(err);
  }
});
