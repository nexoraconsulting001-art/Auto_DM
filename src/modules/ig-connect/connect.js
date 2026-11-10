import crypto from 'node:crypto';
import { safeNext } from '../../auth.js';
import { ApiError } from '../../contracts/api/index.js';
import { OAuthCallbackQuery, PROVIDER_PATHS } from '../../contracts/api/provider.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { DISCONNECTED_BY_OWNER } from '../ig-accounts/index.js';
import { tenantBaseUrl } from '../admin-api/urls.js';
import { messagePage } from './pages.js';
import { SCOPES_TO_GO_LIVE, SCOPE_INSIGHTS, WEBHOOK_FIELD_SCOPES, nextRefreshAt } from './rules.js';

const STATE_TTL_MS = 10 * 60_000;
const DEFAULT_RETURN = '/admin/settings';
const MANAGER_ROLES = new Set(['owner', 'manager']);
const CLOSED_STATUSES = new Set(['suspended', 'closed', 'killed']);

const hashState = (state) => crypto.createHash('sha256').update(state).digest('hex');

/**
 * Connecting an Instagram account (PRD 4.2). One Meta app serves every business, so Meta sends everyone back to one registered address and
 * the `state` says which business and who started it. A state is random, stored only as a hash, lasts 10 minutes and works once.
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
   * Puts the account on this business, or says it can't be. An account belongs to one business, because webhooks route by its id alone.
   * A row another business left behind by disconnecting is cleared; any other is theirs.
   */
  async function claimAccount(tenant, login) {
    return platformDb.tx(async (t) => {
      const [row] = await t.query('SELECT tenant_id, access_token_enc, status_reason FROM ig_accounts WHERE ig_user_id = $1 FOR UPDATE', [login.igUserId]);
      if (row && row.tenant_id !== tenant.id) {
        if (row.access_token_enc !== '' || row.status_reason !== DISCONNECTED_BY_OWNER) return false;
        await t.query('DELETE FROM ig_accounts WHERE ig_user_id = $1', [login.igUserId]);
      }
      await t.query('INSERT INTO ig_accounts (ig_user_id, tenant_id, username) VALUES ($1, $2, $3) ON CONFLICT (ig_user_id) DO NOTHING', [login.igUserId, tenant.id, login.username]);
      return true;
    });
  }

  /** Under Unified Login the subscription belongs to the Page behind the account. */
  const subscriptionTarget = (detail, account) => (detail?.loginKind === 'unified' && detail.pageId ? { pageId: detail.pageId, token: account.token } : account);

  /** Tells Meta to send this account's events here (PRD 4.1), only the fields its granted permissions allow. False leaves it for the hourly retry. */
  async function subscribe(igUserId) {
    const detail = await repos.igAccounts.detail(igUserId);
    const account = await repos.igAccounts.get(igUserId);
    const fields = Object.entries(WEBHOOK_FIELD_SCOPES).filter(([, scope]) => detail?.scopes.includes(scope)).map(([field]) => field);
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

  /** The business, the person, the code. Returns the word that goes on the return address as ?instagram=. */
  async function complete({ state, code, oauthError, req }) {
    if (oauthError) return 'denied';
    if (!code) return 'failed';
    const person = state.user_id ? await repos.users.get(state.user_id) : null;
    if (!person || !MANAGER_ROLES.has(person.role)) return 'forbidden';

    let login;
    try {
      login = await meta.login.connect({ code, redirectUri: redirectUri(req) });
    } catch (err) {
      log.warn('ig_connect.exchange_failed', { kind: err.kind, status: err.status, code: err.code });
      return 'failed';
    }
    if (!login.token || !/^\w+$/.test(login.igUserId) || login.igUserId === 'undefined') {
      log.warn('ig_connect.exchange_failed', { kind: 'malformed' });
      return 'failed';
    }
    const tenant = { id: state.tenant_id };
    if (!(await claimAccount(tenant, login))) {
      log.warn('ig_connect.account_taken', { igUserId: login.igUserId });
      await repos.audit.record({ actor: `user:${person.id}`, action: 'instagram.connect_refused', target: `instagram:${login.igUserId}`, details: { reason: 'other_business' } });
      return 'taken';
    }
    const { account } = await repos.igAccounts.saveConnection({ ...login, connectedBy: person.id, nextRefreshAt: nextRefreshAt(Date.now(), login.expiresAt) });
    await retireOthers(account.igUserId, `user:${person.id}`);
    await subscribe(account.igUserId);
    await applyInsightsChoice(account);
    await gates.evaluate().catch((err) => reportError(err, { msg: 'ig_connect.gates_failed' }));
    return SCOPES_TO_GO_LIVE.every((scope) => account.scopes.includes(scope)) ? 'connected' : 'missing_scopes';
  }

  async function callback(req, res) {
    res.set('Cache-Control', 'no-store');
    const query = OAuthCallbackQuery.safeParse(req.query);
    if (!query.success || !query.data.state) return messagePage(res, 400, expiredLink);
    const state = await consumeState(query.data.state);
    if (!state) {
      log.warn('ig_connect.bad_state');
      return messagePage(res, 400, expiredLink);
    }
    const tenant = await repos.tenants.get(state.tenant_id);
    if (!tenant || CLOSED_STATUSES.has(tenant.status)) return messagePage(res, 400, expiredLink);
    const outcome = await withTenant(tenant, () => complete({ state, code: query.data.code, oauthError: query.data.error, req }));
    res.redirect(303, landing(tenant, state.return_to, outcome));
  }

  return { start, callback, subscribe, disconnect };
}

const expiredLink = {
  title: 'This link has expired',
  text: 'Connecting Instagram has to be finished within 10 minutes, and each link works once. Go back to Bhava and press Connect Instagram again.',
};
