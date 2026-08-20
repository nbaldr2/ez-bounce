import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { prefilterCsv, scanCsv } from '../lib/prefilter.js';
import type { KeptAddress, RejectedAddress } from '../lib/prefilter.js';
import type { UploadRow } from '../db.js';

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
    if (!ok) {
      cb(new Error('Only .csv, .tsv and .txt files are accepted'));
      return;
    }
    cb(null, true);
  },
});

function storedPath(uploadId: string): string {
  return path.join(config.uploadTmpDir, `${uploadId}.csv`);
}

/**
 * POST /api/uploads
 * Accepts the file, scans a sample to detect the email column, and returns the
 * detection result. No SMTP work happens here and nothing is filtered yet — the
 * client shows the detected column for confirmation first.
 */
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

    db.prepare(
      `INSERT INTO uploads (id, filename, created_at, email_column, columns_json, total_rows, delimiter)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uploadId,
      req.file.originalname,
      Date.now(),
      scan.emailColumn,
      JSON.stringify(scan.columns),
      0,
      scan.delimiter,
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
 * POST /api/uploads/:id/analyze
 * Runs the full prefilter pass and stores the surviving candidates.
 * Returns the counts the UI shows *before* the operator commits to a job.
 */
uploadsRouter.post('/:id/analyze', async (req, res, next) => {
  try {
    const uploadId = req.params.id;
    const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId) as
      | UploadRow
      | undefined;
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

    // Re-scan only to recover the headerless flag cheaply.
    const scan = await scanCsv(filePath, 50);

    // Replace any previous analysis for this upload.
    db.prepare('DELETE FROM candidates WHERE upload_id = ?').run(uploadId);
    db.prepare('DELETE FROM rejected WHERE upload_id = ?').run(uploadId);

    const insCand = db.prepare(
      'INSERT OR IGNORE INTO candidates (upload_id, email, domain, row_json) VALUES (?, ?, ?, ?)',
    );
    const insRej = db.prepare(
      'INSERT OR IGNORE INTO rejected (upload_id, email, verdict, row_json) VALUES (?, ?, ?, NULL)',
    );

    // Each batch is one transaction: fast, and bounded memory regardless of how
    // large the file is.
    const writeKept = db.transaction((batch: KeptAddress[]) => {
      for (const c of batch) {
        insCand.run(uploadId, c.email, c.domain, c.row ? JSON.stringify(c.row) : null);
      }
    });
    const writeRejected = db.transaction((batch: RejectedAddress[]) => {
      for (const r of batch) insRej.run(uploadId, r.email, r.verdict);
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
      { keep: writeKept, reject: writeRejected },
    );

    db.prepare(
      'UPDATE uploads SET email_column = ?, total_rows = ?, report_json = ? WHERE id = ?',
    ).run(emailColumn, outcome.report.totalRows, JSON.stringify(outcome.report), uploadId);

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

uploadsRouter.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(req.params.id) as
    | UploadRow
    | undefined;
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
});
