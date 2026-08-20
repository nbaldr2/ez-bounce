import type { Category, Reason, Settings } from '../types.js';
import type { ReacherError, ReacherResponse } from './reacher.js';

/**
 * Turns a Reacher response into either a terminal verdict or a "retry this
 * later" signal.
 *
 * The single most important rule in this file: a 4xx SMTP reply is not a verdict.
 * Gmail answers "421 4.7.0 Try again later" / "450 4.2.1 The user you are trying
 * to contact is receiving mail at a rate that prevents additional messages from
 * being delivered" when it dislikes your request *rate*, and both of those
 * strings say nothing whatsoever about whether the mailbox exists. Recording
 * them as `invalid` is how a verification tool silently deletes good addresses
 * from a list. They must be requeued with backoff.
 */

export type Classification =
  | { kind: 'terminal'; category: Category; reason: Reason; smtpCode: number | null; message: string | null }
  | { kind: 'temp_fail'; reason: Reason; smtpCode: number | null; message: string | null };

function isError(v: unknown): v is ReacherError {
  return typeof v === 'object' && v !== null && ('type' in v || 'message' in v);
}

function textValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(' ');
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).map(textValue).filter(Boolean).join(' ');
  }
  return '';
}

function errorText(res: ReacherResponse): string {
  const parts: string[] = [];
  for (const block of [res.error, res.smtp, res.mx, res.misc]) {
    const nested =
      typeof block === 'object' && block !== null && 'error' in block
        ? (block as { error?: unknown }).error
        : undefined;
    for (const candidate of [block, nested]) {
      if (isError(candidate)) {
        if (candidate.type) parts.push(candidate.type);
        const message = textValue(candidate.message);
        const description = textValue(candidate.description);
        if (message) parts.push(message);
        if (description) parts.push(description);
      }
    }
  }
  return parts.join(' | ');
}

/** Pulls a 3-digit SMTP status code out of a free-form error string. */
export function extractSmtpCode(text: string): number | null {
  // Prefer an enhanced status code's leading reply code, e.g. "450 4.2.1 ..."
  const m = text.match(/\b([245]\d{2})\b(?:[ -]\d\.\d\.\d)?/);
  if (!m) return null;
  const code = Number.parseInt(m[1]!, 10);
  return Number.isFinite(code) ? code : null;
}

/**
 * Substrings that indicate rate limiting / greylisting / temporary refusal.
 * Matched case-insensitively against the concatenated Reacher error text.
 */
const TEMP_FAIL_PATTERNS: ReadonlyArray<[RegExp, Reason]> = [
  [/\btry again later\b/i, 'greylisted'],
  [/\btry later\b/i, 'greylisted'],
  [/\bgreylist/i, 'greylisted'],
  [/\bgraylist/i, 'greylisted'],
  [/\bdeferred\b/i, 'greylisted'],
  [/\btemporar/i, 'greylisted'],
  [/\btransient\b/i, 'greylisted'],
  [/\bservice not available\b/i, 'greylisted'],
  [/\btoo many\b/i, 'greylisted'],
  [/\brate limit/i, 'greylisted'],
  [/\brate that prevents\b/i, 'greylisted'],
  [/\bthrottl/i, 'greylisted'],
  [/\bresources temporarily unavailable\b/i, 'greylisted'],
  [/\bmailbox (?:is )?(?:temporarily )?unavailable\b/i, 'greylisted'],
  [/\bconnection (?:reset|closed|refused|timed out|timeout)\b/i, 'connection_error'],
  [/\btimed? ?out\b/i, 'connection_error'],
  [/\bbroken pipe\b/i, 'connection_error'],
  [/\bnetwork (?:is )?unreachable\b/i, 'connection_error'],
  [/\bio error\b/i, 'connection_error'],
  [/\bdisconnected\b/i, 'connection_error'],
  [/\bwebdriver\b/i, 'connection_error'],
];

/**
 * Patterns that mean *this IP* is blocked rather than the address being bad.
 * These are retried too — but they usually mean the operator needs to fix rDNS
 * or slow down, so they are reported under their own reason.
 */
const IP_BLOCK_PATTERNS: readonly RegExp[] = [
  /\bblocked using\b/i,
  /\bblacklist/i,
  /\bblocklist/i,
  /\bspamhaus\b/i,
  /\bbarracuda\b/i,
  /\bnot authorized\b/i,
  /\bclient host rejected\b/i,
  /\baccess denied\b/i,
  /\bunsolicited mail\b/i,
  /\bbad reputation\b/i,
  /\breverse dns\b/i,
  /\brdns\b/i,
  /\bptr record\b/i,
  /\bno reverse\b/i,
  /\bdoes not (?:have|resolve)\b.*\bptr\b/i,
  /\b5\.7\.1\b.*\bnot accepted\b/i,
  /\bunable to add\b.*\bto (?:our )?(?:allow|white)list\b/i,
];

/** Hard, permanent rejections. Safe to record as invalid. */
const HARD_FAIL_PATTERNS: readonly RegExp[] = [
  /\buser (?:unknown|not found)\b/i,
  /\bno such user\b/i,
  /\bno such (?:mailbox|recipient)\b/i,
  /\brecipient (?:address )?rejected\b/i,
  /\bmailbox (?:not found|unavailable|does not exist)\b/i,
  /\baddress (?:not found|does not exist|rejected)\b/i,
  /\binvalid (?:recipient|mailbox|address)\b/i,
  /\bunrouteable address\b/i,
  /\bdoes ?n[o']?t exist\b/i,
];

/**
 * Decides whether an error is transient.
 *
 * Precedence:
 *   1. An explicit 4xx reply code wins outright — that is what the RFC means by
 *      "temporary".
 *   2. An explicit 5xx code with a recognisable hard-fail message is permanent,
 *      but a 5xx that looks like an IP block is retried (a different attempt, or
 *      a fixed PTR record, may succeed).
 *   3. With no code at all, fall back to message pattern matching.
 */
function classifyError(text: string): { temp: boolean; reason: Reason; code: number | null } {
  const code = extractSmtpCode(text);

  if (code !== null && code >= 400 && code < 500) {
    const ipBlocked = IP_BLOCK_PATTERNS.some((re) => re.test(text));
    return { temp: true, reason: ipBlocked ? 'ip_blocked' : 'greylisted', code };
  }

  if (code !== null && code >= 500) {
    if (IP_BLOCK_PATTERNS.some((re) => re.test(text))) {
      return { temp: true, reason: 'ip_blocked', code };
    }
    if (HARD_FAIL_PATTERNS.some((re) => re.test(text))) {
      return { temp: false, reason: 'rejected', code };
    }
    // An unrecognised 5xx is permanent by definition.
    return { temp: false, reason: 'rejected', code };
  }

  if (IP_BLOCK_PATTERNS.some((re) => re.test(text))) {
    return { temp: true, reason: 'ip_blocked', code };
  }
  for (const [re, reason] of TEMP_FAIL_PATTERNS) {
    if (re.test(text)) return { temp: true, reason, code };
  }
  if (HARD_FAIL_PATTERNS.some((re) => re.test(text))) {
    return { temp: false, reason: 'rejected', code };
  }

  return { temp: false, reason: 'unknown', code };
}

export function classify(res: ReacherResponse, settings: Settings): Classification {
  const text = errorText(res);
  const smtp = isError(res.smtp) ? undefined : res.smtp;
  const mx = isError(res.mx) ? undefined : res.mx;
  const reachable = res.is_reachable;

  // Syntax should already have been caught in the prefilter, but Reacher is the
  // authority if it disagrees.
  if (res.syntax?.is_valid_syntax === false) {
    return {
      kind: 'terminal',
      category: 'invalid',
      reason: 'invalid_syntax',
      smtpCode: null,
      message: null,
    };
  }

  // A domain with no MX cannot receive mail at all. Permanent.
  if (mx && mx.accepts_mail === false && (mx.records?.length ?? 0) === 0) {
    return { kind: 'terminal', category: 'invalid', reason: 'no_mx', smtpCode: null, message: null };
  }

  switch (reachable) {
    case 'safe':
      return {
        kind: 'terminal',
        category: 'valid',
        reason: 'deliverable',
        smtpCode: null,
        message: null,
      };

    case 'risky': {
      if (smtp?.is_catch_all) {
        return {
          kind: 'terminal',
          category: 'catch_all',
          reason: 'catch_all',
          smtpCode: null,
          message: null,
        };
      }
      if (smtp?.is_disabled) {
        // A disabled/suspended mailbox will hard-bounce.
        return {
          kind: 'terminal',
          category: 'invalid',
          reason: 'disabled',
          smtpCode: null,
          message: null,
        };
      }
      if (smtp?.has_full_inbox) {
        return settings.fullInboxAsCatchAll
          ? {
              kind: 'terminal',
              category: 'catch_all',
              reason: 'full_inbox',
              smtpCode: null,
              message: null,
            }
          : {
              kind: 'terminal',
              category: 'unknown',
              reason: 'full_inbox',
              smtpCode: null,
              message: null,
            };
      }
      return {
        kind: 'terminal',
        category: 'catch_all',
        reason: 'catch_all',
        smtpCode: null,
        message: text || null,
      };
    }

    case 'invalid': {
      // Reacher says invalid — but verify the underlying reply really was
      // permanent before we act on it.
      const { temp, reason, code } = classifyError(text);
      if (temp) {
        return { kind: 'temp_fail', reason, smtpCode: code, message: text || null };
      }
      return {
        kind: 'terminal',
        category: 'invalid',
        reason: reason === 'unknown' ? 'rejected' : reason,
        smtpCode: code,
        message: text || null,
      };
    }

    case 'unknown':
    default: {
      const { temp, reason, code } = classifyError(text);
      if (temp) {
        return { kind: 'temp_fail', reason, smtpCode: code, message: text || null };
      }
      // Reacher couldn't reach a conclusion and the error isn't recognisably
      // transient. Retry once via the normal schedule only if we saw nothing at
      // all (empty error), since a silent failure is usually a connection issue.
      if (text.trim() === '') {
        return {
          kind: 'temp_fail',
          reason: 'connection_error',
          smtpCode: null,
          message: null,
        };
      }
      return {
        kind: 'terminal',
        category: 'unknown',
        reason: reason === 'rejected' ? 'rejected' : 'unknown',
        smtpCode: code,
        message: text || null,
      };
    }
  }
}
