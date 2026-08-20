import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import type { JobListItem, JobStatus, JobStatusResponse } from '../types.ts';
import { Badge, Button, Card, ErrorBanner, fmt, fmtDuration } from './ui.tsx';

const REFRESH_MS = 3000;

function isActive(status: JobStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'paused';
}

function statusTone(status: JobStatus): 'good' | 'bad' | 'warn' | 'info' | 'muted' {
  switch (status) {
    case 'completed':
      return 'good';
    case 'cancelled':
      return 'bad';
    case 'paused':
      return 'warn';
    case 'queued':
    case 'running':
      return 'info';
  }
}

function label(status: JobStatus): string {
  return status === 'queued' ? 'Queueing' : status[0]!.toUpperCase() + status.slice(1);
}

function stamp(time: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(time));
}

/**
 * Server-backed job history. A browser tab is optional: jobs and results live
 * in SQLite/Redis, and this view rebuilds progress from the API every time it
 * opens. Only active or newly discovered jobs are polled after the first load.
 */
export function JobDashboard({
  onSelect,
  onNewList,
}: {
  onSelect: (jobId: string) => void;
  onNewList: () => void;
}) {
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [statuses, setStatuses] = useState<Record<string, JobStatusResponse>>({});
  const statusesRef = useRef<Record<string, JobStatusResponse>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;

    const refresh = async () => {
      try {
        const list = await api.jobs();
        const previous = statusesRef.current;
        const needsStatus = list.jobs.filter((job) => {
          const prior = previous[job.id];
          return !prior || isActive(job.status) || (prior !== undefined && isActive(prior.status));
        });

        const fetched = await Promise.all(
          needsStatus.map(async (job) => {
            try {
              return [job.id, await api.jobStatus(job.id)] as const;
            } catch {
              return null;
            }
          }),
        );
        if (disposed) return;

        const next = { ...previous };
        for (const item of fetched) {
          if (item) next[item[0]] = item[1];
        }
        statusesRef.current = next;
        setJobs(list.jobs);
        setStatuses(next);
        setError(null);
      } catch (err) {
        if (!disposed) setError((err as Error).message);
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="space-y-6">
      <Card
        title="Your lists"
        subtitle="Lists and results are saved on the server. Closing the browser never stops a job."
        right={<Button onClick={onNewList}>New list</Button>}
      >
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        {loading && jobs.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">Loading saved lists…</p>
        ) : jobs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-6 py-12 text-center">
            <p className="text-sm font-medium text-slate-200">No lists yet</p>
            <p className="mt-1 text-sm text-slate-500">Upload a CSV to create your first verification job.</p>
            <Button onClick={onNewList} className="mt-5">
              Upload a CSV
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {jobs.map((job) => {
              const detail = statuses[job.id];
              const currentStatus = detail?.status ?? job.status;
              const done = detail?.counts.done ?? 0;
              const pct = job.total > 0 ? Math.min(100, (done / job.total) * 100) : 0;
              const active = isActive(currentStatus);
              const terminal = currentStatus === 'completed' || currentStatus === 'cancelled';

              return (
                <button
                  key={job.id}
                  onClick={() => onSelect(job.id)}
                  className={`group w-full rounded-xl border p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
                    active
                      ? 'border-sky-900/80 bg-sky-950/20 hover:border-sky-700'
                      : 'border-slate-800 bg-slate-900/50 hover:border-slate-600 hover:bg-slate-900'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-100">{job.filename}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {stamp(job.createdAt)} · Job {job.id.slice(0, 8)}
                      </p>
                    </div>
                    <Badge tone={statusTone(currentStatus)}>{label(currentStatus)}</Badge>
                  </div>

                  <div className="mt-4">
                    <div className="mb-1.5 flex items-baseline justify-between text-xs text-slate-400">
                      <span className="tnum">
                        {detail ? `${fmt(done)} / ${fmt(job.total)} checked` : `${fmt(job.total)} addresses`}
                      </span>
                      {active && detail?.etaSeconds !== null && detail?.etaSeconds !== undefined && (
                        <span className="tnum">ETA {fmtDuration(detail.etaSeconds)}</span>
                      )}
                      {terminal && detail?.finishedAt && <span>{stamp(detail.finishedAt)}</span>}
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          currentStatus === 'paused'
                            ? 'bg-amber-500'
                            : currentStatus === 'cancelled'
                              ? 'bg-red-500'
                              : 'bg-emerald-500'
                        }`}
                        style={{ width: `${terminal && !detail ? 100 : pct}%` }}
                      />
                    </div>
                  </div>

                  {detail && (done > 0 || terminal) && (
                    <div className="tnum mt-3 grid grid-cols-4 gap-2 text-center text-xs">
                      <span className="rounded bg-emerald-950/50 px-1.5 py-1 text-emerald-300">
                        {fmt(detail.counts.valid)} valid
                      </span>
                      <span className="rounded bg-red-950/50 px-1.5 py-1 text-red-300">
                        {fmt(detail.counts.invalid)} invalid
                      </span>
                      <span className="rounded bg-amber-950/50 px-1.5 py-1 text-amber-300">
                        {fmt(detail.counts.catch_all)} catch-all
                      </span>
                      <span className="rounded bg-sky-950/50 px-1.5 py-1 text-sky-300">
                        {fmt(detail.counts.unknown)} unknown
                      </span>
                    </div>
                  )}

                  {active && detail && (
                    <p className="mt-3 text-xs text-sky-300/80">
                      {detail.rate > 0 ? `${detail.rate.toFixed(2)} addresses/sec` : 'Preparing workers…'}
                      {detail.counts.retryPending > 0 &&
                        ` · ${fmt(detail.counts.retryPending)} waiting to retry`}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
