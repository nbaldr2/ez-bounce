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
import { JobDashboard } from './components/JobDashboard.tsx';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { Badge, Button, ErrorBanner } from './components/ui.tsx';

type FilterOptions = { dropRole: boolean; dropDisposable: boolean; keepColumns: boolean };
type View = 'lists' | 'new' | 'job';

const POLL_MS = 2000;

export function App() {
  const [view, setView] = useState<View>('lists');
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

  // Health is polled slowly; it shows immediately when the Reacher sidecar or
  // Redis is unavailable without affecting the server-side verification job.
  useEffect(() => {
    const tick = () => void api.health().then(setHealth).catch(() => setHealth(null));
    tick();
    const timer = window.setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, []);

  /** Polls the selected job only. All jobs themselves continue in BullMQ/Redis. */
  useEffect(() => {
    if (view !== 'job' || !jobId) return;

    const stop = () => {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    const tick = async () => {
      try {
        const next = await api.jobStatus(jobId);
        setStatus(next);
        if (next.status === 'completed' || next.status === 'cancelled') stop();
      } catch (err) {
        setError((err as Error).message);
      }
    };

    void tick();
    pollRef.current = window.setInterval(() => void tick(), POLL_MS);
    return stop;
  }, [jobId, view]);

  const showLists = useCallback(() => {
    setView('lists');
    setJobId(null);
    setStatus(null);
    setError(null);
  }, []);

  const showNewList = useCallback(() => {
    setScan(null);
    setEmailColumn('');
    setAnalysis(null);
    setJobId(null);
    setStatus(null);
    setError(null);
    setView('new');
  }, []);

  const selectJob = useCallback((id: string) => {
    setJobId(id);
    setStatus(null);
    setError(null);
    setView('job');
  }, []);

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
    (nextScan: UploadScan, column: string) => {
      setScan(nextScan);
      setEmailColumn(column);
      void runAnalyze(nextScan.uploadId, column, options);
    },
    [options, runAnalyze],
  );

  const startJob = useCallback(async () => {
    if (!analysis) return;
    setStarting(true);
    setError(null);
    try {
      const { jobId: id } = await api.startJob(analysis.uploadId);
      setJobId(id);
      setStatus(null);
      setView('job');
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

  const finished = status?.status === 'completed' || status?.status === 'cancelled';
  const hasProgress = status !== null && status.counts.done > 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <button onClick={showLists} className="text-left focus:outline-none focus:ring-2 focus:ring-emerald-500">
          <h1 className="text-2xl font-bold tracking-tight text-slate-50">ez-debounce</h1>
          <p className="mt-1 text-sm text-slate-400">
            Self-hosted bulk email verification · Reacher + rate-limited worker pools
          </p>
        </button>
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
          {view !== 'lists' && (
            <Button variant="ghost" onClick={showLists}>
              Lists
            </Button>
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
        {view === 'lists' && <JobDashboard onSelect={selectJob} onNewList={showNewList} />}

        {view === 'new' && (
          <>
            <UploadStep onReady={onUploadReady} disabled={analysing} />
            {analysis && (
              <PrefilterStep
                report={analysis.report}
                options={options}
                onOptionsChange={(nextOptions) => {
                  setOptions(nextOptions);
                  if (scan) void runAnalyze(scan.uploadId, emailColumn, nextOptions);
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

        {view === 'job' && jobId && status && !finished && (
          <ProgressStep
            status={status}
            onPause={() => void control('pause')}
            onResume={() => void control('resume')}
            onCancel={() => void control('cancel')}
            onBack={showLists}
            busy={controlBusy}
          />
        )}

        {view === 'job' && jobId && !status && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
            <p>Loading job status and queue progress…</p>
            <Button variant="ghost" onClick={showLists} className="mt-4">
              Back to lists
            </Button>
          </div>
        )}

        {view === 'job' && jobId && status && (finished || hasProgress) && (
          <ResultsDashboard status={status} onBack={showLists} />
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
