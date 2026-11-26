// The PRD and the /api/v1 contract say what must happen, but for the features below they name no address or
// hook yet. Each name in this file is this track's assumption, kept in one place: when a feature is built under
// another name, change it here and every test follows. A test that fails against one of these is reporting a
// missing feature or a name to line up, and never needs its checks changed for that.
// The buyer addresses, the shopper sign-in and the order-state pages below are now the real ones (src/contracts/store-routes.js).
import { createEmail } from '../../../tools/sim/email/index.mjs';
import { createWhatsApp } from '../../../tools/sim/whatsapp/index.mjs';
import { trackingPath } from '../../../src/modules/shipping/util.js';
import { CONSOLE_HOST, hit } from './support.js';

/**
 * Platform Console, on its own host. Answers the tests read:
 *   createBusiness  201 { tenant: { id }, draftKit: { colors, logoUrl }, import: { adapter?, canRetry? } }
 *   rawExport       201 { rowCount, expiresAt }, and an audit_log row whose action contains "export"
 *   impersonate     2xx, and an audit_log row whose action contains "impersonat"
 *   killSwitch      2xx, and one audit_log row whose action contains "kill"
 */
export const consolePaths = {
  createBusiness: '/tenants',
  retryImport: (id) => `/tenants/${id}/import/retry`,
  impersonate: (id) => `/tenants/${id}/impersonate`,
  killSwitch: '/kill-switch',
  rawExport: '/raw-export',
  alerts: '/alerts',
  runWeeklyReport: (id) => `/tenants/${id}/reports/weekly`,
};

/**
 * Seller API additions, written the way the contract writes routes. Answers the tests read:
 *   domains (POST)  201 { id, status: 'pending', records: [{ type: 'TXT'|'CNAME', name, value }] }
 *   domainCheck     200 { status: 'pending'|'verified'|'failed'|'stopped'|'expired' }
 *   auditLog        200 page of rows
 */
export const sellerPaths = {
  domains: '/domains',
  domainCheck: (id) => `/domains/${id}/check`,
  domainPrimary: '/domains/primary',
  auditLog: '/audit-log',
};

/** Where a raw export's file and its expiry are recorded. */
export const rawExportsTable = 'raw_exports';

/** The on-demand TLS check Caddy calls with ?domain=. */
export const askForCertificate = (app, domain) => hit(app, `/tls/ask?domain=${encodeURIComponent(domain)}`, { host: CONSOLE_HOST });

/** Field names not yet in the BrandKit schema. */
export const kitFields = { publicReplies: 'publicReplyVariants', buyerEmailSender: 'buyerEmailSender' };

/** Own-gateway keys, sent where the contract already keeps payment settings. */
export const razorpayKeys = (keyId, keySecret) => ({ razorpayKeyId: keyId, razorpayKeySecret: keySecret });

/**
 * Buyer pages (STORE_ROUTES). Payment success, failure and pending are not three addresses but three states of the order's
 * own page, /order/:token (S-71, S-74): `orderStates` below puts an order in each. Tracking's address carries a signed token.
 */
export const buyerPaths = {
  creatorPage: (slug) => `/${slug}`,
  paymentSuccess: (token) => `/order/${token}`,
  paymentFailure: (token) => `/order/${token}`,
  paymentPending: (token) => `/order/${token}`,
  tracking: (order) => trackingPath(order.tenant_id, order.id, order.public_token),
  invoice: (token, number) => `/order/${token}/invoice/${number}`,
  guestCheckout: '/api/store/checkout',
};

/** Puts an order in the state its page shows: success (paid), pending (waiting for payment), failure (the payment failed). */
export const orderStates = {
  success: (app, order) => app.db.query(`UPDATE orders SET fulfilment_status = 'new', payment_status = 'paid', paid_paise = total_paise WHERE tenant_id = $1 AND id = $2`, [order.tenant_id, order.id]),
  pending: (app, order) => app.db.query(`UPDATE orders SET fulfilment_status = 'pending', payment_status = 'unpaid' WHERE tenant_id = $1 AND id = $2`, [order.tenant_id, order.id]),
  failure: async (app, order) => {
    await orderStates.pending(app, order);
    await app.db.query(`UPDATE payments SET status = 'failed' WHERE tenant_id = $1 AND order_id = $2`, [order.tenant_id, order.id]);
  },
};

/** Shopper sign-in by one-time code (WhatsApp) and the shared-profile consent screen. */
export const shopperPaths = {
  requestCode: '/api/store/otp/send',
  verifyCode: '/api/store/otp/verify',
  consent: '/account/shared-profile',
  consentSave: '/api/store/shared-profile',
};

/** The seller's order-alert settings, where the sender of a shopper's emails is chosen. */
export const alertPaths = { settings: '/alert-settings' };

/** Hooks a test passes through startApp's overrides, in place of the outside world. */
export const hooks = {
  mail: 'mailTransport', // { send(message) }: message is { from, to, subject, html, text }
  whatsapp: 'whatsappTransport', // { send(message) }
  dns: 'dnsResolver', // { resolveTxt(name), resolveCname(name), resolve4(name) }, as in node:dns/promises
  siteFetcher: 'siteFetcher', // (url, { signal }) => { status, headers, body }
};

/**
 * Stands in for the email provider: the HTTP mail API the real adapter speaks (tools/sim/email), started with the app.
 * `messages()` reads everything the platform sent; each message is { from, to, subject, html, text, headers } (`to` is a list).
 * `send(message)` is also here, for the one module (domains) that takes a transport object.
 */
export function fakeMail() {
  const sim = createEmail();
  const mail = {
    sim,
    sent: [],
    start: () => sim.start(),
    close: () => sim.close(),
    async messages() {
      mail.sent = (await sim.get('/sent')).sent;
      return mail.sent;
    },
    async send(message) {
      mail.sent.push(message);
      return { id: `mail-${mail.sent.length}` };
    },
  };
  return mail;
}

/**
 * Stands in for WhatsApp: the Cloud API simulator (tools/sim/whatsapp). `lastCode(phone)` reads the six-digit code the
 * platform sent to that number.
 */
export function fakeWhatsapp() {
  const sim = createWhatsApp();
  return {
    sim,
    start: () => sim.start(),
    close: () => sim.close(),
    async lastCode(phone) {
      const { sent } = await sim.get('/sent');
      const to = String(phone).replace(/\D/g, '');
      for (const message of sent.filter((m) => m.to === to).reverse()) {
        const code = /(?<![0-9])[0-9]{6}(?![0-9])/.exec(JSON.stringify(message.body.template ?? message.body.text ?? {}))?.[0];
        if (code) return code;
      }
      return null;
    },
  };
}

/** Stands in for the public DNS. Records nothing until a test publishes it; `calls` counts lookups. */
export function fakeDns() {
  const txt = new Map();
  const cname = new Map();
  const answer = (map, name) => {
    fake.calls++;
    if (map.has(name)) return map.get(name);
    throw Object.assign(new Error(`no record for ${name}`), { code: 'ENOTFOUND' });
  };
  const fake = {
    calls: 0,
    publish(records) {
      for (const r of records) {
        if (r.type === 'TXT') txt.set(r.name, [[r.value]]);
        if (r.type === 'CNAME') cname.set(r.name, [r.value]);
      }
    },
    resolveTxt: async (name) => answer(txt, name),
    resolveCname: async (name) => answer(cname, name),
    resolve4: async (name) => answer(new Map(), name),
  };
  return fake;
}
