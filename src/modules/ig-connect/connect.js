import crypto from 'node:crypto';
import { safeNext } from '../../auth.js';
import { ApiError } from '../../contracts/api/index.js';
import { OAuthCallbackQuery, OWNER_APP_CALLBACK, PROVIDER_PATHS } from '../../contracts/api/provider.js';
import { log, reportError } from '../../platform/log.js';
import { currentTenant, normalizeHost, tenantId, withTenant } from '../../tenancy.js';
import { claimConnection, tellPassedOver } from '../ig-accounts/claim.js';
import { tenantBaseUrl } from '../admin-api/urls.js';
import { messagePage } from './pages.js';
import { SCOPES_TO_GO_LIVE, SCOPE_INSIGHTS, READ_RECEIPTS_FIELD, WEBHOOK_FIELD_SCOPES, nextRefreshAt } from './rules.js';
import { secretBinding } from '../../contracts/secrets.js';

const STATE_TTL_MS = 10 * 60_000;
const DEFAULT_RETURN = '/admin/settings';
const MANAGER_ROLES = new Set(['owner', 'manager']);
const CLOSED_STATUSES = new Set(['suspended', 'closed', 'killed']);

const hashState = (state) => crypto.createHash('sha256').update(state).digest('hex');
const FINISH_TOKEN = /^[\w-]{20,200}$/;

/**
 * Connecting an Instagram account (PRD 4.2). One Meta app serves every business, so Meta sends everyone back to one registered address and
 * the `state` says which business and who started it. A state is random, stored only as a hash, lasts 10 minutes and works once.
 *
 * The callback never saves the account itself (D-4): whoever finishes Meta's consent holds the callback, so an authorize
 * address passed to someone else would put their Instagram on this business. The callback keeps Meta's answer, encrypted,
 * against a one-time finish token, and the connect is finished only in the session of the person who started it: the
 * console's cookie on the host it started from (GET PROVIDER_PATHS.instagramFinish), or the owner app's own token
 * (instagram.connectFinish, after Meta returns to the app's scheme). Any other browser is refused, audited, and the
 * token is spent.
 */
export function createConnect({ db, repos, meta, config, platform, gates }) {
  const platformDb = db.platform;

  const callbackBase = (req) => config.metaCallbackBaseUrl || config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
  const redirectUri = (req) => `${callbackBase(req)}${PROVIDER_PATHS.instagramCallback}`;

  /** Where the browser lands, on the business's own address. */
  function landing(tenant, returnTo, outcome) {
    const base = tenantBaseUrl(tenant, config);
    const url = new URL(safeNext(returnTo, DEFAULT_RETURN), base || 'http://relative.invalid');
    url.searchParams.set('instagram', outcome);
    return base ? url.href : `${url.pathname}${url.search}`;
  }

  async function start({ user, returnTo, req }) {
    if (!platform.secrets.configured) throw new ApiError('conflict', 'Instagram connection isn’t set up on this server yet.');
    const state = crypto.randomBytes(32).toString('base64url');
    let authorizeUrl;
    try {
      authorizeUrl = meta.login.authorizeUrl({ state, redirectUri: redirectUri(req) });
    } catch (err) {
      reportError(err, { msg: 'ig_connect.not_configured' });
      throw new ApiError('conflict', 'Instagram connection isn’t set up on this server yet.');
    }
    await repos.igConnect.saveState({
      stateHash: hashState(state),
      provider: meta.login.kind,
      userId: user.id,
      returnTo: safeNext(returnTo, DEFAULT_RETURN),
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
      via: req.bearer ? 'bearer' : 'cookie',
      startHost: req.bearer ? '' : normalizeHost(req.hostname),
    });
    return { authorizeUrl };
  }

  /** Marks the state used and returns its row. Null for anything but a live, unused state from this login. */
  async function consumeState(state) {
    const [row] = await platformDb.query(
      `UPDATE oauth_states SET used_at = now() WHERE state_hash = $1 AND provider = $2 AND used_at IS NULL AND expires_at > now() RETURNING *`,
      [hashState(state), meta.login.kind],
    );
    return row ?? null;
  }

  /**
   * Puts the account on this business, or says it can't be (null). An account sends for one business at a time, because webhooks
   * route by its id alone. A row another business released by disconnecting stays theirs, with its history (tenancy-1); any other is theirs.
   */
  const claimAccount = (tenant, login) => claimConnection(platformDb, 'instagram', { tenantId: tenant.id, accountId: login.igUserId, name: login.username });

  /**
   * The subscription belongs to the Instagram account under both logins. Under Unified Login the Page's own subscription accepts
   * only Page fields (messages needs pages_messaging, and comments, live_comments and mentions are not Page fields, so Meta refused
   * the whole request with error 100); the account's subscribed_apps takes all five, with the Page token the account already holds.
   */
  const subscriptionTarget = (detail, account) => account;

  /** Tells Meta to send this account's events here (PRD 4.1), only the fields its granted permissions allow. False leaves it for the hourly retry. */
  async function subscribe(igUserId) {
    const detail = await repos.igAccounts.detail(igUserId);
    const account = await repos.igAccounts.get(igUserId);
    const fields = Object.entries(WEBHOOK_FIELD_SCOPES).filter(([, scope]) => detail?.scopes.includes(scope)).map(([field]) => field);
    if (config.readReceipts && fields.includes('messages')) fields.push(READ_RECEIPTS_FIELD);
    if (!account?.token || !fields.length) return false;
    try {
      const answer = await meta.client.forAccount(subscriptionTarget(detail, account)).subscribe(fields);
      if (answer?.success === false) throw new Error('Meta did not accept the subscription');
      await repos.igAccounts.setSubscribed(igUserId, fields);
      return true;
    } catch (err) {
      log.warn('ig_connect.subscribe_failed', { igUserId, kind: err.kind, status: err.status, code: err.code });
      return false;
    }
  }

  /** Only one account sends for a business. Connecting a different one ends the old one. */
  async function retireOthers(igUserId, actor) {
    for (const other of await repos.igAccounts.othersWithTokens(igUserId)) await disconnect(other, actor);
  }

  async function disconnect(igUserId, actor) {
    const [account, detail] = await Promise.all([repos.igAccounts.get(igUserId), repos.igAccounts.detail(igUserId)]);
    if (account?.token) {
      try {
        await meta.client.forAccount(subscriptionTarget(detail, account)).unsubscribe();
      } catch (err) {
        // The token goes either way, and Meta stops delivering once it is dead.
        log.warn('ig_connect.unsubscribe_failed', { igUserId, kind: err.kind, status: err.status, code: err.code });
      }
    }
    return repos.igAccounts.disconnect(igUserId, { actor });
  }

  /** Permission to read insights is optional, and missing it means slow mode and a prompt to reconnect (PRD 4.15). */
  async function applyInsightsChoice(account) {
    const denied = !account.scopes.includes(SCOPE_INSIGHTS);
    await repos.igAccounts.setInsightsDenied(account.igUserId, denied);
    if (!denied) return;
    await repos.alerts.raise({
      kind: 'instagram.permission_needed',
      message: 'Bhava can’t read your Instagram insights, so automations run in slow mode and insights show “Permission needed”. Reconnect Instagram and allow insights to fix this.',
      target: `instagram:${account.igUserId}`,
      dedupeKey: `insights:${account.igUserId}:${account.tokenVersion}`,
    });
  }

  /** Who started it, if they may still connect Instagram here. */
  async function starter(state) {
    const person = state.user_id ? await repos.users.get(state.user_id) : null;
    return person && MANAGER_ROLES.has(person.role) ? person : null;
  }

  /**
   * The business, the person, the code: Meta's answer, or the word that goes on the return address as ?instagram= when
   * there is nothing to finish. Saves nothing.
   */
  async function receive({ state, code, oauthError, req }) {
    if (oauthError) return { outcome: 'denied' };
    if (!code) return { outcome: 'failed' };
    if (!(await starter(state))) return { outcome: 'forbidden' };

    let login;
    try {
      login = await meta.login.connect({ code, redirectUri: redirectUri(req) });
    } catch (err) {
      log.warn('ig_connect.exchange_failed', { kind: err.kind, status: err.status, code: err.code });
      return { outcome: 'failed' };
    }
    if (!login.token || !/^\w+$/.test(login.igUserId) || login.igUserId === 'undefined') {
      log.warn('ig_connect.exchange_failed', { kind: 'malformed' });
      return { outcome: 'failed' };
    }
    return { login };
  }

  /** Spends a finish token: the state row and Meta's answer, once, while the state is live. Null otherwise. */
  async function takeFinish(token) {
    if (!FINISH_TOKEN.test(String(token ?? ''))) return null;
    const [row] = await platformDb.query(
      `WITH taken AS (
         SELECT state_hash, pending_login_enc FROM oauth_states
         WHERE finish_hash = $1 AND provider = $2 AND finished_at IS NULL AND expires_at > now() FOR UPDATE
       )
       UPDATE oauth_states o SET finished_at = now(), pending_login_enc = '' FROM taken WHERE o.state_hash = taken.state_hash
       RETURNING o.state_hash, o.tenant_id, o.user_id, o.return_to, o.via, taken.pending_login_enc AS pending`,
      [hashState(token), meta.login.kind],
    );
    if (!row) return null;
    let login = null;
    try {
      login = row.pending ? JSON.parse(platform.secrets.decrypt(row.pending, secretBinding('oauth_states', 'pending_login_enc', row))) : null;
    } catch (err) {
      reportError(err, { msg: 'ig_connect.pending_unreadable' });
    }
    if (login?.expiresAt) login.expiresAt = new Date(login.expiresAt);
    return { tenant_id: row.tenant_id, user_id: row.user_id, return_to: row.return_to, via: row.via, login };
  }

  /** A finish someone other than the person who started it tried: refused, on the audit log, and the token is spent. */
  async function refuseFinish(row, reason) {
    log.warn('ig_connect.finish_refused', { reason });
    await withTenant({ id: row.tenant_id }, () => repos.audit.record({ actor: 'system', action: 'instagram.connect_refused', target: 'instagram:pending', details: { reason, startedBy: row.user_id ?? null } }))
      .catch((err) => reportError(err, { msg: 'ig_connect.audit_failed' }));
  }

  /** The last step, in the business and by the person who started it: the account goes on this business. */
  async function complete({ state, login }) {
    const person = await starter(state);
    if (!person) return 'forbidden';
    if (!login?.token) return 'failed';
    const tenant = { id: state.tenant_id };
    const claim = await claimAccount(tenant, login);
    if (!claim) {
      log.warn('ig_connect.account_taken', { igUserId: login.igUserId });
      // The account is another business's: a referral between the two is a self-referral (F-129). The connect trigger of
      // migration 741 never runs for a refused account, so the block is made here (migration 986).
      await platformDb.query('SELECT block_same_instagram_referrals($1, $2)', [String(login.igUserId), Number(tenant.id)]);
      await repos.audit.record({ actor: `user:${person.id}`, action: 'instagram.connect_refused', target: `instagram:${login.igUserId}`, details: { reason: 'other_business' } });
      return 'taken';
    }
    const { account } = await repos.igAccounts.saveConnection({ ...login, connectedBy: person.id, nextRefreshAt: nextRefreshAt(Date.now(), login.expiresAt) });
    await tellPassedOver({ db, repos }, 'instagram', login.igUserId, claim.passedOver);
    await retireOthers(account.igUserId, `user:${person.id}`);
    await subscribe(account.igUserId);
    await applyInsightsChoice(account);
    await gates.evaluate().catch((err) => reportError(err, { msg: 'ig_connect.gates_failed' }));
    return SCOPES_TO_GO_LIVE.every((scope) => account.scopes.includes(scope)) ? 'connected' : 'missing_scopes';
  }

  /** Where the browser goes after the callback: on to the finish step, or the outcome when there is nothing to finish. */
  function onward(req, tenant, state, { outcome = null, finishToken = null }) {
    if (state.via === 'bearer') {
      // The owner app's own scheme: the app finishes with its token (instagram.connectFinish).
      return `${OWNER_APP_CALLBACK}?${finishToken ? `instagram=finish&f=${encodeURIComponent(finishToken)}` : `instagram=${encodeURIComponent(outcome)}`}`;
    }
    if (!finishToken) return landing(tenant, state.return_to, outcome);
    // The host the console started from, where its session cookie is.
    const path = `${PROVIDER_PATHS.instagramFinish}?f=${encodeURIComponent(finishToken)}`;
    if (state.start_host) return `${req.protocol}://${state.start_host}${path}`;
    const base = tenantBaseUrl(tenant, config);
    return base ? `${base.replace(/\/$/, '')}${path}` : path;
  }

  async function callback(req, res) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const query = OAuthCallbackQuery.safeParse(req.query);
    if (!query.success || !query.data.state) return messagePage(res, 400, expiredLink);
    const state = await consumeState(query.data.state);
    if (!state) {
      log.warn('ig_connect.bad_state');
      return messagePage(res, 400, expiredLink);
    }
    const tenant = await repos.tenants.get(state.tenant_id);
    if (!tenant || CLOSED_STATUSES.has(tenant.status)) return messagePage(res, 400, expiredLink);
    const got = await withTenant(tenant, () => receive({ state, code: query.data.code, oauthError: query.data.error, req }));
    if (!got.login) return res.redirect(303, onward(req, tenant, state, { outcome: got.outcome }));
    // Meta's answer waits here, encrypted, for the finish step; nothing is saved to the business yet.
    const finishToken = crypto.randomBytes(32).toString('base64url');
    await platformDb.query(
      'UPDATE oauth_states SET finish_hash = $2, pending_login_enc = $3 WHERE state_hash = $1',
      [state.state_hash, hashState(finishToken), platform.secrets.encrypt(JSON.stringify(got.login), secretBinding('oauth_states', 'pending_login_enc', state))],
    );
    return res.redirect(303, onward(req, tenant, state, { finishToken }));
  }

  /**
   * GET PROVIDER_PATHS.instagramFinish?f=<token> on the host the console started from: only the signed-in cookie session
   * of the person who started the connect, in this business, finishes it.
   */
  async function finishInBrowser(req, res) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const tenant = currentTenant();
    const row = await takeFinish(req.query.f);
    if (!row) {
      log.warn('ig_connect.finish_unknown');
      return messagePage(res, 400, expiredLink);
    }
    if (!tenant || Number(row.tenant_id) !== Number(tenant.id)) {
      await refuseFinish(row, 'other_business');
      return messagePage(res, 400, expiredLink);
    }
    if (row.via !== 'cookie' || req.bearer || !req.user || Number(req.user.id) !== Number(row.user_id)) {
      await refuseFinish(row, req.user ? 'other_person' : 'not_signed_in');
      return messagePage(res, 400, expiredLink);
    }
    const outcome = await complete({ state: row, login: row.login });
    return res.redirect(303, landing(tenant, row.return_to, outcome));
  }

  /** instagram.connectFinish: the owner app's last step, with its own token. */
  async function finishByApp({ finishToken, user }) {
    const row = await takeFinish(finishToken);
    if (!row) return { outcome: 'expired' };
    if (Number(row.tenant_id) !== Number(tenantId())) {
      await refuseFinish(row, 'other_business');
      return { outcome: 'expired' };
    }
    if (row.via !== 'bearer' || Number(user.id) !== Number(row.user_id)) {
      await refuseFinish(row, 'other_person');
      throw new ApiError('forbidden', 'Only the person who started connecting Instagram can finish it. Start again.');
    }
    return { outcome: await complete({ state: row, login: row.login }) };
  }

  return { start, callback, finishInBrowser, finishByApp, subscribe, disconnect };
}

const expiredLink = {
  title: 'This link has expired',
  text: 'Connecting Instagram has to be finished within 10 minutes, and each link works once. Go back to Bhava and press Connect Instagram again.',
};
