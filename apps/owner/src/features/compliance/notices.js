/**
 * Pure: what is stopping or slowing this business's messages, as string keys a screen turns into words, the same rules
 * as the console (console/src/features/compliance/notices.js). Home, Automations and the inbox show the same list,
 * so a seller hears about a pause or a lost connection wherever they are.
 */

const LOST = new Set(['reconnect_needed', 'deauthorized']);
export const INSIGHTS_SCOPE = 'instagram_business_manage_insights';
const DAY_MS = 86_400_000;

/** The four permissions a connection asks for, in the order the screen lists them. */
export const SCOPES = Object.freeze([
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
  INSIGHTS_SCOPE,
]);

const daysUntil = (when, now) => Math.max(0, Math.ceil((new Date(when).getTime() - now) / DAY_MS));
const reconnect = { label: 'compliance.notice.reconnectAction', path: '/connect' };
const review = { label: 'compliance.notice.reviewAction', path: '/compliance' };
const why = { label: 'compliance.notice.whyAction', path: '/compliance/log' };

export const isLost = (status) => LOST.has(status);

function instagramNotices(status, connection, now) {
  if (status?.reconnectNeeded || LOST.has(connection?.status)) return [{ key: 'reconnect', tone: 'bad', text: 'compliance.notice.reconnect', action: reconnect }];
  if (connection?.status !== 'active') return [];
  const missing = (connection.missingScopes ?? []).filter((scope) => scope !== INSIGHTS_SCOPE);
  if (missing.length) return [{ key: 'scopes', tone: 'bad', text: 'compliance.notice.scopes', values: { scopes: missing }, action: reconnect }];
  if (!connection.insightsGranted) return [{ key: 'insights', tone: 'warn', text: 'compliance.notice.insights', action: reconnect }];
  if (connection.health === 'amber' || connection.health === 'red') {
    const days = connection.tokenExpiresAt ? daysUntil(connection.tokenExpiresAt, now) : null;
    return [{
      key: 'expiring',
      tone: connection.health === 'red' ? 'bad' : 'warn',
      text: days === null ? 'compliance.notice.expiringSoon' : days === 1 ? 'compliance.notice.expiringDay' : 'compliance.notice.expiringDays',
      values: { days },
      action: reconnect,
    }];
  }
  return [];
}

/**
 * Most serious first. `status` is compliance.status, `connection` instagram.connection, `facebook` facebook.connection;
 * any may be missing while it loads or when it failed. Each reconnect appears once, whichever signal reported it.
 */
export function statusNotices({ status, connection, facebook, now = Date.now() } = {}) {
  const notices = [];
  if (status?.globalPause) notices.push({ key: 'global', tone: 'bad', text: 'compliance.notice.global' });
  if (status?.paused) {
    notices.push(status.canResume
      ? { key: 'paused', tone: 'warn', text: 'compliance.notice.paused', action: review }
      : { key: 'paused', tone: 'bad', text: 'compliance.notice.supportPause' });
  }
  notices.push(...instagramNotices(status, connection, now));
  if (status?.breaker === 'open') notices.push({ key: 'breaker', tone: 'bad', text: 'compliance.notice.breakerOpen', action: why });
  else if (status?.breaker === 'half_open') notices.push({ key: 'breaker', tone: 'warn', text: 'compliance.notice.breakerHalf', action: why });
  if (status?.slowMode?.active && !notices.some((notice) => notice.key === 'insights')) notices.push({ key: 'slow', tone: 'warn', text: 'compliance.notice.slow', action: review });
  if (facebook?.enabled && LOST.has(facebook.status)) notices.push({ key: 'facebook', tone: 'warn', text: 'compliance.notice.facebook', action: { label: 'compliance.notice.reconnectPage', path: '/connect' } });
  return notices;
}

/** The one line at the top of the compliance screen: { title, tone, badge } as string keys. */
export function overallStatus(status) {
  if (status.globalPause) return { title: 'compliance.overall.global', tone: 'bad', badge: 'compliance.badge.paused' };
  if (status.paused) return { title: status.canResume ? 'compliance.overall.youPaused' : 'compliance.overall.supportPaused', tone: 'bad', badge: 'compliance.badge.paused' };
  if (status.reconnectNeeded) return { title: 'compliance.overall.reconnect', tone: 'bad', badge: 'compliance.badge.onHold' };
  if (status.breaker !== 'closed') return { title: 'compliance.overall.breaker', tone: 'bad', badge: 'compliance.badge.onHold' };
  if (status.slowMode.active) return { title: 'compliance.overall.slow', tone: 'warn', badge: 'compliance.badge.slow' };
  return { title: 'compliance.overall.normal', tone: 'good', badge: 'compliance.badge.running' };
}

/** Facebook's one optional card on Home: only when the feature is on and no Page is connected (PRD 6.10). */
export const offersFacebook = (facebook) => Boolean(facebook?.enabled) && facebook.status === 'not_connected';

export const GATES = Object.freeze(['gate.access_level', 'gate.scope_missing', 'gate.privacy_url', 'gate.deletion_callback']);

/** Only the caps that have room to be lowered. Lowering is all a seller may do (PRD 4.7); the server refuses more. */
export const LOWERABLE_CAPS = Object.freeze([
  { code: 'cap.per_person_24h', max: 3 },
  { code: 'cap.dm_replies_24h', max: 10 },
  { code: 'cap.public_reply_media_h', max: 20 },
  { code: 'cap.public_reply_tenant_h', max: 60 },
]);

/** The text boxes as the API wants them, or `errors` by cap code as { key, values }. Empty means "the standard limit". */
export function capsToOverrides(values) {
  const overrides = {};
  const errors = {};
  for (const { code, max } of LOWERABLE_CAPS) {
    const text = String(values[code] ?? '').trim();
    if (text === '') continue;
    if (!/^\d+$/.test(text)) errors[code] = { key: 'compliance.rules.wholeNumber' };
    else if (Number(text) > max) errors[code] = { key: 'compliance.rules.onlyLower', values: { max } };
    else overrides[code] = Number(text);
  }
  return Object.keys(errors).length ? { errors } : { overrides };
}

export const overridesToCaps = (overrides = {}) => Object.fromEntries(LOWERABLE_CAPS.map(({ code }) => [code, overrides[code] === undefined ? '' : String(overrides[code])]));

export const WORD_LISTS = Object.freeze(['optout', 'negative', 'handoff']);

/** Only a slowdown a reach drop started can be overridden, by the owner, with the word typed out (PRD 4.3). */
export const OVERRIDE_WORD = 'override';
export const overrideTyped = (typed) => String(typed ?? '').trim().toLowerCase() === OVERRIDE_WORD;
