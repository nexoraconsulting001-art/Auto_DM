import { APP_PLATFORMS, DEVICE_ID } from '../../contracts/accounts.js';
import { ApiError } from '../../contracts/api/index.js';
import { PushCampaignSend, PushCredentialsUpdate } from '../../contracts/api/apps.js';
import { SHOPPER_PUSH_KINDS, SHOPPER_PUSH_RULES, fillPush, inQuietHours, shopperPushProblem, weekStart } from '../../contracts/apps.js';
import { PushDeviceBody, PushFollowOrder, PushPrefsSave } from '../../contracts/store-routes.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';
import { hiddenReason, PAGE_COLS } from '../categories/repo.js';
import { keyedHash } from '../shoppers/keys.js';
import { parseBody } from '../storefront/http.js';
import { checkApnsKey, checkServiceAccount, senderFor } from './sender.js';

/**
 * Push to shoppers from the brand's own app (PRD 10.11): the service behind shopperPushFor(ctx). Everything runs as one
 * business (tenantId()), every statement names tenant_id, and no input names a device or a shopper by id: an app call works
 * on its own install (the app session's device), and a campaign's audience is whoever opted in.
 *
 * The rules it holds:
 *   - Registering never opts in. Each toggle holds when it was turned on (NULL is off); every change is a consent row.
 *     first_order_prompt may turn on order updates only; offers and new reels need an explicit true from settings.
 *     Permission denied wipes the token and turns every toggle off (source system_permission). A different person on the
 *     install (sign-out, or another shopper) turns them off too (source sign_out): what one person chose is not another's.
 *   - Claim, then send. A shopper_push_log row is claimed in a transaction that locks the subject's device rows and reads
 *     the toggle again; it commits before anything is sent. Its unique key (device, source) makes one event one push per
 *     device however often it is delivered. Offers and new-reel pushes count the subject's distinct sources this week
 *     (Asia/Kolkata, from Monday) under that lock, so two campaigns at once cannot both pass the weekly cap.
 *   - Never twice on a guess. `attempts` goes up in its own statement before each call, so a crash mid-call is never sent
 *     again; only a throttled answer is tried again (up to maxAttempts). A timeout, an unavailable provider or a junk answer
 *     ends the row as failed. A rejected token is deleted then and there, with its toggles.
 *   - Before each send the device is read again: an opt-out, a deleted token or a lost permission skips the row, so the
 *     withdrawal of consent holds from the very next push.
 *   - Words: every push passes shopperPushProblem on its final title, body and data; data is { link, kind } only.
 *   - Offers and new-reel pushes wait out quiet hours (21:00 to 09:00 IST); order updates never wait.
 *   - A brand with no credentials sends nothing; only the seller is told (the campaign's block reason, the summary).
 */
const TOGGLE_KEYS = Object.freeze({ orderUpdates: 'order_updates', offers: 'offers', newReels: 'new_reels' });
const COLUMN = Object.freeze({ order_updates: 'order_updates_on_at', offers: 'offers_on_at', new_reels: 'new_reels_on_at' });
const KIND_TOGGLE = Object.freeze({ order_update: 'order_updates', offer: 'offers', new_reel: 'new_reels' });
const HOLDS_TOKEN = Object.freeze(['granted', 'provisional']);
const CREDENTIAL_OF = Object.freeze({ android: 'fcm', ios: 'apns' });
const FEATURE_OF = Object.freeze({ android: 'app.android', ios: 'app.ios' });
const PUSHABLE = `deleted_at IS NULL AND token_enc IS NOT NULL AND permission IN ('granted', 'provisional')`;
const LOCK_SPACE = 60_611;
const IST_MS = 330 * 60_000;
const ORDER_KINDS = Object.freeze(Object.keys(SHOPPER_PUSH_KINDS).filter((kind) => kind !== 'new_reel'));
export const SHOPPER_PUSH_ORDER_EVENTS = ORDER_KINDS;
export const SHOPPER_PUSH_QUEUE = 'shopper-push.send';

export const CAP_MESSAGE = 'Weekly offer limit reached';
export const NO_CREDENTIALS_MESSAGE = 'Add your app’s push keys before sending an offer.';
export const NO_AUDIENCE_MESSAGE = 'Nobody has turned on offers in your app yet.';
/** What the owner is told (an alert, never the shopper) when a push could not go out because of the brand's own keys. */
export const SELLER_KEY_ALERTS = Object.freeze({
  missing: (name) => `Your app can’t send notifications on ${name} yet: add your push keys in App publishing.`,
  refused: (name) => `${name} refused your app’s push keys, so notifications stopped. Upload them again in App publishing.`,
});
const PLATFORM_NAME = Object.freeze({ android: 'Android', ios: 'iPhone' });
const WORDING = Object.freeze({
  title_too_long: ['title', 'Keep the title to 65 characters or fewer'],
  body_too_long: ['body', 'Keep the offer to 178 characters or fewer'],
  link: ['linkPath', 'Use a page of your store the app opens, like /c/sale'],
  names_platform: ['body', 'Use your own brand’s name in the offer'],
  phone: ['body', 'An offer can’t carry a phone number'],
  email: ['body', 'An offer can’t carry an email address'],
  address: ['body', 'An offer can’t carry an address'],
  payment: ['body', 'An offer can’t carry payment details'],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const onOf = (row, toggle) => Boolean(row?.[COLUMN[toggle]]);
const pushable = (row) => Boolean(row && !row.deleted_at && row.token_enc && HOLDS_TOKEN.includes(row.permission));
const subjectOf = (row) => (row.shopper_id === null || row.shopper_id === undefined ? `d:${row.id}` : `s:${row.shopper_id}`);
const isProviderRefusal = (err) => Boolean(err && typeof err.kind === 'string' && typeof err.retryable === 'boolean');

/** 09:00 IST after `now` (now is in quiet hours). */
export function quietEnd(now) {
  const ist = new Date(new Date(now).getTime() + IST_MS);
  const day = ist.getUTCHours() >= SHOPPER_PUSH_RULES.quietFromHour ? 1 : 0;
  const end = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + day, SHOPPER_PUSH_RULES.quietToHour, 0, 0);
  return new Date(end - IST_MS);
}

/** Whether a push provider refused our own (the brand's) credentials, rather than the device or the moment. */
function credentialsRefused(err) {
  if (!isProviderRefusal(err) || err.kind !== 'unavailable') return false;
  if (err.provider === 'fcm') return err.code === 'bad_service_account' || ([400, 401, 403].includes(err.status) && err.code !== 'malformed');
  if (err.provider === 'apns') return err.status === 403 || ['BadTopic', 'TopicDisallowed', 'BadCertificate', 'BadCertificateEnvironment', 'InvalidProviderToken', 'MissingProviderToken', 'ExpiredProviderToken'].includes(err.code);
  return false;
}

function maskEmail(email) {
  const text = String(email ?? '');
  const at = text.indexOf('@');
  if (at < 1) return text ? '•••' : '';
  return `${text.slice(0, Math.min(2, at))}•••${text.slice(at)}`;
}

export function createShopperPush(ctx) {
  const { db, config } = ctx;
  const secrets = ctx.platform.secrets;
  const weeklyCap = () => Number(config.shopperPushWeeklyCap) || SHOPPER_PUSH_RULES.weeklyCap;
  const tid = () => tenantId();

  const service = {
    /** The clock every rule reads (quiet hours, the week). Tests may replace it. */
    now: () => new Date(),
    /** How long to wait before trying a throttled push again. Tests may replace it. */
    retryDelayMs: (attempt, retryAfter) => Math.min(30_000, retryAfter ? Number(retryAfter) * 1000 : 500 * 2 ** (attempt - 1)),
  };

  /** The business's current consent notice version, read on `runner` (a transaction's own, inside one). */
  async function noticeVersion(runner = db) {
    try {
      const [row] = await runner.query('SELECT version FROM consent_notices WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1', [tid()]);
      return row ? Number(row.version) : null;
    } catch {
      return null;
    }
  }

  async function entitled(platform) {
    return Boolean(await ctx.repos.entitlements.can(FEATURE_OF[platform]));
  }

  async function requireApp(platform = null) {
    const ok = platform ? await entitled(platform) : (await entitled('android')) || (await entitled('ios'));
    if (!ok) throw new ApiError('forbidden', 'Your plan doesn’t include your own shopper app.', { reason: 'plan' });
  }

  async function credentialRow(runner = db) {
    const [row] = await runner.query('SELECT * FROM app_push_credentials WHERE tenant_id = $1', [tid()]);
    return row ?? null;
  }

  const credentialSet = (row, platform) => (CREDENTIAL_OF[platform] === 'fcm'
    ? Boolean(row?.fcm_service_account_enc) && row.fcm_status !== 'invalid'
    : Boolean(row?.apns_key_enc) && row.apns_status !== 'invalid');

  /** The platforms a push can go to now: the plan has the app and the brand's own credentials are set and not refused. */
  async function sendablePlatforms() {
    const row = await credentialRow();
    const out = [];
    for (const platform of APP_PLATFORMS) if (credentialSet(row, platform) && (await entitled(platform))) out.push(platform);
    return out;
  }

  function sessionOf(session) {
    if (!session || !DEVICE_ID.test(String(session.deviceId ?? '')) || !APP_PLATFORMS.includes(session.platform)) {
      throw new ApiError('unauthorized', 'Open the app and try again.');
    }
    const id = Number(session.shopperId);
    const shopperId = !session.guest && Number.isSafeInteger(id) && id > 0 ? id : null;
    return { deviceId: String(session.deviceId), platform: session.platform, version: String(session.version ?? '').slice(0, 20), shopperId };
  }

  async function writeConsents(t, row, changes, source, notice, shopperId = row.shopper_id) {
    for (const { toggle, granted } of changes) {
      await t.query(
        `INSERT INTO shopper_push_consents (tenant_id, device_row_id, shopper_id, toggle, granted, source, notice_version) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tid(), row.id, shopperId ?? null, toggle, granted, source, notice],
      );
    }
  }

  /** Turns every toggle of the row off, with a consent row for each that was on. */
  async function turnOff(t, row, source, notice) {
    const changes = Object.values(TOGGLE_KEYS).filter((toggle) => onOf(row, toggle)).map((toggle) => ({ toggle, granted: false }));
    if (!changes.length) return row;
    await writeConsents(t, row, changes, source, notice);
    const [updated] = await t.query(
      `UPDATE shopper_push_devices SET order_updates_on_at = NULL, offers_on_at = NULL, new_reels_on_at = NULL, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tid(), row.id],
    );
    return updated;
  }

  /** This install's row, locked, created without a token if new, and made the current person's. */
  async function ensureDevice(t, s, notice) {
    await t.query(
      `INSERT INTO shopper_push_devices (tenant_id, device_id, shopper_id, platform, app_version) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, device_id) DO NOTHING`,
      [tid(), s.deviceId, s.shopperId, s.platform, s.version],
    );
    let [row] = await t.query('SELECT * FROM shopper_push_devices WHERE tenant_id = $1 AND device_id = $2 FOR NO KEY UPDATE', [tid(), s.deviceId]);
    if (row.shopper_id !== null && Number(row.shopper_id) !== s.shopperId) {
      // Someone else now holds this install: the last person's choices and followed orders are not theirs.
      row = await turnOff(t, row, 'sign_out', notice);
      await t.query('DELETE FROM shopper_push_orders WHERE tenant_id = $1 AND device_row_id = $2', [tid(), row.id]);
    }
    const [current] = await t.query(
      `UPDATE shopper_push_devices SET shopper_id = $3, platform = $4, app_version = $5, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tid(), row.id, s.shopperId, s.platform, s.version],
    );
    return current;
  }

  function prefsView(row, configured, s) {
    const theirs = row && (row.shopper_id === null || Number(row.shopper_id) === s.shopperId);
    return {
      permission: row?.permission ?? 'not_asked',
      orderUpdates: Boolean(theirs && onOf(row, 'order_updates')),
      offers: Boolean(theirs && onOf(row, 'offers')),
      newReels: Boolean(theirs && onOf(row, 'new_reels')),
      configured,
    };
  }

  const configuredFor = async (platform) => credentialSet(await credentialRow(), platform) && (await entitled(platform));

  // ---- the app's calls ----

  service.registerDevice = async (session, input) => {
    const s = sessionOf(session);
    const { token, permission } = parseBody(PushDeviceBody, input);
    let keep = Boolean(token) && HOLDS_TOKEN.includes(permission);
    if (keep && !secrets.configured) {
      log.warn('shopper_push.token_not_stored', { reason: 'no_data_key' });
      keep = false;
    }
    const hash = keep ? keyedHash(config, `shopper-push-token:${tid()}`, token) : '';
    const encrypted = keep ? secrets.encrypt(token) : null;
    const notice = await noticeVersion();
    const saved = await db.tx(async (t) => {
      if (hash) await t.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_SPACE, `${tid()}:${hash}`]);
      let row = await ensureDevice(t, s, notice);
      // A token is on one install only: one that moved here leaves the row it was on.
      if (hash) await t.query(`UPDATE shopper_push_devices SET token_enc = NULL, token_hash = '', updated_at = now() WHERE tenant_id = $1 AND token_hash = $2 AND id <> $3`, [tid(), hash, row.id]);
      if (permission === 'denied') row = await turnOff(t, row, 'system_permission', notice);
      const [updated] = await t.query(
        `UPDATE shopper_push_devices SET token_enc = $3, token_hash = $4,
           permission_at = CASE WHEN permission = $5 AND permission_at IS NOT NULL THEN permission_at ELSE now() END, permission = $5,
           deleted_at = CASE WHEN $3::text IS NULL THEN deleted_at ELSE NULL END,
           delete_reason = CASE WHEN $3::text IS NULL THEN delete_reason ELSE '' END,
           updated_at = now()
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [tid(), row.id, encrypted, hash, permission],
      );
      return updated;
    });
    log.info('shopper_push.device_registered', { deviceRowId: Number(saved.id), platform: s.platform, permission, token: Boolean(keep) });
    return prefsView(saved, await configuredFor(s.platform), s);
  };

  service.prefs = async (session) => {
    const s = sessionOf(session);
    const [row] = await db.query('SELECT * FROM shopper_push_devices WHERE tenant_id = $1 AND device_id = $2', [tid(), s.deviceId]);
    return prefsView(row ?? null, await configuredFor(s.platform), s);
  };

  service.savePrefs = async (session, input) => {
    const s = sessionOf(session);
    const body = parseBody(PushPrefsSave, input);
    if (body.source === 'first_order_prompt' && (body.offers === true || body.newReels === true)) {
      const fields = {};
      if (body.offers === true) fields.offers = 'Turn offers on in your notification settings';
      if (body.newReels === true) fields.newReels = 'Turn new reels on in your notification settings';
      throw new ApiError('validation_failed', 'Offers and new reels are turned on in your notification settings.', { fields });
    }
    const notice = await noticeVersion();
    const saved = await db.tx(async (t) => {
      const row = await ensureDevice(t, s, notice);
      const changes = [];
      for (const [key, toggle] of Object.entries(TOGGLE_KEYS)) {
        if (body[key] === undefined || body[key] === onOf(row, toggle)) continue;
        changes.push({ toggle, granted: body[key] });
      }
      if (!changes.length) return row;
      const sets = changes.map(({ toggle, granted }) => `${COLUMN[toggle]} = ${granted ? 'now()' : 'NULL'}`);
      const [updated] = await t.query(`UPDATE shopper_push_devices SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tid(), row.id]);
      await writeConsents(t, updated, changes, body.source, notice);
      return updated;
    });
    log.info('shopper_push.prefs_saved', { deviceRowId: Number(saved.id), source: body.source });
    return prefsView(saved, await configuredFor(s.platform), s);
  };

  service.removeDevice = async (session) => {
    const s = sessionOf(session);
    const notice = await noticeVersion();
    await db.tx(async (t) => {
      const [row] = await t.query('SELECT * FROM shopper_push_devices WHERE tenant_id = $1 AND device_id = $2 FOR NO KEY UPDATE', [tid(), s.deviceId]);
      if (!row || row.deleted_at) return;
      await turnOff(t, row, 'settings', notice);
      await t.query('DELETE FROM shopper_push_orders WHERE tenant_id = $1 AND device_row_id = $2', [tid(), row.id]);
      await t.query(
        `UPDATE shopper_push_devices SET token_enc = NULL, token_hash = '', deleted_at = now(), delete_reason = 'removed', updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tid(), row.id],
      );
    });
  };

  /** Sign-out (app-api, in its own transaction t): the install is a guest again and keeps none of the person's choices. */
  service.detachShopper = async (t, deviceId) => {
    if (!DEVICE_ID.test(String(deviceId ?? ''))) return false;
    const [row] = await t.query('SELECT * FROM shopper_push_devices WHERE tenant_id = $1 AND device_id = $2 FOR NO KEY UPDATE', [tid(), String(deviceId)]);
    if (!row || row.shopper_id === null) return false;
    await turnOff(t, row, 'sign_out', await noticeVersion(t));
    await t.query('DELETE FROM shopper_push_orders WHERE tenant_id = $1 AND device_row_id = $2', [tid(), row.id]);
    await t.query('UPDATE shopper_push_devices SET shopper_id = NULL, updated_at = now() WHERE tenant_id = $1 AND id = $2', [tid(), row.id]);
    return true;
  };

  /**
   * A guest's install follows an order it placed, by the order's own token: updates of that order reach it. `input` is the
   * route's body ({ orderToken }) or the token itself, as app-api's checkout hand-off may pass it.
   */
  service.followOrder = async (session, input) => {
    const s = sessionOf(session);
    const { orderToken } = parseBody(PushFollowOrder, typeof input === 'string' ? { orderToken: input } : input);
    const [order] = await db.query('SELECT id, shopper_id FROM orders WHERE tenant_id = $1 AND public_token = $2', [tid(), orderToken]);
    const notYours = order?.shopper_id !== null && order?.shopper_id !== undefined && s.shopperId !== null && Number(order.shopper_id) !== s.shopperId;
    if (!order || notYours) throw new ApiError('not_found', 'We couldn’t find that order.');
    const notice = await noticeVersion();
    await db.tx(async (t) => {
      const row = await ensureDevice(t, s, notice);
      await t.query(
        `INSERT INTO shopper_push_orders (tenant_id, device_row_id, order_id) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, device_row_id, order_id) DO NOTHING`,
        [tid(), row.id, order.id],
      );
    });
  };

  // ---- claiming ----

  /**
   * Claims one push for every eligible device of one subject (a shopper's devices, or one guest install), under a lock on
   * those rows. For a capped kind, a subject at the weekly cap gets nothing. -> { devices, claimed, capped }
   */
  async function claimSubject({ shopperId, deviceRowId }, { kind, sourceKind, sourceId, toggle, platforms, week, only = null }) {
    return db.tx(async (t) => {
      const rows = await t.query(
        `SELECT * FROM shopper_push_devices WHERE tenant_id = $1 AND (shopper_id = $2 OR id = $3) ORDER BY id FOR NO KEY UPDATE`,
        [tid(), shopperId ?? null, deviceRowId ?? null],
      );
      const subject = shopperId ? `s:${shopperId}` : `d:${deviceRowId}`;
      const eligible = rows.filter((row) => subjectOf(row) === subject && (!only || only.has(Number(row.id))) && pushable(row) && onOf(row, toggle) && (!platforms || platforms.includes(row.platform)));
      if (!eligible.length) return { devices: 0, claimed: 0, capped: 0 };
      if (SHOPPER_PUSH_RULES.cappedKinds.includes(kind)) {
        const [{ n }] = await t.query(
          `SELECT count(DISTINCT source_kind || ':' || source_id)::int AS n FROM shopper_push_log
           WHERE tenant_id = $1 AND cap_subject = $2 AND week_start = $3 AND kind IN ('offer', 'new_reel') AND status <> 'skipped'
             AND NOT (source_kind = $4 AND source_id = $5)`,
          [tid(), subject, week, sourceKind, sourceId],
        );
        if (n >= weeklyCap()) return { devices: eligible.length, claimed: 0, capped: eligible.length };
      }
      let claimed = 0;
      for (const row of eligible) {
        const inserted = await t.query(
          `INSERT INTO shopper_push_log (tenant_id, device_row_id, shopper_id, cap_subject, kind, source_kind, source_id, week_start)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id, device_row_id, source_kind, source_id) DO NOTHING RETURNING id`,
          [tid(), row.id, row.shopper_id, subject, kind, sourceKind, sourceId, week],
        );
        claimed += inserted.length;
      }
      return { devices: eligible.length, claimed, capped: 0 };
    });
  }

  /** Claims for every subject among `devices` (rows with id and shopper_id), for those devices only. */
  async function claimAll(devices, spec) {
    const only = new Set(devices.map((row) => Number(row.id)));
    const subjects = new Map();
    for (const row of devices) {
      const key = subjectOf(row);
      if (!subjects.has(key)) subjects.set(key, row.shopper_id === null ? { deviceRowId: Number(row.id) } : { shopperId: Number(row.shopper_id) });
    }
    const total = { devices: 0, claimed: 0, capped: 0 };
    for (const subject of subjects.values()) {
      const result = await claimSubject(subject, { ...spec, only });
      for (const key of Object.keys(total)) total[key] += result[key];
    }
    return total;
  }

  // ---- sending ----

  async function endRow(id, status, reason = '', providerId = '') {
    const rows = await db.query(
      `UPDATE shopper_push_log SET status = $3, reason = $4, provider_id = $5, sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE sent_at END
       WHERE tenant_id = $1 AND id = $2 AND status = 'claimed' RETURNING id`,
      [tid(), id, status, String(reason).slice(0, 40), String(providerId ?? '').slice(0, 200)],
    );
    return rows.length > 0;
  }

  /** The provider said this token is gone: the install keeps no token and no toggle (unless it registered a new one meanwhile). */
  async function dropToken(deviceRowId, tokenHash, reason) {
    const notice = await noticeVersion();
    await db.tx(async (t) => {
      const [row] = await t.query('SELECT * FROM shopper_push_devices WHERE tenant_id = $1 AND id = $2 FOR NO KEY UPDATE', [tid(), deviceRowId]);
      if (!row || row.deleted_at || row.token_hash !== tokenHash) return;
      await turnOff(t, row, 'token_rejected', notice);
      await t.query(
        `UPDATE shopper_push_devices SET token_enc = NULL, token_hash = '', deleted_at = now(), delete_reason = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tid(), deviceRowId, reason],
      );
    });
    log.info('shopper_push.token_deleted', { deviceRowId: Number(deviceRowId), reason });
  }

  /** Tells the owner, once a week per platform and cause, that pushes are not going out because of the brand's keys. */
  async function tellSeller(platform, why) {
    try {
      await ctx.repos.alerts.raise({
        kind: 'app.push_keys', severity: 'warning', target: 'push-credentials', message: SELLER_KEY_ALERTS[why](PLATFORM_NAME[platform]),
        dedupeKey: `app.push_keys:${platform}:${why}:${weekStart(service.now())}`,
      });
    } catch (err) {
      reportError(err, { msg: 'shopper_push.alert_failed', platform });
    }
  }

  async function markRefused(platform) {
    const column = CREDENTIAL_OF[platform] === 'fcm' ? 'fcm_status' : 'apns_status';
    await db.query(`UPDATE app_push_credentials SET ${column} = 'invalid' WHERE tenant_id = $1`, [tid()]);
    log.warn('shopper_push.credentials_refused', { platform });
    await tellSeller(platform, 'refused');
  }

  /**
   * Sends one claimed row that has never been tried: read the device again, take the first try, send, record. The first try
   * is taken only from attempts = 0, so of two runs that both picked the row up, one sends and the other finds it gone.
   */
  async function deliver(id, message, sender, batch) {
    const [row] = await db.query(
      `SELECT l.id, l.kind, l.status, l.attempts, d.id AS device_row_id, d.platform, d.token_enc, d.token_hash, d.permission, d.deleted_at,
              d.order_updates_on_at, d.offers_on_at, d.new_reels_on_at
       FROM shopper_push_log l JOIN shopper_push_devices d ON d.tenant_id = l.tenant_id AND d.id = l.device_row_id
       WHERE l.tenant_id = $1 AND l.id = $2`,
      [tid(), id],
    );
    if (!row || row.status !== 'claimed' || Number(row.attempts) !== 0) return 'gone';
    if (!pushable(row) || !onOf(row, KIND_TOGGLE[row.kind])) return (await endRow(id, 'skipped', 'opted_out')) ? 'skipped' : 'gone';
    const problem = shopperPushProblem(message);
    if (problem) return (await endRow(id, 'skipped', `wording:${problem}`)) ? 'skipped' : 'gone';
    if (!sender.configured(row.platform) || batch.refused.has(row.platform)) {
      if (!batch.refused.has(row.platform) && !batch.told.has(row.platform)) {
        batch.told.add(row.platform);
        await tellSeller(row.platform, 'missing');
      }
      return (await endRow(id, 'failed', 'no_credentials')) ? 'failed' : 'gone';
    }
    let token;
    try {
      token = secrets.decrypt(row.token_enc);
    } catch {
      return (await endRow(id, 'skipped', 'token_unreadable')) ? 'skipped' : 'gone';
    }
    let attempts = 0;
    for (;;) {
      // The try is counted before the call: a row whose call may have gone out is never picked up again.
      const [took] = await db.query(
        `UPDATE shopper_push_log SET attempts = attempts + 1 WHERE tenant_id = $1 AND id = $2 AND status = 'claimed' AND attempts = $3 RETURNING attempts`,
        [tid(), id, attempts],
      );
      if (!took) return 'gone';
      attempts = Number(took.attempts);
      try {
        const answer = await sender.send({
          platform: row.platform, token, title: message.title, body: message.body, data: message.data,
          collapseKey: message.collapseKey, ttl: SHOPPER_PUSH_RULES.ttlSeconds,
        });
        if (!answer?.ok) {
          await endRow(id, 'failed', 'no_credentials');
          return 'failed';
        }
        await endRow(id, 'sent', '', answer.id);
        await db.query('UPDATE shopper_push_devices SET last_ok_at = now() WHERE tenant_id = $1 AND id = $2', [tid(), row.device_row_id]);
        return 'sent';
      } catch (err) {
        const kind = isProviderRefusal(err) ? err.kind : '';
        if (kind === 'throttled' && attempts < SHOPPER_PUSH_RULES.maxAttempts) {
          await sleep(service.retryDelayMs(attempts, err.retryAfter));
          continue;
        }
        if (kind === 'unregistered' || kind === 'invalid_token') {
          await endRow(id, 'failed', kind);
          await dropToken(row.device_row_id, row.token_hash, kind);
          return 'failed';
        }
        if (credentialsRefused(err)) {
          batch.refused.add(row.platform);
          await endRow(id, 'failed', 'credentials');
          await markRefused(row.platform);
          return 'failed';
        }
        if (!kind) reportError(err, { msg: 'shopper_push.send_failed', logId: Number(id) });
        await endRow(id, 'failed', kind || 'error');
        return 'failed';
      }
    }
  }

  /** Sends every claimed, never-tried row of one source. -> { sent, failed, skipped } */
  async function sendClaimed(sourceKind, sourceId, message) {
    const rows = await db.query(
      `SELECT id FROM shopper_push_log WHERE tenant_id = $1 AND source_kind = $2 AND source_id = $3 AND status = 'claimed' AND attempts = 0 ORDER BY id`,
      [tid(), sourceKind, sourceId],
    );
    const tally = { sent: 0, failed: 0, skipped: 0 };
    if (!rows.length) return tally;
    const sender = await senderFor(ctx);
    const batch = { refused: new Set(), told: new Set() };
    try {
      for (const { id } of rows) {
        const outcome = await deliver(id, message, sender, batch);
        if (outcome in tally) tally[outcome] += 1;
      }
    } finally {
      sender.close();
    }
    log.info('shopper_push.batch', { sourceKind, ...tally });
    return tally;
  }

  async function hasApp() {
    const [row] = await db.query('SELECT 1 FROM app_configs WHERE tenant_id = $1', [tid()]);
    return Boolean(row) && ((await entitled('android')) || (await entitled('ios')));
  }

  // ---- order updates ----

  /** One order event (SHOPPER_PUSH_KINDS): one push per opted-in device of the order's shopper and of guests following it. */
  service.orderEvent = async (event) => {
    const spec = ORDER_KINDS.includes(event?.type) ? SHOPPER_PUSH_KINDS[event.type] : null;
    if (!spec || !(await hasApp())) return { claimed: 0 };
    const [order] = await db.query('SELECT id, order_number, shopper_id FROM orders WHERE tenant_id = $1 AND id = $2', [tid(), event.orderId]);
    if (!order) return { claimed: 0 };
    const values = { orderNumber: order.order_number };
    const message = {
      title: fillPush(spec.title, values),
      body: fillPush(spec.body, values),
      data: { link: fillPush(spec.link, values), kind: 'order_update' },
      collapseKey: `order-${order.order_number}`.slice(0, 64),
    };
    const problem = shopperPushProblem(message);
    if (problem) {
      log.warn('shopper_push.wording_refused', { kind: 'order_update', reason: problem });
      return { claimed: 0 };
    }
    const devices = await db.query(
      `SELECT id, shopper_id FROM shopper_push_devices
       WHERE tenant_id = $1 AND ${PUSHABLE} AND order_updates_on_at IS NOT NULL
         AND (shopper_id = $2 OR id IN (SELECT device_row_id FROM shopper_push_orders WHERE tenant_id = $1 AND order_id = $3))`,
      [tid(), order.shopper_id ?? null, order.id],
    );
    const sourceId = String(event.id);
    // Not capped and never delayed; the claim still locks the subject's rows and reads the toggle again.
    const { claimed } = await claimAll(devices, { kind: 'order_update', sourceKind: 'order_event', sourceId, toggle: 'order_updates', platforms: null, week: weekStart(service.now()) });
    const tally = await sendClaimed('order_event', sourceId, message);
    return { claimed, ...tally };
  };

  // ---- offers ----

  const offerMessage = (c) => ({ title: c.title, body: c.body, data: { link: c.link_path, kind: 'offer' }, collapseKey: `offer-${c.id}` });

  function wordingError(problem, offer = null) {
    let [field, message] = WORDING[problem] ?? ['body', 'Please check the offer’s words'];
    // Name the field that holds it: the title when the title alone is refused for the same reason.
    if (field === 'body' && offer && shopperPushProblem({ ...offer, body: '' }) === problem) field = 'title';
    return new ApiError('validation_failed', message, { fields: { [field]: message } });
  }

  async function block(id, reason, counts = {}) {
    const [row] = await db.query(
      `UPDATE push_campaigns SET status = 'blocked', block_reason = $3, audience_count = $4, capped_count = $5
       WHERE tenant_id = $1 AND id = $2 AND status = 'queued' RETURNING *`,
      [tid(), id, reason, counts.audience ?? 0, counts.capped ?? 0],
    );
    log.info('shopper_push.campaign_blocked', { campaignId: Number(id), reason });
    return row;
  }

  function refusalFor(campaign) {
    switch (campaign.block_reason) {
      case 'weekly_cap': return new ApiError('conflict', CAP_MESSAGE);
      case 'no_credentials': return new ApiError('conflict', NO_CREDENTIALS_MESSAGE);
      case 'no_audience': return new ApiError('conflict', NO_AUDIENCE_MESSAGE);
      default: return wordingError(shopperPushProblem(offerMessage(campaign)), offerMessage(campaign));
    }
  }

  async function campaignRow(id) {
    const [row] = await db.query(
      `SELECT c.*, cp.code AS coupon_code FROM push_campaigns c LEFT JOIN coupons cp ON cp.tenant_id = c.tenant_id AND cp.id = c.coupon_id
       WHERE c.tenant_id = $1 AND c.id = $2`,
      [tid(), id],
    );
    return row ?? null;
  }

  const campaignView = (c) => ({
    id: Number(c.id), title: c.title, body: c.body, couponCode: c.coupon_code ?? null, linkPath: c.link_path, status: c.status, blockReason: c.block_reason,
    audienceCount: Number(c.audience_count), sentCount: Number(c.sent_count), cappedCount: Number(c.capped_count), failedCount: Number(c.failed_count),
    createdAt: c.created_at, sentAt: c.sent_at ?? null,
  });

  /** An offer to everyone who turned Offers on. 409 "Weekly offer limit reached" when every one of them is at the cap. */
  service.sendCampaign = async (input, actor) => {
    await requireApp();
    const body = parseBody(PushCampaignSend, input);
    if (body.couponId) {
      const [coupon] = await db.query('SELECT id FROM coupons WHERE tenant_id = $1 AND id = $2', [tid(), body.couponId]);
      if (!coupon) throw new ApiError('validation_failed', 'Choose a coupon of your store', { fields: { couponId: 'Choose a coupon of your store' } });
    }
    const now = service.now();
    const sendAfter = inQuietHours(now) ? quietEnd(now) : null;
    const actorId = Number(actor?.id);
    const [created] = await db.query(
      `INSERT INTO push_campaigns (tenant_id, title, body, coupon_id, link_path, created_by, request_key, send_after)
       SELECT $1, $2, $3, $4, $5, (SELECT id FROM users WHERE tenant_id = $1 AND id = $6), $7, $8
       ON CONFLICT (tenant_id, request_key) DO NOTHING RETURNING id`,
      [tid(), body.title, body.body, body.couponId ?? null, body.linkPath, Number.isSafeInteger(actorId) ? actorId : null, body.requestKey, sendAfter],
    );
    if (!created) {
      // The same request again: the first answer again, and nothing sent twice.
      const [known] = await db.query('SELECT id FROM push_campaigns WHERE tenant_id = $1 AND request_key = $2', [tid(), body.requestKey]);
      const existing = await campaignRow(known.id);
      if (existing.status === 'blocked') throw refusalFor(existing);
      return campaignView(existing);
    }
    const campaign = await campaignRow(created.id);
    const problem = shopperPushProblem(offerMessage(campaign));
    if (problem) {
      await block(campaign.id, 'wording');
      throw wordingError(problem, offerMessage(campaign));
    }
    const platforms = await sendablePlatforms();
    if (!platforms.length) {
      await block(campaign.id, 'no_credentials');
      throw new ApiError('conflict', NO_CREDENTIALS_MESSAGE);
    }
    const devices = await db.query(
      `SELECT id, shopper_id FROM shopper_push_devices WHERE tenant_id = $1 AND ${PUSHABLE} AND offers_on_at IS NOT NULL AND platform = ANY($2::text[]) ORDER BY id`,
      [tid(), platforms],
    );
    const result = await claimAll(devices, { kind: 'offer', sourceKind: 'campaign', sourceId: String(campaign.id), toggle: 'offers', platforms, week: weekStart(sendAfter ?? now) });
    if (!result.devices) {
      await block(campaign.id, 'no_audience');
      throw new ApiError('conflict', NO_AUDIENCE_MESSAGE);
    }
    if (!result.claimed) {
      await block(campaign.id, 'weekly_cap', { audience: result.devices, capped: result.capped });
      throw new ApiError('conflict', CAP_MESSAGE);
    }
    await db.query('UPDATE push_campaigns SET audience_count = $3, capped_count = $4 WHERE tenant_id = $1 AND id = $2', [tid(), campaign.id, result.devices, result.capped]);
    await ctx.platform.queue.enqueue(SHOPPER_PUSH_QUEUE, { campaignId: Number(campaign.id) }, {
      tenantId: tid(), delayMs: sendAfter ? Math.max(0, sendAfter.getTime() - now.getTime()) : 0, dedupeKey: `campaign:${tid()}:${campaign.id}`,
    });
    log.info('shopper_push.campaign_queued', { campaignId: Number(campaign.id), audience: result.devices, claimed: result.claimed, capped: result.capped, waits: Boolean(sendAfter) });
    return campaignView(await campaignRow(campaign.id));
  };

  /** The queue's job: sends a campaign's claimed rows once its quiet hours are over. */
  service.runCampaign = async (id) => {
    const now = service.now();
    const campaign = await campaignRow(Number(id));
    if (!campaign || !['queued', 'sending'].includes(campaign.status)) return null;
    if (campaign.send_after && new Date(campaign.send_after) > now) return null;
    if (inQuietHours(now)) {
      await db.query(`UPDATE push_campaigns SET send_after = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'queued'`, [tid(), campaign.id, quietEnd(now)]);
      return null;
    }
    const taken = await db.query(`UPDATE push_campaigns SET status = 'sending' WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'sending') RETURNING id`, [tid(), campaign.id]);
    if (!taken.length) return null;
    const sourceId = String(campaign.id);
    await sendClaimed('campaign', sourceId, offerMessage(campaign));
    // A row whose try was taken (attempts > 0) is never sent again, whoever took it: a run still sending it ends it itself,
    // and one that died left it as it is, counted as neither sent nor failed. Only never-tried rows keep the campaign open.
    const [counts] = await db.query(
      `SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'claimed' AND attempts = 0)::int AS waiting
       FROM shopper_push_log WHERE tenant_id = $1 AND source_kind = 'campaign' AND source_id = $2`,
      [tid(), sourceId],
    );
    if (counts.waiting) return campaignView(await campaignRow(campaign.id));
    // The last run to finish writes the final counts, so two runs that overlapped still add up.
    await db.query(
      `UPDATE push_campaigns SET status = CASE WHEN $3 > 0 OR $4 = 0 THEN 'sent' ELSE 'failed' END, sent_count = $3, failed_count = $4,
         sent_at = COALESCE(sent_at, now())
       WHERE tenant_id = $1 AND id = $2 AND status IN ('sending', 'sent', 'failed')`,
      [tid(), campaign.id, counts.sent, counts.failed],
    );
    return campaignView(await campaignRow(campaign.id));
  };

  service.campaigns = async (query = {}) => {
    await requireApp();
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    if (query.cursor !== undefined && !/^[0-9]{1,18}$/.test(String(query.cursor))) throw new ApiError('validation_failed', 'Invalid cursor', { fields: { cursor: 'Invalid cursor' } });
    const rows = await db.query(
      `SELECT c.*, cp.code AS coupon_code FROM push_campaigns c LEFT JOIN coupons cp ON cp.tenant_id = c.tenant_id AND cp.id = c.coupon_id
       WHERE c.tenant_id = $1 AND ($2::bigint IS NULL OR c.id < $2::bigint) ORDER BY c.id DESC LIMIT $3`,
      [tid(), query.cursor ?? null, limit + 1],
    );
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map(campaignView);
    return { items, nextCursor: more ? String(items[items.length - 1].id) : null };
  };

  service.summary = async () => {
    await requireApp();
    const [opted] = await db.query(
      `SELECT count(*) FILTER (WHERE order_updates_on_at IS NOT NULL)::int AS order_updates, count(*) FILTER (WHERE offers_on_at IS NOT NULL)::int AS offers,
              count(*) FILTER (WHERE new_reels_on_at IS NOT NULL)::int AS new_reels
       FROM shopper_push_devices WHERE tenant_id = $1 AND ${PUSHABLE}`,
      [tid()],
    );
    const platforms = await sendablePlatforms();
    const [reach] = await db.query(
      `SELECT count(*)::int AS n FROM shopper_push_devices d
       WHERE d.tenant_id = $1 AND d.deleted_at IS NULL AND d.token_enc IS NOT NULL AND d.permission IN ('granted', 'provisional')
         AND d.offers_on_at IS NOT NULL AND d.platform = ANY($2::text[])
         AND (SELECT count(DISTINCT l.source_kind || ':' || l.source_id) FROM shopper_push_log l
              WHERE l.tenant_id = d.tenant_id AND l.week_start = $3 AND l.kind IN ('offer', 'new_reel') AND l.status <> 'skipped'
                AND l.cap_subject = CASE WHEN d.shopper_id IS NULL THEN 'd:' || d.id ELSE 's:' || d.shopper_id END) < $4`,
      [tid(), platforms, weekStart(service.now()), weeklyCap()],
    );
    return {
      weeklyCap: weeklyCap(),
      optedIn: { orderUpdates: opted.order_updates, offers: opted.offers, newReels: opted.new_reels },
      reachableNow: reach.n,
      credentials: { android: platforms.includes('android'), ios: platforms.includes('ios') },
    };
  };

  // ---- new reels ----

  async function reelCandidate(event, now) {
    const [row] = await db.query(
      `SELECT ${PAGE_COLS}, cr.starts_at, cr.ends_at, c.name AS category_name, c.visible AS category_visible
       FROM category_reels cr
       JOIN reels r ON r.tenant_id = cr.tenant_id AND r.id = cr.page_id
       JOIN categories c ON c.tenant_id = cr.tenant_id AND c.id = cr.category_id
       WHERE cr.tenant_id = $1 AND cr.category_id = $2 AND cr.page_id = $3`,
      [tid(), event.category_id, event.page_id],
    );
    if (!row || !row.category_visible || !row.slug || hiddenReason(row, now) !== '') return null;
    const spec = SHOPPER_PUSH_KINDS.new_reel;
    const category = String(row.category_name ?? '').replace(/\s+/g, ' ').trim().slice(0, SHOPPER_PUSH_RULES.titleMax - 7);
    const message = {
      title: fillPush(spec.title, { category }),
      body: fillPush(spec.body, {}),
      data: { link: fillPush(spec.link, { slug: row.slug }), kind: 'new_reel' },
      collapseKey: 'new-reel',
    };
    return shopperPushProblem(message) ? null : message;
  }

  /** The schedule's job: reels that joined a category at least mergeMs ago. The newest visible one is pushed once; the rest merge. */
  service.runReels = async () => {
    const now = service.now();
    if (inQuietHours(now)) return { pushed: false };
    const due = await db.query(
      `SELECT id, category_id, page_id FROM shopper_push_events WHERE tenant_id = $1 AND processed_at IS NULL AND created_at <= $2
       ORDER BY created_at DESC, id DESC LIMIT 200`,
      [tid(), new Date(now.getTime() - SHOPPER_PUSH_RULES.mergeMs)],
    );
    if (!due.length) return { pushed: false };
    const finish = (ids, outcome) => (ids.length ? db.query(
      `UPDATE shopper_push_events SET processed_at = now(), outcome = $3 WHERE tenant_id = $1 AND id = ANY($2::bigint[]) AND processed_at IS NULL`,
      [tid(), ids, outcome],
    ) : null);
    if (!(await hasApp())) {
      await finish(due.map((e) => e.id), 'no_app');
      return { pushed: false };
    }
    let chosen = null;
    const merged = [];
    const hidden = [];
    for (const event of due) {
      const message = await reelCandidate(event, now);
      if (!message) hidden.push(event.id);
      else if (!chosen) chosen = { event, message };
      else merged.push(event.id);
    }
    await finish(hidden, 'not_visible');
    await finish(merged, 'merged');
    if (!chosen) return { pushed: false };
    const sourceId = `${chosen.event.category_id}:${chosen.event.page_id}`;
    const platforms = await sendablePlatforms();
    const devices = platforms.length ? await db.query(
      `SELECT id, shopper_id FROM shopper_push_devices WHERE tenant_id = $1 AND ${PUSHABLE} AND new_reels_on_at IS NOT NULL AND platform = ANY($2::text[]) ORDER BY id`,
      [tid(), platforms],
    ) : [];
    const result = await claimAll(devices, { kind: 'new_reel', sourceKind: 'category_reel', sourceId, toggle: 'new_reels', platforms, week: weekStart(now) });
    const tally = await sendClaimed('category_reel', sourceId, chosen.message);
    await finish([chosen.event.id], result.devices ? 'sent' : 'no_audience');
    return { pushed: true, ...result, ...tally };
  };

  // ---- the brand's own credentials ----

  function credentialsView(row) {
    return {
      fcm: { set: Boolean(row?.fcm_service_account_enc), projectId: row?.fcm_project_id ?? '', clientEmailMasked: maskEmail(row?.fcm_client_email), status: row?.fcm_status ?? 'not_set' },
      apns: {
        set: Boolean(row?.apns_key_enc), keyId: row?.apns_key_id ?? '', teamId: row?.apns_team_id ?? '', topic: row?.apns_topic ?? '',
        env: row?.apns_env ?? 'production', status: row?.apns_status ?? 'not_set',
      },
    };
  }

  service.credentials = {
    async get() {
      await requireApp();
      return credentialsView(await credentialRow());
    },
    async save(input, actor) {
      await requireApp();
      const body = parseBody(PushCredentialsUpdate, input);
      if (body.fcm !== undefined) await requireApp('android');
      if (body.apns !== undefined) await requireApp('ios');
      const encrypt = (value) => {
        if (!secrets.configured) throw new ApiError('conflict', 'Keys can’t be stored yet. Please contact support.');
        return secrets.encrypt(value);
      };
      const sets = [];
      const params = [];
      const set = (column, value) => {
        params.push(value);
        sets.push(`${column} = $${params.length + 1}`);
      };
      const changed = {};
      if (body.fcm === null) {
        set('fcm_project_id', ''); set('fcm_client_email', ''); set('fcm_service_account_enc', null); set('fcm_status', 'not_set');
        changed.fcm = 'removed';
      } else if (body.fcm) {
        const { projectId, clientEmail } = checkServiceAccount(body.fcm.serviceAccount);
        set('fcm_project_id', projectId); set('fcm_client_email', clientEmail); set('fcm_service_account_enc', encrypt(body.fcm.serviceAccount)); set('fcm_status', 'ok');
        changed.fcm = 'set';
      }
      if (body.apns === null) {
        set('apns_key_id', ''); set('apns_team_id', ''); set('apns_topic', ''); set('apns_key_enc', null); set('apns_status', 'not_set');
        changed.apns = 'removed';
      } else if (body.apns) {
        checkApnsKey(body.apns.key);
        const [app] = await db.query('SELECT ios_bundle_id FROM app_configs WHERE tenant_id = $1', [tid()]);
        set('apns_key_id', body.apns.keyId); set('apns_team_id', body.apns.teamId); set('apns_topic', String(app?.ios_bundle_id ?? '').slice(0, 155));
        set('apns_env', body.apns.env); set('apns_key_enc', encrypt(body.apns.key)); set('apns_status', 'ok');
        changed.apns = 'set';
      }
      const actorId = Number(actor?.id);
      const saved = await db.tx(async (t) => {
        await t.query('INSERT INTO app_push_credentials (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tid()]);
        const [row] = await t.query(
          `UPDATE app_push_credentials SET ${[...sets, `updated_by = (SELECT id FROM users WHERE tenant_id = $1 AND id = $${params.length + 2})`, 'updated_at = now()'].join(', ')}
           WHERE tenant_id = $1 RETURNING *`,
          [tid(), ...params, Number.isSafeInteger(actorId) ? actorId : null],
        );
        // The change and its audit row land together; the row says what changed, never a word of a key.
        await writeAudit(t, { actor: Number.isSafeInteger(actorId) ? `user:${actorId}` : 'user:unknown', action: 'push_credentials.save', target: 'push_credentials', details: changed });
        return row;
      });
      log.info('shopper_push.credentials_saved', changed);
      return credentialsView(saved);
    },
  };

  // ---- the schedule ----

  /** Every minute, from any worker: hands each business's due campaigns and due reel pushes to the queue. Platform-wide read. */
  service.scan = async () => {
    const now = service.now();
    const platformDb = db.platform ?? db;
    const slot = Math.floor(now.getTime() / 600_000);
    const campaigns = await platformDb.query(
      `SELECT tenant_id, id FROM push_campaigns WHERE status IN ('queued', 'sending') AND (send_after IS NULL OR send_after <= $1)
         AND created_at <= $1::timestamptz - interval '1 minute' ORDER BY id LIMIT 500`,
      [now],
    );
    for (const c of campaigns) {
      await ctx.platform.queue.enqueue(SHOPPER_PUSH_QUEUE, { campaignId: Number(c.id) }, { tenantId: c.tenant_id, dedupeKey: `campaign:${c.tenant_id}:${c.id}:${slot}` });
    }
    if (inQuietHours(now)) return { campaigns: campaigns.length, reels: 0 };
    const reels = await platformDb.query(
      `SELECT DISTINCT tenant_id FROM shopper_push_events WHERE processed_at IS NULL AND created_at <= $1 LIMIT 500`,
      [new Date(now.getTime() - SHOPPER_PUSH_RULES.mergeMs)],
    );
    const minute = Math.floor(now.getTime() / 60_000);
    for (const r of reels) await ctx.platform.queue.enqueue(SHOPPER_PUSH_QUEUE, { reels: true }, { tenantId: r.tenant_id, dedupeKey: `reels:${r.tenant_id}:${minute}` });
    return { campaigns: campaigns.length, reels: reels.length };
  };

  /** What the queue job runs, as the job's business. */
  service.work = async (payload = {}) => {
    if (Number.isSafeInteger(Number(payload.campaignId)) && Number(payload.campaignId) > 0) return service.runCampaign(Number(payload.campaignId));
    if (payload.reels === true) return service.runReels();
    return null;
  };

  return service;
}
