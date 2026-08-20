import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { Category, JobStatusResponse, ProviderGroup, ResultRow } from '../types.ts';
import { CATEGORIES, PROVIDER_GROUPS } from '../types.ts';
import {
  Badge,
  Button,
  Card,
  Stat,
  categoryLabel,
  categoryTone,
  fmt,
  fmtDuration,
} from './ui.tsx';

const PAGE = 50;

/** Step 4 + 5: results dashboard with a filterable table and CSV export. */
export function ResultsDashboard({
  status,
  onBack,
}: {
  status: JobStatusResponse;
  onBack: () => void;
}) {
  const jobId = status.id;
  const { counts } = status;

  const [category, setCategory] = useState<Category | 'all'>('all');
  const [group, setGroup] = useState<ProviderGroup | 'all'>('all');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [byReason, setByReason] = useState<Array<{ category: string; reason: string; n: number }>>(
    [],
  );
  const [includeColumns, setIncludeColumns] = useState(false);

  // Debounce the search box so typing doesn't fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.results(jobId, {
        category,
        group,
        q: debounced,
        limit: PAGE,
        offset: page * PAGE,
      });
      setRows(res.rows);
      setTotalRows(res.total);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [jobId, category, group, debounced, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api
      .summary(jobId)
      .then((s) => setByReason(s.byReason))
      .catch(() => undefined);
  }, [jobId, status.status]);

  const pages = Math.ceil(totalRows / PAGE);
  const deliverablePct =
    counts.done > 0 ? ((counts.valid / counts.done) * 100).toFixed(1) : '0.0';
  const retryExhausted = byReason
    .filter((r) => r.reason === 'temp_fail_exhausted')
    .reduce((n, r) => n + r.n, 0);
  const ipBlocked = byReason.filter((r) => r.reason === 'ip_blocked').reduce((n, r) => n + r.n, 0);

  const elapsed =
    status.startedAt && status.finishedAt ? (status.finishedAt - status.startedAt) / 1000 : null;

  return (
    <div className="space-y-6">
      <Card
        title="4 · Results"
        subtitle={
          status.status === 'completed'
            ? `Finished in ${fmtDuration(elapsed)} · ${status.rate.toFixed(2)} addresses/sec`
            : `Job is ${status.status} — showing what has been verified so far`
        }
        right={
          <Button variant="ghost" onClick={onBack}>
            Back to lists
          </Button>
        }
      >
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Valid" value={counts.valid} tone="good" hint={`${deliverablePct}% of checked`} />
            <Stat label="Invalid" value={counts.invalid} tone="bad" hint="will hard-bounce" />
            <Stat
              label="Catch-all"
              value={counts.catch_all}
              tone="warn"
              hint="domain accepts everything"
            />
            <Stat label="Unknown" value={counts.unknown} tone="info" hint="no verdict reached" />
            <Stat
              label="Retries used"
              value={counts.tempFailEvents}
              hint="4xx responses re-queued"
            />
          </div>

          {(retryExhausted > 0 || ipBlocked > 0) && (
            <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-200">
              {retryExhausted > 0 && (
                <p>
                  <span className="tnum font-semibold">{fmt(retryExhausted)}</span> addresses
                  exhausted the retry schedule and are recorded as <strong>unknown</strong>, not
                  invalid — the receiving server kept deferring us. Re-running just those later
                  often resolves them.
                </p>
              )}
              {ipBlocked > 0 && (
                <p className={retryExhausted > 0 ? 'mt-1.5' : ''}>
                  <span className="tnum font-semibold">{fmt(ipBlocked)}</span> responses looked like
                  an <strong>IP-level block</strong> rather than a bad mailbox. Check the VPS PTR
                  record and whether the IP is on a blocklist.
                </p>
              )}
            </div>
          )}

          {byReason.length > 0 && (
            <details className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
              <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-slate-400">
                Breakdown by reason
              </summary>
              <div className="mt-3 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {byReason.map((r) => (
                  <div
                    key={`${r.category}-${r.reason}`}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="flex items-center gap-1.5">
                      <Badge
                        tone={categoryTone[r.category as Category] ?? 'muted'}
                      >
                        {r.category}
                      </Badge>
                      <span className="text-slate-400">{r.reason}</span>
                    </span>
                    <span className="tnum text-slate-300">{fmt(r.n)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* ---- export ---- */}
          <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4">
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-400">
              5 · Export
            </h3>
            <label className="mb-3 flex cursor-pointer items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={includeColumns}
                onChange={(e) => setIncludeColumns(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 accent-emerald-500"
              />
              Include the other columns from the original CSV
            </label>
            <div className="flex flex-wrap gap-2">
              <a
                href={api.exportUrl(jobId, 'valid_only', { includeColumns })}
                className="inline-flex items-center rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-400"
              >
                Valid only ({fmt(counts.valid)})
              </a>
              <a
                href={api.exportUrl(jobId, 'safe_to_send', { includeColumns })}
                className="inline-flex items-center rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:border-slate-500 hover:bg-slate-800"
              >
                Valid + catch-all ({fmt(counts.valid + counts.catch_all)})
              </a>
              <a
                href={api.exportUrl(jobId, 'all_labeled', { includeColumns })}
                className="inline-flex items-center rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:border-slate-500 hover:bg-slate-800"
              >
                All with labels ({fmt(counts.done)})
              </a>
              <a
                href={api.exportUrl(jobId, 'all_labeled', {
                  includeColumns,
                  includePrefiltered: true,
                })}
                className="inline-flex items-center rounded-lg border border-slate-800 px-4 py-2 text-sm font-medium text-slate-400 hover:border-slate-600 hover:bg-slate-800"
              >
                All + pre-filtered rows
              </a>
            </div>
          </div>
        </div>
      </Card>

      {/* ---- table ---- */}
      <Card title="Addresses" subtitle={`${fmt(totalRows)} matching`}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search email, domain or reason…"
              className="min-w-56 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
            />
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value as Category | 'all');
                setPage(0);
              }}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
            >
              <option value="all">All categories</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel[c]}
                </option>
              ))}
            </select>
            <select
              value={group}
              onChange={(e) => {
                setGroup(e.target.value as ProviderGroup | 'all');
                setPage(0);
              }}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
            >
              <option value="all">All pools</option>
              {PROVIDER_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900/80 text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                  <th className="px-3 py-2 font-medium">Pool</th>
                  <th className="px-3 py-2 text-right font-medium">Tries</th>
                  <th className="px-3 py-2 text-right font-medium">SMTP</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-500">
                      No addresses match these filters.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr
                    key={r.email}
                    className="border-t border-slate-800 hover:bg-slate-900/50"
                    title={r.message ?? undefined}
                  >
                    <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-slate-200">
                      {r.email}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={categoryTone[r.category] ?? 'muted'}>
                        {categoryLabel[r.category] ?? r.category}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-400">{r.reason}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{r.group}</td>
                    <td className="tnum px-3 py-2 text-right text-xs text-slate-400">
                      {r.attempts}
                    </td>
                    <td className="tnum px-3 py-2 text-right text-xs text-slate-500">
                      {r.smtpCode ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="tnum">
                Page {page + 1} of {fmt(pages)}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="subtle"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0 || loading}
                >
                  Previous
                </Button>
                <Button
                  variant="subtle"
                  onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                  disabled={page >= pages - 1 || loading}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
