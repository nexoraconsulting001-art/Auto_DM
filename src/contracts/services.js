/**
 * Managed services (PRD 5.17): what Bhava's team may do in a seller's business, as data. No imports, so the server, both
 * consoles and the apps read the same rules.
 *
 * A service operator works through the seller API, in a seller session that names a service session (sessions.service_session_id).
 * A route says which services may call it in its `service` field (src/contracts/api); a route with none is 403 for an operator.
 * Keys, payouts, refunds, billing, staff and roles never get one: NEVER_A_SERVICE below is checked against the route table.
 */
export const SERVICES = Object.freeze(['reel_management', 'reel_backlog', 'merchandising', 'catalog_management', 'performance_report']);

/** The services whose operators change things in the business. The backlog is worked with reel management's routes; the report is produced by Bhava and changes nothing. */
export const SERVICE_SCOPES = Object.freeze({
  catalog_management: 'Products and categories',
  reel_management: 'Automations, reel categories and reel order',
  reel_backlog: 'Automations, reel categories and reel order, for reels already posted',
  merchandising: 'Collections, banners and page order',
  performance_report: 'The monthly report. Changes nothing in the business',
});

/** The entitlement that says a business has a service (BILLING_FEATURES.services in billing.js). */
export const serviceFeature = (service) => `service.${service}`;

/** `direct`: the team's changes go live. `approve_first`: each waits as a draft until the seller approves it. The seller picks per service. */
export const SERVICE_MODES = Object.freeze(['direct', 'approve_first']);

/**
 * A recorded change (service_changes.state):
 *   applied   made directly                         -> undone
 *   draft     waiting for the seller                -> approved, rejected
 *   approved  a draft the seller let through        -> undone
 *   rejected, undone                                the end
 */
export const CHANGE_STATES = Object.freeze(['applied', 'draft', 'approved', 'rejected', 'undone']);
export const CHANGE_MOVES = Object.freeze({ applied: Object.freeze(['undone']), draft: Object.freeze(['approved', 'rejected']), approved: Object.freeze(['undone']), rejected: Object.freeze([]), undone: Object.freeze([]) });
export const canMoveChange = (from, to) => Boolean(CHANGE_MOVES[from]?.includes(to));

/** How long one service session may last, and how long a task reference may be. */
export const SERVICE_SESSION_HOURS = 8;
export const TASK_REF_MAX = 120;

/** Route groups no service may ever be given (PRD 5.17: keys, payouts, refunds, billing, staff and roles). */
export const NEVER_A_SERVICE = Object.freeze([
  'auth', 'team', 'billing', 'referrals', 'signup', 'setup', 'services', 'teamFeed', 'apiKeys', 'settings', 'paymentSettings', 'paymentAccount', 'payments', 'settlements', 'refunds', 'shippingSettings',
  'whatsappAccount', 'shopify', 'pushCredentials', 'storeAccess', 'privacy', 'dataRequests', 'audit', 'instagram', 'facebook', 'domains', 'customers', 'shoppers',
]);

const SECRET_KEY = /(secret|token|password|passcode|otp|credential|authorization|api_?key|key_?secret|private_?key|signature|cookie)/i;
export const MASKED = '••••';

/**
 * A copy of a JSON value with every secret-looking field masked, for service_changes.before and after and for audit details.
 * Arrays and objects are walked; anything deeper than 12 levels is dropped rather than trusted.
 */
export function maskSecrets(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) && inner !== null && inner !== undefined && inner !== '' ? MASKED : maskSecrets(inner, depth + 1);
  }
  return out;
}

/**
 * What a seller's "Done by Bhava team" feed may do with a change. Undo writes `before` back through the route that made the
 * change (or the route its `undo` field names), so only a change that has both a before and an after can be undone: something
 * created or removed by the team is put right by hand, and the feed says so.
 */
export const canUndoChange = (change) => ['applied', 'approved'].includes(change?.state) && change.before !== null && change.before !== undefined && change.after !== null && change.after !== undefined;
