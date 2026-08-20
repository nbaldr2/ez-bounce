import { useCallback, useRef, useState } from 'react';
import { api } from '../api.ts';
import type { UploadScan } from '../types.ts';
import { Button, Card, ErrorBanner, fmtBytes } from './ui.tsx';

/**
 * Step 1: drag/drop a CSV, then confirm the auto-detected email column.
 *
 * Detection is done server-side on a 200-row sample and is content-driven, so
 * the dropdown is only an override — but it is always shown, because a silently
 * wrong column choice would waste the entire SMTP budget on garbage.
 */
export function UploadStep({
  onReady,
  disabled,
}: {
  onReady: (scan: UploadScan, emailColumn: string) => void;
  disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [scan, setScan] = useState<UploadScan | null>(null);
  const [emailColumn, setEmailColumn] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setUploading(true);
    setProgress(0);
    setScan(null);
    try {
      const result = await api.upload(file, setProgress);
      setScan(result);
      setEmailColumn(result.emailColumn ?? '');
      if (!result.emailColumn) {
        setError(
          'No column looked like an email address. Pick the right column below, or check the delimiter.',
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  return (
    <Card title="1 · Upload list" subtitle="CSV, TSV or a plain newline-delimited .txt file.">
      <div className="space-y-4">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
            dragging
              ? 'border-emerald-500 bg-emerald-950/30'
              : 'border-slate-700 bg-slate-950/40 hover:border-slate-500'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.tsv,.txt,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
          <p className="text-sm font-medium text-slate-200">
            {uploading ? `Uploading… ${progress}%` : 'Drop a CSV here, or click to browse'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Nothing is sent to any third party — verification runs on this server.
          </p>
          {uploading && (
            <div className="mt-4 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>

        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        {scan && (
          <div className="space-y-4 rounded-lg border border-slate-800 bg-slate-950/40 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-medium text-slate-200">{scan.filename}</span>
              <span className="text-slate-500">
                {fmtBytes(scan.sizeBytes)} · delimiter{' '}
                <code className="rounded bg-slate-800 px-1">
                  {scan.delimiter === '\t' ? '\\t' : scan.delimiter}
                </code>
                {scan.headerless && ' · no header row detected'}
              </span>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">
                Email column
              </label>
              <select
                value={emailColumn}
                onChange={(e) => setEmailColumn(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
              >
                <option value="">— select a column —</option>
                {scan.columnStats.map((s) => {
                  const pct = s.sampled > 0 ? Math.round((s.emailLike / s.sampled) * 100) : 0;
                  return (
                    <option key={s.column} value={s.column}>
                      {s.column} — {pct}% of {s.sampled} sampled values parse as email
                    </option>
                  );
                })}
              </select>
              {scan.emailColumn && (
                <p className="mt-1.5 text-xs text-emerald-400">
                  Auto-detected <strong>{scan.emailColumn}</strong>
                  {emailColumn !== scan.emailColumn && ' (overridden)'}
                </p>
              )}
            </div>

            {scan.sampleRows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-500">
                    <tr>
                      {scan.columns.slice(0, 6).map((c) => (
                        <th key={c} className="px-2 py-1 font-medium">
                          {c === emailColumn ? (
                            <span className="text-emerald-400">{c} ●</span>
                          ) : (
                            c
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="text-slate-400">
                    {scan.sampleRows.map((row, i) => (
                      <tr key={i} className="border-t border-slate-800/60">
                        {scan.columns.slice(0, 6).map((c) => (
                          <td key={c} className="max-w-[16rem] truncate px-2 py-1">
                            {row[c] ?? ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <Button
              onClick={() => scan && emailColumn && onReady(scan, emailColumn)}
              disabled={!emailColumn || disabled}
            >
              Analyse list →
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
