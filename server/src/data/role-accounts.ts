/**
 * Role / functional mailbox local-parts.
 *
 * These are shared team aliases rather than individuals. They are usually
 * deliverable, so an SMTP check will happily call them "valid" — but mailing
 * them is what gets a sending domain reported as spam. Filtering them out
 * before the SMTP stage saves both list quality and verification time.
 */
export const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'abuse',
  'accounting',
  'accounts',
  'admin',
  'administrator',
  'adminstrator',
  'ads',
  'alert',
  'alerts',
  'all',
  'billing',
  'bounce',
  'bounces',
  'bugs',
  'careers',
  'ceo',
  'cfo',
  'clients',
  'compliance',
  'contact',
  'contacts',
  'contacto',
  'customerservice',
  'customersupport',
  'dev',
  'developer',
  'devnull',
  'directory',
  'donotreply',
  'do-not-reply',
  'enquiries',
  'enquiry',
  'everyone',
  'facturation',
  'feedback',
  'finance',
  'ftp',
  'general',
  'help',
  'helpdesk',
  'hostmaster',
  'hr',
  'inbox',
  'info',
  'informacion',
  'information',
  'inquiries',
  'inquiry',
  'invoice',
  'invoices',
  'it',
  'jobs',
  'kontakt',
  'legal',
  'list',
  'listserv',
  'mail',
  'mailer',
  'mailer-daemon',
  'maildaemon',
  'mailerdaemon',
  'marketing',
  'media',
  'members',
  'newsletter',
  'no-reply',
  'noc',
  'noreply',
  'notification',
  'notifications',
  'null',
  'office',
  'onboarding',
  'operations',
  'orders',
  'payments',
  'payroll',
  'postmaster',
  'press',
  'privacy',
  'purchasing',
  'recruitment',
  'root',
  'sales',
  'secretary',
  'security',
  'service',
  'services',
  'spam',
  'staff',
  'subscribe',
  'support',
  'sysadmin',
  'system',
  'team',
  'tech',
  'test',
  'testing',
  'unsubscribe',
  'usenet',
  'uucp',
  'webmaster',
  'welcome',
  'www',
  'www-data',
]);

/**
 * Prefixes that make a mailbox a role account regardless of what follows,
 * e.g. `noreply-bounces@`, `support.eu@`, `info2@`.
 */
const ROLE_PREFIXES: readonly string[] = [
  'no-reply',
  'noreply',
  'donotreply',
  'do-not-reply',
  'mailer-daemon',
  'postmaster',
  'webmaster',
  'abuse',
];

/**
 * Decides whether a local-part is a role/functional address.
 *
 * Sub-addressing (`info+tag@`) and dot-separated suffixes (`sales.uk@`) are
 * normalised first so they cannot be used to slip past the exact-match set.
 */
export function isRoleAddress(localPart: string): boolean {
  const lower = localPart.toLowerCase();

  // Strip +tag sub-addressing.
  const plus = lower.split('+')[0] ?? lower;

  if (ROLE_LOCAL_PARTS.has(plus)) return true;

  for (const prefix of ROLE_PREFIXES) {
    if (plus === prefix) return true;
    // `noreply-2024`, `noreply.eu`, `noreply_list`
    if (plus.startsWith(prefix)) {
      const rest = plus.slice(prefix.length);
      if (rest === '' || /^[-._\d]/.test(rest)) return true;
    }
  }

  // `sales.uk`, `info-team`, `support_2` -> role
  //
  // The head must be at least 4 characters. Short role words like `it` and `hr`
  // are extremely common name fragments, and without this floor `it.smith` and
  // `hr.johnson` — real people — would be silently dropped from the list.
  const tokens = plus.split(/[._-]/);
  const head = tokens[0] ?? plus;
  if (head.length >= 4 && ROLE_LOCAL_PARTS.has(head)) {
    const rest = plus.slice(head.length);
    // Only treat as role when the remainder is a short qualifier, so we don't
    // misclassify real people like `mark.info.hansen`.
    if (rest.length > 0 && rest.length <= 6 && /^[._-][a-z0-9]{1,5}$/.test(rest)) return true;
  }

  // `it.support`, `eu.sales` -> role. A short department/region prefix in front
  // of an unambiguous role word.
  //
  // The 5-character floor on the role word is deliberate. Dropping it to 4
  // would also catch `uk.info`, but it would catch `bob.jobs` too — and Jobs is
  // a real surname, as are Root and Best. Missing a role account costs one
  // wasted SMTP check; dropping a real lead is silent and unrecoverable, so the
  // asymmetry is resolved in favour of keeping the address.
  if (tokens.length === 2) {
    const [first, last] = tokens as [string, string];
    if (first.length <= 3 && last.length >= 5 && ROLE_LOCAL_PARTS.has(last)) return true;
  }

  // Trailing digits on an exact role word: info2, support01
  const stripped = plus.replace(/\d+$/, '');
  if (stripped !== plus && ROLE_LOCAL_PARTS.has(stripped)) return true;

  return false;
}
