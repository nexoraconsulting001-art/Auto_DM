import { ProviderError } from '../../adapters/http.js';
import { KYC_STATES, KYC_STEP_STATUS, OPTIONAL_SCOPES, STEP_CHECKS } from '../../contracts/onboarding.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { isPlatformAddress } from '../domains/rules.js';
import { paymentsFor } from '../payments/index.js';
import { shippingFor } from '../shipping/index.js';
import { addressComplete, pickupReady } from '../shipping/settings.js';

/**
 * One function per live check of STEP_CHECKS (src/contracts/onboarding.js). Each looks at the current business and answers
 * { status, code, reason, fix } and, for the Route account, { kyc }. None of them changes anything the owner did, and none
 * puts a token, a key, a username or a message in what it answers or logs. A provider that does not answer leaves the step
 * `waiting`, never `done`.
 */
const pending = (fix = '', code = '', reason = '') => ({ status: 'pending', code, reason, fix });
const failed = (code, reason, fix) => ({ status: 'failed', code, reason, fix });
const waiting = (code, reason, fix = '') => ({ status: 'waiting', code, reason, fix });
const done = (code = '', reason = '', fix = '') => ({ status: 'done', code, reason, fix });

const SCOPE_WORDS = {
  instagram_business_basic: 'basic access',
  instagram_business_manage_messages: 'messages',
  instagram_business_manage_comments: 'comments',
  instagram_business_manage_insights: 'insights',
};

/** A test call with a seller's own keys: 'ok', 'invalid' (the provider refused the keys) or 'unreachable'. Never throws for the provider. */
export async function testOwnKeys(ctx, provider, { keyId, keySecret }) {
  try {
    if (provider === 'razorpay') {
      // Fetching an order that does not exist: refused keys answer 401, accepted keys a plain "no such order".
      await ctx.providers.razorpay.partner.fetchOrder({ keyId, keySecret }, 'order_bhavakeycheck0');
      return 'ok';
    }
    if (provider === 'shiprocket') {
      await ctx.providers.shiprocket.forAccount({ email: keyId, password: keySecret }).pickupLocations();
      return 'ok';
    }
    return 'unreachable';
  } catch (err) {
    if (!(err instanceof ProviderError) && err?.name !== 'ProviderError') {
      reportError(err, { msg: 'onboarding.key_test_error', provider });
      return 'unreachable';
    }
    log.warn('onboarding.key_test_failed', { tenantId: tenantId(), provider, kind: err.kind, status: err.status });
    if (err.kind === 'auth') return 'invalid';
    if (err.kind === 'rejected' && provider === 'razorpay') return 'ok';
    return 'unreachable';
  }
}

export function createChecks(ctx) {
  const { db, repos, config = {} } = ctx;

  async function instagramAccount() {
    const detail = await repos.igAccounts.primary();
    return detail;
  }

  return {
    async token_scopes() {
      const detail = await instagramAccount();
      if (!detail) return pending('reconnect');
      if (!detail.hasToken) return pending('reconnect', 'gate.token_missing', 'Connect Instagram again.');
      if (detail.status !== 'active') return failed('gate.token_invalid', 'Instagram stopped accepting the connection. Connect it again.', 'reconnect');
      if (detail.tokenExpiresAt && new Date(detail.tokenExpiresAt) <= new Date()) return failed('gate.token_expired', 'The Instagram connection has expired. Connect it again.', 'reconnect');
      const granted = detail.scopes ?? [];
      const missing = STEP_CHECKS.token_scopes.needs.filter((scope) => !granted.includes(scope));
      if (missing.length) {
        return failed('gate.scope_missing', `Instagram was not given permission for ${missing.map((s) => SCOPE_WORDS[s] ?? s).join(', ')}. Connect again and allow every permission.`, 'reconnect');
      }
      const optional = OPTIONAL_SCOPES.filter((scope) => !granted.includes(scope));
      if (optional.length) {
        return done('gate.insights_missing', 'Insights permission needed: analytics stay off and sending runs in slow mode until you reconnect and allow it.', 'reconnect');
      }
      return done();
    },

    async subscribed_apps() {
      const detail = await instagramAccount();
      if (!detail?.hasToken) return pending('reconnect');
      const account = await repos.igAccounts.get(detail.igUserId);
      if (!account?.token) return pending('reconnect');
      const target = detail.loginKind === 'unified' && detail.pageId ? { pageId: detail.pageId, token: account.token } : account;
      try {
        const answer = await ctx.meta.client.forAccount(target).subscriptions();
        const apps = Array.isArray(answer?.data) ? answer.data : [];
        const ours = config.metaAppId ? apps.filter((a) => String(a?.id ?? '') === String(config.metaAppId)) : apps;
        if (ours.length) return done();
        return failed('gate.not_subscribed', 'Instagram is not sending this account’s messages to us yet. Connect it again.', 'reconnect');
      } catch (err) {
        log.warn('onboarding.subscribed_apps_failed', { tenantId: tenantId(), kind: err?.kind, status: err?.status });
        if (err?.kind === 'auth') return failed('gate.token_invalid', 'Instagram stopped accepting the connection. Connect it again.', 'reconnect');
        return waiting('meta.unreachable', 'Instagram did not answer. We will check again shortly.');
      }
    },

    async route_kyc() {
      const [row] = await db.query('SELECT linked_account_id FROM payment_settings WHERE tenant_id = $1', [tenantId()]);
      if (!row?.linked_account_id) return { ...pending('kyc', 'kyc.not_started'), kyc: null };
      let account;
      try {
        account = await ctx.providers.razorpay.route.fetchLinkedAccount(row.linked_account_id);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        log.warn('onboarding.kyc_check_failed', { tenantId: tenantId(), kind: err.kind, status: err.status });
        return { ...waiting('kyc.unreachable', 'Razorpay did not answer. We will check again shortly.', 'kyc'), kyc: undefined };
      }
      const status = KYC_STATES.includes(account.status) ? account.status : 'under_review';
      // The payments module's own record moves too: checkout reads it, and opens only on an active account.
      await paymentsFor(ctx).settings.setKyc(status);
      const stepStatus = KYC_STEP_STATUS[status];
      const reason = stepStatus === 'failed' ? (account.reason || (status === 'suspended' ? 'Razorpay has suspended this account.' : 'Razorpay could not verify these details.')) : '';
      return { status: stepStatus, code: `kyc.${status}`, reason, fix: stepStatus === 'done' ? '' : 'kyc', kyc: { status, reason } };
    },

    async pickup_location() {
      const settings = shippingFor(ctx).settings;
      const row = await settings.row();
      if (row.missing || !addressComplete(row)) return pending('pickup');
      if (!pickupReady(row)) return waiting('courier.pickup_pending', 'The courier has not added this pickup address yet. We will try again shortly.', 'pickup');
      if (row.mode === 'own') return done();
      try {
        const locations = await settings.courierFor('managed', row).pickupLocations();
        if (locations.some((l) => l.code === row.pickup_location)) return done();
        return failed('courier.pickup_missing', 'The courier no longer has this pickup address. Save it again.', 'pickup');
      } catch (err) {
        log.warn('onboarding.pickup_check_failed', { tenantId: tenantId(), kind: err?.kind, status: err?.status });
        return waiting('courier.unreachable', 'The courier did not answer. We will check again shortly.', 'pickup');
      }
    },

    async provider_test_call() {
      const results = [];
      const razorpay = await repos.gatewayKeys?.get('razorpay').catch(() => null);
      if (razorpay) results.push(await testOwnKeys(ctx, 'razorpay', razorpay));
      const shipping = await shippingFor(ctx).settings.row();
      if (shipping.own_email && shipping.own_password_enc) {
        const login = (() => {
          try {
            return ctx.platform?.secrets?.decrypt(shipping.own_password_enc) ?? null;
          } catch {
            return null;
          }
        })();
        if (login) results.push(await testOwnKeys(ctx, 'shiprocket', { keyId: shipping.own_email, keySecret: login }));
      }
      if (!results.length) return pending('keys');
      if (results.includes('ok')) return done();
      if (results.includes('unreachable')) return waiting('keys.unreachable', 'The provider did not answer. We will check again shortly.', 'keys');
      return failed('keys.test_failed', 'Your own keys no longer work. Bhava’s accounts are used meanwhile.', 'keys');
    },

    async dns() {
      const rows = await db.query('SELECT domain, status FROM tenant_domains WHERE tenant_id = $1', [tenantId()]);
      const own = rows.filter((r) => !isPlatformAddress(r.domain, config));
      if (!own.length) return pending('dns');
      if (own.some((r) => r.status === 'verified')) return done();
      if (own.some((r) => r.status === 'pending')) return waiting('dns.pending', 'Waiting for the domain’s DNS to point at us.', 'dns');
      return failed('dns.failed', 'The domain’s DNS does not point at us. Check the records and try again.', 'dns');
    },

    async terms_accepted() {
      const [row] = await db.query(`SELECT detail FROM onboarding_steps WHERE tenant_id = $1 AND step = 'terms'`, [tenantId()]);
      return row?.detail?.accepted?.version ? done() : pending('terms');
    },
  };
}
