import crypto from 'node:crypto';
import { ProviderError } from '../../adapters/http.js';
import { ApiError } from '../../contracts/api/index.js';
import { PINCODE } from '../../contracts/orders.js';
import { STORE_PROVIDER_PATHS } from '../../contracts/store-routes.js';
import { log } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';
import { PaymentError, maskId, rupees } from './util.js';

/**
 * How one business takes money (PRD 9.6): the ways to pay it has on, its cash-on-delivery rules, and which gateway account
 * the money runs on. `managed` is the platform's own Razorpay account with Route; `own` is the seller's, connected by
 * Partner OAuth or by its own keys (repos.gatewayKeys). Tokens and the webhook secret are stored encrypted.
 *
 *   options()                       what the console's payment settings screen shows
 *   updateOptions(patch, actor)     audited
 *   account()                       mode, KYC and connection, ids masked
 *   startLinked(body, actor)        managed: the Route linked account and its KYC
 *   connectUrl(user)                own: where the owner goes to connect an account; completeOauth({ state, code }) finishes it
 *   setMode(mode, actor)            new orders only: an order keeps orders.gateway_mode
 *   disconnect(actor)
 *   effectiveMode()                 the mode a new order gets
 *   ready(mode)                     can that mode take money now
 *   credentials(mode, { accountRef }) -> { adapter, account, accountRef, checkoutSecret }  for a call to the gateway
 *   checkout({ orderPaise, pincode, phone }) -> ways to pay with reasons, the COD fee and the advance split, for the checkout track
 */
const BLANK = Object.freeze({
  mode: null, provider: 'razorpay', linked_account_id: null, kyc_status: 'not_started', own_account_id: null, own_connection: 'none',
  oauth_access_enc: '', oauth_refresh_enc: '', oauth_expires_at: null, webhook_secret_enc: '', webhook_key: null,
  upi: true, card: true, netbanking: true, wallet: true, cod: false, part_advance: false, cod_fee_paise: 0, cod_max_order_paise: null,
  cod_pincodes: [], cod_block_rto_count: null, advance_kind: 'fixed', advance_value: 0, hold_minutes: 30,
});

const OPTION_COLUMNS = Object.freeze({
  upi: 'upi', card: 'card', netbanking: 'netbanking', wallet: 'wallet', cod: 'cod', partAdvance: 'part_advance', codFeePaise: 'cod_fee_paise',
  codMaxOrderPaise: 'cod_max_order_paise', codPincodes: 'cod_pincodes', codBlockRtoCount: 'cod_block_rto_count', advanceKind: 'advance_kind',
  advanceValue: 'advance_value', holdMinutes: 'hold_minutes',
});

const KYC_OF = Object.freeze({ created: 'pending', under_review: 'pending', needs_clarification: 'pending', activated: 'verified', rejected: 'rejected', suspended: 'rejected' });
/** The linked account's status at the gateway, as ours. Anything unknown is still pending: online payment stays off. */
export const kycStatusOf = (gatewayStatus) => KYC_OF[gatewayStatus] ?? 'pending';

const STATE_MINUTES = 15;
const REFRESH_BEFORE_MS = 5 * 60_000;

/** The advance and what is left for the door, for a part-advance order. Null when the split can't be made (nothing left for the door). */
export function advanceSplit(options, totalPaise) {
  const total = Number(totalPaise);
  const value = Number(options.advanceValue);
  const advance = options.advanceKind === 'percent' ? Math.round((total * value) / 10000) : value;
  if (!Number.isSafeInteger(advance) || advance < 100 || advance >= total) return null;
  return { advancePaise: advance, balancePaise: total - advance };
}

export function createSettings({ db, repos, config, providers, secrets }) {
  const razorpay = providers?.razorpay;
  const baseUrl = () => config.publicBaseUrl || (config.platformDomain ? `https://${config.platformDomain}` : '');
  const defaultMode = () => (config.paymentMode === 'own' ? 'own' : 'managed');

  async function row(runner = db) {
    const [found] = await runner.query('SELECT * FROM payment_settings WHERE tenant_id = $1', [tenantId()]);
    return found ?? { ...BLANK, mode: defaultMode(), tenant_id: tenantId(), missing: true };
  }
  /** Makes sure the row exists, with the mode the business had by default, then locks it. */
  async function lockRow(t) {
    await t.query('INSERT INTO payment_settings (tenant_id, mode) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING', [tenantId(), defaultMode()]);
    const [found] = await t.query('SELECT * FROM payment_settings WHERE tenant_id = $1 FOR UPDATE', [tenantId()]);
    return found;
  }

  const managedReady = (r) => Boolean(r.linked_account_id && r.kyc_status === 'verified' && config.razorpayKeyId && config.razorpayKeySecret);
  const ownReady = (r) => r.own_connection !== 'none';
  const isReady = (r, mode = r.mode) => (mode === 'own' ? ownReady(r) : managedReady(r));

  const toOptions = (r) => ({
    upi: r.upi, card: r.card, netbanking: r.netbanking, wallet: r.wallet, cod: r.cod, partAdvance: r.part_advance,
    codFeePaise: Number(r.cod_fee_paise), codMaxOrderPaise: r.cod_max_order_paise === null ? null : Number(r.cod_max_order_paise),
    codPincodes: r.cod_pincodes ?? [], codBlockRtoCount: r.cod_block_rto_count, advanceKind: r.advance_kind, advanceValue: Number(r.advance_value),
    holdMinutes: r.hold_minutes, onlineReady: isReady(r),
  });

  const webhookUrlOf = (r) => (r.webhook_key && r.own_connection !== 'none' && baseUrl() ? `${baseUrl()}${STORE_PROVIDER_PATHS.razorpayOwn.path.replace(':key', r.webhook_key)}` : null);
  const toAccount = (r) => ({
    mode: r.mode, provider: r.provider, kycStatus: r.kyc_status, linkedAccount: maskId(r.linked_account_id), ownConnection: r.own_connection,
    ownAccount: maskId(r.own_account_id), webhookUrl: webhookUrlOf(r),
  });

  const needSecrets = () => {
    if (!secrets?.configured) throw new ApiError('conflict', 'A payment account can’t be connected yet. Please contact support.');
  };
  /** A fresh address key and secret for this business's own webhook, kept if it already has them. */
  const webhookColumns = (r) => (r.webhook_key && r.webhook_secret_enc
    ? { webhook_key: r.webhook_key, webhook_secret_enc: r.webhook_secret_enc }
    : { webhook_key: crypto.randomBytes(24).toString('base64url'), webhook_secret_enc: secrets.encrypt(crypto.randomBytes(32).toString('base64url')) });

  const sign = (payload) => crypto.createHmac('sha256', `${config.sessionSecret}:razorpay-oauth`).update(payload).digest('base64url');
  function makeState(user) {
    if (!config.sessionSecret) throw new ApiError('conflict', 'A payment account can’t be connected yet. Please contact support.');
    const payload = Buffer.from(JSON.stringify({ t: tenantId(), u: user?.id ?? 0, e: Date.now() + STATE_MINUTES * 60_000, n: crypto.randomBytes(9).toString('base64url') })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }
  function readState(state) {
    const [payload, mac] = String(state ?? '').split('.');
    if (!payload || !mac || !config.sessionSecret) return null;
    const expected = sign(payload);
    if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return Number.isInteger(data.t) && data.t > 0 && Number(data.e) > Date.now() ? data : null;
    } catch {
      return null;
    }
  }

  const readTokens = (r) => {
    const stored = JSON.parse(secrets.decrypt(r.oauth_access_enc));
    return { accessToken: stored.a, publicToken: stored.p ?? '', refreshToken: r.oauth_refresh_enc ? secrets.decrypt(r.oauth_refresh_enc) : '' };
  };
  async function saveTokens(runner, tokens) {
    await runner.query(
      'UPDATE payment_settings SET oauth_access_enc = $2, oauth_refresh_enc = $3, oauth_expires_at = $4, updated_at = now() WHERE tenant_id = $1',
      [tenantId(), secrets.encrypt(JSON.stringify({ a: tokens.accessToken, p: tokens.publicToken ?? '' })), tokens.refreshToken ? secrets.encrypt(tokens.refreshToken) : '', tokens.expiresAt ?? null],
    );
  }

  return {
    row,
    isReady,

    async options() {
      return toOptions(await row());
    },

    async updateOptions(patch, actor) {
      const entries = Object.entries(patch ?? {}).filter(([key, value]) => Object.hasOwn(OPTION_COLUMNS, key) && value !== undefined);
      if (!entries.length) return toOptions(await row());
      return db.tx(async (t) => {
        const before = await lockRow(t);
        const next = { ...toOptions(before), ...Object.fromEntries(entries) };
        const fields = {};
        if (next.partAdvance && next.advanceKind === 'percent' && !(next.advanceValue >= 1 && next.advanceValue <= 9900)) fields.advanceValue = 'Enter a percentage between 0.01 and 99';
        if (next.partAdvance && next.advanceKind === 'fixed' && next.advanceValue < 100) fields.advanceValue = 'Enter an advance of at least ₹1';
        if (next.codMaxOrderPaise !== null && next.codMaxOrderPaise <= 0) fields.codMaxOrderPaise = 'Enter an amount above zero, or leave it empty';
        if ((next.codPincodes ?? []).some((pin) => !PINCODE.test(pin))) fields.codPincodes = 'Enter 6-digit PIN codes';
        if (Object.keys(fields).length) throw new ApiError('validation_failed', Object.values(fields)[0], { fields });
        next.codPincodes = [...new Set(next.codPincodes)];
        const sets = entries.map(([key], i) => `${OPTION_COLUMNS[key]} = $${i + 2}${key === 'codPincodes' ? '::text[]' : ''}`);
        const [after] = await t.query(`UPDATE payment_settings SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $1 RETURNING *`, [tenantId(), ...entries.map(([key]) => next[key])]);
        await writeAudit(t, { actor, action: 'payment_settings.change', target: 'payment_settings', details: { fields: entries.map(([key]) => key) } });
        return toOptions(after);
      });
    },

    async account() {
      return toAccount(await row());
    },

    /** Managed mode: creates the seller's Route linked account. Asking again answers with the one it has. */
    async startLinked(body, actor) {
      const current = await row();
      if (current.linked_account_id) return toAccount(current);
      if (!config.razorpayKeyId || !config.razorpayKeySecret) throw new ApiError('conflict', 'Online payments aren’t available on this platform yet. Please contact support.');
      let linked;
      try {
        // The reference makes a repeat of this call the same account at the gateway.
        linked = await razorpay.route.createLinkedAccount({ email: body.email, phone: body.phone, legalName: body.legalName, businessType: body.businessType, contactName: body.contactName, reference: `tenant-${tenantId()}` });
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        log.warn('payments.linked_account_failed', { kind: err.kind, code: err.code });
        throw new ApiError(err.kind === 'rejected' ? 'validation_failed' : 'conflict', err.kind === 'rejected' ? 'The payment provider didn’t accept these details. Check them and try again.' : 'The payment provider didn’t answer. Try again in a minute.');
      }
      return db.tx(async (t) => {
        const locked = await lockRow(t);
        if (!locked.linked_account_id) {
          await t.query('UPDATE payment_settings SET linked_account_id = $2, kyc_status = $3, updated_at = now() WHERE tenant_id = $1', [tenantId(), linked.id, kycStatusOf(linked.status)]);
          await writeAudit(t, { actor, action: 'payment_account.linked_start', target: 'razorpay', details: { account: maskId(linked.id) } });
        }
        return toAccount(await row(t));
      });
    },

    /** Moves KYC from what the gateway says. A late "under review" never undoes "verified". */
    async setKyc(gatewayStatus) {
      const next = kycStatusOf(gatewayStatus);
      return db.tx(async (t) => {
        const current = await lockRow(t);
        if (current.kyc_status === next || (current.kyc_status === 'verified' && next === 'pending')) return { changed: false, status: current.kyc_status };
        await t.query('UPDATE payment_settings SET kyc_status = $2, updated_at = now() WHERE tenant_id = $1', [tenantId(), next]);
        await writeAudit(t, { actor: 'webhook:razorpay', action: 'payment_account.kyc', target: 'razorpay', details: { from: current.kyc_status, to: next } });
        return { changed: true, status: next };
      });
    },

    connectUrl(user) {
      needSecrets();
      if (!config.razorpayPartnerClientId || !baseUrl()) throw new ApiError('conflict', 'Connecting your own account isn’t available yet. Please contact support.');
      return { url: razorpay.partner.authorizeUrl({ state: makeState(user), redirectUri: `${baseUrl()}${STORE_PROVIDER_PATHS.razorpayOauth.path}` }) };
    },

    /** The gateway sent the owner back. The state names the business and proves this server started the visit. */
    async completeOauth({ state, code }) {
      const data = readState(state);
      if (!data || typeof code !== 'string' || !code || code.length > 500) return { ok: false, reason: 'state' };
      needSecrets();
      let tokens;
      try {
        tokens = await razorpay.partner.exchangeCode({ code, redirectUri: `${baseUrl()}${STORE_PROVIDER_PATHS.razorpayOauth.path}` });
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        log.warn('payments.oauth_exchange_failed', { kind: err.kind, tenantId: data.t });
        return { ok: false, reason: 'exchange', tenantId: data.t };
      }
      if (!tokens.accessToken || !tokens.accountId) return { ok: false, reason: 'exchange', tenantId: data.t };
      await withTenant(data.t, () => db.tx(async (t) => {
        const current = await lockRow(t);
        const hook = webhookColumns(current);
        await t.query(
          `UPDATE payment_settings SET own_connection = 'oauth', own_account_id = $2, webhook_key = $3, webhook_secret_enc = $4, updated_at = now() WHERE tenant_id = $1`,
          [tenantId(), String(tokens.accountId).slice(0, 60), hook.webhook_key, hook.webhook_secret_enc],
        );
        await saveTokens(t, tokens);
        await writeAudit(t, { actor: data.u ? `user:${data.u}` : 'system', action: 'payment_account.connect', target: 'razorpay', details: { account: maskId(tokens.accountId), by: 'oauth' } });
      }));
      return { ok: true, tenantId: data.t };
    },

    async setMode(mode, actor) {
      const keys = mode === 'own' ? await repos.gatewayKeys.get('razorpay') : null;
      if (mode === 'own') needSecrets();
      return db.tx(async (t) => {
        const current = await lockRow(t);
        const sets = { mode };
        if (mode === 'own' && current.own_connection === 'none') {
          if (!keys) throw new ApiError('conflict', 'Connect your own payment account first.');
          Object.assign(sets, { own_connection: 'keys', own_account_id: current.own_account_id ?? String(keys.keyId).slice(0, 60) }, webhookColumns(current));
        }
        const columns = Object.keys(sets);
        await t.query(`UPDATE payment_settings SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE tenant_id = $1`, [tenantId(), ...columns.map((c) => sets[c])]);
        if (current.mode !== mode) await writeAudit(t, { actor, action: 'payment_mode.change', target: 'razorpay', details: { from: current.mode, to: mode } });
        return toAccount(await row(t));
      });
    },

    /** Forgets the seller's own account. New orders go back to managed; the webhook address stays, so late events still verify. */
    async disconnect(actor) {
      await db.tx(async (t) => {
        const current = await lockRow(t);
        if (current.own_connection === 'none') return;
        await t.query(
          `UPDATE payment_settings SET own_connection = 'none', oauth_access_enc = '', oauth_refresh_enc = '', oauth_expires_at = NULL, mode = 'managed', updated_at = now() WHERE tenant_id = $1`,
          [tenantId()],
        );
        await writeAudit(t, { actor, action: 'payment_account.disconnect', target: 'razorpay', details: { account: maskId(current.own_account_id), wasMode: current.mode } });
      });
    },

    async effectiveMode() {
      return (await row()).mode;
    },

    async ready(mode) {
      const current = await row();
      return isReady(current, mode ?? current.mode);
    },

    /**
     * What a call to the gateway needs. `accountRef` is the account a payment already ran on (payments.account_ref): an
     * older managed order keeps using its linked account after the business switches mode (S-72).
     */
    async credentials(mode, { accountRef } = {}) {
      const current = await row();
      if (mode === 'managed') {
        const linkedAccountId = accountRef || current.linked_account_id;
        if (!linkedAccountId || !config.razorpayKeyId || !config.razorpayKeySecret) throw new PaymentError('conflict', 'Online payment isn’t set up for this store yet.', 'online_unavailable');
        return { mode, adapter: razorpay.route, account: { linkedAccountId }, accountRef: linkedAccountId, checkoutSecret: config.razorpayKeySecret };
      }
      if (current.own_connection === 'oauth' && current.oauth_access_enc) {
        let tokens;
        try {
          tokens = readTokens(current);
        } catch (err) {
          log.warn('payments.oauth_tokens_unreadable', { error: err.name });
          throw new PaymentError('conflict', 'This store’s own payment account needs to be connected again.', 'online_unavailable');
        }
        const expires = current.oauth_expires_at ? new Date(current.oauth_expires_at).getTime() : Infinity;
        if (expires - Date.now() < REFRESH_BEFORE_MS && tokens.refreshToken) {
          let fresh = {};
          try {
            fresh = await razorpay.partner.refreshToken(tokens.refreshToken);
          } catch (err) {
            if (!(err instanceof ProviderError)) throw err;
            log.warn('payments.oauth_refresh_failed', { kind: err.kind });
            if (expires <= Date.now()) throw new PaymentError('conflict', 'This store’s own payment account needs to be connected again.', 'online_unavailable');
          }
          if (fresh.accessToken) {
            tokens = { accessToken: fresh.accessToken, publicToken: fresh.publicToken || tokens.publicToken, refreshToken: fresh.refreshToken || tokens.refreshToken, expiresAt: fresh.expiresAt };
            await saveTokens(db, tokens);
          }
        }
        return { mode, adapter: razorpay.partner, account: { accessToken: tokens.accessToken, publicToken: tokens.publicToken }, accountRef: accountRef || current.own_account_id || '', checkoutSecret: null };
      }
      if (current.own_connection === 'keys') {
        const keys = await repos.gatewayKeys.get('razorpay').catch((err) => {
          log.warn('payments.keys_unreadable', { error: err.name });
          return null;
        });
        if (keys) return { mode, adapter: razorpay.partner, account: keys, accountRef: accountRef || current.own_account_id || String(keys.keyId).slice(0, 60), checkoutSecret: keys.keySecret };
      }
      throw new PaymentError('conflict', 'This store’s own payment account isn’t connected.', 'online_unavailable');
    },

    /**
     * For checkout (9.5, 9.6): which ways to pay this order has, each with the reason when it doesn't (S-22), the COD fee, and
     * the advance split. `orderPaise` is the order's value before any COD fee; nothing here comes from the shopper but the
     * PIN and phone it typed.
     */
    async checkout({ orderPaise, pincode = '', phone = '' } = {}) {
      const current = await row();
      const options = toOptions(current);
      const allowed = await repos.entitlements.can('store.payments');
      const online = allowed && options.onlineReady && (options.upi || options.card || options.netbanking || options.wallet);
      const modes = [{ mode: 'prepaid', available: online, reason: online ? '' : 'Online payment isn’t available at this store right now.' }];

      // What the door may collect: the cap, the PINs and the refusal history hold for cash on delivery and for the balance
      // of a part-advance order alike.
      let doorReason = '';
      if (options.codMaxOrderPaise !== null && Number(orderPaise) > options.codMaxOrderPaise) doorReason = `Cash on delivery is available on orders up to ${rupees(options.codMaxOrderPaise)}.`;
      else if (options.codPincodes.length && !options.codPincodes.includes(String(pincode))) doorReason = 'Cash on delivery isn’t available at this PIN code.';
      else if (options.codBlockRtoCount !== null && phone && (options.cod || options.partAdvance)) {
        const [{ n }] = await db.query(`SELECT count(*) AS n FROM orders WHERE tenant_id = $1 AND phone = $2 AND fulfilment_status IN ('rto_initiated', 'rto_delivered')`, [tenantId(), String(phone)]);
        if (Number(n) >= options.codBlockRtoCount) doorReason = 'Cash on delivery isn’t available for this order. Please pay online.';
      }
      const codReason = options.cod ? doorReason : 'Cash on delivery isn’t offered by this store.';
      modes.push({ mode: 'cod', available: !codReason, reason: codReason });

      const split = advanceSplit(options, Number(orderPaise));
      let advanceReason = '';
      if (!options.partAdvance) advanceReason = 'Paying part in advance isn’t offered by this store.';
      else if (!online) advanceReason = 'Online payment isn’t available at this store right now.';
      else if (doorReason) advanceReason = doorReason;
      else if (!split) advanceReason = 'This order is too small to pay part in advance.';
      modes.push({ mode: 'part_advance', available: !advanceReason, reason: advanceReason });

      return { paymentModes: modes, codFeePaise: options.codFeePaise, advance: advanceReason ? null : split, holdMinutes: options.holdMinutes, methods: { upi: options.upi, card: options.card, netbanking: options.netbanking, wallet: options.wallet } };
    },

    /** The business behind an own-account webhook address, with the secret its deliveries are signed with. Platform path: no business is known yet. */
    async byWebhookKey(key) {
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(key)) return null;
      const [found] = await (db.platform ?? db).query('SELECT tenant_id, webhook_secret_enc, own_account_id FROM payment_settings WHERE webhook_key = $1', [key]);
      if (!found?.webhook_secret_enc || !secrets?.configured) return null;
      try {
        return { tenantId: found.tenant_id, secret: secrets.decrypt(found.webhook_secret_enc), ownAccountId: found.own_account_id };
      } catch (err) {
        // A secret sealed with a key that is no longer configured: no delivery can be verified, so none is taken.
        log.warn('payments.webhook_secret_unreadable', { tenantId: found.tenant_id, error: err.name });
        return null;
      }
    },

    /** The secret the seller's gateway signs its webhooks with. Never part of an API answer. */
    async webhookSecret() {
      const current = await row();
      return current.webhook_secret_enc ? { key: current.webhook_key, secret: secrets.decrypt(current.webhook_secret_enc), url: webhookUrlOf(current) } : null;
    },
  };
}
