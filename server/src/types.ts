/**
 * Shared domain types. Mirrored by web/src/types.ts (kept in sync by hand —
 * the two packages build independently so they can be deployed separately).
 */

/**
 * Terminal verification categories. These are the only values ever persisted
 * to `results.category`.
 *
 * `temp_fail` is deliberately NOT in this union: a temp-fail is a transient
 * state that lives in the queue (as a delayed retry), never a stored verdict.
 * Once the backoff schedule is exhausted the address lands in `unknown` with
 * reason `temp_fail_exhausted`, so a mail server having a bad afternoon can
 * never be misreported as a hard bounce.
 */
export type Category = 'valid' | 'invalid' | 'catch_all' | 'unknown';

export const CATEGORIES: readonly Category[] = ['valid', 'invalid', 'catch_all', 'unknown'];

/** Why an address ended up in its category. Surfaced in the UI + CSV export. */
export type Reason =
  | 'deliverable'
  | 'catch_all'
  | 'full_inbox'
  | 'disabled'
  | 'invalid_syntax'
  | 'no_mx'
  | 'rejected'
  | 'temp_fail_exhausted'
  | 'greylisted'
  | 'ip_blocked'
  | 'connection_error'
  | 'reacher_error'
  | 'cancelled'
  | 'unknown';

/**
 * Provider pools. Addresses are bucketed by the *MX host* they resolve to, not
 * by the domain in the address, because Google Workspace / Microsoft 365 custom
 * domains share the same MX infrastructure — and therefore the same
 * per-source-IP rate limits — as gmail.com / outlook.com.
 */
export type ProviderGroup = 'gmail' | 'microsoft' | 'yahoo' | 'apple' | 'proton' | 'other';

export const PROVIDER_GROUPS: readonly ProviderGroup[] = [
  'gmail',
  'microsoft',
  'yahoo',
  'apple',
  'proton',
  'other',
];

export type JobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'cancelled';

/** Outcome buckets from the pre-SMTP filter stage. */
export type PrefilterVerdict =
  | 'kept'
  | 'duplicate'
  | 'invalid_syntax'
  | 'role'
  | 'disposable'
  | 'blocked_domain';

export interface PrefilterReport {
  totalRows: number;
  /** Rows where the email cell was empty/whitespace. */
  emptyRows: number;
  duplicate: number;
  invalid_syntax: number;
  role: number;
  disposable: number;
  blocked_domain: number;
  /** Addresses that survive and will actually be sent to Reacher. */
  kept: number;
  /** Top domains among kept addresses, for a sanity check before spending SMTP budget. */
  topDomains: Array<{ domain: string; count: number }>;
  /** Kept-address counts per provider pool, so you can predict runtime. */
  groupCounts: Partial<Record<ProviderGroup, number>>;
}

export interface PerGroupSettings {
  /** Size of the worker pool for this provider. */
  concurrency: number;
  /** Minimum spacing between request *starts* across the whole pool, in ms. */
  delayMs: number;
}

export interface Settings {
  groups: Record<ProviderGroup, PerGroupSettings>;
  /** Backoff schedule for temp-fails, in ms. Length = number of retries. */
  retryBackoffMs: number[];
  /** Per-request timeout against the Reacher sidecar. */
  reacherTimeoutMs: number;
  /** Treat `risky`+full-inbox as catch-all rather than unknown. */
  fullInboxAsCatchAll: boolean;
}

export interface JobCounts {
  valid: number;
  invalid: number;
  catch_all: number;
  unknown: number;
  /** Terminal addresses (sum of the four categories above). */
  done: number;
  /** Cumulative count of 4xx/transient responses seen, including re-tries. */
  tempFailEvents: number;
  /** Addresses currently sitting in a delayed retry slot. */
  retryPending: number;
  /** Addresses in the queue not yet terminal. */
  pending: number;
  /** Currently in flight. */
  active: number;
}

export interface JobStatusResponse {
  id: string;
  uploadId: string;
  status: JobStatus;
  total: number;
  counts: JobCounts;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Addresses verified per second, averaged over the run. */
  rate: number;
  /** Seconds remaining at the current rate, or null if not yet estimable. */
  etaSeconds: number | null;
  prefilter: PrefilterReport | null;
  perGroup: Array<{
    group: ProviderGroup;
    waiting: number;
    active: number;
    delayed: number;
    concurrency: number;
    delayMs: number;
    paused: boolean;
  }>;
}

export interface ResultRow {
  email: string;
  domain: string;
  group: ProviderGroup;
  category: Category;
  reason: Reason;
  /** Raw `is_reachable` value from Reacher, for auditing. */
  reacherStatus: string | null;
  /** How many times we asked Reacher about this address. */
  attempts: number;
  smtpCode: number | null;
  message: string | null;
  updatedAt: number;
}
