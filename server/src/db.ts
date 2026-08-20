import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { config } from './config.js';

// PostgreSQL int8 values arrive as strings by default. Job sizes, timestamps,
// and counts stay safely below Number.MAX_SAFE_INTEGER at the 10M scale.
types.setTypeParser(20, (value) => Number.parseInt(value, 10));

type DbExecutor = Pick<PoolClient, 'query'>;

export interface UploadRow extends QueryResultRow {
  id: string;
  filename: string;
  created_at: number;
  email_column: string | null;
  columns_json: string;
  total_rows: number;
  report_json: string | null;
  delimiter: string | null;
}

export interface JobRow extends QueryResultRow {
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

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: config.dbStatementTimeoutMs,
  application_name: 'ez-debounce',
});

pool.on('error', (err) => {
  console.error('[postgres] idle client error:', err.message);
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, values as unknown[]);
  return result.rows;
}

export async function execute(text: string, values: readonly unknown[] = []): Promise<number> {
  const result = await pool.query(text, values as unknown[]);
  return result.rowCount ?? 0;
}

export async function transaction<T>(fn: (client: DbExecutor) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Idempotent schema migration. PostgreSQL, not the Node process, owns durable
 * history and concurrency. `BIGINT` is required for millisecond timestamps and
 * allows result/job counts far beyond SQLite's practical single-file limits.
 */
export async function initDb(): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uploads (
      id            TEXT PRIMARY KEY,
      filename      TEXT NOT NULL,
      created_at    BIGINT NOT NULL,
      email_column  TEXT,
      columns_json  TEXT NOT NULL DEFAULT '[]',
      total_rows    BIGINT NOT NULL DEFAULT 0,
      report_json   TEXT,
      delimiter     TEXT
    );

    -- dedupe_key makes Gmail dot/+ aliases a database-enforced unique value
    -- without holding millions of addresses in a Node.js Set.
    CREATE TABLE IF NOT EXISTS candidates (
      upload_id      TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
      email          TEXT NOT NULL,
      dedupe_key     TEXT NOT NULL,
      domain         TEXT NOT NULL,
      provider_group TEXT NOT NULL,
      row_json       TEXT,
      PRIMARY KEY (upload_id, dedupe_key),
      UNIQUE (upload_id, email)
    );

    CREATE TABLE IF NOT EXISTS rejected (
      upload_id  TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
      email      TEXT NOT NULL,
      verdict    TEXT NOT NULL,
      row_json   TEXT,
      PRIMARY KEY (upload_id, email, verdict)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id             TEXT PRIMARY KEY,
      upload_id      TEXT NOT NULL REFERENCES uploads(id) ON DELETE RESTRICT,
      status         TEXT NOT NULL,
      total          BIGINT NOT NULL,
      created_at     BIGINT NOT NULL,
      started_at     BIGINT,
      finished_at    BIGINT,
      settings_json  TEXT NOT NULL,
      prefilter_json TEXT
    );

    CREATE TABLE IF NOT EXISTS results (
      job_id         TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      email          TEXT NOT NULL,
      domain         TEXT NOT NULL,
      provider_group TEXT NOT NULL,
      category       TEXT,
      reason         TEXT,
      reacher_status TEXT,
      attempts       INTEGER NOT NULL DEFAULT 0,
      smtp_code      INTEGER,
      message        TEXT,
      updated_at     BIGINT NOT NULL,
      raw_json       TEXT,
      PRIMARY KEY (job_id, email)
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_created_at
      ON jobs (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_candidates_upload_email
      ON candidates (upload_id, email);
    CREATE INDEX IF NOT EXISTS idx_candidates_upload_domain
      ON candidates (upload_id, domain);
    CREATE INDEX IF NOT EXISTS idx_results_job_category_email
      ON results (job_id, category, email);
    CREATE INDEX IF NOT EXISTS idx_results_job_group_email
      ON results (job_id, provider_group, email);
    CREATE INDEX IF NOT EXISTS idx_results_job_updated_at
      ON results (job_id, updated_at DESC, email);
    CREATE INDEX IF NOT EXISTS idx_results_email_trgm
      ON results USING GIN (email gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_results_domain_trgm
      ON results USING GIN (domain gin_trgm_ops);
  `);
}

export async function databaseHealthy(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
