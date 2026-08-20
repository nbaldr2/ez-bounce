import type { JobStatusResponse } from '../types.ts';
import { Badge, Button, Card, Stat, fmt, fmtDuration } from './ui.tsx';

/**
 * Step 3: live progress.
 *
 * The per-pool table is the operationally important part: it shows Gmail's
 * queue draining at its own throttled pace alongside the fast pools, plus the
 * delayed (retry-waiting) count so a rising temp-fail rate is visible
 * immediately rather than at the end of the run.
 */
export function ProgressStep({
  status,
  onPause,
  onResume,
  onCancel,
  onBack,
  busy,
}: {
  status: JobStatusResponse;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onBack: () => void;
  busy: boolean;
}) {
  const { counts, total } = status;
  const pct = total > 0 ? Math.min(100, (counts.done / total) * 100) : 0;
  const running = status.status === 'running' || status.status === 'queued';

  const tempFailRate = counts.done > 0 ? counts.tempFailEvents / counts.done : 0;
  const hot = tempFailRate > 0.15;

  return (
    <Card
      title="3 · Verifying"
      subtitle={`Job ${status.id.slice(0, 8)} · ${status.status}`}
      right={
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onBack}>
            Back to lists
          </Button>
          {running ? (
            <Button variant="ghost" onClick={onPause} disabled={busy}>
              Pause
            </Button>
          ) : status.status === 'paused' ? (
            <Button variant="primary" onClick={onResume} disabled={busy}>
              Resume
            </Button>
          ) : null}
          {status.status !== 'completed' && status.status !== 'cancelled' && (
            <Button variant="danger" onClick={onCancel} disabled={busy}>
              Stop
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        <div>
          <div className="mb-2 flex items-baseline justify-between text-sm">
            <span className="tnum font-medium text-slate-200">
              {fmt(counts.done)} / {fmt(total)}
            </span>
            <span className="tnum text-slate-400">
              {pct.toFixed(1)}% · {status.rate.toFixed(2)}/s ·{' '}
              {status.etaSeconds !== null ? `ETA ${fmtDuration(status.etaSeconds)}` : 'ETA —'}
            </span>
          </div>
          <div
            className="h-3 w-full overflow-hidden rounded-full bg-slate-800"
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                status.status === 'paused' ? 'bg-amber-500' : 'bg-emerald-500'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Valid" value={counts.valid} tone="good" />
          <Stat label="Invalid" value={counts.invalid} tone="bad" />
          <Stat label="Catch-all" value={counts.catch_all} tone="warn" />
          <Stat label="Unknown" value={counts.unknown} tone="info" />
          <Stat
            label="Awaiting retry"
            value={counts.retryPending}
            tone={counts.retryPending > 0 ? 'warn' : 'neutral'}
            hint="temp-failed, sitting in backoff"
          />
          <Stat label="In flight" value={counts.active} />
        </div>

        {counts.tempFailEvents > 0 && (
          <div
            className={`rounded-lg border p-3 text-xs ${
              hot
                ? 'border-amber-800 bg-amber-950/40 text-amber-200'
                : 'border-slate-800 bg-slate-950/40 text-slate-400'
            }`}
          >
            <span className="tnum font-semibold">{fmt(counts.tempFailEvents)}</span> temporary
            failures (4xx) seen so far — {(tempFailRate * 100).toFixed(1)}% of completed checks.
            {hot && (
              <>
                {' '}
                <strong>That is high.</strong> Lower the concurrency or raise the delay for the
                affected pool in Settings; the change applies to this running job. Also confirm the
                VPS has a valid PTR record.
              </>
            )}
            {!hot && ' These are being retried with backoff, not counted as invalid.'}
          </div>
        )}

        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
            Worker pools
          </h3>
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/80 text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Pool</th>
                  <th className="px-3 py-2 text-right font-medium">Queued</th>
                  <th className="px-3 py-2 text-right font-medium">Active</th>
                  <th className="px-3 py-2 text-right font-medium">Retry wait</th>
                  <th className="px-3 py-2 text-right font-medium">Concurrency</th>
                  <th className="px-3 py-2 text-right font-medium">Delay</th>
                  <th className="px-3 py-2 text-right font-medium">Max rate</th>
                </tr>
              </thead>
              <tbody>
                {status.perGroup.map((g) => {
                  const idle = g.waiting + g.active + g.delayed === 0;
                  const maxRate = g.delayMs > 0 ? 1000 / g.delayMs : Infinity;
                  return (
                    <tr
                      key={g.group}
                      className={`border-t border-slate-800 ${idle ? 'opacity-40' : ''}`}
                    >
                      <td className="px-3 py-2">
                        <Badge tone={g.group === 'gmail' ? 'warn' : 'muted'}>{g.group}</Badge>
                        {g.paused && <span className="ml-2 text-amber-400">paused</span>}
                      </td>
                      <td className="tnum px-3 py-2 text-right text-slate-300">{fmt(g.waiting)}</td>
                      <td className="tnum px-3 py-2 text-right text-slate-300">{fmt(g.active)}</td>
                      <td
                        className={`tnum px-3 py-2 text-right ${
                          g.delayed > 0 ? 'text-amber-300' : 'text-slate-500'
                        }`}
                      >
                        {fmt(g.delayed)}
                      </td>
                      <td className="tnum px-3 py-2 text-right text-slate-300">{g.concurrency}</td>
                      <td className="tnum px-3 py-2 text-right text-slate-300">{g.delayMs}ms</td>
                      <td className="tnum px-3 py-2 text-right text-slate-500">
                        {Number.isFinite(maxRate) ? `${maxRate.toFixed(2)}/s` : 'unlimited'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Queue depth is per pool and shared across jobs. Max rate is the pacing ceiling
            (1000/delay); actual throughput is the lower of that and concurrency ÷ SMTP latency.
          </p>
        </div>
      </div>
    </Card>
  );
}
