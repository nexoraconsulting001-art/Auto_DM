import { isOutcome, isReason } from './reasons.js';

/** Pure: what is stopping or slowing this business's messages, in the words a seller reads. Screens render the list. */

export const SUPPORT_PAUSE = 'Paused by support. Contact support.';
const LOST = new Set(['reconnect_needed', 'deauthorized']);
const INSIGHTS_SCOPE = 'instagram_business_manage_insights';
const CONNECT = '/connect';
const COMPLIANCE = '/compliance';
const DAY_MS = 86_400_000;

const SCOPE_WORDS = Object.freeze({
  instagram_business_basic: 'your profile',
  instagram_business_manage_messages: 'messages',
  instagram_business_manage_comments: 'comments',
  [INSIGHTS_SCOPE]: 'insights',
});

export const scopeWord = (scope) => SCOPE_WORDS[scope] ?? scope;

const daysUntil = (when, now) => Math.max(0, Math.ceil((new Date(when).getTime() - now) / DAY_MS));
const reconnect = { label: 'Reconnect Instagram', to: CONNECT };

function instagramNotices(status, connection, now) {
  if (status?.reconnectNeeded || LOST.has(connection?.status)) {
    return [{ key: 'reconnect', tone: 'bad', text: 'Your Instagram connection has stopped working, so messages are on hold.', action: reconnect }];
  }
  if (connection?.status !== 'active') return [];

  const missing = connection.missingScopes.filter((scope) => scope !== INSIGHTS_SCOPE);
  if (missing.length) {
    return [{ key: 'scopes', tone: 'bad', text: `Instagram isn’t letting us use ${missing.map(scopeWord).join(' and ')}, so automations can’t go live.`, action: reconnect }];
  }
  if (!connection.insightsGranted) {
    return [{ key: 'insights', tone: 'warn', text: 'Slow mode is on because insights permission was not given. Allow it to send at full speed.', action: reconnect }];
  }
  if (connection.health === 'amber' || connection.health === 'red') {
    const days = connection.tokenExpiresAt ? daysUntil(connection.tokenExpiresAt, now) : null;
    return [{
      key: 'expiring',
      tone: connection.health === 'red' ? 'bad' : 'warn',
      text: days === null ? 'Your Instagram connection needs attention soon.' : `Your Instagram connection runs out in ${days} ${days === 1 ? 'day' : 'days'} unless it renews.`,
      action: reconnect,
    }];
  }
  return [];
}

function facebookNotices(facebook) {
  if (!facebook?.enabled || !LOST.has(facebook.status)) return [];
  return [{ key: 'facebook', tone: 'warn', text: 'Your Facebook Page needs reconnecting. Its automations are stopped, and everything else keeps working.', action: { label: 'Reconnect Page', to: CONNECT } }];
}

/**
 * Most serious first. `status` is compliance.status, `connection` instagram.connection, `facebook` facebook.connection;
 * any can be missing while it loads or if it failed. Each reconnect appears once, whichever signal reported it.
 */
export function statusNotices({ status, connection, facebook, now = Date.now() }) {
  const notices = [];
  if (status?.globalPause) notices.push({ key: 'global', tone: 'bad', text: 'Bhava has paused all automated messages for a while. Held messages send afterwards if they haven’t expired.' });
  if (status?.paused) {
    notices.push(status.canResume
      ? { key: 'paused', tone: 'warn', text: 'Your automations are paused. Nothing is being sent.', action: { label: 'Review', to: COMPLIANCE } }
      : { key: 'paused', tone: 'bad', text: SUPPORT_PAUSE });
  }
  notices.push(...instagramNotices(status, connection, now));
  if (status?.breaker === 'open') notices.push({ key: 'breaker', tone: 'bad', text: 'Sending stopped by itself after errors from Instagram. It will try again shortly.', action: { label: 'See why', to: `${COMPLIANCE}/log` } });
  else if (status?.breaker === 'half_open') notices.push({ key: 'breaker', tone: 'warn', text: 'Sending is being tested after errors from Instagram.', action: { label: 'See why', to: `${COMPLIANCE}/log` } });
  // The insights notice already explains slow mode; saying it twice reads like two problems.
  if (status?.slowMode.active && !notices.some((notice) => notice.key === 'insights')) notices.push({ key: 'slow', tone: 'warn', text: 'Slow mode is on, so messages go out at half speed.', action: { label: 'Review', to: COMPLIANCE } });
  notices.push(...facebookNotices(facebook));
  return notices;
}

/** The one line at the top of the compliance screen. */
export function overallStatus(status) {
  if (status.globalPause) return { title: 'Paused by Bhava', tone: 'bad', badge: 'Paused' };
  if (status.paused) return { title: status.canResume ? 'You paused sending' : 'Paused by support', tone: 'bad', badge: 'Paused' };
  if (status.reconnectNeeded) return { title: 'Waiting for Instagram', tone: 'bad', badge: 'On hold' };
  if (status.breaker !== 'closed') return { title: 'Stopped after errors', tone: 'bad', badge: 'On hold' };
  if (status.slowMode.active) return { title: 'Sending slowly', tone: 'warn', badge: 'Slow mode' };
  return { title: 'Sending normally', tone: 'good', badge: 'Running' };
}

/** Facebook's one optional card: only when the feature is on and no Page is connected (PRD 6.10). */
export const offersFacebook = (facebook) => Boolean(facebook?.enabled) && facebook.status === 'not_connected';

export const GATE_LABELS = Object.freeze({
  'gate.access_level': 'Meta has given this account access',
  'gate.scope_missing': 'Messages and comments permissions granted',
  'gate.privacy_url': 'Privacy page reachable',
  'gate.deletion_callback': 'Data deletion address reachable',
});

/** Only the caps that have room to be lowered; the rest are already one. Lowering is all a seller may do (PRD 4.7). */
export const LOWERABLE_CAPS = Object.freeze([
  { code: 'cap.per_person_24h', label: 'DMs per person per day', max: 3 },
  { code: 'cap.dm_replies_24h', label: 'Automated replies per person per day', max: 10 },
  { code: 'cap.public_reply_media_h', label: 'Public replies per post per hour', max: 20 },
  { code: 'cap.public_reply_tenant_h', label: 'Public replies across your account per hour', max: 60 },
]);

/** The form's text boxes as the API wants them, or `errors` by cap code. Empty means "use the standard limit". */
export function capsToOverrides(values) {
  const overrides = {};
  const errors = {};
  for (const { code, max } of LOWERABLE_CAPS) {
    const text = String(values[code] ?? '').trim();
    if (text === '') continue;
    if (!/^\d+$/.test(text)) errors[code] = 'Use a whole number, or leave it empty';
    else if (Number(text) > max) errors[code] = `This can only be lowered. The most it can be is ${max}.`;
    else overrides[code] = Number(text);
  }
  return Object.keys(errors).length ? { errors } : { overrides };
}

export const overridesToCaps = (overrides) => Object.fromEntries(LOWERABLE_CAPS.map(({ code }) => [code, overrides[code] === undefined ? '' : String(overrides[code])]));

export const WORD_LISTS = Object.freeze([
  { code: 'optout', label: 'Stop words', text: 'Someone who sends one of these stops getting automated messages.' },
  { code: 'negative', label: 'Complaint words', text: 'A comment with one of these gets no sales link and goes to Needs a human.' },
  { code: 'handoff', label: 'Ask for a person', text: 'A DM with one of these pauses automation in that chat and tells you.' },
]);

const ID = /^[1-9]\d{0,9}$/;
const MEDIA_ID_MAX = 80;

/** The log's filters from the address. Only what the API can accept goes out, so a mistyped link shows the whole log, not an error. */
export function logFilters(params) {
  const filters = {};
  if (isOutcome(params.get('outcome'))) filters.outcome = params.get('outcome');
  if (isReason(params.get('reason'))) filters.reason = params.get('reason');
  if (ID.test(params.get('automationId') ?? '')) filters.automationId = params.get('automationId');
  const media = params.get('mediaId') ?? '';
  if (media && media.length <= MEDIA_ID_MAX) filters.mediaId = media;
  return filters;
}
