import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
fs.mkdirSync(config.uploadTmpDir, { recursive: true });

export const db = new Database(config.sqlitePath);

// WAL lets the API read results while workers are writing them.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS uploads (
  id            TEXT PRIMARY KEY,
  filename      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  email_column  TEXT,
  columns_json  TEXT NOT NULL DEFAULT '[]',
  total_rows    INTEGER NOT NULL DEFAULT 0,
  report_json   TEXT,
  delimiter     TEXT
);

-- Addresses that survived the prefilter and are eligible for SMTP checks.
CREATE TABLE IF NOT EXISTS candidates (
  upload_id  TEXT NOT NULL,
  email      TEXT NOT NULL,
  domain     TEXT NOT NULL,
  row_json   TEXT,
  PRIMARY KEY (upload_id, email)
) WITHOUT ROWID;

-- Addresses rejected before SMTP, retained so "export all with labels" can
-- reproduce the original list in full.
CREATE TABLE IF NOT EXISTS rejected (
  upload_id  TEXT NOT NULL,
  email      TEXT NOT NULL,
  verdict    TEXT NOT NULL,
  row_json   TEXT,
  PRIMARY KEY (upload_id, email, verdict)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  upload_id      TEXT NOT NULL,
  status         TEXT NOT NULL,
  total          INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER,
  settings_json  TEXT NOT NULL,
  prefilter_json TEXT
);

CREATE TABLE IF NOT EXISTS results (
  job_id         TEXT NOT NULL,
  email          TEXT NOT NULL,
  domain         TEXT NOT NULL,
  provider_group TEXT NOT NULL,
  category       TEXT,
  reason         TEXT,
  reacher_status TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  smtp_code      INTEGER,
  message        TEXT,
  updated_at     INTEGER NOT NULL,
  raw_json       TEXT,
  PRIMARY KEY (job_id, email)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_results_job_category ON results (job_id, category);
CREATE INDEX IF NOT EXISTS idx_results_job_group    ON results (job_id, provider_group);
CREATE INDEX IF NOT EXISTS idx_jobs_upload          ON jobs (upload_id);
`);

export interface UploadRow {
  id: string;
  filename: string;
  created_at: number;
  email_column: string | null;
  columns_json: string;
  total_rows: number;
  report_json: string | null;
  delimiter: string | null;
}

export interface JobRow {
  id: string;
  upload_id: string;
  status: string;
  total: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  settings_json: string;
  prefilter_json: string | null;
}
