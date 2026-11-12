/**
 * The tenant health console (PRD 5.9): which checks exist, as data. No imports. The console sets no thresholds of its own:
 * the account checks are the Account Health deductions of Phase 2 (HEALTH_DEDUCTIONS in analytics.js), read as they stand.
 *
 * The tenant-health module supplies one function per check; each answers { status, detail } and is stopped at CHECK_TIMEOUT_MS,
 * which is recorded as `unreachable` (F-40) and never fails the page. A check runs at most once every CHECK_EVERY_MS per
 * business; asking sooner answers the stored row. The last answer and when it ran are in tenant_health_checks.
 */
export const CHECK_TIMEOUT_MS = 10_000;
export const CHECK_EVERY_MS = 10 * 60_000;

/** Worst first: this order sorts the console's list and decides a business's overall state. */
export const HEALTH_STATUSES = Object.freeze(['bad', 'unreachable', 'warn', 'ok']);
export const severityOf = (status) => {
  const at = HEALTH_STATUSES.indexOf(status);
  return at === -1 ? HEALTH_STATUSES.length : at;
};
export const worstOf = (statuses) => [...statuses].sort((a, b) => severityOf(a) - severityOf(b))[0] ?? 'ok';

/**
 * `source` is what the check reads. `deductions` (account checks only) are the Phase 2 deduction codes it reports: any of
 * `bad` present is bad, any of `warn` is a warning. `ownKeysOnly` checks are skipped for a business on Bhava's own accounts.
 * `notifies` names the notice the owner gets when the check turns bad (F-41).
 */
export const HEALTH_CHECKS = Object.freeze({
  'account.token': Object.freeze({ label: 'Instagram token', source: 'account_health', deductions: Object.freeze({ bad: Object.freeze(['token_rejected', 'token_refresh_failed', 'token_3d']), warn: Object.freeze(['token_14d']) }) }),
  'account.scopes': Object.freeze({ label: 'Permissions', source: 'account_health', deductions: Object.freeze({ bad: Object.freeze(['scope_missing']), warn: Object.freeze([]) }) }),
  'account.api_errors': Object.freeze({ label: 'Meta API errors', source: 'account_health', deductions: Object.freeze({ bad: Object.freeze(['api_errors_20', 'buc_80002']), warn: Object.freeze(['api_errors_5', 'usage_75']) }) }),
  'account.webhooks': Object.freeze({ label: 'Webhooks arriving', source: 'account_health', deductions: Object.freeze({ bad: Object.freeze([]), warn: Object.freeze(['no_webhooks_72h']) }) }),
  'account.policy': Object.freeze({ label: 'Messaging policy and reach', source: 'account_health', deductions: Object.freeze({ bad: Object.freeze(['messaging_policy']), warn: Object.freeze(['reach_guard_tripped']) }) }),
  'account.graph': Object.freeze({ label: 'Graph API reachable', source: 'meta' }),
  'domain.dns': Object.freeze({ label: 'Domain', source: 'dns' }),
  'domain.tls': Object.freeze({ label: 'Certificate', source: 'tls' }),
  'keys.payments': Object.freeze({ label: 'Own payment keys', source: 'provider', ownKeysOnly: true, notifies: 'reconnect.payments' }),
  'keys.shipping': Object.freeze({ label: 'Own courier account', source: 'provider', ownKeysOnly: true, notifies: 'reconnect.shipping' }),
});
export const HEALTH_CHECK_NAMES = Object.freeze(Object.keys(HEALTH_CHECKS));

/** The state of an account check from the deduction codes Account Health holds for the business today. */
export function statusFromDeductions(check, codes) {
  const has = (list) => list.some((code) => codes.includes(code));
  const rule = HEALTH_CHECKS[check]?.deductions;
  if (!rule) throw new Error(`"${check}" is not an Account Health check`);
  return has(rule.bad) ? 'bad' : has(rule.warn) ? 'warn' : 'ok';
}

/** True when a stored row is recent enough that the check must not run again yet. `at` is the row's last_ran_at. */
export const ranRecently = (at, now = Date.now()) => Boolean(at) && now - new Date(at).getTime() < CHECK_EVERY_MS;

/**
 * Worst first, for the console's list: by the worst check, then by the Account Health score (lowest first, none last),
 * then by name so the order is stable. Each item is { worst, score, name }.
 */
export function compareHealth(a, b) {
  const bySeverity = severityOf(a.worst) - severityOf(b.worst);
  if (bySeverity) return bySeverity;
  const score = (item) => (typeof item.score === 'number' ? item.score : 101);
  return score(a) - score(b) || String(a.name).localeCompare(String(b.name));
}

/** Runs `check()` and answers its result, or { status: 'unreachable' } when it has not answered in time or throws. Never rejects. */
export function withinTimeout(check, ms = CHECK_TIMEOUT_MS) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 'unreachable', detail: { reason: 'timeout' } }), ms);
  });
  const ran = Promise.resolve().then(check).catch(() => ({ status: 'unreachable', detail: { reason: 'error' } }));
  return Promise.race([ran, late]).finally(() => clearTimeout(timer));
}
