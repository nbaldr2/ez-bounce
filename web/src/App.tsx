import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import type {
  AnalyzeResponse,
  HealthResponse,
  JobStatusResponse,
  UploadScan,
} from './types.ts';
import { UploadStep } from './components/UploadStep.tsx';
import { PrefilterStep } from './components/PrefilterStep.tsx';
import { ProgressStep } from './components/ProgressStep.tsx';
import { ResultsDashboard } from './components/ResultsDashboard.tsx';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { Badge, Button, ErrorBanner } from './components/ui.tsx';

type FilterOptions = { dropRole: boolean; dropDisposable: boolean; keepColumns: boolean };

const POLL_MS = 2000;
const JOB_KEY = 'ezd.activeJobId';

export function App() {
  const [scan, setScan] = useState<UploadScan | null>(null);
  const [emailColumn, setEmailColumn] = useState<string>('');
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [options, setOptions] = useState<FilterOptions>({
    dropRole: true,
    dropDisposable: true,
    keepColumns: true,
  });
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatusResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const pollRef = useRef<number | null>(null);

  // Health is polled slowly; it's how the operator notices the Reacher sidecar
  // died rather than every address mysteriously coming back unknown.
  useEffect(() => {
    const tick = () => void api.health().then(setHealth).catch(() => setHealth(null));
    tick();
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, []);

  // Survive a page refresh mid-run: a 100k Gmail-heavy job can take hours.
  useEffect(() => {
    const saved = localStorage.getItem(JOB_KEY);
    if (saved) {
      api
        .jobStatus(saved)
        .then((s) => {
          setJobId(s.id);
          setStatus(s);
        })
        .catch(() => localStorage.removeItem(JOB_KEY));
    }
  }, []);

  /** Polls /jobs/:id/status every 2s until the job reaches a terminal state. */
  useEffect(() => {
    if (!jobId) return;

    const stop = () => {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    const tick = async () => {
      try {
        const s = await api.jobStatus(jobId);
        setStatus(s);
        if (s.status === 'completed' || s.status === 'cancelled') stop();
      } catch (err) {
        setError((err as Error).message);
      }
    };

    void tick();
    pollRef.current = window.setInterval(() => void tick(), POLL_MS);
    return stop;
  }, [jobId]);

  const runAnalyze = useCallback(
    async (uploadId: string, column: string, opts: FilterOptions) => {
      setAnalysing(true);
      setError(null);
      try {
        const res = await api.analyze(uploadId, { emailColumn: column, ...opts });
        setAnalysis(res);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setAnalysing(false);
      }
    },
    [],
  );

  const onUploadReady = useCallback(
    (s: UploadScan, column: string) => {
      setScan(s);
      setEmailColumn(column);
      void runAnalyze(s.uploadId, column, options);
    },
    [options, runAnalyze],
  );

  const startJob = useCallback(async () => {
    if (!analysis) return;
    setStarting(true);
    setError(null);
    try {
      const { jobId: id } = await api.startJob(analysis.uploadId);
      localStorage.setItem(JOB_KEY, id);
      setJobId(id);
      setStatus(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }, [analysis]);

  const control = useCallback(
    async (action: 'pause' | 'resume' | 'cancel') => {
      if (!jobId) return;
      setControlBusy(true);
      try {
        await api.control(jobId, action);
        setStatus(await api.jobStatus(jobId));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setControlBusy(false);
      }
    },
    [jobId],
  );

  const reset = useCallback(() => {
    localStorage.removeItem(JOB_KEY);
    setScan(null);
    setEmailColumn('');
    setAnalysis(null);
    setJobId(null);
    setStatus(null);
    setError(null);
  }, []);

  const finished = status?.status === 'completed' || status?.status === 'cancelled';
  const hasProgress = status !== null && status.counts.done > 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-50">ez-debounce</h1>
          <p className="mt-1 text-sm text-slate-400">
            Self-hosted bulk email verification · Reacher + rate-limited worker pools
          </p>
        </div>
        <div className="flex items-center gap-3">
          {health && (
            <div className="flex items-center gap-1.5 text-xs">
              <Badge tone={health.reacher.ok ? 'good' : 'bad'}>
                reacher {health.reacher.ok ? 'up' : 'down'}
              </Badge>
              <Badge tone={health.redis ? 'good' : 'bad'}>
                redis {health.redis ? 'up' : 'down'}
              </Badge>
            </div>
          )}
          <Button variant="ghost" onClick={() => setSettingsOpen(true)}>
            Settings
          </Button>
        </div>
      </header>

      {health && !health.reacher.ok && (
        <div className="mb-6">
          <ErrorBanner
            message={`The Reacher sidecar at ${health.reacherUrl} is not responding (${health.reacher.detail}). Verification will return "unknown" for every address until it is back. Check: docker compose logs reacher`}
          />
        </div>
      )}

      {error && (
        <div className="mb-6">
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      <div className="space-y-6">
        {!jobId && (
          <>
            <UploadStep onReady={onUploadReady} disabled={analysing} />
            {analysis && (
              <PrefilterStep
                report={analysis.report}
                options={options}
                onOptionsChange={(o) => {
                  setOptions(o);
                  if (scan) void runAnalyze(scan.uploadId, emailColumn, o);
                }}
                onStart={() => void startJob()}
                onReanalyze={() => {
                  if (scan) void runAnalyze(scan.uploadId, emailColumn, options);
                }}
                busy={analysing}
                starting={starting}
              />
            )}
          </>
        )}

        {jobId && status && !finished && (
          <ProgressStep
            status={status}
            onPause={() => void control('pause')}
            onResume={() => void control('resume')}
            onCancel={() => void control('cancel')}
            busy={controlBusy}
          />
        )}

        {jobId && !status && (
          <p className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
            Queueing addresses and resolving MX records…
          </p>
        )}

        {jobId && status && (finished || hasProgress) && (
          <ResultsDashboard status={status} onReset={reset} />
        )}
      </div>

      <footer className="mt-12 border-t border-slate-800 pt-5 text-xs leading-relaxed text-slate-500">
        <p>
          Reliable results against Gmail require a <strong>PTR / reverse-DNS record</strong> on this
          VPS's outbound IP, and outbound port 25 unblocked. Without rDNS, Google will answer with
          4xx deferrals that this tool will correctly report as <em>unknown</em> rather than invalid
          — accurate, but not useful. See the README.
        </p>
      </footer>

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
