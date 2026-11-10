// The PRD and the /api/v1 contract say what must happen, but for the features below they name no address or
// hook yet. Each name in this file is this track's assumption, kept in one place: when a feature is built under
// another name, change it here and every test follows. A test that fails against one of these is reporting a
// missing feature or a name to line up, and never needs its checks changed for that.
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

/** Buyer pages that do not exist yet. */
export const buyerPaths = {
  creatorPage: (slug) => `/${slug}`,
  paymentSuccess: (token) => `/order/${token}/success`,
  paymentFailure: (token) => `/order/${token}/failure`,
  paymentPending: (token) => `/order/${token}/pending`,
  tracking: (token) => `/track/${token}`,
  invoice: (token) => `/order/${token}/invoice`,
  guestCheckout: '/api/checkout',
};

/** Shopper sign-in by one-time code and the shared-identity consent screen. */
export const shopperPaths = {
  requestCode: '/api/shopper/otp',
  verifyCode: '/api/shopper/otp/verify',
  consent: '/account/shared-identity',
};

/** Hooks a test passes through startApp's overrides, in place of the outside world. */
export const hooks = {
  mail: 'mailTransport', // { send(message) }: message is { from, to, subject, html, text }
  whatsapp: 'whatsappTransport', // { send(message) }
  dns: 'dnsResolver', // { resolveTxt(name), resolveCname(name), resolve4(name) }, as in node:dns/promises
  siteFetcher: 'siteFetcher', // (url, { signal }) => { status, headers, body }
};

/** Stands in for the email provider. `sent` holds everything the platform tried to send. */
export function fakeMail() {
  const sent = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      return { id: `mail-${sent.length}` };
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
