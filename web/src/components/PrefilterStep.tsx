import type { PrefilterReport } from '../types.ts';
import { Badge, Button, Card, Toggle, fmt } from './ui.tsx';

/**
 * Step 2: the pre-SMTP filter review.
 *
 * This screen exists to answer one question before any SMTP budget is spent:
 * "how many addresses am I actually about to verify, and what got dropped?"
 * Every number here is computed locally — no MX traffic has happened yet.
 */
export function PrefilterStep({
  report,
  options,
  onOptionsChange,
  onStart,
  onReanalyze,
  busy,
  starting,
}: {
  report: PrefilterReport;
  options: { dropRole: boolean; dropDisposable: boolean; keepColumns: boolean };
  onOptionsChange: (o: { dropRole: boolean; dropDisposable: boolean; keepColumns: boolean }) => void;
  onStart: () => void;
  onReanalyze: () => void;
  busy: boolean;
  starting: boolean;
}) {
  const removed =
    report.duplicate +
    report.invalid_syntax +
    report.role +
    report.disposable +
    report.blocked_domain +
    report.emptyRows;

  const rows: Array<{ label: string; value: number; note: string }> = [
    { label: 'Rows in file', value: report.totalRows, note: 'every data row read' },
    { label: 'Empty email cell', value: report.emptyRows, note: 'nothing to check' },
    {
      label: 'Invalid syntax',
      value: report.invalid_syntax,
      note: 'cannot be a mailbox — no SMTP needed',
    },
    {
      label: 'Duplicates',
      value: report.duplicate,
      note: 'Gmail dots/+tags normalised before comparing',
    },
    { label: 'Role accounts', value: report.role, note: 'info@, support@, noreply@ …' },
    { label: 'Disposable domains', value: report.disposable, note: 'mailinator, guerrillamail …' },
    { label: 'Blocked domains', value: report.blocked_domain, note: 'from BLOCKED_DOMAINS env' },
  ];

  const gmailish = report.groupCounts.gmail ?? 0;
  const gmailPct = report.kept > 0 ? Math.round((gmailish / report.kept) * 100) : 0;

  return (
    <Card
      title="2 · Pre-filter review"
      subtitle="Cheap local checks first. Only what survives here costs an SMTP conversation."
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <div className="overflow-hidden rounded-lg border border-slate-800">
            <table className="w-full text-sm">
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={r.label}
                    className={i === 0 ? 'bg-slate-900/80' : 'border-t border-slate-800'}
                  >
                    <td className="px-4 py-2 text-slate-300">
                      {r.label}
                      <span className="ml-2 text-xs text-slate-500">{r.note}</span>
                    </td>
                    <td className="tnum px-4 py-2 text-right font-medium text-slate-200">
                      {i === 0 ? fmt(r.value) : r.value > 0 ? `−${fmt(r.value)}` : '0'}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-emerald-900 bg-emerald-950/30">
                  <td className="px-4 py-3 font-semibold text-emerald-300">
                    To verify over SMTP
                    <span className="ml-2 text-xs font-normal text-emerald-500/70">
                      {report.totalRows > 0
                        ? `${Math.round((report.kept / report.totalRows) * 100)}% of the file`
                        : ''}
                    </span>
                  </td>
                  <td className="tnum px-4 py-3 text-right text-lg font-bold text-emerald-300">
                    {fmt(report.kept)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="text-xs text-slate-500">
            {fmt(removed)} addresses removed before touching a mail server.
          </p>

          {report.topDomains.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                Top domains to verify
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {report.topDomains.map((d) => (
                  <span
                    key={d.domain}
                    className="rounded-md bg-slate-800/80 px-2 py-1 text-xs text-slate-300"
                  >
                    {d.domain} <span className="tnum text-slate-500">{fmt(d.count)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-5">
          <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/40 p-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Filter options
            </h3>
            <Toggle
              checked={options.dropRole}
              onChange={(v) => onOptionsChange({ ...options, dropRole: v })}
              label="Drop role accounts"
              description="Shared aliases are deliverable but hurt sender reputation."
            />
            <Toggle
              checked={options.dropDisposable}
              onChange={(v) => onOptionsChange({ ...options, dropDisposable: v })}
              label="Drop disposable domains"
              description="Throwaway inboxes — valid today, gone tomorrow."
            />
            <Toggle
              checked={options.keepColumns}
              onChange={(v) => onOptionsChange({ ...options, keepColumns: v })}
              label="Keep other CSV columns"
              description="Lets the export carry names, companies, etc. through."
            />
            <Button variant="ghost" onClick={onReanalyze} disabled={busy} className="w-full">
              {busy ? 'Re-analysing…' : 'Re-run pre-filter'}
            </Button>
          </div>

          {gmailish > 0 && (
            <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-4 text-xs text-amber-200">
              <p className="font-semibold">
                {gmailPct}% of this list is Google-hosted ({fmt(gmailish)} addresses).
              </p>
              <p className="mt-1.5 text-amber-200/80">
                These are throttled through a single small worker pool on purpose. At the default
                2 workers / 1500&nbsp;ms spacing that is roughly{' '}
                <strong>{fmt(Math.round(gmailish / 1.33 / 60))} minutes</strong> for the Google
                portion alone. Other providers drain in parallel, so total runtime is set by
                whichever pool is slowest.
              </p>
            </div>
          )}

          <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              Provider pools
            </h3>
            <ul className="space-y-1.5 text-xs">
              {Object.entries(report.groupCounts)
                .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                .map(([g, n]) => (
                  <li key={g} className="flex items-center justify-between">
                    <Badge tone={g === 'gmail' ? 'warn' : 'muted'}>{g}</Badge>
                    <span className="tnum text-slate-400">{fmt(n ?? 0)}</span>
                  </li>
                ))}
            </ul>
            <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500">
              Estimated from the address domain. At job start each domain's MX is resolved, so
              Google Workspace and Microsoft 365 custom domains move into their real pool.
            </p>
          </div>

          <Button
            onClick={onStart}
            disabled={report.kept === 0 || starting || busy}
            className="w-full"
          >
            {starting ? 'Starting…' : `Start verifying ${fmt(report.kept)} addresses →`}
          </Button>
        </div>
      </div>
    </Card>
  );
}
