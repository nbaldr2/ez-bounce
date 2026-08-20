/**
 * Email syntax validation.
 *
 * Deliberately stricter than RFC 5322 (which permits quoted local-parts,
 * comments and IP-literal domains that no real marketing list contains) and
 * looser than a naive `\S+@\S+`. The goal is to reject only what an MX server
 * would certainly reject, since every address that passes here costs an SMTP
 * conversation.
 */

const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export interface ParsedEmail {
  email: string;
  localPart: string;
  domain: string;
}

/** Trims, lowercases and strips `mailto:` / surrounding punctuation. */
export function normalizeEmail(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  s = s.replace(/^mailto:/i, '');
  // Strip stray wrapping quotes from spreadsheet exports.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  // Trailing list separators left behind by hand-edited CSVs.
  s = s.replace(/[;,]+$/, '').trim();
  return s.toLowerCase();
}

export function parseEmail(raw: string): ParsedEmail | null {
  const email = normalizeEmail(raw);
  if (email.length === 0 || email.length > 254) return null;

  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;

  const localPart = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (localPart.length > 64) return null;
  if (!LOCAL_RE.test(localPart)) return null;

  if (domain.length > 253) return null;
  if (domain.startsWith('.') || domain.endsWith('.')) return null;
  if (domain.includes('..')) return null;

  const labels = domain.split('.');
  // Require a TLD: no `user@localhost` in a mailing list.
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!LABEL_RE.test(label)) return null;
  }

  const tld = labels[labels.length - 1]!;
  // TLDs are alphabetic and at least two characters.
  if (!/^[A-Za-z]{2,63}$/.test(tld)) return null;

  return { email, localPart, domain };
}

export function isValidSyntax(raw: string): boolean {
  return parseEmail(raw) !== null;
}

/**
 * Canonical form used for deduplication.
 *
 * Gmail ignores dots and everything after `+` in the local-part, so
 * `john.doe+news@gmail.com` and `johndoe@gmail.com` are the same mailbox and
 * must not both be verified. We only apply that rule to Google-operated
 * consumer domains, because dot-collapsing is provider-specific: on most hosts
 * `john.doe@` and `johndoe@` are genuinely different people.
 */
const GOOGLE_CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const PLUS_ADDRESSING_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'fastmail.com',
  'protonmail.com',
  'proton.me',
  'icloud.com',
  'yahoo.com',
]);

export function dedupeKey(parsed: ParsedEmail): string {
  let local = parsed.localPart;
  const domain = parsed.domain;

  if (PLUS_ADDRESSING_DOMAINS.has(domain)) {
    local = local.split('+')[0] ?? local;
  }
  if (GOOGLE_CONSUMER_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    return `${local}@gmail.com`;
  }
  return `${local}@${domain}`;
}
