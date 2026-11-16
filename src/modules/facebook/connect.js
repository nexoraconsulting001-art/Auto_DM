import crypto from 'node:crypto';
import { safeNext } from '../../auth.js';
import { ApiError } from '../../contracts/api/index.js';
import { OAuthCallbackQuery, PROVIDER_PATHS } from '../../contracts/api/provider.js';
import { log } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { tenantBaseUrl } from '../admin-api/urls.js';
import { messagePage } from '../ig-connect/pages.js';
import { claimConnection, tellPassedOver } from '../ig-accounts/claim.js';

const PROVIDER = 'facebook';
const STATE_TTL_MS = 10 * 60_000;
const DEFAULT_RETURN = '/admin/settings';
const MANAGER_ROLES = new Set(['owner', 'manager']);
const CLOSED_STATUSES = new Set(['suspended', 'closed', 'killed']);

/** The webhook fields a Page needs, and the permission Meta wants for each (permission names are to confirm at App Review). */
const WEBHOOK_FIELD_SCOPES = Object.freeze({ feed: 'pages_manage_metadata', messages: 'pages_messaging', messaging_postbacks: 'pages_messaging' });
/** Without these a Page can't answer a comment. */
export const SCOPES_TO_ANSWER = Object.freeze(['pages_messaging', 'pages_manage_metadata', 'pages_read_engagement']);

const hashState = (state) => crypto.createHash('sha256').update(state).digest('hex');
const notSetUp = () => new ApiError('conflict', 'Facebook connection isn’t set up on this server yet.');

const expiredLink = {
  title: 'This link has expired',
  text: 'Connecting Facebook has to be finished within 10 minutes, and each link works once. Go back to Bhava and press Connect Facebook Page again.',
};

/**
 * Connecting a Facebook Page with Facebook Login for Business (PRD 6.10). The same shape as connecting Instagram: one Meta app serves every business,
 * so Meta sends everyone back to one registered address and the `state` says which business and who started it. A state is random, stored only as a
 * hash, lasts 10 minutes and works once. A Page belongs to one business, because webhooks route by its id alone.
 */
export function createFacebookConnect({ db, repos, meta, config, platform }) {
  const platformDb = db.platform;

  const callbackBase = (req) => config.metaCallbackBaseUrl || config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
  const redirectUri = (req) => `${callbackBase(req)}${PROVIDER_PATHS.facebookCallback}`;

  /** Where the browser lands, on the business's own address. */
  function landing(tenant, returnTo, outcome) {
    const base = tenantBaseUrl(tenant, config);
    const url = new URL(safeNext(returnTo, DEFAULT_RETURN), base || 'http://relative.invalid');
    url.searchParams.set('facebook', outcome);
    return base ? url.href : `${url.pathname}${url.search}`;
  }

  async function start({ user, returnTo, req }) {
    if (!platform.secrets.configured) throw notSetUp();
    const state = crypto.randomBytes(32).toString('base64url');
    let authorizeUrl;
    try {
      authorizeUrl = meta.facebookLogin.authorizeUrl({ state, redirectUri: redirectUri(req) });
    } catch (err) {
      log.warn('facebook.not_configured', { error: err.name });
      throw notSetUp();
    }
    await repos.igConnect.saveState({ stateHash: hashState(state), provider: PROVIDER, userId: user.id, returnTo: safeNext(returnTo, DEFAULT_RETURN), expiresAt: new Date(Date.now() + STATE_TTL_MS) });
    return { authorizeUrl };
  }

  async function consumeState(state) {
    const [row] = await platformDb.query(
      `UPDATE oauth_states SET used_at = now() WHERE state_hash = $1 AND provider = $2 AND used_at IS NULL AND expires_at > now() RETURNING *`,
      [hashState(state), PROVIDER],
    );
    return row ?? null;
  }

  /**
   * Puts the Page on this business, or says it can't be (null). A row another business released by disconnecting stays theirs,
   * with its history (tenancy-1); any other is theirs.
   */
  const claimPage = (tenant, page) => claimConnection(platformDb, 'facebook', { tenantId: tenant.id, accountId: page.pageId, name: page.name });

  /** Tells Meta to send this Page's events here, only the fields its granted permissions allow. False leaves it for the hourly retry. */
  async function subscribe(pageId) {
    const [page, detail] = await Promise.all([repos.fbPages.get(pageId), repos.fbPages.detail(pageId)]);
    const fields = Object.entries(WEBHOOK_FIELD_SCOPES).filter(([, scope]) => detail?.scopes.includes(scope)).map(([field]) => field);
    if (!page?.token || !fields.length) return false;
    try {
      const answer = await meta.client.forAccount(page).subscribe(fields);
      if (answer?.success === false) throw new Error('Meta did not accept the subscription');
      await repos.fbPages.setSubscribed(pageId, fields);
      return true;
    } catch (err) {
      log.warn('facebook.subscribe_failed', { pageId, kind: err.kind, status: err.status, code: err.code });
      return false;
    }
  }

  async function disconnect(pageId, actor) {
    const page = await repos.fbPages.get(pageId);
    if (page?.token) {
      try {
        await meta.client.forAccount(page).unsubscribe();
      } catch (err) {
        // The token goes either way, and Meta stops delivering once it is dead.
        log.warn('facebook.unsubscribe_failed', { pageId, kind: err.kind, status: err.status, code: err.code });
      }
    }
    return repos.fbPages.disconnect(pageId, { actor });
  }

  /** The Page that goes with this business's Instagram goes first; anyone else's is passed over. */
  function inPreferredOrder(pages, igUserId) {
    const usable = pages.filter((page) => page.token && /^\w+$/.test(page.pageId));
    return [...usable.filter((page) => igUserId && page.igUserId === igUserId), ...usable.filter((page) => !igUserId || page.igUserId !== igUserId)];
  }

  /** The business, the person, the code. Returns the word that goes on the return address as ?facebook=. */
  async function complete({ state, code, oauthError, req }) {
    if (oauthError) return 'denied';
    if (!code) return 'failed';
    const person = state.user_id ? await repos.users.get(state.user_id) : null;
    if (!person || !MANAGER_ROLES.has(person.role)) return 'forbidden';

    let login;
    try {
      login = await meta.facebookLogin.connect({ code, redirectUri: redirectUri(req) });
    } catch (err) {
      log.warn('facebook.exchange_failed', { kind: err.kind, status: err.status, code: err.code });
      return 'failed';
    }
    const candidates = inPreferredOrder(login.pages, (await repos.igAccounts.current())?.igUserId);
    if (!candidates.length) return 'no_page';

    const tenant = { id: state.tenant_id };
    let page = null;
    let claim = null;
    for (const candidate of candidates) {
      claim = await claimPage(tenant, candidate);
      if (claim) {
        page = candidate;
        break;
      }
      log.warn('facebook.page_taken', { pageId: candidate.pageId });
      await repos.audit.record({ actor: `user:${person.id}`, action: 'facebook.connect_refused', target: `facebook:${candidate.pageId}`, details: { reason: 'other_business' } });
    }
    if (!page) return 'taken';

    await repos.fbPages.saveConnection({ pageId: page.pageId, name: page.name, igUserId: page.igUserId, token: page.token, scopes: login.scopes, connectedBy: person.id });
    await tellPassedOver({ db, repos }, 'facebook', page.pageId, claim.passedOver);
    // Only one Page sends for a business. Connecting a different one ends the old one.
    for (const other of await repos.fbPages.othersWithTokens(page.pageId)) await disconnect(other, `user:${person.id}`);
    await subscribe(page.pageId);
    return SCOPES_TO_ANSWER.every((scope) => login.scopes.includes(scope)) ? 'connected' : 'missing_scopes';
  }

  async function callback(req, res) {
    res.set('Cache-Control', 'no-store');
    const query = OAuthCallbackQuery.safeParse(req.query);
    if (!query.success || !query.data.state) return messagePage(res, 400, expiredLink);
    const state = await consumeState(query.data.state);
    if (!state) {
      log.warn('facebook.bad_state');
      return messagePage(res, 400, expiredLink);
    }
    const tenant = await repos.tenants.get(state.tenant_id);
    if (!tenant || CLOSED_STATUSES.has(tenant.status)) return messagePage(res, 400, expiredLink);
    const outcome = await withTenant(tenant, () => complete({ state, code: query.data.code, oauthError: query.data.error, req }));
    res.redirect(303, landing(tenant, state.return_to, outcome));
  }

  return { start, callback, subscribe, disconnect };
}
