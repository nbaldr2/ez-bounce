import type { ReactNode } from 'react';

export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

export function fmtDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Card({
  title,
  subtitle,
  right,
  children,
  className = '',
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg shadow-black/20 ${className}`}
    >
      {(title || right) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="text-base font-semibold text-slate-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-sm text-slate-400">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  type = 'button',
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle';
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40';
  const variants = {
    primary: 'bg-emerald-500 text-emerald-950 hover:bg-emerald-400',
    ghost: 'border border-slate-700 text-slate-200 hover:border-slate-500 hover:bg-slate-800',
    danger: 'border border-red-900 bg-red-950/60 text-red-300 hover:bg-red-900/60',
    subtle: 'bg-slate-800 text-slate-200 hover:bg-slate-700',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Stat({
  label,
  value,
  tone = 'neutral',
  hint,
}: {
  label: string;
  value: string | number;
  tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'info';
  hint?: string;
}) {
  const tones = {
    neutral: 'border-slate-800 bg-slate-900/80 text-slate-100',
    good: 'border-emerald-900/60 bg-emerald-950/40 text-emerald-300',
    bad: 'border-red-900/60 bg-red-950/40 text-red-300',
    warn: 'border-amber-900/60 bg-amber-950/40 text-amber-300',
    info: 'border-sky-900/60 bg-sky-950/40 text-sky-300',
  };
  return (
    <div className={`rounded-lg border p-3 ${tones[tone]}`} title={hint}>
      <div className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</div>
      <div className="tnum mt-1 text-2xl font-semibold">
        {typeof value === 'number' ? fmt(value) : value}
      </div>
      {hint && <div className="mt-1 text-xs opacity-60">{hint}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'info' | 'muted';
}) {
  const tones = {
    neutral: 'bg-slate-800 text-slate-300',
    good: 'bg-emerald-950 text-emerald-300 ring-1 ring-emerald-900',
    bad: 'bg-red-950 text-red-300 ring-1 ring-red-900',
    warn: 'bg-amber-950 text-amber-300 ring-1 ring-amber-900',
    info: 'bg-sky-950 text-sky-300 ring-1 ring-sky-900',
    muted: 'bg-slate-900 text-slate-500 ring-1 ring-slate-800',
  };
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-600 bg-slate-800 accent-emerald-500"
      />
      <span>
        <span className="block text-sm text-slate-200">{label}</span>
        {description && <span className="block text-xs text-slate-500">{description}</span>}
      </span>
    </label>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-200">
      <span className="whitespace-pre-wrap">{message}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 text-red-400 hover:text-red-200">
          dismiss
        </button>
      )}
    </div>
  );
}

export const categoryTone = {
  valid: 'good',
  invalid: 'bad',
  catch_all: 'warn',
  unknown: 'info',
} as const;

export const categoryLabel = {
  valid: 'Valid',
  invalid: 'Invalid',
  catch_all: 'Catch-all',
  unknown: 'Unknown',
} as const;
