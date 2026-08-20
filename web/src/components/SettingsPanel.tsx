import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { ProviderGroup, Settings } from '../types.ts';
import { PROVIDER_GROUPS } from '../types.ts';
import { Button, ErrorBanner, Toggle } from './ui.tsx';

/**
 * Live tuning panel.
 *
 * Everything here is applied to a *running* job: concurrency propagates to the
 * workers within ~2s, and delay / backoff / timeout are read fresh for every
 * address. That is the point — you tune Gmail down the moment 4xx responses
 * start appearing, without losing the job.
 */
export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [defaults, setDefaults] = useState<Settings | null>(null);
  const [backoffText, setBackoffText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    void api
      .getSettings()
      .then((r) => {
        setSettings(r.settings);
        setDefaults(r.envDefaults);
        setBackoffText(r.settings.retryBackoffMs.map((ms) => Math.round(ms / 1000)).join(', '));
      })
      .catch((e) => setError((e as Error).message));
  }, [open]);

  if (!open) return null;

  const setGroup = (g: ProviderGroup, patch: Partial<Settings['groups'][ProviderGroup]>) => {
    setSettings((s) =>
      s ? { ...s, groups: { ...s.groups, [g]: { ...s.groups[g], ...patch } } } : s,
    );
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // Backoff is entered in seconds for readability, stored in ms.
      const backoff = backoffText
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((s) => s * 1000);

      const res = await api.patchSettings({ ...settings, retryBackoffMs: backoff });
      setSettings(res.settings);
      setBackoffText(res.settings.retryBackoffMs.map((ms) => Math.round(ms / 1000)).join(', '));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      const res = await api.resetSettings();
      setSettings(res.settings);
      setBackoffText(res.settings.retryBackoffMs.map((ms) => Math.round(ms / 1000)).join(', '));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <aside
        className="h-full w-full max-w-lg overflow-y-auto border-l border-slate-800 bg-slate-950 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Rate limiting</h2>
            <p className="mt-1 text-sm text-slate-400">
              Applies to running jobs — no restart needed.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200">
            close
          </button>
        </header>

        {error && (
          <div className="mb-4">
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </div>
        )}

        {!settings ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <div className="space-y-6">
            <div className="space-y-3">
              {PROVIDER_GROUPS.map((g) => {
                const s = settings.groups[g];
                const maxRate = s.delayMs > 0 ? 1000 / s.delayMs : Infinity;
                const def = defaults?.groups[g];
                const changed = def && (def.concurrency !== s.concurrency || def.delayMs !== s.delayMs);
                return (
                  <div
                    key={g}
                    className={`rounded-lg border p-3 ${
                      g === 'gmail'
                        ? 'border-amber-900/60 bg-amber-950/20'
                        : 'border-slate-800 bg-slate-900/40'
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-200">{g}</span>
                      <span className="tnum text-xs text-slate-500">
                        ceiling {Number.isFinite(maxRate) ? `${maxRate.toFixed(2)}/s` : '∞'}
                        {changed && <span className="ml-2 text-amber-400">modified</span>}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block">
                        <span className="mb-1 block text-xs text-slate-500">
                          Concurrency
                          {def ? ` (env: ${def.concurrency})` : ''}
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={s.concurrency}
                          onChange={(e) =>
                            setGroup(g, { concurrency: Math.max(1, Number(e.target.value) || 1) })
                          }
                          className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs text-slate-500">
                          Delay ms{def ? ` (env: ${def.delayMs})` : ''}
                        </span>
                        <input
                          type="number"
                          min={0}
                          step={50}
                          value={s.delayMs}
                          onChange={(e) =>
                            setGroup(g, { delayMs: Math.max(0, Number(e.target.value) || 0) })
                          }
                          className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
                Retry backoff (seconds, comma separated)
              </span>
              <input
                value={backoffText}
                onChange={(e) => setBackoffText(e.target.value)}
                placeholder="30, 120, 600"
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
              />
              <span className="mt-1 block text-xs text-slate-500">
                A temp-fail waits these intervals in turn. After the last one the address is
                recorded as <strong>unknown</strong> — never invalid.
              </span>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
                Reacher timeout (ms)
              </span>
              <input
                type="number"
                min={1000}
                step={1000}
                value={settings.reacherTimeoutMs}
                onChange={(e) =>
                  setSettings({ ...settings, reacherTimeoutMs: Number(e.target.value) || 45000 })
                }
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
              />
            </label>

            <Toggle
              checked={settings.fullInboxAsCatchAll}
              onChange={(v) => setSettings({ ...settings, fullInboxAsCatchAll: v })}
              label="Count full mailboxes as catch-all"
              description="Off: a full inbox is 'unknown'. The mailbox exists but cannot receive right now."
            />

            <div className="flex gap-2 pt-2">
              <Button onClick={save} disabled={saving}>
                {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Apply now'}
              </Button>
              <Button variant="ghost" onClick={reset} disabled={saving}>
                Reset to env defaults
              </Button>
            </div>

            <p className="text-xs leading-relaxed text-slate-500">
              Concurrency reaches the workers within about 2 seconds. Delay, backoff and timeout are
              read per address, so they take effect on the very next check. Saving also clears the
              pacing timeline, so lowering a delay speeds things up immediately instead of after the
              old reservations drain.
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
