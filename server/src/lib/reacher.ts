import { config } from '../config.js';

/**
 * Minimal typing of the Reacher `POST /v0/check_email` response.
 * Fields are all optional because the shape varies by how far the check got
 * (a syntax failure returns no `smtp` block at all) and across Reacher versions.
 */
export interface ReacherResponse {
  input?: string;
  is_reachable?: 'safe' | 'risky' | 'invalid' | 'unknown' | string;
  misc?:
    | {
        is_disposable?: boolean;
        is_role_account?: boolean;
        gravatar_url?: string | null;
      }
    | ReacherError;
  mx?:
    | {
        accepts_mail?: boolean;
        records?: string[];
      }
    | ReacherError;
  smtp?:
    | {
        can_connect_smtp?: boolean;
        has_full_inbox?: boolean;
        is_catch_all?: boolean;
        is_deliverable?: boolean;
        is_disabled?: boolean;
      }
    | ReacherError;
  syntax?: {
    address?: string | null;
    domain?: string;
    is_valid_syntax?: boolean;
    username?: string;
  };
  error?: ReacherError;
}

export interface ReacherError {
  type?: string;
  message?: string;
  description?: string;
}

export class ReacherHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'ReacherHttpError';
  }
}

export class ReacherUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReacherUnavailableError';
  }
}

/**
 * Calls the Reacher sidecar for one address.
 *
 * Network-level failures and 5xx/429 responses from Reacher itself are raised
 * as errors (the caller treats them as transient, since they say nothing about
 * the address). A 200 response is returned verbatim for classification.
 */
export async function checkEmail(email: string, timeoutMs: number): Promise<ReacherResponse> {
  const url = `${config.reacherUrl}/v0/check_email`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.reacherSecret) headers['x-reacher-secret'] = config.reacherSecret;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to_email: email }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    const kind = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'network';
    throw new ReacherUnavailableError(`Reacher ${kind} for ${email}: ${e.message}`);
  }

  const text = await res.text();

  if (!res.ok) {
    throw new ReacherHttpError(
      `Reacher returned HTTP ${res.status} for ${email}`,
      res.status,
      text.slice(0, 500),
    );
  }

  try {
    return JSON.parse(text) as ReacherResponse;
  } catch {
    throw new ReacherHttpError(
      `Reacher returned unparseable JSON for ${email}`,
      res.status,
      text.slice(0, 500),
    );
  }
}

/** Liveness probe used by /api/health and at boot. */
export async function reacherHealthy(timeoutMs = 5_000): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${config.reacherUrl}/v0/check_email`, {
      method: 'OPTIONS',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Any HTTP answer means the process is up and listening.
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
