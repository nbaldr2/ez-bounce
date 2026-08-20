import type {
  AnalyzeResponse,
  Category,
  HealthResponse,
  JobListItem,
  JobStatusResponse,
  ProviderGroup,
  ResultRow,
  Settings,
  UploadScan,
} from './types.ts';

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 300) };
  }
  if (!res.ok) {
    const msg =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export const api = {
  async health(): Promise<HealthResponse> {
    return handle(await fetch('/api/health'));
  },

  /** Uploads the CSV and returns column detection results. */
  async upload(file: File, onProgress?: (pct: number) => void): Promise<UploadScan> {
    // XHR rather than fetch: upload progress events matter for a 100k-row file.
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('file', file);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads');
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener('load', () => {
        try {
          const body = JSON.parse(xhr.responseText || '{}');
          if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadScan);
          else reject(new Error(body.error ?? `HTTP ${xhr.status}`));
        } catch {
          reject(new Error(`Bad response (HTTP ${xhr.status})`));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
      xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
      xhr.send(form);
    });
  },

  async analyze(
    uploadId: string,
    opts: { emailColumn: string; dropRole: boolean; dropDisposable: boolean; keepColumns: boolean },
  ): Promise<AnalyzeResponse> {
    return handle(
      await fetch(`/api/uploads/${uploadId}/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opts),
      }),
    );
  },

  async startJob(uploadId: string): Promise<{ jobId: string; total: number }> {
    return handle(
      await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uploadId }),
      }),
    );
  },

  async jobStatus(jobId: string): Promise<JobStatusResponse> {
    return handle(await fetch(`/api/jobs/${jobId}/status`));
  },

  /** Persistent server-side history, newest list first. */
  async jobs(): Promise<{ jobs: JobListItem[] }> {
    return handle(await fetch('/api/jobs'));
  },

  async control(jobId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
    await handle(await fetch(`/api/jobs/${jobId}/${action}`, { method: 'POST' }));
  },

  async results(
    jobId: string,
    params: {
      category?: Category | 'all';
      group?: ProviderGroup | 'all';
      q?: string;
      limit?: number;
      offset?: number;
      sort?: string;
      dir?: 'asc' | 'desc';
    },
  ): Promise<{ total: number; limit: number; offset: number; rows: ResultRow[] }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '' && v !== 'all') qs.set(k, String(v));
    }
    return handle(await fetch(`/api/jobs/${jobId}/results?${qs.toString()}`));
  },

  async summary(jobId: string): Promise<{
    counts: Record<string, number>;
    byReason: Array<{ category: string; reason: string; n: number }>;
    byGroup: Array<{ grp: string; category: string; n: number }>;
  }> {
    return handle(await fetch(`/api/jobs/${jobId}/summary`));
  },

  exportUrl(
    jobId: string,
    mode: 'valid_only' | 'all_labeled' | 'safe_to_send',
    opts: { includeColumns?: boolean; includePrefiltered?: boolean } = {},
  ): string {
    const qs = new URLSearchParams({ mode });
    if (opts.includeColumns) qs.set('includeColumns', 'true');
    if (opts.includePrefiltered) qs.set('includePrefiltered', 'true');
    return `/api/jobs/${jobId}/export?${qs.toString()}`;
  },

  async getSettings(): Promise<{ settings: Settings; envDefaults: Settings }> {
    return handle(await fetch('/api/settings'));
  },

  async patchSettings(patch: unknown): Promise<{ settings: Settings }> {
    return handle(
      await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    );
  },

  async resetSettings(): Promise<{ settings: Settings }> {
    return handle(await fetch('/api/settings/reset', { method: 'POST' }));
  },
};
