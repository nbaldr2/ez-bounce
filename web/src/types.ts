/** Mirrors server/src/types.ts. */

export type Category = 'valid' | 'invalid' | 'catch_all' | 'unknown';

export const CATEGORIES: Category[] = ['valid', 'invalid', 'catch_all', 'unknown'];

export type ProviderGroup = 'gmail' | 'microsoft' | 'yahoo' | 'apple' | 'proton' | 'other';

export const PROVIDER_GROUPS: ProviderGroup[] = [
  'gmail',
  'microsoft',
  'yahoo',
  'apple',
  'proton',
  'other',
];

export type JobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'cancelled';

/** Persisted job metadata used by the main list-history dashboard. */
export interface JobListItem {
  id: string;
  uploadId: string;
  filename: string;
  status: JobStatus;
  total: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface PrefilterReport {
  totalRows: number;
  emptyRows: number;
  duplicate: number;
  invalid_syntax: number;
  role: number;
  disposable: number;
  blocked_domain: number;
  kept: number;
  topDomains: Array<{ domain: string; count: number }>;
  groupCounts: Partial<Record<ProviderGroup, number>>;
}

export interface UploadScan {
  uploadId: string;
  filename: string;
  sizeBytes: number;
  columns: string[];
  delimiter: string;
  emailColumn: string | null;
  columnStats: Array<{ column: string; sampled: number; emailLike: number; score: number }>;
  sampleRows: Array<Record<string, string>>;
  headerless: boolean;
}

export interface AnalyzeResponse {
  uploadId: string;
  emailColumn: string;
  report: PrefilterReport;
  options: { dropRole: boolean; dropDisposable: boolean; keepColumns: boolean };
}

export interface JobCounts {
  valid: number;
  invalid: number;
  catch_all: number;
  unknown: number;
  done: number;
  tempFailEvents: number;
  retryPending: number;
  pending: number;
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
  rate: number;
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
  reason: string;
  reacherStatus: string | null;
  attempts: number;
  smtpCode: number | null;
  message: string | null;
  updatedAt: number;
}

export interface PerGroupSettings {
  concurrency: number;
  delayMs: number;
}

export interface Settings {
  groups: Record<ProviderGroup, PerGroupSettings>;
  retryBackoffMs: number[];
  reacherTimeoutMs: number;
  fullInboxAsCatchAll: boolean;
}

export interface HealthResponse {
  ok: boolean;
  redis: boolean;
  reacher: { ok: boolean; detail: string };
  reacherUrl: string;
  workers: boolean;
}
