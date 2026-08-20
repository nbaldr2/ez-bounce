import dns from 'node:dns/promises';
import { config } from '../config.js';
import { keys, redis } from '../redis.js';
import type { ProviderGroup } from '../types.js';

/**
 * Provider bucketing.
 *
 * The unit that rate-limits you is the *receiving mail infrastructure*, not the
 * domain in the address. Every Google Workspace tenant on a custom domain is
 * answered by aspmx.l.google.com and counts against the same per-source-IP
 * budget as gmail.com. If you bucket on the literal string "@gmail.com" you
 * will throttle consumer Gmail correctly and then get 421'd anyway by the
 * thousands of Workspace domains hiding in the "other" pool.
 *
 * So: resolve MX once per domain (cached in Redis), map the MX hostname to a
 * pool, and fall back to the address-domain heuristic when DNS fails.
 */

/** MX hostname suffixes -> pool. Order matters; first match wins. */
const MX_SUFFIX_GROUPS: ReadonlyArray<[string, ProviderGroup]> = [
  // Google (consumer Gmail + Workspace)
  ['.google.com', 'gmail'],
  ['.googlemail.com', 'gmail'],
  ['.google', 'gmail'],
  ['.psmtp.com', 'gmail'],

  // Microsoft (Outlook consumer + Microsoft 365 + legacy Hotmail)
  ['.outlook.com', 'microsoft'],
  ['.protection.outlook.com', 'microsoft'],
  ['.hotmail.com', 'microsoft'],
  ['.microsoft.com', 'microsoft'],
  ['.office365.us', 'microsoft'],
  ['.mail.protection.outlook.com', 'microsoft'],

  // Yahoo / AOL / Verizon Media, now Yahoo Inc.
  ['.yahoodns.net', 'yahoo'],
  ['.yahoo.com', 'yahoo'],
  ['.aol.com', 'yahoo'],
  ['.att.net', 'yahoo'],

  // Apple iCloud
  ['.icloud.com', 'apple'],
  ['.apple.com', 'apple'],
  ['.mail.me.com', 'apple'],

  // Proton
  ['.protonmail.ch', 'proton'],
  ['.proton.me', 'proton'],
  ['.protonmail.com', 'proton'],
];

/**
 * Address-domain fallback, used at prefilter time (where we want an instant
 * estimate for 100k rows without 100k DNS lookups) and when MX resolution
 * fails at verification time.
 */
const DOMAIN_GROUPS: Readonly<Record<string, ProviderGroup>> = {
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'google.com': 'gmail',
  'outlook.com': 'microsoft',
  'outlook.fr': 'microsoft',
  'outlook.de': 'microsoft',
  'outlook.es': 'microsoft',
  'outlook.it': 'microsoft',
  'outlook.co.uk': 'microsoft',
  'hotmail.com': 'microsoft',
  'hotmail.co.uk': 'microsoft',
  'hotmail.fr': 'microsoft',
  'hotmail.de': 'microsoft',
  'hotmail.it': 'microsoft',
  'hotmail.es': 'microsoft',
  'live.com': 'microsoft',
  'live.co.uk': 'microsoft',
  'live.fr': 'microsoft',
  'live.nl': 'microsoft',
  'msn.com': 'microsoft',
  'passport.com': 'microsoft',
  'yahoo.com': 'yahoo',
  'yahoo.co.uk': 'yahoo',
  'yahoo.fr': 'yahoo',
  'yahoo.de': 'yahoo',
  'yahoo.it': 'yahoo',
  'yahoo.es': 'yahoo',
  'yahoo.ca': 'yahoo',
  'yahoo.com.au': 'yahoo',
  'yahoo.co.jp': 'yahoo',
  'ymail.com': 'yahoo',
  'rocketmail.com': 'yahoo',
  'aol.com': 'yahoo',
  'aim.com': 'yahoo',
  'icloud.com': 'apple',
  'me.com': 'apple',
  'mac.com': 'apple',
  'protonmail.com': 'proton',
  'protonmail.ch': 'proton',
  'proton.me': 'proton',
  'pm.me': 'proton',
};

/** Synchronous, DNS-free bucketing. Used for prefilter estimates. */
export function groupForDomain(domain: string): ProviderGroup {
  return DOMAIN_GROUPS[domain.toLowerCase()] ?? 'other';
}

function groupForMxHosts(hosts: string[]): ProviderGroup | null {
  for (const host of hosts) {
    const h = `.${host.toLowerCase().replace(/\.$/, '')}`;
    for (const [suffix, group] of MX_SUFFIX_GROUPS) {
      if (h.endsWith(suffix)) return group;
    }
  }
  return null;
}

export interface GroupResolution {
  group: ProviderGroup;
  /** How we decided: useful for debugging a mis-bucketed domain. */
  via: 'cache' | 'mx' | 'domain' | 'disabled';
  mx: string[];
}

/**
 * Resolves the pool for a domain, caching per domain so a 100k list of Gmail
 * addresses performs exactly one DNS query.
 */
export async function resolveGroup(domain: string): Promise<GroupResolution> {
  const d = domain.toLowerCase();

  if (config.disableMxGrouping) {
    return { group: groupForDomain(d), via: 'disabled', mx: [] };
  }

  // A well-known consumer domain never needs a lookup.
  const known = DOMAIN_GROUPS[d];
  if (known) return { group: known, via: 'domain', mx: [] };

  const cacheKey = keys.mx(d);
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as { group: ProviderGroup; mx: string[] };
      return { group: parsed.group, via: 'cache', mx: parsed.mx };
    }
  } catch {
    // Cache problems must never block verification.
  }

  let mxHosts: string[] = [];
  try {
    const records = await dns.resolveMx(d);
    mxHosts = records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
  } catch {
    // NXDOMAIN / no MX / timeout: fall back to the domain heuristic. Reacher
    // will independently report `no_mx` if the domain truly cannot receive.
    mxHosts = [];
  }

  const group = groupForMxHosts(mxHosts) ?? groupForDomain(d);

  try {
    await redis.set(
      cacheKey,
      JSON.stringify({ group, mx: mxHosts.slice(0, 5) }),
      'EX',
      config.mxCacheTtlSeconds,
    );
  } catch {
    // Non-fatal.
  }

  return { group, via: mxHosts.length > 0 ? 'mx' : 'domain', mx: mxHosts };
}
