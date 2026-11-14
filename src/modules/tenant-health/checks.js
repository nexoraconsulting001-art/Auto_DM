import { ProviderError } from '../../adapters/http.js';
import { HEALTH_CHECKS, statusFromDeductions } from '../../contracts/health.js';
import { InstagramApiError as MetaApiError } from '../../instagram.js';
import { SafeFetchError } from '../../platform/safe-fetch.js';
import { paymentsFor } from '../payments/index.js';
import { scoreHealth } from '../reach-guard/rules.js';
import { shippingFor } from '../shipping/index.js';

/**
 * One function per check of HEALTH_CHECKS (src/contracts/health.js). Each runs inside the business (withTenant) and answers
 * { status, detail }, or throws when the thing it asks could not be reached, which withinTimeout records as `unreachable`.
 * Details are ids, codes and counts: never a token, a username or an address.
 *
 * The account checks read the Phase 2 Account Health deductions as they stand (account_health), except the token family
 * (token_rejected, token_refresh_failed, token_3d, token_14d), which is worked out now from the token itself with Account
 * Health's own scoreHealth, so a token that broke since Account Health last ran shows at once. No threshold is set here.
 */
const TOKEN_CODES = new Set(['token_rejected', 'token_refresh_failed', 'token_3d', 'token_14d']);
const ok = (detail = {}) => ({ status: 'ok', detail });
const PROBE_ORDER = 'order_bhavahealthprobe';

/** What the account checks need, read once per run. `facts.accounts` is every Instagram account of the business. */
export async function accountFacts(pdb, tenantId, now = new Date()) {
  const accounts = await pdb.query(
    `SELECT ig_user_id, status, access_token_enc <> '' AS has_token, token_expires_at, refresh_failures FROM ig_accounts WHERE tenant_id = $1`,
    [tenantId],
  );
  const stored = await pdb.query('SELECT deductions FROM account_health WHERE tenant_id = $1', [tenantId]);
  const live = accounts.flatMap((a) => scoreHealth({ channel: 'instagram', active: a.status === 'active', hasToken: a.has_token, tokenExpiresAt: a.token_expires_at, refreshFailures: a.refresh_failures ?? 0 }, now).deductions.map((d) => d.code));
  const kept = stored.flatMap((r) => (Array.isArray(r.deductions) ? r.deductions : [])).map((d) => d?.code).filter((code) => typeof code === 'string' && !TOKEN_CODES.has(code));
  return { accounts: accounts.length, codes: [...new Set([...live.filter((c) => TOKEN_CODES.has(c)), ...kept])] };
}

function accountCheck(name) {
  return async ({ facts }) => {
    if (!facts.accounts) return name === 'account.token' ? { status: 'warn', detail: { reason: 'not_connected' } } : ok({ reason: 'not_connected' });
    const rule = HEALTH_CHECKS[name].deductions;
    const codes = facts.codes.filter((code) => rule.bad.includes(code) || rule.warn.includes(code));
    return { status: statusFromDeductions(name, facts.codes), detail: { codes } };
  };
}

/** The account the business sends from answers Graph API. A token Meta refuses is bad; no answer is unreachable. */
async function graphCheck({ ig, repos }) {
  const account = await repos.igAccounts.current();
  if (!account) return { status: 'warn', detail: { reason: 'not_connected' } };
  try {
    await ig.getAccount(account);
    return ok();
  } catch (err) {
    if (!(err instanceof MetaApiError)) throw err;
    if (['timeout', 'network', 'malformed'].includes(err.kind) || err.status >= 500 || err.status === 0) throw err;
    if (err.kind === 'token_invalid' || err.kind === 'oauth' || err.status === 401 || err.status === 403) return { status: 'bad', detail: { reason: 'token_refused', kind: err.kind } };
    return { status: 'warn', detail: { reason: 'graph_error', kind: err.kind, status: err.status } };
  }
}

/** The business's primary custom domain, or null when it is on the platform's own address. */
const primaryDomain = async (pdb, tenantId) => (await pdb.query('SELECT domain, status FROM tenant_domains WHERE tenant_id = $1 AND is_primary', [tenantId]))[0] ?? null;

async function dnsCheck({ pdb, tenant }) {
  const domain = await primaryDomain(pdb, tenant.id);
  if (!domain) return ok({ domain: 'platform' });
  if (domain.status === 'verified') return ok({ domain: 'custom' });
  return { status: domain.status === 'pending' ? 'warn' : 'bad', detail: { domain: 'custom', state: domain.status } };
}

/** A real request to the custom domain over https, through safeFetch (public addresses only). Any answer means TLS held. */
async function tlsCheck({ pdb, tenant, platform }) {
  const domain = await primaryDomain(pdb, tenant.id);
  if (!domain || domain.status !== 'verified') return ok({ domain: domain ? 'unverified' : 'platform' });
  try {
    await platform.fetcher.page(`https://${domain.domain}/`);
    return ok({ domain: 'custom' });
  } catch (err) {
    if (!(err instanceof SafeFetchError)) throw err;
    if (err.code === 'blocked') return { status: 'bad', detail: { reason: 'blocked' } };
    if (['network', 'timeout', 'host_busy'].includes(err.code)) throw err;
    return ok({ domain: 'custom', answered: err.code });
  }
}

/** The business's own Razorpay keys or connection: one harmless read. A refusal of the keys is bad; any other answer means they work. */
async function paymentKeysCheck({ ctx }) {
  let creds;
  try {
    creds = await paymentsFor(ctx).settings.credentials('own');
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    return { status: 'bad', detail: { reason: 'not_connected' } };
  }
  try {
    await creds.adapter.fetchOrder(creds.account, PROBE_ORDER);
    return ok();
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.kind === 'auth') return { status: 'bad', detail: { reason: 'keys_refused', status: err.status } };
    if (err.kind === 'rejected') return ok({ probe: 'not_found' });
    throw err;
  }
}

/** The business's own Shiprocket login: list its pickup locations. */
async function courierKeysCheck({ ctx }) {
  const settings = shippingFor(ctx).settings;
  let client;
  try {
    client = settings.courierFor('own', await settings.row());
  } catch {
    return { status: 'bad', detail: { reason: 'not_connected' } };
  }
  try {
    await client.pickupLocations();
    return ok();
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.kind === 'auth') return { status: 'bad', detail: { reason: 'keys_refused', status: err.status } };
    throw err;
  }
}

export const CHECKS = Object.freeze({
  'account.token': accountCheck('account.token'),
  'account.scopes': accountCheck('account.scopes'),
  'account.api_errors': accountCheck('account.api_errors'),
  'account.webhooks': accountCheck('account.webhooks'),
  'account.policy': accountCheck('account.policy'),
  'account.graph': graphCheck,
  'domain.dns': dnsCheck,
  'domain.tls': tlsCheck,
  'keys.payments': paymentKeysCheck,
  'keys.shipping': courierKeysCheck,
});
