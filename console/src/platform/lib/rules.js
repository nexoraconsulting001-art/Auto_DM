// The Platform Console's plain rules, with no React in them, so a test can run them under node.

export const REASON_MAX = 500;
/** The same order as HEALTH_STATUSES in src/contracts/health.js: worst first (a test keeps the two in step). */
export const HEALTH_ORDER = Object.freeze(['bad', 'unreachable', 'warn', 'ok']);
export const OPERATOR_TARGET_MS = 10 * 60_000;
export const ACTIVE_GAP_MS = 2 * 60_000;

/** '' when the reason will do, else what to tell the person. Every action that needs a reason checks this before it sends. */
export function reasonProblem(text) {
  const value = String(text ?? '').trim();
  if (!value) return 'Give a reason';
  if (value.length > REASON_MAX) return `The reason is at most ${REASON_MAX} characters`;
  return '';
}

/** Never the whole of a secret: its first four characters and dots for the rest, or only dots when it is short. */
export function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 8) return '•'.repeat(text.length);
  return `${text.slice(0, 4)}${'•'.repeat(Math.min(text.length - 4, 12))}`;
}

/** An address that carries a one-time token in its path or query, with the token masked. */
export function maskLink(url) {
  const text = String(url ?? '');
  const match = /^(.*?)([?#/])([A-Za-z0-9_=&.%-]{12,})$/.exec(text);
  if (!match) return text;
  return `${match[1]}${match[2]}${maskSecret(match[3])}`;
}

const severity = (status) => {
  const at = HEALTH_ORDER.indexOf(status);
  return at === -1 ? HEALTH_ORDER.length : at;
};

/** Health rows, worst first, then the lowest score first, then by name. The server sorts too; this keeps a page right after a refresh. */
export function worstFirst(rows) {
  return [...rows].sort((a, b) => severity(a.worst) - severity(b.worst)
    || (a.score ?? 101) - (b.score ?? 101)
    || String(a.tenantName).localeCompare(String(b.tenantName)));
}

/** Time left until `expiresAt`, as { ms, label: 'm:ss', over }. */
export function countdown(expiresAt, now = Date.now()) {
  const ms = Math.max(0, new Date(expiresAt).getTime() - now);
  const total = Math.ceil(ms / 1000);
  const label = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  return { ms, label, over: ms <= 0 };
}

/** The second confirmation for write mode: the business's name, typed (ignoring case and spaces at the ends). */
export const nameMatches = (typed, name) => {
  const wanted = String(name ?? '').trim().toLowerCase();
  return wanted !== '' && String(typed ?? '').trim().toLowerCase() === wanted;
};

export function formatDuration(ms) {
  const total = Math.round(Math.max(0, ms ?? 0) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (!minutes) return `${seconds} s`;
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

/** Where the operator stands against the 10-minute target (F-27). */
export const targetState = (activeMs) => (activeMs <= OPERATOR_TARGET_MS ? 'within' : 'over');

/**
 * Counts the operator's active time: the gap between two touches counts only when it is under `gapMs`, so a coffee break is
 * not on the clock. `flush` hands back what was counted since the last flush as { activeMs, startedAt, endedAt }, or null.
 */
export function createActivityTracker({ gapMs = ACTIVE_GAP_MS } = {}) {
  let last = null;
  let started = null;
  let active = 0;
  const reset = () => {
    last = null;
    started = null;
    active = 0;
  };
  return {
    touch(now = Date.now()) {
      if (last !== null && now >= last && now - last <= gapMs) active += now - last;
      if (started === null) started = now;
      last = now;
    },
    flush() {
      if (last === null || active <= 0) {
        reset();
        return null;
      }
      const result = { activeMs: Math.min(Math.round(active), 3_600_000), startedAt: new Date(started).toISOString(), endedAt: new Date(last).toISOString() };
      reset();
      return result;
    },
  };
}

export const ROLE_LABELS = Object.freeze({ super_admin: 'Super admin', support: 'Support', onboarding: 'Onboarding', service_operator: 'Service operator' });
export const PLAN_LABELS = Object.freeze({ free: 'Free', t1: 'Tier 1', t2: 'Tier 2', t3: 'Tier 3', t4: 'Tier 4', t5: 'Tier 5' });
export const TIERS = Object.freeze(['free', 't1', 't2', 't3', 't4', 't5']);

/** Words for the machine values the server sends, so a screen never shows a raw code. */
export const WORDS = Object.freeze({
  scope: { global: 'Everything (global)', activations: 'New automations', business: 'A business', account: 'An Instagram account', automation: 'One automation' },
  health: { bad: 'Needs action', unreachable: 'Could not check', warn: 'Watch', ok: 'Fine' },
  service: { reel_management: 'Reel management', reel_backlog: 'Reel backlog', merchandising: 'Merchandising', catalog_management: 'Catalog management', performance_report: 'Performance report' },
  mode: { direct: 'Changes go live', approve_first: 'Seller approves first' },
  change: { applied: 'Applied', draft: 'Waiting for the seller', approved: 'Approved', rejected: 'Rejected', undone: 'Undone' },
  submission: { draft: 'Draft', in_review: 'In review', rejected: 'Rejected', approved: 'Approved', live: 'Live' },
  ota: { publishing: 'Publishing', live: 'Live', rolling_back: 'Rolling back', rolled_back: 'Rolled back', superseded: 'Replaced', blocked: 'Blocked', failed: 'Failed' },
  build: { queued: 'Queued', building: 'Building', built: 'Built', failed: 'Failed', submitted: 'Submitted' },
  subscription: { active: 'Active', past_due: 'Payment due', grace: 'In grace', suspended: 'Suspended', cancelled: 'Cancelled' },
  signup: { closed: 'Closed', invite: 'Invite only', public: 'Open to everyone' },
  invite: { none: 'No link yet', sent: 'Sent', used: 'Opened', expired: 'Expired', revoked: 'Revoked' },
  step: { pending: 'To do', waiting: 'Waiting', done: 'Done', failed: 'Needs a fix' },
});
export const word = (group, value) => WORDS[group]?.[value] ?? String(value ?? '');

export const HEALTH_TONE = Object.freeze({ bad: 'bad', unreachable: 'warn', warn: 'warn', ok: 'good' });

/** Raw export tables (the contract's list). */
export const EXPORT_TABLES = Object.freeze([
  { value: 'audit_log', label: 'Audit log' },
  { value: 'compliance_events', label: 'Compliance events' },
  { value: 'events', label: 'Events' },
  { value: 'traffic_events', label: 'Traffic events' },
]);

/** "12, 15 18" to [12, 15, 18]; null when anything in it is not a whole number above zero. */
export function parseIds(text) {
  const parts = String(text ?? '').split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return [];
  const ids = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  return ids.some((id) => !Number.isSafeInteger(id) || id < 1) ? null : [...new Set(ids)];
}
