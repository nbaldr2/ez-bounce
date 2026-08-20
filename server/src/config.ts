import path from 'node:path';
import type { PerGroupSettings, ProviderGroup, Settings } from './types.js';
import { PROVIDER_GROUPS } from './types.js';

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Env ${name} must be an integer, got ${JSON.stringify(v)}`);
  }
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function intList(name: string, fallback: number[]): number[] {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const parts = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number.parseInt(s, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`Env ${name} must be a comma-separated list of ms values, got ${v}`);
      }
      return n;
    });
  return parts.length > 0 ? parts : fallback;
}

/**
 * Per-provider defaults. Gmail is intentionally the most conservative: a single
 * VPS IP talking to Google's MX will start collecting 421/450 responses well
 * before it saturates any other provider. concurrency=2 with 1.5s spacing is
 * roughly 1.3 addresses/sec — slow, but it is the difference between a clean
 * run and a tarpitted IP.
 */
const GROUP_DEFAULTS: Record<ProviderGroup, PerGroupSettings> = {
  gmail: { concurrency: 2, delayMs: 1500 },
  microsoft: { concurrency: 3, delayMs: 1000 },
  yahoo: { concurrency: 2, delayMs: 1200 },
  apple: { concurrency: 2, delayMs: 1200 },
  proton: { concurrency: 3, delayMs: 500 },
  other: { concurrency: 8, delayMs: 100 },
};

function groupSettingsFromEnv(): Record<ProviderGroup, PerGroupSettings> {
  const out = {} as Record<ProviderGroup, PerGroupSettings>;
  for (const g of PROVIDER_GROUPS) {
    const prefix = g.toUpperCase();
    const d = GROUP_DEFAULTS[g];
    out[g] = {
      concurrency: int(`${prefix}_CONCURRENCY`, d.concurrency),
      delayMs: int(`${prefix}_DELAY_MS`, d.delayMs),
    };
  }
  return out;
}

const dataDir = str('DATA_DIR', path.resolve(process.cwd(), 'data'));

export const config = {
  port: int('PORT', 3000),
  redisUrl: str('REDIS_URL', 'redis://127.0.0.1:6379'),
  reacherUrl: str('REACHER_URL', 'http://127.0.0.1:8080').replace(/\/+$/, ''),
  /** Sent as `x-reacher-secret` when set (matches RCH__HEADER_SECRET on the sidecar). */
  reacherSecret: str('REACHER_HEADER_SECRET', ''),
  dataDir,
  /** PostgreSQL is mandatory for high-volume candidate/result storage. */
  databaseUrl: str('DATABASE_URL', 'postgresql://ezdebounce:ezdebounce@127.0.0.1:5432/ezdebounce'),
  /** Shared API + workers connection budget. PostgreSQL enforces the real limit. */
  dbPoolMax: int('DB_POOL_MAX', 24),
  dbStatementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', 60_000),
  uploadTmpDir: str('UPLOAD_TMP_DIR', path.join(dataDir, 'tmp')),
  maxUploadMb: int('MAX_UPLOAD_MB', 250),
  /** Serve the built React app from here when it exists. */
  webDist: str('WEB_DIST', path.resolve(process.cwd(), '../web/dist')),
  /** Set false in the API-only container if you ever split web/worker roles. */
  runWorkers: bool('RUN_WORKERS', true),
  /** Extra domains to drop during prefilter, comma separated. */
  blockedDomains: str('BLOCKED_DOMAINS', ''),
  /** Skip MX resolution and bucket purely on the address domain. */
  disableMxGrouping: bool('DISABLE_MX_GROUPING', false),
  mxCacheTtlSeconds: int('MX_CACHE_TTL_SECONDS', 24 * 60 * 60),
  /** Maximum outstanding BullMQ address jobs. Remaining candidates stay in PostgreSQL. */
  queueWindow: int('QUEUE_WINDOW', 50_000),
  /** Number of candidates admitted to Redis in one dispatcher pass. */
  dispatchPage: int('DISPATCH_PAGE', 10_000),
  defaults: {
    groups: groupSettingsFromEnv(),
    /** 30s, then 2m, then 10m, then give up and record `unknown`. */
    retryBackoffMs: intList('RETRY_BACKOFF_MS', [30_000, 120_000, 600_000]),
    reacherTimeoutMs: int('REACHER_TIMEOUT_MS', 45_000),
    fullInboxAsCatchAll: bool('FULL_INBOX_AS_CATCH_ALL', false),
  } satisfies Settings,
};

export type Config = typeof config;
