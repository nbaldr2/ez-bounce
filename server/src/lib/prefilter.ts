import fs from 'node:fs';
import { parse } from 'csv-parse';
import { config } from '../config.js';
import { DISPOSABLE_DOMAINS } from '../data/disposable-domains.js';
import { isRoleAddress } from '../data/role-accounts.js';
import { dedupeKey, parseEmail } from './email.js';
import { groupForDomain } from './providers.js';
import type { PrefilterReport, PrefilterVerdict, ProviderGroup } from '../types.js';

// ---------------------------------------------------------------------------
// Domain deny lists
// ---------------------------------------------------------------------------

function loadDisposable(): Set<string> {
  const set = new Set<string>(DISPOSABLE_DOMAINS.map((d) => d.toLowerCase()));
  const file = process.env.DISPOSABLE_DOMAINS_FILE;
  if (file) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      let added = 0;
      for (const line of text.split(/\r?\n/)) {
        const d = line.trim().toLowerCase();
        if (d && !d.startsWith('#') && !set.has(d)) {
          set.add(d);
          added += 1;
        }
      }
      console.log(`[prefilter] loaded ${added} extra disposable domains from ${file}`);
    } catch (err) {
      console.warn(`[prefilter] could not read DISPOSABLE_DOMAINS_FILE: ${(err as Error).message}`);
    }
  }
  return set;
}

const disposableDomains = loadDisposable();

const blockedDomains = new Set(
  config.blockedDomains
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
);

/** Matches the domain itself and any subdomain of it (`a.mailinator.com`). */
function inDomainSet(domain: string, set: Set<string>): boolean {
  if (set.has(domain)) return true;
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i += 1) {
    if (set.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

export function isDisposableDomain(domain: string): boolean {
  return inDomainSet(domain, disposableDomains);
}

export function isBlockedDomain(domain: string): boolean {
  return blockedDomains.size > 0 && inDomainSet(domain, blockedDomains);
}

// ---------------------------------------------------------------------------
// CSV reading + email column detection
// ---------------------------------------------------------------------------

const EMAIL_HEADER_HINTS = [
  'email',
  'e-mail',
  'e mail',
  'mail',
  'emailaddress',
  'email_address',
  'email address',
  'correo',
  'courriel',
  'mailadresse',
  'e_mail',
];

function headerScore(header: string): number {
  const h = header.trim().toLowerCase();
  if (h === 'email' || h === 'e-mail' || h === 'email_address' || h === 'emailaddress') return 100;
  for (const hint of EMAIL_HEADER_HINTS) {
    if (h === hint) return 90;
  }
  for (const hint of EMAIL_HEADER_HINTS) {
    if (h.includes(hint)) return 60;
  }
  return 0;
}

/** Sniffs the most likely delimiter from the header line. */
function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const c of candidates) {
    const count = firstLine.split(c).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  return best;
}

export interface CsvScan {
  columns: string[];
  delimiter: string;
  /** Column chosen for emails, or null when nothing looked like an address. */
  emailColumn: string | null;
  /** Per-column diagnostics so the UI can offer an override. */
  columnStats: Array<{ column: string; sampled: number; emailLike: number; score: number }>;
  sampleRows: Array<Record<string, string>>;
  /** True when the file has no header row and columns are synthetic (col_1...). */
  headerless: boolean;
}

/**
 * Reads the first N rows to pick the email column before committing to a full
 * pass. Detection is content-driven (what fraction of values parse as an email)
 * with header names used only as a tie-breaker, so it works on headerless files
 * and on files where a `notes` column happens to be called "mail".
 */
export async function scanCsv(filePath: string, sampleSize = 200): Promise<CsvScan> {
  const head = await readHead(filePath, 64 * 1024);
  const delimiter = detectDelimiter(head);

  // First pass with no header, so we can decide whether row 1 is a header.
  const raw = await readRows(filePath, delimiter, false, sampleSize + 1);
  if (raw.length === 0) {
    return {
      columns: [],
      delimiter,
      emailColumn: null,
      columnStats: [],
      sampleRows: [],
      headerless: false,
    };
  }

  const first = raw[0]!;
  const width = Math.max(...raw.map((r) => r.length));
  // Row 1 is a header if none of its cells is a valid email and it has no
  // duplicate/empty cells.
  const firstHasEmail = first.some((c) => parseEmail(c ?? '') !== null);
  const firstAllNonEmpty = first.length > 0 && first.every((c) => (c ?? '').trim() !== '');
  const uniqueFirst = new Set(first.map((c) => (c ?? '').trim().toLowerCase())).size === first.length;
  const headerless = firstHasEmail || !firstAllNonEmpty || !uniqueFirst;

  const columns = headerless
    ? Array.from({ length: width }, (_, i) => `col_${i + 1}`)
    : first.map((c, i) => (c.trim() === '' ? `col_${i + 1}` : c.trim()));

  const dataRows = headerless ? raw : raw.slice(1);

  const stats = columns.map((column, idx) => {
    let sampled = 0;
    let emailLike = 0;
    for (const row of dataRows) {
      const cell = row[idx];
      if (cell === undefined || cell.trim() === '') continue;
      sampled += 1;
      if (parseEmail(cell) !== null) emailLike += 1;
    }
    const ratio = sampled > 0 ? emailLike / sampled : 0;
    // Content dominates; the header name only breaks ties.
    const score = ratio * 1000 + headerScore(column) + (sampled > 0 ? 1 : 0);
    return { column, sampled, emailLike, score, ratio };
  });

  const viable = stats.filter((s) => s.ratio >= 0.5 && s.emailLike > 0);
  viable.sort((a, b) => b.score - a.score);
  const emailColumn = viable[0]?.column ?? null;

  const sampleRows = dataRows.slice(0, 5).map((row) => {
    const obj: Record<string, string> = {};
    columns.forEach((c, i) => {
      obj[c] = row[i] ?? '';
    });
    return obj;
  });

  return {
    columns,
    delimiter,
    emailColumn,
    columnStats: stats.map(({ column, sampled, emailLike, score }) => ({
      column,
      sampled,
      emailLike,
      score: Math.round(score),
    })),
    sampleRows,
    headerless,
  };
}

function readHead(filePath: string, bytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { start: 0, end: bytes, encoding: 'utf8' });
    let out = '';
    stream.on('data', (c) => {
      out += c;
    });
    stream.on('end', () => resolve(out));
    stream.on('error', reject);
  });
}

function readRows(
  filePath: string,
  delimiter: string,
  columnsAsHeader: boolean,
  limit: number,
): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const rows: string[][] = [];
    const parser = parse({
      delimiter,
      columns: columnsAsHeader,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      bom: true,
      trim: false,
      to: limit,
    });
    const stream = fs.createReadStream(filePath);
    parser.on('readable', () => {
      let rec: string[] | null;
      while ((rec = parser.read() as string[] | null) !== null) {
        rows.push(rec);
        if (rows.length >= limit) break;
      }
    });
    parser.on('error', reject);
    parser.on('end', () => resolve(rows));
    stream.on('error', reject);
    stream.pipe(parser);
  });
}

// ---------------------------------------------------------------------------
// Prefilter
// ---------------------------------------------------------------------------

export interface PrefilterOptions {
  emailColumn: string;
  columns: string[];
  delimiter: string;
  headerless: boolean;
  dropRole: boolean;
  dropDisposable: boolean;
  /** Keep the full original row alongside the address for labelled exports. */
  keepRow: boolean;
}

export interface KeptAddress {
  email: string;
  domain: string;
  row: Record<string, string> | null;
}

export interface RejectedAddress {
  email: string;
  verdict: PrefilterVerdict;
}

/**
 * Batch sink for prefilter output.
 *
 * Accumulating 100k+ addresses in an array before touching the database costs
 * hundreds of MB on a small VPS, so results are handed over in batches and
 * written as they are produced. Peak memory then depends on the number of
 * *unique* addresses (the dedupe set) rather than on the full row payloads.
 */
export interface PrefilterSink {
  keep(batch: KeptAddress[]): void;
  reject(batch: RejectedAddress[]): void;
}

const SINK_BATCH = 5_000;

export interface PrefilterOutcome {
  report: PrefilterReport;
}

/**
 * Streams the whole file and partitions it into kept vs rejected.
 *
 * Order of checks matters and is deliberate: syntax before dedupe (so garbage
 * cells never occupy a dedupe slot), dedupe before role/disposable (so counts
 * describe unique mailboxes rather than raw rows).
 */
export async function prefilterCsv(
  filePath: string,
  opts: PrefilterOptions,
  sink: PrefilterSink,
): Promise<PrefilterOutcome> {
  const emailIdx = opts.columns.indexOf(opts.emailColumn);
  if (emailIdx < 0) throw new Error(`Column ${opts.emailColumn} not found`);

  const report: PrefilterReport = {
    totalRows: 0,
    emptyRows: 0,
    duplicate: 0,
    invalid_syntax: 0,
    role: 0,
    disposable: 0,
    blocked_domain: 0,
    kept: 0,
    topDomains: [],
    groupCounts: {},
  };

  const seen = new Set<string>();
  let kept: KeptAddress[] = [];
  let rejected: RejectedAddress[] = [];
  const domainCounts = new Map<string, number>();
  const groupCounts = new Map<ProviderGroup, number>();

  const flushKept = (force = false) => {
    if (kept.length >= SINK_BATCH || (force && kept.length > 0)) {
      sink.keep(kept);
      kept = [];
    }
  };
  const flushRejected = (force = false) => {
    if (rejected.length >= SINK_BATCH || (force && rejected.length > 0)) {
      sink.reject(rejected);
      rejected = [];
    }
  };

  await new Promise<void>((resolve, reject) => {
    const parser = parse({
      delimiter: opts.delimiter,
      columns: false,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      bom: true,
      from_line: opts.headerless ? 1 : 2,
    });
    const stream = fs.createReadStream(filePath);

    parser.on('readable', () => {
      let rec: string[] | null;
      while ((rec = parser.read() as string[] | null) !== null) {
        report.totalRows += 1;
        const cell = rec[emailIdx];

        if (cell === undefined || cell.trim() === '') {
          report.emptyRows += 1;
          continue;
        }

        const parsed = parseEmail(cell);
        if (!parsed) {
          report.invalid_syntax += 1;
          rejected.push({ email: cell.trim().slice(0, 320), verdict: 'invalid_syntax' });
          flushRejected();
          continue;
        }

        const key = dedupeKey(parsed);
        if (seen.has(key)) {
          report.duplicate += 1;
          rejected.push({ email: parsed.email, verdict: 'duplicate' });
          flushRejected();
          continue;
        }
        seen.add(key);

        if (isBlockedDomain(parsed.domain)) {
          report.blocked_domain += 1;
          rejected.push({ email: parsed.email, verdict: 'blocked_domain' });
          flushRejected();
          continue;
        }

        if (opts.dropDisposable && isDisposableDomain(parsed.domain)) {
          report.disposable += 1;
          rejected.push({ email: parsed.email, verdict: 'disposable' });
          flushRejected();
          continue;
        }

        if (opts.dropRole && isRoleAddress(parsed.localPart)) {
          report.role += 1;
          rejected.push({ email: parsed.email, verdict: 'role' });
          flushRejected();
          continue;
        }

        let row: Record<string, string> | null = null;
        if (opts.keepRow) {
          row = {};
          opts.columns.forEach((c, i) => {
            const v = rec![i];
            if (v !== undefined && v !== '') row![c] = v;
          });
        }

        kept.push({ email: parsed.email, domain: parsed.domain, row });
        flushKept();
        report.kept += 1;
        domainCounts.set(parsed.domain, (domainCounts.get(parsed.domain) ?? 0) + 1);
        const g = groupForDomain(parsed.domain);
        groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
      }
    });

    parser.on('error', reject);
    parser.on('end', () => resolve());
    stream.on('error', reject);
    stream.pipe(parser);
  });

  flushKept(true);
  flushRejected(true);

  report.topDomains = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([domain, count]) => ({ domain, count }));
  report.groupCounts = Object.fromEntries(groupCounts) as PrefilterReport['groupCounts'];

  return { report };
}
