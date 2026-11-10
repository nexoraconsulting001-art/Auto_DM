import { INSTAGRAM_SCOPES } from '../../adapters/meta/index.js';
import { DISCONNECTED_BY_OWNER } from '../ig-accounts/index.js';

const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const SCOPE_BASIC = 'instagram_business_basic';
export const SCOPE_MESSAGES = 'instagram_business_manage_messages';
export const SCOPE_COMMENTS = 'instagram_business_manage_comments';
export const SCOPE_INSIGHTS = 'instagram_business_manage_insights';

/** The permissions a business can't go live without (PRD 4.15). Insights is optional: without it, slow mode. */
export const SCOPES_TO_GO_LIVE = Object.freeze([SCOPE_MESSAGES, SCOPE_COMMENTS]);

/** The webhook fields to subscribe (PRD 4.1), and the permission Meta wants for each. */
export const WEBHOOK_FIELD_SCOPES = Object.freeze({
  comments: SCOPE_COMMENTS,
  mentions: SCOPE_COMMENTS,
  messages: SCOPE_MESSAGES,
  messaging_postbacks: SCOPE_MESSAGES,
});
export const WEBHOOK_FIELDS = Object.freeze(Object.keys(WEBHOOK_FIELD_SCOPES));

/** Read receipts, for the funnel's Seen step (PRD 7.15, to confirm). Not required to count as subscribed, and asked for only with READ_RECEIPTS=1. */
export const READ_RECEIPTS_FIELD = 'messaging_seen';

const REFRESH_MIN_AGE_MS = DAY;
const REFRESH_WITHIN_MS = 30 * DAY;

/** A token can be refreshed from 24 hours old, and is, once it has 30 days or less to live (PRD 4.2). Null when Meta gave no expiry. */
export function nextRefreshAt(issuedAtMs, expiresAt) {
  if (!expiresAt) return null;
  return new Date(Math.max(issuedAtMs + REFRESH_MIN_AGE_MS, new Date(expiresAt).getTime() - REFRESH_WITHIN_MS));
}

const WARNING_DAYS = Object.freeze([1, 3, 7, 14]);

/** The warning a token this close to expiry is due, the most urgent only, or null (PRD 4.2). */
export function expiryWarning(expiresAt, nowMs) {
  const left = new Date(expiresAt).getTime() - nowMs;
  if (left <= 0) return null;
  return WARNING_DAYS.find((days) => left <= days * DAY) ?? null;
}

/** The connection's colour (PRD 4.2): amber at 14 days or less or after a failed refresh, red at 3 days or less or once it has stopped working. */
export function healthOf(account, nowMs) {
  if (account.status !== 'active') return 'red';
  if (!account.hasToken) return 'none';
  const left = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() - nowMs : Infinity;
  if (left <= 3 * DAY) return 'red';
  return left <= 14 * DAY || account.refreshFailures > 0 ? 'amber' : 'ok';
}

const NOT_CONNECTED = Object.freeze({
  status: 'not_connected',
  igUserId: null,
  username: '',
  loginKind: null,
  scopes: [],
  missingScopes: [...INSTAGRAM_SCOPES],
  insightsGranted: false,
  tokenExpiresAt: null,
  health: 'none',
  webhooksSubscribed: false,
});

/** What the API says about a connection (src/contracts/api/instagram.js). A row that is only linked, or that the seller ended, is "not connected". */
export function connectionView(account, nowMs = Date.now()) {
  if (!account || account.statusReason === DISCONNECTED_BY_OWNER || (account.status === 'active' && !account.hasToken)) return NOT_CONNECTED;
  return {
    status: account.status,
    igUserId: account.igUserId,
    username: account.username,
    loginKind: account.loginKind,
    scopes: account.scopes,
    missingScopes: INSTAGRAM_SCOPES.filter((scope) => !account.scopes.includes(scope)),
    insightsGranted: account.scopes.includes(SCOPE_INSIGHTS),
    tokenExpiresAt: account.tokenExpiresAt,
    health: healthOf(account, nowMs),
    webhooksSubscribed: Boolean(account.subscribedAt) && WEBHOOK_FIELDS.every((field) => account.subscribedFields.includes(field)),
  };
}
